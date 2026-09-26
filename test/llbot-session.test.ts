import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KICK_WINDOW_MS, LlbotIdentity, parseLlbotLine } from '../src/kernel/services/llbot-identity.ts';
import { LLBotManager, pmhqPreflightVerdict } from '../src/kernel/services/llbot.ts';
import { OneBot11Adapter } from '../src/kernel/adapters/onebot11.ts';
import { Bus } from '../src/kernel/bus.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';

// ---------------- LLBot 日志行 → 登录态事件 ----------------
// 语料全部取自真实日志 data/llbot/bin/llbot/data/logs/llbot-*.log

test('parseLlbotLine: 1001 踢下线', () => {
  const ev = parseLlbotLine('2026-09-15 22:24:54 [W] core [Kick] code=1001 title="下线通知" desc="你的账号当前登录已失效，请重新登录。"');
  assert.deepEqual(ev, { type: 'kick', code: 1001, desc: '下线通知：你的账号当前登录已失效，请重新登录。' });
});

test('parseLlbotLine: 其它 code 的踢下线', () => {
  const ev = parseLlbotLine('[W] core [Kick] code=1002 title="被挤下线" desc="账号在别处登录。"');
  assert.equal(ev?.type, 'kick');
  assert.equal((ev as { code: number }).code, 1002);
});

test('parseLlbotLine: 会话失效 / 登录成功 / 二维码用尽 / 无关行', () => {
  assert.equal(
    parseLlbotLine('2026-09-15 10:48:31 [I] qq-protocol Saved session expired, will need QR login: SSO trpc.msg.register_proxy.RegisterProxy.SsoInfoSync failed: retCode=-10003, extraMsg=身份验证失败，请你重新登录。(w21)')?.type,
    'session-invalid',
  );
  assert.equal(
    parseLlbotLine('2026-09-15 05:36:58 [I] qq-protocol Specified uin 3893163081 has no usable session; dropping it and doing a fresh QR login')?.type,
    'session-invalid',
  );
  assert.equal(parseLlbotLine('2026-09-15 21:04:37 [I] qq-protocol [QQ Server] Online registered!')?.type, 'logged-in');
  assert.equal(parseLlbotLine('2026-09-15 21:04:37 [I] qq-protocol Login successful! UID: u_x, nick: "叶的组诗"')?.type, 'logged-in');
  assert.equal(parseLlbotLine('[W] qq-protocol 已自动刷新 10 张二维码仍未登录, 停止自动刷新; 到 WebUI 登录页点击刷新可继续, 或重启')?.type, 'qr-exhausted');
  assert.equal(parseLlbotLine('2026-09-15 22:18:42 [I] core [收-群] 某群(915382720) 某人(892792272)：看看个子可爱'), null);
});

test('parseLlbotLine: 扫码后被 QQ 拒绝登录（风控 state=168）', () => {
  const ev = parseLlbotLine('[E] qq-protocol Login failed: state=168 社交功能限制提醒 你的账号近期存在安全风险，部分功能使用受限，请登录最新手机QQ并根据提示恢复账号使用。');
  assert.equal(ev?.type, 'login-failed');
  assert.equal((ev as { state: number }).state, 168);
  assert.match((ev as { message: string }).message, /社交功能限制/);
});

// ---------------- 设备身份钉住 / 会话备份 ----------------

interface Fixture {
  id: LlbotIdentity;
  idDir: string;
  liveDir: string;
  clock: { now: number };
  dispose: () => void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'parallel-llbot-'));
  const idDir = join(root, 'llbot-identity');
  const liveDir = join(root, 'llbot', 'bin', 'llbot', 'data');
  mkdirSync(liveDir, { recursive: true });
  const clock = { now: 1_700_000_000_000 };
  const id = new LlbotIdentity(idDir, () => liveDir, () => clock.now);
  return { id, idDir, liveDir, clock, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function writeGuid(dir: string, hex: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'machine_guid.bin'), Buffer.from(hex, 'hex'));
}

function writeSession(dir: string, uin: string, tag: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `qq-session-${uin}.json`), JSON.stringify({ uin, tag, enc: 'x' }));
}

