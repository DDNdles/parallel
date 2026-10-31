#!/usr/bin/env node
/**
 * 发布打包：把 parallel 打成可直接分发的 zip。
 *
 * 红线（用户明令）：发布的程序里不能带任何私人 key。
 *  - data/ 整目录绝不进包（secrets.json / 轮转副本 / QQ 登录态 / 聊天记录 / 记忆库）；
 *  - 打包前对每个入包文件做私钥自检：secrets.json 里的真实值逐个比对 + 通用 key 形态扫描，
 *    命中即列出文件行号并**中止打包**（宁可不发，不带 key 出门）。
 *
 * 用法：node scripts/pack-release.mjs [--slim] [--no-node]
 *  默认 = 零依赖绿色版：node_modules + 内置 win-x64 Node 运行时（runtime/node.exe），
 *  解压双击就能跑，不要求目标机装过 Node。
 *  --slim   不带 node_modules / 运行时（开发自测用，目标机自行 npm ci）
 *  --no-node 带 node_modules 但不带 Node 运行时
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const slim = process.argv.includes('--slim');
const withNode = !slim && !process.argv.includes('--no-node');
const allowDirty = process.argv.includes('--allow-dirty');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `parallel-v${pkg.version}`;
const release = join(root, 'release');
const stage = join(release, 'stage', name);

// ---------- 干净树闸门：发布包必须能由仓库复现 ----------
// 以前直接 cpSync 工作区，未提交的改动（含只有本机才有的插件/私人人格）会静默进包。
// 非 git 环境（用户解压 zip 后自己再打包）没有可校验的基准，跳过。
try {
  const dirty = execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (dirty && !allowDirty) {
    console.error('[pack] 工作区有未提交改动，发布包必须与仓库一致。先提交，或显式加 --allow-dirty：');
    console.error(dirty.split('\n').slice(0, 20).join('\n'));
    process.exit(1);
  }
} catch { /* 不是 git 仓库：跳过 */ }

// ---------- 收集本机已知密钥值（data/secrets.json 若存在） ----------
const known = [];
const secretsPath = join(root, 'data', 'secrets.json');
if (existsSync(secretsPath)) {
  try {
    const s = JSON.parse(readFileSync(secretsPath, 'utf8'));
    const push = (label, v) => { if (typeof v === 'string' && v.length >= 8) known.push({ label, v }); };
    for (const [k, v] of Object.entries(s)) if (typeof v === 'string') push(k, v);
    for (const [p, v] of Object.entries(s.providerKeys ?? {})) push(`providerKeys.${p}`, v);
    for (const [p, m] of Object.entries(s.pluginSecrets ?? {})) for (const [k, v] of Object.entries(m ?? {})) push(`pluginSecrets.${p}.${k}`, v);
  } catch { /* secrets 读不了就不做已知值比对，通用扫描仍在 */ }
}
// 通用 key 形态（左侧带非 key 字符边界，避免 task-xxx 这类误报）
const GENERIC = [
  { label: 'sk- 形态', re: /(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/ },
  { label: 'tvly- 形态', re: /(^|[^A-Za-z0-9_-])tvly-[A-Za-z0-9]{16,}/ },
  { label: 'JWT 形态', re: /eyJ0eXAiOiJKV1Qi[A-Za-z0-9._-]{20,}/ },
];

// ---------- 入包清单（白名单式，新增顶层内容要显式加进来） ----------
// logos/ 是 3MB 设计过程稿、运行时零引用，不再随包（仓库里保留）。
const INCLUDE_DIRS = ['bin', 'dist', 'src', 'examples', 'docker', 'ui', 'scripts', 'test'];
const INCLUDE_FILES = ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'parallel.cmd', 'parallel.sh', 'README.md'];
const SKIP_IN_MODULES = new Set(['.cache', '.package-lock.json']);
// 无论清单怎么改都绝不入包（第二道保险，白名单之外理论上根本不会被复制）
// ref/ 是个人的参考音色音频；__pycache__/pyc 是 docker 里跑出来的字节码。
const FORBIDDEN = [
  /^data(\/|\\|$)/, /\.bak/, /\.log$/, /\.tmp$/, /(^|\/|\\)\.env/,
  /^docker[\\/][^\\/]+[\\/]ref([\\/]|$)/,
  /[\\/]__pycache__([\\/]|$)/, /\.pyc$/,
  // QQ 表情美术版权归腾讯：不随仓库/发布包走，运行时从本机协议端发行包生成到 data/face
  /^ui[\\/]face([\\/]|$)/,
  // dist 里只允许编译产物：历史残留的 stage/tgz 绝不能进包
  /^dist[\\/]stage([\\/]|$)/,
  /\.tgz$/,
  // 翻唱（cover）是私人插件：跑自部署服务与个人音色，不随发布包出门（仓库/开发目录保留，npm 包 files 里同步剔除）
  /^src[\\/]plugins[\\/]cover([\\/]|$)/,
  /^dist[\\/]src[\\/]plugins[\\/]cover([\\/]|$)/,
];

