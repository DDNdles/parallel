import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateService, isNewerVersion, readOwnVersion } from '../src/kernel/services/update.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

/** 最小 Response 形状：UpdateService 只用 ok 和 json() */
function res(body: object, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

test('isNewerVersion：三段数字比较，缺段按 0，不认字符串序', () => {
  assert.equal(isNewerVersion('0.3.0', 'v0.4.0'), true);
  assert.equal(isNewerVersion('0.3.0', 'v0.3.0'), false);
  assert.equal(isNewerVersion('0.3.0', 'v0.2.9'), false);
  assert.equal(isNewerVersion('0.10.0', 'v0.9.1'), false);   // 数字序：10 > 9
  assert.equal(isNewerVersion('0.3', 'v0.3.1'), true);       // 缺段按 0
  assert.equal(isNewerVersion('0.4.0', 'v0.4'), false);
});

test('UpdateService：发现新版并缓存', async () => {
  const svc = new UpdateService({
    log: fakeLog,
    currentVersion: '0.3.0',
    fetchFn: (async () => res({ tag_name: 'v0.4.0', html_url: 'https://github.com/DDNdles/parallel/releases/tag/v0.4.0' })) as never,
  });
  const info = await svc.checkNow();
  assert.equal(info?.latest, 'v0.4.0');
  assert.equal(info?.current, '0.3.0');
  assert.equal(info?.url, 'https://github.com/DDNdles/parallel/releases/tag/v0.4.0');
  assert.equal(svc.get(), info);   // 缓存同一份
});

test('同版本 / 旧版 / draft / prerelease 都不提示', async () => {
  for (const body of [
    { tag_name: 'v0.3.0', html_url: 'https://x' },
    { tag_name: 'v0.2.9', html_url: 'https://x' },
    { tag_name: 'v0.4.0', html_url: 'https://x', draft: true },
    { tag_name: 'v0.4.0', html_url: 'https://x', prerelease: true },
    { html_url: 'https://x' },                       // 没 tag 也不炸
  ]) {
    const svc = new UpdateService({
      log: fakeLog,
      currentVersion: '0.3.0',
      fetchFn: (async () => res(body)) as never,
    });
    assert.equal(await svc.checkNow(), null, JSON.stringify(body));
  }
});

test('失败静默：网络炸了不抛错，且保留上一次的成功结果', async () => {
  let shouldFail = false;
  const svc = new UpdateService({
    log: fakeLog,
    currentVersion: '0.3.0',
    fetchFn: (async () => {
      if (shouldFail) throw new Error('ECONNRESET');
      return res({ tag_name: 'v0.4.0', html_url: 'https://x' });
    }) as never,
  });
  const first = await svc.checkNow();
  assert.equal(first?.latest, 'v0.4.0');
  shouldFail = true;
  assert.equal(await svc.checkNow(), first);   // 失败回落到缓存
});

test('start() 尊重 PARALLEL_NO_UPDATE_CHECK=1，stop() 收掉定时器', async () => {
  let calls = 0;
  process.env.PARALLEL_NO_UPDATE_CHECK = '1';
  const svc = new UpdateService({
    log: fakeLog,
    currentVersion: '0.3.0',
    fetchFn: (async () => { calls++; return res({ tag_name: 'v0.4.0', html_url: 'https://x' }); }) as never,
  });
  svc.start();
  svc.stop();
  assert.equal(calls, 0);
  delete process.env.PARALLEL_NO_UPDATE_CHECK;
});

test('readOwnVersion：能从包根 package.json 读出语义化版本', () => {
  assert.match(readOwnVersion(), /^\d+\.\d+\.\d+$/);
});
