import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyModelCfg } from '../src/kernel/services/llm.ts';
import type { LLMChatRequest } from '../src/kernel/types.ts';

/**
 * 模型页声明的配置如何影响这一次请求（引擎无关的整形，仍然归内核管）：
 * ① inputTypes —— 没声明的媒体不转发；
 * ② capabilities.webSearch —— 模型自带联网就摘掉 Tavily 的 web_search（省额度），web_fetch 保留；
 * ③ maxOutput —— 作为输出上限发出，调用方显式给的优先。
 *
 * 注意：真正把请求拼成各家线格式、把媒体转成 content 块的工作，自 2026-09-28 起已交给
 * @earendil-works/pi-ai（见 test/pi-ai-backend.test.ts），这里只验内核自己那层整形。
 */

let tmp = '';
let wavPath = '';

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'parallel-cfg-'));
  // 1 字节"音频"：只验它有没有被保留，内容无意义
  wavPath = join(tmp, 'v.wav');
  writeFileSync(wavPath, Buffer.from('RIFFxxxxWAVEfmt ', 'latin1'));
});

after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* OS 回收 */ }
});

const fnTool = (name: string) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});
const req = (over: Partial<LLMChatRequest> = {}): LLMChatRequest => ({
  model: 'm-1', messages: [{ role: 'user', content: '看下这张图' }], ...over,
});

test('inputTypes 没声明的媒体不转发，声明了的留着', () => {
  const atts = [
    { kind: 'image' as const, url: 'https://x/p.png' },
    { kind: 'audio' as const, path: wavPath, mime: 'audio/wav' },
    { kind: 'video' as const, url: 'https://x/v.mp4' },
  ];
  assert.deepEqual(
    applyModelCfg({ inputTypes: ['text', 'image'] }, req({ attachments: atts })).attachments?.map((a) => a.kind),
    ['image']);
  assert.equal(applyModelCfg({ inputTypes: ['text'] }, req({ attachments: atts })).attachments, undefined,
    '一条都不剩时干脆去掉该字段');
  assert.deepEqual(
    applyModelCfg({ inputTypes: ['text', 'image', 'audio'] }, req({ attachments: atts })).attachments?.map((a) => a.kind),
    ['image', 'audio'], '视频没声明 → 不转');
});

test('勾选原生联网搜索：摘掉 Tavily 的 web_search，web_fetch 保留', () => {
  const tools = [fnTool('web_search'), fnTool('web_fetch'), fnTool('run_python')];
  const out = applyModelCfg({ capabilities: ['webSearch'] }, req({ tools }));
  assert.equal(out.nativeSearch, true);
  assert.deepEqual(out.tools?.map((t) => t.function.name), ['web_fetch', 'run_python']);

  const plain = applyModelCfg({}, req({ tools }));
  assert.equal(plain.nativeSearch, undefined, '没勾选就照旧给 Tavily 工具');
  assert.equal(plain.tools?.length, 3);

  // 只剩 web_search 时整个 tools 字段撤掉，免得发个空数组过去
  assert.equal(applyModelCfg({ capabilities: ['webSearch'] }, req({ tools: [fnTool('web_search')] })).tools, undefined);
});

test('最大输出 Token 成为输出上限；调用方显式给的优先', () => {
  assert.equal(applyModelCfg({ maxOutput: 8192 }, req()).maxTokens, 8192);
  assert.equal(applyModelCfg({ maxOutput: 8192 }, req({ maxTokens: 1 })).maxTokens, 1, 'ping 这类显式值不被配置盖掉');
  assert.equal(applyModelCfg({}, req()).maxTokens, undefined, '没填就不发，交给对端默认');
  assert.equal(applyModelCfg({ maxOutput: 0 }, req()).maxTokens, undefined);
  // 没在模型页登记过的模型：原样发，别乱动调用方的请求
  const untouched = applyModelCfg(undefined, req({ tools: [fnTool('web_search')] }));
  assert.equal(untouched.tools?.length, 1);
  assert.equal(untouched.nativeSearch, undefined);
  assert.equal(untouched.maxTokens, undefined);
});
