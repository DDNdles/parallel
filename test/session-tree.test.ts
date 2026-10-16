import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bus } from '../src/kernel/bus.ts';
import { SessionLog } from '../src/kernel/sessionlog.ts';

/**
 * 会话条目树：每条entry带 parentId，同一会话串成一条活动分支；
 * compaction 条目表示"这一刻之前的历史由摘要代替"。
 * 这是接 pi 压缩的前提——它的语义要靠 `firstKeptEntryId` 指回具体条目。
 */

const dir = () => mkdtempSync(join(tmpdir(), 'parallel-sess-'));

test('append：同会话的条目串成一条链，不同会话互不影响', () => {
  const d = dir();
  try {
    const log = new SessionLog(d, new Bus());
    const a1 = log.append('100', 'group', { type: 'message_in', role: 'user', text: '一' });
    const a2 = log.append('100', 'group', { type: 'message_out', role: 'assistant', text: '二' });
    const b1 = log.append('200', 'private', { type: 'message_in', role: 'user', text: '别的会话' });

    assert.equal(a1.parentId, null, '第一条没有父');
    assert.equal(a2.parentId, a1.id, '第二条接上第一条');
    assert.equal(b1.parentId, null, '另一个会话从自己这条链的头开始');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('branch：从叶子沿 parentId 往回走，按时间正序返回', () => {
  const d = dir();
  try {
    const log = new SessionLog(d, new Bus());
    const ids = ['一', '二', '三', '四'].map((t, i) => log.append('100', 'group', { type: i % 2 ? 'message_out' : 'message_in', role: i % 2 ? 'assistant' : 'user', text: t }).id);
    const branch = log.branch('100', 'group', 3);
    assert.deepEqual(branch.map((e) => e.id), ids.slice(-3), '取最近三条，且时间正序');
    assert.equal(branch[0].id, ids[1]);
    assert.equal(branch[0].parentId, ids[0], '链的关系还在（第一条的父是被截掉的那条）');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('project：没有 compression 时就是整条分支的消息', () => {
  const d = dir();
  try {
    const log = new SessionLog(d, new Bus());
    const e1 = log.append('100', 'group', { type: 'message_in', role: 'user', text: '问题' });
    const e2 = log.append('100', 'group', { type: 'message_out', role: 'assistant', text: '回答' });
    log.append('100', 'group', { type: 'tool_call', role: 'tool', text: 'sandbox_read' });

    const p = log.project('100', 'group');
    assert.deepEqual(p.messages, [
      { role: 'user', content: '问题', ts: e1.ts },
      { role: 'assistant', content: '回答', ts: e2.ts },
    ], '工具行不进模型上下文');
    assert.equal(p.summary, undefined);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('project：有 compression 后只给摘要 + 其后的消息', () => {
  const d = dir();
  try {
    const log = new SessionLog(d, new Bus());
    log.append('100', 'group', { type: 'message_in', role: 'user', text: '很早的问题' });
    log.append('100', 'group', { type: 'message_out', role: 'assistant', text: '很早的回答' });
    log.appendCompaction('100', 'group', { summary: '## 目标\n早前聊过 X', firstKeptEntryId: null, tokensBefore: 12_345 });
    const e1 = log.append('100', 'group', { type: 'message_in', role: 'user', text: '之后的问题' });
    const e2 = log.append('100', 'group', { type: 'message_out', role: 'assistant', text: '之后的回答' });

    const p = log.project('100', 'group');
    assert.equal(p.summary, '## 目标\n早前聊过 X', '摘要要回给调用方');
    assert.deepEqual(p.messages, [
      { role: 'user', content: '之后的问题', ts: e1.ts },
      { role: 'assistant', content: '之后的回答', ts: e2.ts },
    ], '压缩之前的历史不再进上下文');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('project：firstKeptEntryId 指回某条时，从那条起保留（pi 的语义）', () => {
  const d = dir();
  try {
    const log = new SessionLog(d, new Bus());
    log.append('100', 'group', { type: 'message_in', role: 'user', text: '旧的' });
    const kept = log.append('100', 'group', { type: 'message_out', role: 'assistant', text: '要保留的' });
    log.appendCompaction('100', 'group', { summary: '摘要', firstKeptEntryId: kept.id, tokensBefore: 999 });
    log.append('100', 'group', { type: 'message_in', role: 'user', text: '新的' });

    const p = log.project('100', 'group');
    assert.deepEqual(p.messages.map((m) => m.content), ['要保留的', '新的']);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('重启后仍然尊重压缩（冷启动不会把历史又变回全文）', () => {
  const d = dir();
  try {
    const first = new SessionLog(d, new Bus());
    first.append('100', 'group', { type: 'message_in', role: 'user', text: '被压掉的问题' });
    first.append('100', 'group', { type: 'message_out', role: 'assistant', text: '被压掉的回答' });
    first.appendCompaction('100', 'group', { summary: '这次对话聊过 X', firstKeptEntryId: null, tokensBefore: 5000 });
    first.append('100', 'group', { type: 'message_in', role: 'user', text: '压缩后的问题' });

    // 换一个实例 = 重启内核
    const second = new SessionLog(d, new Bus());
    const p = second.project('100', 'group');
    assert.equal(p.summary, '这次对话聊过 X', '重建后摘要还在');
    assert.deepEqual(p.messages.map((m) => m.content), ['压缩后的问题'], '压缩前的消息不该复活');

    // 重启后新追加的条目要继续接在活链上（parentId 链不能断）
    const before = second.branch('100', 'group');
    const next = second.append('100', 'group', { type: 'message_out', role: 'assistant', text: '重启后的回答' });
    assert.equal(next.parentId, before[before.length - 1].id, '新条目接在上一条上');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