if (!existsSync(join(root, 'ui', 'index.html'))) {
  console.error('[pack] ui/ 还没有构建产物：先在 web/ 里 npm run build，再打包。');
  process.exit(1);
}

// 只清自己的 stage：release/ 里可能已经有 npm pack 先放进来的 tgz，不能整目录清掉
rmSync(join(release, 'stage'), { recursive: true, force: true });
mkdirSync(join(release, 'stage'), { recursive: true });
mkdirSync(stage, { recursive: true });

let files = 0;
/** 复制一个顶层条目，边复制边记录入包文件（node_modules 里跳过缓存杂物） */
function copyTop(src) {
  const dest = join(stage, src);
  cpSync(join(root, src), dest, {
    recursive: true,
    filter: (f) => {
      const rel = relative(root, f);
      const base = f.split(/[\\/]/).pop();
      if (FORBIDDEN.some((re) => re.test(rel))) { console.error(`[pack] 拒绝入包: ${rel}`); return false; }
      if (rel.startsWith('node_modules')) {
        if (SKIP_IN_MODULES.has(base)) return false;
        if (statSync(f).isDirectory() && (base === '.git' || base === 'test')) return false;
      }
      return true;
    },
  });
}

for (const d of INCLUDE_DIRS) {
  if (!existsSync(join(root, d))) continue;
  copyTop(d);
}
for (const f of INCLUDE_FILES) {
  if (!existsSync(join(root, f))) continue;
  cpSync(join(root, f), join(stage, f));
  files++;
}
if (!slim && existsSync(join(root, 'node_modules'))) copyTop('node_modules');

