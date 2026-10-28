import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 包根（src/kernel 的上两级）：运行期找 docker/、scripts/ 这类随包资源用它。
 * 不要用 process.cwd() —— npm -g 安装后用户在任意目录启动，cwd 是他的工作目录，不是包目录。
 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 运行期实际加载内核/内置插件/内置资源的根：
 *  - npm 包（落在 node_modules）里 Node 拒绝做类型剥离（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
 *    只能跑编译产物 `dist/src`（由 `npm run build:pkg` 产出）；
 *  - 开发 / zip（目录不在 node_modules）直跑 `src` 的 TS 源码。
 * bin/parallel.js 按同一规则选入口文件。
 */
export const ACTIVE_ROOT = existsSync(join(PACKAGE_ROOT, 'dist', 'src', 'kernel', 'main.js'))
  ? join(PACKAGE_ROOT, 'dist', 'src')
  : join(PACKAGE_ROOT, 'src');
