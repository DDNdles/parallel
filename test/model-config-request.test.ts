import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OpenAiCompatProvider, OpenAiResponsesProvider, AnthropicProvider, applyModelCfg,
} from '../src/kernel/services/llm.ts';
import type { LLMChatRequest } from '../src/kernel/types.ts';

/**
 * 模型页声明的三项配置如何影响真实请求（本地假 SSE 服务器，不打真实 API）：
 * ① inputTypes —— 只有声明过的媒体才转成多模态 content 块（图片走 url 或 data URL，音频走 base64 + 容器格式）；
 * ② capabilities.webSearch —— 摘掉 Tavily 的 web_search 工具，并按线格式发出内置搜索工具；
 * ③ maxOutput —— 作为输出上限发出（Chat Completions/Anthropic 用 max_tokens，Responses 用 max_output_tokens）。
 * 界面上的「调用参数」就是这三项推导出来的只读预览，因此这里断言的键必须与它一致。
 */

let server: Server;
let baseUrl = '';
const seen: { path: string; body: any }[] = [];
let tmp = '';
let wavPath = '';
let pngPath = '';

const CHAT_SSE = [
  'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
  'data: [DONE]\n\n',
];
const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];
const RESPONSES_SSE = [
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}\n\n',
];

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'parallel-cfg-'));
  // 1 字节"音频"与"图片"：只验是否被读成 base64，内容无意义
  wavPath = join(tmp, 'v.wav');
  pngPath = join(tmp, 'p.png');
  writeFileSync(wavPath, Buffer.from('RIFFxxxxWAVEfmt ', 'latin1'));
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') });
      const stream = req.url === '/v1/chat/completions' ? CHAT_SSE
        : req.url === '/v1/messages' ? ANTHROPIC_SSE
          : req.url === '/v1/responses' ? RESPONSES_SSE : null;
      if (!stream) { res.writeHead(404).end('{}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      stream.forEach((s) => res.write(s));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});

after(() => {
  server.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* OS 回收 */ }
});

const last = () => seen[seen.length - 1].body;
const fnTool = (name: string) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});
const req = (over: Partial<LLMChatRequest> = {}): LLMChatRequest => ({
  model: 'm-1', messages: [{ role: 'user', content: '看下这张图' }], ...over,
});

// ============ ① applyModelCfg：纯判定 ============

test('inputTypes 没声明的媒体不转发，声明了的留着', () => {
  const atts = [
    { kind: 'image' as const, url: 'https://x/p.png' },
    { kind: 'audio' as const, path: wavPath, mime: 'audio/wav' },
    { kind: 'video' as const, url: 'https://x/v.mp4' },
  ];
  assert.deepEqual(
    applyModelCfg({ inputTypes: ['text', 'image'] }, req({ attachments: atts })).attachments?.map((a) => a.kind),
    ['image']);
  assert.equal(applyModelCfg({ inputTypes: ['text'] }, req({ attachments: atts })).attachments, undefined,
    '一条都不剩时干脆去掉该字段');
  assert.deepEqual(
    applyModelCfg({ inputTypes: ['text', 'image', 'audio'] }, req({ attachments: atts })).attachments?.map((a) => a.kind),
    ['image', 'audio'], '视频没声明 → 不转');
});

test('勾选原生联网搜索：摘掉 Tavily 的 web_search，web_fetch 保留', () => {
  const tools = [fnTool('web_search'), fnTool('web_fetch'), fnTool('run_python')];
  const out = applyModelCfg({ capabilities: ['webSearch'] }, req({ tools }));
  assert.equal(out.nativeSearch, true);
  assert.deepEqual(out.tools?.map((t) => t.function.name), ['web_fetch', 'run_python']);

  const plain = applyModelCfg({}, req({ tools }));
  assert.equal(plain.nativeSearch, undefined, '没勾选就照旧给 Tavily 工具');
  assert.equal(plain.tools?.length, 3);

  // 只剩 web_search 时整个 tools 字段撤掉，免得发个空数组过去
  assert.equal(applyModelCfg({ capabilities: ['webSearch'] }, req({ tools: [fnTool('web_search')] })).tools, undefined);
});

test('最大输出 Token 成为输出上限；调用方显式给的优先', () => {
  assert.equal(applyModelCfg({ maxOutput: 8192 }, req()).maxTokens, 8192);
  assert.equal(applyModelCfg({ maxOutput: 8192 }, req({ maxTokens: 1 })).maxTokens, 1, 'ping 这类显式值不被配置盖掉');
  assert.equal(applyModelCfg({}, req()).maxTokens, undefined, '没填就不发，交给对端默认');
  assert.equal(applyModelCfg({ maxOutput: 0 }, req()).maxTokens, undefined);
  // 没在模型页登记过的模型：原样发，别乱动调用方的请求
  const untouched = applyModelCfg(undefined, req({ tools: [fnTool('web_search')] }));
  assert.equal(untouched.tools?.length, 1);
  assert.equal(untouched.nativeSearch, undefined);
  assert.equal(untouched.maxTokens, undefined);
});

