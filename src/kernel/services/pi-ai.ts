// ============================================================
// pi-ai 桥接：把 parallel 的请求/回复形状接到 @earendil-works/pi-ai 上
//
// 定位：**模型层的唯一引擎**。三种「连接方式」（openai-compatible / openai-responses / anthropic）
// 一律交给 pi-ai 跑；内核自己不再实现任何线格式（自研那 554 行已于 2026-09-28 删除）。
// 它产出 parallel 自己的 LLMResponse，所以 AgentLoop、插件、UI 都无感。
//
// 内核在这层之上只保留自己的价值面：供应商配置、聊天/工作两条优先链与降级阈值、用量账、
// 模型页契约（applyModelCfg 的整形）、以及 apiKey 只从自己的 secrets.json 按请求传
// （不进 pi-ai 的凭证库）。agent loop 用的是 `LlmService.chainStreamFn`——它把降级链套在
// pi-ai 的流外面，**不是**让 agent loop 直连 pi-ai。
//
// pi-ai 与 pi-agent-core 是硬依赖（约 100MB / 50+ 包，含 openai / @anthropic-ai / @google /
// @aws-sdk + @smithy）。项目原先是"唯一依赖 ws、运行时零 npm"，这条已按用户决定放开。
//
// 映射口径（都是有意的选择，不要"顺手统一"）：
//  - thinking 增量不进 content：parallel 的 content 是给用户看的正文，思考走 events/日志。
//  - usage：promptTokens = input + cacheRead（两家的 prompt_tokens 含缓存命中），
//    cacheHitTokens = cacheRead、cacheMissTokens = input；保持 prompt >= cacheHit 这条不变式。
//  - 附件：图片走 pi-ai 的 ImageContent（它原生支持），在 `toPiMessages` 里**按消息归位**
//    （每条消息自己的图挂在自己那条上，读盘/取 URL 转 base64 都在那一步）；**音频/视频 pi-ai 的
//    content 块里没有**，所以在它的 `onPayload` 扩展点上直接补进请求体（见 injectMedia）。
//    只补它认的三种线格式，Anthropic Messages 没有音频/视频块，遇到就记 warn 跳过——不硬塞、不静默丢。
//  - Gemini 原生那一档（google-generative-ai）：pi-ai 底下是 @google/genai SDK，
//    它把 `model.baseUrl` 当"已含版本段"用（自己拼 `/models/<id>:streamGenerateContent?alt=sse`、
//    key 走 `x-goog-api-key` 头），所以 baseUrl 必须先过 geminiApiBase 归一，多一段 /models 就 404。
//  - finishReason 是 pi-ai **归一化后**的词表（stop/length/toolUse/error/aborted…），与自研后端
//    回传的原始字符串（如 OpenAI 的 tool_calls）不同；调用方只当不透明标记，别按字符串比对。
// ============================================================

import { readFileSync, statSync } from 'node:fs';
import type { ChatMessage, LLMChatRequest, LLMResponse, LLMUsage, MessageAttachment, ToolCall, ToolDef } from '../types.ts';
import { fetchBuffer, findFfmpeg, toWavFile } from './media.ts';

export type PiProtocol = 'openai-compatible' | 'openai-responses' | 'anthropic' | 'gemini';

/** Google 原生线格式的 api 名（pi-ai 的键），补媒体块时要按它分支 */
const GOOGLE_API = 'google-generative-ai';

/** parallel 的连接方式 → pi-ai 的 api 名 + 懒加载模块（只有真用到才 import 那个 api 实现） */
const PROTOCOL_API: Record<PiProtocol, { api: string; module: string; exportName: string }> = {
  'openai-compatible': {
    api: 'openai-completions',
    module: '@earendil-works/pi-ai/api/openai-completions.lazy',
    exportName: 'openAICompletionsApi',
  },
  'openai-responses': {
    api: 'openai-responses',
    module: '@earendil-works/pi-ai/api/openai-responses.lazy',
    exportName: 'openAIResponsesApi',
  },
  'anthropic': {
    api: 'anthropic-messages',
    module: '@earendil-works/pi-ai/api/anthropic-messages.lazy',
    exportName: 'anthropicMessagesApi',
  },
  'gemini': {
    api: GOOGLE_API,
    module: '@earendil-works/pi-ai/api/google-generative-ai.lazy',
    exportName: 'googleGenerativeAIApi',
  },
};

