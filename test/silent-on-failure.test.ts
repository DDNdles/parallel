import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../src/kernel/kernel.ts';
import type { MockEngine } from '../src/kernel/services/mock-engine.ts';
import { MockOneBot } from './helpers/mock-onebot.ts';

/**
 * 模型失败 = 彻底沉默（用户定稿）：没接模型 / 额度耗尽 / 模型吐空内容时，
 * 群里一个字都不能发——"没能好好回答请再问一次"式的托词也不行。
 * 失败细节走报错中心与会话流（gate 条目），桌面端可查，群里不可见。
 */
let kernel: Kernel;
let dataDir: string;
let mock: MockOneBot;
let mockProvider: MockEngine;

const GROUP = 321;
const MEMBER = 10002;
const MASTER = 9998;

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 10000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等待 ${what} 超时`);
}

/** 沉默轮次不产生协议端动作，"留痕落在会话流"本身就是轮次结束信号 */
function turnEvidence() {
  const tail = kernel.sessionLog.tail(String(GROUP), 'group', 50);
  return tail.some((e) =>
    (e.type === 'gate' && String(e.text).includes('没有产出内容')) || e.type === 'error');
}

const sentCount = () =>
  mock.actions.filter((a) => a.action === 'send_group_msg' || a.action === 'send_private_msg').length;

const ONEBOT_PORT = 30000 + (process.pid % 20000); // 随机端口，与其他测试文件并行不冲突
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'parallel-silent-'));
  kernel = new Kernel({ dataDir, noApi: true });
  kernel.config.config.risk.replyRatePerMin = 10_000;
  kernel.chat.setRatePerMin(10_000);
  // 打字延迟压到 HDSI 下限（公式不可关闭），本用例只关心"发不发"，不关心节奏
  const hlOut = kernel.config.config.humanlike.outgoing;
  hlOut.typingBaseDelaySeconds = 0;
  hlOut.typingMaxDelaySeconds = 0;
  hlOut.typingJitterRatio = 0;
  kernel.config.config.onebot.port = ONEBOT_PORT;
  kernel.config.config.masterIds = [String(MASTER)];
  (kernel.config.config.providers as Record<string, unknown>).mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true }],
  };
  kernel.config.config.llm.activeProvider = 'mock';
  kernel.config.config.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  mockProvider = (kernel.llm as unknown as { providers: Map<string, MockEngine> }).providers.get('mock')!;
  await kernel.boot();
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
  mock = new MockOneBot(`ws://127.0.0.1:${ONEBOT_PORT}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await until(() => mock.actions.some((a) => a.action === 'get_login_info'), 5000, 'get_login_info');
  // 适配器是异步拿登录号的：selfId 没登记上前，@ 段比不出 isAtMe，第一条消息会被必要性门控吃掉
  await until(() => !!(kernel.adapter.status() as { selfId?: string }).selfId, 5000, '适配器 selfId');
});

// 攒货与计时器不能跨用例（与 e2e 同一纪律）
beforeEach(() => { kernel.humanlike.resetAll(); });

after(async () => {
  mock.close();
  await kernel.shutdown();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Temp 目录系统会回收 */ }
});

test('没接模型（链空）：群消息得到完全沉默', async () => {
  const llm = kernel.config.config.llm;
  llm.chatChain = [];
  llm.activeProvider = ''; // chainConfig 对空链会回退 activeProvider，两处都清掉才是真"没接模型"
  mock.actions.length = 0;
  try {
    mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: ' 在吗', atMe: true, nickname: '小明' });
    await until(turnEvidence, 10000, '沉默留痕（gate/error 条目）');
    assert.equal(sentCount(), 0, '模型链为空时一个字都不该发（包括托词）');
  } finally {
    llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
    llm.activeProvider = 'mock';
  }
});

test('模型吐空内容：同样完全沉默，且托词文案已死', async () => {
  mockProvider.script.push({ content: '' });
  mock.actions.length = 0;

  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: ' 说句话', atMe: true, nickname: '小明' });
  await until(turnEvidence, 10000, '"本轮没有产出内容"的 gate 条目');

  assert.equal(sentCount(), 0, '空回复不应发出任何消息');
  assert.ok(!mock.actions.some((a) => JSON.stringify(a.params).includes('再问我一次')),
    '旧的托词文案不应再出现');
});

test('链恢复后正常回复不受影响', async () => {
  mock.actions.length = 0;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: ' 你好呀', atMe: true, nickname: '小明' });
  const reply = await mock.waitForReply(GROUP);
  assert.ok(reply.trim().length > 0, '链恢复后应照常回复');
});
