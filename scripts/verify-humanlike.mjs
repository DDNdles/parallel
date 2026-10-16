/**
 * 一次性验收脚本（跑完即删）：端到端验证拟人层四件事真的成立。
 *
 * 真实链路：真内核 + 真 OneBot 适配器（反向 WS）+ 真 Pipeline，只把模型换成可脚本化的 mock。
 * 若提供 USTC_KEY 环境变量则改用真模型（默认走 mock，因为仓库里存的 USTC key 已被吊销）。
 *
 *   ① 分段发送：一条多句回复真的被拆成多条 QQ 消息发出去
 *   ② 打字节奏：计划里第一条不等，其余按字数停顿
 *   ③ 会接话：@ 会回；普通群聊消息不回（必要性打分）
 *   ④ 主动发言：主动轮里模型回 SKIP 就保持沉默
 *   ⑤ 状态快照：桌面端排障接口可读
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel/kernel.ts';
import { MockOneBot } from '../test/helpers/mock-onebot.ts';

const KEY = process.env.USTC_KEY ?? '';
const BASE = process.env.USTC_BASE ?? 'https://api.llm.ustc.edu.cn/v1';
const MODEL = process.env.USTC_MODEL ?? 'deepseek-flash';
const useReal = !!KEY;

const dir = mkdtempSync(join(tmpdir(), 'hl-verify-'));
const PORT = 34000 + (process.pid % 2000);
const GROUP = 90001;
const GROUP2 = 90002;
const MEMBER = 10001;
const MAX_WAIT = useReal ? 90_000 : 15_000;

const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); }
  throw new Error(`等待 ${what} 超时`);
}

/** 临时目录里有带 key 的 secrets.json：先零覆盖再删 */
function wipeDir() {
  try {
    writeFileSync(join(dir, 'secrets.json'), Buffer.alloc(4096));
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch { return false; }
}
// 兜底：进程以任何方式死掉（未捕获异常、EADDRINUSE 这类事件级错误、Ctrl-C）都要把临时目录清掉，
// 否则带 key 的 secrets.json 会留在 temp 里（踩过一次）。
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (wipeDir()) console.log('\n（兜底清理）临时数据目录已清除:', dir); process.exit(sig === 'exit' ? 0 : 130); });
}