export function isPiProtocol(proto: string): proto is PiProtocol {
  return proto in PROTOCOL_API;
}

/** Gemini 的 Base URL 归一：模型页里填 `…/v1beta` 或 `…/v1beta/models` 都行（Google 文档两种都写），
 *  但 SDK 只会往后拼 `/models/<id>:streamGenerateContent`，所以尾部那段 models 必须摘掉、
 *  版本段缺失时补上默认的 v1beta。 */
export function geminiApiBase(raw: string): string {
  let s = (raw ?? '').trim().replace(/\/+$/, '');
  if (/\/models$/i.test(s)) s = s.slice(0, -'/models'.length).replace(/\/+$/, '');
  if (!/^v\d/i.test(s.split('/').pop() ?? '')) s += '/v1beta';
  return s;
}

/** 交给 pi-ai 的 baseUrl：只有 gemini 这档需要归一，其余原样（别把别人的路径改坏） */
export function providerBaseUrl(protocol: PiProtocol | string, url: string): string {
  return protocol === 'gemini' ? geminiApiBase(url) : url;
}

/** pi-ai 主模块（懒加载 + 缓存；没装返回 null） */
let piai: any | null | undefined;
async function loadPiAi(): Promise<any | null> {
  if (piai !== undefined) return piai;
  try {
    piai = await import('@earendil-works/pi-ai');
  } catch {
    piai = null;
  }
  return piai;
}

/** 装了没（模型页与自检用） */
export async function piAiInstalled(): Promise<boolean> {
  return (await loadPiAi()) !== null;
}

const NOT_INSTALLED = '未安装 @earendil-works/pi-ai：请先 `npm i @earendil-works/pi-ai`，或把供应商的连接方式改回内置实现';

export interface PiCheapLog {
  warn?(msg: string, extra?: Record<string, unknown>): void;
}

export interface PiChatOptions {
  providerId: string;
  protocol: PiProtocol;
  baseUrl: string;
  apiKey: string;
  /** 模型元数据（连 pi-ai 的 Model 需要 contextWindow / maxTokens / 是否支持图片） */
  model: { id: string; contextWindow?: number; maxTokens?: number; image?: boolean };
  req: LLMChatRequest;
  onDelta?: (d: { text?: string; toolCall?: Partial<ToolCall> & { index: number } }) => void;
  log?: PiCheapLog;
  /** 自带 api 实现（mock 这类进程内引擎用）；给了就不去 import 线格式模块 */
  engine?: { apiName: string; api: unknown };
}

/** 从 parallel 的供应商配置造一份 pi-ai Model（走链的流函数与直连都复用它） */
export async function piModelFor(o: {
  providerId: string; protocol: PiProtocol; engineApi?: string;
  baseUrl: string; model: { id: string; contextWindow?: number; maxTokens?: number; image?: boolean };
}): Promise<any> {
  const pie = await loadPiAi();
  if (!pie) throw new PiNotInstalledError(NOT_INSTALLED);
  const api = o.engineApi ?? PROTOCOL_API[o.protocol].api;
  return toPiModel(pie, { ...o, req: { model: '', messages: [] } } as PiChatOptions, api);
}

/** pi-ai 主模块（走链的流函数要用它的 createModels / 流事件工厂） */
export async function piAiModule(): Promise<any | null> {
  return loadPiAi();
}

/** 连接方式对应的 pi-ai api 实现（懒加载工厂调用一次） */
export async function piApiImpl(protocol: PiProtocol): Promise<unknown> {
  const meta = PROTOCOL_API[protocol];
  return (await import(/* @vite-ignore */ meta.module))[meta.exportName]();
}

/** 一份 Model 定义（pi-ai 的 Model 只要元数据，请求级参数另传）。
 *  `api` 必须与 provider 注册时那个 api 键一致，否则 pi-ai 会报 "no API implementation for …" ——
 *  带自定义引擎（mock）时用的是引擎的 api 名，不是连接方式推导出来的那个。 */
