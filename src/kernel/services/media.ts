import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 媒体兜底转码：QQ 发来的语音常是 Silk / AMR，而 OpenAI 系的 input_audio 只认
 * mp3|wav|ogg|flac|pcm16，直接塞过去对端会 400。这里在本机把它转成 16k 单声道 wav。
 *
 * 依赖外部 ffmpeg（PATH 里能找到，或用 PARALLEL_FFMPEG 指定路径）。找不到不静默假装成功：
 * 抛 MediaError，由调用方记进报错中心，用户在「报错」页能看到语音为什么没被读懂。
 */

export class MediaError extends Error {}

const WAV_MAX_BYTES = 20 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;

let ffmpegBin: string | null | undefined;

/** 找 ffmpeg：PARALLEL_FFMPEG 优先，其次 PATH。结果缓存，探测只跑一次 */
export function findFfmpeg(): string | null {
  if (ffmpegBin !== undefined) return ffmpegBin;
  const env = (process.env.PARALLEL_FFMPEG ?? '').trim();
  if (env && existsSync(env)) return (ffmpegBin = env);
  const bin = env || 'ffmpeg';
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { timeout: 5000 });
  ffmpegBin = probe.status === 0 ? bin : null;
  return ffmpegBin;
}

function cacheDir(): string {
  const dir = join(tmpdir(), 'parallel-media');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 清掉一小时前的转码产物（每次落新文件时顺手扫一遍，不引定时器） */
function sweepCache(): void {
  const now = Date.now();
  for (const name of readdirSync(cacheDir())) {
    if (!name.endsWith('.wav')) continue;
    const f = join(cacheDir(), name);
    try { if (now - statSync(f).mtimeMs > CACHE_TTL_MS) rmSync(f, { force: true }); } catch { /* 正被占用就留给下次 */ }
  }
}

/** 任意容器 → 16k 单声道 wav；ffmpeg 缺失或解码失败都抛带原因的 MediaError */
export async function toWav(buf: Buffer, mime: string): Promise<Buffer> {
  const bin = findFfmpeg();
  if (!bin) throw new MediaError(`本机没有 ffmpeg，无法把 ${mime || '未知格式'} 语音转成模型认得的 wav（装 ffmpeg，或用 PARALLEL_FFMPEG 指定其路径）`);
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1']);
    const chunks: Buffer[] = [];
    let err = '';
    let size = 0;
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > WAV_MAX_BYTES) { child.kill(); reject(new MediaError('转码结果超过 20MB，已放弃')); return; }
      chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-400); });
    child.on('error', (e) => reject(new MediaError(`ffmpeg 启动失败: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new MediaError(`ffmpeg 退出码 ${code}：${err || '（无输出——该文件可能是 QQ Silk，协议端未转码）'}`));
    });
    child.stdin.end(buf);
  });
}

/** 转码 + 按内容寻址落盘（同一条语音在历史里重放时不重复转），返回绝对路径 */
export async function toWavFile(buf: Buffer, mime: string): Promise<string> {
  const key = createHash('sha1').update(buf).digest('hex').slice(0, 24);
  const f = join(cacheDir(), `${key}.wav`);
  if (existsSync(f)) return f;
  const wav = await toWav(buf, mime);
  const hit = readdirSync(cacheDir()).length;
  writeFileSync(f, wav);
  if (hit > 8) sweepCache();
  return f;
}

export async function fetchBuffer(url: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new MediaError(`下载失败 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length || buf.length > maxBytes) throw new MediaError(`文件为空或超过 ${Math.round(maxBytes / 1048576)}MB`);
  return buf;
}
