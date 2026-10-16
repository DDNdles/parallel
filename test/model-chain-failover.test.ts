import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bus, busEvents } from '../src/kernel/bus.ts';
import { ConfigStore } from '../src/kernel/config.ts';
import { Db } from '../src/kernel/db.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';
import { LlmService } from '../src/kernel/services/llm.ts';
import type { LLMChatRequest } from '../src/kernel/types.ts';

/**
 * 模型优先级链与掉线降级（本地假服务器，不打真实 API）：
 * ① 链按顺序取，当前这条失败后在同一次调用里顺延到下一条；
 * ② 只有连续失败满 llm.failoverThreshold 次，才把链上位置永久挪走（防一次网络抖动就换模型）；
 * ③ 已经往外吐过字 / 用户主动打断时不换模型（换了只会重复输出或违背中断）；
 * ④ 配置级不可用（未启用 / 缺 key）与请求失败同等对待，一样降级；
 * ⑤ work 链独立：空 = 没有可用模型（不跟随 chat 链）。
 */

let server: Server;
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

  bus = new Bus();
  errors = new ErrorCenter(bus, { dataDir });
  config = new ConfigStore(dataDir, bus, errors);
  llm = new LlmService(config, errors, new Db(dataDir), bus);

  const providers = config.config.providers as Record<string, any>;
  const defs: [string, string, string][] = [['bad', 'bad-1', 'openai-compatible'], ['good', 'good-1', 'openai-compatible'], ['flaky', 'flaky-1', 'openai-compatible']];
  for (const [id, model, protocol] of defs) {
    providers[id] = {
      label: id, model, enabled: true, baseUrl, protocol, custom: true,
      models: [{ id: model, enabled: true, inputTypes: ['text', 'image', 'video', 'audio'] }],
    };
    config.setProviderKey(id, 'sk-test');
  }
  llm.syncCustomProviders();
  config.config.llm.chatChain = [{ provider: 'bad', model: 'bad-1' }, { provider: 'good', model: 'good-1' }];
  config.config.llm.failoverThreshold = 1;
});

after(() => {
  server.close();
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
