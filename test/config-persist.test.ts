import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigStore } from '../src/kernel/config.ts';
import { Bus } from '../src/kernel/bus.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';

/**
 * 配置装载只该「矫正已知键的类型、补齐默认值」，不该删掉默认值里没有的键。
 * 2026-10-28 的配置校验把装载改成「只按 defaults 骨架取值」，于是 providers /
 * modelByProvider 这类按 id 装条目的字典每次启动都被裁成默认那两条 ——
 * 用户加的供应商（gemini / ustc / our-free-model）启动一次丢一次，再一存盘就永久消失。
 */

function makeStore(seed: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-persist-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(seed, null, 2));
  const bus = new Bus();
  const store = new ConfigStore(dir, bus, new ErrorCenter(bus, { dataDir: dir }));
  return { dir, store };
}

test('配置：用户自加的供应商不会被装载裁掉，存盘后仍在', () => {
  const { dir, store } = makeStore({
    providers: {
      gemini: {
        label: 'gemini', model: 'gemini-3.8-flash-low', enabled: true,
        baseUrl: 'http://127.0.0.1:8045', protocol: 'openai-compatible', custom: true,
        models: [{ id: 'gemini-3.8-flash-low', contextWindow: 1048576, inputTypes: ['text'], enabled: true }],
      },
    },
    llm: {
      chatChain: [{ provider: 'gemini', model: 'gemini-3.8-flash-low' }],
      modelByProvider: { gemini: 'gemini-3.8-flash-low' },
    },
  });

  const providers = store.config.providers as Record<string, any>;
  assert.ok(providers.gemini, '自定义供应商被载入时删掉了');
  assert.equal(providers.gemini.baseUrl, 'http://127.0.0.1:8045');
  assert.equal(providers.gemini.models[0].id, 'gemini-3.8-flash-low');
  // 默认值里本来就有这两条：idempotent，不该被用户配置挤掉
  assert.ok(providers.deepseek);
  assert.equal(store.config.llm.modelByProvider.gemini, 'gemini-3.8-flash-low');

  store.saveConfig();
  const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.ok(written.providers.gemini, '存盘后供应商丢了');
  assert.equal(written.llm.modelByProvider.gemini, 'gemini-3.8-flash-low');

  // 再装一次（等价于下次启动）：仍然在
  const bus = new Bus();
  const again = new ConfigStore(dir, bus, new ErrorCenter(bus, { dataDir: dir }));
  assert.ok((again.config.providers as Record<string, any>).gemini, '第二次装载时供应商丢了');
  assert.deepEqual(again.config.llm.chatChain, [{ provider: 'gemini', model: 'gemini-3.8-flash-low' }]);
});

test('配置：类型错的已知键仍回落默认值，已删的旧键仍清掉', () => {
  const { store } = makeStore({
    risk: { replyRatePerMin: 'not-a-number', jitterMinMs: 300 },
    humanlike: { enabled: true, script: { chapters: [] } },
    ui: { port: '80' },
  });
  // 类型不符 → 用默认值
  assert.equal(store.config.risk.replyRatePerMin, 12);
  assert.equal(store.config.ui.port, 3080);
  // 旧键（迁移显式删除）
  assert.equal((store.config.risk as any).jitterMinMs, undefined);
  assert.equal((store.config.humanlike as any).enabled, undefined);
  assert.equal((store.config.humanlike as any).script, undefined);
});

test('配置：空对象默认值的字典段保留用户条目', () => {
  const { store } = makeStore({
    ui: { chatPrefs: { 3893163081: { pinned: [], hidden: [], listWidth: 250 } } },
  });
  const prefs = (store.config.ui as any).chatPrefs;
  assert.ok(prefs['3893163081'], 'chatPrefs 里的用户条目被裁掉了');
  assert.equal(prefs['3893163081'].listWidth, 250);
});
