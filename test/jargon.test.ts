import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../src/kernel/db.ts';
import {
  JargonService, JARGON_LADDER,
  extractCandidates, buildJargonPrompt, parseJargonReply,
} from '../src/kernel/humanlike/jargon.ts';
import type { ChatEvent } from '../src/kernel/types.ts';

/**
 * 圈内黑话（表达学习）：频次阶梯 [4,8,25,100] 触发反事实判定，判定为圈内含意时
 * 只进 prompt 的「圈内黑话」参考节（帮听懂，不改说话风格、不产数值）。
 * MaiBot 出处 jargon_miner.py 的 is_jargon = not is_similar 口径在这里合成一次调用复刻。
 */

function groupEvent(text: string): ChatEvent {
  return {
    platform: 'qq', type: 'group', chatId: '910', userId: 'u1', nickname: '小明',
    text, segments: [], files: [], isAtMe: false, isReplyToMe: false, raw: {}, ts: Date.now(),
  } as ChatEvent;
}

interface Harness { j: JargonService; db: Db; seen: { term: string; contexts: string[] }[]; dir: string; tryRm: () => void }
function makeService(
  infer: (p: { term: string; contexts: string[] }) => Promise<{ jargon: boolean; meaning: string } | null> = async () => null,
  opt: { stepMs?: number } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-jargon-'));
  const db = new Db(dir);
  const seen: { term: string; contexts: string[] }[] = [];
  let t = 1_700_000_000_000;
  const j = new JargonService({
    db,
    config: () => ({ enable: true }),
    infer: async (p) => { seen.push({ term: p.term, contexts: p.contexts }); return infer(p); },
    now: () => { t += opt.stepMs ?? 70_000; return t; },
  });
  try {
    return { j, db, seen, dir, tryRm: () => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
  } finally { /* 返回后再清 */ }
}

test('候选提取：只收带字母的词，链接/占位符/虚词不收', () => {
  assert.deepEqual(extractCandidates('[$图片] 逛 gym 呀 https://x.y/z?qq=1'), ['gym']);
  assert.deepEqual(extractCandidates('这波必须 yyds！nsdd~ 懂的都懂'), ['yyds', 'nsdd']);
  assert.deepEqual(extractCandidates('纯中文没有外文词'), []);
});

test('反事实判定两段式提示词按口径拼装、行结果能剥出来', () => {
  const p = buildJargonPrompt({ term: 'yyds', count: 4, contexts: ['这局 yyds', 'yyds 了兄弟们'] });
  assert.ok(p.includes('词：yyds') && p.includes('第 1 步（不看语境）') && p.includes('- 例1：这局 yyds'));
  assert.deepEqual(parseJargonReply('好的，结论如下 {"jargon": true, "meaning": "永远的神"} 注意'), { jargon: true, meaning: '永远的神' });
  assert.deepEqual(parseJargonReply('读不出分歧这条不是 {"jargon": false, "meaning": ""}'), { jargon: false, meaning: '' });
  assert.equal(parseJargonReply('没有结构化结论'), null);
});

test('频次阶梯：第 4 次才触发一次判定，判定结果落库并进参考节', async () => {
  const h = makeService(async (p) => {
    if (p.term === 'yyds') return { jargon: true, meaning: '永远的神' };
    return { jargon: false, meaning: '' };
  });
  try {
    assert.equal(h.j.sections({ platform: 'qq', type: 'group', chatId: '910' }), null, '词没学会前不发节');
    for (let i = 0; i < 3; i++) h.j.observe(groupEvent(`说真的 yyds`));
    assert.equal(h.seen.length, 0, '没过阶梯不问');
    h.j.observe(groupEvent('这波 yyds'));
    await waitUntil(() => h.seen.length >= 1, 200);
    await settle(); h.j.flush();
    const row = h.db.get<{ count: number; rung: number; meaning: string }>('SELECT count, rung, meaning FROM jargon WHERE term = ?', 'yyds');
    assert.ok(row, '词条落库');
    assert.equal(row?.count, JARGON_LADDER[0]);
    assert.ok((row?.rung ?? 0) >= 1, '已跨过第一档');
    assert.equal(row?.meaning, '永远的神');
    const section = h.j.sections({ platform: 'qq', type: 'group', chatId: '910' });
    assert.ok(section?.includes('- yyds：永远的神'), section ?? '空');
  } finally {
    h.j.dispose();
    h.tryRm();
  }
});

test('不是黑话：判定为否后这档不再重问，词不进参考节', async () => {
  const h = makeService(async () => ({ jargon: false, meaning: '' }));
  try {
    for (let i = 0; i < 8; i++) h.j.observe(groupEvent('来点 gym'));
    await waitUntil(() => h.seen.length >= 1, 200);
    // now 步长 70s：第 4 个就问过一次；run 后已进位，8 次内不再问第二回
    assert.equal(h.seen.length, 1, JSON.stringify(h.seen));
    const section = h.j.sections({ platform: 'qq', type: 'group', chatId: '910' });
    assert.equal(section, null, '普通词不进节');
  } finally {
    h.j.dispose();
    h.tryRm();
  }
});

test('守门：enable=false 不挖；重启后同一 db 底数接得上', async () => {
  const h = makeService(async () => ({ jargon: true, meaning: '永远的神' }));
  try {
    for (let i = 0; i < 4; i++) h.j.observe(groupEvent('yyds 真的 yyds'));
    await waitUntil(() => h.seen.length >= 1, 200);
    await settle();
    h.j.flush();

    const db = h.db; // 同一个库给第二个实例（模拟重启后）
    let t2 = 1_700_000_000_000;
    const j2 = new JargonService({ db, config: () => ({ enable: true }), infer: async () => null, now: () => { t2 += 70_000; return t2; } });
    // 接底数：老 count 已 ≥4，再来一条就跨到下一档？不——rung 已进位，只到 8 才再问，
    // 这里验证的是 counts 读回来了（sections 里的词条还在）
    assert.ok(j2.sections({ platform: 'qq', type: 'group', chatId: '910' })?.includes('yyds：永远的神'));
    j2.dispose();

    // enable=false 的实例完全不挖
    let t3 = 1_700_000_000_000;
    const seen3: string[] = [];
    const j3 = new JargonService({
      db, config: () => ({ enable: false }),
      infer: async (p) => { seen3.push(p.term); return null; },
      now: () => { t3 += 70_000; return t3; },
    });
    for (let i = 0; i < 6; i++) j3.observe(groupEvent('yyds yyds yyds'));
    await waitUntil(() => seen3.length >= 1, 150);
    assert.equal(seen3.length, 0, '关了就不问');
    j3.dispose();
  } finally {
    h.j.dispose();
    h.tryRm();
  }
});

const settle = () => new Promise((r) => setTimeout(r, 20));

const waitUntil = async (cond: () => unknown, ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};
