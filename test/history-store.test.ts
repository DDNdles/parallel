import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bus } from '../src/kernel/bus.ts';
import { HistoryStore } from '../src/kernel/agentloop.ts';
import { SessionLog } from '../src/kernel/sessionlog.ts';
import { DEFAULT_CONFIG, freshDefaultConfig } from '../src/kernel/config.ts';
import { windowAnchorTs } from '../src/kernel/pipeline.ts';
import type { ChatRef, MessageAttachment } from '../src/kernel/types.ts';

/**
 * HistoryStore 与冷启动重建。
 *
 * 内存路径与磁盘路径各验一面：
 *  - 内存：pushUser/pushAssistant 落 ts、第三参附件进快照、snapshot(chat, sinceTs) 按窗口筛、
 *    没有 ts 的条目保守保留、trim 的条数裁剪照旧；
 *  - 磁盘：直接写一份 jsonl 夹具再冷启动 get()，验 ts 与附件（顶层 files + 记录节点 files）能重建回来——
 *    重启后时间窗过滤与窗口内媒体重放全靠这一层，丢了等于重启即失忆。
 *
 * 上下文 = 时间窗（storage.contextMinutes）与条数上限（storage.historyLimit）同时生效。
 */

const GROUP: ChatRef = { platform: 'qq', type: 'group', chatId: '9001' };
const OTHER: ChatRef = { platform: 'qq', type: 'private', chatId: '8001' };

