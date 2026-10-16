/**
 * 抓真实请求报文：起一个本地假端点顶替模型，让内核照常跑一轮 chat 和一轮 work，
 * 把它实际发出去的 HTTP body（system / messages / tools 全都在里面）原样存下来并打印摘要。
 *
 *   node --experimental-transform-types --no-warnings scripts/dump-payloads.mjs
 *
 * 产物：data/debug/chat-request.json、data/debug/work-request.json（data/ 不入库）
 * 只打印 body，不打印 Authorization 头，也不碰任何真 key。
 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../src/kernel/kernel.ts';
import { MockOneBot } from '../test/helpers/mock-onebot.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'debug');
const GROUP = 91001;
const MEMBER = 10001;
const MASTER = 9999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假端点：记下 body，回一段合法的 OpenAI 流式响应（纯文本、不调工具） */
function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* 记原文 */ }
      seen.push(body ?? raw);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta, finish) => `data: ${JSON.stringify({
        id: 'stub-1', object: 'chat.completion.chunk', created: 0, model: 'stub',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      res.write(chunk({ role: 'assistant', content: '（占位回复）' }, null));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return {
    seen,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => server.close(),
  };
}

/** 从 OpenAI 兼容报文里抽出可读摘要 */
function summarize(body, label) {
  const messages = body?.messages ?? [];
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const tools = (body?.tools ?? []).map((t) => t.function?.name).filter(Boolean);
  const convo = messages.filter((m) => m.role !== 'system');
  return {
    label,
    model: body?.model,
    stream: body?.stream,
    temperature: body?.temperature,
    max_tokens: body?.max_tokens ?? body?.max_completion_tokens,
    messageCount: messages.length,
    toolCount: tools.length,
    tools,
    convoPreview: convo.map((m) => `${m.role}: ${String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 90)}`),
    system,
  };
}

const stub = startStub();
const port = await stub.listen();
const dataDir = mkdtempSync(join(tmpdir(), 'dump-'));
let kernel, mock;

try {
  kernel = new Kernel({ dataDir, noApi: true });
  kernel.config.config.onebot.port = 31000 + (process.pid % 2000);
  kernel.config.config.masterIds = [String(MASTER)];
  kernel.config.config.providers.stub = {
    label: 'Stub', model: 'stub-model', enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`,
    protocol: 'openai-compatible', custom: true,
    models: [{ id: 'stub-model', contextWindow: 65536, enabled: true }],
  };
  kernel.config.config.llm.activeProvider = 'stub';
  kernel.config.config.llm.chatChain = [{ provider: 'stub', model: 'stub-model' }];
  kernel.config.setProviderKey('stub', 'stub-not-a-real-key');
  kernel.config.saveConfig();
  kernel.llm.syncCustomProviders();

  await kernel.boot();
  kernel.container.setGroupState('chat', String(GROUP), true, 'ui');
  kernel.container.setGroupState('work', String(GROUP), true, 'ui');

  mock = new MockOneBot(`ws://127.0.0.1:${kernel.config.config.onebot.port}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await sleep(600);
  mock.actions.length = 0;

  // ---- chat 轮：@ 一句，且带上世界书关键词（"是谁"）让常驻+命中两条都进来 ----
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '你是谁呀？', atMe: true, nickname: '小明' });
  const t0 = Date.now();
  while (!stub.seen.length && Date.now() - t0 < 20000) await sleep(100);

  // ---- work 轮：主人发 /work ----
  mock.actions.length = 0;
  kernel.pipeline.submit({
    id: 'w1', platform: 'qq', type: 'group', chatId: String(GROUP), userId: String(MASTER),
    nickname: '主人', senderRole: 'owner',
    segments: [{ type: 'text', data: { text: '/work 统计 inbox 里有多少个文件' } }],
    text: '/work 统计 inbox 里有多少个文件', isAtMe: false, isReplyToMe: false, raw: {}, ts: Date.now(),
  });
  const t1 = Date.now();
  while (!stub.seen.some((b) => (b?.tools ?? []).some((t) => t.function?.name === 'work_finish')) && Date.now() - t1 < 30000) await sleep(150);

  const isWork = (b) => (b?.tools ?? []).some((t) => t.function?.name === 'work_finish');
  const chatBody = stub.seen.find((b) => !isWork(b));
  const workBody = stub.seen.find(isWork);

  mkdirSync(outDir, { recursive: true });
  if (chatBody) writeFileSync(join(outDir, 'chat-request.json'), JSON.stringify(chatBody, null, 2));
  if (workBody) writeFileSync(join(outDir, 'work-request.json'), JSON.stringify(workBody, null, 2));

  for (const [body, label] of [[chatBody, 'CHAT'], [workBody, 'WORK']]) {
    if (!body) { console.log(`\n${label}: 没抓到\n`); continue; }
    const s = summarize(body, label);
    console.log(`\n${'='.repeat(78)}\n${label} 请求报文  model=${s.model} stream=${s.stream} max_tokens=${s.max_tokens} 消息 ${s.messageCount} 条 / 工具 ${s.toolCount} 个`);
    console.log(`工具：${s.tools.join(', ') || '（无）'}`);
    console.log(`${'─'.repeat(78)}\n【system 全文】\n${s.system}`);
    console.log(`${'─'.repeat(78)}\n【非 system 消息】\n${s.convoPreview.join('\n')}`);
    console.log(`\n（完整报文见 data/debug/${label === 'CHAT' ? 'chat' : 'work'}-request.json，共 ${JSON.stringify(body).length} 字符）`);
  }
} catch (e) {
  console.log('异常：', e.message);
} finally {
  try { mock?.close(); } catch { /* ignore */ }
  try { await kernel?.shutdown(); } catch { /* ignore */ }
  stub.close();
  await sleep(300);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}
