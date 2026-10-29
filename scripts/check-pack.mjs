#!/usr/bin/env node
/** npm pack / 发布前置检查：ui/ 与 dist/ 都必须已构建（`npm run build` + `npm run build:pkg`），
 *  否则发出去的包要么没有桌面端、要么在 node_modules 里跑不起来（Node 拒绝类型剥离 TS）。 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const missing = [];
if (!existsSync(join(root, 'ui', 'index.html'))) missing.push('ui/（桌面端产物，`npm run build`）');
const distMain = join(root, 'dist', 'src', 'kernel', 'main.js');
if (!existsSync(distMain)) missing.push('dist/（编译运行时，`npm run build:pkg`）');
if (missing.length) {
  console.error('[pack] 缺少构建产物：' + missing.join('、') + '。先构建再打包。');
  process.exit(1);
}

// dist 是 npm 包装里唯一的运行时（包里不带 src），过期就等于把旧代码发出去 ——
// 它不会报错，只会在用户机器上跑着改之前的行为（开发目录的 404 前端就是这么来的）。
const newestSource = (dir) => {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestSource(p));
    else if (e.name.endsWith('.ts')) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
};
let srcNewest = 0;
for (const d of ['src', 'examples']) {
  const abs = join(root, d);
  if (existsSync(abs)) srcNewest = Math.max(srcNewest, newestSource(abs));
}
const distTime = statSync(distMain).mtimeMs;
if (srcNewest > distTime) {
  const mins = Math.round((srcNewest - distTime) / 60000);
  console.error(`[pack] dist/ 比源码旧（落后约 ${mins} 分钟）：先 npm run build:pkg 再打包，否则发出去的是旧代码。`);
  process.exit(1);
}

console.log('[pack] ui/ 与 dist/ 产物就绪（dist 不旧于源码）');
