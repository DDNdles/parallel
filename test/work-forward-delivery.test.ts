import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockOneBot } from './helpers/mock-onebot.ts';
import { workScopeOf } from '../src/kernel/services/work.ts';
import { isDeliverableArtifact } from '../src/kernel/services/artifacts.ts';

// ============================================================
// work 交付：正文 + 产物合并成一条「聊天记录」（send_forward_msg），
// 而不是正文几条气泡 + 文件一条条发。
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

test('sendForward：正文 + 文件放进同一个 forward 节点数组，并按聊天记录落账', async () => {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-work-forward-'));
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

    await kernel.chat.sendForward(scoped, {
      text: '做好了，看文件。',
      artifacts: ['deliver.html'],
      mention: { userId: '10001' },
      selfId: '3344',
      selfNickname: 'parallel-test',
    });

    const act = await mock.waitForAction('send_forward_msg', 5000);
    assert.equal(act.params.message_type, 'group');
    assert.equal(act.params.group_id, '9602');
    const nodes = act.params.messages as any[];
    assert.equal(nodes.length, 2, JSON.stringify(nodes));
    assert.equal(nodes[0].type, 'node');
    assert.equal(nodes[0].data.content[0].type, 'at');
    assert.equal(nodes[0].data.content[1].data.text, '做好了，看文件。');
    assert.equal(nodes[1].data.content[0].type, 'file');
    assert.equal(nodes[1].data.content[0].data.name, 'deliver.html');

    const out = kernel.sessionLog.tail('9602', 'group').find((e) => e.type === 'message_out');
    assert.ok(out, '聊天记录要落一条 message_out');
    const fwd = (out!.data as any)?.forward;
    assert.equal(fwd?.title, '工作交付');
    assert.equal(fwd?.nodes?.length, 2);
    assert.equal(fwd?.nodes?.[1]?.files?.[0]?.name, 'deliver.html', '桌面端才能画文件行');

    // 不额外产生普通文字/文件消息
    assert.equal(mock.actions.filter((a) => a.action === 'send_group_msg').length, 0);
    assert.equal(mock.actions.filter((a) => a.action === 'upload_group_file').length, 0);
  } finally {
    mock.close();
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sendForward：多份产物打包成一个 zip 合集，内部文件不进包，也不再逐个文件发', async () => {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-work-pack-'));
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

    await kernel.chat.sendForward(scoped, {
      text: '论文写好了。',
      // 故意混入内部文件：投递口径要把它们挡掉
      artifacts: ['paper/a.md', 'paper/b.txt', '.skills/x/SKILL.md', 'inbox/pic.jpg'],
      selfId: '3344',
      selfNickname: 'parallel-test',
    });

    const act = await mock.waitForAction('send_forward_msg', 5000);
    const nodes = act.params.messages as any[];
    assert.equal(nodes.length, 2, `正文 + 一个合集节点：${JSON.stringify(nodes)}`);
    assert.equal(nodes[0].data.content[0].data.text.includes('合集'), true, '正文要说明产物已打包');
    assert.equal(nodes[1].data.content[0].type, 'file');
    const zipName = String(nodes[1].data.content[0].data.name);
    assert.match(zipName, /^工作交付_.*\.zip$/);
    assert.equal(mock.actions.filter((a) => a.action === 'upload_group_file').length, 0, '不许再逐个上传文件');
    assert.equal(mock.actions.filter((a) => a.action === 'send_group_msg').length, 0, '不许再单独发正文');

    // 包里有且只有两份真正的产物
    const zip = readFileSync(join(kernel.sandbox.root(scoped), 'deliver', zipName));
    assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304', '应该是标准 zip');
    const names = zip.toString('latin1');
    assert.ok(names.includes('paper/a.md'), '产物 a 应在合集里');
    assert.ok(names.includes('paper/b.txt'), '产物 b 应在合集里');
    assert.ok(!names.includes('SKILL.md'), '技能文件不许进合集');
    assert.ok(!names.includes('inbox/pic.jpg'), '收件镜像不许进合集');

    const out = kernel.sessionLog.tail('9603', 'group').find((e) => e.type === 'message_out');
    const d = out!.data as any;
    assert.deepEqual(d.artifacts, ['paper/a.md', 'paper/b.txt'], '清单仍按原始产物落账');
    assert.equal(d.package?.count, 2);
    assert.equal(d.forward?.nodes?.length, 2);
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
