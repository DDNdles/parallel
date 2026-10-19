/**
 * 缓存探针：用当前 data/ 里的真实 provider 配置与 key，对 chat 链上的每个模型
 * 连续发两次完全相同的「大稳定 system + 固定 user」请求，打印 usage。
 *
 *   node --experimental-transform-types --no-warnings scripts/probe-cache.mjs
 *
 * 目的：确认本地中转到底报不报缓存、报在哪个字段。第二次 cacheHit > 0 才算可用。
 * 注意：会真实调用模型（每次约 6k prompt token），请自行确认额度；不会打印任何 key。
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../src/kernel/kernel.ts';

const here = dirname(fileURLToPath(import.meta.url));
const realData = join(here, '..', 'data');
const tmp = mkdtempSync(join(tmpdir(), 'parallel-cache-probe-'));
const PORT = 33000 + (process.pid % 2000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let kernel;
try {
  copyFileSync(join(realData, 'config.json'), join(tmp, 'config.json'));
  copyFileSync(join(realData, 'secrets.json'), join(tmp, 'secrets.json'));

  process.env.PARALLEL_DEBUG = process.env.PARALLEL_DEBUG ?? '1';
  kernel = new Kernel({ dataDir: tmp, noApi: true });
  kernel.config.config.onebot.port = PORT;
  await kernel.boot();

  const chain = Array.isArray(kernel.config.config.llm.chatChain) ? kernel.config.config.llm.chatChain : [];
  if (!chain.length) {
    console.log('chat 链为空，无法探测。');
  } else {
    // 稳定前缀要足够大：3.8-flash 的缓存下限约 4,096 token，这里约 6k token
    const system = [
      '你是缓存测试助手。只回复 OK，不要解释。',
      '以下是一段完全稳定的提示词前缀，用于测试提示词缓存。'.repeat(600),
    ].join('\n');
    const req = {
      model: '',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '只回复 OK' },
      ],
      stream: false,
      maxTokens: 8,
    };
    console.log(`探针 system ${system.length} 字符；每个模型发两次相同请求。`);
    for (const ref of chain) {
      console.log(`\n=== ${ref.provider}/${ref.model} ===`);
      for (let i = 1; i <= 2; i++) {
        const t0 = Date.now();
        try {
          const r = await kernel.llm.chat(req, { providerId: ref.provider, model: ref.model });
          console.log(`call${i} ${Date.now() - t0}ms usage=${JSON.stringify(r.usage ?? null)} content=${JSON.stringify(String(r.content ?? '').slice(0, 20))}`);
        } catch (e) {
          console.log(`call${i} ${Date.now() - t0}ms ERROR=${e?.message ?? String(e)}`);
        }
        if (i === 1) await sleep(500);
      }
    }
  }
} catch (e) {
  console.log('探针异常：', e?.message ?? String(e));
} finally {
  try { await kernel?.shutdown(); } catch { /* ignore */ }
  await sleep(200);
  try {
    writeFileSync(join(tmp, 'secrets.json'), Buffer.alloc(4096));
    rmSync(tmp, { recursive: true, force: true });
  } catch { /* ignore */ }
  process.exit(0);
}
