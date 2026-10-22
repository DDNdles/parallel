import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * 存储层：node:sqlite（零原生依赖）。FTS5 用 trigram 分词以支持中文检索；
 * <3 字符的检索词回退 LIKE。
 */
export class Db {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const file = join(dataDir, 'parallel.db');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // busy_timeout 兜底：内核自身单连接不撞库，但外物（sqlite3 CLI、备份工具）碰库时
    // 等它 5 秒而不是立刻 SQLITE_BUSY —— 调研里 MaiBot 的 1s 超时静默丢消息是反面教材
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        nickname TEXT DEFAULT '',
        remark TEXT DEFAULT '',
        first_seen INTEGER,
        last_seen INTEGER,
        blocked INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_attrs (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at INTEGER,
        PRIMARY KEY (user_id, key)
      );

      CREATE TABLE IF NOT EXISTS user_facts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source_plugin TEXT,
        source_chat TEXT,
        weight REAL DEFAULT 1,
        ts INTEGER,
        expires_at INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS user_facts_fts USING fts5(content, tokenize='trigram', content='user_facts', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS user_facts_ai AFTER INSERT ON user_facts BEGIN
        INSERT INTO user_facts_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS user_facts_ad AFTER DELETE ON user_facts BEGIN
        INSERT INTO user_facts_fts(user_facts_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS user_facts_au AFTER UPDATE ON user_facts BEGIN
        INSERT INTO user_facts_fts(user_facts_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO user_facts_fts(rowid, content) VALUES(new.rowid, new.content);
      END;

      CREATE TABLE IF NOT EXISTS memory_ops (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        op TEXT,
        payload TEXT,
        source TEXT,
        ts INTEGER
      );

      CREATE TABLE IF NOT EXISTS plugin_states (
        plugin_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        enabled INTEGER,
        updated_by TEXT,
        updated_at INTEGER,
        PRIMARY KEY (plugin_id, chat_id)
      );

      CREATE TABLE IF NOT EXISTS plugin_kv (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at INTEGER,
        PRIMARY KEY (plugin_id, key)
      );

      CREATE TABLE IF NOT EXISTS plugin_user_config (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at INTEGER,
        PRIMARY KEY (plugin_id, key)
      );

      CREATE TABLE IF NOT EXISTS stickers (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        name TEXT NOT NULL,
        tags TEXT DEFAULT '',
        file TEXT NOT NULL,
        count INTEGER DEFAULT 0,
        last_used INTEGER,
        added_by TEXT,
        added_at INTEGER,
        UNIQUE (chat_id, name)
      );

      CREATE TABLE IF NOT EXISTS sandbox_files (
        chat_key TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        size INTEGER,
        last_access INTEGER,
        PRIMARY KEY (chat_key, rel_path)
      );

      CREATE TABLE IF NOT EXISTS usage_stats (
        day TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        cache_hit INTEGER DEFAULT 0,
        cache_miss INTEGER DEFAULT 0,
        llm_calls INTEGER DEFAULT 0,
        messages_in INTEGER DEFAULT 0,
        messages_out INTEGER DEFAULT 0,
        PRIMARY KEY (day, provider, model, chat_id)
      );

      CREATE TABLE IF NOT EXISTS plugin_errors (
        plugin_id TEXT NOT NULL,
        error_key TEXT NOT NULL,
        count INTEGER DEFAULT 0,
        last_ts INTEGER,
        last_message TEXT,
        PRIMARY KEY (plugin_id, error_key)
      );

      CREATE TABLE IF NOT EXISTS daily_items (
        plugin_id TEXT NOT NULL,
        day TEXT NOT NULL,
        item TEXT,
        PRIMARY KEY (plugin_id, day)
      );

      CREATE TABLE IF NOT EXISTS settings_kv (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- 圈内黑话（表达学习，humanlike/jargon.ts）：每 (群, 词) 学到的含意与频次阶梯进度
      CREATE TABLE IF NOT EXISTS jargon (
        term TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        count INTEGER DEFAULT 0,
        rung INTEGER DEFAULT 0,
        meaning TEXT DEFAULT '',
        ts INTEGER,
        PRIMARY KEY (chat_id, term)
      );

      -- work 子代理任务运行记录（桌面端「工作」页 + 审计）
      CREATE TABLE IF NOT EXISTS work_runs (        id TEXT PRIMARY KEY,
        chat_key TEXT NOT NULL,
        task TEXT NOT NULL,
        model TEXT,
        trigger TEXT,
        phase TEXT,
        ok INTEGER DEFAULT 0,
        rounds INTEGER DEFAULT 0,
        tool_calls INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        summary TEXT,
        error TEXT,
        user_id TEXT,
        ts INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_work_runs_ts ON work_runs(ts DESC);
    `);
    // work 产物清单（JSON 数组）：chat 的 deliver_file 在内核重启后要靠它知道"上次交付了什么"
    // ——会话沙箱里的文件还在，不能因为重启就让 chat 说"发不了"。
    // events / usage / nickname：桌面端「工作」抽屉在重启后还要能画 loop 与缓存/上下文指标。
    const workCols = this.db.prepare('PRAGMA table_info(work_runs)').all() as { name: string }[];
    const addWorkCol = (name: string, type: string) => {
      if (workCols.length && !workCols.some((c) => c.name === name)) this.db.exec(`ALTER TABLE work_runs ADD COLUMN ${name} ${type}`);
    };
    addWorkCol('artifacts', 'TEXT');
    addWorkCol('events', 'TEXT');
    addWorkCol('usage', 'TEXT');
    addWorkCol('nickname', 'TEXT');
    this.repairFts();
    this.migrateUsageModel();
  }

  /** usage_stats 早先是 (day, provider, chat_id) 主键、没有模型与缓存命中列。
   *  「用量」页要按模型分「输入未命中 / 输入缓存命中 / 输出」，主键必须带上 model，
   *  而 SQLite 不支持改主键 —— 只能建新表搬一次。老行的 model 留空串（报表里显示成「未知模型」），
   *  不猜、不改写历史。列已存在就是新库/已迁过的库，直接返回。 */
  private migrateUsageModel(): void {
    const cols = this.db.prepare('PRAGMA table_info(usage_stats)').all() as { name: string }[];
    if (!cols.length || cols.some((c) => c.name === 'model')) return;
    this.db.exec(`
      CREATE TABLE usage_stats_new (
        day TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        cache_hit INTEGER DEFAULT 0,
        cache_miss INTEGER DEFAULT 0,
        llm_calls INTEGER DEFAULT 0,
        messages_in INTEGER DEFAULT 0,
        messages_out INTEGER DEFAULT 0,
        PRIMARY KEY (day, provider, model, chat_id)
      );
      INSERT INTO usage_stats_new (day, provider, model, chat_id, prompt_tokens, completion_tokens, llm_calls, messages_in, messages_out)
        SELECT day, provider, '', chat_id, prompt_tokens, completion_tokens, llm_calls, messages_in, messages_out FROM usage_stats;
      DROP TABLE usage_stats;
      ALTER TABLE usage_stats_new RENAME TO usage_stats;
    `);
  }

  /** 老库的 FTS 索引缺 AFTER UPDATE 触发器：改过一次记忆后索引与内容错位，
   *  再删就会抛 SQLITE_CORRUPT。补完触发器按内容表重建一次（只跑一次）。 */
  private repairFts(): void {
    const done = this.db.prepare("SELECT value FROM settings_kv WHERE key='fts_repair_v1'").get();
    if (done) return;
    try {
      this.db.exec("INSERT INTO user_facts_fts(user_facts_fts) VALUES('rebuild')");
    } catch { /* 重建失败不阻塞启动，检索会退化成空结果 */ }
    this.db.prepare("INSERT INTO settings_kv (key, value) VALUES ('fts_repair_v1', '1')").run();
  }

  // ---- 便捷方法 ----
  run(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
