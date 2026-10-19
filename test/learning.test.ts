import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EXPRESSION_SYSTEM, buildExpressionPrompt, expressionDue, expressionSection,
  mergeExpressions, parseExpressions, selectExpressions,
  type ExpressionEntry, type ExpressionMessage,
} from '../src/plugins/chat/expression.ts';
import {
  PROFILE_SYSTEM, MIDTERM_SYSTEM, buildProfilePrompt, buildMidtermPrompt,
  midtermSection, parseMidterm, parseProfile, profileSection,
  type MidtermEntry,
} from '../src/plugins/chat/notes.ts';

const msg = (text: string, ts = 1000): ExpressionMessage => ({ ts, userId: 'u1', nickname: '小明', text });

test('表达学习：提示词带自认标记，解析只留像样的情境/说法', () => {
  assert.match(EXPRESSION_SYSTEM, /表达方式整理助手/);
  const out = parseExpressions(JSON.stringify({
    expressions: [
      { situation: '有人问在吗', style: '在的在的', keys: ['在吗'] },
      { situation: '有人问在吗', style: '在的在的', keys: ['重复'] },
      { situation: '大家笑了', style: '哈哈哈' },
      { situation: '', style: '没情境' },
      { situation: '有人吐槽加班', style: '班味太重了', keys: ['加班', '班味'] },
    ],
  }), [], 10, 123);
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.equal(out[0].style, '在的在的');
  assert.deepEqual(out[0].keys, ['在吗']);
  assert.equal(out[1].style, '班味太重了');
  assert.equal(out[1].at, 123);
});

test('表达学习：模型输出不听话时从 JSON 块里剥，空/NONE 不落', () => {
  const out = parseExpressions('结论如下：\n{"expressions":[{"situation":"有人迟到","style":"又迟到了是吧","keys":[]}]}\n以上', [], 10, 1);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].keys, ['有人迟到', '又迟到了是吧']);
  assert.deepEqual(parseExpressions('{"expressions":[]}', [], 10, 1), []);
  assert.deepEqual(parseExpressions('NONE', [], 10, 1), []);
});

test('表达学习：合并按说法去重、只留最近的 maxPerChat 条', () => {
  const a: ExpressionEntry = { situation: 'a', style: '说法一', keys: ['a'], at: 1 };
  const b: ExpressionEntry = { situation: 'b', style: '说法二', keys: ['b'], at: 2 };
  const c: ExpressionEntry = { situation: 'c', style: '说法一', keys: ['c'], at: 3 };
  const merged = mergeExpressions([a, b], [c], 2);
  assert.deepEqual(merged.map((e) => e.style), ['说法二', '说法一']);
  assert.equal(merged[1].keys[0], 'c', '同说法保新的');
});

test('表达学习：到期判定 = 攒够条数 + 群已静默', () => {
  const cfg = { enable: true, minMessages: 3, idleSeconds: 10, maxPerChat: 24, injectMax: 4 };
  const list = [msg('a', 1000), msg('b', 2000), msg('c', 3000)];
  assert.equal(expressionDue(list, cfg, 5000), false, '还没静默够');
  assert.equal(expressionDue(list, cfg, 13_000), true);
  assert.equal(expressionDue(list.slice(0, 2), cfg, 13_000), false, '条数不够');
  assert.equal(expressionDue(list, { ...cfg, enable: false }, 13_000), false, '开关关掉');
});

test('表达学习：注入按关键词命中优先，没命中也会给最近的几条当参考', () => {
  const entries: ExpressionEntry[] = [
    { situation: '有人问在吗', style: '在的在的', keys: ['在吗'], at: 1 },
    { situation: '有人吐槽加班', style: '班味太重了', keys: ['加班', '班味'], at: 2 },
    { situation: '有人夸好吃', style: '绝绝子', keys: ['好吃'], at: 3 },
  ];
  assert.deepEqual(selectExpressions(entries, '今天加班到十点', 2, () => 0.5).map((e) => e.style), ['班味太重了', '绝绝子']);
  const fallback = selectExpressions(entries, '完全无关的话题', 2, () => 0.5);
  assert.equal(fallback.length, 2, '没命中也要给参考');
  assert.ok(expressionSection(fallback)?.includes('# 本群的说法（参考）'));
});

test('用户画像：提示词带自认标记，输出清洗与 NONE', () => {
  assert.match(PROFILE_SYSTEM, /用户画像整理助手/);
  assert.equal(parseProfile('画像： 小明是个直爽的人，喜欢打游戏。 '), '小明是个直爽的人，喜欢打游戏。');
  assert.equal(parseProfile('NONE'), null);
  assert.equal(parseProfile(''), null);
  assert.ok(buildProfilePrompt(['喜欢打游戏', '常加班'], '旧画像').includes('上一版画像'));
  assert.ok(profileSection('小明是个直爽的人')?.includes('你对对方的印象'));
});

test('中期回想：提示词带自认标记，JSON/纯文本都能解析，分节说明是背景', () => {
  assert.match(MIDTERM_SYSTEM, /聊天回想整理助手/);
  assert.deepEqual(parseMidterm('{"summary":"大家在聊新游戏","cues":["新游戏","周末"]}'), { summary: '大家在聊新游戏', cues: ['新游戏', '周末'] });
  assert.deepEqual(parseMidterm('没有 JSON，整段就是摘要'), { summary: '没有 JSON，整段就是摘要', cues: [] });
  assert.equal(parseMidterm('{"summary":""}'), null);
  assert.equal(parseMidterm('NONE'), null);

  const prev: MidtermEntry = { summary: '更早聊过考试', cues: ['考试'], fromTs: 1, toTs: 2, updatedAt: 3 };
  const prompt = buildMidtermPrompt([{ ts: 4, role: 'user', who: '小明', text: '周末开黑吗' }], prev);
  assert.ok(prompt.includes('更早之前的回想') && prompt.includes('小明：周末开黑吗'));
  const section = midtermSection({ summary: '大家在聊新游戏', cues: ['新游戏'], fromTs: 1, toTs: 2, updatedAt: 3 });
  assert.ok(section?.includes('# 更早的聊天（背景回想）') && section?.includes('别主动提'));
});
