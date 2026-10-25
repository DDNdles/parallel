#!/usr/bin/env node
// ============================================================
// prepare-ref —— 从 B 站视频提取一段「参考音色」干声，供唱歌插件使用
//
// 本机不需要装 ffmpeg / yt-dlp / Python：全部在 Docker 里跑。
// 工具镜像首次运行时自动构建（python:3.12-slim + apt ffmpeg + pip yt-dlp），
// 之后直接复用；下载与切片都在容器内完成，只有最后的 wav 落回仓库。
//
// 用法：
//   node scripts/sing/prepare-ref.mjs
//   node scripts/sing/prepare-ref.mjs --start 42 --dur 20
//   node scripts/sing/prepare-ref.mjs --url https://www.bilibili.com/video/BV1fYpn6SEk9 --part 1
//
// 产物默认：data/sing/ref/dafatyu.wav（data/ 已在 .gitignore，不入库）
// ============================================================

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DEFAULT_URL = 'https://www.bilibili.com/video/BV1fYpn6SEk9';
const DEFAULT_OUT = join(ROOT, 'data', 'sing', 'ref', 'dafatyu.wav');
const IMAGE = 'qqbot-sing-prepare-ref:1';

const DOCKERFILE = `FROM python:3.12-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \\
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -U yt-dlp
WORKDIR /work
`;

function log(msg) {
  console.log(`[prepare-ref] ${msg}`);
}

function die(msg, code = 1) {
  console.error(`\n[prepare-ref] ${msg}\n`);
  process.exit(code);
}

function help() {
  console.log(`prepare-ref —— 从 B 站视频提取参考音色干声（Docker 内完成下载、截段、转码）

用法：
  node scripts/sing/prepare-ref.mjs [选项]

选项：
  --url <URL>       视频地址或 BV 号
                    默认：${DEFAULT_URL}
  --part <N>        分 P 序号（B 站多 P 视频用，例如 --part 1）
  --start <秒>      截取起点，默认 30
  --dur <秒>        截取时长，默认 20（参考音色建议 10~30 秒）
  --out <路径>      输出 wav 路径，默认 data/sing/ref/dafatyu.wav
                    必须位于仓库目录内；相对路径按当前工作目录解析，父目录自动创建
  --force           输出文件已存在时覆盖（默认拒绝，避免误覆盖挑好的干声）
  -h, --help        显示本帮助

示例：
  # 默认：BV1fYpn6SEk9 的 30s 起 20s，mono 24000Hz
  node scripts/sing/prepare-ref.mjs

  # 换一段人声更饱满的区间，并覆盖旧文件
  node scripts/sing/prepare-ref.mjs --start 42 --dur 20 --force

说明：
  - 本机不需要 ffmpeg / yt-dlp / Python；首次运行会构建 Docker 镜像
    ${IMAGE}（python:3.12-slim + ffmpeg + yt-dlp），之后复用。
  - 下载的是最佳音质音频流（yt-dlp -f "ba"），截段后转成
    单声道 24000 Hz 16-bit PCM WAV。
  - 脚本不读取、不保存任何账号 Cookie；只尝试公开视频的免登录下载。
    B 站风控要求登录时脚本会如实报错，不会伪造凭据。
  - 带伴奏的原曲会污染 ACE-Step 等模型的音色提取。脚本只负责截取原视频
    音频；若截到的区间仍有伴奏，请换 --start（或先用 UVR5 / Demucs
    做人声分离后再用本脚本截取分离后的干声）。
`);
}

/** 支持 --key value 与 --key=value 两种写法 */
function parseArgs(argv) {
  const opts = {
    url: DEFAULT_URL,
    part: 0,
    start: 30,
    dur: 20,
    out: DEFAULT_OUT,
    force: false,
  };
  const takesValue = new Set(['url', 'part', 'start', 'dur', 'out']);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '-h' || raw === '--help') {
      help();
      process.exit(0);
    }
    if (!raw.startsWith('--')) die(`不认识的参数：${raw}（用 --help 看用法）`);
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    if (key === 'force') {
      opts.force = true;
      continue;
    }
    if (!takesValue.has(key)) die(`不认识的参数：--${key}（用 --help 看用法）`);
    const value = eq >= 0 ? raw.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '') die(`--${key} 需要一个值`);
    opts[key] = value;
  }
  return opts;
}

