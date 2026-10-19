import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapUsage } from '../src/kernel/services/pi-ai.ts';

test('usage 映射：pi-ai 规范化的 cacheRead/input', () => {
  assert.deepEqual(mapUsage({ cacheRead: 100, input: 20, output: 5 }), {
    promptTokens: 120, completionTokens: 5, cacheHitTokens: 100, cacheMissTokens: 20,
  });
});

test('usage 映射：Anthropic 的 cache_read_input_tokens', () => {
  assert.deepEqual(mapUsage({
    input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5,
  }), {
    promptTokens: 130, completionTokens: 5, cacheHitTokens: 100, cacheMissTokens: 30,
  });
});

test('usage 映射：OpenAI 的 cached_tokens 是 prompt_tokens 的子集', () => {
  assert.deepEqual(mapUsage({
    prompt_tokens: 120, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens: 5,
  }), {
    promptTokens: 120, completionTokens: 5, cacheHitTokens: 100, cacheMissTokens: 20,
  });
});

test('usage 映射：Gemini 的 cachedContentTokenCount 是 promptTokenCount 的子集', () => {
  assert.deepEqual(mapUsage({
    promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 5,
  }), {
    promptTokens: 120, completionTokens: 5, cacheHitTokens: 100, cacheMissTokens: 20,
  });
});

test('usage 映射：没有任何缓存字段时保持原口径', () => {
  assert.deepEqual(mapUsage({ input: 20, output: 5 }), {
    promptTokens: 20, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 20,
  });
});
