import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { MockOneBot } from './helpers/mock-onebot.ts';

// ============================================================
// 拉黑（users.blocked）的口径：bot 完全不收这个人的消息。
//  - 群聊/私聊都不落账、不记用量、不触发模型与出站；
//  - 适配器在下载之前就挡掉，图片/语音根本不进沙箱；
//  - 解除后此后的消息照常收（不补拉黑期间的历史）。
// ============================================================

const GROUP = 9603;
const BLOCKED = 20001;

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待 ${what} 超时`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-block-'));
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
  kernel.container.setGroupState('chat', String(GROUP), true, 'owner');
  const mock = new MockOneBot(`ws://127.0.0.1:${cfg.onebot.port}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await until(() => mock.actions.some((a) => a.action === 'get_login_info'), 5000, '协议端握手');
  return {
    kernel, mock,
    chat: { platform: 'qq' as const, type: 'group' as const, chatId: String(GROUP) },
    cleanup: async () => { mock.close(); await kernel.shutdown(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('拉黑 = 完全不收：群消息不落账、不触发模型与出站，解除后恢复', async () => {
  const k = await boot();
  try {
    k.kernel.memory.setBlocked(String(BLOCKED), true);
    const before = k.kernel.memory.getProfile(String(BLOCKED)).lastSeen;
    k.mock.sendGroupMessage({ groupId: GROUP, userId: BLOCKED, text: '在吗在吗', nickname: '小明', atMe: true });
    await wait(800);

    const log = k.kernel.sessionLog.tail(String(GROUP), 'group');
    assert.ok(!log.some((e) => e.type === 'message_in'), '被拉黑的消息不能落账');
    assert.ok(!log.some((e) => String(e.text ?? '').includes('黑名单')), '也不能留「忽略」条目，口径是没收到');
    assert.equal(k.mock.actions.filter((a) => a.action === 'send_group_msg').length, 0, '@ 了也不回');
    assert.equal(k.kernel.memory.getProfile(String(BLOCKED)).lastSeen, before, '连 lastSeen 都不该动');

    // 解除后：此后的消息照常收（拉黑期间的没补）
    k.kernel.memory.setBlocked(String(BLOCKED), false);
    k.mock.sendGroupMessage({ groupId: GROUP, userId: BLOCKED, text: '解除了吗', nickname: '小明' });
    await until(() => k.kernel.sessionLog.tail(String(GROUP), 'group')
      .some((e) => e.type === 'message_in' && String(e.text ?? '').includes('解除了吗')), 5000, '解除后的入站');
  } finally {
    await k.cleanup();
  }
});

test('拉黑 = 完全不收：私聊同样静默，解除后照常回', async () => {
  const k = await boot();
  try {
    k.kernel.memory.setBlocked(String(BLOCKED), true);
    k.mock.sendPrivateMessage({ userId: BLOCKED, text: '私聊也不理我吗', nickname: '小明' });
    await wait(800);
    assert.ok(!k.kernel.sessionLog.tail(String(BLOCKED), 'private').some((e) => e.type === 'message_in'),
      '私聊消息也不能落账');
    assert.equal(k.mock.actions.filter((a) => a.action === 'send_private_msg').length, 0, '一个字都不发');

    k.kernel.memory.setBlocked(String(BLOCKED), false);
    k.mock.sendPrivateMessage({ userId: BLOCKED, text: '现在呢', nickname: '小明' });
    await until(() => k.mock.actions.some((a) => a.action === 'send_private_msg'), 8000, '解除后的回复');
  } finally {
    await k.cleanup();
  }
});

test('拉黑 = 连图片都不下载：适配器在落盘前收口', async () => {
  let hits = 0;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001a5f645f30000000049454e44ae426082', 'hex');
  const srv = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) });
    res.end(png);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const k = await boot();
  const imgUrl = `http://127.0.0.1:${port}/x.png`;
  try {
    k.kernel.memory.setBlocked(String(BLOCKED), true);
    k.mock.sendGroupMessage({
      groupId: GROUP, userId: BLOCKED, text: '看图', nickname: '小明',
      extraSegments: [{ type: 'image', data: { file: 'x.png', url: imgUrl } }],
    });
    await wait(1000);
    assert.equal(hits, 0, '被拉黑用户的图片不该被请求下载');
    // 沙箱根目录在启动时就会建好，这里看 inbox 里有没有落下来的文件
    const inbox = join(k.kernel.sandbox.root(k.chat), 'inbox');
    assert.equal(existsSync(inbox) ? readdirSync(inbox).length : 0, 0, '沙箱 inbox 不该出现文件');

    // 解除后同一张图要能下来：证明上面不是"链路本来就不通"
    k.kernel.memory.setBlocked(String(BLOCKED), false);
    k.mock.sendGroupMessage({
      groupId: GROUP, userId: BLOCKED, text: '再看', nickname: '小明',
      extraSegments: [{ type: 'image', data: { file: 'x.png', url: imgUrl } }],
    });
    await until(() => hits > 0, 8000, '解除后的图片下载');
    const hit = await until(() => k.kernel.sessionLog.tail(String(GROUP), 'group')
      .find((e) => e.type === 'message_in' && String(e.text ?? '').includes('再看')), 5000, '带图的入站');
    const files = (hit!.data as { files?: { rel?: string }[] } | undefined)?.files ?? [];
    assert.ok(files.some((f) => String(f.rel ?? '').startsWith('inbox/')), '图片应落到 inbox');
  } finally {
    await k.cleanup();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
