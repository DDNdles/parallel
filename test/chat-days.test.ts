import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../src/kernel/kernel.ts';
import { startApiServer } from '../src/kernel/api/server.ts';
import { localDay } from '../src/kernel/sessionlog.ts';

/**
 * 会话左侧日轨的后端：days() 按本地日期聚合"能看见的消息"，dayEntries() 取某一天的全部。
 * 两者扫的都是整份 jsonl，所以窗口之外（tail 的 300 条内存缓冲以外）的日子也数得出来。
 */
const ANY = (x: unknown) => x as Record<string, any>;

/** 造一份跨几天的会话日志（append 用的是 nowMs，测日期得直接把条目写盘；dir 就是 sessions 目录） */
function seed(dir: string, chatKey: string, rows: { ts: number; type: string; text: string }[]) {
  writeFileSync(join(dir, chatKey + '.jsonl'), rows.map((r, i) => JSON.stringify({
    id: `s_${i}`, ts: r.ts, chatId: chatKey.split('_')[1], chatType: chatKey.split('_')[0],
    type: r.type, role: r.type === 'message_in' ? 'user' : 'assistant', text: r.text, seq: i + 1, parentId: null,
  })).join('\n') + '\n');
}
const at = (d: number, h: number) => new Date(2026, 9, d, h, 5).getTime();   // 2026-10-d

test('days()/dayEntries()：按本地日期切天，只数会话流里真显示的行', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-days-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  ANY(kernel.config.config.onebot).port = 30000 + (process.pid % 20000);
  await kernel.boot();
  try {
    seed(kernel.sessionLog.dir, 'group_777', [
      { ts: at(3, 8), type: 'message_in', text: '早' },
      { ts: at(3, 9), type: 'message_out', text: '早呀' },
      { ts: at(4, 23), type: 'message_in', text: '跨零点了' },
      { ts: at(4, 23), type: 'llm_call', text: '不算' },
      { ts: at(4, 23), type: 'gate', text: '不算' },
      { ts: at(6, 1), type: 'message_out', text: '两天后' },
    ]);
    const days = kernel.sessionLog.days('777', 'group');
    assert.deepEqual(days.map((d) => d.day), ['2026-10-03', '2026-10-04', '2026-10-06']);
    assert.deepEqual(days.map((d) => d.count), [2, 1, 1], '工具/系统行不进日轨');
    assert.equal(days[0].firstTs, at(3, 8));
    assert.equal(days[0].lastTs, at(3, 9));
    assert.deepEqual(kernel.sessionLog.dayEntries('777', 'group', '2026-10-03').map((e) => e.text), ['早', '早呀']);
    assert.deepEqual(kernel.sessionLog.dayEntries('777', 'group', '2026-10-04').map((e) => e.text), ['跨零点了']);
    assert.deepEqual(kernel.sessionLog.dayEntries('777', 'group', '2026-10-05'), [], '没消息的那天不该凭空冒出来');
    // 本地日期键与 Date 的本地时区一致（跨零点那条归它自己那天，不是 UTC 的前一天）
    assert.equal(localDay(at(4, 23)), '2026-10-04');
    assert.deepEqual(kernel.sessionLog.days('没这个会话', 'group'), []);
  } finally {
    await kernel.shutdown();
  }
});

test('API：GET /api/chats/<key>/days 与 /day?day=（坏参数 400）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-days-api-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  ANY(kernel.config.config.onebot).port = 30000 + (process.pid % 20000);
  kernel.config.config.ui.port = 43000 + (process.pid % 5000);
  await kernel.boot();
  const server = await startApiServer(kernel);
  const base = `http://127.0.0.1:${kernel.config.config.ui.port}`;
  const tk = `token=${kernel.config.secrets.uiToken}`;
  try {
    seed(kernel.sessionLog.dir, 'private_888', [
      { ts: at(1, 10), type: 'message_in', text: '一' },
      { ts: at(2, 10), type: 'message_out', text: '二' },
    ]);
    const g = async (p: string) => ({ status: 200, body: ANY(await (await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}${tk}`)).json()) });
    const d = await g('/api/chats/private_888/days');
    assert.deepEqual(d.body.days.map((x: { day: string }) => x.day), ['2026-10-01', '2026-10-02']);
    const one = await g('/api/chats/private_888/day?day=2026-10-02');
    assert.equal(one.body.day, '2026-10-02');
    assert.deepEqual(one.body.entries.map((e: { text: string }) => e.text), ['二']);
    const bad = await fetch(`${base}/api/chats/private_888/day?day=昨天&${tk}`);
    assert.equal(bad.status, 400, '日期格式不合法就拒，不去拼路径');
    const weird = await fetch(`${base}/api/chats/private_888/day?day=${encodeURIComponent('../../etc/passwd')}&${tk}`);
    assert.equal(weird.status, 400, '路径穿越类的 date 一律 400');
  } finally {
    server.close();
    await kernel.shutdown();
  }
});
