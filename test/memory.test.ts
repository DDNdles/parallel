import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { Db } from '../src/kernel/db.ts';
import { Bus } from '../src/kernel/bus.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';
import { MemoryService } from '../src/kernel/services/memory.ts';

function mk() {
  const dir = mkdtempSync(tmpdir() + '/pmem-');
  const db = new Db(dir);
  const bus = new Bus();
  return new MemoryService(db, bus, new ErrorCenter(bus, { dataDir: dir }));
}
const ops = (m: MemoryService, userId?: string) => m.recentOps(100, userId).map((o) => o.op).sort();
const last = (m: MemoryService, op: string) => m.recentOps(100).find((o) => o.op === op)!;

// ---------------- 操作审计 ----------------

test('建档/新增/修改/删除/拉黑/忘记我都写入审计', () => {
  const m = mk();
  m.touchUser('1001', '小明');
  const f = m.addFact('1001', { content: '喜欢打篮球' });
  m.updateFact('1001', f.id, '喜欢打羽毛球');
  m.deleteFacts('1001', [f.id]);
  m.setBlocked('1001', true);
  m.setBlocked('1001', false);
  m.forget('1001');
  assert.deepEqual(ops(m), [
    'add_fact', 'block', 'create_profile', 'delete_facts', 'forget', 'unblock', 'update_fact',
  ]);
});

test('审计按用户过滤，不串号', () => {
  const m = mk();
  m.touchUser('1001');
  m.touchUser('1002');
  m.addFact('1001', { content: '只属于 1001' });
  assert.deepEqual(ops(m, '1001'), ['add_fact', 'create_profile']);
  assert.deepEqual(ops(m, '1002'), ['create_profile']);
  assert.deepEqual(ops(m, '9999'), []);
});

test('审计记的是内容而不是内部 id', () => {
  const m = mk();
  m.touchUser('1001');
  const f = m.addFact('1001', { content: '住在杭州' });
  m.deleteFacts('1001', [f.id]);
  assert.equal(last(m, 'delete_facts').payload, '住在杭州');
  m.addFact('1001', { content: '爱吃辣' });
  m.updateFact('1001', m.topFacts('1001', 1)[0].id, '爱吃甜');
  assert.equal(last(m, 'update_fact').payload, '爱吃甜');
});

test('属性写入都进审计，值截断进 payload', () => {
  const m = mk();
  m.touchUser('1001');
  m.setAttr('1001', 'school', '浙大');
  assert.deepEqual(ops(m), ['create_profile', 'set_attr:school']);
  assert.equal(last(m, 'set_attr:school').payload, '"浙大"');
});

// ---------------- 记忆检索（FTS 索引一致性） ----------------

test('改过记忆后仍能删除，且检索跟得上改动（缺 AFTER UPDATE 触发器时删除会报 SQLITE_CORRUPT）', () => {
  const m = mk();
  m.touchUser('1001');
  const a = m.addFact('1001', { content: '喜欢在深夜写代码' });
  const b = m.addFact('1001', { content: '喜欢在深夜听雨' });
  m.updateFact('1001', a.id, '喜欢在清晨写代码');
  m.deleteFacts('1001', [b.id]);
  assert.deepEqual(m.searchFacts('1001', '清晨').map((f) => f.content), ['喜欢在清晨写代码']);
  assert.deepEqual(m.searchFacts('1001', '听雨'), []);
});