function toPiModel(pie: any, o: PiChatOptions, api: string): any {
  return {
    id: o.model.id,
    name: o.model.id,
    api,
    provider: o.providerId,
    baseUrl: providerBaseUrl(o.protocol, o.baseUrl),
    reasoning: false,
    input: o.model.image ? ['text', 'image'] : ['text'],
    // 单价全 0：parallel 的模型页不维护单价，账单由 usage 自己算，不假装知道价钱
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: o.model.contextWindow && o.model.contextWindow > 0 ? o.model.contextWindow : 128_000,
    maxTokens: o.model.maxTokens && o.model.maxTokens > 0 ? o.model.maxTokens : 4096,
  };
}

/** parallel 的 message 数组 → pi-ai 的 Message[]，外加「该并进 system 的设定文本」。
 *  中途出现的 system（人格插件那几条设定）**不折成 user 轮**：Gemini 的 contents 只认 user/model，
 *  而当 user 发出去会让模型把内设读成对面念给它的话（实测它回过「你怎么又在念这串奇怪的咒语啊」）。
 *  三种线格式唯一的共同落点是 system 末尾，所以这里把它们摘出来交回调用方拼进 systemPrompt。
 *  agent loop 与插件直连共用这一份，别在调用方各写一遍。
 *
 *  `opt.attachmentsFor(i)`：第 i 条**输入消息自己的**附件（窗口内历史按消息归位；本轮那些属于最后一条）。
 *  其中的**图片**在这里读成 pi-ai 原生的 ImageContent 块、PREPEND 到该条 content 最前——
 *  每张图长在它当时那条消息上，模型才知道"哪句话配的哪张图"。
 *  音频/视频没有 pi-ai 的 content 块可放，由调用方收起来走 onPayload（见 chainStreamFn 与 injectMedia）。
 *  时间戳取消息自带的 `ts`（上下文时间窗筛的也是同一个值），老条目没有 ts 才盖 now。 */
export async function toPiMessages(
  messages: ChatMessage[],
  model: { id: string; provider: string },
  api: string,
  opt?: { attachmentsFor?: (i: number) => MessageAttachment[] | undefined },
): Promise<{ messages: any[]; extraSystem: string; failedImages: number }> {
  const out: any[] = [];
  const lifted: string[] = [];
  let failedImages = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system') {
      if (m.content?.trim()) lifted.push(m.content.trim());
      continue;
    }
    if (m.role === 'user') {
      const images: any[] = [];
      const own = opt?.attachmentsFor?.(i);
      if (own?.length) {
        const loaded = await loadImages(own);
        images.push(...loaded.images);
        failedImages += loaded.failed;
      }
      out.push({ role: 'user', content: [...images, { type: 'text', text: m.content }], timestamp: m.ts ?? Date.now() });
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'toolResult',
        toolCallId: m.tool_call_id ?? '',
        toolName: m.name ?? '',
        content: [{ type: 'text', text: m.content }],
        isError: false,
        timestamp: m.ts ?? Date.now(),
      });
      continue;
    }
    // assistant：正文块 + 工具调用块；重放历史时补齐 pi-ai 要求的元数据字段
    const content: any[] = [];
    if (m.content?.trim()) content.push({ type: 'text', text: m.content });
    for (const tc of m.tool_calls ?? []) {
      let args: unknown = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      content.push({ type: 'toolCall', id: tc.id, name: tc.function.name, arguments: args });
    }
    if (!content.length) content.push({ type: 'text', text: '' });
    out.push({
      role: 'assistant',
      content,
      api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: m.tool_calls?.length ? 'toolUse' : 'stop',
      timestamp: m.ts ?? Date.now(),
    });
  }
  return { messages: out, extraSystem: lifted.join('\n\n'), failedImages };
}

/** 图片附件 → pi-ai 的 ImageContent；data URL 拆成 base64 + mimeType。读不动的记一条待报。 */
async function loadImages(attachments: LLMChatRequest['attachments']): Promise<{ images: any[]; failed: number }> {
  const images: any[] = [];
  let failed = 0;
  for (const a of attachments ?? []) {
    if (a.kind !== 'image') continue;
    const b64 = await loadBase64(a);
    if (b64) images.push({ type: 'image', data: b64, mimeType: a.mime ?? 'image/png' });
    else failed++;
  }
  return { images, failed };
}

