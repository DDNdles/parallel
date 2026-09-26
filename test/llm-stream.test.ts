import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer, type Server } from 'node:http';

import { OpenAiCompatProvider } from '../src/kernel/services/llm.ts';
import type { LLMChatRequest } from '../src/kernel/types.ts';

/**
 * OpenAiCompatProvider.chatVia 流式路径单测：
 * 本地假 SSE 服务器模拟 OpenAI-compatible chat/completions 流式响应，
 * 验证 ① 文本 delta 逐段回调与聚合 ② tool_calls 跨 chunk 增量聚合（id/name/arguments）
 * ③ usage 捕获 ④ finish_reason ⑤ 请求携带 Authorization/Bearer、stream:true、tools 透传。
 */

let server: Server;
let baseUrl = '';
let lastAuth = '';
let lastBody: any;

/** SSE 事件行 */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastAuth = String(req.headers['authorization'] ?? '');
      lastBody = JSON.parse(raw || '{}');
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const chunks: string[] = [
        // 文本 delta 分两段
        sse({ choices: [{ delta: { content: '你好，' } }] }),
        sse({ choices: [{ delta: { content: '喵！' } }] }),
        // 工具调用：id/name 与 arguments 分多个增量到达
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_python', arguments: '' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"code":' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"print(1)"}' } }] } }] }),
        // 第二个工具（无 id，靠 index 聚合）
        sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'sandbox', arguments: '{"p":' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"a.txt"}' } }] } }] }),
        // finish + usage
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        'data: [DONE]\n\n',
      ];
      let i = 0;
      const write = () => {
        if (i < chunks.length) {
          res.write(chunks[i++]);
          setTimeout(write, 5); // 逐块写出，逼真模拟增量到达
        } else {
          res.end();
        }
      };
      write();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
});

after(() => {
  server.close();
});

const REQ: LLMChatRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'run_python', description: 'd', parameters: { type: 'object', properties: {} } } }],
};

test('chatVia 流式：文本 delta 逐段回调并聚合', async () => {
  const p = new OpenAiCompatProvider('test');
  const textDeltas: string[] = [];
  const resp = await p.chatVia(baseUrl, 'sk-test', REQ, (d) => {
    if (d.text) textDeltas.push(d.text);
  });
  assert.deepEqual(textDeltas, ['你好，', '喵！'], 'onDelta 应逐段收到文本增量');
  assert.equal(resp.content, '你好，喵！');
});

test('chatVia 流式：tool_calls 跨 chunk 按 index 聚合', async () => {
  const p = new OpenAiCompatProvider('test');
  const toolDeltas: number[] = [];
  const resp = await p.chatVia(baseUrl, 'sk-test', REQ, (d) => {
    if (d.toolCall) toolDeltas.push(d.toolCall.index);
  });
  assert.deepEqual(toolDeltas, [0, 0, 0, 1, 1], 'onDelta 应按到达顺序回调工具增量');
  assert.equal(resp.toolCalls.length, 2);
  assert.equal(resp.toolCalls[0].id, 'call_1');
  assert.equal(resp.toolCalls[0].function.name, 'run_python');
  assert.equal(resp.toolCalls[0].function.arguments, '{"code":"print(1)"}');
  assert.equal(resp.toolCalls[1].id, 'call_2');
  assert.equal(resp.toolCalls[1].function.name, 'sandbox');
  assert.equal(resp.toolCalls[1].function.arguments, '{"p":"a.txt"}');
  assert.equal(resp.finishReason, 'tool_calls');
});

test('chatVia 流式：usage 捕获与请求形状（Bearer/stream/tools）', async () => {
  const p = new OpenAiCompatProvider('test');
  const resp = await p.chatVia(baseUrl, 'sk-secret', REQ);
  assert.deepEqual(resp.usage, { promptTokens: 10, completionTokens: 5 });
  assert.equal(lastAuth, 'Bearer sk-secret');
  assert.equal(lastBody.model, 'test-model');
  assert.equal(lastBody.stream, true);
  assert.deepEqual(lastBody.stream_options, { include_usage: true });
  assert.equal(lastBody.tools?.[0]?.function?.name, 'run_python');
  assert.equal(lastBody.messages?.[0]?.content, 'hi');
});

test('chatVia：非 2xx 抛错（供报错中心/边界处理）', async () => {
  const p = new OpenAiCompatProvider('test');
  await assert.rejects(
    () => p.chatVia(baseUrl + '/wrong-path', 'sk-x', REQ), // 假服务器对非 /v1/chat/completions 返回 404
    /HTTP 404/,
  );
});