function toNumber(name, value, { integer = false, min = 0, max = 3600 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) die(`--${name} 必须是数字，收到：${value}`);
  if (n < min || n > max) die(`--${name} 超出范围（${min}..${max}），收到：${value}`);
  if (integer && !Number.isInteger(n)) die(`--${name} 必须是整数，收到：${value}`);
  return n;
}

/** BV1xxxxxxxxx → 完整视频地址；也允许直接给 URL */
function normalizeUrl(input, part) {
  const text = String(input).trim();
  let url;
  try {
    if (/^BV[0-9A-Za-z]{10}$/.test(text)) url = new URL(`https://www.bilibili.com/video/${text}`);
    else if (/^https?:\/\//i.test(text)) url = new URL(text);
    else die(`--url 需要 B 站视频 URL 或 BV 号，收到：${input}`);
  } catch {
    die(`--url 不是合法的视频地址：${input}`);
  }
  if (part > 0) url.searchParams.set('p', String(part));
  return url.href;
}

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', ...opts });
  if (r.error && r.error.code === 'ENOENT') {
    die('找不到 docker 命令。请先安装并启动 Docker Desktop（本机要求 Docker 29.x）。');
  }
  return r;
}

/** Linux/macOS 上以当前用户身份写挂载目录，避免产物变成 root 所有；Windows 无 getuid */
function userArgs() {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return [];
  return ['--user', `${process.getuid()}:${process.getgid()}`];
}

