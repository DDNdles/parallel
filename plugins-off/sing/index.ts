import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatRef, MsgSegment, PluginContext, Role } from '../../kernel/types.ts';
import { clamp, newId, sleep } from '../../kernel/util/misc.ts';

// ============================================================
// sing —— 用云 API 让 bot 用自己的音色唱歌
//
// 不自带模型：用户在插件设置里填自己的 API Key / 参考音频（与 imagegen
// 「用户自己的 Gemini Key 画图」同一产品口径）。产物是音频字节，写进
// pluginDataDir/sing/，再作为 record 段直接发进当前会话。
//
// 内置 preset（调研结论，2026-10）：
//  - fal-ai-ace-step（默认）：唯一真正打通「参考音频克隆音色 + 歌词演唱」的
//    商业云 API。提交到队列 → 轮询 status_url → 取 response_url 里的音频 URL
//    → 下载。来源：https://fal.ai/models/fal-ai/ace-step/audio-to-audio/api
//    官方 OpenAPI（https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ace-step/audio-to-audio）
//    把 original_tags 标成**必填**（调研结论漏了它），这里用目标 tags 兜底传入。
//  - minimax-music：同步返回 data.audio（24 小时有效的下载 URL）→ 下载。
//    来源：https://platform.minimaxi.com/docs/api-reference/music-generation.md
//    注意：MiniMax 2026-08-20 起不再给新用户开音乐接口，且 music-cover 是
//    整曲翻唱、不是提取单一音色唱新歌；保留它只为已开通的老用户。
//  - custom / 未命中 preset：POST {baseUrl}/generate，body {lyrics,tags,seconds}，
//    Authorization: Bearer apiKey，响应体直接就是音频字节（给自部署 ACE-Step 留的接法）。
//
// 被淘汰的供应商（Fish Audio / 火山引擎 / HF Space）不内置：Fish 只是 TTS，
// 加 [singing] 也只是唱腔念白；火山歌唱合成只支持 3 个系统音色 + 15 秒儿歌
// 模板；HF Space 依赖不稳定的 Gradio SSE 且公共队列经常排队/崩溃。
//
// 关键坑：adapter 的 localizeSegment 只把 image 的本地路径转 file://，
// record 不会自动转 —— 这里必须自己给 pathToFileURL(abs).href。
//
// REST：/api/plugin/sing/{status,records,audio,preview,send}（桌面端「唱歌」页；
// records 只留最近 50 条成功产物，audio 只认这些记录里的文件名，preview 只落盘不发送）。
// ============================================================

const DEFAULT_PROVIDER = 'fal-ai-ace-step';
const DEFAULT_TAGS = 'cute female vocal, pop, bright';
/** 歌词硬上限：一次请求别把 body 撑爆（MiniMax 另有 1000 的官方上限，按 provider 单独校验） */
const LYRICS_MAX = 3000;
/** 风格描述上限（MiniMax prompt 的官方上限是 300 字符） */
const TAGS_MAX = 300;
/** MiniMax music-cover 官方下限：prompt / lyrics 都至少要 10 个字符，否则接口报 2013 */
const MINIMAX_PROMPT_MIN = 10;
const MINIMAX_LYRICS_MIN = 10;
/** MiniMax music-cover 歌词官方上限（与全局 LYRICS_MAX 不同） */
const MINIMAX_LYRICS_MAX = 1000;
/** 参考音频体积上限：base64 之后还要涨 1/3，再大只会白白超时 */
const REF_MAX_BYTES = 20 * 1024 * 1024;
/** 产物只留最近 24 小时：云 API 回来的是整首歌，攒着会把数据目录吃满 */
const KEEP_MS = 24 * 3600_000;

const USAGE_PREFIX = 'usage:';
const COOLDOWN_KEY = 'cooldown';
const LAST_AT_KEY = 'lastAt';
/** 桌面端记录：最近 50 条成功生成 + 最近 10 条失败（失败只留排障够用的一条，不让 state 无限长） */
const RECORDS_KEY = 'records';
const ERRORS_KEY = 'lastErrors';
const RECORDS_MAX = 50;
const ERRORS_MAX = 10;

const FAL_SUBMIT = 'https://queue.fal.run/fal-ai/ace-step/audio-to-audio';
const MINIMAX_SUBMIT = 'https://api.minimax.cn/v1/music_generation';

export type AudioMime = 'audio/mpeg' | 'audio/wav';

// ============================================================
// 纯工具函数（不碰 ctx：方便测试与热重载）
// ============================================================

/** 本地时区的自然日键，零点翻篇（额度按它分桶） */
export function dayKeyOf(ts = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 按文件头识别**产物**音频类型：只收 QQ 语音最稳的 mp3/wav，不认扩展名 */
export function sniffAudioMime(buf: Buffer): AudioMime | undefined {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  // ID3 标签头
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  // 无 ID3 的 MPEG 帧同步：11 位全 1
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  return undefined;
}

/** 参考音频可以比产物宽：ACE-Step 收 mp3/wav/ogg/m4a/aac */
function sniffRefMime(buf: Buffer): string | undefined {
  const out = sniffAudioMime(buf);
  if (out) return out;
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  // ADTS：12 位同步 + layer=00
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xf6) === 0xf0) return 'audio/aac';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  return undefined;
}

function mimeFromName(name: string): string | undefined {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m?.[1];
  if (!ext) return undefined;
  const map: Record<string, string> = {
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  };
  return map[ext];
}

/** 从 content-type 兜底识别产物（文件头认不出时才用） */
function mimeFromContentType(contentType?: string): AudioMime | undefined {
  const ct = String(contentType ?? '').toLowerCase();
  if (ct.includes('audio/wav') || ct.includes('audio/x-wav') || ct.includes('audio/wave')) return 'audio/wav';
  if (ct.includes('audio/mpeg') || ct.includes('audio/mp3')) return 'audio/mpeg';
  return undefined;
}

// MPEG 音频帧头的码率表（下标 = 4bit bitrate index；0=free，15=invalid）
// 来源：ISO/IEC 11172-3 / 13818-3 的 Table 2.4.2.3-1（MPEG1）与 2.4.2.3-2（MPEG2/2.5）
const MPEG1_BITRATES: Record<number, number[]> = {
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],   // Layer I
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],      // Layer II
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],       // Layer III
};
const MPEG2_BITRATES: Record<number, number[]> = {
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],      // Layer I
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],           // Layer II
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],           // Layer III
};
const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],   // MPEG1
  2: [22050, 24000, 16000],   // MPEG2
  0: [11025, 12000, 8000],    // MPEG2.5
};

interface MpegFrameInfo {
  bitrateKbps: number;
  /** 整帧长度（字节），用来验证下一帧是否也是同步头 */
  length: number;
  /** 这一层/版本每帧的固定样本数（VBR 逐帧累计时长要用） */
  samplesPerFrame: number;
  sampleRate: number;
}

