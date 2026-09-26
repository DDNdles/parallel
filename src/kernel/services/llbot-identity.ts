import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, readJson } from '../util/fsutil.ts';

/**
 * LLBot 登录态持久化 + 设备身份管理。
 *
 * 为什么需要它（2026-09-16 排查「扫码登录后过一段时间又弹登录页」）：
 * - LLBot Direct（纯协议）模式下 `data/machine_guid.bin` 就是账号对腾讯的**唯一设备身份**：
 *   wtlogin 的 guid 与签名服务（SignProxy）的 device 指纹同源，登录/上线注册都拿它当设备号。
 * - 腾讯把登录态判失效时会给一条 `[Kick] code=1001 下线通知`；LLBot 的既定策略是删掉
 *   machine_guid.bin + `qq-session-<uin>.json` 并**随机换一个新设备身份**重扫。实测 4 天里换了
 *   5 个设备身份（每个进程一代），等于每掉一次线就对腾讯装成一台新电脑 —— 这本身是风控信号，
 *   而且下一次掉线又必须人工扫码。
 * - 本模块把设备身份与会话凭证**钉住**：每次拉 LLBot 前把 pin 过的 guid 写回去，会话文件另存备份，
 *   掉线后据此免扫码快速登录；只有同一身份在短窗口内被连续踢（说明它真被标记了）才轮换一次身份。
 *
 * 目录：<内核 data>/llbot-identity/（刻意放在 LLBot home 之外，它自己不会清理这里）
 *   machine_guid.bin        钉住的设备身份（16B）
 *   qq-session-<uin>*.json  会话凭证备份
 *   state.json              踢下线历史 / 备份时间 / 轮换记录（供状态展示与策略判断）
 */

export interface LlbotKick {
  code: number;
  desc: string;
  at: number;
}

export interface LlbotIdentityState {
  deviceId: string;
  /** 该设备身份被踢下线的历史（时间倒序，只留最近若干条） */
  kicks: LlbotKick[];
  lastKick?: LlbotKick;
  /** 上一次换设备身份的时间 */
  rotatedAt?: number;
  /** 上一次确认「凭证已作废」的时间（收到 1001 / 恢复失败 -10003 时记） */
  sessionInvalidatedAt?: number;
  sessionInvalidatedReason?: string;
  /** 会话备份的写入时间（判断备份是否还新、是否早于作废时间） */
  lastSessionBackupAt?: number;
  lastOnlineAt?: number;
  /** 掉线后「拿备份会话赌一次」的已尝试时间（每轮掉线只赌一次，避免反复拿死凭证撞服务端） */
  sessionRetryAt?: number;
}

/** LLBot stdout 里值得内核关心的事件 */
export type LlbotLineEvent =
  | { type: 'kick'; code: number; desc: string }
  | { type: 'session-invalid'; reason: string }
  | { type: 'logged-in' }
  | { type: 'login-failed'; state: number; message: string }
  | { type: 'qr-exhausted' };

const KICK_CODE_RE = /\[Kick\]\s*code=(-?\d+)/;
const KICK_DESC_RE = /desc="([^"]*)"/;
const KICK_TITLE_RE = /title="([^"]*)"/;
/** "Login failed: state=168 社交功能限制提醒 你的账号…" */
const LOGIN_FAILED_RE = /Login failed:\s*state=(-?\d+)\s*(.*)$/;

/**
 * 解析 LLBot 单行输出。只认这几类信号，其余交给日志。
 * 语料出处：data/llbot/bin/llbot/data/logs/llbot-*.log 真实日志。
 */
export function parseLlbotLine(line: string): LlbotLineEvent | null {
  if (line.includes('[Kick]')) {
    const code = Number(KICK_CODE_RE.exec(line)?.[1] ?? 0);
    const title = KICK_TITLE_RE.exec(line)?.[1] ?? '';
    const desc = KICK_DESC_RE.exec(line)?.[1] ?? '';
    return { type: 'kick', code, desc: [title, desc].filter(Boolean).join('：') };
  }
  const failed = LOGIN_FAILED_RE.exec(line);
  if (failed) return { type: 'login-failed', state: Number(failed[1]), message: (failed[2] ?? '').trim() };
  if (line.includes('[QQ Server] Online registered') || line.includes('Login successful')) {
    return { type: 'logged-in' };
  }
  if (
    line.includes('Saved session expired') ||
    line.includes('has no usable session') ||
    line.includes('retCode=-10003')
  ) {
    const m = /extraMsg=([^()]*)/.exec(line) ?? /: (.+)$/.exec(line);
    return { type: 'session-invalid', reason: (m?.[1] ?? '').trim() };
  }
  if (line.includes('停止自动刷新')) return { type: 'qr-exhausted' };
  return null;
}