test('LlbotIdentity: 首次接管现有设备身份，之后钉住不再变', () => {
  const f = fixture();
  try {
    writeGuid(f.liveDir, 'aa'.repeat(16));
    assert.equal(f.id.pinGuid(), 'adopted');
    assert.equal(f.id.deviceId(), 'aa'.repeat(16));

    // LLBot 收到 1001 会删掉自己的 guid：下次启动必须把它写回同一个身份
    rmSync(join(f.liveDir, 'machine_guid.bin'));
    assert.equal(f.id.pinGuid(), 'pinned');
    assert.equal(readFileSync(join(f.liveDir, 'machine_guid.bin')).toString('hex'), 'aa'.repeat(16));

    // 反过来，LLBot 自己换了新随机 guid 也会被覆盖回钉住的那份
    writeGuid(f.liveDir, 'bb'.repeat(16));
    f.id.pinGuid();
    assert.equal(readFileSync(join(f.liveDir, 'machine_guid.bin')).toString('hex'), 'aa'.repeat(16));
    assert.equal(f.id.deviceId(), 'aa'.repeat(16));
  } finally { f.dispose(); }
});

test('LlbotIdentity: 无 pin 无 live 时交给 LLBot 生成，随后收编', () => {
  const f = fixture();
  try {
    assert.equal(f.id.pinGuid(), 'pending');
    writeGuid(f.liveDir, 'cc'.repeat(16));
    assert.equal(f.id.adoptLiveGuid(), 'cc'.repeat(16));
    assert.equal(f.id.pinGuid(), 'pinned');
  } finally { f.dispose(); }
});

test('LlbotIdentity: 会话备份 + 丢失后恢复（免扫码快速登录的凭据）', () => {
  const f = fixture();
  try {
    writeGuid(f.liveDir, 'aa'.repeat(16));
    f.id.pinGuid();
    writeSession(f.liveDir, '3893163081', 'v1');
    assert.deepEqual(f.id.backupSessions(), ['qq-session-3893163081.json']);
    assert.ok(f.id.hasRestorableSession());

    // LLBot 目录里的会话没了（它自己删的 / 目录被换过）→ 从备份补回
    rmSync(join(f.liveDir, 'qq-session-3893163081.json'));
    assert.deepEqual(f.id.restoreSessionsIfLost(), ['qq-session-3893163081.json']);
    assert.equal(JSON.parse(readFileSync(join(f.liveDir, 'qq-session-3893163081.json'), 'utf-8')).tag, 'v1');

    // 已经有 live 文件时不重复覆盖
    assert.deepEqual(f.id.restoreSessionsIfLost(), []);
  } finally { f.dispose(); }
});

test('LlbotIdentity: 1001 之后同一份死凭证只赌一次，恢复失败即丢弃', () => {
  const f = fixture();
  try {
    writeGuid(f.liveDir, 'aa'.repeat(16));
    f.id.pinGuid();
    writeSession(f.liveDir, '3893163081', 'v1');
    f.id.backupSessions();

    f.clock.now += 60_000;
    f.id.noteKick(1001, '下线通知：你的账号当前登录已失效，请重新登录。');
    rmSync(join(f.liveDir, 'qq-session-3893163081.json'));

    // 第一轮：允许拿备份赌一次（它也可能是「顶号但凭证仍可用」）
    assert.deepEqual(f.id.restoreSessionsIfLost(), ['qq-session-3893163081.json']);
    rmSync(join(f.liveDir, 'qq-session-3893163081.json'));
    // 已经赌过 → 不再反复拿死凭证去撞服务端
    assert.deepEqual(f.id.restoreSessionsIfLost(), []);

    // LLBot 确认凭证作废 → 备份直接丢掉
    f.id.noteSessionInvalid('身份验证失败，请你重新登录。');
    assert.deepEqual(f.id.sessionBackups(), []);
    assert.deepEqual(f.id.restoreSessionsIfLost(), []);
  } finally { f.dispose(); }
});

test('LlbotIdentity: 登录成功清作废标记；连续掉线才轮换设备身份', () => {
  const f = fixture();
  try {
    writeGuid(f.liveDir, 'aa'.repeat(16));
    f.id.pinGuid();
    writeSession(f.liveDir, '3893163081', 'v2');
    f.id.backupSessions();
    f.id.noteOnline();
    // 重新扫码后的新凭证比作废时间新 → 可恢复
    assert.ok(f.id.hasRestorableSession());

    f.id.noteKick(1001, '下线通知');
    assert.equal(f.id.shouldRotate(), false, '单次掉线不该换设备身份');
    f.clock.now += 10 * 60_000;
    f.id.noteKick(1001, '下线通知');
    assert.equal(f.id.shouldRotate(), true, '同一身份 6 小时内被踢两次 = 已被标记');

    f.id.rotate();
    assert.equal(f.id.deviceId(), '');
    assert.equal(f.id.shouldRotate(), false);
    assert.ok(!existsSync(join(f.liveDir, 'machine_guid.bin')), '轮换要连 LLBot 的 guid 一起清掉，换全新设备');
    assert.deepEqual(f.id.sessionBackups(), []);

    // 窗口外的老踢记录不再计数
    f.clock.now += KICK_WINDOW_MS + 1000;
    f.id.noteKick(1001, '下线通知');
    assert.equal(f.id.shouldRotate(), false);
  } finally { f.dispose(); }
});

