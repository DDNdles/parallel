import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { faceTokensToNames, faceTokensToSegments, qqFaceId, qqFaceName } from '../src/kernel/util/qqface.ts';
import { MockOneBot } from './helpers/mock-onebot.ts';

// ============================================================
// QQ 经典表情：名称表 + 出站 face 段。
// 入站 `[表情:32]` 给模型前换成 `[表情:疑问]`；模型写 `[表情/微笑]` 时发成真正的 face 段。
// ============================================================

test('QQ 表情：编号与名称互查，未知名称不硬猜', () => {
  assert.equal(qqFaceName('32'), '疑问');
  assert.equal(qqFaceId('疑问'), '32');
  assert.equal(qqFaceId('14'), '14');
  assert.equal(qqFaceId('没有这个表情'), undefined);
  // 模型常把名字写短：语义明确的简称补上，多义的（笑）继续不猜
  assert.equal(qqFaceId('呜呜'), '386', '呜呜 → 呜呜呜');
  assert.equal(qqFaceId('哭'), '9', '哭 → 大哭');
  assert.equal(qqFaceId('笑'), undefined, '笑有多义候选，不硬猜');
  assert.equal(faceTokensToNames('收到[表情:32]'), '收到[表情:疑问]');
  assert.equal(faceTokensToNames('[表情:9999]'), '[表情:9999]', '不认识的编号保持原样');
  assert.deepEqual(faceTokensToSegments('好[表情/微笑]呀'), [
    { type: 'text', data: { text: '好' } },
    { type: 'face', data: { id: '14' } },
    { type: 'text', data: { text: '呀' } },
  ]);
  assert.deepEqual(faceTokensToSegments('写不出来[表情:呜呜]'), [
    { type: 'text', data: { text: '写不出来' } },
    { type: 'face', data: { id: '386' } },
  ]);
  assert.deepEqual(faceTokensToSegments('[表情:哭]'), [
    { type: 'face', data: { id: '9' } },
  ]);
  // 认不出来的令牌不吞字
  assert.deepEqual(faceTokensToSegments('不存在的[表情/没有这个]'), [
    { type: 'text', data: { text: '不存在的[表情/没有这个]' } },
  ]);
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待 ${what} 超时`);
}

test('出站：sendText 里的 [表情/微笑] 切成 face 段并落账', async () => {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-qq-face-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = 30000 + (process.pid % 20000);
  cfg.providers.mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true }],
  };
  cfg.llm.activeProvider = 'mock';
  cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  await kernel.boot();

  const mock = new MockOneBot(`ws://127.0.0.1:${cfg.onebot.port}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  try {
    await until(() => mock.actions.some((a) => a.action === 'get_login_info'), 5000, '协议端握手');
    mock.setReply('send_group_msg', { message_id: 1 });
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9601' };
    await kernel.chat.sendText(chat, '好[表情/微笑]');

    const act = await mock.waitForAction('send_group_msg', 5000);
    assert.deepEqual(act.params.message, [
      { type: 'text', data: { text: '好' } },
      { type: 'face', data: { id: '14' } },
    ], JSON.stringify(act.params.message));

    const out = kernel.sessionLog.tail('9601', 'group').find((e) => e.type === 'message_out');
    assert.equal(out?.text, '好[表情:14]', '落账保留编号，桌面端才能按 ID 找图');
  } finally {
    mock.close();
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
