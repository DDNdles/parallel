import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { Bus } from '../src/kernel/bus.ts';
import { ConfigStore } from '../src/kernel/config.ts';
import { Db } from '../src/kernel/db.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';
import { SandboxService, SandboxError } from '../src/kernel/services/sandbox.ts';

/**
 * 桌面端「沙箱文件」读取面（沙箱页的文件浏览器用的就是这三个方法）：
 * list 逐层列目录、preview 只把文本交给 UI、handOff 越界必须挡。
 * 不在测试里真调用 handOff 的成功分支——那会真的弹出资源管理器/看图窗口。
 */
function mk() {
  const dir = mkdtempSync(tmpdir() + '/psb-');
  const db = new Db(dir);
  const bus = new Bus();
  const errors = new ErrorCenter(bus, { dataDir: dir });
  const config = new ConfigStore(dir, bus, errors);
  return new SandboxService(dir, db, config, errors);
}
const chat = { platform: 'qq', type: 'group' as const, chatId: '77' };

test('列目录：文件与子目录分开，可逐层进入', () => {
  const sb = mk();
  sb.write(chat, 'note.md', '# 标题');
  sb.write(chat, 'out/report.txt', '报告正文');
  const top = sb.list(chat);
  assert.deepEqual(top.map((e) => [e.name, e.type]).filter(([n]) => n === 'out' || n === 'note.md'), [['out', 'dir'], ['note.md', 'file']]);
  assert.deepEqual(sb.list(chat, 'out').map((e) => e.relPath), ['out/report.txt']);
});

test('预览：文本给内容（可截断），二进制给 null', () => {
  const sb = mk();
  sb.write(chat, 'note.md', '# 标题\n正文');
  assert.deepEqual(sb.preview(chat, 'note.md'), { text: '# 标题\n正文', truncated: false });
  assert.deepEqual(sb.preview(chat, 'note.md', 3), { text: '# 标', truncated: true });
  sb.write(chat, 'raw.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  assert.equal(sb.preview(chat, 'raw.png'), null);
});

test('预览与打开都拦住越界路径和不存在的文件', () => {
  const sb = mk();
  sb.write(chat, 'note.md', 'x');
  assert.throws(() => sb.preview(chat, '../../config.json'), SandboxError);
  assert.throws(() => sb.handOff(chat, '../..'), SandboxError);
  assert.throws(() => sb.preview(chat, 'nope.txt'), SandboxError);
  assert.throws(() => sb.handOff(chat, 'nope.txt'), SandboxError);
});

test('沙箱里的符号链接不能把读写带出根目录', () => {
  const sb = mk();
  const outside = mkdtempSync(tmpdir() + '/pout-');
  writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET');
  try {
    // Windows 下目录 junction 不需要管理员/开发者模式；Linux 用普通目录链接
    symlinkSync(outside, join(sb.root(chat), 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return; // 环境不允许建链接（无权限）：跳过，不把测试做成假绿
  }
  assert.throws(() => sb.read(chat, 'escape/secret.txt'), SandboxError);
  assert.throws(() => sb.write(chat, 'escape/pwn.txt', 'x'), SandboxError);
  assert.equal(sb.list(chat).some((e) => e.name === 'escape'), false);
});

test('chatKey 消毒：chatId/scope 带 ../ 也只会落成一个目录名', () => {
  const sb = mk();
  const evil = { platform: 'qq', type: 'group' as const, chatId: '../../..', scope: '../u1' };
  const key = sb.chatKey(evil);
  assert.match(key, /^[A-Za-z0-9._-]+$/);
  assert.equal(key.includes('/'), false);
  assert.equal(key.includes('\\'), false);
  const root = sb.root(evil);
  const rel = relative(join(sb.root(chat), '..'), root);
  assert.equal(rel.startsWith('..'), false, `沙箱根跑出了 sandbox/：${root}`);
  assert.equal(sb.chatKey(chat), 'group_77');
});
