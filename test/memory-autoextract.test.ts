import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EXTRACT_SYSTEM, MAX_FAILS, QUEUE_MAX_TURNS, buildExtractPrompt, claimTurns, dueGroups,
  parseFacts, pushTurn, settle, type ExtractCfg, type ExtractQueue,
} from '../src/plugins/chat/memory-extract.ts';

const CFG: ExtractCfg = { autoSave: true, minTurns: 3, idleSeconds: 60, maxFacts: 5 };
const T = (n: number) => ({ ts: 1_000_000 + n * 1000, user: `用户说 ${n}`, reply: `我回 ${n}` });
const mkq = (turns: ReturnType<typeof T>[], over: Partial<ExtractQueue[string]> = {}): ExtractQueue =>
  ({ '1001|g1': { userId: '1001', chatId: 'g1', turns, fails: 0, ...over } });

test('排队：按「用户+会话」分组成一条队列', () => {
  const q: ExtractQueue = {};
  pushTurn(q, '1001', 'g1', T(1));
  pushTurn(q, '1001', 'g1', T(2));
  pushTurn(q, '1001', 'g2', T(3));
  pushTurn(q, '2002', 'g1', T(4));
  assert.deepEqual(Object.keys(q), ['1001|g1', '1001|g2', '2002|g1']);
  assert.equal(q['1001|g1'].turns.length, 2);
});

test('排队：一组超过上限就丢最旧的，不让坏输入把 KV 撑爆', () => {
  const q: ExtractQueue = {};
  for (let i = 0; i < QUEUE_MAX_TURNS + 20; i++) pushTurn(q, '1001', 'g1', T(i));
  const g = q['1001|g1'];
  assert.equal(g.turns.length, QUEUE_MAX_TURNS);
  assert.equal(g.turns[0].user, `用户说 ${20}`, '被丢的是最前面的 20 轮');
});

test('到期判定：轮数够 + 静默够才动手，正在跑的那组跳过', () => {
  const turns = [T(1), T(2), T(3)];
  const last = turns[turns.length - 1].ts;
  assert.deepEqual(dueGroups(mkq(turns.slice(0, 2)), last, CFG), [], '轮数不够');
  assert.deepEqual(dueGroups(mkq(turns), last + 59_000, CFG), [], '静默不够');
  assert.equal(dueGroups(mkq(turns), last + 60_000, CFG).length, 1, '刚好到点');
  assert.deepEqual(dueGroups(mkq(turns, { running: true }), last + 600_000, CFG), [], '在跑的不能被重复领走');
});

test('结算：成功就把这批轮丢掉，失败累计到上限后整组丢弃', () => {
  const q = mkq([T(1), T(2), T(3)]);
  const g = q['1001|g1'];
  assert.equal(claimTurns(q, g).length, 3);
  assert.equal(q['1001|g1'].running, true);
  settle(q, g, true);
  assert.equal(q['1001|g1'], undefined, '清空了就把组删掉');

  const q2 = mkq([T(1), T(2), T(3)]);
  const g2 = q2['1001|g1'];
  for (let i = 0; i < MAX_FAILS; i++) {
    claimTurns(q2, g2);
    settle(q2, g2, false);
  }
  assert.equal(q2['1001|g1'], undefined, `连败 ${MAX_FAILS} 次后丢弃这组`);
});

test('解析：剥列表符号与引号、丢 NONE、与已有记忆和批内互去重、限量限长', () => {
  const out = parseFacts(
    [
      '- 喜欢的乐队是万人谜',
      '* 喜欢的乐队是万人谜',            // 批内重复
      '1. 约定每周五复盘',
      '“住在杭州”',                      // 引号
      'NONE',
      '',
      '   ',
      '  2、 爱吃香菜 ',
      '喜欢的乐队是万人谜！',            // 归一化后与已有记忆同条（标点不算差异）
      '这条'.repeat(60),                 // 超长
    ].join('\n'),
    ['喜欢的乐队是万人谜'],
    5,
  );
  assert.deepEqual(out, ['约定每周五复盘', '住在杭州', '爱吃香菜', '这条'.repeat(40)]);
  assert.equal(out[3].length, 80, '截到 80 字');
  assert.equal(parseFacts('NONE', [], 5).length, 0);
  assert.equal(parseFacts('', [], 5).length, 0);
  assert.deepEqual(parseFacts('- 一\n- 二\n- 三', [], 2), ['一', '二'], '限量');
});

test('提示词：把已有记忆与轮数都交给模型，并带上 mock 认路的那句标记', () => {
  assert.match(EXTRACT_SYSTEM, /^你是记忆整理助手。/);
  const p = buildExtractPrompt([T(1), T(2)], ['喜欢的乐队是万人谜'], 3);
  assert.match(p, /已经记住的：\n- 喜欢的乐队是万人谜/);
  assert.match(p, /共 2 轮/);
  assert.match(p, /用户：用户说 1\n我：我回 1/);
  assert.match(p, /最多输出 3 行/);
  assert.match(buildExtractPrompt([T(1)], [], 3), /已经记住的：（无）/);
});
