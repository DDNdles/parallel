import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * QQ 表情运行时资源：`data/face/<id>.webp`。
 *
 * 表情美术版权归腾讯所有，**不进 git、不进发布包**；内核在首次需要时从用户本机
 * 协议端发行包自带的 `webui/face`（128px APNG）转码生成（64px 静态 WebP）。
 * 没拉协议端 / 没装 ffmpeg 时静默跳过——前端对缺图有「回落中文名」兜底。
 */

export function faceDir(dataDir: string): string {
  return join(dataDir, 'face');
}

/** 同一时刻只跑一轮转码 */
let running: Promise<number> | null = null;

export function ensureFaces(dataDir: string, log: { info: (m: string) => void; warn: (m: string) => void }): Promise<number> {
  if (!running) running = run(dataDir, log).finally(() => { running = null; });
  return running;
}

async function run(dataDir: string, log: { info: (m: string) => void; warn: (m: string) => void }): Promise<number> {
  const outDir = faceDir(dataDir);
  const srcDir = join(dataDir, 'llbot', 'bin', 'llbot', 'webui', 'face');
  if (!existsSync(srcDir)) return 0;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const existing = new Set(readdirSync(outDir).filter((f) => f.endsWith('.webp')));
  const pngs = readdirSync(srcDir)
    .filter((f) => /^\d+\.png$/.test(f))
    .filter((f) => !existing.has(`${f.replace(/\.png$/, '')}.webp`));
  if (!pngs.length) return existing.size;

  const bundled = join(dataDir, 'bin', 'ffmpeg.exe');
  let ffmpeg = 'ffmpeg';
  if (existsSync(bundled)) ffmpeg = bundled;
  else {
    const probe = await new Promise<boolean>((res) => execFile('ffmpeg', ['-version'], { windowsHide: true, timeout: 5000 }, (e) => res(!e)));
    if (!probe) {
      log.warn('QQ 表情转码跳过：本机没有 ffmpeg（桌面端会用中文名代替表情图）。装好 ffmpeg 后重启内核可再生成。');
      return existing.size;
    }
  }

  const queue = [...pngs];
  let converted = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      const id = f.replace(/\.png$/, '');
      const out = join(outDir, `${id}.webp`);
      try {
        await new Promise<void>((res, rej) => execFile(ffmpeg, [
          '-y', '-loglevel', 'error', '-i', join(srcDir, f),
          '-vf', 'scale=64:64:flags=lanczos', '-frames:v', '1',
          '-c:v', 'libwebp', '-quality', '80', out,
        ], { windowsHide: true }, (e) => (e ? rej(e) : res())));
        converted++;
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (converted > 0) log.info(`QQ 表情资源就绪：data/face（新增 ${converted} 个）`);
  if (failed > 0) log.warn(`QQ 表情转码有 ${failed} 张失败（不影响其余，缺的会显示中文名）`);
  return existing.size + converted;
}
