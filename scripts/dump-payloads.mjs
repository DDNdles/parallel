/**
 * 抓真实请求报文：起一个本地假端点顶替模型，让内核照常跑一轮 chat、一轮 work 和一轮 chat-media，
 * 把它实际发出去的 HTTP body（system / messages / tools 全都在里面）原样存下来并打印摘要。
 *
 *   node --experimental-transform-types --no-warnings scripts/dump-payloads.mjs
 *
 * chat-media 场景：先在临时数据目录里埋一份会话日志（3 小时前那条落在时间窗外、40 秒前那条带
 * 图与语音、30 秒前那条带一份聊天记录），再 @ 一句触发一轮。报文里因此能看见「上下文时限」
 * 「本轮媒体补传」两个分节，以及窗口内媒体的内容块。
 * 假 PNG / 假 WAV 由同一个本地 http 服务器回真字节：窗口内历史的附件只留 URL（带 rkey 的临时
 * 链不落盘），内核是 fetch 现取的，所以数据目录里不需要真有那两个文件。
 *
 * 产物：data/debug/chat-request.json、data/debug/work-request.json、data/debug/chat-request-media.json
 * （data/ 不入库）只打印 body，不打印 Authorization 头，也不碰任何真 key。
 * chat-media 场景自带硬断言（见 assertMedia）：时间窗外那条漏进请求体、窗口内图片块没出现、
 * 语音块没挂到最后一条 user、system 少了「上下文时限」、工具面不是那 8 个，都会 exit 1。
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
/** chat-media 场景单独开一个群：窗口历史只有埋进去的那三条，断言不用绕开别的场景留下的消息 */
const GROUP_MEDIA = 91002;
const MEMBER = 10001;
/** 埋进会话日志的人（都是普通群员，不是主人） */
const OWNER_OF_LOG = 10002;
const OTHER_OF_LOG = 10003;
const MASTER = 9999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 时间窗外那条的正文：只在埋进去的会话日志里存在，这一发请求体里出现它就说明时间窗没生效 */
const OUTSIDE_TEXT = '三小时前那句早该出了时间窗的话';

/** 窗口内历史要用到的假媒体字节：真字节由下面的本地 http 服务器回，会话日志里只写 URL */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
/** 合法的最小 WAV（RIFF/fmt/data，data 段放几个字节的"静音"）：容器对端认，不用 ffmpeg 转 */
const WAV = (() => {
  const pcm = Buffer.alloc(64, 7);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
})();
const MEDIA_BYTES = {
  'pic.png': { buf: PNG, type: 'image/png' },
  'voice.wav': { buf: WAV, type: 'audio/wav' },
};

/**
 * 假端点：记下 body，回一段合法的 OpenAI 流式响应（纯文本、不调工具）。
 * 同一个服务器顺手当假媒体源（`/media/<名字>`）：窗口内历史的附件是内核按 URL fetch 现取的，
 * 得有个真服务器回真字节；URL 必须是 http —— file:// 走不到 fetch，内核只会按"读不动"如实跳过。
 */
function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    const path = String(req.url ?? '');
    if (path.startsWith('/media/')) {
      const m = MEDIA_BYTES[path.split('/').pop() ?? ''];
      if (!m) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': m.type, 'content-length': m.buf.length });
      res.end(m.buf);
      return;
    }
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
const mediaUrl = (name) => `http://127.0.0.1:${port}/media/${name}`;
const dataDir = mkdtempSync(join(tmpdir(), 'dump-'));
let kernel, mock;
/** chat-media 场景的断言失败原因；有一条就 exit 1 */
const failures = [];

/**
 * 在临时数据目录里埋一份 chat-media 场景的会话日志。
 *
 * 走的是内核自己的读取路径（SessionLog.project ← data/sessions/<chatKey>.jsonl）：内核 boot 后这条
 * 会话的第一条入站消息会先把历史从磁盘重建一次，时间窗按每条自己的 ts 筛，所以"窗外/窗内"由这里的
 * ts 决定。**parentId 必须连成一条链** —— project() 是沿活动叶子往回走的，断链的那几条等于没埋。
 *
 * 附件只写 URL：真链带 rkey 且几小时就过期，落盘的那份才存 rel/sandboxPath，这里没有真实沙箱件。
 * 这正是内核认得的那种形状（`loadBuffer`：先读本机路径，读不动再按 url 取——收件被保留期清掉就只剩 URL）。
 * 记录第三条的 depth=1 就是"记录里套记录"——适配器取回时把嵌套记录的节点摊到父节点后面并打上层号，
 * 这里照那个形状存（只放里面那层，所以是 3 节点）。
 */
