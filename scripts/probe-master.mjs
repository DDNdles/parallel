/**
 * 主人私聊探针：复刻「君にも嘘をつこう」这条会话的形状（主人 3095966025 → 私聊），
 * 把「模型原样输出 → 实际发出的消息」摊开，顺带看风控与拟人化在真实输出下的表现：
 *   - 一轮回复被拆成几条、每条之间停多久
 *   - 限速按条计费（replyRatePerMin 条/分钟）在这条会话上够不够用
 *   - 抖动有没有和打字停顿叠加
 *
 * Key 只从环境变量读，绝不落盘到仓库：
 *   MASTERY_KEY=... node --experimental-transform-types --no-warnings scripts/probe-master.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel/kernel.ts';
import { MockOneBot } from '../test/helpers/mock-onebot.ts';

const KEY = process.env.MASTERY_KEY ?? '';
const BASE = process.env.MASTERY_BASE ?? 'https://api.llm.ustc.edu.cn/v1';
const MODEL = process.env.MASTERY_MODEL ?? 'deepseek-flash';
const useReal = !!KEY;

const MASTER = '3095966025';       // 主人私聊会话的另一端
const CHAT = MASTER;               // 私聊 chatId 就是对方的号码（读会话日志要用它，别用探针自己的名字）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'master-'));
const PORT = 34000 + (process.pid % 2000);

const rawReplies = [];
const outs = [];
let kernel, mock;

try {
  kernel = new Kernel({ dataDir: dir, noApi: true });
  kernel.config.config.risk.replyRatePerMin = Number(process.env.PROBE_RATE ?? 12);  // 默认保持产品值，别在探针里放宽
  kernel.config.config.onebot.port = PORT;
  kernel.config.config.masterIds = [MASTER];
  // 分几条由模型自己写 <sep/> 决定（HDSI 口径，不再有"表达风格"这个注入口）：
  // 想验证多条拆分与按条限速时，让模型在回复里输出 <sep/>。
  const hlOut = kernel.config.config.humanlike.outgoing;
  hlOut.typingMaxDelaySeconds = 8;                    // 配合下面"安静 9s"的收尾窗口
  hlOut.typingJitterRatio = 0;
  if (useReal) {
    kernel.config.config.providers.probe = {
      label: 'Probe', model: MODEL, enabled: true, baseUrl: BASE, protocol: 'openai-compatible', custom: true,
      models: [{ id: MODEL, contextWindow: 65536, enabled: true }],
    };
    kernel.config.setProviderKey('probe', KEY);
    kernel.config.config.llm.activeProvider = 'probe';
    kernel.config.config.llm.chatChain = [{ provider: 'probe', model: MODEL }];
    kernel.llm.syncCustomProviders();
  } else {
    kernel.config.config.providers.mock = {
      label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
      models: [{ id: 'mock-1', enabled: true }],
    };
    kernel.config.config.llm.activeProvider = 'mock';
    kernel.config.config.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
    kernel.llm.providers.get('mock').script.push({ content: '（mock）在的。' });
  }
  kernel.config.saveConfig();
  kernel.bus.on('agent.end', (d) => rawReplies.push(String(d?.reply ?? '')));
  await kernel.boot();

  mock = new MockOneBot(`ws://127.0.0.1:${PORT}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await sleep(600);

  const PROMPTS = ['在吗', '今天天气怎么样', '我有点睡不着'];
  for (const text of PROMPTS) {
    mock.actions.length = 0;
    const before = rawReplies.length;
    const t0 = Date.now();
    mock.sendPrivateMessage({ userId: Number(MASTER), nickname: '主人', text });

    // 等模型出结果 + 第一条发出，之后还要等后续几条（每条前面有打字停顿）。
    // 只等"第一条"会把后半程的气泡记到下一轮里去 —— 这里等到动作安静下来为止。
    const deadline = t0 + (useReal ? 120_000 : 10_000);
    let lastCount = -1, quietSince = 0;
    while (Date.now() < deadline) {
      const n = mock.actions.filter((a) => a.action === 'send_private_msg').length;
      const started = rawReplies.length > before && n > 0;
      if (!started) { quietSince = 0; lastCount = n; await sleep(150); continue; }
      if (n !== lastCount) { lastCount = n; quietSince = Date.now(); await sleep(120); continue; }
      if (!quietSince) { quietSince = Date.now(); await sleep(120); continue; }
      // 发出第一条之后再安静 9s：上面把打字等待上限压到 8s，窗口比它长就能把最后一条记进这一轮
      if (Date.now() - quietSince > 9000) break;
      await sleep(120);
    }

    const sent = mock.actions
      .filter((a) => a.action === 'send_private_msg')
      .map((a) => (a.params.message ?? []).filter((s) => s.type === 'text').map((s) => s.data.text).join(''));
    const total = Date.now() - t0;

    console.log(`\n${'='.repeat(76)}`);
    console.log(`【主人】${text}    （${sent.length} 条，总耗时 ${total}ms）`);
    console.log('  模型原样输出：');
    for (const line of (rawReplies.at(-1) ?? '（没拿到）').split('\n')) console.log('    | ' + line);
    console.log(`  实际发出 ${sent.length} 条：`);
    for (const [i, s] of sent.entries()) console.log(`    ${i + 1}. ${s}`);
    outs.push(...sent);

    const leaked = sent.filter((s) => /[（(][^）)]{1,20}[）)]|[*＊][^*＊]{1,20}[*＊]|<\\?say/.test(s));
    console.log(`  可疑（旁白/标签漏出）：${leaked.length ? JSON.stringify(leaked) : '无'}`);
    console.log(`  抖动有没有叠加：${sent.length > 1 ? '见上面各条之间的间隔（有多条即说明停顿在起作用）' : '单条，无从体现'}`);
    const gates = kernel.sessionLog.tail(CHAT, 'private', 60).filter((e) => e.type === 'gate' || e.type === 'error');
    if (gates.length) console.log(`  gate/error：${gates.map((g) => g.text).join(' | ')}`);
  }

  console.log(`\n${'#'.repeat(76)}`);
  console.log(`合计发出 ${outs.length} 条，限速配置 ${kernel.config.config.risk.replyRatePerMin} 条/分钟`);
  const truncated = kernel.sessionLog.tail(CHAT, 'private', 200).filter((e) => e.data?.decision === 'rate_truncated');
  const dropped = kernel.sessionLog.tail(CHAT, 'private', 200).filter((e) => e.data?.decision === 'rate_limited');
  console.log(`限速截断 ${truncated.length} 次，整批丢弃 ${dropped.length} 次`);
} catch (e) {
  console.log('异常：', e.message);
} finally {
  try { mock?.close(); } catch { /* ignore */ }
  try { await kernel?.shutdown(); } catch { /* ignore */ }
  await sleep(300);
  try {
    writeFileSync(join(dir, 'secrets.json'), Buffer.alloc(4096));   // 先零覆写再删，别把 key 留在磁盘上
    rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
  process.exit(0);
}