// ---------- 零依赖：内置 Node 运行时 ----------
// 双击路线不该要求用户先装 Node ≥ 24。官方 win-x64 node.exe 进包（runtime/node.exe），
// SHA256 对 nodejs.org 的 SHASUMS256.txt 核对后才入包；parallel.cmd 会优先用它。
// 版本与开发/CI 同代（Node 24），升级这里要顺手跟着升。下载缓存在 release/cache/。
if (withNode) {
  const NODE_VERSION = 'v24.18.0';
  const cacheDir = join(release, 'cache');
  const exeCache = join(cacheDir, `node-${NODE_VERSION}-win-x64.exe`);
  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(exeCache)) {
    console.log(`[pack] 下载 Node 运行时 ${NODE_VERSION}（win-x64）…`);
    const url = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[pack] node.exe 下载失败：HTTP ${res.status}`);
      process.exit(1);
    }
    writeFileSync(exeCache, Buffer.from(await res.arrayBuffer()));
  }
  const sums = await (await fetch(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find((l) => l.endsWith('win-x64/node.exe'))?.split(/\s+/)[0];
  const got = createHash('sha256').update(readFileSync(exeCache)).digest('hex');
  if (!want || want !== got) {
    console.error(`[pack] node.exe SHA256 不符（期望 ${want ?? '未找到'}，实际 ${got}），已中止`);
    process.exit(1);
  }
  mkdirSync(join(stage, 'runtime'), { recursive: true });
  cpSync(exeCache, join(stage, 'runtime', 'node.exe'));
  files++;
}

// ---------- 发布包瘦身 + 脚本对齐 ----------
// devDependencies（typescript 几十 MB）不必随包；随包 package.json 里的 build/typecheck
// 依赖 web/ 源码与 tsc（都不在包里），留着只会让人一敲就报错。
if (!slim) {
  for (const dep of Object.keys(pkg.devDependencies ?? {})) {
    rmSync(join(stage, 'node_modules', dep), { recursive: true, force: true });
  }
  for (const dep of Object.keys(pkg.devDependencies ?? {})) {
    if (!dep.startsWith('@')) continue;
    const scopeDir = join(stage, 'node_modules', dep.split('/')[0]);
    if (existsSync(scopeDir) && readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true, force: true });
  }
}
const stagedPkgPath = join(stage, 'package.json');
if (existsSync(stagedPkgPath)) {
  const sp = JSON.parse(readFileSync(stagedPkgPath, 'utf8'));
  delete sp.devDependencies;
  if (sp.scripts) {
    delete sp.scripts.build;
    delete sp.scripts.typecheck;
  }
  writeFileSync(stagedPkgPath, JSON.stringify(sp, null, 2) + '\n');
}

// ---------- 私钥自检：逐文件扫已知值 + 通用形态 ----------
const scanTargets = [];
(function listFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p);
    else scanTargets.push(p);
  }
})(stage);

const hits = [];
for (const p of scanTargets) {
  files++;
  let buf;
  try { buf = readFileSync(p); } catch { continue; }
  if (buf.includes(0)) continue;                       // 二进制跳过
  if (buf.byteLength > 5 * 1024 * 1024) continue;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const rel = relative(stage, p);
  lines.forEach((line, i) => {
    for (const k of known) {
      if (line.includes(k.v)) hits.push(`${rel}:${i + 1}  已知密钥 ${k.label}`);
    }
    for (const g of GENERIC) {
      if (g.re.test(line)) hits.push(`${rel}:${i + 1}  ${g.label}`);
    }
  });
}

if (hits.length) {
  console.error('[pack] 私钥自检未通过，已中止（staging 保留在 dist/stage 供排查）:');
  console.error(hits.slice(0, 40).join('\n'));
  if (hits.length > 40) console.error(`…共 ${hits.length} 处`);
  process.exit(1);
}

// ---------- 压缩 ----------
const zip = join(release, `${name}.zip`);
if (process.platform === 'win32') {
  // execSync 裸写 tar 会先命中 Git 自带的 GNU tar（不认 -a 的 .zip 后缀，会掉进
  // Compress-Archive 兜底并丢掉顶层目录），所以显式用 System32 的 bsdtar。
  const sysTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  try {
    execSync(`"${sysTar}" -a -c -f "${zip}" -C "${join(release, 'stage')}" "${name}"`, { stdio: 'pipe' });
  } catch {
    // 兜底必须打目录本身（dir\* 会丢掉顶层文件夹，解压撒一地）
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${join(release, 'stage', name)}' -DestinationPath '${zip}' -Force"`, { stdio: 'pipe' });
  }
} else {
  // linux 的 GNU tar 不认 .zip 后缀（-a 会静默打成裸 tar，v0.2.0/0.2.1 首打就栽在这）：
  // 优先 zip CLI，没有就用 python3 的 zipfile 模块
  try {
    execSync(`zip -r -q "${zip}" "${name}"`, { cwd: join(release, 'stage'), stdio: 'pipe' });
  } catch {
    execSync(`python3 -m zipfile -c "${zip}" "${name}"`, { cwd: join(release, 'stage'), stdio: 'pipe' });
  }
}
rmSync(join(release, 'stage'), { recursive: true, force: true });

// 打出来必须是真 zip（PK 魔数）且带顶层目录前缀：GNU tar / Compress-Archive 两次事故的后手
{
  const buf = readFileSync(zip);
  if (buf.subarray(0, 2).toString('binary') !== 'PK') {
    console.error('[pack] 产物不是有效 zip（魔数不对），已中止。');
    process.exit(1);
  }
  // 首个本地文件头：偏移 26/28 是文件名/扩展字段长度（LE16），随后是名字
  const nameLen = buf.readUInt16LE(26);
  const first = buf.subarray(30, 30 + nameLen).toString('utf8');
  if (!first.startsWith(`${name}/`)) {
    console.error(`[pack] zip 首条目是 "${first}"，缺顶层目录 ${name}/（解压会撒一地），已中止。`);
    process.exit(1);
  }
}

const size = statSync(zip).size;
console.log(`[pack] 完成: ${relative(root, zip)}`);
console.log(`[pack] 入包文件 ${files} 个，zip ${(size / 1024 / 1024).toFixed(1)} MB，私钥自检通过（已知值 ${known.length} 条 + 通用形态 ${GENERIC.length} 条）`);
if (slim) console.log('[pack] slim 模式：未带 node_modules，目标机需 npm ci');