/** 解析 offset 处的一个 MPEG 帧头；不是有效帧返回 undefined（不做任何解码） */
function mpegFrameAt(buf: Buffer, offset: number): MpegFrameInfo | undefined {
  if (offset < 0 || offset + 4 > buf.length) return undefined;
  if (buf[offset] !== 0xff || (buf[offset + 1]! & 0xe0) !== 0xe0) return undefined;

  const versionBits = (buf[offset + 1]! >> 3) & 0x03;   // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=保留
  const layerBits = (buf[offset + 1]! >> 1) & 0x03;     // 3=Layer I, 2=Layer II, 1=Layer III
  if (versionBits === 1 || layerBits === 0) return undefined;

  const bitrateIndex = (buf[offset + 2]! >> 4) & 0x0f;
  const sampleRateIndex = (buf[offset + 2]! >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined;

  const table = versionBits === 3 ? MPEG1_BITRATES : MPEG2_BITRATES;
  const bitrateKbps = table[layerBits]![bitrateIndex]!;
  const sampleRate = MPEG_SAMPLE_RATES[versionBits]![sampleRateIndex]!;
  if (!bitrateKbps || !sampleRate) return undefined;

  const padding = (buf[offset + 2]! >> 1) & 0x01;
  // Layer I：4 字节槽 × (12 × bitrate / sampleRate + padding)；
  // Layer II / MPEG1 Layer III：144；MPEG2/2.5 Layer III：72
  let length: number;
  let samplesPerFrame: number;
  if (layerBits === 3) {
    length = Math.floor((12 * bitrateKbps * 1000) / sampleRate + padding) * 4;
    samplesPerFrame = 384;
  } else {
    const coef = versionBits === 3 || layerBits === 2 ? 144 : 72;
    length = Math.floor((coef * bitrateKbps * 1000) / sampleRate) + padding;
    samplesPerFrame = layerBits === 2 ? 1152 : versionBits === 3 ? 1152 : 576;
  }
  if (length < 4) return undefined;
  return { bitrateKbps, length, samplesPerFrame, sampleRate };
}

/** ID3v2 标签总长度（含 10 字节头与可选 footer）；没有标签返回 0，标签声明越界返回 undefined */
function id3v2Length(buf: Buffer): number | undefined {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  const total = 10 + size + ((buf[5]! & 0x10) !== 0 ? 10 : 0);
  return total <= buf.length ? total : undefined;
}

/** 在 ID3 标签之后找第一个 MPEG 帧，然后顺着帧链走到底：数帧、看码率是否恒定、有没有走到文件尾。
 *  CBR 用首帧码率就准；VBR（Xing/LAME 输出常见）首帧码率不代表整段，必须逐帧累计时长。 */
function walkMpegFrames(buf: Buffer, start: number): {
  frames: number;
  sampleRate: number;
  samplesPerFrame: number;
  /** 全程同一码率（CBR） */
  uniform: boolean;
  firstBitrateKbps: number;
  /** 帧链走到了文件尾（容一个 128 字节 ID3v1 尾标签）；断链说明中间有垃圾字节，帧数只能当参考 */
  complete: boolean;
  audioBytes: number;
} | undefined {
  // 只在文件头 64KB 内找第一帧：正常 mp3 第一帧就在最前面，扫太远只会把随机字节认成帧头
  const limit = Math.min(buf.length - 4, start + 64 * 1024);
  for (let off = Math.max(0, start); off <= limit; off++) {
    const first = mpegFrameAt(buf, off);
    if (!first) continue;
    const nextOff = off + first.length;
    // 单帧到尾（容 ID3v1 尾标签）才允许只凭一帧认头；后面还有字节时要求第二帧也同步，
    // 否则随机字节凑出的假帧头会把整段带偏
    if (nextOff < buf.length - 128 && !mpegFrameAt(buf, nextOff)) continue;
    let frames = 0;
    let bitrate = 0;
    let uniform = true;
    let cursor = off;
    for (;;) {
      const f = mpegFrameAt(buf, cursor);
      if (!f) break;
      frames += 1;
      if (bitrate === 0) bitrate = f.bitrateKbps;
      else if (f.bitrateKbps !== bitrate) uniform = false;
      cursor += f.length;
      if (cursor + 4 > buf.length) break;
    }
    return {
      frames,
      sampleRate: first.sampleRate,
      samplesPerFrame: first.samplesPerFrame,
      uniform,
      firstBitrateKbps: bitrate,
      complete: cursor >= buf.length - 128,
      audioBytes: buf.length - off,
    };
  }
  return undefined;
}

/** 按 WAV 的 fmt 块 byteRate 与 data 块长度估时长（不依赖固定的 44 字节头） */
function wavSeconds(buf: Buffer): number | undefined {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return undefined;
  }
  let off = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (size === 0) break;   // 坏块（size=0）会让偏移原地踏步，直接当解析失败
    if (id === 'fmt ' && size >= 12 && body + size <= buf.length) {
      byteRate = buf.readUInt32LE(body + 8);
    } else if (id === 'data') {
      // 流式写入的 wav 常把 data size 写成 0xFFFFFFFF：按文件剩余字节截断
      dataBytes = Math.min(size, buf.length - body);
    }
    off = body + size + (size % 2);   // chunk 按偶数字节对齐
  }
  if (!byteRate || dataBytes <= 0) return undefined;
  return Math.max(1, Math.round(dataBytes / byteRate));
}

export interface SecondsEstimate {
  seconds: number;
  /** false = 头部解析失败，退回旧的粗估法；工具回复此时不要写「约 N 秒」 */
  exact: boolean;
}

/** 估个时长给模型一句「约 N 秒」：只解析头部，不为了报时长去解码整首歌 */
export function estimateSeconds(buf: Buffer, mime: AudioMime): SecondsEstimate {
  if (mime === 'audio/wav') {
    const seconds = wavSeconds(buf);
    if (seconds !== undefined) return { seconds, exact: true };
    return { seconds: Math.max(1, Math.round(buf.length / 32000)), exact: false };   // 16kHz / 16bit / 单声道兜底
  }
  const id3 = id3v2Length(buf);
  if (id3 !== undefined) {
    const walk = walkMpegFrames(buf, id3);
    if (walk) {
      // CBR：首帧码率 × 全部音频字节（尾标签 ≤128 字节的误差可忽略）
      if (walk.uniform) {
        return { seconds: Math.max(1, Math.round((walk.audioBytes * 8) / (walk.firstBitrateKbps * 1000))), exact: true };
      }
      // VBR：每帧样本数固定，逐帧累计就是真时长；链没走完则是低估，只当参考值
      const seconds = Math.max(1, Math.round((walk.frames * walk.samplesPerFrame) / walk.sampleRate));
      return { seconds, exact: walk.complete };
    }
  }
  return { seconds: Math.max(1, Math.round((buf.length * 8) / 128000)), exact: false };   // MP3 按 128kbps 粗估
}

type ProviderKind = 'fal' | 'minimax' | 'custom';

/** 未命中 preset 一律走通用契约（provider=custom 与写错名字同一个行为） */
function providerKindOf(id: string): ProviderKind {
  if (id === 'fal-ai-ace-step') return 'fal';
  if (id === 'minimax-music') return 'minimax';
  return 'custom';
}

