import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatRef, PluginContext, Role } from '../../kernel/types.ts';
import { clamp, newId, sleep } from '../../kernel/util/misc.ts';

// ============================================================
// cover —— 翻唱现成的歌，而不是生成一首新歌
//
// 链路：网易云搜歌/取流 → 下载原曲 → 自部署 cover 服务
//   （UVR/MDX 分离人声与伴奏 → FeiyuVoice-RVC 换音色 → 混回伴奏）
//   → 产物落盘 → record 段发进当前会话。
//
// 2026-10-27 起 sing（生成新歌）已下线，唱歌能力只剩 cover 这一条路。
//
// 关键坑：adapter 的 localizeSegment 只把 image 的本地路径转
// file://，record 必须自己给 pathToFileURL(abs).href；限速时 send 会正常
// resolve 但整批丢弃，所以必须看 sendTracked 的 sent 回执。
// ============================================================

const OUT_MAX_BYTES = 60 * 1024 * 1024;
const SONG_MAX_BYTES = 30 * 1024 * 1024;
const KEEP_MS = 24 * 3600_000;
const RECORDS_MAX = 50;
const ERRORS_MAX = 10;

const USAGE_PREFIX = 'usage:';
const COOLDOWN_KEY = 'cooldown';
const LAST_AT_KEY = 'lastAt';
const RECORDS_KEY = 'records';
const ERRORS_KEY = 'lastErrors';

const NETEASE_SEARCH = 'https://music.163.com/api/search/get/web';
const NETEASE_OUTER = 'https://music.163.com/song/media/outer/url';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) parallel-cover/1.0';

interface Cfg {
  baseUrl: string;
  apiKey: string;
  cookie: string;
  cooldownSeconds: number;
  dailyQuota: number;
  ownerUnlimited: boolean;
  timeoutMs: number;
  maxSongMb: number;
}

interface SongInfo {
  id: number;
  name: string;
  artists: string;
}

export interface CoverRecord {
  id: string;
  ts: number;
  userId: string;
  chatId: string;
  song: string;
  artist: string;
  seconds: number;
  file: string;
  mime: string;
}

interface CoverError {
  ts: number;
  chatId: string;
  error: string;
}

interface CoverOpts {
  chat: ChatRef;
  userId: string;
  role: Role;
  song: unknown;
  artist?: unknown;
  withInstrumental?: unknown;
  deliver?: boolean;
  recordUserId?: string;
}

type FailCode = 'config' | 'limit' | 'api' | 'timeout' | 'storage' | 'notfound';

type Outcome =
  | { ok: true; data: Buffer; seconds?: number; contentType?: string }
  | { ok: false; code: FailCode; error: string };