/** 把一条附件读成 Buffer：先试本机路径，读不动再按 url 取（沙箱收件可能被保留期清掉，那份 URL 还在） */
async function loadBuffer(a: MessageAttachment): Promise<Buffer | null> {
  try {
    if (a.path) return readFileSync(a.path);
  } catch { /* 换 URL 再试 */ }
  try {
    if (a.url) return await fetchBuffer(a.url);
  } catch { /* 取不到就当作读不动 */ }
  return null;
}

async function loadBase64(a: MessageAttachment): Promise<string | null> {
  return (await loadBuffer(a))?.toString('base64') ?? null;
}

/** 音频容器 → OpenAI `input_audio.format` 认的名字；认不出来就交给 ffmpeg 转 wav */
function audioFormatOf(mime: string): 'wav' | 'mp3' | undefined {
  if (/wav/.test(mime)) return 'wav';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  return undefined;
}

/**
 * 把图片块挂到最后一条 user 消息上，返回**新数组**（原消息对象不动）。
 * agent loop 传进来的 context 是它自己的活动 transcript：就地塞 base64 会一直留在历史里，
 * 每一轮工具往返都重发一遍。
 * 「最后一条 user」就是本轮真人那句：人格插件的设定由 toPiMessages 摘进 system，不再占 user 轮，
 * 所以图片与 injectMedia 补进去的音视频块都落在同一条真人消息上。
 * 只有插件直连（chatViaPiAi）走这条路；agent loop 主链路的图由 toPiMessages 的 attachmentsFor 按消息归位。
 */
export function withImages(messages: any[], images: any[]): any[] {
  const i = messages.map((m: any) => m?.role).lastIndexOf('user');
  if (i < 0 || !images.length) return messages;
  const m = messages[i];
  const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
  return [...messages.slice(0, i), { ...m, content: [...images, ...content] }, ...messages.slice(i + 1)];
}

export interface PreparedMedia {
  images: any[];
  /** 音频块（按各家线格式成形，见 audioBlock）——**数组**：窗口内可能带多条语音，逐条送 */
  audios: Record<string, unknown>[];
  /** 视频块（见下面的视频口径）——同上，逐条送 */
  videos: Record<string, unknown>[];
  /** @deprecated 兼容别名：= audios[0] / videos[0]（老调用方只认单块）；新代码一律用数组 */
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
  /** 补不进去的那部分及原因 */
  skipped: string[];
}

/** 音频块：OpenAI 两家是 `input_audio` 内容项，Gemini 原生是 `inlineData` part（无 type 字段） */
function audioBlock(api: string, b64: string, format: 'wav' | 'mp3'): Record<string, unknown> {
  if (api === GOOGLE_API) return { inlineData: { mimeType: format === 'mp3' ? 'audio/mpeg' : `audio/${format}`, data: b64 } };
  return { type: 'input_audio', input_audio: { data: b64, format } };
}

/** 视频内联上限（字节）：只有本机文件时才读盘转 base64。
 *  20MB 是两头的夹缝——Gemini 的请求体上限与 token 体积都不允许把大视频塞进一发请求，
 *  而 QQ 视频动辄几十 MB；超过这一档就按"读不动"跳过（有公网 URL 的照旧递 URL，由对端自己去取）。 */
const VIDEO_INLINE_MAX_BYTES = 20 * 1024 * 1024;
const VIDEO_INLINE_MAX_MB = VIDEO_INLINE_MAX_BYTES / 1024 / 1024;

const isHttpUrl = (u?: string): u is string => !!u && /^https?:\/\//.test(u);

/** 视频只有本机文件时读成 base64（≤20MB 才读）；读不动返回 null，由调用方如实跳过、不静默丢 */
async function loadVideoInline(a: MessageAttachment): Promise<{ b64: string; mime: string } | null> {
  if (!a.path) return null;
  try {
    const st = statSync(a.path);
    if (!st.isFile() || st.size > VIDEO_INLINE_MAX_BYTES) return null;
  } catch {
    return null;
  }
  const buf = await loadBuffer(a);
  if (!buf) return null;
  return { b64: buf.toString('base64'), mime: a.mime ?? 'video/mp4' };
}