function providerLabelOf(kind: ProviderKind): string {
  return kind === 'fal' ? 'fal.ai（ACE-Step）' : kind === 'minimax' ? 'MiniMax' : '自部署唱歌服务';
}

/** 从错误响应里挑一句人话（不把整段 JSON 甩给用户） */
function briefOf(raw: string): string {
  let msg = '';
  try {
    const j = JSON.parse(raw) as any;
    const pick = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail ?? j?.base_resp?.status_msg ?? j?.msg;
    if (typeof pick === 'string') msg = pick;
  } catch { msg = raw; }
  return msg.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function httpError(label: string, status: number, raw: string): string {
  const brief = briefOf(raw);
  if (status === 401 || status === 403) {
    return `${label} 鉴权失败：API Key 无效或没有这个模型的权限，请主人在「插件 → 唱歌」里检查。`;
  }
  if (status === 402) return `${label} 账户余额不足（HTTP 402），充点钱再唱吧。`;
  if (status === 404) return `${label} 接口不存在（HTTP 404）：请核对 provider / baseUrl / 模型名。`;
  if (status === 429) return `${label} 说额度或调用频率受限（HTTP 429），过一会儿再试。`;
  if (status >= 500) return `${label} 服务暂时不可用（HTTP ${status}），稍后再试。`;
  if (status === 400 && /safety|moderation|policy|prohibited|censor/i.test(brief)) {
    return `${label} 说这段歌词/风格被内容审核拦了（HTTP 400），换个词再试。`;
  }
  return `${label} 返回 HTTP ${status}${brief ? `（${brief}）` : ''}。`;
}

function isTimeoutError(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  return err?.name === 'TimeoutError' || err?.name === 'AbortError'
    || /timeout|timed out/i.test(String(err?.message ?? ''));
}

type JsonReply =
  | { ok: true; data: any }
  | { ok: false; code: 'api' | 'timeout'; error: string };

function netError(label: string, e: unknown, timeoutMs: number): JsonReply {
  if (isTimeoutError(e)) {
    return { ok: false, code: 'timeout', error: `${label} 超时了：等了 ${Math.round(timeoutMs / 1000)} 秒还没回来，稍后再试。` };
  }
  const msg = String((e as Error)?.message ?? '网络错误').replace(/\s+/g, ' ').slice(0, 140);
  return { ok: false, code: 'api', error: `${label} 连不上（${msg}），稍后再试。` };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  label: string,
): Promise<JsonReply> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(500, timeoutMs)),
    });
  } catch (e) {
    return netError(label, e, timeoutMs);
  }
  const raw = await resp.text().catch(() => '');
  if (!resp.ok) return { ok: false, code: 'api', error: httpError(label, resp.status, raw) };
  try {
    return { ok: true, data: raw ? JSON.parse(raw) : {} };
  } catch {
    return { ok: false, code: 'api', error: `${label} 回了看不懂的内容（不是 JSON），稍后再试。` };
  }
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number, label: string): Promise<JsonReply> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(Math.max(500, timeoutMs)) });
  } catch (e) {
    return netError(label, e, timeoutMs);
  }
  const raw = await resp.text().catch(() => '');
  if (!resp.ok) return { ok: false, code: 'api', error: httpError(label, resp.status, raw) };
  try {
    return { ok: true, data: raw ? JSON.parse(raw) : {} };
  } catch {
    return { ok: false, code: 'api', error: `${label} 回了看不懂的内容（不是 JSON），稍后再试。` };
  }
}

// ============================================================
// 配置与参考音频
// ============================================================

interface Cfg {
  provider: string;
  apiKey: string;
  voiceId: string;
  refAudio: string;
  baseUrl: string;
  /** SCOW 等门户代理的会话 Cookie（如 107 平台：SCOW_USER=...）；仅 custom 契约发送 */
  cookie: string;
  maxSeconds: number;
  cooldownSeconds: number;
  dailyQuota: number;
  ownerUnlimited: boolean;
  timeoutMs: number;
}

interface GenInput {
  lyrics: string;
  tags: string;
  seconds?: number;
}

/** 桌面端成功记录（/records 只返回这些字段；file 只存文件名，不存绝对路径） */
export interface SingRecord {
  id: string;
  ts: number;
  userId: string;
  chatId: string;
  seconds: number;
  provider: string;
  file: string;
  mime: AudioMime;
}

/** 最近失败（/records 的 lastErrors）：够主人排障，不把整段异常堆栈存进 state */
interface SingError {
  ts: number;
  chatId: string;
  error: string;
}

interface SingOpts {
  chat: ChatRef;
  userId: string;
  role: Role;
  lyrics: unknown;
  tags: unknown;
  seconds: unknown;
  /** false = 只生成落盘、不发送（桌面端试唱）；默认发送 */
  deliver?: boolean;
  /** records 里记的 userId（试唱标 desktop；额度仍按 userId 算） */
  recordUserId?: string;
}

type FailCode = 'config' | 'limit' | 'api' | 'timeout' | 'storage';

type Outcome =
  | { ok: true; data: Buffer; contentType?: string }
  | { ok: false; code: FailCode; error: string };

interface GoodRef {
  /** 给 fal 的 audio_url：公网 URL 或 base64 data URI */
  url?: string;
  /** 给 MiniMax 的 audio_base64（原始 base64，不带 data URI 前缀） */
  base64?: string;
  mime: string;
}

type RefSource = ({ ok: true } & GoodRef) | { ok: false; error: string };

function numOf(v: unknown, def: number, min: number, max: number): number {
  if (v === '' || v === null || v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(Math.trunc(n), min, max) : def;
}

/** 把一段字符串当参考音频来源解析：URL / data URI / 文件路径 / 原始 base64 */
function parseRef(raw: string, baseDir: string): RefSource | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  if (/^https?:\/\//i.test(text)) {
    // 远端 URL 取不到字节，类型交给服务商自己判断
    return { ok: true, url: text, mime: 'audio/mpeg' };
  }

  const dataUri = text.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/i);
  if (dataUri) {
    if (!dataUri[2]) return { ok: false, error: '参考音频的 data URI 需要用 base64 编码。' };
    const b64 = dataUri[3]!.replace(/\s+/g, '');
    let buf: Buffer;
    try { buf = Buffer.from(b64, 'base64'); } catch { return { ok: false, error: '参考音频的 base64 解不开。' }; }
    if (!buf.length) return { ok: false, error: '参考音频的数据是空的。' };
    if (buf.length > REF_MAX_BYTES) return { ok: false, error: `参考音频太大（上限 ${REF_MAX_BYTES / 1024 / 1024}MB）。` };
    const declared = String(dataUri[1] ?? '').toLowerCase();
    const mime = declared.startsWith('audio/') ? declared : sniffRefMime(buf) ?? 'audio/mpeg';
    return { ok: true, url: text, base64: b64, mime };
  }

  // 文件路径：绝对路径优先，其次相对 pluginDataDir / 进程 cwd
  const cands = isAbsolute(text)
    ? [text]
    : [resolve(baseDir, text), resolve(process.cwd(), text)];
  const hit = cands.find((p) => existsSync(p));
  if (hit) {
    try {
      const st = statSync(hit);
      if (!st.isFile()) return { ok: false, error: `参考音频不是文件：${hit}` };
      if (st.size > REF_MAX_BYTES) return { ok: false, error: `参考音频太大（上限 ${REF_MAX_BYTES / 1024 / 1024}MB）：${hit}` };
      const buf = readFileSync(hit);
      if (!buf.length) return { ok: false, error: `参考音频是空文件：${hit}` };
      const mime = sniffRefMime(buf) ?? mimeFromName(hit);
      if (!mime || !mime.startsWith('audio/')) {
        return { ok: false, error: `参考音频不是支持的格式（mp3/wav/ogg/m4a/aac/flac）：${hit}` };
      }
      const b64 = buf.toString('base64');
      return { ok: true, url: `data:${mime};base64,${b64}`, base64: b64, mime };
    } catch (e) {
      return { ok: false, error: `读不到参考音频 ${hit}：${(e as Error).message}` };
    }
  }
  if (/[\\/]/.test(text)) {
    return { ok: false, error: `读不到参考音频文件：${cands.join(' / ')}` };
  }

  // 原始 base64（很长、字符集吻合、解出来还得是真音频才认，避免把克隆 id 当 base64）
  const compact = text.replace(/\s+/g, '');
  if (compact.length >= 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    try {
      const buf = Buffer.from(compact, 'base64');
      const mime = sniffRefMime(buf);
      if (mime) {
        if (buf.length > REF_MAX_BYTES) return { ok: false, error: `参考音频太大（上限 ${REF_MAX_BYTES / 1024 / 1024}MB）。` };
        return { ok: true, url: `data:${mime};base64,${compact}`, base64: compact, mime };
      }
    } catch { /* 落到下面当普通 id 处理 */ }
  }
  return undefined;
}

