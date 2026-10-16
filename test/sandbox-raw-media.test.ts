import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { Kernel } from '../src/kernel/kernel.ts';
import { startApiServer } from '../src/kernel/api/server.ts';
import type { ChatRef } from '../src/kernel/types.ts';

/**
 * 桌面端播放聊天记录里的语音/视频，靠的是 /api/sandbox/raw 这一条路：
 *  - 语音/视频要能拖进度条 → 必须支持 Range（<video>/<audio> 靠 206 分段取）
 *  - 但内联白名单不能放宽：svg/html 一类能带脚本的绝不放（同源内联等于把沙箱目录变成执行位）
 * 两头都得钉住，所以单独一个用例文件。
 */
const CHAT: ChatRef = { platform: 'qq', type: 'group', chatId: '770001' };
let kernel: Kernel;
let server: Server;
let dataDir: string;
let port = 0;
let token = '';

const url = (path: string) => `http://127.0.0.1:${port}/api/sandbox/raw?chat=group_770001&path=${encodeURIComponent(path)}&token=${token}`;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'parallel-raw-'));
  port = 30000 + (process.pid % 20000);
  kernel = new Kernel({ dataDir, noApi: true });
  kernel.config.config.ui.port = port;
  (kernel.config.config.onebot as unknown as { port: number }).port = port + 1;
  await kernel.boot();
  server = await startApiServer(kernel);
  token = kernel.config.secrets.uiToken;
  const inbox = join(kernel.sandbox.root(CHAT), 'inbox');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'a.png'), Buffer.alloc(50, 1));
  writeFileSync(join(inbox, 'v.silk'), Buffer.alloc(2000, 7));
  writeFileSync(join(inbox, 'm.mp4'), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  writeFileSync(join(inbox, 'evil.svg'), Buffer.from('<svg onload="alert(1)"></svg>'));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await kernel.shutdown();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Temp 目录系统会回收 */ }
});

test('图片仍走一次性读取：200 + 正确 MIME + 完整字节', async () => {
  const r = await fetch(url('inbox/a.png'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal((await r.arrayBuffer()).byteLength, 50);
});

test('语音/视频内联可播：声明 accept-ranges，Range 请求回 206 且分段内容对得上', async () => {
  const full = await fetch(url('inbox/m.mp4'));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal((await full.arrayBuffer()).byteLength, 1000);

  const part = await fetch(url('inbox/m.mp4'), { headers: { range: 'bytes=100-199' } });
  const buf = Buffer.from(await part.arrayBuffer());
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
  assert.equal(buf.length, 100);
  assert.equal(buf[0], 100, '分段要从第 100 字节接上，不能把整份重发一遍');
  assert.equal(buf[99], 199);

  const tail = await fetch(url('inbox/v.silk'), { headers: { range: 'bytes=1990-' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-type'), 'audio/silk');
  assert.equal(Buffer.from(await tail.arrayBuffer()).length, 10);
});

test('越界 Range 回 416，不许把整份文件当分段发出去', async () => {
  const r = await fetch(url('inbox/m.mp4'), { headers: { range: 'bytes=5000-6000' } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), 'bytes */1000');
});

test('白名单没放宽：svg 这类能带脚本的类型照样拒绝，越界路径也挡住', async () => {
  assert.equal((await fetch(url('inbox/evil.svg'))).status, 404);
  const bad = await fetch(url('../../secrets.json'));
  assert.ok(bad.status >= 400, `越界路径必须挡住，实得 ${bad.status}`);
});
