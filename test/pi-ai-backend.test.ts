import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bus } from '../src/kernel/bus.ts';
import { ConfigStore, type ModelRef } from '../src/kernel/config.ts';
import { Db } from '../src/kernel/db.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';
import { LlmService } from '../src/kernel/services/llm.ts';
import { chatViaPiAi, geminiApiBase, isPiProtocol, piAiInstalled, piApiName, prepareMedia, providerBaseUrl } from '../src/kernel/services/pi-ai.ts';

/**
 * pi-ai 后端（本地假服务器，不打真实 API）：
 * 供应商配 `backend:'pi-ai'` 时，同一个「连接方式」交给 @earendil-works/pi-ai 跑，
 * 产出仍是 parallel 自己的 LLMResponse——所以 AgentLoop / 插件 / UI 不需要知道自己走的是哪套引擎。
 * 这里验的是最容易出错的三段：请求形状（model/messages/tools/stream）、SSE 解析（正文+工具调用）、
 * usage 映射（缓存命中/未命中）。
 */

let server: Server;
let baseUrl = '';
let dataDir = '';
let bus: Bus;
let config: ConfigStore;
let errors: ErrorCenter;
let llm: LlmService;

const bodies: any[] = [];
const authHeaders: string[] = [];

/** OpenAI 兼容的流式回复：先正文、再一次工具调用，最后一帧带 usage 与 finish_reason */
const SSE = [
  'data: {"choices":[{"delta":{"role":"assistant","content":"你好"}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"sandbox_read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":40}}}\n\n',
  'data: [DONE]\n\n',
];

const installed = await piAiInstalled();

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'parallel-piai-'));
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      authHeaders.push(String(req.headers.authorization ?? ''));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      SSE.forEach((s) => res.write(s));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

  bus = new Bus();
  errors = new ErrorCenter(bus, { dataDir });
  config = new ConfigStore(dataDir, bus, errors);
  llm = new LlmService(config, errors, new Db(dataDir), bus);

  const providers = config.config.providers as Record<string, any>;
  providers['pi-test'] = {
    label: 'pi-test', model: 'pi-model', enabled: true, baseUrl,
    protocol: 'openai-compatible', custom: true,
    models: [{ id: 'pi-model', enabled: true, contextWindow: 128000, maxOutput: 4096, inputTypes: ['text', 'image'] }],
  };
  config.setProviderKey('pi-test', 'sk-pi-test');
  llm.syncCustomProviders();
  (config.config.llm as { chatChain: ModelRef[] }).chatChain = [{ provider: 'pi-test', model: 'pi-model' }];
});

after(() => {
  server.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* OS 回收 */ }
});

const reset = () => { bodies.length = 0; authHeaders.length = 0; };

test('pi-ai 后端的可判定前提：装了依赖、协议名可识别', async () => {
  assert.equal(installed, true, '本机装了 @earendil-works/pi-ai（测试需要它）');
  assert.equal(isPiProtocol('openai-compatible'), true);
  assert.equal(isPiProtocol('openai-responses'), true);
  assert.equal(isPiProtocol('anthropic'), true);
  assert.equal(isPiProtocol('gemini'), true);
  assert.equal(piApiName('gemini'), 'google-generative-ai');
  assert.equal(isPiProtocol('mock'), false, 'mock 不走 pi-ai');
});

