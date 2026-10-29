import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本模块所在目录：开发/zip 是 <包根>/src/kernel，npm 包是 <包根>/dist/src/kernel */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 运行期实际加载内核/内置插件/内置资源的根：
 *  - 开发 / zip：<包根>/src，直跑 TS 源码；
 *  - npm 包：<包根>/dist/src（`npm run build:pkg` 的产物）—— node_modules 里 Node 拒绝类型剥离
 *    （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。
 * 两种布局里它都正好是本模块的上一级，不需要再去猜 dist 在不在（猜错过一次：开发目录留了
 * 一份过期的 dist，插件就全从旧编译产物加载了）。bin/parallel.js 按同一规则选入口。
 */
export const ACTIVE_ROOT = resolve(MODULE_DIR, '..');

/**
 * 包根：向上找最近的、带 name 的 package.json。运行期找 docker/、scripts/、ui/ 这类随包资源用它。
 * 不要用 process.cwd() —— npm -g 安装后用户在任意目录启动，cwd 是他的工作目录，不是包目录。
 * 也不要写死层级：源码形态在 src/kernel（上两级），编译产物在 dist/src/kernel（上三级），
 * 写死会在编译形态下把包根算成 <包根>/dist，随包的 docker/、scripts/、ui/ 就全部找不到。
 */
function findPackageRoot(from: string): string {
  let dir = from;
  for (;;) {
    const pkgFile = join(dir, 'package.json');
    if (existsSync(pkgFile)) {
      try {
        const name = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: unknown }).name;
        if (typeof name === 'string' && name) return dir;
      } catch { /* 坏 json：继续往上找 */ }
    }
    const up = resolve(dir, '..');
    if (up === dir) return resolve(from, '..', '..');   // 一路到盘符根都没有：退回旧口径
    dir = up;
  }
}

export const PACKAGE_ROOT = findPackageRoot(MODULE_DIR);
