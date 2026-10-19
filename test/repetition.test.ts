import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeAntiRepeat, detectRepetition, extractRepetitionCandidates, markRepetitionNudged,
  markRepetitionRetry, normalizeRepetitionText, repetitionHitInText, repetitionNudgeDue,
  repetitionRetryConstraint, repetitionSection, touchAntiRepeat,
  type RepetitionConfig,
} from '../src/kernel/humanlike/repetition.ts';

const CFG: RepetitionConfig = {
  enable: true,
  windowMessages: 20,
  minMessages: 3,
  cooldownMinutes: 30,
  maxPhrases: 3,
  retry: true,
  maxStrikes: 3,
};
const NOW = 1_700_000_000_000;
const self = (text: string, at = NOW) => ({ at, text });
const inbound = (text: string, at = NOW) => ({ at, text });

test('候选提取：中文 n-gram、英文词、媒体/URL/停用词过滤', () => {
  const c = extractRepetitionCandidates('[图片] 这个 梁文峰 又来了 https://x.y/z?q=1 yyds');
  assert.ok(c.includes('梁文峰'), JSON.stringify(c));
  assert.ok(c.includes('yyds'));
  assert.ok(!c.includes('这个'), '停用词不该进来');
  assert.ok(!c.includes('https'), 'URL 不该进来');
  assert.equal(normalizeRepetitionText('[图片] 梁文峰，又来了！'), '梁文峰 又来了');
});

test('检测：3 个不同轮都提「梁文峰」→ 命中，且只留最长词', () => {
  const hits = detectRepetition(
    [self('梁文峰'), self('梁文峰'), self('梁文峰')],
    [],
    CFG,
  );
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].phrase, '梁文峰');
  assert.equal(hits[0].selfMsgs, 3);
  assert.equal(hits[0].inMsgs, 0);
  assert.ok(!hits.some((h) => h.phrase === '梁文' || h.phrase === '文峰'), '不该报子串');
});

test('检测：群里也在高频提它 → 不罚（话题词不是口癖）', () => {
  const hits = detectRepetition(
    [self('梁文峰'), self('梁文峰'), self('梁文峰')],
    [inbound('梁文峰'), inbound('梁文峰'), inbound('梁文峰')],
    CFG,
  );
  assert.equal(hits.length, 0, JSON.stringify(hits));
});

test('冷却：命中后建立冷却；提醒有间隔；连续重写失败到上限就停', () => {
  const hits = detectRepetition([self('梁文峰'), self('梁文峰'), self('梁文峰')], [], CFG);
  let state = touchAntiRepeat([], hits, NOW, CFG);
  assert.equal(state.length, 1);
  assert.equal(state[0].phrase, '梁文峰');
  assert.ok(activeAntiRepeat(state, NOW).length === 1);
  assert.ok(repetitionNudgeDue(state, NOW));
  state = markRepetitionNudged(state, NOW);
  assert.equal(repetitionNudgeDue(state, NOW, 5 * 60_000), false, '刚提醒过不该再提醒');
  assert.equal(repetitionNudgeDue(state, NOW + 5 * 60_000, 5 * 60_000), true, '过了间隔可再提醒');

  for (let i = 0; i < 3; i++) state = markRepetitionRetry(state, '梁文峰', false, NOW + i, CFG);
  const entry = state.find((e) => e.phrase === '梁文峰');
  assert.equal(entry?.strikes, 3);
  assert.equal(entry?.retryExhausted, true);
  assert.equal(repetitionHitInText('梁文峰又来了', state, NOW + 10), null, '熔断后不再触发重写');

  const okState = markRepetitionRetry(state, '梁文峰', true, NOW + 20, CFG);
  assert.equal(okState.length, 0, '重写成功应解除冷却');
});

test('最终回复检查：只在生效冷却词里找，且优先最长词', () => {
  const hits = detectRepetition([self('梁文峰'), self('梁文峰'), self('梁文峰')], [], CFG);
  const state = touchAntiRepeat([], hits, NOW, CFG);
  assert.equal(repetitionHitInText('今天梁文峰又来了', state, NOW)?.phrase, '梁文峰');
  assert.equal(repetitionHitInText('今天天气不错', state, NOW), null);
});

test('文案：提醒明确说人设是背景、不要解释；重写约束带上草稿与命中词', () => {
  const hits = detectRepetition([self('梁文峰'), self('梁文峰'), self('梁文峰')], [], CFG);
  const state = touchAntiRepeat([], hits, NOW, CFG);
  const section = repetitionSection(state, 20);
  assert.ok(section?.includes('# 重复提醒'));
  assert.ok(section?.includes('梁文峰'));
  assert.ok(section?.includes('人设里的名字和设定只是背景'));
  assert.ok(section?.includes('不要解释你在避免重复'));
  const retry = repetitionRetryConstraint('梁文峰说这个可以', ['梁文峰']);
  assert.ok(retry.includes('梁文峰说这个可以'));
  assert.ok(retry.includes('去掉这些词'));
  assert.ok(retry.includes('只输出重写后的正文'));
});