/**
 * 取音色来源：优先 refAudio，其次 voiceId。
 * ACE-Step / MiniMax 都是「每次请求带参考音频」的模式，没有可复用的 voice_id；
 * 如果用户只填了一个克隆 id，就明确告诉他这个供应商唱不了。
 */
function loadRefSource(cfg: Cfg, baseDir: string): RefSource {
  if (cfg.refAudio) {
    const got = parseRef(cfg.refAudio, baseDir);
    if (got) return got;
    return { ok: false, error: 'refAudio 既不是可读取的音频文件，也不是 http/data/base64 音频（支持 mp3/wav/ogg/m4a/aac/flac）。' };
  }
  if (cfg.voiceId) {
    const got = parseRef(cfg.voiceId, baseDir);
    if (got?.ok) return got;
    return { ok: false, error: '当前唱歌供应商不支持复用克隆音色 id，请把 10~30 秒纯净干声填进 refAudio（本地路径或公网 URL）。' };
  }
  return { ok: false, error: '还没配置参考音频（refAudio）或克隆音色（voiceId），不知道要唱成谁的声音。' };
}

// ============================================================
// preset：请求构造 + 响应解析
// ============================================================

async function downloadAudio(url: string, timeoutMs: number, label: string): Promise<Outcome> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(Math.max(1000, timeoutMs)) });
  } catch (e) {
    const err = netError(label, e, timeoutMs);
    return err;
  }
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    return { ok: false, code: 'api', error: httpError(label, resp.status, raw) };
  }
  let data: Buffer;
  try {
    data = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    return { ok: false, code: 'api', error: `${label} 的音频下载中断了（${(e as Error).message}）。` };
  }
  if (!data.length) return { ok: false, code: 'api', error: `${label} 返回的音频是空的。` };
  return { ok: true, data, contentType: resp.headers.get('content-type') ?? '' };
}

/** ACE-Step（fal.ai）：提交队列 → 轮询 status_url → 取 response_url → 下载音频 */
async function generateFal(cfg: Cfg, input: GenInput, ref: GoodRef): Promise<Outcome> {
  const label = providerLabelOf('fal');
  const audioUrl = ref.url ?? (ref.base64 ? `data:${ref.mime};base64,${ref.base64}` : '');
  if (!audioUrl) return { ok: false, code: 'config', error: `唱歌服务还没配置好：${label} 需要一份参考音频。` };

  // baseUrl 可指向镜像 fal 路径的代理/网关（国内直连 fal 常被墙）
  const root = cfg.baseUrl ? cfg.baseUrl.replace(/\/+$/, '') : '';
  const submitUrl = root ? `${root}/fal-ai/ace-step/audio-to-audio` : FAL_SUBMIT;
  const auth = { authorization: `Key ${cfg.apiKey}` };

  // 官方 schema 字段：audio_url / tags / original_tags 必填；lyrics + edit_mode=lyrics
  // 表示「按新歌词替换人声」。没有时长字段，歌多长由歌词与参考音频决定。
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    tags: input.tags,
    // 2026-10 核对官方 OpenAPI 后加的必填字段（调研结论里漏了）；没有原曲标签就用同一份风格
    original_tags: input.tags,
    lyrics: input.lyrics,
    edit_mode: 'lyrics',
    guidance_scale: 15,
    lyric_guidance_scale: 1.5,
  };

  const deadline = Date.now() + cfg.timeoutMs;
  const left = () => deadline - Date.now();
  const timeout = (): Outcome => ({
    ok: false,
    code: 'timeout',
    error: `${label} 超时了：等了 ${Math.round(cfg.timeoutMs / 1000)} 秒还没唱完，稍后再试。`,
  });

  if (left() <= 0) return timeout();
  const submitted = await postJson(submitUrl, auth, body, left(), label);
  if (!submitted.ok) return submitted;

  const job = submitted.data ?? {};
  const requestId = String(job.request_id ?? '').trim();
  const submitBase = submitUrl.replace(/\/+$/, '');
  const statusUrl = String(job.status_url ?? '').trim()
    || (requestId ? `${submitBase}/requests/${encodeURIComponent(requestId)}/status` : '');
  const resultUrl = String(job.response_url ?? '').trim()
    || (requestId ? `${submitBase}/requests/${encodeURIComponent(requestId)}` : '');
  if (!resultUrl) {
    return { ok: false, code: 'api', error: `${label} 返回的任务里没有 request_id / 结果地址，没法取音频。` };
  }

  let status = String(job.status ?? 'IN_QUEUE').toUpperCase();
  const pollMs = clamp(Math.floor(cfg.timeoutMs / 20), 300, 2000);
  while (status !== 'COMPLETED') {
    if (left() <= 0) return timeout();
    await sleep(Math.min(pollMs, Math.max(0, left())));
    if (left() <= 0) return timeout();
    if (!statusUrl) {
      return { ok: false, code: 'api', error: `${label} 的任务还在排队，但没有给轮询地址。` };
    }
    const polled = await getJson(statusUrl, auth, left(), label);
    if (!polled.ok) return polled;
    status = String(polled.data?.status ?? '').toUpperCase();
    if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
      const detail = String(polled.data?.error ?? polled.data?.detail ?? '').trim().slice(0, 160);
      return {
        ok: false,
        code: 'api',
        error: `${label} 这次没唱成（任务状态 ${status}${detail ? `：${detail}` : ''}）。`,
      };
    }
  }

  if (left() <= 0) return timeout();
  const result = await getJson(resultUrl, auth, left(), label);
  if (!result.ok) return result;
  const fileUrl = typeof result.data?.audio?.url === 'string' ? result.data.audio.url : '';
  if (!fileUrl) return { ok: false, code: 'api', error: `${label} 唱完了，但结果里没有音频地址。` };
  if (!/^https?:\/\//i.test(fileUrl)) {
    return { ok: false, code: 'api', error: `${label} 返回的音频地址不是 http(s) URL，取不了。` };
  }
  return downloadAudio(fileUrl, Math.max(1000, left()), label);
}

