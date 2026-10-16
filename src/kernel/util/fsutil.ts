import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * 原子化 JSON 落盘（红线 §3.4）：
 * 写 .tmp → rename 覆盖 → 保留滚动 .bak（3 份，rotate:false 关掉）。
 * 所有配置写入必须走这里，禁止运行时手改文件。
 * 密钥文件必须 rotate:false：轮转副本会把旧密钥长期留在盘上（.bak 一份都不该有）。
 */
export function atomicWriteJson(file: string, data: unknown, opts: { rotate?: boolean } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  if ((opts.rotate ?? true) && existsSync(file)) {
    try { rotateBackups(file); } catch { /* 备份失败不阻塞主写入 */ }
  }
  renameSync(tmp, file);
}

function rotateBackups(file: string): void {
  const b3 = file + '.bak3', b2 = file + '.bak2', b1 = file + '.bak';
  if (existsSync(b2)) copyFileSync(b2, b3);
  if (existsSync(b1)) copyFileSync(b1, b2);
  copyFileSync(file, b1);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch (e) {
    // 主文件损坏时尝试备份
    for (const bak of [file + '.bak', file + '.bak2', file + '.bak3']) {
      try {
        if (existsSync(bak)) return JSON.parse(readFileSync(bak, 'utf-8')) as T;
      } catch { /* 继续尝试 */ }
    }
    return fallback;
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

export { join, dirname };
