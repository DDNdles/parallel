import { newId, nowMs, truncate } from '../util/misc.ts';
import type { Db } from '../db.ts';
import type { Bus } from '../bus.ts';
import { busEvents } from '../bus.ts';
import type { ErrorCenter } from '../errors.ts';
import type { MemoryOp, UserFact, UserProfile } from '../types.ts';

/**
 * 用户记忆服务：按 QQ 号记忆，SQLite + FTS5(trigram) 检索。
 * 预留 memoryBackend 切换位（mem0 等适配器实现同一接口即可替换）。
 */
export class MemoryService {
  constructor(
    private db: Db,
    private bus: Bus,
    private errors: ErrorCenter,
  ) {}

  touchUser(userId: string, nickname?: string): void {
    const row = this.db.get('SELECT user_id, nickname FROM users WHERE user_id=?', userId);
    if (!row) {
      this.db.run('INSERT INTO users (user_id, nickname, first_seen, last_seen) VALUES (?,?,?,?)', userId, nickname ?? '', nowMs(), nowMs());
      this.op(userId, 'create_profile', '', 'kernel');
    } else {
      this.db.run('UPDATE users SET last_seen=? WHERE user_id=?', nowMs(), userId);
      if (nickname && nickname !== row.nickname && !row.nickname) {
        this.db.run('UPDATE users SET nickname=? WHERE user_id=?', nickname, userId);
      }
    }
  }

  getProfile(userId: string): UserProfile {
    const row = this.db.get<any>('SELECT * FROM users WHERE user_id=?', userId);
    if (!row) {
      return { userId, nickname: '', firstSeen: nowMs(), lastSeen: nowMs(), blocked: false };
    }
    return {
      userId: row.user_id, nickname: row.nickname ?? '', remark: row.remark ?? '',
      firstSeen: row.first_seen, lastSeen: row.last_seen, blocked: !!row.blocked,
    };
  }

  listUsers(filter?: { blocked?: boolean }): UserProfile[] {
    const rows = filter?.blocked !== undefined
      ? this.db.all<any>('SELECT * FROM users WHERE blocked=? ORDER BY last_seen DESC', filter.blocked ? 1 : 0)
      : this.db.all<any>('SELECT * FROM users ORDER BY last_seen DESC');
    return rows.map((r) => ({
      userId: r.user_id, nickname: r.nickname ?? '', remark: r.remark ?? '',
      firstSeen: r.first_seen, lastSeen: r.last_seen, blocked: !!r.blocked,
    }));
  }

  setBlocked(userId: string, blocked: boolean): void {
    this.touchUser(userId);
    this.db.run('UPDATE users SET blocked=? WHERE user_id=?', blocked ? 1 : 0, userId);
    this.op(userId, blocked ? 'block' : 'unblock', '', 'ui');
  }

  setRemark(userId: string, remark: string): void {
    this.touchUser(userId);
    this.db.run('UPDATE users SET remark=? WHERE user_id=?', remark, userId);
  }

  // ---- 事实 ----

  addFact(userId: string, fact: { content: string; sourcePlugin?: string; sourceChat?: string; ttlDays?: number; weight?: number }): UserFact {
    const id = newId('f_');
    const ts = nowMs();
    const expiresAt = fact.ttlDays ? ts + fact.ttlDays * 86_400_000 : null;
    this.db.run(
      'INSERT INTO user_facts (id, user_id, content, source_plugin, source_chat, weight, ts, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      id, userId, fact.content, fact.sourcePlugin ?? 'kernel', fact.sourceChat ?? '', fact.weight ?? 1, ts, expiresAt,
    );
    this.op(userId, 'add_fact', fact.content, fact.sourcePlugin ?? 'kernel');
    this.bus.emit(busEvents.memoryChanged, { userId, op: 'add_fact' });
    return { id, userId, content: fact.content, sourcePlugin: fact.sourcePlugin ?? 'kernel', sourceChat: fact.sourceChat ?? '', weight: fact.weight ?? 1, ts, expiresAt: expiresAt ?? undefined };
  }