/**
 * 准备本轮附件：
 *  - 图片 → pi-ai 原生的 ImageContent 块（由调用方挂到对应消息上；播种区的归位由 agentloop 决定）
 *  - 音频 → 逐条读成 base64，容器对端不收时用 ffmpeg 转 16k 单声道 wav；转不动就跳过并说明原因
 *  - 视频 → 优先公网 URL；只有本机文件且 ≤20MB 才读成 base64 内联，否则跳过并说明原因
 * `api` 决定能补哪些：Anthropic Messages 两者都没有块，直接进 skipped。
 */
export async function prepareMedia(o: { attachments?: MessageAttachment[]; api: string }): Promise<PreparedMedia> {
  const { images, failed } = await loadImages(o.attachments);
  const skipped: string[] = [];
  if (failed) skipped.push(`${failed} 张图片读不动（路径/URL 取不到）`);

  const audios = (o.attachments ?? []).filter((a) => a.kind === 'audio');
  const videos = (o.attachments ?? []).filter((a) => a.kind === 'video');
  const out: PreparedMedia = { images, audios: [], videos: [], skipped };
  const done = (): PreparedMedia => {
    // 兼容别名：等于数组第一条（老调用方只认单块）。多条的场合下它只是"第一条"，别拿它当全部。
    if (out.audios[0]) out.audio = out.audios[0];
    if (out.videos[0]) out.video = out.videos[0];
    return out;
  };

  if (o.api === 'anthropic-messages') {
    if (audios.length) skipped.push('Anthropic Messages 没有音频输入块');
    if (videos.length) skipped.push('Anthropic Messages 没有视频输入块');
    return done();
  }

  for (const audio of audios) {
    // 语音逐条处理：容器对端认就直接读盘，不认就交给 ffmpeg 转 wav（toWavFile 自带缓存，重复转同一份只转一次）
    const mime = audio.mime ?? '';
    let format = audioFormatOf(mime);
    let b64: string | null = null;
    let why = `语音读取失败（${mime || '未知容器'}）`;
    if (format) {
      b64 = await loadBase64(audio);
    } else if (findFfmpeg()) {
      // silk/amr 这类对端不收的容器：本机先转 wav（要 ffmpeg）
      try {
        const buf = await loadBuffer(audio);
        if (buf) { b64 = readFileSync(await toWavFile(buf, mime)).toString('base64'); format = 'wav'; }
        else why = `语音转不了（${mime || '未知容器'}，源文件也读不到）`;
      } catch {
        why = `语音转不了（${mime || '未知容器'}，ffmpeg 没转出来）`;
      }
    } else {
      why = `语音是 ${mime || '未知'} 容器，对端不收且本机没有 ffmpeg，转不了`;
    }
    if (b64 && format) out.audios.push(audioBlock(o.api, b64, format));
    else skipped.push(why);
  }

  for (const video of videos) {
    if (o.api === 'openai-completions') {
      // 公网 URL 优先（对端自己去取）；只有 file:// 或本机路径时读 base64 内联成 data URL
      if (isHttpUrl(video.url)) {
        out.videos.push({ type: 'video_url', video_url: { url: video.url } });
        continue;
      }
      const inl = await loadVideoInline(video);
      if (inl) out.videos.push({ type: 'video_url', video_url: { url: `data:${inl.mime};base64,${inl.b64}` } });
      else skipped.push(`视频读不动（没有公网 URL，本机文件缺失或超过 ${VIDEO_INLINE_MAX_MB}MB）`);
    } else if (o.api === GOOGLE_API) {
      // Gemini 认 fileData.fileUri（公网 URL 或 Files API 上传件的 /files/xxx）；只有本机文件时才读内联
      if (isHttpUrl(video.url)) {
        out.videos.push({ fileData: { fileUri: video.url, mimeType: video.mime ?? 'video/mp4' } });
        continue;
      }
      const inl = await loadVideoInline(video);
      if (inl) out.videos.push({ inlineData: { mimeType: inl.mime, data: inl.b64 } });
      else skipped.push(`视频只有本机文件且读不动（Gemini 原生线格式要公网 URL；本机文件缺失或超过 ${VIDEO_INLINE_MAX_MB}MB）`);
    } else {
      skipped.push('OpenAI Responses 没有视频输入块');
    }
  }
  return done();
}

