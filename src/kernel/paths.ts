import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 包根（src/kernel 的上两级）：运行期找 docker/、scripts/ 这类随包资源用它。
 * 不要用 process.cwd() —— npm -g 安装后用户在任意目录启动，cwd 是他的工作目录，不是包目录。
 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