function plantMediaSessionLog(dir, urlOf) {
  const now = Date.now();
  const sessions = join(dir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const line = (o) => JSON.stringify({ chatId: String(GROUP_MEDIA), chatType: 'group', type: 'message_in', role: 'user', ...o });
  const lines = [
    // ① 约 3 小时前：纯文本，落在 5 分钟时间窗之外——这一发请求体里出现它就说明窗没生效
    line({ id: 's_media_1', parentId: null, ts: now - 3 * 60 * 60_000, userId: String(OWNER_OF_LOG), nickname: '小红', text: OUTSIDE_TEXT }),
    // ② 约 40 秒前：顶层图 + 语音（一件在窗口内的媒体）
    line({
      id: 's_media_2', parentId: 's_media_1', ts: now - 40_000, userId: String(OWNER_OF_LOG), nickname: '小红',
      text: '刚拍的图，还有我哼的那两句',
      data: { files: [{ name: 'pic.png', url: urlOf('pic.png') }, { name: 'voice.wav', url: urlOf('voice.wav') }] },
    }),
    // ③ 约 30 秒前：聊天记录 3 节点 = 图片 + 纯文本 + 一层嵌套记录
    line({
      id: 's_media_3', parentId: 's_media_2', ts: now - 30_000, userId: String(OTHER_OF_LOG), nickname: '小刚',
      text: '[聊天记录]',
      data: {
        forward: {
          id: 'res-media-log', title: '群聊的聊天记录', dropped: 0, failed: false,
          nodes: [
            { nickname: '小明', userId: String(MEMBER), text: '看这张', ts: now - 120_000, files: [{ name: 'pic.png', url: urlOf('pic.png') }] },
            { nickname: '小刚', userId: String(OTHER_OF_LOG), text: '这张我先存着了', ts: now - 110_000 },
            { nickname: '小红', userId: String(OWNER_OF_LOG), text: '里面那层说的：别往外传', ts: now - 100_000, depth: 1 },
          ],
        },
      },
    }),
  ];
  writeFileSync(join(sessions, `group_${GROUP_MEDIA}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

/** 一条消息的内容块（正文是字符串时按 OpenAI 的写法包一层） */
function blocksOf(m) {
  if (typeof m?.content === 'string') return m.content ? [{ type: 'text', text: m.content }] : [];
  return Array.isArray(m?.content) ? m.content : [];
}

/** 从 system 里摘出一节的原文（分节之间是空行，节内是单换行） */
function systemSection(system, title) {
  const m = new RegExp(`# ${title}\\n([\\s\\S]*?)(?=\\n\\n|$)`).exec(system);
  return m ? `# ${title}\n${m[1]}`.trim() : undefined;
}

/**
 * chat-media 场景的硬断言。判"模型到底收没收到"只看真发出去的报文，不看代码猜：
 * 时间窗外那条一个字都不该有；窗口内的图/语音必须真出现在块里（语音挂在最后一条 user 上）。
 * 返回失败清单，调用方据此 exit 1。
 */
function assertMedia(body) {
  const fails = [];
  const say = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg); };
  const messages = body?.messages ?? [];
  const flat = JSON.stringify(body ?? null);
  const users = messages.filter((m) => m?.role === 'user');
  const lastUserBlocks = blocksOf(users[users.length - 1]);
  const allBlocks = messages.filter((m) => m?.role !== 'system').flatMap(blocksOf);
  const count = (bs, type) => bs.filter((b) => b?.type === type).length;

  say(!flat.includes(OUTSIDE_TEXT), `时间窗外那条（3 小时前）不在请求体里`);
  // 正面证据：窗内那两条确实进来了——不然"窗内图片块 ≥1"绿得没意义
  say(flat.includes('刚拍的图，还有我哼的那两句') && flat.includes('这张我先存着了'),
    '窗口内两条历史（40 秒前带图与语音 / 30 秒前带聊天记录）都在请求体里');
  const images = count(allBlocks, 'image_url');
  say(images >= 1, `窗口内图片块 ${images} 个（要求 ≥1；顶层那张 + 记录里那张）`);
  const audiosLast = count(lastUserBlocks, 'input_audio');
  say(audiosLast >= 1, `窗口内语音块 ${audiosLast} 个挂在最后一条 user 上（要求 ≥1）`);
  // 这一轮窗口里没有视频件，所以"零"才是正确答案——有块才是凭空长出来的
  const videos = count(allBlocks, 'video_url');
  say(videos === 0, `这轮窗口里没有视频件：video_url 块 ${videos} 个（如实说明，没有对应件）`);
  const withImg = users.filter((m) => count(blocksOf(m), 'image_url') > 0).length;
  say(withImg >= 2, `图片分别长在 ${withImg} 条 user 上（按消息归位，不是全堆在最后一条）`);

  const system = messages.filter((m) => m?.role === 'system').map((m) => String(m.content ?? '')).join('\n');
  say(system.includes('上下文时限'), 'system 含「上下文时限」（405 分节）');
  const tools = (body?.tools ?? []).map((t) => t.function?.name).filter(Boolean).sort();
  const want = ['forget_me', 'plan_schedule', 'recall_facts', 'remember_fact', 'remember_setting', 'search_history', 'web_fetch', 'web_search'];
  say(tools.length === 8 && JSON.stringify(tools) === JSON.stringify(want),
    `工具恰好 8 个（实得 ${tools.length} 个：${tools.join(', ') || '无'}）`);
  return fails;
}

try {
  // chat-media 的历史必须在建内核之前就躺在临时数据目录里：内核是冷启动读它重建窗口内历史的
  plantMediaSessionLog(dataDir, mediaUrl);
  kernel = new Kernel({ dataDir, noApi: true });
  kernel.config.config.onebot.port = 31000 + (process.pid % 2000);
  kernel.config.config.masterIds = [String(MASTER)];
  kernel.config.config.providers.stub = {
    label: 'Stub', model: 'stub-model', enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`,
    protocol: 'openai-compatible', custom: true,
    // inputTypes 是模型页那列「输入类型」，缺了它链首检查按"什么都不收"处理：
    // 窗口内的图会被拦在播种区、音视频会被 chainStreamFn 的筛子滤掉（各自留一条 warn），报文里就什么都看不到
    models: [{ id: 'stub-model', contextWindow: 65536, enabled: true, inputTypes: ['text', 'image', 'audio', 'video'] }],
  };
  kernel.config.config.llm.activeProvider = 'stub';
  kernel.config.config.llm.chatChain = [{ provider: 'stub', model: 'stub-model' }];
  kernel.config.setProviderKey('stub', 'stub-not-a-real-key');
  kernel.config.saveConfig();
  kernel.llm.syncCustomProviders();

  await kernel.boot();
  kernel.container.setGroupState('chat', String(GROUP), true, 'ui');
  kernel.container.setGroupState('work', String(GROUP), true, 'ui');
  kernel.container.setGroupState('chat', String(GROUP_MEDIA), true, 'ui');

  mock = new MockOneBot(`ws://127.0.0.1:${kernel.config.config.onebot.port}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await sleep(600);
  mock.actions.length = 0;

  // ---- chat 轮：@ 一句，且带上世界书关键词（"是谁"）让常驻+命中两条都进来 ----
  const isWork = (b) => (b?.tools ?? []).some((t) => t.function?.name === 'work_finish');
  // 每轮各按"这一轮之后新到的报文"取：三个场景共用一个假端点，不划边界就会互相拿到对方的 body
  const chatSince = stub.seen.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '你是谁呀？', atMe: true, nickname: '小明' });
  const t0 = Date.now();
  while (stub.seen.length <= chatSince && Date.now() - t0 < 20000) await sleep(100);

  // ---- work 轮：主人发 /work ----
  mock.actions.length = 0;
  const workSince = stub.seen.length;
  kernel.pipeline.submit({
    id: 'w1', platform: 'qq', type: 'group', chatId: String(GROUP), userId: String(MASTER),
    nickname: '主人', senderRole: 'owner',
    segments: [{ type: 'text', data: { text: '/work 统计 inbox 里有多少个文件' } }],
    text: '/work 统计 inbox 里有多少个文件', isAtMe: false, isReplyToMe: false, raw: {}, ts: Date.now(),
  });
  const t1 = Date.now();
  while (!stub.seen.slice(workSince).some(isWork) && Date.now() - t1 < 30000) await sleep(150);

  // ---- chat-media 轮：窗口内的历史已经在数据目录里躺着了，这里只 @ 一句触发 ----
  const mediaSince = stub.seen.length;
  mock.sendGroupMessage({ groupId: GROUP_MEDIA, userId: MEMBER, text: '看看我刚发你的那些', atMe: true, nickname: '小明' });
  const t2 = Date.now();
  while (!stub.seen.slice(mediaSince).some((b) => !isWork(b)) && Date.now() - t2 < 20000) await sleep(100);

  const chatBody = stub.seen.slice(chatSince).find((b) => !isWork(b));
  const workBody = stub.seen.slice(workSince).find(isWork);
  const mediaBody = stub.seen.slice(mediaSince).find((b) => !isWork(b));

  mkdirSync(outDir, { recursive: true });
  if (chatBody) writeFileSync(join(outDir, 'chat-request.json'), JSON.stringify(chatBody, null, 2));
  if (workBody) writeFileSync(join(outDir, 'work-request.json'), JSON.stringify(workBody, null, 2));
  if (mediaBody) writeFileSync(join(outDir, 'chat-request-media.json'), JSON.stringify(mediaBody, null, 2));

  for (const [body, label] of [[chatBody, 'CHAT'], [workBody, 'WORK']]) {
    if (!body) { console.log(`\n${label}: 没抓到\n`); continue; }
    const s = summarize(body, label);
    console.log(`\n${'='.repeat(78)}\n${label} 请求报文  model=${s.model} stream=${s.stream} max_tokens=${s.max_tokens} 消息 ${s.messageCount} 条 / 工具 ${s.toolCount} 个`);
    console.log(`工具：${s.tools.join(', ') || '（无）'}`);
    console.log(`${'─'.repeat(78)}\n【system 全文】\n${s.system}`);
    console.log(`${'─'.repeat(78)}\n【非 system 消息】\n${s.convoPreview.join('\n')}`);
    console.log(`\n（完整报文见 data/debug/${label === 'CHAT' ? 'chat' : 'work'}-request.json，共 ${JSON.stringify(body).length} 字符）`);
  }

  // ---- CHAT-MEDIA：媒体视角的摘要 + 硬断言 ----
  if (!mediaBody) {
    failures.push('CHAT-MEDIA 没抓到报文');
    console.log(`\nCHAT-MEDIA: 没抓到\n`);
  } else {
    const s = summarize(mediaBody, 'CHAT-MEDIA');
    console.log(`\n${'='.repeat(78)}\nCHAT-MEDIA 请求报文  model=${s.model} stream=${s.stream} max_tokens=${s.max_tokens} 消息 ${s.messageCount} 条 / 工具 ${s.toolCount} 个`);
    console.log(`工具：${s.tools.join(', ') || '（无）'}`);
    for (const title of ['上下文时限', '本轮媒体补传']) {
      const sec = systemSection(s.system, title);
      console.log(`${'─'.repeat(78)}\n【system 分节】\n${sec ?? `（没有这一节：${title}）`}`);
    }
    console.log(`${'─'.repeat(78)}\n【内容块分布】（只看 user 消息）`);
    const users = (mediaBody.messages ?? []).filter((m) => m?.role === 'user');
    users.forEach((m, i) => {
      const kinds = blocksOf(m).map((b) => (b?.type === 'text'
        ? `text「${String(b.text ?? '').replace(/\s+/g, ' ').slice(0, 46)}」`
        : String(b?.type)));
      console.log(`  user#${i + 1}: ${kinds.join(' | ') || '（空）'}`);
    });
    console.log(`${'─'.repeat(78)}\n【硬断言】`);
    failures.push(...assertMedia(mediaBody));
    console.log(`\n（完整报文见 data/debug/chat-request-media.json，共 ${JSON.stringify(mediaBody).length} 字符）`);
  }
} catch (e) {
  console.log('异常：', e.message);
  failures.push(`脚本异常：${e.message}`);
} finally {
  try { mock?.close(); } catch { /* ignore */ }
  try { await kernel?.shutdown(); } catch { /* ignore */ }
  stub.close();
  await sleep(300);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (failures.length) console.log(`\n断言失败 ${failures.length} 条：\n- ${failures.join('\n- ')}\n`);
  process.exit(failures.length ? 1 : 0);
}
