import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LLBotManager } from '../src/kernel/services/llbot.ts';
import { Bus } from '../src/kernel/bus.ts';
import { ConfigStore } from '../src/kernel/config.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { startApiServer } from '../src/kernel/api/server.ts';
import type { Logger } from '../src/kernel/types.ts';

/**
 * 协议端使用授权（LLBot 的 Auth Token）。
 *
 * 背景（读 LuckyLilliaBot 源码核实，不是猜的）：它的签名服务要一个 Auth Token，
 * 得去 auth.luckylillia.com 申请（说明用途）或进官方群过审核；token 落在其 DATA_DIR 的
 * auth_token.txt，LLBot 每秒轮询该文件 → 校验 → 通过才拉起扫码登录。控制台另有
 * GET /api/auth-token/status 报 {applicable, online, hasToken, validation, message, loginError}。
 * 这页验的就是内核那一层：写文件、读状态、以及**任何回包与日志都不许带出 token 内容**。
 */

const quiet = (): Logger => ({ info() {}, warn() {}, error() {} } as unknown as Logger);

function mk(dataDir: string): { llbot: LLBotManager; config: ConfigStore } {
  const bus = new Bus();
  const errors = new ErrorCenter(bus, { dataDir });
  const config = new ConfigStore(dataDir, bus, errors);
  return { config, llbot: new LLBotManager(config, errors, bus, quiet) };
}

/** LLBot 的 DATA_DIR：CLI 包布局里是 <home>/bin/llbot/data，测试目录没那层所以落在 <home>/data */
const tokenFile = (dataDir: string) => join(dataDir, 'llbot', 'data', 'auth_token.txt');

test('setAuthToken：落盘 + 进 secrets，空串等于撤销', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-auth-'));
  const { llbot, config } = mk(dataDir);
  try {
    llbot.setAuthToken('  tok-abc123  ');
    assert.equal(readFileSync(tokenFile(dataDir), 'utf-8'), 'tok-abc123', '首尾空白要削掉再写');
    assert.equal(config.secrets.llbotAuthToken, 'tok-abc123');
    assert.equal(readFileSync(join(dataDir, 'secrets.json'), 'utf-8').includes('tok-abc123'), true, '得持久化，重启后还要能覆写回去');

    llbot.setAuthToken('');
    assert.equal(existsSync(tokenFile(dataDir)), false, '清空要删文件：留着它 LLBot 会一直拿旧 token 跑');
    assert.equal(config.secrets.llbotAuthToken, '');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('authState：控制台没起来时只报本地那一半，且绝不回 token 内容', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-auth2-'));
  const { llbot } = mk(dataDir);
  try {
    // 端口 1（没有服务）：fetch 必然失败
    llbot.setAuthToken('super-secret-token');
    const st = await llbot.authState();
    assert.equal(st.reachable, false, '连不上控制台要如实标出来，别把"没起来"说成"没授权"');
    assert.equal(st.hasToken, true);
    assert.equal(st.validation, '');
    assert.equal(st.supported, undefined);
    assert.match(st.pageUrl, /^https:\/\/auth\.luckylillia\.com$/, '默认 cf 接入点的申请页');
    assert.equal(st.mirrorUrl, 'https://llbot.wumiao.wang', '国内镜像一并给出');
    assert.equal(st.qqGroup, '545402644');
    assert.ok(!JSON.stringify(st).includes('super-secret-token'), '状态包里不许出现 token 本体');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('authState：控制台报的校验态原样透出，鉴权走 X-Webui-Token = sha256(webui_token.txt)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-auth3-'));
  const { llbot, config } = mk(dataDir);
  let seenHeader = '';
  let payload: Record<string, unknown> = {
    applicable: true, online: true, hasToken: true, validation: 'valid', message: '', loginError: '',
    authTokenPageUrl: 'https://mirror.example/auth',
  };
  const srv: Server = createServer((req, res) => {
    seenHeader = String(req.headers['x-webui-token'] ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: payload }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    mkdirSync(join(dataDir, 'llbot', 'data'), { recursive: true });
    writeFileSync(join(dataDir, 'llbot', 'data', 'webui_token.txt'), 'pw-xyz', 'utf-8');
    (config.config.onebot as unknown as { llbot: { webuiPort: number } }).llbot.webuiPort = port;

    const st = await llbot.authState();
    assert.equal(seenHeader, createHash('sha256').update('pw-xyz').digest('hex'), '鉴权头与登录二维码那套一致');
    assert.equal(st.reachable, true);
    assert.equal(st.validation, 'valid');
    assert.equal(st.online, true);
    assert.equal(st.pageUrl, 'https://mirror.example/auth', '控制台说申请页在别处就以它为准');

    payload = { applicable: false, online: false, hasToken: false, validation: 'idle', message: '', loginError: '' };
    const pmhq = await llbot.authState();
    assert.equal(pmhq.applicable, false, '有头模式由本机 QQ 签名，面板据此说"不需要"');

    payload = { applicable: true, online: false, hasToken: true, validation: 'invalid', message: 'Auth Token 无效、已失效或无权限，请重新获取', loginError: 'auth_token 可用 QQ 数量已达上限' };
    const bad = await llbot.authState();
    assert.equal(bad.validation, 'invalid');
    assert.equal(bad.message, 'Auth Token 无效、已失效或无权限，请重新获取', '原文透传，别自己编文案');
    assert.equal(bad.loginError, 'auth_token 可用 QQ 数量已达上限');
  } finally {
    srv.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('API：/api/setup/auth 免 token 可读可写，响应与日志都不带 token 本体，且不拉起协议端', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-auth-api-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const ob = kernel.config.config.onebot as unknown as Record<string, Record<string, unknown>>;
  ob.port = 31000 + (process.pid % 19000);
  kernel.config.config.ui.port = 43000 + (process.pid % 5000);
  await kernel.boot();
  const server = await startApiServer(kernel);
  const base = `http://127.0.0.1:${kernel.config.config.ui.port}`;
  try {
    const r = await fetch(`${base}/api/setup/auth`);
    assert.equal(r.status, 200, '这页排在拿到 uiToken 之前，必须免鉴权');
    const body = await r.json() as Record<string, unknown>;
    assert.equal(body.supported, true);
    assert.equal(body.hasToken, false);

    const w = await fetch(`${base}/api/setup/auth`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'api-tok-42' }),
    });
    const after = await w.json() as Record<string, unknown>;
    assert.equal(after.hasToken, true);
    assert.ok(!JSON.stringify(after).includes('api-tok-42'), '回包不许带 token');
    assert.equal(readFileSync(join(dataDir, 'llbot', 'data', 'auth_token.txt'), 'utf-8'), 'api-tok-42');
    assert.equal(kernel.llbot.running(), false, '录入授权不等于把协议端拉起来（noApi 红线）');
  } finally {
    server.close();
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