function numOf(v: unknown, def: number, min: number, max: number): number {
  if (v === '' || v === null || v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(Math.trunc(n), min, max) : def;
}

function briefOf(raw: string): string {
  let msg = '';
  try {
    const j = JSON.parse(raw) as any;
    const pick = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail ?? j?.msg;
    if (typeof pick === 'string') msg = pick;
  } catch { msg = raw; }
  return msg.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function httpError(label: string, status: number, raw: string): string {
  const brief = briefOf(raw);
  if (status === 401 || status === 403) {
    return `${label} 鉴权失败：API Key 或 SCOW Cookie 不对，请主人在「插件 → 翻唱」里检查。`;
  }
  if (status === 413) return `${label} 说原曲文件太大，换一首短一点的。`;
  if (status === 422) return `${label} 说这首音频处理不了${brief ? `（${brief}）` : ''}。`;
  if (status === 429) return `${label} 正在忙/被限流，过一会儿再翻。`;
  if (status === 503) return `${label} 正在翻上一首，等它唱完再点。`;
  if (status >= 500) return `${label} 处理失败了${brief ? `（${brief}）` : ''}，稍后再试。`;
  return `${label} 返回 HTTP ${status}${brief ? `（${brief}）` : ''}。`;
}

function isTimeoutError(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  return err?.name === 'TimeoutError' || err?.name === 'AbortError'
    || /timeout|timed out/i.test(String(err?.message ?? ''));
}

function sniffAudioMime(buf: Buffer): 'audio/mpeg' | 'audio/wav' | undefined {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  return undefined;
}

/** 网易云搜索：优先匹配歌手；过滤伴奏/纯音乐；取不到就报一句人话 */
export async function searchNetease(song: string, artist: string, timeoutMs: number): Promise<
  { ok: true; song: SongInfo; alternates: SongInfo[] } | { ok: false; code: FailCode; error: string }
> {
  const query = `${song}${artist ? ` ${artist}` : ''}`.trim();
  const body = new URLSearchParams({ s: query, type: '1', limit: '12', offset: '0' });
  let resp: Response;
  try {
    resp = await fetch(NETEASE_SEARCH, {
      method: 'POST',
      headers: {
        'user-agent': UA,
        referer: 'https://music.163.com/',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)),
    });
  } catch (e) {
    return { ok: false, code: 'api', error: `网易云连不上（${(e as Error).message}），稍后再试。` };
  }
  if (!resp.ok) return { ok: false, code: 'api', error: `网易云搜索返回 HTTP ${resp.status}。` };
  let data: any;
  try { data = await resp.json(); } catch { return { ok: false, code: 'api', error: '网易云搜索回了看不懂的内容。' }; }
  const songs: any[] = Array.isArray(data?.result?.songs) ? data.result.songs : [];
  if (!songs.length) {
    return { ok: false, code: 'notfound', error: `网易云没搜到《${song}》${artist ? `（${artist}）` : ''}，换个歌名或去掉歌手名再试。` };
  }
  const clean = songs.filter((s) => {
    const name = String(s?.name ?? '');
    return !/伴奏|纯音乐|instrumental|off\s*vocal|karaoke/i.test(name);
  });
  const pool = clean.length ? clean : songs;
  const wanted = artist.trim().toLowerCase();
  const isMatch = (s: any) => Array.isArray(s?.artists)
    && s.artists.some((a: any) => String(a?.name ?? '').toLowerCase().includes(wanted));
  // 同一歌手常有多个版本（VIP/现场/翻唱），排序还会随请求变：
  // 歌手匹配的版本全部排在前面，首选拿不到播放地址时按顺序再试后面的
  const matched = wanted ? pool.filter(isMatch) : [];
  const ordered = matched.length
    ? [...matched, ...pool.filter((s) => !matched.includes(s))]
    : pool;
  const toInfo = (s: any): SongInfo | null => {
    const id = Number(s?.id);
    const name = String(s?.name ?? '').trim();
    const artists = Array.isArray(s?.artists) ? s.artists.map((a: any) => String(a?.name ?? '')).filter(Boolean).join('/') : '';
    return Number.isFinite(id) && id > 0 && name ? { id, name, artists } : null;
  };
  const infos = ordered.slice(0, 6).map(toInfo).filter((x): x is SongInfo => !!x);
  if (!infos.length) {
    return { ok: false, code: 'notfound', error: `网易云返回的《${song}》没有可用的歌曲 id。` };
  }
  const [first, ...rest] = infos;
  // 备选只收同名版本（VIP/现场/翻唱）：网易云模糊搜索会混进别的歌，宁可报错也不翻错歌
  const alternates = rest.filter((x) => x.name === first.name);
  return { ok: true, song: first, alternates };
}

/** 取原曲音频字节：先走公开 outer 链，失败再问 player/url；VIP/版权歌会明确报错 */
export async function downloadNetease(id: number, timeoutMs: number, maxBytes: number): Promise<Outcome> {
  const headers = { 'user-agent': UA, referer: 'https://music.163.com/' };
  const tryUrl = async (url: string): Promise<Outcome> => {
    let resp: Response;
    try {
      resp = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(Math.min(timeoutMs, 120_000)) });
    } catch (e) {
      return { ok: false, code: 'api', error: `原曲下载失败（${(e as Error).message}）。` };
    }
    if (!resp.ok) return { ok: false, code: 'api', error: `原曲下载返回 HTTP ${resp.status}。` };
    const len = Number(resp.headers.get('content-length') ?? 0);
    if (len > maxBytes) return { ok: false, code: 'api', error: `原曲文件太大（${Math.round(len / 1024 / 1024)}MB），换一首。` };
    let buf: Buffer;
    try { buf = Buffer.from(await resp.arrayBuffer()); } catch (e) {
      return { ok: false, code: 'api', error: `原曲下载中断（${(e as Error).message}）。` };
    }
    if (!buf.length) return { ok: false, code: 'api', error: '原曲下载回来是空文件。' };
    if (buf.length > maxBytes) return { ok: false, code: 'api', error: `原曲文件太大（${Math.round(buf.length / 1024 / 1024)}MB），换一首。` };
    const mime = sniffAudioMime(buf);
    if (!mime) return { ok: false, code: 'api', error: `原曲(id=${id})回来的不是 mp3/wav 音频（可能是 VIP/版权限制页）。` };
    return { ok: true, data: buf, contentType: resp.headers.get('content-type') ?? mime };
  };

  let outer = await tryUrl(`${NETEASE_OUTER}?id=${id}.mp3`);
  // 网易云 CDN 对长连接进程偶发回非音频页（200 + HTML），隔 1.5s 换条连接再试一次
  if (!outer.ok && outer.code === 'api') {
    await sleep(1500);
    const again = await tryUrl(`${NETEASE_OUTER}?id=${id}.mp3`);
    if (again.ok) outer = again; else if (outer.error.includes('不是 mp3/wav')) outer = again;
  }
  if (outer.ok) return outer;
  // outer 链对 VIP/版权歌经常 403/404；再试一次 player/url（标准音质，免登录可用时）。
  let resp: Response;
  try {
    resp = await fetch(`https://music.163.com/api/song/enhance/player/url?ids=[${id}]&br=128000`, {
      headers, signal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)),
    });
  } catch {
    return outer;
  }
  if (!resp.ok) return outer;
  let data: any;
  try { data = await resp.json(); } catch { return outer; }
  const url = String(data?.data?.[0]?.url ?? '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    // outer 失败的原因往往才是真相（HTTP 403=版权、网络错=网易云抽风），带出来好排查
    return { ok: false, code: 'notfound', error: `网易云没给这首歌的播放地址（可能是 VIP/版权限制），换一首试试。[${outer.code === 'api' ? outer.error : 'outer 失败'}]` };
  }
  const second = await tryUrl(url);
  return second.ok ? second : outer;
}

