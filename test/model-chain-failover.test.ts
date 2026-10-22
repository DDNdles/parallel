import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bus, busEvents } from '../src/kernel/bus.ts';
import { ConfigStore } from '../src/kernel/config.ts';
import { Db } from '../src/kernel/db.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';
import { LlmService, isHardUnavailable, isProviderWideFailure } from '../src/kernel/services/llm.ts';
import type { LLMChatRequest } from '../src/kernel/types.ts';

/**
 * 模型优先级链与掉线降级（本地假服务器，不打真实 API）：
 * ① 链按顺序取，当前这条失败后在同一次调用里顺延到下一条；
 * ② 硬不可用（连不上/鉴权失败/模型不存在）立刻挪位置并冷却，后续调用不再先白试一遍；
 *    软故障（500/429/过载）只有连续失败满 llm.failoverThreshold 次才挪；
 * ③ 整条链都失败才记 error；中途有人接上只留一条 warn（不再吓用户一跳）；
 * ④ 已经往外吐过字 / 用户主动打断时不换模型（换了只会重复输出或违背中断）；
 * ⑤ 配置级不可用（未启用 / 缺 key）与请求失败同等对待，一样降级；
 * ⑥ work 链独立：空 = 没有可用模型（不跟随 chat 链）。
 */

let server: Server;
/** 接受连接后立刻掐断：模拟"端口在、但对端根本不理你"的 transport 故障 */
let deadServer: NetServer;
let deadUrl = '';
let baseUrl = '';
let dataDir = '';
let bus: Bus;
let config: ConfigStore;
let errors: ErrorCenter;
let llm: LlmService;

const hits: string[] = [];
const bodies: any[] = [];
const CHAT_SSE = [
  'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];

/** bad 总是 500，flaky 先吐一个字再断流（算已流式），good 正常回 SSE */
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'parallel-chain-'));
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      hits.push(body.model);
      bodies.push(body);
      if (body.model === 'flaky-1') {
        // 先吐出一个字（pi-ai 会把它作为 text_delta 交给上层），然后把连接掐掉，
        // 模拟"已经流式吐过字之后才对端断掉"——这才是这条用例要验的场景。
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"半"}}]}\n\n');
        setTimeout(() => res.destroy(), 10);
        return;
      }
      if (body.model === 'bad-1') { res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      CHAT_SSE.forEach((s) => res.write(s));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

  deadServer = createNetServer((sock) => sock.destroy());
  await new Promise<void>((r) => deadServer.listen(0, '127.0.0.1', () => r()));
  deadUrl = `http://127.0.0.1:${(deadServer.address() as { port: number }).port}/v1`;

  bus = new Bus();
  errors = new ErrorCenter(bus, { dataDir });
  config = new ConfigStore(dataDir, bus, errors);
  llm = new LlmService(config, errors, new Db(dataDir), bus);

  const providers = config.config.providers as Record<string, any>;
  const defs: [string, string, string, string][] = [
    ['bad', 'bad-1', 'openai-compatible', `${baseUrl}`],
    ['good', 'good-1', 'openai-compatible', `${baseUrl}`],
    ['flaky', 'flaky-1', 'openai-compatible', `${baseUrl}`],
    ['dead', 'dead-1', 'openai-compatible', `${deadUrl}`],
  ];
  for (const [id, model, protocol, url] of defs) {
    providers[id] = {
      label: id, model, enabled: true, baseUrl: url, protocol, custom: true,
      models: [{ id: model, enabled: true, inputTypes: ['text', 'image', 'video', 'audio'] }],
    };
    config.setProviderKey(id, 'sk-test');
  }
  // 同一家供应商下的第二个模型：用来验"整家连不上时，同家的后续条目这轮直接跳过"
  providers.dead.models.push({ id: 'dead-2', enabled: true });
  // 思考等级由每个模型自己声明；good 只开 low/high 两档
  providers.good.models[0].reasoningLevels = ['low', 'high'];
  llm.syncCustomProviders();
  config.config.llm.chatChain = [{ provider: 'bad', model: 'bad-1' }, { provider: 'good', model: 'good-1' }];
  config.config.llm.failoverThreshold = 1;
});

