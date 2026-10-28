import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockOneBot } from './helpers/mock-onebot.ts';
import { workScopeOf } from '../src/kernel/services/work.ts';
import { isDeliverableArtifact } from '../src/kernel/services/artifacts.ts';

// ============================================================
// work 交付：正文直接一条、产物每份一条文件消息
// （2026-10-28 用户定：不再合并成「聊天记录」合集，也不再打 zip 包）。
// ============================================================

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待 ${what} 超时`);
}

test('sendDelivery：正文一条（@ + 文本），产物单独一条文件消息，不走合并转发', async () => {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-work-delivery-'));
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
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9602' };
    const scoped = { ...chat, scope: workScopeOf('10001') };
    kernel.sandbox.write(scoped, 'deliver.html', '<h1>ok</h1>\n');

    await kernel.chat.sendDelivery(scoped, {
      text: '做好了，看文件。',
      artifacts: ['deliver.html'],
      mention: { userId: '10001' },
    });

    const textAct = await mock.waitForAction('send_group_msg', 5000);
    assert.equal(textAct.params.group_id, '9602');
    const segs = textAct.params.message as any[];
    assert.equal(segs[0].type, 'at');
    assert.equal(String(segs[0].data.qq), '10001');
    assert.equal(segs[1].type, 'text');
    assert.equal(segs[1].data.text, '做好了，看文件。');

    const fileAct = await mock.waitForAction('upload_group_file', 5000);
    assert.equal(fileAct.params.group_id, '9602');
    assert.equal(fileAct.params.name, 'deliver.html');
    assert.match(String(fileAct.params.file), /deliver\.html$/);

    assert.equal(mock.actions.filter((a) => a.action === 'send_forward_msg').length, 0, '不再发合并转发');

    const outs = kernel.sessionLog.tail('9602', 'group').filter((e) => e.type === 'message_out');
    assert.ok(outs.some((e) => String(e.text ?? '').includes('做好了')), '正文要落账');
    assert.ok(outs.some((e) => String(e.text ?? '').includes('[文件]')), '文件也要落账');
  } finally {
    mock.close();
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sendDelivery：多份产物逐个发，内部文件挡掉，不生成 zip 包', async () => {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-work-delivery2-'));
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
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9603' };
    const scoped = { ...chat, scope: workScopeOf('10002') };
    kernel.sandbox.write(scoped, 'paper/a.md', '# a\n');
    kernel.sandbox.write(scoped, 'paper/b.txt', 'b\n');
    kernel.sandbox.write(scoped, '.skills/x/SKILL.md', '内部技能文件');
    kernel.sandbox.write(scoped, 'inbox/pic.jpg', '收件镜像');

    await kernel.chat.sendDelivery(scoped, {
      text: '论文写好了。',
      // 故意混入内部文件：投递口径要把它们挡掉
      artifacts: ['paper/a.md', 'paper/b.txt', '.skills/x/SKILL.md', 'inbox/pic.jpg'],
    });

    const texts = mock.actions.filter((a) => a.action === 'send_group_msg');
    assert.equal(texts.length, 1, '正文只发一条');
    assert.equal((texts[0].params.message as any[])[0].data.text, '论文写好了。');

    await until(() => mock.actions.filter((a) => a.action === 'upload_group_file').length >= 2, 5000, '两份产物都上传');
    const uploads = mock.actions.filter((a) => a.action === 'upload_group_file');
    const names = uploads.map((a) => a.params.name).sort();
    assert.deepEqual(names, ['a.md', 'b.txt'], `只发真正的产物：${JSON.stringify(names)}`);
    assert.equal(mock.actions.filter((a) => a.action === 'send_forward_msg').length, 0, '不再发合并转发');
    assert.equal(existsSync(join(kernel.sandbox.root(scoped), 'deliver')), false, '不再生成合集包目录');
  } finally {
    mock.close();
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sendDelivery：没有产物就只发正文，不产生空文件消息', async () => {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-work-delivery3-'));
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
    const chat = { platform: 'qq' as const, type: 'private' as const, chatId: '10001' };
    const scoped = { ...chat, scope: workScopeOf('10001') };

    await kernel.chat.sendDelivery(scoped, { text: '查完了，结论如下。' });

    const act = await mock.waitForAction('send_private_msg', 5000);
    assert.equal(String(act.params.user_id), '10001');
    assert.equal((act.params.message as any[])[0].data.text, '查完了，结论如下。');
    assert.equal(mock.actions.filter((a) => a.action === 'upload_private_file').length, 0);
    assert.equal(mock.actions.filter((a) => a.action === 'send_forward_msg').length, 0);
  } finally {
    mock.close();
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('产物路径口径：技能/收件/缓存/隐藏/越界都不算交付物', () => {
  for (const p of ['paper/main.tex', 'figs/fig1.png', 'results/tab.csv', 'a.md']) {
    assert.equal(isDeliverableArtifact(p), true, `${p} 应该是交付物`);
  }
  for (const p of [
    '.skills/x/SKILL.md', 'inbox/pic.jpg', 'node_modules/a.js', 'paper/__pycache__/x.pyc',
    '.git/config', 'paper/_preview.html', 'logs/run.log', 'C:/tmp/a.md', '/etc/passwd', '../out.md', '',
  ]) {
    assert.equal(isDeliverableArtifact(p), false, `${p} 不该被当成交付物`);
  }
});