  /** FTS5 trigram 检索；<3 字符回退 LIKE。与 topFacts 同一口径：过期事实不再可见 */
  searchFacts(userId: string, query: string, limit = 10): UserFact[] {
    const q = query.trim();
    if (!q) return this.topFacts(userId, limit);
    const now = nowMs();
    let rows: any[];
    if ([...q].length >= 3) {
      const ftsQuery = q.replace(/["']/g, ' ');
      rows = this.db.all(
        `SELECT f.* FROM user_facts_fts ft JOIN user_facts f ON f.rowid = ft.rowid
         WHERE user_facts_fts MATCH ? AND f.user_id = ? AND (f.expires_at IS NULL OR f.expires_at > ?)
         ORDER BY f.weight DESC, f.ts DESC LIMIT ?`,
        `"${ftsQuery}"`, userId, now, limit,
      );
      if (rows.length === 0) {
        rows = this.db.all(
          'SELECT * FROM user_facts WHERE user_id=? AND content LIKE ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY weight DESC, ts DESC LIMIT ?',
          userId, `%${q}%`, now, limit,
        );
      }
    } else {
      rows = this.db.all(
        'SELECT * FROM user_facts WHERE user_id=? AND content LIKE ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY weight DESC, ts DESC LIMIT ?',
        userId, `%${q}%`, now, limit,
      );
    }
    return rows.map(rowToFact);
  }

  topFacts(userId: string, limit = 5): UserFact[] {
    const now = nowMs();
    const rows = this.db.all(
      `SELECT * FROM user_facts WHERE user_id=? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY weight DESC, ts DESC LIMIT ?`,
      userId, now, limit,
    );
    return rows.map(rowToFact);
  }

  deleteFacts(userId: string, ids: string[]): void {
    const contents = ids.length
      ? this.db.all<{ content: string }>(
        `SELECT content FROM user_facts WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`, userId, ...ids,
      ).map((r) => r.content)
      : [];
    for (const id of ids) {
      this.db.run('DELETE FROM user_facts WHERE user_id=? AND id=?', userId, id);
    }
    this.op(userId, 'delete_facts', contents.join(' / '), 'ui');
    this.bus.emit(busEvents.memoryChanged, { userId, op: 'delete_facts' });
  }

  updateFact(userId: string, id: string, content: string): void {
    this.db.run('UPDATE user_facts SET content=? WHERE user_id=? AND id=?', content, userId, id);
    this.op(userId, 'update_fact', truncate(content, 100), 'ui');
    this.bus.emit(busEvents.memoryChanged, { userId, op: 'update_fact' });
  }

  // ---- 结构化属性 ----

  getAttr<T = unknown>(userId: string, key: string): T | undefined {
    const row = this.db.get<{ value: string }>('SELECT value FROM user_attrs WHERE user_id=? AND key=?', userId, key);
    if (!row) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return row.value as unknown as T; }
  }

  setAttr(userId: string, key: string, value: unknown): void {
    this.touchUser(userId);
    this.db.run(
      `INSERT INTO user_attrs (user_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      userId, key, JSON.stringify(value ?? null), nowMs(),
    );
    this.op(userId, `set_attr:${key}`, truncate(JSON.stringify(value), 100), 'kernel');
    this.bus.emit(busEvents.memoryChanged, { userId, op: `set_attr:${key}` });
  }

  allAttrs(userId: string): Record<string, unknown> {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM user_attrs WHERE user_id=?', userId);
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  }

  /** "忘记我"：清空某用户全部记忆（拉黑状态可选保留） */
  forget(userId: string, opts: { keepBlocked?: boolean; source?: string } = {}): void {
    const blocked = opts.keepBlocked ? this.getProfile(userId).blocked : false;
    this.db.run('DELETE FROM user_facts WHERE user_id=?', userId);
    this.db.run('DELETE FROM user_attrs WHERE user_id=?', userId);
    this.db.run('DELETE FROM users WHERE user_id=?', userId);
    if (blocked) {
      this.db.run('INSERT INTO users (user_id, nickname, first_seen, last_seen, blocked) VALUES (?,?,?,?,1)', userId, '', nowMs(), nowMs());
    }
    this.op(userId, 'forget', opts.keepBlocked ? 'keepBlocked' : '', opts.source ?? 'chat');
    this.bus.emit(busEvents.memoryChanged, { userId, op: 'forget' });
  }

  // ---- 审计 ----

  private op(userId: string, op: string, payload: string, source: string): void {
    try {
      this.db.run('INSERT INTO memory_ops (id, user_id, op, payload, source, ts) VALUES (?,?,?,?,?,?)',
        newId('m_'), userId, op, truncate(payload, 200), source, nowMs());
    } catch (e) {
      this.errors.record('warn', 'storage', `memory_ops 写入失败: ${(e as Error).message}`);
    }
  }

  recentOps(limit = 100, userId?: string): MemoryOp[] {
    const rows = userId
      ? this.db.all('SELECT * FROM memory_ops WHERE user_id=? ORDER BY ts DESC LIMIT ?', userId, limit)
      : this.db.all('SELECT * FROM memory_ops ORDER BY ts DESC LIMIT ?', limit);
    return rows.map((r: any) => ({
      id: r.id, userId: r.user_id, op: r.op, payload: r.payload, source: r.source, ts: r.ts,
    }));
  }
}

function rowToFact(r: any): UserFact {
  return {
    id: r.id, userId: r.user_id, content: r.content, sourcePlugin: r.source_plugin,
    sourceChat: r.source_chat, weight: r.weight, ts: r.ts, expiresAt: r.expires_at ?? undefined,
  };
}