after(() => {
  server.close();
  deadServer.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* OS 回收 */ }
});

const req = (over: Partial<LLMChatRequest> = {}): LLMChatRequest => ({
  model: '', messages: [{ role: 'user', content: '在吗' }], ...over,
});
const reset = () => { hits.length = 0; bodies.length = 0; llm.resetFailover(); };

test('当前模型掉线：同一次调用顺延到链上下一条并拿到回复', async () => {
  reset();
  const resp = await llm.chat(req(), {});
  assert.equal(resp.content, '好');
  assert.deepEqual(hits, ['bad-1', 'good-1'], '先试第一条，失败后接着试第二条');
});

test('错误分类：连不上/鉴权/缺模型算硬故障，429/500 仍按软故障', () => {
  assert.equal(isHardUnavailable(new Error('server_error: workbuddy: transport error: fetch failed')), true);
  assert.equal(isHardUnavailable(new Error('401 "invalid api key"')), true);
  assert.equal(isHardUnavailable(new Error('404 "model not found"')), true);
  assert.equal(isHardUnavailable(new Error('供应商 our-free-model 未启用，请在桌面端“模型”页启用或切换。')), true);
  assert.equal(isHardUnavailable(new Error('429 "rate limit"')), false);
  assert.equal(isHardUnavailable(new Error('500 "{\\"error\\":\\"boom\\"}"')), false);
  // 整家不可用的错误：同家的第二个模型这轮直接跳过；只是某个模型没了则不跳过
  assert.equal(isProviderWideFailure(new Error('400 "User location is not supported for the API use."')), true);
  assert.equal(isProviderWideFailure(new Error('401 "invalid api key"')), true);
  assert.equal(isProviderWideFailure(new Error('404 "model not found"')), false);
});

test('硬不可用（连不上）不等阈值：立刻挪位置、冷却，下一次不再先白试', async () => {
  reset();
  errors.clear();
  config.config.llm.failoverThreshold = 5;
  config.config.llm.chatChain = [{ provider: 'dead', model: 'dead-1' }, { provider: 'good', model: 'good-1' }];

  const resp = await llm.chat(req(), {});
  assert.equal(resp.content, '好');
  assert.deepEqual(hits, ['good-1'], '死的那条一次就够，不在同一次调用里等阈值');
  const view = llm.chainsView().chat;
  assert.equal(view[0].state, 'down', '连不上的那条立刻显示掉线');
  assert.ok((view[0].downUntil ?? 0) > Date.now(), '冷却时间已记下');
  assert.equal(view[1].state, 'current', '接替者在位');

  hits.length = 0;
  await llm.chat(req(), {});
  assert.deepEqual(hits, ['good-1'], '冷却期内后续调用不再去撞死的那条');

  const recs = errors.list({ category: 'provider' });
  assert.ok(recs.length > 0, '切换过程有记录');
  assert.ok(recs.every((e) => e.level === 'warn'), '已经有人接上就不算 error');
  assert.match(recs[0].message, /已自动切换模型/);

  config.config.llm.chatChain = [{ provider: 'bad', model: 'bad-1' }, { provider: 'good', model: 'good-1' }];
  config.config.llm.failoverThreshold = 1;
  llm.resetFailover();
});

test('同一家 provider 的 transport 故障只算一次：后续同家条目这轮直接跳过', async () => {
  reset();
  config.config.llm.failoverThreshold = 5;
  config.config.llm.chatChain = [
    { provider: 'dead', model: 'dead-1' },
    { provider: 'dead', model: 'dead-2' },
    { provider: 'good', model: 'good-1' },
  ];
  const resp = await llm.chat(req(), {});
  assert.equal(resp.content, '好');
  assert.deepEqual(hits, ['good-1']);
  const view = llm.chainsView().chat;
  assert.equal(view[0].fails, 1, '第一条记一次失败');
  assert.equal(view[1].fails, 0, '同家的第二条没有再白发一次请求');
  assert.equal(view[2].state, 'current', '指针落在真正接上的那条上');
  config.config.llm.chatChain = [{ provider: 'bad', model: 'bad-1' }, { provider: 'good', model: 'good-1' }];
  config.config.llm.failoverThreshold = 1;
  llm.resetFailover();
});

