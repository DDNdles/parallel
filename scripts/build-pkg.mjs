#!/usr/bin/env node
/**
 * 编译 npm 包运行时：tsc → dist/ + 复制非 TS 资产（plugin.json、agents/*.md、personas、*.mjs…）。
 *
 * 为什么必须编译：Node 拒绝对 node_modules 里的 TS 做类型剥离
 * （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING，无旗标可绕），npm 安装的包必须带编译产物；
 * bin/parallel.js 优先跑 dist/src/kernel/main.js，开发/zip（不在 node_modules）仍直跑 src 的 TS。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');

rmSync(outDir, { recursive: true, force: true });
const r = spawnSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) {
  console.error('[build:pkg] tsc 编译失败');
  process.exit(r.status ?? 1);
}

/** 把 src/examples 里的非 TS 资产原样拷进 dist（运行时要按相对路径读它们） */
function copyAssets(fromDir, toDir) {
  if (!existsSync(fromDir)) return;
  mkdirSync(toDir, { recursive: true });
  for (const e of readdirSync(fromDir, { withFileTypes: true })) {
    const src = join(fromDir, e.name);
    const dst = join(toDir, e.name);
    if (e.isDirectory()) { copyAssets(src, dst); continue; }
    if (e.name.endsWith('.ts') || e.name.endsWith('.tsbuildinfo')) continue;
    cpSync(src, dst);
  }
}
copyAssets(join(root, 'src'), join(outDir, 'src'));
copyAssets(join(root, 'examples'), join(outDir, 'examples'));

if (!existsSync(join(outDir, 'src', 'kernel', 'main.js'))) {
  console.error('[build:pkg] 产物异常：dist/src/kernel/main.js 不存在');
  process.exit(1);
}
let files = 0;
(function count(d) { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) count(join(d, e.name)); else files++; } })(outDir);
console.log(`[build:pkg] dist/ 就绪（${files} 个文件）`);