/** 同一设备身份在这个窗口内被踢这么多次，就认定身份被标记 → 轮换 */
export const KICK_WINDOW_MS = 6 * 60 * 60 * 1000;
export const KICK_ROTATE_THRESHOLD = 2;
/** 备份会话的保鲜期：超过就不再拿去赌 */
export const SESSION_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_KICK_HISTORY = 20;

export class LlbotIdentity {
  private state: LlbotIdentityState;

  constructor(
    /** 内核侧身份目录 */
    private dir: string,
    /** LLBot 实际 data 目录（可能随包布局变化，故用函数取） */
    private liveDir: () => string,
    private now: () => number = () => Date.now(),
  ) {
    this.state = readJson<LlbotIdentityState>(this.statePath(), { deviceId: '', kicks: [] });
    if (!Array.isArray(this.state.kicks)) this.state.kicks = [];
  }

  private statePath(): string {
    return join(this.dir, 'state.json');
  }

  private pinGuidPath(): string {
    return join(this.dir, 'machine_guid.bin');
  }

  private liveGuidPath(): string {
    return join(this.liveDir(), 'machine_guid.bin');
  }

  private save(): void {
    atomicWriteJson(this.statePath(), this.state);
  }

  /** 当前钉住的设备身份（hex，空 = 还没建立） */
  deviceId(): string {
    return this.state.deviceId;
  }

  /**
   * 启动 LLBot 前调用：把钉住的设备身份写回 LLBot 的 data 目录。
   * - 已有 pin：覆盖 LLBot 的文件（LLBot 上次掉线时可能已把它删了/换了新的）
   * - 没有 pin 但 LLBot 有文件：把现有身份收编为 pin（首次接管，保持不动）
   * - 都没有：等 LLBot 起来自己生成，随后 adoptLiveGuid() 收编
   */
  pinGuid(): 'pinned' | 'adopted' | 'pending' {
    mkdirSync(this.dir, { recursive: true });
    const live = this.liveGuidPath();
    if (existsSync(this.pinGuidPath())) {
      const buf = readFileSync(this.pinGuidPath());
      if (buf.length !== 16) {
        rmSync(this.pinGuidPath(), { force: true });
        return this.pinGuid();
      }
      this.writeLive(buf);
      this.state.deviceId = buf.toString('hex');
      this.save();
      return 'pinned';
    }
    if (existsSync(live)) {
      const buf = readFileSync(live);
      if (buf.length === 16) {
        writeFileSync(this.pinGuidPath(), buf);
        this.state.deviceId = buf.toString('hex');
        this.save();
        return 'adopted';
      }
    }
    return 'pending';
  }

