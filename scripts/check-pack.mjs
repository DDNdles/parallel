#!/usr/bin/env node
/** npm pack / 发布前置检查：ui/ 与 dist/ 都必须已构建（`npm run build` + `npm run build:pkg`），
 *  否则发出去的包要么没有桌面端、要么在 node_modules 里跑不起来（Node 拒绝类型剥离 TS）。 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const missing = [];
if (!existsSync(join(root, 'ui', 'index.html'))) missing.push('ui/（桌面端产物，`npm run build`）');
if (!existsSync(join(root, 'dist', 'src', 'kernel', 'main.js'))) missing.push('dist/（编译运行时，`npm run build:pkg`）');
if (missing.length) {
  console.error('[pack] 缺少构建产物：' + missing.join('、') + '。先构建再打包。');
  process.exit(1);
}
console.log('[pack] ui/ 与 dist/ 产物就绪');
