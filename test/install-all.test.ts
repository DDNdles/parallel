import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installJobView, resetInstallJob, startInstallAll, type InstallerCtx } from '../src/kernel/services/installer.ts';
import type { DepItem, DepProbe } from '../src/kernel/services/deps.ts';

/**
 * 首装「一键安装」的状态机：不碰本机 winget / docker / 网络，探测与命令全部注入。
 *
 * 这里钉住三件事：
 *  - 已经就绪的项不再重装；
 *  - winget 装完探测转 ok → 该项 ok；装不动（没有 winget / 装完仍探测不到）→ manual / failed，
 *    后面几步照常继续，不能因为一项失败就整单停摆；
 *  - 收尾 ready 只看必备项。
 */
const IDS = ['node', 'data', 'ffmpeg', 'python', 'bash', 'qq', 'llbot', 'docker'];

function mkItems(missing: string[], opts: { optional?: string[]; idle?: string[] } = {}) {
  const map = new Map<string, DepItem>();
  for (const id of IDS) {
    const optional = !!opts.optional?.includes(id);
    const idle = !!opts.idle?.includes(id);
    map.set(id, {
      id, label: id, required: !optional,
      state: idle ? 'idle' : missing.includes(id) ? 'missing' : 'ok',
      // 与真实探测同口径：缺失项 detail 就是「未安装」，settle 才会用调用方的兜底文案
      detail: idle ? `${id} 已安装但未启动` : missing.includes(id) ? '未安装' : '就绪',
    });
  }
  return map;
}

/** 假时钟：sleep 只推进时间，不真的等（waitProbe 的超时预算靠它耗尽） */
function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
  };
}

function ctxOf(items: Map<string, DepItem>, extra: Partial<InstallerCtx> = {}): InstallerCtx {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-inst-'));
  const probeCtx = () => ({ dataDir, headed: true, endFlavor: 'llbot', endDownloaded: true, endConnected: false, qqPathCfg: '' } as DepProbe);
  const clock = fakeClock();
  return {
    dataDir,
    probeCtx,
    probeAll: async () => [...items.values()],
    probeOne: async (id: string) => items.get(id)!,
    ...clock,
    ...extra,
  };
}

async function untilDone(timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const j = installJobView();
    if (j && !j.running) return j;
    if (Date.now() - start > timeoutMs) throw new Error('安装任务超时未结束');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => resetInstallJob());

test('一键安装：已就绪的项跳过，缺的走 winget，装完探测转 ok', async () => {
  const items = mkItems(['python']);
  const calls: string[] = [];
  const ctx = ctxOf(items, {
    hasWinget: async () => true,
    exec: async (bin, args) => {
      calls.push(`${bin} ${args.slice(0, 3).join(' ')}`);
      if (bin === 'winget' && args.includes('Python.Python.3.13')) {
        items.set('python', { id: 'python', label: 'python', required: true, state: 'ok', detail: 'Python 3.13（新装的）' });
      }
      return { ok: true, out: '' };
    },
  });
  const job = startInstallAll(ctx);
  assert.equal(job.running, true);
  const done = await untilDone();
  assert.equal(done.ready, true, JSON.stringify(done.steps));
  const byId = new Map(done.steps.map((s) => [s.id, s]));
  assert.equal(byId.get('python')!.state, 'ok');
  assert.match(byId.get('python')!.detail, /Python 3\.13/);
  assert.equal(byId.get('node')!.state, 'ok', '本来就绪的项标 ok');
  assert.ok(calls.length >= 1 && calls[0].startsWith('winget install --id Python.Python.3.13'), calls.join('\n'));
  assert.equal(calls.filter((c) => c.includes('Git.Git')).length, 0, 'bash 已就绪，不该再跑 winget');
  rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('一键安装：没有 winget → 标「需要你处理」，其余步骤照跑，收尾不 ready', async () => {
  const items = mkItems(['python', 'bash'], { optional: ['ffmpeg'] });
  const ctx = ctxOf(items, {
    hasWinget: async () => false,
    exec: async () => { throw new Error('没有 winget 就不该执行命令'); },
  });
  startInstallAll(ctx);
  const done = await untilDone();
  const byId = new Map(done.steps.map((s) => [s.id, s]));
  assert.equal(byId.get('python')!.state, 'manual');
  assert.match(byId.get('python')!.detail, /没有 winget/);
  assert.equal(byId.get('bash')!.state, 'manual');
  assert.equal(done.ready, false, '必备项没齐');
  rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('一键安装：winget 说成功但探测不到 → failed；步骤不会挂死（超时预算耗尽）', async () => {
  const items = mkItems(['python']);
  const ctx = ctxOf(items, {
    hasWinget: async () => true,
    exec: async () => ({ ok: true, out: 'Successfully installed' }),
  });
  startInstallAll(ctx);
  const done = await untilDone(10_000);
  const python = done.steps.find((s) => s.id === 'python')!;
  assert.equal(python.state, 'failed');
  assert.match(python.detail, /仍未探测到|可能需要重开终端/);
  assert.equal(done.ready, false);
  rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('一键安装：Docker 已安装但没启动 → 拉起后转 ok；协议端只下载不拉起', async () => {
  const items = mkItems(['docker', 'llbot'], { idle: ['docker'] });
  let launched = 0;
  let endInstalls = 0;
  const ctx = ctxOf(items, {
    ensureEnd: async () => {
      endInstalls++;
      items.set('llbot', { id: 'llbot', label: 'llbot', required: true, state: 'ok', detail: '已就位（data/llbot）' });
    },
    launchDocker: () => {
      launched++;
      items.set('docker', { id: 'docker', label: 'docker', required: true, state: 'ok', detail: 'docker 就绪' });
      return true;
    },
  });
  startInstallAll(ctx);
  const done = await untilDone();
  assert.equal(done.ready, true, JSON.stringify(done.steps));
  assert.equal(endInstalls, 1, '协议端发行包由内核下载');
  assert.equal(launched, 1, 'Docker 只启动一次');
  const byId = new Map(done.steps.map((s) => [s.id, s]));
  assert.equal(byId.get('docker')!.state, 'ok');
  assert.equal(byId.get('llbot')!.state, 'ok');
  rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('一键安装：无头直连不需要 QQNT，跳过而不是硬装', async () => {
  const items = mkItems(['qq'], { optional: ['qq'] });
  let installed = 0;
  const ctx = ctxOf(items, {
    hasWinget: async () => true,
    exec: async () => { installed++; return { ok: true, out: '' }; },
  });
  startInstallAll(ctx);
  const done = await untilDone();
  const qq = done.steps.find((s) => s.id === 'qq')!;
  assert.equal(qq.state, 'skipped');
  assert.match(qq.detail, /无头直连/);
  assert.equal(installed, 0, '不需要就不该装 200MB 的 QQ');
  rmSync(ctx.dataDir, { recursive: true, force: true });
});