function jobHeaders(cfg: Cfg): Record<string, string> {
  return {
    ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    // SCOW 门户代理（107 /api/proxy/...）只认会话 Cookie；普通自部署留空
    ...(cfg.cookie ? { cookie: cfg.cookie } : {}),
  };
}

/** 搜歌 → 下载原曲 → POST /cover。异步服务回 202 {id}；老版同步服务直接回音频。 */
async function submitCoverJob(
  cfg: Cfg,
  songQuery: string,
  artistQuery: string,
  withInstrumental: boolean,
): Promise<
  | { ok: true; song: SongInfo; jobId: string; seconds?: number }
  | { ok: true; song: SongInfo; direct: { data: Buffer; seconds?: number; contentType?: string } }
  | { ok: false; code: FailCode; error: string }
> {
  const label = '翻唱服务';
  if (!cfg.baseUrl) {
    return { ok: false, code: 'config', error: '翻唱服务还没配置：请主人在「插件 → 翻唱」里填 baseUrl（107 的 SCOW 代理地址）。' };
  }
  const found = await searchNetease(songQuery, artistQuery, cfg.timeoutMs);
  if (!found.ok) return found;
  const candidates = [found.song, ...found.alternates];
  let song = candidates[0];
  let downloaded = await downloadNetease(song.id, cfg.timeoutMs, cfg.maxSongMb * 1024 * 1024);
  // 首选版本可能是 VIP/版权拿不到流，按同名备选逐个再试（绝不跨歌名）
  for (let i = 1; i < candidates.length && !downloaded.ok; i++) {
    if (downloaded.code !== 'notfound' && downloaded.code !== 'api') break;
    song = candidates[i];
    downloaded = await downloadNetease(song.id, cfg.timeoutMs, cfg.maxSongMb * 1024 * 1024);
  }
  if (!downloaded.ok) return downloaded;

  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(downloaded.data)], { type: 'audio/mpeg' }), `${song.name || 'song'}.mp3`);
  form.append('with_instrumental', withInstrumental ? 'true' : 'false');
  form.append('vocal_gain', '1');
  form.append('instrumental_gain', '1');
  const base = cfg.baseUrl.replace(/\/+$/, '');
  let resp: Response;
  try {
    resp = await fetch(`${base}/cover`, {
      method: 'POST',
      headers: jobHeaders(cfg),
      body: form as any,
      // 107 的 nginx 代理约 60s 就 504；上传通常远快于这个值
      signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 55_000)),
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      return { ok: false, code: 'timeout', error: `${label} 提交超时了（55 秒），稍后再试。` };
    }
    return { ok: false, code: 'api', error: `${label} 连不上（${(e as Error).message}），稍后再试。` };
  }
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    return { ok: false, code: 'api', error: httpError(label, resp.status, raw) };
  }

  const ctype = (resp.headers.get('content-type') ?? '').toLowerCase();
  if (ctype.startsWith('audio/')) {
    let direct: Buffer;
    try { direct = Buffer.from(await resp.arrayBuffer()); } catch (e) {
      return { ok: false, code: 'api', error: `翻唱结果读取中断（${(e as Error).message}）。` };
    }
    if (!direct.length) return { ok: false, code: 'api', error: '翻唱服务返回了空音频。' };
    const mime = sniffAudioMime(direct);
    if (!mime) return { ok: false, code: 'api', error: '翻唱服务回来的不是 mp3/wav。' };
    const rawSeconds = Number(resp.headers.get('x-cover-seconds') ?? 0);
    return {
      ok: true, song,
      direct: {
        data: direct, contentType: ctype,
        seconds: Number.isFinite(rawSeconds) && rawSeconds > 0 ? Math.round(rawSeconds) : undefined,
      },
    };
  }

  let submitted: any;
  try { submitted = await resp.json(); } catch {
    return { ok: false, code: 'api', error: `${label} 没有返回任务 id（可能还是旧版同步接口）。` };
  }
  const jobId = String(submitted?.id ?? '').trim();
  if (!submitted?.ok || !jobId) {
    return { ok: false, code: 'api', error: `${label} 没有返回任务 id。` };
  }
  const hint = Number(submitted?.seconds ?? 0);
  return { ok: true, song, jobId, seconds: Number.isFinite(hint) && hint > 0 ? Math.round(hint) : undefined };
}

