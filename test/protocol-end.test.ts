import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel, makeLogger } from '../src/kernel/kernel.ts';
import { startApiServer } from '../src/kernel/api/server.ts';
import { ConfigStore, freshDefaultConfig } from '../src/kernel/config.ts';
import { Db } from '../src/kernel/db.ts';
import { Bus } from '../src/kernel/bus.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';
import { coerceLike } from '../src/kernel/util/misc.ts';
import {
  NapCatManager, mergeNapcatNetworkConfig, napcatWsClient, qqPathFromUninstallString,
} from '../src/kernel/services/napcat.ts';

/**
 * 协议端可切换（LLBot / NapCat），托管常驻开启：
 * 默认仍是 LLBot，切到 NapCat 后内核不再拉起 LLBot；界面侧没有托管开关，
 * 只剩「检测」这条逐项实测（发行包 / 前提 / 进程 / 控制台 / 反向 WS）。
 */
const ANY = (x: unknown) => x as Record<string, unknown>;
const clients = (cfg: Record<string, unknown>) => ANY(ANY(cfg.network)).websocketClients as Record<string, unknown>[];

test('默认协议端是 LLBot；老配置里的 managed 键被迁移清掉', () => {
  const d = freshDefaultConfig();
  assert.equal(d.onebot.flavor, 'llbot');
  assert.equal(ANY(d.onebot.llbot).managed, undefined);
  assert.equal(ANY(d.onebot.napcat).managed, undefined);
  assert.equal(ANY(d.onebot.napcat).webuiPort, 6099);

  const dataDir = mkdtempSync(tmpdir() + '/pnap-cfg-');
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    onebot: { port: 3999, llbot: { managed: false, mode: 'direct', junk: 1 }, napcat: { managed: false } },
  }));
  const store = new ConfigStore(dataDir, new Bus(), new ErrorCenter(new Bus(), { dataDir }));
  assert.equal(ANY(store.config.onebot.llbot).managed, undefined);
  assert.equal(ANY(store.config.onebot.llbot).junk, undefined, '未知键一并清掉');
  assert.equal(ANY(store.config.onebot.llbot).mode, 'direct', '有用的键保留');
  assert.equal(ANY(store.config.onebot.napcat).managed, undefined);
  assert.equal(ANY(store.config.onebot).port, 3999);
});

test('反向 WS 客户端写成官方 schema，并保留用户已有的其它网络', () => {
  const client = napcatWsClient('ws://127.0.0.1:3001/onebot', 'tk');
  assert.deepEqual(clients(mergeNapcatNetworkConfig({}, client))[0], {
    name: 'parallel', enable: true, url: 'ws://127.0.0.1:3001/onebot', messagePostFormat: 'array',
    reportSelfMessage: false, reconnectInterval: 5000, token: 'tk', debug: false, heartInterval: 30000,
  });
  const user = { someOther: 1, network: { httpServers: [{ name: 'web', port: 3000 }], websocketClients: [{ name: '别的', url: 'ws://x' }] } };
  const once = mergeNapcatNetworkConfig(user, client);
  const net = ANY(once.network);
  assert.equal(once.someOther, 1);
  assert.equal(ANY(net.httpServers[0]).name, 'web');
  assert.deepEqual(clients(once).map((c) => c.name), ['别的', 'parallel']);
  // 幂等：被改坏的条目会被拉回内核期望值，且不会多出第二条
  const broken = mergeNapcatNetworkConfig(user, { ...client, url: 'ws://旧地址' });
  const twice = mergeNapcatNetworkConfig(broken, client);
  assert.equal(clients(twice).filter((c) => c.name === 'parallel').length, 1);
  assert.equal(clients(twice).find((c) => c.name === 'parallel')?.url, 'ws://127.0.0.1:3001/onebot');
});

test('QQ 路径按官方启动脚本的口径从注册表卸载器路径推出', () => {
  assert.equal(qqPathFromUninstallString('"C:\\Program Files\\Tencent\\QQNT\\Uninstall.exe"'), join('C:\\Program Files\\Tencent\\QQNT', 'QQ.exe'));
  assert.equal(qqPathFromUninstallString('C:\\QQNT\\Uninstall.exe'), join('C:\\QQNT', 'QQ.exe'));
  assert.equal(qqPathFromUninstallString(''), '');
});

test('无头内核不托管；切成 NapCat 后 LLBot 也不会被拉起', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-flavor-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  ANY(ANY(kernel.config.config.onebot)).port = 30000 + (process.pid % 20000);
  kernel.config.config.onebot.flavor = 'napcat';
  await kernel.boot();
  try {
    assert.equal(kernel.protocolEnd().id, 'napcat');
    assert.equal(kernel.llbot.running(), false, 'noApi 内核不该托管任何协议端');
    assert.equal(kernel.napcat.running(), false);
    assert.equal(ANY(kernel.napcat.status()).managed, undefined, '状态里不再有托管字段');
    assert.match(String(ANY(kernel.napcat.status()).webuiUrl), /^http:\/\/127\.0\.0\.1:6099\/webui\?token=[0-9a-f]{12}$/);
    kernel.config.config.onebot.flavor = 'llbot';
    assert.equal(kernel.protocolEnd().id, 'llbot');
  } finally {
    await kernel.shutdown();
  }
});