/** MiniMax 音乐：同步返回 data.audio 的 24 小时下载 URL → 下载 */
async function generateMinimax(cfg: Cfg, input: GenInput, ref: GoodRef): Promise<Outcome> {
  const label = providerLabelOf('minimax');
  // MiniMax 的 audio_url 要公网地址；本地文件/本地 data URI 一律走 audio_base64
  const remote = ref.url && /^https?:\/\//i.test(ref.url) ? ref.url : '';
  if (!remote && !ref.base64) {
    return { ok: false, code: 'config', error: `唱歌服务还没配置好：${label} 需要公网参考音频或 base64 音频。` };
  }
  const body: Record<string, unknown> = {
    model: 'music-cover',
    prompt: input.tags,
    lyrics: input.lyrics,
    output_format: 'url',
  };
  if (remote) body.audio_url = remote;
  else body.audio_base64 = ref.base64;

  const root = cfg.baseUrl ? cfg.baseUrl.replace(/\/+$/, '') : 'https://api.minimax.cn';
  const url = cfg.baseUrl ? `${root}/v1/music_generation` : MINIMAX_SUBMIT;
  const got = await postJson(url, { authorization: `Bearer ${cfg.apiKey}` }, body, cfg.timeoutMs, label);
  if (!got.ok) return got;

  const baseResp = got.data?.base_resp ?? {};
  const code = Number(baseResp?.status_code ?? 0);
  if (code !== 0) {
    const msg = String(baseResp?.status_msg ?? '').trim().slice(0, 160);
    return { ok: false, code: 'api', error: `${label} 唱歌接口报错（${code}${msg ? `：${msg}` : ''}）。` };
  }

  const audio = typeof got.data?.data?.audio === 'string' ? got.data.data.audio : '';
  if (!audio) return { ok: false, code: 'api', error: `${label} 没有返回音频地址。` };
  if (!/^https?:\/\//i.test(audio)) {
    return { ok: false, code: 'api', error: `${label} 返回的不是音频下载地址（output_format=url 时应为 http URL）。` };
  }
  return downloadAudio(audio, cfg.timeoutMs, label);
}

