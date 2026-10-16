/**
 * 剧本体探针：真模型跑几轮 chat，把「模型原样输出 → 实际发出的消息」摊开看。
 * 用来确认模型是否真的按 `<say id>` 写小说，以及旁白有没有漏进 QQ。
 *
 *   USTC_KEY=... node --experimental-transform-types --no-warnings scripts/probe-scene.mjs
 *   （不给 USTC_KEY 就走 mock，只能验管道、验不了模型配不配合）
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

const GROUP = 92001;
const MEMBER = 10001;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'scene-'));
const PORT = 32000 + (process.pid % 2000);

/** 模型每一轮的原始输出（agent loop 收尾时从总线拿；会话日志里只留了发出去的那几条） */
const rawReplies = [];
let kernel, mock;

try {
  kernel = new Kernel({ dataDir: dir, noApi: true });
  kernel.config.config.onebot.port = PORT;
  kernel.config.config.masterIds = ['9000'];
  // 探针不等打字停顿（HDSI 公式不可关闭，压到下限 250ms/条）
  const hlOut = kernel.config.config.humanlike.outgoing;
  hlOut.typingBaseDelaySeconds = 0;
  hlOut.typingMaxDelaySeconds = 0;
  hlOut.typingJitterRatio = 0;
  if (useReal) {
    kernel.config.config.providers.ustc = {
      label: 'USTC', model: MODEL, enabled: true, baseUrl: BASE, protocol: 'openai-compatible', custom: true,
      models: [{ id: MODEL, contextWindow: 65536, enabled: true }],
    };
    kernel.config.setProviderKey('ustc', KEY);
    kernel.config.config.llm.activeProvider = 'ustc';
    kernel.config.config.llm.chatChain = [{ provider: 'ustc', model: MODEL }];
    kernel.llm.syncCustomProviders();
  } else {
    kernel.config.config.providers.mock = {
      label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
      models: [{ id: 'mock-1', enabled: true }],
    };
    kernel.config.config.llm.activeProvider = 'mock';
    kernel.config.config.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
    kernel.llm.providers.get('mock').script.push({
      content: '她懒得抬头。<say id="s1">知道了，这就去。</say><say id="s2">别催。</say>',
    });
  }
  kernel.config.saveConfig();
  kernel.bus.on('agent.end', (d) => rawReplies.push(String(d?.reply ?? '')));
  await kernel.boot();
  kernel.container.setGroupState('chat', String(GROUP), true, 'ui');

  mock = new MockOneBot(`ws://127.0.0.1:${PORT}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await sleep(600);

  const PROMPTS = [
    { text: '在吗', nickname: '小明' },
    { text: '今天食堂的饭好难吃', nickname: '阿强' },
    { text: '你是谁呀', nickname: '小美' },
    { text: '我最近老是失眠', nickname: '阿强' },
  ];
  for (const msg of PROMPTS) {
    mock.actions.length = 0;
    const before = rawReplies.length;
    mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, atMe: true, ...msg });
    const t0 = Date.now();
    // 有动静（发出消息）且拿到模型输出就算这轮结束；真模型慢，给足时间
    while (Date.now() - t0 < (useReal ? 90_000 : 8000)) {
      if (mock.actions.some((a) => a.action === 'send_group_msg') && rawReplies.length > before) break;
      await sleep(200);
    }
    await sleep(700);

    const sent = mock.actions
      .filter((a) => a.action === 'send_group_msg')
      .map((a) => (a.params.message ?? []).filter((s) => s.type === 'text').map((s) => s.data.text).join(''));
    console.log(`\n${'='.repeat(76)}`);
    console.log(`【${msg.nickname}】${msg.text}`);
    console.log('  模型原样输出：');
    for (const line of (rawReplies.at(-1) ?? '（没拿到）').split('\n')) console.log('    | ' + line);
    console.log(`  实际发出 ${sent.length} 条：${JSON.stringify(sent)}`);
    const leaked = sent.filter((s) => /[（(][^）)]{1,20}[）)]|[*＊][^*＊]{1,20}[*＊]|<\/?say/.test(s));
    console.log(`  可疑（旁白/标签漏出）：${leaked.length ? JSON.stringify(leaked) : '无'}`);
  }
} catch (e) {
  console.log('异常：', e.message);
} finally {
  try { mock?.close(); } catch { /* ignore */ }
  try { await kernel?.shutdown(); } catch { /* ignore */ }
  await sleep(300);
  try {
    writeFileSync(join(dir, 'secrets.json'), Buffer.alloc(4096));
    rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
  process.exit(0);
}
