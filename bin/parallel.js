#!/usr/bin/env node
// parallel 启动器：开发/zip 直跑 TypeScript 源码（Node ≥ 24 --experimental-transform-types），
// npm 包（node_modules 里 Node 拒绝类型剥离）跑编译产物 dist/src。两种形态都不需要用户手动构建。
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// 先预检 Node 版本：--experimental-transform-types 需要 ≥24，低版本会报看不懂的语法错
const major = Number(process.versions.node.split('.')[0]);
if (!(major >= 24)) {
  console.error(`[parallel] 需要 Node.js ≥ 24（当前 ${process.versions.node}）。\n到 https://nodejs.org 装最新 LTS 后重试。`);
  process.exit(1);
}

// --use-system-ca：用操作系统信任库校验证书（Node 自带 CA 缺不少国内站点的中间证书，
// 例如中科大一〇七平台的 SCOW 门户链就缺；插件经 HTTPS 调它时否则 UNABLE_TO_VERIFY_LEAF_SIGNATURE）
// 入口选择：node_modules 里必须跑编译产物（dist/src），目录直跑（开发/zip）跑 src 的 TS。
const pkg = resolve(here, '..');
const compiledMain = resolve(pkg, 'dist', 'src', 'kernel', 'main.js');
const tsMain = resolve(pkg, 'src', 'kernel', 'main.ts');
const useCompiled = existsSync(compiledMain);
const mainFile = useCompiled ? compiledMain : tsMain;
const requiredFlags = ['--no-warnings', '--use-system-ca', ...(useCompiled ? [] : ['--experimental-transform-types'])];
const missing = requiredFlags.filter((f) => !process.execArgv.includes(f));
if (missing.length) {
  const r = spawnSync(process.execPath, [...requiredFlags, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

// 不 chdir 进包目录：数据目录默认是「用户运行命令时所在的目录」（npm -g 安装也写用户目录）。
// 随包资源（docker/、scripts/、内置插件）由 src/kernel/paths.ts 的 PACKAGE_ROOT / ACTIVE_ROOT 按模块路径定位。
const args = process.argv.slice(2);
let version = '0.0.0';
try { version = JSON.parse(readFileSync(resolve(pkg, 'package.json'), 'utf8')).version ?? version; } catch { /* 读不到就用占位 */ }

if (args.includes('--help') || args.includes('-h')) {
  console.log(`parallel —— QQ bot harness

用法: parallel [选项]

选项:
  --data-dir <dir>   数据目录（默认当前目录下的 ./data）
  --port <port>      桌面 UI / API 端口（默认 3080）
  --version          版本号
`);
  process.exit(0);
}
if (args.includes('--version')) {
  console.log(`parallel ${version}`);
  process.exit(0);
}

await import(pathToFileURL(mainFile).href);