test('work 链走 chainStreamFn 时同样会降级（派活实际走的就是这条路径）', async () => {
  reset();
  errors.clear();
  config.config.llm.failoverThreshold = 5;
  config.config.llm.workChain = [{ provider: 'dead', model: 'dead-1' }, { provider: 'good', model: 'good-1' }];
  const fn = llm.chainStreamFn('work');
  const stream = await fn({} as any, { messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }], timestamp: Date.now() }] } as any, {});
  let done: any = null;
  for await (const ev of stream as any) {
    if (ev.type === 'done') done = ev;
    if (ev.type === 'error') assert.fail(`不该以错误结束：${ev.error?.errorMessage}`);
  }
  assert.ok(done, '流正常结束');
  assert.equal(done.message?.content?.find((b: any) => b.type === 'text')?.text, '好');
  assert.deepEqual(hits, ['good-1'], 'work 链跳过了连不上的那条');
  assert.equal(llm.servingLabel('work'), 'good:good-1');
  const recs = errors.list({ category: 'provider' });
  assert.ok(recs.every((e) => e.level === 'warn'), '中途接上只留 warn');
  config.config.llm.workChain = [];
  config.config.llm.failoverThreshold = 1;
  llm.resetFailover();
});

test('阈值 2：只掉一次不挪位置，连续两次才切下一个', async () => {
  reset();
  config.config.llm.failoverThreshold = 2;
  await llm.chat(req(), {});
  assert.equal(llm.chainsView().chat[0].state, 'current', '第一条仍是当前位置（只失败了 1 次）');
  assert.equal(llm.chainsView().chat[0].fails, 1);

  hits.length = 0;
  await llm.chat(req(), {});
  assert.equal(llm.chainsView().chat[1].state, 'current', '连续两次掉线后位置挪到第二条');
  assert.equal(llm.chainsView().chat[0].fails, 2);
  assert.equal(hits[0], 'bad-1', '每次调用仍从当前位置往后依次试');
  config.config.llm.failoverThreshold = 1;
});

test('降级切换向桌面端发 model.failover 事件', async () => {
  reset();
  config.config.llm.failoverThreshold = 1;
  const got: any[] = [];
  const off = bus.on(busEvents.modelFailover, (d: unknown) => got.push(d));
  await llm.chat(req(), {});
  off();
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'chat');
  assert.equal(got[0].from, 'bad:bad-1');
  assert.equal(got[0].to, 'good:good-1');
});

test('成功之后清零该条的失败计数', async () => {
  reset();
  config.config.llm.failoverThreshold = 3;
  await llm.chat(req(), {});                       // bad 失败 1 次
  assert.equal(llm.chainsView().chat[0].fails, 1);
  llm.resetFailover();
  config.config.llm.chatChain = [{ provider: 'good', model: 'good-1' }, { provider: 'bad', model: 'bad-1' }];
  await llm.chat(req(), {});                       // good 直接成功
  assert.equal(llm.chainsView().chat[0].fails, 0);
  assert.equal(llm.chainsView().chat[0].state, 'current');
  config.config.llm.chatChain = [{ provider: 'bad', model: 'bad-1' }, { provider: 'good', model: 'good-1' }];
  config.config.llm.failoverThreshold = 1;
});

test('已经流式吐过字就不再换模型（否则用户看到两份回答）', async () => {
  reset();
  config.config.llm.chatChain = [{ provider: 'flaky', model: 'flaky-1' }, { provider: 'good', model: 'good-1' }];
  let text = '';
  await assert.rejects(
    () => llm.chat(req(), { onDelta: (d) => { text += d.text ?? ''; } }),
    // pi-ai 把对端断流报成 "terminated"（自研实现以前是把对端 body 里的 kaboom 原文带上来）
    /terminated|kaboom/,
  );
  assert.equal(text, '半', '半个回答已经推给桌面端了');
  assert.equal(hits.length, 1, '只打了第一条，没有顺延');
  config.config.llm.chatChain = [{ provider: 'bad', model: 'bad-1' }, { provider: 'good', model: 'good-1' }];
});