const tmp = () => mkdtempSync(join(tmpdir(), 'parallel-ctxwin-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 造一份会话日志 jsonl 夹具（同一会话串成链式 parentId，最后一行即活动叶子）。
 * 键值为 undefined 时 JSON.stringify 会把键整条丢掉——"本次改动前落盘、没有 ts 的老行"就这样造。
 */
function writeLog(root: string, chat: ChatRef, rows: Record<string, unknown>[]): void {
  const sessions = join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  let parentId: string | null = null;
  const lines = rows.map((r, i) => {
    const id = `s_fix_${i + 1}`;
    const line = { id, parentId, ts: undefined as number | undefined, chatId: chat.chatId, chatType: chat.type, seq: i + 1, ...r };
    parentId = id;
    return JSON.stringify(line);
  });
  writeFileSync(join(sessions, `${chat.type}_${chat.chatId}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

/** 落一份假沙箱收件文件（sandboxPath 得指向真存在的文件，否则"读得出来"这条无从谈起） */
function saveInbox(root: string, name: string, body: string): string {
  const inbox = join(root, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const p = join(inbox, name);
  writeFileSync(p, body);
  return p;
}

// ---------------- 内存路径：ts / 附件 / 窗口 / 裁剪 ----------------

test('HistoryStore：pushUser / pushAssistant 带 ts，snapshot(chat, sinceTs) 按窗口筛（含边界）', async () => {
  const d = tmp();
  try {
    const store = new HistoryStore(new SessionLog(d, new Bus()), 50);
    store.pushUser(GROUP, '第一句');
    await sleep(5);
    store.pushAssistant(GROUP, '第一句的回答');
    await sleep(5);
    store.pushUser(GROUP, '第二句');

    const all = store.snapshot(GROUP);
    assert.deepEqual(all.map((m) => m.content), ['第一句', '第一句的回答', '第二句']);
    const [t1, t2, t3] = all.map((m) => m.ts);
    for (const t of [t1, t2, t3]) assert.equal(typeof t, 'number', '每条都要带 ts');
    assert.ok(t1! < t2! && t2! < t3!, `ts 要单调递增，实际 ${t1}/${t2}/${t3}`);

    // 窗口起点落在中间那条上：`>=` 语义（含边界），只有它和它之后的留下
    assert.deepEqual(store.snapshot(GROUP, t2).map((m) => m.content), ['第一句的回答', '第二句']);
    assert.deepEqual(store.snapshot(GROUP, t3).map((m) => m.content), ['第二句']);
    assert.deepEqual(store.snapshot(GROUP, t3! + 1), [], '起点晚于全部条目 → 空');
    assert.equal(store.snapshot(GROUP).length, 3, '不给 sinceTs 就是全量');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('HistoryStore：pushUser 第三参附件进快照，没带媒体的消息不落 attachments 键', () => {
  const d = tmp();
  try {
    const store = new HistoryStore(new SessionLog(d, new Bus()), 50);
    const atts: MessageAttachment[] = [
      { kind: 'image', path: join(d, 'pic.png'), name: 'pic.png', mime: 'image/png' },
    ];
    store.pushUser(GROUP, '看这张图', atts);
    store.pushAssistant(GROUP, '看到了');
    store.pushUser(GROUP, '纯文本', []);

    const msgs = store.snapshot(GROUP);
    assert.deepEqual(msgs[0].attachments, atts, '附件原样进快照（窗口内媒体重放靠它）');
    assert.equal('attachments' in msgs[1], false, '没有媒体的消息不落这个键');
    assert.equal('attachments' in msgs[2], false, '空数组与不传同义');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('HistoryStore：trim 条数裁剪仍生效，裁完不以 assistant 开头', () => {
  const d = tmp();
  try {
    const store = new HistoryStore(new SessionLog(d, new Bus()), 3);
    store.pushUser(GROUP, 'u1');
    store.pushAssistant(GROUP, 'a1');
    store.pushUser(GROUP, 'u2');
    store.pushAssistant(GROUP, 'a2');
    assert.deepEqual(store.snapshot(GROUP).map((m) => m.content), ['u2', 'a2'], '超限裁到上限内，并把开头的 assistant 丢掉');
    store.pushUser(GROUP, 'u3');
    assert.deepEqual(store.snapshot(GROUP).map((m) => m.content), ['u2', 'a2', 'u3']);
    assert.deepEqual(store.snapshot(OTHER), [], '环是按 chatKey 分的，别的会话不受影响');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---------------- 磁盘路径：冷启动重建 ----------------

test('冷启动重建：ts 跟着回来；没有 ts 的老条目在窗口过滤下保守保留', () => {
  const d = tmp();
  try {
    const T = 1_700_000_000_000;
    writeLog(d, GROUP, [
      { ts: T, type: 'message_in', role: 'user', nickname: '群友', text: '很久以前的问题' },
      { ts: T + 1000, type: 'message_out', role: 'assistant', text: '很久以前的回答' },
      // 本次改动之前落盘的行：没有 ts 这个键
      { type: 'message_in', role: 'user', nickname: '群友', text: '没有时间戳的老条目' },
    ]);

    const store = new HistoryStore(new SessionLog(d, new Bus()), 50);
    const msgs = store.get(GROUP);
    // 群聊历史带昵称前缀（2026-10-16 起：模型在群里看到「谁说的」全靠这个）
    assert.deepEqual(msgs.map((m) => m.content), ['群友：很久以前的问题', '很久以前的回答', '群友：没有时间戳的老条目']);
    assert.equal(msgs[0].ts, T, '落账时的 ts 要原样重建');
    assert.equal(msgs[1].ts, T + 1000);
    assert.equal(msgs[2].ts, undefined, '老行本来就没有 ts，不做假时间');

    // 窗口起点比那两条带 ts 的晚得多：它们被筛掉，没有 ts 的那条留下
    assert.deepEqual(store.snapshot(GROUP, T + 999_999).map((m) => m.content), ['群友：没有时间戳的老条目']);
    assert.equal(store.snapshot(GROUP).length, 3, '不给窗口就是全量');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('冷启动重建：顶层 files 与记录节点 files 归位成 attachments，message_out 不带附件', () => {
  const d = tmp();
  try {
    const pic = saveInbox(d, 'a.png', 'fake-png-bytes');
    const voice = saveInbox(d, 'v.amr', 'fake-amr');
    const clip = saveInbox(d, 'clip.mp4', 'fake-mp4');
    const T1 = 1_700_000_100_000;
    const T2 = T1 + 1000;
    const T3 = T2 + 1000;

    writeLog(d, GROUP, [
      {
        ts: T1, type: 'message_in', role: 'user', userId: '2', nickname: '群友', text: '看这张图 [图片]',
        data: {
          messageId: 'm1',
          files: [
            // url 存心给个不着调的：真 url 带 rkey、几小时就过期，不该躺在日志里
            { name: 'a.png', rel: 'inbox/a.png', sandboxPath: pic, size: 14, url: 'not-a-real-url' },
            // 本次改动前落盘的顶层文件：sandboxPath 没存，读不出任何东西 → 不产出附件
            { name: 'old.png', rel: 'inbox/old.png', size: 5 },
          ],
        },
      },
      {
        ts: T2, type: 'message_in', role: 'user', userId: '2', nickname: '群友', text: '这是聊天记录 [聊天记录]',
        data: {
          messageId: 'm2',
          forward: {
            id: 'res-1', title: '群聊的聊天记录', dropped: 0, failed: false,
            nodes: [
              {
                nickname: '小明', userId: '3', text: '第一条是语音', ts: T2,
                files: [
                  { name: 'v.amr', rel: 'inbox/v.amr', sandboxPath: voice, size: 8 },
                  { name: 'no-carrier.jpg', rel: 'inbox/no-carrier.jpg', size: 3 },
                ],
              },
              { nickname: '小红', userId: '4', text: '第二条是视频', ts: T2, files: [{ name: 'clip.mp4', rel: 'inbox/clip.mp4', sandboxPath: clip, size: 8 }] },
            ],
          },
        },
      },
      { ts: T3, type: 'message_out', role: 'assistant', text: '收到' },
    ]);

    const store = new HistoryStore(new SessionLog(d, new Bus()), 50);
    const msgs = store.get(GROUP);
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs.map((m) => [m.role, m.ts]), [['user', T1], ['user', T2], ['assistant', T3]]);

    // ① 顶层文件：只收有载体的那条，kind/name/mime 按扩展名归位，path 指回沙箱里那份
    const top = msgs[0].attachments ?? [];
    assert.equal(top.length, 1, '没有载体的老文件不产出附件（不留空占位）');
    assert.equal(top[0].kind, 'image');
    assert.equal(top[0].name, 'a.png');
    assert.equal(top[0].mime, 'image/png');
    assert.equal(top[0].path, pic);
    assert.equal(top[0].url, undefined, '不着调的 url 不当下载地址带上');
    assert.equal(readFileSync(top[0].path!, 'utf-8'), 'fake-png-bytes', 'path 指的是沙箱里真那份文件');

    // ② 记录节点文件：按 节点顺序 + 节点内顺序 跟在顶层之后，声音/视频按扩展名分 kind
    const fwd = msgs[1].attachments ?? [];
    assert.deepEqual(fwd.map((a) => [a.kind, a.name, a.mime]), [
      ['audio', 'v.amr', 'audio/amr'],
      ['video', 'clip.mp4', 'video/mp4'],
    ]);
    assert.equal(fwd[0].path, voice);
    assert.equal(fwd[1].path, clip);

    // 正文是给模型现净化过的：占位换成真记录，条数与节点正文都在
    assert.ok(msgs[1].content.includes('【聊天记录·群聊的聊天记录·共 2 条】'), `实际正文：${msgs[1].content}`);
    assert.ok(msgs[1].content.includes('小明：第一条是语音'));
    assert.equal(msgs[1].content.includes('[聊天记录]'), false, '占位不该留在给模型的正文里');

    // ③ 出站消息本来就没有媒体
    assert.equal('attachments' in msgs[2], false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('冷启动重建：压缩摘要（无 ts）不被时间窗筛掉', () => {
  const d = tmp();
  try {
    const T = 1_700_000_200_000;
    writeLog(d, GROUP, [
      { ts: T - 60_000, type: 'message_in', role: 'user', text: '被压掉的问题' },
      { ts: T - 59_000, type: 'message_out', role: 'assistant', text: '被压掉的回答' },
      {
        ts: T - 58_000, type: 'compaction', role: 'system', summary: '## 目标\n聊过 X',
        firstKeptEntryId: null, tokensBefore: 5000, text: '上下文已压缩（原 ~5k tokens）',
      },
      { ts: T, type: 'message_in', role: 'user', text: '压缩后的问题' },
    ]);

    const store = new HistoryStore(new SessionLog(d, new Bus()), 50);
    const msgs = store.get(GROUP);
    assert.deepEqual(msgs.map((m) => m.content.includes('聊过 X')), [true, false], '摘要接在压缩后的消息之前');
    assert.equal(msgs[0].ts, undefined, '摘要本身没有 ts');

    // 窗口收紧到压缩后那一秒之后：带 ts 的被筛掉，摘要（无 ts）按保守语义留下
    const win = store.snapshot(GROUP, T + 1);
    assert.equal(win.length, 1);
    assert.ok(win[0].content.includes('聊过 X'));
    assert.equal(win[0].ts, undefined);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---------------- 默认值 ----------------

test('默认值：storage.contextMinutes 为 10（范围 1~720，白名单在 api/server.ts）', () => {
  assert.equal(DEFAULT_CONFIG.storage.contextMinutes, 10);
  // 设置页回填用的是深拷贝，键不能在这一步丢
  const cfg = freshDefaultConfig() as unknown as { storage: { contextMinutes?: number } };
  assert.equal(cfg.storage.contextMinutes, 10);
});

// ---------------- 梳理点对齐（2026-10-16 裁定②）----------------

test('梳理点对齐：窗口起点只在整格边界上动，两次梳理之间只增不减', () => {
  const span = 10 * 60_000;
  const base = Math.floor(1_700_000_000_000 / span) * span;   // 对齐网格边界
  // 同一格内的两次 turn 锚点相同（消息数组因此 append-only，前缀缓存吃得动）
  const withinCell = base + 1_000;
  const laterInCell = base + span - 1_000;
  assert.equal(windowAnchorTs(withinCell, 10), windowAnchorTs(laterInCell, 10));
  // 锚点 ≤ now - N 分钟，且最多差一格
  const a = windowAnchorTs(withinCell, 10);
  assert.ok(a <= withinCell - span && withinCell - span - a < span, `anchor=${a} now-span=${withinCell - span}`);
  // 跨格那一刻整段跳到下一格
  const acrossCell = base + span + 1_000;
  assert.equal(windowAnchorTs(acrossCell, 10), windowAnchorTs(withinCell, 10) + span);
  // 覆盖范围确实落在 N~2N 分钟之间
  const coverage = acrossCell - windowAnchorTs(acrossCell, 10);
  assert.ok(coverage > span && coverage <= 2 * span, `coverage=${coverage / 60_000}min`);
});