// ============ ② Chat Completions ============

test('Chat Completions：图片走 image_url、音频读成本机 base64，文本块在前', async () => {
  const r = applyModelCfg({ inputTypes: ['text', 'image', 'audio'] }, req({
    attachments: [{ kind: 'image', url: 'https://x/p.png' }, { kind: 'audio', path: wavPath, mime: 'audio/wav' }],
  }));
  await new OpenAiCompatProvider('p1').chatVia(baseUrl, 'k', r);
  const content = last().messages.at(-1).content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, '看下这张图');
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: 'https://x/p.png' } });
  assert.equal(content[2].type, 'input_audio');
  assert.equal(content[2].input_audio.format, 'wav');
  assert.ok(content[2].input_audio.data.length > 0, '本机 wav 读成了 base64');
});

test('Chat Completions：没有 url 的图片转成 data URL；QQ 的 silk 语音不硬塞', async () => {
  writeFileSync(join(tmp, 'v.slk'), Buffer.from('silk'));
  const r = applyModelCfg({ inputTypes: ['text', 'image', 'audio'] }, req({
    attachments: [{ kind: 'image', path: pngPath }, { kind: 'audio', path: join(tmp, 'v.slk'), mime: 'audio/silk' }],
  }));
  await new OpenAiCompatProvider('p1').chatVia(baseUrl, 'k', r);
  const content = last().messages.at(-1).content;
  assert.equal(content.length, 2, 'silk 不在 OpenAI 认的容器里，只留文本+图片');
  assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test('Chat Completions：最大输出 Token 发成 max_tokens', async () => {
  await new OpenAiCompatProvider('p1').chatVia(baseUrl, 'k', applyModelCfg({ maxOutput: 4096 }, req()));
  assert.equal(last().max_tokens, 4096);
  await new OpenAiCompatProvider('p1').chatVia(baseUrl, 'k', applyModelCfg({}, req()));
  assert.equal(last().max_tokens, undefined, '没填就不带这个键');
});

// ============ ③ Responses ============

test('Responses：input_image / input_audio 块 + 内置 web_search 工具 + max_output_tokens', async () => {
  const r = applyModelCfg({ inputTypes: ['text', 'image', 'audio'], capabilities: ['webSearch'], maxOutput: 2048 }, req({
    attachments: [{ kind: 'image', url: 'https://x/p.png' }, { kind: 'audio', path: wavPath, mime: 'audio/wav' }],
    tools: [fnTool('web_search'), fnTool('web_fetch')],
  }));
  await new OpenAiResponsesProvider('p1').chatVia(baseUrl, 'k', r);
  const body = last();
  const item = body.input.at(-1);
  assert.equal(item.content[0].type, 'input_text');
  assert.deepEqual(item.content[1], { type: 'input_image', image_url: 'https://x/p.png' });
  assert.equal(item.content[2].type, 'input_audio');
  assert.equal(item.content[2].input_audio.format, 'wav');
  assert.equal(body.tools[0].type, 'web_search', '内置搜索工具在前');
  assert.deepEqual(body.tools.slice(1).map((t: any) => t.name), ['web_fetch'], 'Tavily 那个 web_search 已摘掉');
  assert.equal(body.max_output_tokens, 2048);
});

// ============ ④ Anthropic ============

test('Anthropic：image 块用 base64 source，内置 web_search_20250305 工具', async () => {
  const r = applyModelCfg({ inputTypes: ['text', 'image'], capabilities: ['webSearch'] }, req({
    attachments: [{ kind: 'image', path: pngPath, mime: 'image/png' }],
    tools: [fnTool('web_search'), fnTool('web_fetch')],
  }));
  await new AnthropicProvider('p1').chatVia(baseUrl, 'k', r);
  const body = last();
  const blocks = body.messages.at(-1).content;
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].source.type, 'base64');
  assert.equal(blocks[1].source.media_type, 'image/png');
  assert.equal(body.tools[0].type, 'web_search_20250305');
  assert.equal(body.tools[0].name, 'web_search');
  assert.deepEqual(body.tools.slice(1).map((t: any) => t.name), ['web_fetch']);
});

test('Anthropic：该格式没有音频块，声明了也只留纯文本 content', async () => {
  const r = applyModelCfg({ inputTypes: ['text', 'audio'] }, req({
    attachments: [{ kind: 'audio', path: wavPath, mime: 'audio/wav' }],
  }));
  await new AnthropicProvider('p1').chatVia(baseUrl, 'k', r);
  assert.equal(last().messages.at(-1).content, '看下这张图', '挂不上媒体块就别把 content 变成数组');
});

test('Anthropic：最大输出 Token 发成 max_tokens（该格式必填，没填仍兜 4096）', async () => {
  await new AnthropicProvider('p1').chatVia(baseUrl, 'k', applyModelCfg({ maxOutput: 3072 }, req()));
  assert.equal(last().max_tokens, 3072);
  await new AnthropicProvider('p1').chatVia(baseUrl, 'k', applyModelCfg({}, req()));
  assert.equal(last().max_tokens, 4096);
});