test('NapCat 布局两种包都认，且没有可代理的二维码', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-napcat-'));
  const db = new Db(dataDir);
  const bus = new Bus();
  const errors = new ErrorCenter(bus, { dataDir });
  const config = new ConfigStore(dataDir, bus, errors);
  const m = new NapCatManager(config, errors, makeLogger, () => ({ connected: false, selfId: '', nickname: '' }));
  assert.equal(m.id, 'napcat');
  assert.equal(m.running(), false);
  assert.equal(m.downloaded(), false);
  // 通用 NapCat.Shell.zip 是平铺布局（napcat.mjs 就在解压根），Windows.Node 包多一层 napcat/
  const flat = join(dataDir, 'napcat');
  mkdirSync(flat, { recursive: true });
  writeFileSync(join(flat, 'napcat.mjs'), '');
  writeFileSync(join(flat, 'NapCatWinBootMain.exe'), '');
  assert.equal(m.downloaded(), true);
  assert.equal(await m.fetchQrcode(), null);   // 注入模式在 QQ 窗口里扫码
  const checks = await m.check();
  assert.deepEqual(checks.map((c) => c.label), ['发行包', '注入目标', '进程', '控制台']);
  assert.equal(checks[0].state, 'pass');
  assert.equal(checks[2].state, 'fail');       // 进程没起
  db.close();
});

test('API：换端要落盘并停掉另一端；检测逐项返回；子块只收白名单', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-flavor-api-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const onebot = ANY(kernel.config.config.onebot);
  onebot.port = 30000 + (process.pid % 20000);
  kernel.config.config.ui.port = 41000 + (process.pid % 8000);
  await kernel.boot();
  const server = await startApiServer(kernel);
  const base = `http://127.0.0.1:${kernel.config.config.ui.port}`;
  const tk = `token=${kernel.config.secrets.uiToken}`;
  const get = async (p: string) => ANY(await (await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}${tk}`)).json());
  const post = async (p: string, body?: unknown) => {
    const r = await fetch(`${base}${p}?${tk}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, body: ANY(await r.json()) };
  };
  try {
    assert.equal((await get('/api/login/status')).protocol, 'llbot');
    assert.equal((await post('/api/login/protocol', { flavor: 'bogus' })).status, 400);

    const sw = await post('/api/login/protocol', { flavor: 'napcat' });
    assert.equal(sw.status, 200);
    assert.equal(sw.body.protocol, 'napcat');
    assert.equal((await get('/api/login/status')).protocol, 'napcat');
    assert.equal(ANY(ANY(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8'))).onebot).flavor, 'napcat');
    assert.equal(kernel.llbot.running(), false);
    assert.equal(kernel.napcat.running(), false);
    // 无头内核不托管：换端 / 重启都不该去下载发行包或拉起注入进程（真跑过一次会往本机 QQ 里注入）
    await post('/api/login/end/restart');
    assert.equal(kernel.napcat.downloaded(), false, 'noApi 内核不该下载 NapCat 发行包');
    assert.equal(kernel.napcat.running(), false);

    // 旧的托管开关入口已删（托管常驻，没有关的口子）
    assert.equal((await post('/api/login/end/stop')).status, 404);

    const chk = await post('/api/login/end/check');
    assert.equal(chk.status, 200);
    assert.equal(chk.body.protocol, 'napcat');
    const rows = chk.body.checks as Record<string, unknown>[];
    assert.ok(rows.length >= 4);
    assert.ok(rows.every((r) => ['pass', 'warn', 'fail'].includes(String(r.state))));
    assert.ok(rows.some((r) => r.label === '反向 WS' && r.state === 'fail'), '没连上就该报 fail');

    // 子块白名单：路径去空白、端口要合法整数，managed/非法 mode 不收
    await post('/api/config', { onebot: { napcat: { qqPath: '  D:\\QQ\\QQ.exe  ', webuiPort: 7000, managed: true }, llbot: { mode: 'bogus' } } });
    const nap = ANY(ANY(kernel.config.config.onebot).napcat);
    assert.equal(nap.qqPath, 'D:\\QQ\\QQ.exe');
    assert.equal(nap.webuiPort, 7000);
    assert.equal(nap.managed, undefined, '托管没有开关入口');
    assert.equal(ANY(ANY(kernel.config.config.onebot).llbot).mode, 'pmhq');
    await post('/api/config', { onebot: { napcat: { webuiPort: 99999 } } });
    assert.equal(ANY(ANY(kernel.config.config.onebot).napcat).webuiPort, 7000, '越界端口不改值');
  } finally {
    server.close();
    await kernel.shutdown();
  }
});