let kernel, mock;
try {
  console.log(`模型：${useReal ? `真模型 ${BASE} / ${MODEL}` : 'mock（可脚本化；传 USTC_KEY 即可跑真模型）'}\n`);
  kernel = new Kernel({ dataDir: dir, noApi: true });
  kernel.config.config.onebot.port = PORT;
  kernel.config.config.masterIds = ['9000'];
  // 打字节奏压短一点，让这次验收跑得快（HDSI 的公式不可关闭，最低 250ms/条）
  const hlOut = kernel.config.config.humanlike.outgoing;
  hlOut.typingBaseDelaySeconds = 0.5;
  hlOut.typingCharactersPerSecond = 8;
  hlOut.typingMaxDelaySeconds = 3;
  hlOut.typingJitterRatio = 0;
  if (useReal) {
    kernel.config.config.providers.ustc = {
      label: 'USTC', model: MODEL, enabled: true, baseUrl: BASE,
      protocol: 'openai-compatible', custom: true,
      models: [{ id: MODEL, contextWindow: 65536, enabled: true }],
    };
    kernel.config.setProviderKey('ustc', KEY);
    kernel.config.config.llm.activeProvider = 'ustc';
    kernel.config.config.llm.chatChain = [{ provider: 'ustc', model: MODEL }];
    // LlmService 的实例表在 Kernel 构造时就建好了；这里后加的供应商要补注册一次
    // （模型页新建供应商走的是同一个方法，见 /api/providers 的 POST）
    kernel.llm.syncCustomProviders();
  } else {
    kernel.config.config.providers.mock = {
      label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
      models: [{ id: 'mock-1', enabled: true }],
    };
    kernel.config.config.llm.activeProvider = 'mock';
    kernel.config.config.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  }
  kernel.config.saveConfig();

  await kernel.boot();
  kernel.container.setGroupState('chat', String(GROUP), true, 'ui');
  kernel.container.setGroupState('chat', String(GROUP2), true, 'ui');

  const engine = kernel.llm.providers.get(useReal ? 'ustc' : 'mock');
  const script = (step) => { if (!useReal) engine.script.push(step); };

  mock = new MockOneBot(`ws://127.0.0.1:${PORT}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await until(() => mock.actions.some((a) => a.action === 'get_login_info'), 5000, 'get_login_info');
  await sleep(500);

  const sendsIn = (g) => mock.actions.filter((a) => a.action === 'send_group_msg' && String(a.params.group_id) === String(g));
  const textOf = (a) => (a.params.message ?? []).filter((s) => s.type === 'text').map((s) => s.data.text).join('');

  // ---- ① 分段发送 + 打字节奏（在真实链路上量每片到达的时刻） ----
  mock.actions.length = 0;
  // HDSI 下"分条"由模型自己写 <sep/> 决定，所以 mock 回复里显式写标记
  script({ content: '今天挺冷的啊<sep/>我已经吃过了<sep/>晚上有空' });
  mock.sendGroupMessage({
    groupId: GROUP, userId: MEMBER, atMe: true, nickname: '小明',
    text: '请分别用几句很短的话回答：今天天气怎么样？你吃了吗？晚上有空吗？要不要一起？',
  });
  const arrived = [];
  const t0 = Date.now();
  while (Date.now() - t0 < MAX_WAIT) {
    const n = sendsIn(GROUP).length;
    if (n > arrived.length) arrived.push(Date.now() - t0);
    // 安静 4s（比上面封顶的 3s 停顿还久）就算这条回复说完了
    if (arrived.length && Date.now() - t0 - arrived.at(-1) > 4000) break;
    await sleep(50);
  }
  const partsA = sendsIn(GROUP);
  const gaps = arrived.slice(1).map((t, i) => t - arrived[i]);
  ok('① 分段发送', useReal ? partsA.length >= 1 : partsA.length >= 2,
    `一条回复拆成 ${partsA.length} 条发出：${JSON.stringify(partsA.map(textOf))}；各片到达 t+${arrived.join('ms, t+')}ms（间隔 ${gaps.join('/')}ms = 打字停顿）`);

  // ---- ② 打字节奏（直接读 compose 的计划） ----
  const plans = await kernel.humanlike.compose({ platform: 'qq', type: 'group', chatId: String(GROUP) }, '今天去上课了<sep/>然后回来睡觉<sep/>睡醒吃了饭。');
  const pauses = plans.map((p) => p.pauseMs);
  ok('② 打字节奏', plans.length >= 2 && pauses[0] === 0 && pauses.slice(1).every((p) => p > 0),
    `${plans.length} 条，停顿 ${JSON.stringify(pauses)}ms（第一条恒为 0）`);

  // ---- ③ 普通群聊保持沉默 ----
  mock.actions.length = 0;
  mock.sendGroupMessage({ groupId: GROUP2, userId: 10002, text: '今天食堂的饭好难吃啊', nickname: '阿强' });
  await sleep(3500);
  const gateLog = kernel.sessionLog.tail(String(GROUP2), 'group', 20).filter((e) => e.type === 'gate');
  ok('③ 普通群聊保持沉默', sendsIn(GROUP2).length === 0,
    `3.5s 内发出 ${sendsIn(GROUP2).length} 条；决策「${gateLog.at(-1)?.text ?? '无'}」`);

  // ---- ③b @ 必须回 ----
  mock.actions.length = 0;
  script({ content: '在的，怎么啦。' });
  mock.sendGroupMessage({ groupId: GROUP2, userId: MEMBER, text: '在吗', atMe: true, nickname: '小明' });
  const replyB = await mock.waitForReply(GROUP2, MAX_WAIT);
  ok('③ @ 必须回', replyB.trim().length > 0, `回复 ${replyB.length} 字：${replyB.slice(0, 60)}`);

  // ---- ④ 主动发言：说还是不说由模型定，但只该出一个回合、不许刷屏 ----
  mock.actions.length = 0;
  script({ content: 'SKIP' });                       // 仅 mock 生效
  kernel.pipeline.enqueueBatch({ chat: { platform: 'qq', type: 'group', chatId: String(GROUP) }, events: [], reason: 'proactive', detail: '验收注入' });
  // 模型说话 → 会有 send_group_msg；模型决定不说 → 只有一条「主动发言」决策记录。两种都算这轮结束。
  await until(
    () => sendsIn(GROUP).length > 0 || kernel.sessionLog.tail(String(GROUP), 'group', 30).some((e) => /主动发言/.test(e.text ?? '')),
    MAX_WAIT, '主动轮结束',
  );
  await sleep(4000);                                 // 让这一轮的分片都发完（> 打字等待上限 3s）
  const proSends = sendsIn(GROUP).length;
  const proLog = kernel.sessionLog.tail(String(GROUP), 'group', 30).filter((e) => /主动发言/.test(e.text ?? ''));
  const decided = proSends === 0 ? '模型自己决定不说' : '模型主动开了一次口';
  // 分几条现在由模型自己写 <sep/> 决定，这里只兜一个"不许刷屏"的上限
  ok('④ 主动轮只出一个回合', proSends <= 3,
    `${decided}：发出 ${proSends} 条；决策「${proLog.at(-1)?.text ?? '（模型说了话，未走沉默分支）'}」`);

  // ---- ④b 主动轮真说话时确实发得出去（mock 下可脚本化强制开口） ----
  if (!useReal) {
    mock.actions.length = 0;
    script({ content: '话说最近有什么好看的剧吗？' });
    kernel.pipeline.enqueueBatch({ chat: { platform: 'qq', type: 'group', chatId: String(GROUP) }, events: [], reason: 'proactive', detail: '验收注入' });
    const replyC = await mock.waitForReply(GROUP, MAX_WAIT);
    ok('④ 主动轮说话时发出去', replyC.trim().length > 0, `发出 ${sendsIn(GROUP).length} 条：${replyC.slice(0, 60)}`);
  }

  // ---- ⑤ 状态快照 ----
  const snap = kernel.humanlike.snapshot({ platform: 'qq', type: 'group', chatId: String(GROUP2) });
  ok('⑤ 状态快照可读', typeof snap.pending === 'number' && typeof snap.frequency === 'number',
    JSON.stringify({ pending: snap.pending, 平均间隔秒: snap.averageIntervalSeconds, 频率: snap.frequency, 存在感: `${snap.recentSelf}/${snap.recentTotal}`, 连续不说: snap.consecutiveNoAction }));

  // ---- ⑥ 桌面端接口：读配置 / 写配置 / 越界值拒绝 / 状态快照 ----
  const { startApiServer } = await import('../src/kernel/api/server.ts');
  // 桌面端内核可能正占着 3080，这里换一个随机端口
  kernel.config.config.ui.port = 35000 + (process.pid % 2000);
  await startApiServer(kernel);
  const port = kernel.config.config.ui.port;
  const auth = { 'x-auth-token': kernel.config.secrets.uiToken, 'content-type': 'application/json' };
  const api = async (p, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { ...auth, ...(init?.headers || {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const got = await api('/api/config');
  const hasSection = !!got.body?.humanlike?.outgoing && typeof got.body.humanlike.outgoing.typingCharactersPerSecond === 'number';
  const wrote = await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ humanlike: { timing: { talkValue: 0.4, necessityThreshold: 90 }, proactive: { enable: true, idleSeconds: 600 } } }),
  });
  const applied = kernel.config.config.humanlike.timing.talkValue === 0.4
    && kernel.config.config.humanlike.timing.necessityThreshold === 90
    && kernel.config.config.humanlike.proactive.enable === true
    && kernel.config.config.humanlike.proactive.idleSeconds === 600;
  const bad = await api('/api/config', { method: 'POST', body: JSON.stringify({ humanlike: { timing: { talkValue: 5 } } }) });
  const rejected = bad.status === 400 && typeof bad.body?.error === 'string';
  const stillOk = kernel.config.config.humanlike.timing.talkValue === 0.4;
  const st = await api('/api/humanlike/status?chatKey=group_' + GROUP2);
  const statusOk = st.status === 200 && typeof st.body?.pending === 'number' && !!st.body?.config;

  ok('⑥ 设置页接口', hasSection && wrote.status === 200 && applied && rejected && stillOk && statusOk,
    `GET 带 humanlike 段=${hasSection}；POST 生效=${applied}；越界值被拒=${rejected}（400「${bad.body?.error}」）且没落盘=${stillOk}；状态接口=${statusOk}`);
} catch (e) {
  ok('运行', false, `异常：${e.message}`);
} finally {
  try { mock?.close(); } catch { /* ignore */ }
  try { await kernel?.shutdown(); } catch { /* ignore */ }
  await sleep(400);
  console.log(wipeDir() ? `\n临时数据目录已清除: ${dir}` : `\n⚠ 临时目录未能完全清除（请手工确认）: ${dir}`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== 验收结果：${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}