function ensureImage() {
  const probe = docker(['image', 'inspect', IMAGE], { stdio: 'ignore' });
  if (probe.status === 0) return;
  log(`首次运行：构建工具镜像 ${IMAGE}（python:3.12-slim + ffmpeg + yt-dlp，需要联网，约几分钟）…`);
  const dir = mkdtempSync(join(tmpdir(), 'sing-ref-build-'));
  try {
    writeFileSync(join(dir, 'Dockerfile'), DOCKERFILE);
    const r = spawnSync('docker', ['build', '--progress=plain', '-t', IMAGE, dir], { stdio: 'inherit' });
    if (r.status !== 0) {
      die('构建工具镜像失败。请确认 Docker Desktop 已启动且能访问 Docker Hub / PyPI，然后重试。');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function inContainerPath(abs) {
  const rel = relative(ROOT, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    die(`--out 必须位于仓库目录内（${ROOT}），收到：${abs}`);
  }
  return '/work/' + rel.split(sep).join('/');
}

function probeOutput(containerOut) {
  const r = docker([
    'run', '--rm',
    ...userArgs(),
    '-v', `${ROOT}:/work`,
    IMAGE,
    'ffprobe', '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels',
    '-show_entries', 'format=duration,size',
    '-of', 'json',
    containerOut,
  ]);
  if (r.status !== 0) return undefined;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const start = toNumber('start', opts.start, { min: 0, max: 3600 });
  const dur = toNumber('dur', opts.dur, { min: 5, max: 60 });
  const part = opts.part === 0 || opts.part === '0' ? 0 : toNumber('part', opts.part, { integer: true, min: 1, max: 999 });
  const url = normalizeUrl(opts.url, part);
  const outAbs = resolve(String(opts.out));
  const containerOut = inContainerPath(outAbs);

  if (existsSync(outAbs) && !opts.force) {
    die(`输出文件已存在：${outAbs}\n如果这是刚挑好的干声，不要覆盖；确需重做请加 --force。`);
  }

  // Docker 可用性：镜像检查也能顺带发现 daemon 没启动
  const version = docker(['info', '--format', '{{.ServerVersion}}']);
  if (version.status !== 0) {
    die('Docker 守护进程不可用。请启动 Docker Desktop 后重试（docker info 失败）。');
  }
  log(`Docker ${String(version.stdout).trim()}，视频：${url}`);
  log(`截取区间：${start}s 起 ${dur}s，输出：${outAbs}`);

  ensureImage();
  mkdirSync(dirname(outAbs), { recursive: true });

  const script = `
set -euo pipefail
export HOME=/tmp
mkdir -p "$(dirname "$OUT")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "[prepare-ref] 容器内下载最佳音质音频流…"
yt-dlp --no-playlist --no-warnings --newline -f "ba" -o "$work/source.%(ext)s" "$URL"

src="$(find "$work" -maxdepth 1 -type f -name 'source.*' | head -n 1)"
if [ -z "$src" ]; then
  echo "[prepare-ref] yt-dlp 没有产出音频文件" >&2
  exit 40
fi
echo "[prepare-ref] 已下载：$(basename "$src")（$(du -h "$src" | cut -f1)）"
echo "[prepare-ref] 截段并转为 mono 24000 Hz 16-bit PCM wav…"
ffmpeg -hide_banner -loglevel error -nostdin -y -ss "$START" -t "$DUR" -i "$src" -vn -ac 1 -ar 24000 -c:a pcm_s16le "$OUT"
echo "[prepare-ref] 完成"
`;

  const run = docker([
    'run', '--rm',
    ...userArgs(),
    '-v', `${ROOT}:/work`,
    '-w', '/work',
    '-e', `URL=${url}`,
    '-e', `START=${start}`,
    '-e', `DUR=${dur}`,
    '-e', `OUT=${containerOut}`,
    IMAGE,
    'bash', '-lc', script,
  ], { stdio: 'inherit' });

  if (run.status !== 0) {
    die([
      `下载 / 截段失败（docker 退出码 ${run.status ?? '未知'}）。`,
      '常见原因：',
      '  - B 站风控要求登录或验证（412 / 需要 cookies）：本脚本按约定不读取账号 Cookie，',
      '    请换用公开可下载的视频，或在浏览器里确认该视频可免登录播放；',
      '  - 多 P 视频没指定分 P：加 --part 1；',
      '  - Docker 无法联网：确认 Docker Desktop 能访问外网；',
      '  - 镜像里的 yt-dlp 因 B 站改版失效：docker rmi qqbot-sing-prepare-ref:1 后重跑，',
      '    脚本会重新构建并安装最新 yt-dlp。',
      `脚本与工具镜像仍然可用；修好网络后重跑：node scripts/sing/prepare-ref.mjs --start ${start} --dur ${dur}${opts.force ? ' --force' : ''}`,
    ].join('\n'));
  }

  if (!existsSync(outAbs)) die(`容器说完成了，但没找到输出文件：${outAbs}`);
  const st = statSync(outAbs);
  if (st.size <= 44) die(`输出文件太小（${st.size} 字节），不像有效音频：${outAbs}`);

  const probe = probeOutput(containerOut);
  const stream = probe?.streams?.[0];
  const seconds = Number(probe?.format?.duration ?? NaN);
  if (!stream || Number(stream.sample_rate) !== 24000 || Number(stream.channels) !== 1) {
    die(`输出校验失败：期望 mono 24000 Hz，实际 ${JSON.stringify(stream ?? null)}。文件留在 ${outAbs}`);
  }
  if (!Number.isFinite(seconds) || seconds < Math.max(1, dur - 1)) {
    die(`输出时长异常（${Number.isFinite(seconds) ? seconds.toFixed(2) : '未知'} 秒，期望约 ${dur} 秒）。`
      + '很可能是 --start 超出了视频时长，或该视频太短；换小一点的 --start 再试。'
      + `文件留在 ${outAbs}`);
  }

  log('校验通过：');
  log(`  文件：${outAbs}`);
  log(`  大小：${(st.size / 1024 / 1024).toFixed(2)} MiB`);
  log(`  格式：${stream.codec_name} / ${stream.sample_rate} Hz / ${stream.channels} 声道 / 约 ${seconds.toFixed(2)} 秒`);
  log('注意：这是原视频的混音切片，不是纯人声干声；要最佳音色，建议先用 UVR5 / Demucs 分离出 vocals 再填 refAudio。');
  log('把上面的绝对路径填进插件设置 refAudio 即可；若该区间的伴奏仍然明显，换 --start 再截一段。');
}

main();