// ---------------- 管理器：登录态字段 / 会话文件识别 ----------------

function makeManager(root: string, opts: { mode?: 'pmhq' | 'direct'; expectedQq?: string; lastLogin?: string } = {}): { mgr: LLBotManager; liveDir: string; idDir: string } {
  const liveDir = join(root, 'llbot', 'bin', 'llbot', 'data');
  mkdirSync(liveDir, { recursive: true });
  const bus = new Bus();
  const errors = new ErrorCenter(bus, { dataDir: root });
  const config = {
    dataDir: root,
    config: {
      onebot: { llbot: { mode: opts.mode ?? 'direct', webuiPort: 15173 } },
      ui: {
        expectedQq: opts.expectedQq ?? '',
        lastLogin: opts.lastLogin ? { qq: opts.lastLogin, nickname: '叶的组诗', ts: 1 } : null,
      },
    },
    secrets: { llbotAuthToken: 'tok-abc', onebotAccessToken: 'y' },
  };
  const logger = () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  const mgr = new LLBotManager(config as never, errors, bus, logger);
  return { mgr, liveDir, idDir: join(root, 'llbot-identity') };
}

test('LLBotManager: status 暴露登录态守护字段（登录页据此解释掉线）', () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-mgr-'));
  try {
    const { mgr } = makeManager(root);
    const st = mgr.status() as Record<string, unknown>;
    for (const key of ['online', 'uin', 'lastDrop', 'kickCode', 'kicksInWindow', 'deviceId', 'savedSessions']) {
      assert.ok(key in st, `status 缺少 ${key}`);
    }
    assert.equal(st.online, false);
    assert.equal(st.deviceId, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('LLBotManager: 带协议后缀的会话文件也算「已存会话」（--qq 快速登录判断）', () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-mgr-'));
  try {
    const { mgr, liveDir } = makeManager(root, { lastLogin: '3893163081' });
    const remembered = (m: LLBotManager) => (m as unknown as { rememberedUin(): string }).rememberedUin();
    const uin = '3893163081';

    writeSession(liveDir, uin, 'linux'); // 无后缀 = linux 协议
    assert.equal(remembered(mgr), uin);

    rmSync(join(liveDir, `qq-session-${uin}.json`));
    writeFileSync(join(liveDir, `qq-session-${uin}-windows.json`), '{}');
    assert.equal(remembered(mgr), uin, '早期只认无后缀名，换协议后会误判成「无已存会话」而退回扫码');

    // 磁盘上有别的账号的会话、但和 lastLogin 对不上 → 不敢乱登，退回扫码
    rmSync(join(liveDir, `qq-session-${uin}-windows.json`));
    writeFileSync(join(liveDir, 'qq-session-10001.json'), '{}');
    assert.equal(remembered(mgr), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('LLBotManager: stderr 上的 [Kick] 也要记账（LLBot 把 [W]/[E] 写 stderr，只盯 stdout 会全漏）', () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-mgr-'));
  try {
    const { mgr } = makeManager(root);
    const feed = (mgr as unknown as { handleLlbotOutput(d: Buffer, s: 'stdout' | 'stderr'): void }).handleLlbotOutput;

    feed.call(mgr, Buffer.from('[W] core [Kick] code=1001 title="下线通知" desc="你的账号当前登录已失效，请重新登录。"\n'), 'stderr');
    const st = mgr.status() as Record<string, unknown>;
    assert.equal(st.kickCode, 1001);
    assert.equal(st.kicksInWindow, 1);
    assert.match(String(st.error), /1001/);

    // 终端二维码块字符行不该被当成新事件
    feed.call(mgr, Buffer.from('\u001b[47m\u001b[30m ██▄▄▄ ▄█ █▀██▄▄ ▀▄█ ▄▀██ ▄▀▄█▄█ █▄  ▀ \u001b[0m\n'), 'stdout');
    assert.equal((mgr.status() as Record<string, unknown>).kickCode, 1001);

    // 风控拒登：原话要带进 error，供登录页直接告诉用户去手机 QQ 解除限制
    feed.call(mgr, Buffer.from('[E] qq-protocol Login failed: state=168 社交功能限制提醒 你的账号近期存在安全风险，部分功能使用受限。\n'), 'stderr');
    assert.match(String((mgr.status() as Record<string, unknown>).error), /社交功能限制/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('LLBotManager: 掉线看门狗——在线转离线记因，扫码静默期内不打扰，一波掉线只自愈一次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-mgr-'));
  try {
    const { mgr } = makeManager(root);
    const m = mgr as unknown as Record<string, any> & {
      tickOnlineWatch(): Promise<void>;
      offlineSince: number;
      lastQrFetchAt: number;
      recovering: boolean;
    };
    m.running = () => true;
    m.stopping = false;
    // 不 stub recover：它自己维护「一波掉线只自愈一次」，stub 掉就等于把被测逻辑一起 stub 了。
    // 真 recover 会 stop()+start()，这里换成计数，避免真去拉 LLBot 进程。
    let restarts = 0;
    m.stop = async () => { restarts++; };
    m.start = async () => { restarts++; };
    const status = () => mgr.status() as Record<string, any>;

    m.loginInfo = async () => ({ online: true, uin: '3893163081', nick: '叶的组诗' });
    await m.tickOnlineWatch();
    assert.equal(status().online, true);
    assert.equal(status().uin, '3893163081');

    // 掉线：先记账（登录页据此解释「为什么突然弹扫码」）
    m.loginInfo = async () => ({ online: false, uin: '', nick: '' });
    await m.tickOnlineWatch();
    assert.equal(status().online, false);
    assert.match(String(status().lastDrop?.desc), /code=1001|中断/);
    assert.equal(restarts, 0, '刚掉线不能立刻重启（可能是抖一下）');

    // 摇过观望期：静默期外允许自愈一次（stop+start 各记一次）
    m.offlineSince = Date.now() - 60_000;
    m.lastQrFetchAt = 0;
    await m.tickOnlineWatch();
    assert.equal(restarts, 2);

    // 还没回到线上时不再反复重启（否则会把用户手上的二维码一直作废）
    await m.tickOnlineWatch();
    assert.equal(restarts, 2, '一波掉线只自愈一次');

    // 有人正在扫码 → 不重启
    m.recoveredThisEpisode = false;
    m.lastQrFetchAt = Date.now();
    m.offlineSince = Date.now() - 60_000;
    await m.tickOnlineWatch();
    assert.equal(restarts, 2, '正在扫码时不要重启打断');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------- 有头模式（PMHQ）：启动参数、注入器配置、账号守卫 ----------------

test('LLBotManager: 有头模式没设预期 bot 账号就拒绝启动（否则可能顶着别的号发言）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-pmhq-'));
  try {
    const { mgr } = makeManager(root, { mode: 'pmhq', expectedQq: '' });
    await mgr.start();
    const st = mgr.status() as Record<string, unknown>;
    assert.equal(st.running, false, '不该拉起任何进程');
    assert.equal(st.mode, 'pmhq');
    assert.match(String(st.error), /预期 bot 账号/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('LLBotManager: 有头模式写 PMHQ 配置（QQ 路径 / 自动登录号 / 鉴权 / 独立档案）', () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-pmhq-'));
  try {
    const { mgr } = makeManager(root, { mode: 'pmhq', expectedQq: '3893163081' });
    (mgr as unknown as { writePmhqConfig(): void }).writePmhqConfig();
    const p = join(root, 'llbot', 'bin', 'pmhq', 'pmhq_config.json');
    assert.ok(existsSync(p), 'PMHQ 配置写在 bin/pmhq/pmhq_config.json');
    const cfg = JSON.parse(readFileSync(p, 'utf-8'));
    assert.equal(cfg.quick_login_qq, '3893163081');
    assert.equal(cfg.auth_token, 'tok-abc', 'PMHQ 必填 manager 鉴权 token');
    assert.equal(cfg.default_port, 13000);
    // bot 的 QQ 走独立档案：默认 <data>/qq-bot-profile，不碰用户自己在用的 QQ
    assert.match(String(cfg.qq_args), /--user-data-dir=.*qq-bot-profile/);

    // 已存在的手改字段要保留，不整份覆盖
    writeFileSync(p, JSON.stringify({ ...cfg, debug: true, default_port: 13999, qq_args: '--user-data-dir="X:\\old" --disable-gpu' }));
    (mgr as unknown as { writePmhqConfig(): void }).writePmhqConfig();
    const again = JSON.parse(readFileSync(p, 'utf-8'));
    assert.equal(again.debug, true);
    assert.equal(again.default_port, 13999);
    assert.equal(again.quick_login_qq, '3893163081');
    assert.match(again.qq_args, /--disable-gpu/, '手改的其它 QQ 参数要留着');
    assert.equal((again.qq_args.match(/--user-data-dir/g) ?? []).length, 1, '我们自己那段只留一份，不叠加');

    // qqProfileDir 填 '-' = 明确用本机默认档案（接管正在运行的那个 QQ）→ 摘掉我们写的档案参数
    (mgr as unknown as { config: { config: { onebot: { llbot: Record<string, unknown> } } } }).config.config.onebot.llbot.qqProfileDir = '-';
    (mgr as unknown as { writePmhqConfig(): void }).writePmhqConfig();
    const finalCfg = JSON.parse(readFileSync(p, 'utf-8'));
    assert.ok(!/--user-data-dir/.test(finalCfg.qq_args), '切回本机默认档案时不能残留旧档案参数');
    assert.match(finalCfg.qq_args, /--disable-gpu/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('LLBotManager: 有头模式的「记住账号」不依赖无头模式的会话文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-pmhq-'));
  try {
    const { mgr, liveDir } = makeManager(root, { mode: 'pmhq', expectedQq: '3893163081' });
    const remembered = (m: LLBotManager) => (m as unknown as { rememberedUin(): string }).rememberedUin();
    assert.equal(liveDir && existsSync(join(liveDir, 'qq-session-3893163081.json')), false, '前提：没有无头模式的会话文件');
    assert.equal(remembered(mgr), '3893163081', '有头模式取自预期账号（交给 PMHQ 自动登录）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OneBot11Adapter: 账号守卫 —— 登录号与预期 bot 账号不符时一律不处理上行事件', () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-guard-'));
  try {
    const bus = new Bus();
    const errors = new ErrorCenter(bus, { dataDir: root });
    const config = {
      config: {
        ui: { expectedQq: '' },   // 先不设限，下面再设
        onebot: { host: '127.0.0.1', port: 3001, reverseWsPath: '/onebot' },
      },
    };
    const seen: unknown[] = [];
    const adapter = new OneBot11Adapter(
      config as never, errors, bus, {} as never, (e) => seen.push(e),
      () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    );
    const a = adapter as unknown as Record<string, any>;
    const handled: unknown[] = [];
    a.handleMessageEvent = async (m: unknown) => { handled.push(m); };
    const frame = { post_type: 'message', message_type: 'private', user_id: 1, self_id: 'X', message: [] };

    // 预期账号未设 → 不设限（无头模式的默认行为：扫谁的码就是谁）
    a.selfId = '3095966025';
    a.checkAccount();
    a.handleFrame(frame);
    assert.equal(handled.length, 1);
    assert.equal(a.accountBlocked, null);

    // 设了预期账号 + 登的是别的号 → 停止代发，且不把错的号记进 lastLogin
    config.config.ui.expectedQq = '3893163081';
    a.checkAccount();
    assert.deepEqual(adapter.status().accountBlocked, { got: '3095966025', expected: '3893163081' });
    a.handleFrame(frame);
    assert.equal(handled.length, 1, '登错号时上行消息一律丢弃');

    // 换回预期账号 → 恢复
    a.selfId = '3893163081';
    a.checkAccount();
    assert.equal(adapter.status().accountBlocked, undefined);
    a.handleFrame(frame);
    assert.equal(handled.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pmhqPreflightVerdict: 有头模式首次注入会让开——本机有别家 QQ 在跑且 bot 的 QQ 还没起来', () => {
  // 本机没 QQ：可以安全拉起（PMHQ 会自己开一个）
  assert.equal(pmhqPreflightVerdict({ total: 0, ours: 0 }, true), '');
  // bot 自己的 QQ 已在跑（同一个档案）：注入目标就是它，放行
  assert.equal(pmhqPreflightVerdict({ total: 3, ours: 3 }, true), '');
  // 只有别的 QQ 在跑（用户自己在用的那个）→ 拒绝，否则 PMHQ 会把它一起关掉
  const msg = pmhqPreflightVerdict({ total: 8, ours: 0 }, true);
  assert.match(msg, /别的 QQ 在运行/);
  assert.match(msg, /qqProfileDir/);
  // 查不到进程（无权限/超时）：fail-open，别因为查询失败把 bot 挡死
  assert.equal(pmhqPreflightVerdict(null, true), '');
  // qqProfileDir='-'（明确借用本机默认档案）：运行中的 QQ 就是目标，永远放行
  assert.equal(pmhqPreflightVerdict({ total: 8, ours: 0 }, false), '');
});