  /** LLBot 首次自己生成 guid 后收编（进程起来后调，幂等） */
  adoptLiveGuid(): string {
    if (existsSync(this.pinGuidPath())) return this.state.deviceId;
    const live = this.liveGuidPath();
    if (!existsSync(live)) return '';
    const buf = readFileSync(live);
    if (buf.length !== 16) return '';
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pinGuidPath(), buf);
    this.state.deviceId = buf.toString('hex');
    this.save();
    return this.state.deviceId;
  }

  private writeLive(buf: Buffer): void {
    const live = this.liveGuidPath();
    mkdirSync(join(live, '..'), { recursive: true });
    writeFileSync(live, buf);
  }

  noteKick(code: number, desc: string): LlbotKick {
    const kick: LlbotKick = { code, desc, at: this.now() };
    this.state.kicks.unshift(kick);
    if (this.state.kicks.length > MAX_KICK_HISTORY) this.state.kicks.length = MAX_KICK_HISTORY;
    this.state.lastKick = kick;
    // 1001 = 下线通知/异地顶号：LLBot 会把会话与设备身份一起作废
    if (code === 1001) {
      this.state.sessionInvalidatedAt = kick.at;
      this.state.sessionInvalidatedReason = desc || `code=${code}`;
      this.state.sessionRetryAt = undefined; // 新一轮掉线，允许再赌一次备份会话
    }
    this.save();
    return kick;
  }

  /** 恢复会话失败（凭证被服务端作废）——别再拿它去撞服务端，备份一并丢掉 */
  noteSessionInvalid(reason: string): void {
    this.state.sessionInvalidatedAt = this.now();
    this.state.sessionInvalidatedReason = reason;
    for (const name of this.sessionBackups()) rmSync(join(this.dir, name), { force: true });
    this.state.lastSessionBackupAt = undefined;
    this.save();
  }

  noteOnline(): void {
    this.state.lastOnlineAt = this.now();
    // 登录成功说明当前凭证有效：清掉作废标记，允许下一次掉线继续用备份
    this.state.sessionInvalidatedAt = undefined;
    this.state.sessionInvalidatedReason = undefined;
    this.state.sessionRetryAt = undefined;
    this.save();
  }

  /** 窗口内被踢次数（同设备身份） */
  kicksInWindow(windowMs = KICK_WINDOW_MS): number {
    const from = this.now() - windowMs;
    return this.state.kicks.filter((k) => k.at >= from).length;
  }

  /** 同一设备身份被连续踢 → 身份可能已被腾讯标记，值得换一次（代价：重新扫码） */
  shouldRotate(): boolean {
    return this.kicksInWindow() >= KICK_ROTATE_THRESHOLD;
  }

  /** 轮换设备身份：丢掉 pin/LLBot 现有 guid 与全部会话备份（下一位是全新设备，必须重新扫码） */
  rotate(): void {
    rmSync(this.pinGuidPath(), { force: true });
    rmSync(this.liveGuidPath(), { force: true });
    for (const name of this.sessionBackups()) rmSync(join(this.dir, name), { force: true });
    this.state = { deviceId: '', kicks: [], rotatedAt: this.now() };
    this.save();
  }

  /** LLBot data 目录里的会话文件（协议后缀由 LLBot 决定，故用通配） */
  liveSessions(): string[] {
    try {
      return readdirSync(this.liveDir()).filter((f) => /^qq-session-\d+.*\.json$/.test(f));
    } catch {
      return [];
    }
  }

  sessionBackups(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => /^qq-session-\d+.*\.json$/.test(f));
    } catch {
      return [];
    }
  }

  /** 把 LLBot 目录里的会话文件备份过来（内容不同才覆盖）。返回有变化的文件名 */
  backupSessions(): string[] {
    mkdirSync(this.dir, { recursive: true });
    const changed: string[] = [];
    for (const name of this.liveSessions()) {
      const src = join(this.liveDir(), name);
      const dst = join(this.dir, name);
      try {
        const same = existsSync(dst) && readFileSync(src).equals(readFileSync(dst));
        if (same) continue;
        copyFileSync(src, dst);
        changed.push(name);
      } catch { /* 单文件失败不影响其他 */ }
    }
    if (changed.length) {
      this.state.lastSessionBackupAt = this.now();
      this.save();
    }
    return changed;
  }

  /** 备份里有没有能用的会话（判断能否免扫码快速登录） */
  hasRestorableSession(): boolean {
    return this.canRestore().length > 0;
  }

  private canRestore(): string[] {
    const age = this.state.lastSessionBackupAt ? this.now() - this.state.lastSessionBackupAt : Infinity;
    if (age > SESSION_BACKUP_MAX_AGE_MS) return [];
    // 备份早于「凭证作废」= 这份本来就是死的，除非本轮掉线还没赌过
    const invalidated = this.state.sessionInvalidatedAt;
    const fresh = this.state.lastSessionBackupAt && invalidated ? this.state.lastSessionBackupAt > invalidated : true;
    if (!fresh && this.state.sessionRetryAt) return []; // 这轮已经赌过一次了
    return this.sessionBackups();
  }

  /**
   * LLBot 目录里的会话丢了（它自己删的 / 目录被换过）→ 从备份补回去。
   * 调用方通常在掉线自愈时调；只有「备份不早于作废时间」或「本轮还没赌过」才补。
   */
  restoreSessionsIfLost(): string[] {
    const restored: string[] = [];
    const candidates = this.canRestore();
    if (!candidates.length) return restored;
    const invalidated = this.state.sessionInvalidatedAt;
    const fresh = this.state.lastSessionBackupAt && invalidated ? this.state.lastSessionBackupAt > invalidated : true;
    for (const name of candidates) {
      if (existsSync(join(this.liveDir(), name))) continue;
      try {
        mkdirSync(this.liveDir(), { recursive: true });
        copyFileSync(join(this.dir, name), join(this.liveDir(), name));
        restored.push(name);
      } catch { /* ignore */ }
    }
    if (restored.length && !fresh) this.state.sessionRetryAt = this.now();
    if (restored.length) this.save();
    return restored;
  }

  status(): {
    deviceId: string;
    kicksInWindow: number;
    lastKick?: LlbotKick;
    rotatedAt?: number;
    sessions: string[];
    sessionInvalidatedAt?: number;
  } {
    return {
      deviceId: this.state.deviceId,
      kicksInWindow: this.kicksInWindow(),
      lastKick: this.state.lastKick,
      rotatedAt: this.state.rotatedAt,
      sessions: this.sessionBackups(),
      sessionInvalidatedAt: this.state.sessionInvalidatedAt,
    };
  }
}