/**
 * 在 pi-ai 组装好的请求体上补音频/视频块。
 * 这是 pi-ai 官方给的扩展点（`StreamOptions.onPayload`）：它负责把消息规范化成各家线格式，
 * 我们只在自己知道的那三种线格式上、往最后一条 user 消息里追加它没有的块类型。
 */
export function injectMedia(payload: any, api: string, media: PreparedMedia): any {
  const extra = [...media.audios, ...media.videos];
  if (!extra.length || !payload || typeof payload !== 'object') return payload;
  const p = payload as Record<string, any>;
  try {
    if (api === 'openai-completions') {
      const msgs = Array.isArray(p.messages) ? p.messages : [];
      const last = [...msgs].reverse().find((m: any) => m?.role === 'user');
      if (!last) return payload;
      last.content = [...(typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content ?? []), ...extra];
      return p;
    }
    if (api === 'openai-responses') {
      const input = Array.isArray(p.input) ? p.input : [];
      const last = [...input].reverse().find((m: any) => m?.role === 'user' && Array.isArray(m.content));
      if (!last) return payload;
      last.content = [...last.content, ...extra];
      return p;
    }
    if (api === GOOGLE_API) {
      // 这里拿到的是 @google/genai 的 params（{model, contents, config}）：媒体进最后一条 user 的 parts，
      // 块本身没有 type 字段（{inlineData} / {fileData}），与图片那条走的是同一套 part 形状
      const contents = Array.isArray(p.contents) ? p.contents : [];
      const last = [...contents].reverse().find((c: any) => c?.role === 'user');
      if (!last) return payload;
      last.parts = [...(last.parts ?? []), ...extra];
      return p;
    }
  } catch {
    return payload;   // 补不进去也不能让请求炸掉：正文里仍有 [语音]/[视频] 占位
  }
  return payload;
}

export function mapUsage(u: any): LLMUsage | undefined {
  if (!u) return undefined;
  const cacheRead = Number(u.cacheRead ?? 0);
  const input = Number(u.input ?? 0);
  return {
    promptTokens: input + cacheRead,
    completionTokens: Number(u.output ?? 0),
    cacheHitTokens: cacheRead,
    cacheMissTokens: input,
  };
}

/**
 * 用 pi-ai 跑一次补全。返回的形状与内核自研线格式完全一致，所以调用方（LlmService.invoke）不用分支。
 * 失败一律抛 ProviderError（由 LlmService 的优先链逻辑接住、按阈值降级）。
 */