type JobStatus =
  | { kind: 'wait' }                        // queued/running，或代理瞬时抖动（继续轮询）
  | { kind: 'done'; seconds?: number }
  | { kind: 'failed'; error: string };

/** 一次性查任务状态；代理 502/503/504 或单次超时都算 wait，由调用方决定重试还是放弃 */
async function fetchCoverStatus(cfg: Cfg, jobId: string): Promise<JobStatus> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  let poll: Response;
  try {
    poll = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`, {
      headers: jobHeaders(cfg), signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { kind: 'wait' };
  }
  if (!poll.ok) {
    if (poll.status === 404) return { kind: 'failed', error: '找不到这个翻唱任务（服务可能重启过），稍后再试。' };
    if ([429, 502, 503, 504].includes(poll.status)) return { kind: 'wait' };
    const raw = await poll.text().catch(() => '');
    return { kind: 'failed', error: httpError('翻唱服务', poll.status, raw) };
  }
  let st: any;
  try { st = await poll.json(); } catch { return { kind: 'wait' }; }
  const status = String(st?.status ?? '');
  if (status === 'done') {
    const s = Number(st?.seconds ?? 0);
    return { kind: 'done', seconds: Number.isFinite(s) && s > 0 ? Math.round(s) : undefined };
  }
  if (status === 'failed') {
    return { kind: 'failed', error: String(st?.error ?? '').trim().slice(0, 300) };
  }
  return { kind: 'wait' };
}

/** 下载任务产物（mp3/wav 校验与大小限制都在这） */
async function fetchCoverAudio(cfg: Cfg, jobId: string, knownSeconds?: number): Promise<Outcome> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  let audioResp: Response;
  try {
    audioResp = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}/audio`, {
      headers: jobHeaders(cfg), signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return { ok: false, code: 'api', error: `翻唱服务 结果下载失败（${(e as Error).message}）。` };
  }
  if (!audioResp.ok) {
    const raw = await audioResp.text().catch(() => '');
    return { ok: false, code: 'api', error: httpError('翻唱服务', audioResp.status, raw) };
  }
  let data: Buffer;
  try { data = Buffer.from(await audioResp.arrayBuffer()); } catch (e) {
    return { ok: false, code: 'api', error: `翻唱结果读取中断（${(e as Error).message}）。` };
  }
  if (!data.length) return { ok: false, code: 'api', error: '翻唱服务返回了空音频。' };
  if (data.length > OUT_MAX_BYTES) return { ok: false, code: 'api', error: '翻唱结果太大（超过 60MB），放弃发送。' };
  const mime = sniffAudioMime(data);
  if (!mime) return { ok: false, code: 'api', error: '翻唱服务回来的不是 mp3/wav（可能把错误信息当音频返回了）。' };
  const rawSeconds = Number(audioResp.headers.get('x-cover-seconds') ?? 0);
  const seconds = knownSeconds ?? (Number.isFinite(rawSeconds) && rawSeconds > 0 ? Math.round(rawSeconds) : undefined);
  return { ok: true, data, contentType: audioResp.headers.get('content-type') ?? mime, seconds };
}

/** 会话工具那条路：提交后在插件里阻塞轮询到 done 再取回音频（LLM 调用没有 HTTP 超时问题） */
async function awaitCoverResult(
  cfg: Cfg, jobId: string, hintSeconds?: number,
): Promise<Outcome> {
  const deadline = Date.now() + cfg.timeoutMs;
  let seconds = hintSeconds;
  for (;;) {
    if (Date.now() >= deadline) {
      return { ok: false, code: 'timeout', error: `翻唱超时了：等了 ${Math.round(cfg.timeoutMs / 1000)} 秒还没处理完，稍后再试。` };
    }
    await sleep(4000);
    const st = await fetchCoverStatus(cfg, jobId);
    if (st.kind === 'failed') {
      return { ok: false, code: 'api', error: `翻唱服务 处理失败${st.error ? `：${st.error}` : ''}。` };
    }
    if (st.kind === 'done') { seconds = st.seconds ?? seconds; break; }
  }
  return fetchCoverAudio(cfg, jobId, seconds);
}

