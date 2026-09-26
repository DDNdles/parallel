import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer, type Server } from 'node:http';

import { AnthropicProvider, OpenAiResponsesProvider } from '../src/kernel/services/llm.ts';
import type { ChatMessage, LLMChatRequest } from '../src/kernel/types.ts';

/**
 * 另外两种连接方式的线格式单测（本地假 SSE 服务器，不打真实 API）：
 * ① Anthropic Messages：system 抽顶层、tool 结果并成 tool_result 块、x-api-key/anthropic-version 头、
 *    max_tokens、tools→input_schema、text_delta 聚合、input_json_delta 拼 tool_use 参数、缓存 token 折算。
 * ② OpenAI Responses：instructions + input 条目序列、function_call/function_call_output 往返、
 *    按 item_id 聚合参数增量、call_id 原样带回、response.completed 的 usage。
 */

let server: Server;
let baseUrl = '';
const seen: { path: string; headers: Record<string, unknown>; body: any }[] = [];

function ev(name: string, obj: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/** Anthropic 流：一句文本 + 一个跨块增量的工具调用 */
const ANTHROPIC_STREAM = [
  ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 20 } } }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '收到，' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '主人' } }),
  ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'run_python' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"code"' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"print(1)"}' } }),
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 21 } }),
  ev('message_stop', { type: 'message_stop' }),
];

/** Responses 流：文本增量 + 两个 function_call 条目 */
const RESPONSES_STREAM = [
  ev('response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }),
  ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', delta: '喵' }),
  ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', delta: '呜' }),
  ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'sandbox_read' } }),
  ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"path":' }),
  ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"a.txt"}' }),
  ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'sandbox_read', arguments: '{"path":"a.txt"}' } }),
  ev('response.completed', { type: 'response.completed', response: { usage: { input_tokens: 500, output_tokens: 33, input_tokens_details: { cached_tokens: 400 } } } }),
];

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push({ path: req.url ?? '', headers: { ...req.headers }, body });
      const stream = req.url === '/v1/messages' ? ANTHROPIC_STREAM : req.url === '/v1/responses' ? RESPONSES_STREAM : null;
      if (!stream || req.method !== 'POST') { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"no route"}}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      let i = 0;
      const write = () => {
        if (i < stream.length) { res.write(stream[i++]); setTimeout(write, 4); } else res.end();
      };
      write();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
});

after(() => server.close());