export async function chatViaPiAi(o: PiChatOptions): Promise<LLMResponse> {
  const pie = await loadPiAi();
  if (!pie) throw new PiNotInstalledError(NOT_INSTALLED);
  const meta = o.engine
    ? { api: o.engine.apiName, module: '', exportName: '' }
    : PROTOCOL_API[o.protocol];

  // 每次调用现建 provider：provider 是"配置 + api 实现"的组合，缓存它反而要处理配置变更失效。
  // createModels/createProvider 本身很轻（不做网络请求），真正贵的是 HTTP。
  const models = pie.createModels();
  // lazy 模块导出的是**工厂**（openAICompletionsApi 是 () => ProviderStreams），必须调用一次
  const apiImpl = o.engine ? o.engine.api : (await import(/* @vite-ignore */ meta.module))[meta.exportName]();
  models.setProvider(pie.createProvider({
    id: o.providerId,
    name: o.providerId,
    baseUrl: providerBaseUrl(o.protocol, o.baseUrl),
    // key 由调用方按请求传（parallel 把 key 存在自己的 secrets.json 里，不走 pi-ai 的凭证库）；
    // 这里给一个"无凭证"解析器，避免 pi-ai 认为该供应商未配置而提前拒绝。
    auth: { apiKey: { name: o.providerId, resolve: async () => ({ auth: {} }) } },
    models: [toPiModel(pie, o, meta.api)],
    api: { [meta.api]: apiImpl },
  }));

  const model = models.getModel(o.providerId, o.model.id);
  if (!model) throw new ProviderError(`pi-ai 不认识模型 ${o.providerId}/${o.model.id}`);

  const media = await prepareMedia({ attachments: o.req.attachments, api: meta.api });
  if (media.skipped.length) {
    o.log?.warn?.(`附件未能全部送达：${media.skipped.join('；')}（正文里仍有 [语音]/[视频] 占位）`, { providerId: o.providerId });
  }

  // 首条 system 走 Context.systemPrompt（pi-ai 会折成开头那条 system 消息）；
  // 中途的 system（人格插件那几条设定）由 toPiMessages 摘出来接到**末尾**——占一条 user 轮会被模型当成对方说的话。
  const sys = o.req.messages[0]?.role === 'system' ? o.req.messages[0].content : '';
  const rest = o.req.messages[0]?.role === 'system' ? o.req.messages.slice(1) : o.req.messages;
  const seeded = await toPiMessages(rest, { id: o.model.id, provider: o.providerId }, meta.api);
  const context = {
    systemPrompt: seeded.extraSystem ? `${sys}\n\n${seeded.extraSystem}` : sys,
    messages: seeded.messages,
    tools: o.req.tools?.length
      ? o.req.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description ?? '',
          // parallel 的工具参数本来就是 JSON Schema，直接包成 TypeBox 的 TSchema，不重写
          parameters: pie.Type.Unsafe(t.function.parameters ?? { type: 'object', properties: {} }),
        }))
      : undefined,
  };
  if (media.images.length) context.messages = withImages(context.messages, media.images);

  let text = '';
  const toolCalls: ToolCall[] = [];
  let finishReason: string | undefined;

  const stream = models.streamSimple(model, context, {
    apiKey: o.apiKey || undefined,
    signal: o.req.signal,
    maxTokens: o.req.maxTokens,
    // 音频/视频：pi-ai 的 content 块里没有这两类，在它组好请求体之后补进去
    onPayload: (payload: unknown) => injectMedia(payload, meta.api, media),
  });

  for await (const ev of stream as AsyncIterable<any>) {
    switch (ev.type) {
      case 'text_delta':
        text += ev.delta ?? '';
        o.onDelta?.({ text: ev.delta ?? '' });
        break;
      case 'thinking_delta':
        // 思考不进 content（parallel 的 content 只给用户看）
        break;
      case 'toolcall_end': {
        const tc = ev.toolCall ?? {};
        const args = tc.arguments === undefined ? {} : tc.arguments;
        toolCalls.push({
          id: String(tc.id ?? `call_${toolCalls.length}`),
          type: 'function',
          function: { name: String(tc.name ?? ''), arguments: typeof args === 'string' ? args : JSON.stringify(args) },
        });
        o.onDelta?.({ toolCall: { id: String(tc.id ?? ''), index: toolCalls.length - 1 } });
        break;
      }
      case 'done': {
        finishReason = ev.reason;
        const usage = mapUsage(ev.message?.usage);
        // 正文以 done 里的完整消息为准（事件流里 text 可能被分片重组）
        const finalText = collectText(ev.message) || text;
        return { content: finalText, toolCalls, usage, finishReason };
      }
      case 'error':
        throw new ProviderError(ev.error?.errorMessage || `pi-ai 流以 ${ev.reason} 结束`);
      default:
        break;
    }
  }
  // 流没有 done 就结束了：拿已经攒到的当结果（不假装成功，finishReason 留空）
  return { content: text, toolCalls, usage: undefined, finishReason };
}

/** 从完整 assistant 消息里取正文（跳过思考块与工具调用块） */
function collectText(message: any): string {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => String(b.text ?? ''))
    .join('');
}

/** pi-ai 没装 / 配置不对：单独一类，便于 UI/自检给出"去装依赖"的提示而不是笼统的调用失败 */
export class PiNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiNotInstalledError';
  }
}

/** 自研那边的 ProviderError 在 llm.ts 里；这里避免循环依赖，用同名语义的轻量错误 */
class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** 供应商的 protocol → pi-ai 的 api 名（模型页/自检展示用） */
export function piApiName(protocol: PiProtocol): string {
  return PROTOCOL_API[protocol].api;
}