export function setup(ctx: PluginContext): void {
  const coverDir = join(ctx.pluginDataDir, 'cover');
  mkdirSync(coverDir, { recursive: true });

  const cfg = (): Cfg => ({
    baseUrl: String(ctx.userConfig.baseUrl ?? '').trim().replace(/\/+$/, ''),
    apiKey: String(ctx.userConfig.apiKey ?? '').trim(),
    cookie: String(ctx.userConfig.cookie ?? '').trim(),
    cooldownSeconds: numOf(ctx.userConfig.cooldownSeconds, 120, 0, 3600),
    dailyQuota: numOf(ctx.userConfig.dailyQuota, 5, 0, 100),
    ownerUnlimited: ctx.userConfig.ownerUnlimited !== false,
    timeoutMs: numOf(ctx.userConfig.timeoutMs, 600_000, 30_000, 1_800_000),
    maxSongMb: numOf(ctx.userConfig.maxSongMb, 30, 5, 80),
  });

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
    for (const k of Object.keys(ctx.state.all())) {
      if (k.startsWith(USAGE_PREFIX) && k.slice(USAGE_PREFIX.length) < day) ctx.state.delete(k);
    }
  }

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
    for (const [k, v] of Object.entries(map)) if (ts - Number(v) >= 24 * 3600_000) delete map[k];
    ctx.state.set(COOLDOWN_KEY, map);
  }
  function reserveCooldown(chatKey: string, ts: number): () => void {
    const map = cooldownMap();
    const prev = map[chatKey];
    map[chatKey] = ts;
    ctx.state.set(COOLDOWN_KEY, map);
    return () => {
      const now = cooldownMap();
      if (now[chatKey] !== ts) return;
      if (prev === undefined) delete now[chatKey];
      else now[chatKey] = prev;
      ctx.state.set(COOLDOWN_KEY, now);
    };
  }

  const inflight = new Map<string, symbol>();
  function acquireChatSlot(chatKey: string): (() => void) | undefined {
    if (inflight.has(chatKey)) return undefined;
    const token = Symbol(chatKey);
    inflight.set(chatKey, token);
    return () => { if (inflight.get(chatKey) === token) inflight.delete(chatKey); };
  }

  function cleanupOld(): void {
    try {
      const cutoff = Date.now() - KEEP_MS;
      for (const name of readdirSync(coverDir)) {
        const p = join(coverDir, name);
        try {
          const st = statSync(p);
          if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(p);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  function records(): CoverRecord[] {
    const v = ctx.state.get<CoverRecord[]>(RECORDS_KEY, []);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string' && typeof x.file === 'string') : [];
  }
  function addRecord(rec: CoverRecord): void {
    const list = records();
    list.unshift(rec);
    ctx.state.set(RECORDS_KEY, list.slice(0, RECORDS_MAX));
  }
  function lastErrors(): CoverError[] {
    const v = ctx.state.get<CoverError[]>(ERRORS_KEY, []);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.error === 'string') : [];
  }
  function addError(chatId: string, error: string): void {
    const list = lastErrors();
    list.unshift({ ts: Date.now(), chatId, error });
    ctx.state.set(ERRORS_KEY, list.slice(0, ERRORS_MAX));
  }

  function insideCoverDir(rel: string): string {
    const root = resolve(coverDir);
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`路径越界：${rel}`);
    return abs;
  }

  function dayKey(ts = Date.now()): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  type CoverResult =
    | { ok: true; id: string; song: string; artist: string; seconds: number; exact: boolean; path: string }
    | { ok: false; code: FailCode; error: string };

  // ---------- 护栏（额度/冷却/在途锁）+ 落盘交付，供同步工具路与桌面异步路共用 ----------

  type Prepared = {
    day: string; userId: string;
    /** 失败/取消：退回额度与冷却、释放本会话在途锁 */
    rollback: () => void;
    /** 成功：写盘（deliver 时再发语音）、定冷却、进 records */
    commit: (out: { data: Buffer; seconds?: number }, song: SongInfo, deliver: boolean) => Promise<CoverResult>;
  };
  type PrepareFail = { ok: false; code: FailCode; error: string };

  async function prepare(opts: CoverOpts): Promise<PrepareFail | { ok: true; c: Cfg; p: Prepared; withInstrumental: boolean; songQuery: string; artistQuery: string }> {
    const c = cfg();
    const songQuery = String(opts.song ?? '').trim();
    if (!songQuery) return { ok: false, code: 'config', error: '翻唱失败：歌名是空的。' };
    if (songQuery.length > 80) return { ok: false, code: 'config', error: '翻唱失败：歌名太长了。' };
    const artistQuery = String(opts.artist ?? '').trim().slice(0, 60);
    const withInstrumental = opts.withInstrumental === undefined ? true : opts.withInstrumental !== false && String(opts.withInstrumental) !== 'false';

    if (!c.baseUrl) {
      return { ok: false, code: 'config', error: '翻唱服务还没配置：请主人在「插件 → 翻唱」里填 baseUrl（107 的 SCOW 代理地址）。' };
    }

    const chatKey = `${opts.chat.platform}:${opts.chat.type}:${opts.chat.chatId}`;
    const now = Date.now();
    const releaseSlot = acquireChatSlot(chatKey);
    if (!releaseSlot) return { ok: false, code: 'limit', error: '这个会话已经有一首在翻了，等它唱完再点。' };

    let undoCooldown: (() => void) | undefined;
    if (c.cooldownSeconds > 0) {
      const last = lastOf(chatKey);
      const elapsed = now - last;
      if (last > 0 && elapsed >= 0 && elapsed < c.cooldownSeconds * 1000) {
        const wait = Math.max(1, Math.ceil((c.cooldownSeconds * 1000 - elapsed) / 1000));
        releaseSlot();
        return { ok: false, code: 'limit', error: `刚翻过啦，还有 ${wait} 秒冷却，等一会儿再点。` };
      }
      undoCooldown = reserveCooldown(chatKey, now);
    }

    const day = dayKey(now);
    const privileged = opts.role === 'owner' || opts.role === 'admin';
    const limited = !(c.ownerUnlimited && privileged);
    const used = limited ? usedOf(day, opts.userId) : 0;
    if (limited && used >= c.dailyQuota) {
      undoCooldown?.();
      releaseSlot();
      return { ok: false, code: 'limit', error: `今天翻唱的额度用完了（${used}/${c.dailyQuota} 首，本地零点重置），明天再来。` };
    }
    if (limited) bumpUsage(day, opts.userId, 1);
    let reserved = limited;
    const rollback = (): void => {
      if (reserved) { bumpUsage(day, opts.userId, -1); reserved = false; }
      if (undoCooldown) { undoCooldown(); undoCooldown = undefined; }
      releaseSlot();
    };

    const commit = async (
      out: { data: Buffer; seconds?: number }, song: SongInfo, deliver: boolean,
    ): Promise<CoverResult> => {
      const mime = sniffAudioMime(out.data) ?? 'audio/mpeg';
      const id = newId('cover_');
      const file = `${id}.${mime === 'audio/wav' ? 'wav' : 'mp3'}`;
      const abs = join(coverDir, file);
      try { writeFileSync(abs, out.data); } catch (e) {
        rollback();
        return { ok: false, code: 'storage', error: `翻唱失败：音频写盘出错（${(e as Error).message}）。` };
      }

      if (deliver) {
        try {
          const receipt = await ctx.chat.sendTracked(opts.chat, [{ type: 'record', data: { file: pathToFileURL(abs).href } }]);
          if (receipt.sent <= 0) {
            try { unlinkSync(abs); } catch { /* ignore */ }
            rollback();
            return { ok: false, code: 'api', error: '翻唱好了，但语音被发送限速拦下了、没有真的发出去；过一会儿再点。' };
          }
        } catch (e) {
          try { unlinkSync(abs); } catch { /* ignore */ }
          rollback();
          return { ok: false, code: 'api', error: `翻唱好了，但语音没发出去（${(e as Error).message}）；先别跟对方说唱好了。` };
        }
      }

      reserved = false;
      undoCooldown = undefined;
      releaseSlot();
      if (c.cooldownSeconds > 0) setCooldown(chatKey, Date.now());
      ctx.state.set(LAST_AT_KEY, Date.now());
      // x-cover-seconds 是原曲时长；没有就按 mp3 320k 粗估（exact=false）
      const seconds = out.seconds ?? Math.max(1, Math.round((out.data.length * 8) / 320_000));
      const exact = out.seconds !== undefined;
      addRecord({
        id, ts: Date.now(), userId: opts.recordUserId ?? opts.userId, chatId: opts.chat.chatId,
        song: song.name, artist: song.artists, seconds, file, mime,
      });
      cleanupOld();
      return { ok: true, id, song: song.name, artist: song.artists, seconds, exact, path: abs };
    };

    return { ok: true, c, withInstrumental, songQuery, artistQuery, p: { day, userId: opts.userId, rollback, commit } };
  }

  async function coverCore(opts: CoverOpts): Promise<CoverResult> {
    const prepped = await prepare(opts);
    if (!prepped.ok) return prepped;
    const { c, p } = prepped;
    try {
      const submitted = await submitCoverJob(c, prepped.songQuery, prepped.artistQuery, prepped.withInstrumental);
      if (!submitted.ok) { p.rollback(); return submitted; }
      const out = 'direct' in submitted
        ? { ok: true as const, ...submitted.direct }
        : await awaitCoverResult(c, submitted.jobId, submitted.seconds);
      if (!out.ok) { p.rollback(); return out; }
      return await p.commit({ data: out.data, seconds: out.seconds }, submitted.song, opts.deliver !== false);
    } catch (e) {
      p.rollback();
      return { ok: false, code: 'api', error: `翻唱失败：工具内部出了意外（${(e as Error).message}），稍后再试。` };
    }
  }

  async function cover(opts: CoverOpts): Promise<CoverResult> {
    try {
      const r = await coverCore(opts);
      if (!r.ok) addError(opts.chat.chatId, r.error);
      return r;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 180);
      addError(opts.chat.chatId, `翻唱失败：${msg}`);
      throw e;
    }
  }

  // ---------- LLM 工具 ----------
  ctx.llm.registerTool({
    name: 'cover',
    description: '翻唱一首现成的歌：按歌名去网易云找原曲，保留原曲旋律，把原唱人声换成 bot 自己的音色，再混回伴奏发语音。用户说“翻唱XX”“用你的声音唱XX”“唱一首XX”时用；写新歌（原创词曲）做不到，别硬编。',
    surface: 'chat',
    promptSnippet: '翻唱现成的歌（保留原曲旋律，换成大肥鱼音色，发语音条）',
    promptGuidelines: [
      '对方点名要你唱某首已有的歌（“翻唱起风了”“用你的声音唱晴天”“唱一首XX”）时用 cover；对方让你“写一首关于XX的歌”（原创新歌）时说明自己只会翻唱现成的歌，不要编歌词糊弄。',
      'song 填歌名，artist 可选（同名歌很多时用它指定歌手）；withInstrumental 默认 true，对方要清唱/纯人声时传 false。',
      '一次只翻一首，别连着点；工具会直接把语音发进会话，正文只写一两句收尾，不要复述歌词。',
      '工具返回失败时如实说为什么（搜不到、VIP/版权没播放地址、服务忙、超时），不要假装唱了。',
      '没配 baseUrl 就直说现在翻唱服务没接上；不要自己编造歌名或歌词。',
    ],
    parameters: {
      type: 'object',
      properties: {
        song: { type: 'string', description: '要翻唱的歌名，如“起风了”' },
        artist: { type: 'string', description: '可选：原唱歌手，用来在搜索结果里消歧' },
        withInstrumental: { type: 'boolean', description: '是否混入原曲伴奏，默认 true；false 只发换声后的人声' },
      },
      required: ['song'],
    },
    handler: async (args, tctx): Promise<string> => {
      try {
        const r = await cover({
          chat: tctx.chat,
          userId: String(tctx.event.userId ?? ''),
          role: tctx.role,
          song: args.song,
          artist: args.artist,
          withInstrumental: args.withInstrumental,
        });
        if (!r.ok) return r.error;
        const who = r.artist ? `（${r.artist}）` : '';
        return r.exact
          ? `已经把《${r.song}》${who}翻唱成语音发进会话了（约 ${r.seconds} 秒）。正文用一两句收尾就行，不要复述歌词。`
          : `已经把《${r.song}》${who}翻唱成语音发进会话了。正文用一两句收尾就行，不要复述歌词。`;
      } catch (e) {
        return `翻唱失败：工具内部出了意外（${String((e as Error)?.message ?? e).slice(0, 160)}），稍后再试。`;
      }
    },
  });

  // ---------- chat 轮说明 ----------
  ctx.hooks.beforeLLM = (req) => {
    const c = cfg();
    if (!req.systemSections) req.systemSections = [];
    const lines = [
      '# 翻唱',
      '- 对方点名要你唱一首已有的歌（“翻唱起风了”“用你的声音唱晴天”）时，调用 cover：它保留原曲旋律，只把原唱人声换成大肥鱼音色，再混回伴奏发语音。',
      '- 对方让你“写一首关于XX的歌”（原创新歌）时做不到：只会翻唱现成的歌，如实说明，别编词曲或假装唱了。',
      '- 调用之后正文只写一两句收尾（例如“翻好啦～”），不要复述歌词全文，也不要让用户再点链接或保存文件。',
      '- 一次只翻一首；刚翻完还在冷却里，别连着调用。',
    ];
    if (!c.baseUrl) {
      lines.push('- 这台 bot 还没配置翻唱服务地址（baseUrl），现在翻不了；对方要点歌就直说。');
    }
    req.systemSections.push({ order: 292, title: 'cover', text: lines.join('\n') });
    return req;
  };

  // ---------- REST（桌面端「翻唱」页：/status /records /audio /preview+job /send） ----------
  const ownerId = (): string => {
    const ids = (ctx.config as { masterIds?: unknown }).masterIds;
    return Array.isArray(ids) && ids.length ? String(ids[0]) : 'owner';
  };
  const desktopChat = (): ChatRef => ({ platform: 'ui', type: 'private', chatId: 'desktop' });

  ctx.http.on('GET', '/status', (req) => {
    const c = cfg();
    const userId = String(req.query.userId ?? '').trim() || ownerId();
    const lastAt = Number(ctx.state.get<number | null>(LAST_AT_KEY, null));
    return {
      body: {
        ok: true,
        baseUrlSet: !!c.baseUrl,
        lastGenerationAt: Number.isFinite(lastAt) && lastAt > 0 ? lastAt : null,
        today: { userId, count: usedOf(dayKey(), userId) },
      },
    };
  });

  ctx.http.on('GET', '/records', () => ({
    body: {
      ok: true,
      records: records().map((r) => ({
        id: r.id, ts: r.ts, userId: r.userId, chatId: r.chatId, song: r.song,
        artist: r.artist, seconds: r.seconds, file: r.file, mime: r.mime,
      })),
      lastErrors: lastErrors().map((e) => ({ ts: e.ts, chatId: e.chatId, error: e.error })),
    },
  }));

  ctx.http.on('GET', '/audio', (req) => {
    const id = String(req.query.id ?? '').trim();
    const rec = id ? records().find((r) => r.id === id) : undefined;
    if (!rec) return { status: 404, body: { ok: false, error: '没有这条翻唱（id 不存在或已被清理）' } };
    let abs: string;
    try { abs = insideCoverDir(rec.file); } catch (e) {
      return { status: 404, body: { ok: false, error: `音频读不到：${(e as Error).message}` } };
    }
    let buf: Buffer;
    try { buf = readFileSync(abs); } catch { return { status: 404, body: { ok: false, error: '音频文件已被清理' } }; }
    return {
      headers: { 'content-type': rec.mime || 'audio/mpeg' },
      body: buf,
    };
  });

  // 桌面端「试翻」是异步任务：HTTP 请求不能挂着等几十分钟（内核 server 5 分钟会掐断），
  // 提交立刻回 202 + jobId，插件后台跑 coverCore（deliver:false），页面轮询 /job。
  // 热重载会丢掉在途任务的句柄，但额度/冷却/记录本身都落 plugin_kv，不脏。
  type DeskJob = {
    id: string; status: 'running' | 'done' | 'failed';
    song?: string; artist?: string; seconds?: number; resultId?: string;
    error?: string; startedAt: number; finishedAt?: number;
  };
  const deskJobs = new Map<string, DeskJob>();

  ctx.http.on('POST', '/preview', async (req) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    for (const j of deskJobs.values()) {
      if (j.status === 'running') {
        return { status: 409, body: { ok: false, error: `已经有一首在试翻了${j.song ? `（《${j.song}》）` : ''}，等它完成再点。` } };
      }
    }
    for (const [k, j] of deskJobs) {
      if (j.status !== 'running' && Date.now() - (j.finishedAt ?? j.startedAt) > 3600_000) deskJobs.delete(k);
    }
    const jobId = newId('dj_');
    const job: DeskJob = { id: jobId, status: 'running', startedAt: Date.now() };
    deskJobs.set(jobId, job);
    void cover({
      chat: desktopChat(),
      userId: ownerId(),
      role: 'owner',
      recordUserId: 'desktop',
      deliver: false,
      song: body.song,
      artist: body.artist,
      withInstrumental: body.withInstrumental,
    }).then((r) => {
      job.finishedAt = Date.now();
      if (r.ok) {
        job.status = 'done';
        job.resultId = r.id; job.song = r.song; job.artist = r.artist; job.seconds = r.seconds;
      } else {
        job.status = 'failed';
        job.error = r.error;
      }
    });
    return { status: 202, body: { ok: true, id: jobId, status: 'running' } };
  });

  ctx.http.on('GET', '/job', (req) => {
    const id = String(req.query.id ?? '').trim();
    const job = id ? deskJobs.get(id) : undefined;
    if (!job) return { status: 404, body: { ok: false, error: '没有这个试翻任务（内核可能重启或重载过）' } };
    return {
      body: {
        ok: true,
        status: job.status,
        ...(job.resultId ? { id: job.resultId, song: job.song, artist: job.artist, seconds: job.seconds } : {}),
        ...(job.error ? { error: job.error } : {}),
        elapsed: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
      },
    };
  });

  ctx.http.on('POST', '/send', async (req) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const id = String(body.id ?? '').trim();
    const type = body.type === 'private' ? 'private' : body.type === 'group' ? 'group' : null;
    const chatId = String(body.chatId ?? '').trim();
    const text = String(body.text ?? '').trim().slice(0, 200);
    const rec = id ? records().find((r) => r.id === id) : undefined;
    if (!rec) return { status: 404, body: { ok: false, error: '没有这条翻唱（id 不存在或已被清理）' } };
    if (!type || !chatId) return { status: 400, body: { ok: false, error: '要指定 type（group/private）与 chatId' } };
    if (!/^\d{5,12}$/.test(chatId)) return { status: 400, body: { ok: false, error: 'chatId 要是 QQ 号/群号（5~12 位数字）' } };
    let abs: string;
    try { abs = insideCoverDir(rec.file); } catch (e) {
      return { status: 400, body: { ok: false, error: (e as Error).message } };
    }
    if (!existsSync(abs)) return { status: 404, body: { ok: false, error: '音频文件已被清理' } };
    const target = { platform: 'qq', type, chatId } as const;
    try {
      const voice = await ctx.chat.sendTracked(target, [{ type: 'record', data: { file: pathToFileURL(abs).href } }]);
      if (voice.sent <= 0) return { status: 502, body: { ok: false, error: '发送被限速拦下了，没有真的发出去' } };
      let warning = '';
      if (text) {
        const textReceipt = await ctx.chat.sendTracked(target, [{ type: 'text', data: { text } }]);
        if (textReceipt.sent <= 0) warning = '附言被限速拦下，没有发出去';
      }
      return { body: { ok: true, messageId: voice.ids[0] ?? null, ...(warning ? { warning } : {}) } };
    } catch (e) {
      return { status: 502, body: { ok: false, error: `发不出去：${(e as Error).message}` } };
    }
  });
}