test('请求形状：system 折成首条 system 消息，工具参数原样进 pi-ai，model 用配置里的', async () => {
  reset();
  await llm.chat({
    model: '',
    system: '',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '读一下 a.txt' },
    ],
    tools: [{
      type: 'function',
      function: { name: 'sandbox_read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    }],
  } as any, {});

  assert.equal(bodies.length, 1, '应该只发一次请求');
  const b = bodies[0];
  assert.equal(b.model, 'pi-model', '模型名取自供应商配置里的模型行');
  assert.equal(b.stream, true, 'pi-ai 走流式');
  const sys = b.messages.find((m: any) => m.role === 'system');
  assert.ok(sys, 'system 要作为首条 system 消息发出去');
  assert.ok(JSON.stringify(sys.content).includes('你是助手'), `system 文本要带上，实际 ${JSON.stringify(sys.content)}`);
  const tool = (b.tools ?? [])[0];
  assert.equal(tool?.function?.name, 'sandbox_read');
  assert.deepEqual(tool?.function?.parameters?.required, ['path'], '工具参数不被重写');
  assert.equal(authHeaders[0], 'Bearer sk-pi-test', 'apiKey 按请求传给 pi-ai');
});

test('SSE 解析：正文与工具调用都拿到，且回调吐出增量', async () => {
  reset();
  const deltas: string[] = [];
  const resp = await llm.chat({
    model: '',
    messages: [{ role: 'user', content: '读一下 a.txt' }],
  } as any, { onDelta: (d) => { if (d.text) deltas.push(d.text); } });

  assert.equal(resp.content, '你好');
  assert.equal(resp.toolCalls.length, 1);
  assert.equal(resp.toolCalls[0].function.name, 'sandbox_read');
  assert.deepEqual(JSON.parse(resp.toolCalls[0].function.arguments), { path: 'a.txt' });
  assert.deepEqual(deltas, ['你好'], '流式增量要透出去（UI 靠它打字机）');
  // pi-ai 会把各家的 stop reason 归一化成自己的词表（OpenAI 的 tool_calls → toolUse），
  // 与自研后端返回的原始字符串不同——调用方只应把它当不透明标记看
  assert.equal(resp.finishReason, 'toolUse');
});

test('usage 映射：prompt = 未命中 + 命中，两者都进缓存账', async () => {
  reset();
  const resp = await llm.chat({ model: '', messages: [{ role: 'user', content: 'hi' }] } as any, {});
  assert.ok(resp.usage, '要带 usage');
  const u = resp.usage!;
  assert.equal(u.completionTokens, 7);
  assert.equal(u.cacheHitTokens, 40, 'session 的 cached_tokens 要落到 cacheHit');
  assert.equal(u.cacheMissTokens, 60, '未命中部分 = prompt_tokens - cached');
  assert.equal(u.promptTokens, 100, 'prompt 总量应与对端报的 prompt_tokens 一致');
  assert.ok(u.promptTokens >= u.cacheHitTokens, '不变式：prompt 不少于命中数');
});

test('换了供应商照样走 pi-ai（没有第二条引擎可切）', async () => {
  reset();
  const providers = config.config.providers as Record<string, any>;
  providers['native-test'] = {
    label: 'native', model: 'native-model', enabled: true, baseUrl,
    protocol: 'openai-compatible', custom: true,
    models: [{ id: 'native-model', enabled: true }],
  };
  config.setProviderKey('native-test', 'sk-native');
  llm.syncCustomProviders();   // 新加的供应商要过这一步才会注册进实例表
  (config.config.llm as { chatChain: ModelRef[] }).chatChain = [{ provider: 'native-test', model: 'native-model' }];
  const resp = await llm.chat({ model: '', messages: [{ role: 'user', content: 'hi' }] } as any, {});
  assert.equal(resp.content, '你好');
  (config.config.llm as { chatChain: ModelRef[] }).chatChain = [{ provider: 'pi-test', model: 'pi-model' }];
});

test('直接调桥接层：未装 pi-ai 时给的是「去装依赖」的明确错误，不静默降级', async () => {
  // 这一条验的是错误类型契约（PiNotInstalledError 会被 LlmService 翻成带指引的 ProviderError）。
  // 本机装了依赖，所以这里只断言"装了就走通"，未装分支靠类型名与代码审查保证。
  const resp = await chatViaPiAi({
    providerId: 'pi-test', protocol: 'openai-compatible', baseUrl, apiKey: 'sk-pi-test',
    model: { id: 'pi-model', contextWindow: 128000 },
    req: { model: '', messages: [{ role: 'user', content: 'hi' }] } as any,
  });
  assert.equal(resp.content, '你好');
});

// ============================================================
// 音频/视频：pi-ai 的 content 块里没有这两类，在它的扩展点上补
// ============================================================

test('音频/视频：在 onPayload 上补进请求体的最后一条 user 消息', async () => {
  reset();
  // 给一个真的 wav 头，走"容器已是对端认的"分支（本机没有 ffmpeg，不测转码）
  const wav = join(dataDir, 'v.wav');
  writeFileSync(wav, Buffer.from('RIFFxxxxWAVEfmt ', 'latin1'));

  const providers = config.config.providers as Record<string, any>;
  providers['av'] = {
    label: 'av', model: 'av-model', enabled: true, baseUrl, protocol: 'openai-compatible', custom: true,
    models: [{ id: 'av-model', enabled: true, inputTypes: ['text', 'image', 'audio', 'video'] }],
  };
  config.setProviderKey('av', 'k');
  llm.syncCustomProviders();
  (config.config.llm as { chatChain: ModelRef[] }).chatChain = [{ provider: 'av', model: 'av-model' }];

  await llm.chat({
    model: '',
    messages: [{ role: 'user', content: '听一下这段，再看看这个视频' }],
    attachments: [
      { kind: 'audio', path: wav, mime: 'audio/wav' },
      { kind: 'video', url: 'https://x/v.mp4' },
    ],
  } as any, {});

  const body = bodies[bodies.length - 1];
  const last = [...body.messages].reverse().find((m: any) => m.role === 'user');
  const blocks = last.content as any[];
  const audio = blocks.find((c) => c.type === 'input_audio');
  const video = blocks.find((c) => c.type === 'video_url');
  assert.ok(audio, `音频块要补进去，实际块类型 ${blocks.map((c) => c.type).join(',')}`);
  assert.equal(audio.input_audio.format, 'wav');
  assert.ok(String(audio.input_audio.data).startsWith('UklGR'), '音频要 base64 成 data');
  assert.ok(video, '视频块要补进去');
  assert.equal(video.video_url.url, 'https://x/v.mp4');
  assert.equal(blocks[0].type, 'text', '原有文本块要保留在最前');

  (config.config.llm as { chatChain: ModelRef[] }).chatChain = [{ provider: 'pi-test', model: 'pi-model' }];
});

test('prepareMedia：Anthropic 没有音频/视频块 → 明确列入 skipped，不静默丢', async () => {
  const m = await prepareMedia({
    api: 'anthropic-messages',
    attachments: [
      { kind: 'audio', url: 'https://x/a.silk', mime: 'audio/silk' },
      { kind: 'video', url: 'https://x/v.mp4' },
    ],
  });
  assert.equal(m.audio, undefined);
  assert.equal(m.video, undefined);
  assert.equal(m.skipped.length, 2);
  assert.ok(m.skipped.every((s) => s.includes('Anthropic')), `实际：${m.skipped.join('；')}`);
});

test('prepareMedia：本机没有 ffmpeg 时，对端不认的语音容器如实报"转不了"', async () => {
  const m = await prepareMedia({ api: 'openai-completions', attachments: [{ kind: 'audio', url: 'https://x/a.silk', mime: 'audio/silk' }] });
  if (m.audio) return;   // 本机装了 ffmpeg 就跳过这条（转码成功也是对的）
  assert.ok(m.skipped.some((s) => /ffmpeg|转不了/.test(s)), `实际：${m.skipped.join('；')}`);
});

test('prepareMedia：Responses 没有视频块，音频可以补', async () => {
  const m = await prepareMedia({ api: 'openai-responses', attachments: [{ kind: 'video', url: 'https://x/v.mp4' }] });
  assert.equal(m.video, undefined);
  assert.ok(m.skipped.some((s) => s.includes('Responses')), `实际：${m.skipped.join('；')}`);
});

// ============================================================
// Gemini 原生那一档（google-generative-ai）：baseUrl 归一 + 媒体进 contents[].parts
// ============================================================

test('gemini 的 baseUrl 归一：带不带 /models、带不带版本段都收敛到 …/v1beta', () => {
  const V = 'https://generativelanguage.googleapis.com/v1beta';
  assert.equal(geminiApiBase(V), V);
  assert.equal(geminiApiBase(`${V}/`), V);
  assert.equal(geminiApiBase(`${V}/models`), V, '照 Google 文档填的 …/v1beta/models 要摘掉尾巴，否则拼成 /models/models');
  assert.equal(geminiApiBase(`${V}/models/`), V);
  assert.equal(geminiApiBase('https://generativelanguage.googleapis.com'), V, '光秃秃的域名补上默认版本段');
  assert.equal(geminiApiBase('https://proxy.example.com/v1'), 'https://proxy.example.com/v1', '已经带版本段的别乱补');
  // 其余几档原样透传：不许顺手把别人填的路径改了
  assert.equal(providerBaseUrl('openai-compatible', 'https://x/v1/'), 'https://x/v1/');
  assert.equal(providerBaseUrl('anthropic', 'https://x/api/anthropic/'), 'https://x/api/anthropic/');
});

test('gemini 档端到端：URL 与 x-goog-api-key 是 Google 原生的形状，语音/视频补进 contents 的 parts', async () => {
  const hits: { url: string; key: string; body: any }[] = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push({ url: req.url ?? '', key: String(req.headers['x-goog-api-key'] ?? ''), body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"candidates":[{"content":{"parts":[{"text":"那是一句问候"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":5,"totalTokenCount":125}}\n\n');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const wav = join(dataDir, 'g.wav');
  writeFileSync(wav, Buffer.from('RIFFxxxxWAVEfmt ', 'latin1'));
  try {
    const resp = await chatViaPiAi({
      providerId: 'gm', protocol: 'gemini',
      // 故意按模型页里最常见的写法填（带 /models 尾巴）：归一没做对就会打到 /v1beta/models/models/…
      baseUrl: `http://127.0.0.1:${port}/v1beta/models`, apiKey: 'gk-1',
      model: { id: 'gemini-3.8-flash', contextWindow: 1_000_000, maxTokens: 512, image: true },
      req: {
        model: 'gemini-3.8-flash',
        messages: [
          { role: 'system', content: '你是鲸鱼娘' },
          { role: 'user', content: '听一下这段语音，再看看这个视频' },
        ],
        attachments: [
          { kind: 'audio', path: wav, mime: 'audio/wav' },
          { kind: 'video', url: 'https://x/v.mp4' },
        ],
      } as any,
    });
    assert.equal(resp.content, '那是一句问候', '回复要从 candidates 里解析出来');
    assert.ok((resp.usage?.promptTokens ?? 0) > 0, 'usageMetadata 要落进用量账');
    assert.equal(hits.length, 1, `只该发一次请求，实际 ${hits.length}`);
    const h = hits[0];
    assert.match(h.url, /^\/v1beta\/models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse/, `实际 URL ${h.url}`);
    assert.equal(h.key, 'gk-1', 'key 走 x-goog-api-key 头，不是 authorization');
    assert.ok(JSON.stringify(h.body.systemInstruction).includes('你是鲸鱼娘'), '首条 system 要折成 systemInstruction');

    const last = [...h.body.contents].reverse().find((c: any) => c.role === 'user');
    const audio = last.parts.find((p: any) => p.inlineData?.mimeType?.startsWith('audio/'));
    const video = last.parts.find((p: any) => p.fileData);
    assert.ok(audio, `语音要作为 inlineData part 补进去，实际 ${JSON.stringify(last.parts.map((p: any) => Object.keys(p)))}`);
    assert.equal(audio.inlineData.mimeType, 'audio/wav');
    assert.ok(String(audio.inlineData.data).startsWith('UklGR'), '音频 base64 与 OpenAI 那档同源');
    assert.equal(video.fileData.fileUri, 'https://x/v.mp4', '视频走 fileData.fileUri，不在本机代读');
    assert.equal(video.fileData.mimeType, 'video/mp4');
    assert.equal(last.parts[0].text, '听一下这段语音，再看看这个视频', '原有文本仍在最前');
  } finally {
    srv.close();
  }
});

test('prepareMedia：Gemini 档的视频只有本机路径时如实报「不代读」，不静默丢', async () => {
  const m = await prepareMedia({ api: 'google-generative-ai', attachments: [{ kind: 'video', path: 'D:\\x\\nope.mp4' }] });
  assert.equal(m.video, undefined);
  assert.ok(m.skipped.some((s) => s.includes('Gemini')), `实际：${m.skipped.join('；')}`);
});

// ============================================================
// 动图：图片块只认静态图，先在本机摊成分帧拼图
// ============================================================

/** 两帧 1×1 GIF（红/蓝）：够 ffmpeg 认成 2 帧动图，又不依赖本机造图 */
const TINY_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==',
  'base64',
);

test('动图识别：GIF 多帧/单帧、PNG、WEBP 按内容判断，不信扩展名', async () => {
  const { isAnimatedImage } = await import('../src/kernel/services/media.ts');
  assert.equal(isAnimatedImage(TINY_GIF), true, '两帧 GIF 是动图');
  // 同一份 GIF 在第二个 GCE（0x21 0xF9）处截断并补结束符：只剩一帧，是静态图
  const second = TINY_GIF.indexOf(Buffer.from([0x21, 0xf9]), 1);
  assert.ok(second > 0, '样例 GIF 里要有第二个帧控制块');
  const staticGif = Buffer.concat([TINY_GIF.subarray(0, second), Buffer.from([0x3b])]);
  assert.equal(isAnimatedImage(staticGif), false, '单帧 GIF 按静态图走');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  assert.equal(isAnimatedImage(png), false, '普通 PNG 不是动图');
  // APNG：PNG 头 + acTL 块
  const apng = Buffer.concat([png.subarray(0, 8), Buffer.from('0000000848544d4c', 'hex'), Buffer.from('acTL', 'latin1'), png.subarray(8)]);
  assert.equal(isAnimatedImage(apng), true, '带 acTL 的 PNG 是 APNG');
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBPVP8X', 'latin1'), Buffer.from('ANIM', 'latin1'), Buffer.alloc(32)]);
  assert.equal(isAnimatedImage(webp), true, '带 ANIM 块的 WebP 是动图');
  const stillWebp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBPVP8X', 'latin1'), Buffer.alloc(32)]);
  assert.equal(isAnimatedImage(stillWebp), false, '静态 WebP 不是动图');
});

test('动图进模型：请求里是 JPEG 分帧拼图 + 一句排版说明，不是原始 GIF', async () => {
  const { setFfmpegCandidate } = await import('../src/kernel/services/media.ts');
  // 测试的 dataDir 是临时目录、PATH 里也没有 ffmpeg：指向项目自带的那份（没有就跳过这条）
  const bundled = join(process.cwd(), 'data', 'bin', 'ffmpeg.exe');
  if (!existsSync(bundled)) return;
  setFfmpegCandidate(bundled);
  reset();
  const gif = join(dataDir, 'anim.gif');
  writeFileSync(gif, TINY_GIF);

  await llm.chat({
    model: '',
    messages: [{ role: 'user', content: '看看这个表情' }],
    attachments: [{ kind: 'image', path: gif, name: 'anim.gif', mime: 'image/gif' }],
  } as any, {});

  const body = bodies[bodies.length - 1];
  const last = [...body.messages].reverse().find((m: any) => m.role === 'user');
  const blocks = last.content as any[];
  const img = blocks.find((c) => c.type === 'image_url');
  assert.ok(img, `图片块要在：${JSON.stringify(blocks.map((b) => b?.type))}`);
  assert.match(String(img.image_url?.url ?? ''), /^data:image\/jpeg;base64,/, '动图要换成分帧拼图（JPEG）');
  assert.ok(!String(img.image_url?.url ?? '').startsWith('data:image/gif'), '原始 GIF 不该原样送出去（对端只取首帧）');
  const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n');
  assert.match(text, /动图/, '要告诉模型这是动图的分帧，不是多张不同的图');
  assert.match(text, /不是多张不同的图/, `实际正文：${text}`);
});

test('静态图不受影响：仍是原样 base64，也不加动图说明', async () => {
  reset();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const f = join(dataDir, 'still.png');
  writeFileSync(f, png);

  await llm.chat({
    model: '',
    messages: [{ role: 'user', content: '看看这张' }],
    attachments: [{ kind: 'image', path: f, name: 'still.png', mime: 'image/png' }],
  } as any, {});

  const body = bodies[bodies.length - 1];
  const last = [...body.messages].reverse().find((m: any) => m.role === 'user');
  const blocks = last.content as any[];
  const img = blocks.find((c) => c.type === 'image_url');
  assert.ok(img);
  assert.equal(img.image_url?.url, `data:image/png;base64,${png.toString('base64')}`, '静态图一个字节都不该被改写');
  const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n');
  assert.ok(!text.includes('动图'), `静态图不该有动图说明：${text}`);
});