test('用户打断（abort）不计掉线、不降级', async () => {
  reset();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => llm.chat(req({ signal: ac.signal }), {}));
  assert.equal(llm.chainsView().chat[0].state, 'current');
  assert.equal(llm.chainsView().chat[0].fails, 0);
});

test('配置级不可用（未启用）也走降级', async () => {
  reset();
  (config.config.providers as Record<string, any>).bad.enabled = false;
  const resp = await llm.chat(req(), {});
  (config.config.providers as Record<string, any>).bad.enabled = true;
  assert.equal(resp.content, '好');
  assert.deepEqual(hits, ['good-1'], '未启用的那条在预检就被拦下、根本不发请求，直接试下一条');
});

test('整条链都不可用时抛最后一条的错误，并记进报错中心', async () => {
  reset();
  config.config.llm.chatChain = [{ provider: 'bad', model: 'bad-1' }];
  // pi-ai 的错误文案：<状态码> "<对端 body>"（自研实现以前是 'HTTP 500 …'）
  await assert.rejects(() => llm.chat(req(), {}), /500/);
  assert.equal(hits.length, 1, '单条链没有可顺延的对象');
  assert.ok(errors.list().some((e) => e.category === 'provider' && /bad: /.test(e.message)));
  config.config.llm.chatChain = [{ provider: 'bad', model: 'bad-1' }, { provider: 'good', model: 'good-1' }];
});

test('work 链独立：空 = 没有可用模型（不跟随 chat）；配了就用自己', () => {
  config.config.llm.chatChain = [{ provider: 'good', model: 'good-1' }];
  config.config.llm.workChain = [];
  assert.equal(llm.servingLabel('work'), '—', '工作链没配就是没配，不再借聊天链');
  assert.deepEqual(llm.chainsView().work, [], '左栏不该凭空长出条目');
  config.config.llm.workChain = [{ provider: 'good', model: 'good-1' }];
  assert.equal(llm.servingLabel('work'), 'good:good-1');
  config.config.llm.workChain = [];
  config.config.llm.chatChain = [];
});

test('链为空时按 activeProvider 兜底（手改 config.json 仍然生效）', () => {
  const saved = config.config.llm.chatChain;
  config.config.llm.chatChain = [];
  config.config.llm.activeProvider = 'good';
  assert.deepEqual(llm.chainConfig('chat'), [{ provider: 'good', model: 'good-1' }]);
  assert.deepEqual(llm.chainsView().chat, [], '左栏只画配置里真写过的条目，兜底那条不占位');
  assert.equal(llm.activeProviderId(), 'good');
  assert.equal(llm.isActiveUsable().ok, true);
  config.config.llm.chatChain = saved;
});

test('思考强度：每个模型单独设置，只认该模型声明的档位', async () => {
  reset();
  config.config.llm.chatChain = [{ provider: 'good', model: 'good-1' }];
  config.config.llm.modelReasoning = { 'good|good-1': 'high' };
  assert.deepEqual(llm.reasoningLevelsFor('good', 'good-1'), ['low', 'high']);
  assert.equal(llm.reasoningFor('good', 'good-1'), 'high');

  await llm.chat(req(), { chain: 'chat' });
  assert.equal(String(bodies[bodies.length - 1]?.reasoning_effort ?? ''), 'high',
    `模型的思考强度要进请求体：${JSON.stringify(bodies[bodies.length - 1])}`);

  config.config.llm.modelReasoning['good|good-1'] = 'not-a-level';
  assert.equal(llm.reasoningFor('good', 'good-1'), '', '非法值按默认处理');

  config.config.llm.modelReasoning['bad|bad-1'] = 'high';
  assert.equal(llm.reasoningFor('bad', 'bad-1'), '', '没声明等级模型不生效');
  config.config.llm.modelReasoning = {};
});
