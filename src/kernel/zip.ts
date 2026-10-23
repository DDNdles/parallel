// ============================================================
// 最小 ZIP 写入器（store + deflate，UTF-8 文件名）
//
// 为什么不用外部命令：Windows 自带的是 GNU tar（不能出 zip），TeXLive 的 zip
// 不是每台机器都有；引第三方包又要为一次投递加依赖。work 交付包通常只有几 MB，
// 用 node:zlib 拼标准 ZIP 结构足够，也跨平台。
//
// 超过预算（默认 64MB）的文件跳过并记在 skipped 里，调用方仍可退回逐个文件发送。
// ============================================================

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

export interface ZipEntryInput {
  /** 包内路径（正斜杠相对路径） */
  name: string;
  /** 宿主机绝对路径 */
  abs: string;
}

export interface ZipResult {
  /** 真正写进包里的条目数 */
  files: number;
  /** 包文件大小（字节） */
  bytes: number;
  /** 因预算/读取失败被跳过的条目数 */
  skipped: number;
}

/** 单次打包的原始数据总预算：再大就退回逐个文件发送，避免把进程内存打爆 */
export const ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** 这些格式已经压过了，再 deflate 只会白费 CPU */
const STORE_EXT = /\.(png|jpe?g|gif|webp|avif|ico|zip|gz|tgz|bz2|xz|7z|rar|mp4|mov|webm|mp3|m4a|ogg|flac|pdf|docx|xlsx|pptx|jar|woff2?|ttf|otf)$/i;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 当前时刻 → DOS 时间/日期（ZIP 用本地时间，不做时区换算） */
function dosDateTime(d = new Date()): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 把一组文件写成一个 zip。条目名用 UTF-8（置 bit 11），中文文件名在 QQ/桌面上正常显示。
 * 任一文件读不了就跳过；全部跳过时返回 files=0，调用方自行退回。
 */
export function createZipFile(zipAbs: string, entries: ZipEntryInput[], maxTotalBytes = ZIP_MAX_TOTAL_BYTES): ZipResult {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const stamp = dosDateTime();
  let offset = 0;
  let total = 0;
  let files = 0;
  let skipped = 0;

  for (const e of entries) {
    const name = String(e.name ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) { skipped++; continue; }
    let raw: Buffer;
    try {
      const st = statSync(e.abs);
      if (!st.isFile()) { skipped++; continue; }
      if (st.size <= 0 || st.size > maxTotalBytes - total) { skipped++; continue; }
      raw = readFileSync(e.abs);
    } catch { skipped++; continue; }
    total += raw.length;

    const method = STORE_EXT.test(name) ? 0 : 8;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localBlock = Buffer.concat([local, nameBuf, data]);
    locals.push(localBlock);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);            // version made by
    central.writeUInt16LE(20, 6);            // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);            // extra len
    central.writeUInt16LE(0, 32);            // comment len
    central.writeUInt16LE(0, 34);            // disk start
    central.writeUInt16LE(0, 36);            // internal attrs
    central.writeUInt32LE(0, 38);            // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    offset += localBlock.length;
    files++;
  }

  if (files === 0) return { files: 0, bytes: 0, skipped };

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files, 8);
  end.writeUInt16LE(files, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const out = Buffer.concat([...locals, centralBuf, end]);
  writeFileSync(zipAbs, out);
  return { files, bytes: out.length, skipped };
}