/** 通用契约：POST {baseUrl}/generate → 响应体就是音频字节 */
async function generateCustom(cfg: Cfg, input: GenInput): Promise<Outcome> {
  const label = providerLabelOf('custom');
  if (!cfg.baseUrl) {
    return { ok: false, code: 'config', error: '唱歌服务还没配置好：provider=custom 时必须填 baseUrl（如 http://127.0.0.1:8080）。' };
  }
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/generate`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        // SCOW 门户代理（107 平台 /api/proxy/...）只认会话 Cookie；普通自部署留空即可
        ...(cfg.cookie ? { cookie: cfg.cookie } : {}),
      },
      body: JSON.stringify({
        lyrics: input.lyrics,
        tags: input.tags,
        seconds: input.seconds ?? cfg.maxSeconds,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    return netError(label, e, cfg.timeoutMs);
  }
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    return { ok: false, code: 'api', error: httpError(label, resp.status, raw) };
  }
  let data: Buffer;
  try {
    data = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    return { ok: false, code: 'api', error: `${label} 的响应读取中断了（${(e as Error).message}）。` };
  }
  if (!data.length) return { ok: false, code: 'api', error: `${label} 返回了空响应（应该直接给音频字节）。` };
  return { ok: true, data, contentType: resp.headers.get('content-type') ?? '' };
}

// ============================================================
// 插件入口
// ============================================================

export function setup(ctx: PluginContext): void {
  const singDir = join(ctx.pluginDataDir, 'sing');
  mkdirSync(singDir, { recursive: true });

  // 所有配置每次现读：热重载后 ctx 是新实例，模块级不缓存任何东西
  const cfg = (): Cfg => ({
    provider: String(ctx.userConfig.provider ?? '').trim() || DEFAULT_PROVIDER,
    apiKey: String(ctx.userConfig.apiKey ?? '').trim(),
    voiceId: String(ctx.userConfig.voiceId ?? '').trim(),
    refAudio: String(ctx.userConfig.refAudio ?? '').trim(),
    baseUrl: String(ctx.userConfig.baseUrl ?? '').trim().replace(/\/+$/, ''),
    cookie: String(ctx.userConfig.cookie ?? '').trim(),
    maxSeconds: numOf(ctx.userConfig.maxSeconds, 60, 10, 120),
    cooldownSeconds: numOf(ctx.userConfig.cooldownSeconds, 60, 0, 3600),
    dailyQuota: numOf(ctx.userConfig.dailyQuota, 5, 0, 100),
    ownerUnlimited: ctx.userConfig.ownerUnlimited !== false,
    timeoutMs: numOf(ctx.userConfig.timeoutMs, 300_000, 1000, 900_000),
  });

  // ---------- 额度（每自然日 + 用户，存在 ctx.state） ----------

  function usageOf(day: string): Record<string, number> {
    const v = ctx.state.get<Record<string, number>>(`${USAGE_PREFIX}${day}`, {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  function usedOf(day: string, userId: string): number {
    return Math.max(0, Math.floor(Number(usageOf(day)[userId]) || 0));
  }

  function bumpUsage(day: string, userId: string, delta: number): void {
    const key = `${USAGE_PREFIX}${day}`;
    const map = usageOf(day);
    map[userId] = Math.max(0, Math.floor(Number(map[userId]) || 0) + delta);
    ctx.state.set(key, map);
    // 只清理比这天更旧的桶（day 是零填充的 yyyy-mm-dd，字典序即可比大小）：
    // 跨天回滚（23:59 开始、00:00 后失败）要把昨天的计数写回去，不能把今天别人的计数顺手删掉
    for (const k of Object.keys(ctx.state.all())) {
      if (k.startsWith(USAGE_PREFIX) && k.slice(USAGE_PREFIX.length) < day) ctx.state.delete(k);
    }
  }

  // ---------- 冷却（同会话，记上次成功生成时间） ----------

  function cooldownMap(): Record<string, number> {
    const v = ctx.state.get<Record<string, number>>(COOLDOWN_KEY, {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  function lastOf(chatKey: string): number {
    return Math.max(0, Math.floor(Number(cooldownMap()[chatKey]) || 0));
  }

  function setCooldown(chatKey: string, ts: number): void {
    const map = cooldownMap();
    map[chatKey] = ts;
    // 24 小时以前的记录没有再用的必要（cooldownSeconds 最大 1 小时）
    for (const [k, v] of Object.entries(map)) {
      if (ts - Number(v) >= 24 * 3600_000) delete map[k];
    }
    ctx.state.set(COOLDOWN_KEY, map);
  }

  /**
   * 同会话在途锁：放在进程内而不是 ctx.state，进程重启/热重载后自动释放，不会留下永久锁。
   * 生成耗时可能超过 cooldownSeconds（timeoutMs 上限 900s），只靠时间戳会让同一会话
   * 的第二首在冷却结束后钻进来；这个锁负责「同一会话同时只唱一首」。
   */
  const inflight = new Map<string, symbol>();

  function acquireChatSlot(chatKey: string): (() => void) | undefined {
    if (inflight.has(chatKey)) return undefined;
    const token = Symbol(chatKey);
    inflight.set(chatKey, token);
    return () => {
      // 只释放自己那把：万一被热重载/新请求接管，不要把别人的锁删掉
      if (inflight.get(chatKey) === token) inflight.delete(chatKey);
    };
  }

  /** 先写入预约时间占住冷却位，失败时回滚；只有当前值仍是本次预约时才恢复 */
  function reserveCooldown(chatKey: string, ts: number): () => void {
    const map = cooldownMap();
    const prev = map[chatKey];
    map[chatKey] = ts;
    ctx.state.set(COOLDOWN_KEY, map);
    return () => {
      const now = cooldownMap();
      // 成功时间或更新的预约已经写进来时，不能用这次的旧值盖回去
      if (now[chatKey] !== ts) return;
      if (prev === undefined) delete now[chatKey];
      else now[chatKey] = prev;
      ctx.state.set(COOLDOWN_KEY, now);
    };
  }

  // ---------- 产物清理 ----------

  function cleanupOld(): void {
    try {
      const cutoff = Date.now() - KEEP_MS;
      for (const name of readdirSync(singDir)) {
        const p = join(singDir, name);
        try {
          const st = statSync(p);
          if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(p);
        } catch { /* 单个文件清理失败不拖垮这次唱歌 */ }
      }
    } catch { /* 目录不可读也不影响主流程 */ }
  }

  // ---------- 成功记录 / 最近失败（桌面端 /records、/audio、/send 用） ----------

  function records(): SingRecord[] {
    const v = ctx.state.get<SingRecord[]>(RECORDS_KEY, []);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string' && typeof x.file === 'string') : [];
  }

  function addRecord(rec: SingRecord): void {
    const list = records();
    list.unshift(rec);
    ctx.state.set(RECORDS_KEY, list.slice(0, RECORDS_MAX));
  }

  function lastErrors(): SingError[] {
    const v = ctx.state.get<SingError[]>(ERRORS_KEY, []);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.error === 'string') : [];
  }

  function addError(chatId: string, error: string): void {
    const list = lastErrors();
    list.unshift({ ts: Date.now(), chatId, error });
    ctx.state.set(ERRORS_KEY, list.slice(0, ERRORS_MAX));
  }

  /** /audio 只认 records 里的文件名，再按 singDir 做边界校验（防路径穿越） */
  function insideSingDir(rel: string): string {
    const root = resolve(singDir);
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`路径越界：只能读插件数据目录 sing/ 下的文件（${rel}）`);
    }
    return abs;
  }

  // ---------- 核心：工具与 REST 共用 ----------

  type SingResult =
    | { ok: true; id: string; path: string; seconds: number; secondsExact: boolean; provider: string }
    | { ok: false; code: FailCode; error: string };

  async function singCore(opts: SingOpts): Promise<SingResult> {
    const c = cfg();
    const kind = providerKindOf(c.provider);
    const label = providerLabelOf(kind);

    const lyrics = String(opts.lyrics ?? '').trim();
    if (!lyrics) return { ok: false, code: 'config', error: '唱歌失败：歌词是空的，不知道唱什么。' };
    if (lyrics.length > LYRICS_MAX) {
      return { ok: false, code: 'config', error: `唱歌失败：歌词太长了（上限 ${LYRICS_MAX} 字），精简一点再试。` };
    }
    const tags = (String(opts.tags ?? '').trim() || DEFAULT_TAGS).slice(0, TAGS_MAX);
    if (kind === 'minimax') {
      // 官方 music-cover 的硬约束：prompt 10~300、lyrics 10~1000；低于下限真实接口会报 2013
      if (lyrics.length < MINIMAX_LYRICS_MIN) {
        return {
          ok: false, code: 'config',
          error: `MiniMax 的歌词太短了：官方要求 ${MINIMAX_LYRICS_MIN}~${MINIMAX_LYRICS_MAX} 个字符（现在 ${lyrics.length} 个）。`,
        };
      }
      if (lyrics.length > MINIMAX_LYRICS_MAX) {
        return {
          ok: false, code: 'config',
          error: `MiniMax 的歌词太长了：官方上限 ${MINIMAX_LYRICS_MAX} 个字符（现在 ${lyrics.length} 个），精简一点再试。`,
        };
      }
      if (tags.length < MINIMAX_PROMPT_MIN) {
        return {
          ok: false, code: 'config',
          error: `MiniMax 的风格描述太短了：官方要求 ${MINIMAX_PROMPT_MIN}~${TAGS_MAX} 个字符（现在 ${tags.length} 个），把曲风与人声写清楚一点。`,
        };
      }
    }
    let seconds: number | undefined;
    if (opts.seconds !== undefined && opts.seconds !== null && String(opts.seconds).trim() !== '') {
      const n = Number(opts.seconds);
      if (!Number.isFinite(n)) return { ok: false, code: 'config', error: '唱歌失败：seconds 要一个数字（秒）。' };
      seconds = clamp(Math.round(n), 10, c.maxSeconds);
    }

    if (!c.apiKey) {
      return { ok: false, code: 'config', error: '唱歌服务还没配置：缺 API Key，请主人在桌面端「插件 → 唱歌」里填一个。' };
    }

    // 参考音频在冷却/额度之前校验：配置不全不该消耗任何一次额度
    let ref: GoodRef | undefined;
    if (kind !== 'custom') {
      const got = loadRefSource(c, ctx.pluginDataDir);
      if (!got.ok) return { ok: false, code: 'config', error: `唱歌服务还没配置好：${got.error}` };
      ref = got;
    }

    const chatKey = `${opts.chat.platform}:${opts.chat.type}:${opts.chat.chatId}`;
    const now = Date.now();

    // 同会话在途锁：先占位（同步完成，双击的第二个请求会看到）。
    // 生成可能比 cooldownSeconds 还久，只靠时间戳挡不住第二首，必须单独上锁。
    const releaseSlot = acquireChatSlot(chatKey);
    if (!releaseSlot) {
      return { ok: false, code: 'limit', error: '这个会话已经有一首在唱了，等它唱完再点。' };
    }

    // 冷却：同一会话成功唱完一首后，cooldownSeconds 内不再接第二首
    let undoCooldown: (() => void) | undefined;
    if (c.cooldownSeconds > 0) {
      const last = lastOf(chatKey);
      const elapsed = now - last;
      if (last > 0 && elapsed >= 0 && elapsed < c.cooldownSeconds * 1000) {
        const wait = Math.max(1, Math.ceil((c.cooldownSeconds * 1000 - elapsed) / 1000));
        releaseSlot();
        return { ok: false, code: 'limit', error: `刚唱过啦，还有 ${wait} 秒冷却，等一会儿再点。` };
      }
      undoCooldown = reserveCooldown(chatKey, now);
    }

    // 额度：普通成员每自然日 dailyQuota 首；先占位，失败退回（用户没听到歌就不该计数）
    const day = dayKeyOf(now);
    const privileged = opts.role === 'owner' || opts.role === 'admin';
    const limited = !(c.ownerUnlimited && privileged);
    const used = limited ? usedOf(day, opts.userId) : 0;
    if (limited && used >= c.dailyQuota) {
      undoCooldown?.();
      releaseSlot();
      return {
        ok: false,
        code: 'limit',
        error: `今天唱歌的额度用完了（${used}/${c.dailyQuota} 首，本地时间零点重置），明天再来吧。`,
      };
    }
    if (limited) bumpUsage(day, opts.userId, 1);
    let reserved = limited;

    const rollback = (): void => {
      if (reserved) { bumpUsage(day, opts.userId, -1); reserved = false; }
      if (undoCooldown) { undoCooldown(); undoCooldown = undefined; }
      releaseSlot();
    };

    const input: GenInput = { lyrics, tags, seconds };
    let out: Outcome;
    try {
      if (kind === 'fal') out = await generateFal(c, input, ref!);
      else if (kind === 'minimax') out = await generateMinimax(c, input, ref!);
      else out = await generateCustom(c, input);
    } catch (e) {
      // 兜底：任何意外都变成一句能转述的中文，绝不把异常抛给内核
      rollback();
      const msg = String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 160);
      return { ok: false, code: 'api', error: `唱歌失败：${label} 调用出了意外（${msg}），稍后再试。` };
    }

    if (!out.ok) {
      rollback();
      return out;
    }

    const mime = sniffAudioMime(out.data) ?? mimeFromContentType(out.contentType);
    if (!mime) {
      rollback();
      return { ok: false, code: 'api', error: '唱歌服务回来的不是 mp3/wav 音频（可能把错误信息当音频返回了），稍后再试。' };
    }

    const id = newId('sing_');
    const file = `${id}.${mime === 'audio/wav' ? 'wav' : 'mp3'}`;
    const abs = join(singDir, file);
    try {
      writeFileSync(abs, out.data);
    } catch (e) {
      rollback();
      return { ok: false, code: 'storage', error: `唱歌失败：音频写盘出错了（${(e as Error).message}）。` };
    }

    // record 段不会被 adapter 自动本地化（localizeSegment 只处理 image），必须自己给 file://
    // 注意：ChatService 在限速令牌不足时会「正常返回但整批丢弃」，所以要看投递回执，
    // 不能把 send resolve 当作已送达（否则模型会宣称发了语音，实际没有）。
    // deliver=false 是桌面端试唱：只落盘，不碰任何会话。
    if (opts.deliver !== false) {
      try {
        const receipt = await ctx.chat.sendTracked(opts.chat, [{ type: 'record', data: { file: pathToFileURL(abs).href } }]);
        if (receipt.sent <= 0) {
          try { unlinkSync(abs); } catch { /* ignore */ }
          rollback();
          return { ok: false, code: 'api', error: '歌是唱好了，但语音被发送限速拦下了、没有真的发出去；过一会儿再点。' };
        }
      } catch (e) {
        try { unlinkSync(abs); } catch { /* ignore */ }
        rollback();
        return { ok: false, code: 'api', error: `歌是唱好了，但语音没发出去（${(e as Error).message}）；先别跟对方说唱好了。` };
      }
    }

    // 成功：额度保留；冷却从真正发出去的时刻重新算
    reserved = false;
    undoCooldown = undefined;
    releaseSlot();
    if (c.cooldownSeconds > 0) setCooldown(chatKey, Date.now());
    ctx.state.set(LAST_AT_KEY, Date.now());
    const est = estimateSeconds(out.data, mime);
    addRecord({
      id,
      ts: Date.now(),
      userId: opts.recordUserId ?? opts.userId,
      chatId: opts.chat.chatId,
      seconds: est.seconds,
      provider: c.provider,
      file,
      mime,
    });
    cleanupOld();
    return { ok: true, id, path: abs, seconds: est.seconds, secondsExact: est.exact, provider: c.provider };
  }

  /**
   * 生成入口：所有失败都顺手记进 /records 的 lastErrors。
   * 核心逻辑仍在 singCore —— 这里不改变任何返回语义，只做失败留痕。
   */
  async function sing(opts: SingOpts): Promise<SingResult> {
    try {
      const r = await singCore(opts);
      if (!r.ok) addError(opts.chat.chatId, r.error);
      return r;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 160);
      addError(opts.chat.chatId, `唱歌失败：工具内部出了意外（${msg}），稍后再试。`);
      throw e;
    }
  }

  // ---------- LLM 工具（chat 面） ----------

  ctx.llm.registerTool({
    name: 'sing',
    description: '用云 API 以 bot 自己的音色把一段歌词唱成语音，直接发进当前会话。需要主人先在插件设置里配好 API Key 与参考音频/音色。',
    surface: 'chat',
    promptSnippet: '用 bot 自己的音色唱一首（语音直接发进会话，一次一首）',
    promptGuidelines: [
      '对方让你唱歌、来一段、想听歌时用 sing；一次只唱一首，别连着点。',
      '歌词填完整（可带 [verse]/[chorus] 结构标签）；风格描述写清楚人声与曲风。',
      '歌由工具直接发进会话，正文只写一两句收尾，不要复述歌词全文。',
      '工具返回失败时如实说唱不了或稍后再试；没配 API Key 就直说现在唱不了。',
    ],
    parameters: {
      type: 'object',
      properties: {
        lyrics: { type: 'string', description: '完整歌词（可带 [verse]/[chorus]/[bridge] 等结构标签，用换行分段）' },
        tags: { type: 'string', description: '风格描述，如 "cute female vocal, pop, 120bpm"；留空用默认可爱流行' },
        seconds: { type: 'number', description: '期望时长（秒，10..上限）；部分供应商按歌词长短自动决定，会忽略这个值' },
      },
      required: ['lyrics'],
    },
    handler: async (args, tctx): Promise<string> => {
      try {
        const r = await sing({
          chat: tctx.chat,
          userId: String(tctx.event.userId ?? ''),
          role: tctx.role,
          lyrics: args.lyrics,
          tags: args.tags,
          seconds: args.seconds,
        });
        if (!r.ok) return r.error;
        return r.secondsExact
          ? `已把这段歌唱进语音发到会话里了（约 ${r.seconds} 秒）。正文用一两句收尾就行，不要复述歌词全文。`
          : '已把这段歌唱进语音发到会话里了。正文用一两句收尾就行，不要复述歌词全文。';
      } catch (e) {
        // 最后一道兜底：状态库/路径这类意外也不能把异常抛回内核
        const msg = String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 160);
        return `唱歌失败：工具内部出了意外（${msg}），稍后再试。`;
      }
    },
  });

  // ---------- chat 轮说明（追加一节，不覆盖别的插件注入） ----------

  ctx.hooks.beforeLLM = (req) => {
    const c = cfg();
    const kind = providerKindOf(c.provider);
    if (!req.systemSections) req.systemSections = [];
    const lines = [
      '# 唱歌',
      '- 对方让你唱歌、来一段、想听歌时，直接调用 sing：它会用 bot 自己的音色把歌词唱成语音，并直接发进当前会话。',
      '- 调用之后正文只写一两句收尾（例如「唱完啦～」），不要复述歌词全文，也不要让用户再点链接或保存文件。',
      '- 一次只唱一首；刚唱完还在冷却里，别连着调用。',
    ];
    if (!c.apiKey) {
      lines.push('- 这台 bot 还没配置唱歌服务的 API Key，现在唱不了；对方要歌就直说唱不了。');
    } else if (kind !== 'custom' && !c.voiceId && !c.refAudio) {
      lines.push('- 唱歌服务配了 Key，但还缺大肥鱼的参考音频/克隆音色，现在还是唱不了；对方要歌就直说。');
    }
    req.systemSections.push({ order: 291, title: 'sing', text: lines.join('\n') });
    return req;
  };

  // ---------- REST（桌面端「唱歌」页；/api/* 已由 uiToken 鉴权） ----------

  const ownerId = (): string => {
    const ids = (ctx.config as { masterIds?: unknown }).masterIds;
    return Array.isArray(ids) && ids.length ? String(ids[0]) : 'owner';
  };

  ctx.http.on('GET', '/status', (req) => {
    const c = cfg();
    const userId = String(req.query.userId ?? '').trim() || ownerId();
    const lastAt = Number(ctx.state.get<number | null>(LAST_AT_KEY, null));
    return {
      body: {
        ok: true,
        provider: c.provider,
        voiceIdSet: !!(c.voiceId || c.refAudio),
        lastGenerationAt: Number.isFinite(lastAt) && lastAt > 0 ? lastAt : null,
        today: { userId, count: usedOf(dayKeyOf(), userId) },
      },
    };
  });

  /** 桌面端没有会话上下文：试唱固定用它，聊天记录里也只留个 desktop 标记 */
  const desktopChat = (): ChatRef => ({ platform: 'ui', type: 'private', chatId: 'desktop' });

  // 最近成功生成 + 最近失败：records 只给约定字段，file 是 sing/ 下的文件名（不含绝对路径）
  ctx.http.on('GET', '/records', () => ({
    body: {
      ok: true,
      records: records().map((r) => ({
        id: r.id, ts: r.ts, userId: r.userId, chatId: r.chatId, seconds: r.seconds,
        provider: r.provider, file: r.file, mime: r.mime,
      })),
      lastErrors: lastErrors().map((e) => ({ ts: e.ts, chatId: e.chatId, error: e.error })),
    },
  }));

  // 按 id 取音频字节：id 只在 records 里查，再对文件名做 singDir 边界校验（不能靠 query 直接拼路径）
  ctx.http.on('GET', '/audio', (req) => {
    const id = String(req.query.id ?? '').trim();
    const rec = id ? records().find((r) => r.id === id) : undefined;
    if (!rec) return { status: 404, body: { ok: false, error: '没有这条录音（id 不存在或已被清理）' } };

    let abs: string;
    try { abs = insideSingDir(rec.file); }
    catch (e) { return { status: 404, body: { ok: false, error: `音频读不到：${(e as Error).message}` } }; }

    let buf: Buffer;
    try { buf = readFileSync(abs); }
    catch { return { status: 404, body: { ok: false, error: '音频文件已被清理' } }; }

    return {
      // content-type 按落盘的扩展名给（与 mime 字段同源）；记录异常时再现场嗅探兜底
      headers: { 'content-type': mimeFromName(rec.file) ?? rec.mime ?? sniffAudioMime(buf) ?? 'application/octet-stream' },
      body: buf,
    };
  });

  // 桌面端试唱：与 chat 工具同一条生成路径（主人身份、不限额），只落盘不发送
  ctx.http.on('POST', '/preview', async (req) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    try {
      const r = await sing({
        chat: desktopChat(),
        userId: ownerId(),
        role: 'owner',
        recordUserId: 'desktop',
        deliver: false,
        lyrics: body.lyrics,
        tags: body.tags,
        seconds: body.seconds,
      });
      if (!r.ok) return { status: 400, body: { ok: false, error: r.error } };
      return { body: { ok: true, id: r.id, seconds: r.seconds } };
    } catch (e) {
      return { status: 400, body: { ok: false, error: `试唱失败：${(e as Error).message}` } };
    }
  });

  // 补发：把已生成的录音按 id 发到指定会话（record 一定转 file://，可选先带一条文字）
  ctx.http.on('POST', '/send', async (req) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const id = String(body.id ?? '').trim();
    const type = body.type === 'private' ? 'private' : body.type === 'group' ? 'group' : null;
    const chatId = String(body.chatId ?? '').trim();
    const text = String(body.text ?? '').trim().slice(0, 200);

    const rec = id ? records().find((r) => r.id === id) : undefined;
    if (!rec) return { status: 404, body: { ok: false, error: '没有这条录音（id 不存在或已被清理）' } };
    if (!type || !chatId) return { status: 400, body: { ok: false, error: '要指定 type（group/private）与 chatId' } };
    // 这是唯一由人手填的发送目标：先挡住手误，别等 OneBot 回 502 才暴露
    if (!/^\d{5,12}$/.test(chatId)) return { status: 400, body: { ok: false, error: 'chatId 要是 QQ 号/群号（5~12 位数字）' } };

    let abs: string;
    try { abs = insideSingDir(rec.file); }
    catch (e) { return { status: 400, body: { ok: false, error: (e as Error).message } }; }
    if (!existsSync(abs)) return { status: 404, body: { ok: false, error: '音频文件已被清理' } };

    const target = { platform: 'qq', type, chatId } as const;
    try {
      // 语音与附言分开发、分开看回执：合在一条 sendTracked 里，文字先发成功、语音被限速
      // 丢掉时 sent 仍 >0，会假成功（splitSegments 会把它们拆成两条）
      const voice = await ctx.chat.sendTracked(target, [{ type: 'record', data: { file: pathToFileURL(abs).href } }]);
      if (voice.sent <= 0) {
        return { status: 502, body: { ok: false, error: '发送被限速拦下了，没有真的发出去' } };
      }
      let warning = '';
      if (text) {
        const textReceipt = await ctx.chat.sendTracked(target, [{ type: 'text', data: { text } }]);
        if (textReceipt.sent <= 0) warning = '附言被限速拦下，没有发出去';
      }
      ctx.log.info(`录音补发 ${id} → ${type}_${chatId}${text ? `（附言：${text.slice(0, 40)}）` : ''}`);
      return { body: { ok: true, messageId: voice.ids[0] ?? null, ...(warning ? { warning } : {}) } };
    } catch (e) {
      return { status: 502, body: { ok: false, error: `发不出去：${(e as Error).message}` } };
    }
  });
}
