import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================
// 内核 ↔ cover supervisor 集成
//
//  真内核（noProtocol：不碰 LLBot/QQ）+ 临时 data 目录 + 本地假门户：
//  1. 设置页打开 autoStart → 插件重载 → 内核拉起 supervisor 子进程
//  2. supervisor 读临时 secrets、轮询假门户、自动提交作业（报文完整）
//  3. 内核 shutdown → 子进程被收掉，不留孤儿
// ============================================================

const freePort = () => new Promise<number>((res) => {
  const s = createNetServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 15000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待 ${what} 超时`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

test('内核打开 autoStart → 拉起 supervisor → 自动提交作业 → 关停收子进程', async () => {
  process.env.PARALLEL_NO_BROWSER = '1';
  const uis: Server[] = [];
  const dirs: string[] = [];
  let kernel: { shutdown: () => Promise<void> } | undefined;
  try {
    // —— 假 107 门户：只认作业列表和提交，别的都 404 ——
    const calls: Array<{ method: string; path: string; body?: string; cookie?: string }> = [];
    const portal = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls.push({ method: req.method ?? 'GET', path: url.pathname, body, cookie: String(req.headers.cookie ?? '') });
        if (req.method === 'GET' && url.pathname === '/api/job/getRunningJobs') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ results: [] }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/job/submitJob') {
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobId: 424242 }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    uis.push(portal);
    await new Promise<void>((r) => portal.listen(0, '127.0.0.1', () => r()));
    const portalPort = (portal.address() as { port: number }).port;
    process.env.PARALLEL_COVER_PORTAL = `http://127.0.0.1:${portalPort}`;

    // —— 临时 data 目录：Cookie/Key 与 uiToken 都从这里读 ——
    const dataDir = mkdtempSync(join(tmpdir(), 'parallel-cover-sup-'));
    dirs.push(dataDir);
    writeFileSync(join(dataDir, 'secrets.json'), JSON.stringify({
      uiToken: 'test-ui-token',
      onebotAccessToken: 'test-onebot',
      llbotAuthToken: '',
      providerKeys: {},
      pluginSecrets: { cover: { apiKey: 'test-key', cookie: 'SCOW_USER=test-cookie' } },
    }));

    const { Kernel } = await import('../src/kernel/kernel.ts');
    const port = await freePort();
    const k = new Kernel({ dataDir, port, noProtocol: true });
    k.config.config.onebot.port = await freePort(); // 别和正在跑的真 bot 抢 3001
    kernel = k;
    await k.boot();
    assert.equal(k.config.secrets.uiToken, 'test-ui-token');

    // —— 打开设置页的「自动接线」：应触发插件重载并拉起子进程 ——
    const cfgResp = await fetch(`http://127.0.0.1:${port}/api/plugins/cover/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-token': 'test-ui-token' },
      body: JSON.stringify({ values: { autoStart: true } }),
    });
    assert.equal(cfgResp.status, 200);

    const submit = await until(
      () => calls.find((c) => c.method === 'POST' && c.path === '/api/job/submitJob'),
      20000,
      'supervisor 自动提交作业',
    );
    assert.match(submit.cookie ?? '', /SCOW_USER=test-cookie/);
    const body = JSON.parse(submit.body ?? '{}');
    assert.equal(body.cluster, 'training');
    assert.equal(body.jobName, 'cover');
    assert.equal(body.partition, 'Students');
    assert.equal(body.account, 'stu');
    assert.equal(body.maxTime, 238);
    assert.equal(body.maxTimeUnit, 0);
    assert.equal(body.memory, '16384MB');
    assert.match(body.command, /COVER_API_KEY=test-key/);
    assert.match(body.command, /\/home\/scc\/pb25071412\/cover\/svc-venv\/bin\/python/);

    const pidFile = join(dataDir, 'cover', 'supervisor.pid');
    const pid = await until(() => {
      try {
        const n = Number(readFileSync(pidFile, 'utf8').trim());
        return n > 0 ? n : 0;
      } catch { return 0; }
    }, 10000, 'supervisor pid');
    assert.ok(alive(pid), 'supervisor 应该在跑');
    await until(() => {
      try { return readFileSync(join(dataDir, 'cover', 'supervisor.out.log'), 'utf8').includes('已自动提交 cover 作业'); } catch { return false; }
    }, 10000, '提交日志');
  } finally {
    if (kernel) await kernel.shutdown();
    // 子进程是内核收的；等它真退出后临时目录才删得掉（Windows 文件占用）
    const pidFile = dirs[0] ? join(dirs[0], 'cover', 'supervisor.pid') : '';
    const pid = pidFile ? Number((() => { try { return readFileSync(pidFile, 'utf8').trim(); } catch { return '0'; } })()) : 0;
    if (pid) await until(() => !alive(pid), 8000, 'supervisor 退出').catch(() => undefined);
    for (const s of uis) await new Promise<void>((r) => s.close(() => r()));
    delete process.env.PARALLEL_COVER_PORTAL;
    delete process.env.PARALLEL_NO_BROWSER;
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* 子进程句柄还没放 */ }
    }
  }
});