/** 一轮带工具调用与工具结果的历史，用来验两种格式的映射 */
const HISTORY: ChatMessage[] = [
  { role: 'system', content: '你是 parallel' },
  { role: 'user', content: '读一下 a.txt' },
  { role: 'assistant', content: '好的', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'sandbox_read', arguments: '{"path":"a.txt"}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
  { role: 'user', content: '再说一遍' },
];
const REQ: LLMChatRequest = {
  model: 'test-model',
  messages: HISTORY,
  tools: [{ type: 'function', function: { name: 'sandbox_read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
};

test('Anthropic：请求形状（system 抽顶层 / tool_result 块 / 头 / max_tokens / input_schema）', async () => {
  const p = new AnthropicProvider('t');
  await p.chatVia(baseUrl, 'sk-ant', { ...REQ, maxTokens: 64 });
  const last = seen[seen.length - 1];
  assert.equal(last.path, '/v1/messages');
  assert.equal(last.headers['x-api-key'], 'sk-ant');
  assert.equal(last.headers['anthropic-version'], '2023-06-01');
  assert.equal(last.body.system, '你是 parallel');
  assert.equal(last.body.max_tokens, 64);
  assert.equal(last.body.stream, true);
  assert.deepEqual(last.body.tools[0], { name: 'sandbox_read', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string' } } } });
  // assistant 轮摊成 text + tool_use 块，紧随其后的 tool 消息并成同一条 user 的 tool_result
  const asst = last.body.messages.find((m: any) => m.role === 'assistant');
  assert.deepEqual(asst.content.map((b: any) => b.type), ['text', 'tool_use']);
  assert.deepEqual(asst.content[1].input, { path: 'a.txt' });
  const toolMsg = last.body.messages.find((m: any) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
  assert.deepEqual(toolMsg.content, [{ type: 'tool_result', tool_use_id: 'call_1', content: '文件内容' }]);
});

test('Anthropic：流式文本与 input_json_delta 聚合、缓存 token 折算', async () => {
  const p = new AnthropicProvider('t');
  const texts: string[] = [];
  const resp = await p.chatVia(baseUrl, 'sk-ant', REQ, (d) => { if (d.text) texts.push(d.text); });
  assert.deepEqual(texts, ['收到，', '主人']);
  assert.equal(resp.content, '收到，主人');
  assert.equal(resp.toolCalls.length, 1);
  assert.equal(resp.toolCalls[0].id, 'tu_1');
  assert.equal(resp.toolCalls[0].function.name, 'run_python');
  assert.equal(resp.toolCalls[0].function.arguments, '{"code":"print(1)"}');
  assert.equal(resp.finishReason, 'tool_calls');
  assert.deepEqual(resp.usage, { promptTokens: 920, completionTokens: 21, cacheHitTokens: 800, cacheMissTokens: 120 });
});

test('Anthropic：baseUrl 已带 /v1 时不拼成 /v1/v1/messages', async () => {
  const p = new AnthropicProvider('t');
  await p.chatVia(baseUrl.replace(/\/$/, ''), 'sk-ant', { ...REQ, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen[seen.length - 1].path, '/v1/messages');
  await p.chatVia(baseUrl.replace(/\/v1$/, ''), 'sk-ant', { ...REQ, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen[seen.length - 1].path, '/v1/messages');
});

test('Anthropic：非 2xx 抛错（错误文本带状态码）', async () => {
  const p = new AnthropicProvider('t');
  await assert.rejects(() => p.chatVia(baseUrl + '/nope', 'k', REQ), /HTTP 404/);
});

test('Responses：请求形状（instructions 抽顶层 / input 条目序列 / tools 摊平）', async () => {
  const p = new OpenAiResponsesProvider('t');
  await p.chatVia(baseUrl, 'sk-oai', REQ);
  const last = seen[seen.length - 1];
  assert.equal(last.path, '/v1/responses');
  assert.equal(last.headers['authorization'], 'Bearer sk-oai');
  assert.equal(last.body.instructions, '你是 parallel');
  assert.equal(last.body.stream, true);
  assert.deepEqual(last.body.tools[0], { type: 'function', name: 'sandbox_read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } });
  const types = last.body.input.map((i: any) => i.type ?? i.role);
  assert.deepEqual(types, ['user', 'assistant', 'function_call', 'function_call_output', 'user']);
  const fc = last.body.input.find((i: any) => i.type === 'function_call');
  assert.deepEqual({ call_id: fc.call_id, name: fc.name, arguments: fc.arguments }, { call_id: 'call_1', name: 'sandbox_read', arguments: '{"path":"a.txt"}' });
  const out = last.body.input.find((i: any) => i.type === 'function_call_output');
  assert.deepEqual(out, { type: 'function_call_output', call_id: 'call_1', output: '文件内容' });
});

test('Responses：文本/参数增量按 item 聚合，call_id 原样带回，usage 取 completed', async () => {
  const p = new OpenAiResponsesProvider('t');
  const texts: string[] = [];
  const resp = await p.chatVia(baseUrl, 'sk-oai', REQ, (d) => { if (d.text) texts.push(d.text); });
  assert.deepEqual(texts, ['喵', '呜']);
  assert.equal(resp.content, '喵呜');
  assert.equal(resp.toolCalls.length, 1);
  assert.equal(resp.toolCalls[0].id, 'call_1', '回填要带 call_id，不是 item id');
  assert.equal(resp.toolCalls[0].function.name, 'sandbox_read');
  assert.equal(resp.toolCalls[0].function.arguments, '{"path":"a.txt"}');
  assert.equal(resp.finishReason, 'tool_calls');
  assert.deepEqual(resp.usage, { promptTokens: 500, completionTokens: 33, cacheHitTokens: 400, cacheMissTokens: 100 });
});

test('Responses：非 2xx 抛错', async () => {
  const p = new OpenAiResponsesProvider('t');
  await assert.rejects(() => p.chatVia(baseUrl + '/nope', 'k', REQ), /HTTP 404/);
});
