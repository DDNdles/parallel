#!/usr/bin/env node
/** npm pack / 发布前置检查：ui/ 必须已经构建（npm run build），否则发出去的包没有桌面端。 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'ui', 'index.html'))) {
  console.error('[pack] ui/ 还没有构建产物：先 `npm run build`（构建桌面端到 ui/），再打包。');
  process.exit(1);
}
console.log('[pack] ui/ 产物就绪');
