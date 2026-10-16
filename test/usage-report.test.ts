import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ============================================================
// 用量报表（usageReport）：「用量」页三张图共用这一份聚合。
// 口径是用户定的，断言的就是口径本身：
//   ① 消息数不对应模型；② token 按模型分，且拆「输入未命中 / 缓存命中 / 输出」；
//   ③ 老库（无 model 列）启动时要原地迁一次，历史行 model 留空而不是被抹掉。
// ============================================================

const DAY = 86_400_000;
const { todayKey } = await import('../src/kernel/util/misc.ts');
/** 相对今天的日号（与 todayKey 同一套 UTC 口径） */
const day = (back: number) => todayKey(-back * DAY);

async function fresh() {
  const { Db } = await import('../src/kernel/db.ts');
  const dir = mkdtempSync(join(tmpdir(), 'parallel-usage-'));
  const db = new Db(dir);
  /** Windows 上 sqlite 句柄没关掉就删不掉目录，收尾必须一起处理 */
  const done = () => { db.db.close(); rmSync(dir, { recursive: true, force: true }); };
  const ins = (d: string, provider: string, model: string, chat: string, o: {
    miss?: number; hit?: number; out?: number; calls?: number; mi?: number; mo?: number;
  }) => db.run(`INSERT INTO usage_stats (day, provider, model, chat_id, prompt_tokens, completion_tokens, cache_hit, cache_miss, llm_calls, messages_in, messages_out)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    d, provider, model, chat, (o.miss ?? 0) + (o.hit ?? 0), o.out ?? 0, o.hit ?? 0, o.miss ?? 0,
    o.calls ?? 0, o.mi ?? 0, o.mo ?? 0);
  return { db, ins, done };
}

test('用量：空库出全零报表，不抛', async () => {
  const { usageReport } = await import('../src/kernel/services/usage.ts');
  const { db, done } = await fresh();
  try {
    const r = usageReport(db);
    assert.equal(r.firstDay, null);
    assert.deepEqual(r.days, []);
    assert.equal(r.today, null);
    assert.equal(r.totals.tokens, 0);
    assert.equal(r.totals.streak, 0);
    assert.deepEqual(r.models, []);
  } finally { done(); }
});

test('用量：token 按模型拆三档，消息数不挂模型', async () => {
  const { usageReport } = await import('../src/kernel/services/usage.ts');
  const { db, ins, done } = await fresh();
  try {
    ins(day(1), 'deepseek', 'deepseek-v4-flash', '888001', { miss: 900, hit: 100, out: 60, calls: 3 });
    ins(day(1), 'deepseek', 'deepseek-v4-flash', '-', { mi: 12, mo: 5 });          // 消息行：model 空
    ins(day(0), 'glm', 'glm-5.3-flash', '888001', { miss: 40, hit: 60, out: 20, calls: 2 });
    const r = usageReport(db);

    assert.equal(r.totals.cacheMiss, 940);
    assert.equal(r.totals.cacheHit, 160);
    assert.equal(r.totals.completion, 80);
    assert.equal(r.totals.tokens, 1180);
    assert.equal(r.totals.calls, 5);
    assert.equal(r.totals.msgIn, 12);
    assert.equal(r.totals.msgOut, 5);

    // 模型列表按 token 降序，且带命中率要用的三档
    assert.deepEqual(r.models.map((m) => m.model), ['deepseek-v4-flash', 'glm-5.3-flash']);
    assert.deepEqual(
      { ...r.models[0] },
      { model: 'deepseek-v4-flash', providers: ['deepseek'], miss: 900, hit: 100, out: 60, calls: 3, tokens: 1060, days: 1 },
    );
    // 日桶里也只有模型有调用时才进 byModel
    const d1 = r.days.find((d) => d.day === day(1))!;
    assert.deepEqual(Object.keys(d1.byModel), ['deepseek-v4-flash']);
    assert.equal(d1.chats, 1);
  } finally { done(); }
});

test('用量：同一模型跨两个供应商会并成一行，providers 都记下来', async () => {
  const { usageReport } = await import('../src/kernel/services/usage.ts');
  const { db, ins, done } = await fresh();
  try {
    ins(day(0), 'ustc', 'glm-5.3-flash', '-', { miss: 10, hit: 0, out: 5, calls: 1 });
    ins(day(0), 'zhipu', 'glm-5.3-flash', '-', { miss: 4, hit: 1, out: 2, calls: 1 });
    const r = usageReport(db);
    assert.equal(r.models.length, 1);
    assert.deepEqual(r.models[0].providers.sort(), ['ustc', 'zhipu']);
    assert.equal(r.models[0].tokens, 22);
    assert.equal(r.models[0].calls, 2);
  } finally { done(); }
});

test('用量：连续天数——今天没记账不算断，中间缺一天才算断', async () => {
  const { usageReport } = await import('../src/kernel/services/usage.ts');
  const { db, ins, done } = await fresh();
  try {
    const msg = (back: number) => ins(day(back), 'alpha', '', '-', { mi: 1 });
    msg(1); msg(2); msg(3);
    let r = usageReport(db);
    assert.equal(r.totals.streak, 3, '今天还没记录，从昨天往回数');
    assert.equal(r.totals.bestStreak, 3);

    msg(0);
    r = usageReport(db);
    assert.equal(r.totals.streak, 4);

    msg(6);                                   // 断一天再补一段
    r = usageReport(db);
    assert.equal(r.totals.bestStreak, 4, '最长段仍是连着的那 4 天');
    assert.equal(r.totals.activeDays, 5);
  } finally { done(); }
});

test('用量：脏日号（手改出来的坏值）不进报表', async () => {
  const { usageReport } = await import('../src/kernel/services/usage.ts');
  const { db, ins, done } = await fresh();
  try {
    db.run('INSERT INTO usage_stats (day, provider, model, chat_id, prompt_tokens, completion_tokens, llm_calls) VALUES (?,?,?,?,?,?,?)',
      'not-a-day', 'alpha', 'm', '-', 999, 999, 9);
    ins(day(0), 'alpha', 'm', '-', { miss: 8, out: 2, calls: 1 });
    const r = usageReport(db);
    assert.equal(r.days.length, 1);
    assert.equal(r.totals.tokens, 10);
  } finally { done(); }
});

test('迁移：老库（无 model 列）启动时搬一次，历史行 model 留空、数字不丢', async () => {
  const { Db } = await import('../src/kernel/db.ts');
  const dir = mkdtempSync(join(tmpdir(), 'parallel-usage-mig-'));
  try {
    const file = join(dir, 'parallel.db');
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE usage_stats (
        day TEXT NOT NULL, provider TEXT NOT NULL, chat_id TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, llm_calls INTEGER DEFAULT 0,
        messages_in INTEGER DEFAULT 0, messages_out INTEGER DEFAULT 0,
        PRIMARY KEY (day, provider, chat_id));`);
    raw.exec("INSERT INTO usage_stats (day, provider, chat_id, prompt_tokens, completion_tokens, llm_calls, messages_in) VALUES ('2026-09-16','mock','888001',1280,280,12,7)");
    raw.close();

    const db = new Db(dir);
    try {
      const cols = db.all<{ name: string }>('PRAGMA table_info(usage_stats)').map((c) => c.name);
      assert.ok(cols.includes('model') && cols.includes('cache_hit') && cols.includes('cache_miss'), cols.join(','));
      const rows = db.all<Record<string, number | string>>('SELECT * FROM usage_stats');
      assert.equal(rows.length, 1, '老行没被复制成两条');
      assert.equal(rows[0].model, '', '历史行不猜模型，留空');
      assert.equal(rows[0].prompt_tokens, 1280);
      assert.equal(rows[0].messages_in, 7);

      const { usageReport } = await import('../src/kernel/services/usage.ts');
      const r = usageReport(db);
      assert.deepEqual(r.models.map((m) => m.model), [''], '历史 token 归到「未知模型」');
      assert.equal(r.models[0].tokens, 1560);
      db.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});
