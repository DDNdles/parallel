#!/usr/bin/env node
// parallel 启动器：Node ≥ 24 直接运行 TypeScript 源码（--experimental-transform-types），
// 支持参数属性等完整 TS 语法，无需构建步骤。
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 若未带 transform 标志则自我重启动一次
// --use-system-ca：用操作系统信任库校验证书（Node 自带 CA 缺不少国内站点的中间证书，
// 例如中科大一〇七平台的 SCOW 门户链就缺；插件经 HTTPS 调它时否则 UNABLE_TO_VERIFY_LEAF_SIGNATURE）
if (!process.execArgv.some((a) => a.includes('transform-types'))) {
  const r = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--use-system-ca', ...process.argv.slice(1)], {
    stdio: 'inherit',
  });
  process.exit(r.status ?? 0);
}

const here = dirname(fileURLToPath(import.meta.url));
process.chdir(resolve(here, '..'));

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`parallel —— QQ bot harness

用法: node bin/parallel.js [选项]

选项:
  --data-dir <dir>   数据目录（默认 ./data）
  --port <port>      桌面 UI / API 端口（默认 3080）
  --version          版本号
`);
  process.exit(0);
}
if (args.includes('--version')) {
  console.log('parallel 0.1.0');
  process.exit(0);
}

await import(pathToFileURL(resolve(here, '../src/kernel/main.ts')).href);
