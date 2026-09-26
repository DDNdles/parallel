import type {
  LLMProvider, LLMChatRequest, LLMResponse, ToolCall, ChatMessage, LLMUsage, MessageAttachment,
} from '../types.ts';
import { readFileSync } from 'node:fs';
import type { ConfigStore, ModelRef } from '../config.ts';
import type { ErrorCenter } from '../errors.ts';
import type { Db } from '../db.ts';
import { todayKey } from '../util/misc.ts';
import { fetchBuffer, toWavFile } from './media.ts';
import { busEvents } from '../bus.ts';
import type { Bus } from '../bus.ts';

/** 两条模型优先级链的名字：会话用 chat，work 子代理用 work */
export type ModelChainKind = 'chat' | 'work';
/** 链上一条 + 运行时健康态（桌面端左栏画降级状态用） */
export interface ChainEntry extends ModelRef {
  fails: number;
  state: 'current' | 'idle' | 'down';
}

/**
 * LLM 供应商抽象（红线 §2.2）：
 * - 完整支持 OpenAI-compatible chat completions（流式 + 工具调用）
 * - gemini-3.8-flash：仅注册接口与配置占位，implemented=false，调用时报"未接入"
 * - deepseek / openai-compatible：走同一 HTTP 实现
 * - mock：测试与演示用脚本化供应商
 */
export class LlmService {
  private providers = new Map<string, LLMProvider>();
  /** 按会话累计的 token 账（含缓存命中），内存态；work 侧栏读它算增量 */
  private usageByChat = new Map<string, UsageSnapshot>();
  /** 活跃请求统计（UI 状态条） */
  activeRequests = 0;

  constructor(
    private config: ConfigStore,
    private errors: ErrorCenter,
    private db: Db,
    private bus: Bus,
  ) {
    this.registerProvider(new OpenAiCompatProvider('openai-compatible'));
    this.registerProvider(new OpenAiCompatProvider('deepseek', 'https://api.deepseek.com'));
    this.registerProvider(new GeminiPlaceholderProvider());
    this.registerProvider(new MockProvider());
    this.syncCustomProviders();
  }

  registerProvider(p: LLMProvider): void {
    this.providers.set(p.id, p);
  }

  /** 模型页新建的供应商只落在 config.providers 里，这里按配置补注册实例（元数据用；发请求另按 protocol 选实现） */
  syncCustomProviders(): void {
    const all = this.config.config.providers as Record<string, any>;
    for (const [id, pc] of Object.entries(all)) {
      if (!pc?.custom || this.providers.has(id)) continue;
      const Impl = WIRE_IMPL[String(pc.protocol ?? 'openai-compatible')] ?? OpenAiCompatProvider;
      this.registerProvider(new Impl(id));
    }
  }

  removeProvider(id: string): void {
    this.providers.delete(id);
  }

  /** 模型页的供应商清单：以配置为准（内核里注册的实例只是能力实现，未写进配置的不该出现在界面上） */
  listProviders(): { id: string; label: string; implemented: boolean; streaming: boolean; enabled: boolean; model: string; configured: boolean }[] {
    const all = this.config.config.providers as Record<string, any>;
    const out: ReturnType<LlmService['listProviders']> = [];
    for (const [id, pc] of Object.entries(all)) {
      const p = this.providers.get(id);
      const enabled = pc?.enabled ?? false;
      const key = this.config.getProviderKey(id);
      out.push({
        id, label: pc?.label ?? p?.label ?? id, implemented: p?.implemented ?? false,
        streaming: p?.streaming ?? false, enabled,
        model: pc?.model ?? '',
        configured: enabled && (pc?.protocol === 'mock' || !!key || !pcNeedsKey(id, pc)),
      });
    }
    return out;
  }

  activeProviderId(): string {
    return this.chainConfig('chat')[0]?.provider ?? this.config.config.llm.activeProvider;
  }

  activeModel(): string {
    return this.chainConfig('chat')[0]?.model ?? this.modelFor(this.activeProviderId());
  }

  /** 某供应商"当前使用"的模型名（模型页里选中的那条） */
  modelFor(pid: string): string {
    const llm = this.config.config.llm;
    return llm.modelByProvider?.[pid] ?? (this.config.config.providers as any)[pid]?.model ?? pid;
  }

  /** 配置里的有序模型链。work 链为空 = 跟随 chat 链；两条都空时按 activeProvider 兜底一条（老配置没走过模型页也能跑） */
  chainConfig(kind: ModelChainKind): ModelRef[] {
    const llm = this.config.config.llm;
    const list = kind === 'work' && llm.workChain.length ? llm.workChain : llm.chatChain;
    const clean = (list ?? []).filter((r) => r && r.provider) as ModelRef[];
    if (clean.length) return clean;
    const pid = llm.activeProvider;
    return pid ? [{ provider: pid, model: this.modelFor(pid) }] : [];
  }

  /** 链上当前位置：连续掉线达到阈值后由 markFail 往后挪 */
  private cursor: Record<ModelChainKind, number> = { chat: 0, work: 0 };
  private streaks = new Map<string, number>();

  private threshold(): number {
    const n = Number(this.config.config.llm.failoverThreshold);
    return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 1;
  }

  private ptr(kind: ModelChainKind, len: number): number {
    if (len <= 0) return 0;
    return Math.min(Math.max(this.cursor[kind] | 0, 0), len - 1);
  }

  /** 当前真正在服务的那条（降级后会变） */
  servingRef(kind: ModelChainKind): ModelRef | null {
    const list = this.chainConfig(kind);
    return list[this.ptr(kind, list.length)] ?? null;
  }

  servingLabel(kind: ModelChainKind): string {
    const r = this.servingRef(kind);
    return r ? `${r.provider}:${r.model}` : '—';
  }

  /** 桌面端展示：只回配置里真写过的条目（没配就是空，界面上显示"跟随聊天模型"），
   *  发请求时才由 chainConfig 兜底到 chat 链 / activeProvider。 */
  chainsView(): Record<ModelChainKind, ChainEntry[]> {
    const one = (kind: ModelChainKind): ChainEntry[] => {
      const llm = this.config.config.llm;
      const configured = (kind === 'work' ? llm.workChain : llm.chatChain) ?? [];
      const at = this.ptr(kind, this.chainConfig(kind).length);
      const th = this.threshold();
      return configured.map((r, i) => {
        const fails = this.streaks.get(`${kind}|${r.provider}|${r.model}`) ?? 0;
        return { ...r, fails, state: i === at ? 'current' as const : fails >= th ? 'down' as const : 'idle' as const };
      });
    };
    return { chat: one('chat'), work: one('work') };
  }

  /** work 模型是否与 chat 模型分离（桌面端展示/测试用） */
  workModelSplit(): { chat: string; work: string; split: boolean } {
    const chat = this.servingLabel('chat');
    const work = this.servingLabel('work');
    return { chat, work, split: this.config.config.llm.workChain.length > 0 && chat !== work };
  }

  /** 改链 / 改阈值后调用：位置与失败计数从头开始 */
  resetFailover(): void {
    this.streaks.clear();
    this.cursor = { chat: 0, work: 0 };
  }

  /** 一条链上能不能用（不抛错版，供 /api/state 与登录页用） */
  isActiveUsable(): { ok: boolean; reason?: string } {
    const list = this.chainConfig('chat');
    if (!list.length) return { ok: false, reason: '还没有可用模型：请在桌面端「模型」页的「聊天模型」里加至少一条' };
    const at = this.ptr('chat', list.length);
    let first: { ok: boolean; reason?: string } | null = null;
    for (let i = 0; i < list.length; i++) {
      const ref = list[(at + i) % list.length];
      const c = this.preflight(ref.provider);
      if (c.ok) return first && !first.ok ? { ok: true, reason: `${first.reason}（已降级到 ${ref.provider}）` } : { ok: true };
      first ??= c;
    }
    return first ?? { ok: false, reason: '模型链不可用' };
  }

  /** 单个供应商的可发性预检：配置级问题（未接入/未启用/缺 key/缺 baseUrl）在这里一次判完，
   *  好让降级逻辑把"这条根本发不出去"和"发出去失败了"同等对待。 */
  private preflight(pid: string): { ok: boolean; reason?: string } {
    const p = this.providers.get(pid);
    if (!p) return { ok: false, reason: `未知的模型供应商 ${pid}` };
    if (!p.implemented) return { ok: false, reason: `${pid} 尚未接入：内核只保留了接口与配置占位（enabled=false）。请在桌面端“模型”页切换到已接入的供应商。` };
    const pc = (this.config.config.providers as Record<string, any>)[pid] ?? {};
    const proto = String(pc.protocol ?? 'openai-compatible');
    if (!IMPL_PROTOCOLS.includes(proto)) return { ok: false, reason: `供应商 ${pid} 的连接方式 ${proto} 内核还未实现：当前只会发 Chat Completions（/chat/completions），请在模型页改回该方式或等实现补齐。` };
    if (pc.enabled === false) return { ok: false, reason: `供应商 ${pid} 未启用，请在桌面端“模型”页启用或切换。` };
    if (pcNeedsKey(pid, pc) && !this.config.getProviderKey(pid)) return { ok: false, reason: `供应商 ${pid} 缺少 API Key，请在桌面端“模型”页配置。` };
    if (WIRE_IMPL[proto] && !String(pc.baseUrl ?? '') && !(p as any).defaultBase) return { ok: false, reason: `供应商 ${pid} 缺少 Base URL 配置` };
    return { ok: true };
  }

  /** 连续失败计数：达到阈值才把链上的位置往后挪一格，并通知桌面端 */
  private markFail(kind: ModelChainKind, idx: number, list: ModelRef[], err: Error): void {
    const ref = list[idx];
    const key = `${kind}|${ref.provider}|${ref.model}`;
    const n = (this.streaks.get(key) ?? 0) + 1;
    this.streaks.set(key, n);
    if (list.length < 2 || n < this.threshold()) return;
    const next = (idx + 1) % list.length;
    this.cursor[kind] = next;
    this.bus.emit(busEvents.modelFailover, {
      kind,
      from: `${ref.provider}:${ref.model}`,
      to: `${list[next].provider}:${list[next].model}`,
      fails: n,
      error: err.message.slice(0, 200),
    });
  }

  /** 主入口：按「聊天模型 / 工作模型」优先级链发请求，带用量统计与报错中心。
   *  当前这条失败后会在同一次调用里顺延到下一条（用户不至于收到一条错误），
   *  但链上位置只在连续掉线满阈值后才挪——没到阈值就换模型会被一次网络抖动带偏。
   *  meta.providerId 显式指定时不走链（插件/特殊调用）。 */
  async chat(
    req: LLMChatRequest,
    meta: {
      chatId?: string; pluginId?: string; providerId?: string; model?: string;
      chain?: ModelChainKind; onDelta?: (d: { text?: string }) => void;
    } = {},
  ): Promise<LLMResponse> {
    const kind = meta.chain ?? 'chat';
    const list: ModelRef[] = meta.providerId
      ? [{ provider: meta.providerId, model: meta.model ?? this.modelFor(meta.providerId) }]
      : this.chainConfig(kind);
    if (!list.length) throw new ProviderError('模型链是空的：请在桌面端「模型」页的「聊天模型」里加至少一条');

    const start = meta.providerId ? 0 : this.ptr(kind, list.length);
    let streamed = false;
    const onDelta = meta.onDelta
      ? (d: { text?: string; toolCall?: Partial<ToolCall> & { index: number } }) => { if (d.text) streamed = true; meta.onDelta!(d); }
      : undefined;
    let lastErr: Error = new ProviderError('模型链全部不可用');

    for (let i = 0; i < list.length; i++) {
      const idx = (start + i) % list.length;
      const ref = list[idx];
      const check = this.preflight(ref.provider);
      if (!check.ok) {
        lastErr = new ProviderError(check.reason ?? `供应商 ${ref.provider} 不可用`);
        if (list.length > 1) this.markFail(kind, idx, list, lastErr);
        continue;
      }
      const pc = (this.config.config.providers as Record<string, any>)[ref.provider] ?? {};
      const model = req.model || meta.model || ref.model;
      const shaped = await this.prepareAttachments(this.shapeForModel(pc, model, { ...req, model }));
      this.activeRequests++;
      const started = Date.now();
      try {
        const resp = await this.invoke(ref.provider, pc, shaped, onDelta);
        this.recordUsage(ref.provider, meta.chatId ?? '-', resp.usage);
        this.streaks.delete(`${kind}|${ref.provider}|${ref.model}`);
        this.bus.emit(busEvents.providerChanged, { event: 'call_ok', provider: ref.provider, model, ms: Date.now() - started });
        return resp;
      } catch (e) {
        const err = e as Error;
        lastErr = err;
        this.errors.record('error', 'provider', `${ref.provider}: ${err.message}`, {
          chatId: meta.chatId, pluginId: meta.pluginId, stack: err.stack,
        });
        // 用户主动打断、或者已经往外吐过字了：换模型只会重复输出或违背中断，直接抛
        if (req.signal?.aborted || streamed) throw err;
        if (list.length > 1) this.markFail(kind, idx, list, err);
      } finally {
        this.activeRequests--;
      }
    }
    throw lastErr;
  }

  /** 按模型页上这条模型声明的配置整形本次请求（判定逻辑在 applyModelCfg，便于单测） */
  private shapeForModel(pc: Record<string, any>, model: string, req: LLMChatRequest): LLMChatRequest {
    const mcfg = (Array.isArray(pc.models) ? pc.models : []).find((m: any) => m?.id === model);
    return applyModelCfg(mcfg, req);
  }

  /** 视觉/听觉的最后一公里：模型声明了 audio 但 QQ 给的是对端不收的容器（silk/amr…）时，
   *  本机转成 16k 单声道 wav 再发。转不动就丢掉这条附件并记一条 media 报错——
   *  正文里仍有 [语音] 占位，模型不会以为消息是空的。 */
  private async prepareAttachments(req: LLMChatRequest): Promise<LLMChatRequest> {
    const list = req.attachments;
    if (!list?.length) return req;
    const out: MessageAttachment[] = [];
    let changed = false;
    for (const a of list) {
      const mime = a.mime ?? '';
      if (a.kind !== 'audio' || !mime || audioFormat(mime)) { out.push(a); continue; }
      changed = true;
      try {
        const buf = a.path ? readFileSync(a.path) : a.url ? await fetchBuffer(a.url) : null;
        if (!buf) throw new Error('既没有本地文件也没有可下载地址');
        out.push({ kind: 'audio', path: await toWavFile(buf, mime), name: a.name, mime: 'audio/wav' });
      } catch (e) {
        this.errors.record('warn', 'media',
          `语音没送进模型（${mime}${a.name ? ` · ${a.name}` : ''}）：${(e as Error).message}`);
      }
    }
    return changed ? { ...req, attachments: out.length ? out : undefined } : req;
  }

  /** 按配置里的连接方式选线格式实现；mock / 占位供应商走各自的 chat() */
  private async invoke(
    pid: string, pc: Record<string, any>, req: LLMChatRequest,
    onDelta?: (d: { text?: string; toolCall?: Partial<ToolCall> & { index: number } }) => void,
  ): Promise<LLMResponse> {
    const proto = String(pc.protocol ?? 'openai-compatible');
    const Impl = WIRE_IMPL[proto];
    if (Impl) {
      const baseUrl = String(pc.baseUrl ?? '') || String((this.providers.get(pid) as any)?.defaultBase ?? '');
      if (!baseUrl) throw new ProviderError(`供应商 ${pid} 缺少 Base URL 配置`);
      return new Impl(pid).chatVia(baseUrl, this.config.getProviderKey(pid), req, onDelta);
    }
    const p = this.providers.get(pid);
    if (!p) throw new ProviderError(`未知的模型供应商 ${pid}`);
    return p.chat(req);
  }

  /** 模型页「测试连接」：真发一发 1 token 的补全，只回成/败与对端错误文本，不计用量、不进报错中心 */
  async ping(pid: string, model: string): Promise<{ ok: boolean; error?: string }> {
    const pc = (this.config.config.providers as Record<string, any>)[pid];
    if (!pc) return { ok: false, error: '未知供应商' };
    try {
      await this.invoke(pid, pc, {
        model, maxTokens: 1, messages: [{ role: 'user', content: 'ping' }],
        signal: AbortSignal.timeout(20000),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 240) };
    }
  }

  private recordUsage(provider: string, chatId: string, usage?: LLMUsage): void {
    if (!usage) return;
    const day = todayKey();
    // 内存账：work 侧栏要展示"这次任务 + 本会话累计"的缓存命中，落库的表结构保持不变
    const acc = this.usageByChat.get(chatId) ?? { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, calls: 0 };
    acc.prompt += usage.promptTokens;
    acc.completion += usage.completionTokens;
    acc.cacheHit += usage.cacheHitTokens ?? 0;
    acc.cacheMiss += usage.cacheMissTokens ?? 0;
    acc.calls += 1;
    this.usageByChat.set(chatId, acc);
    const row = this.db.get<{ prompt_tokens: number; completion_tokens: number; llm_calls: number }>(
      'SELECT prompt_tokens, completion_tokens, llm_calls FROM usage_stats WHERE day=? AND provider=? AND chat_id=?',
      day, provider, chatId,
    );
    if (row) {
      this.db.run(
        'UPDATE usage_stats SET prompt_tokens=?, completion_tokens=?, llm_calls=? WHERE day=? AND provider=? AND chat_id=?',
        row.prompt_tokens + usage.promptTokens, row.completion_tokens + usage.completionTokens, row.llm_calls + 1,
        day, provider, chatId,
      );
    } else {
      this.db.run(
        'INSERT INTO usage_stats (day, provider, chat_id, prompt_tokens, completion_tokens, llm_calls) VALUES (?,?,?,?,?,1)',
        day, provider, chatId, usage.promptTokens, usage.completionTokens,
      );
    }
  }

  todayUsage(): { promptTokens: number; completionTokens: number; llmCalls: number } {
    const rows = this.db.all<{ prompt_tokens: number; completion_tokens: number; llm_calls: number }>(
      'SELECT prompt_tokens, completion_tokens, llm_calls FROM usage_stats WHERE day=?', todayKey(),
    );
    return {
      promptTokens: rows.reduce((s, r) => s + r.prompt_tokens, 0),
      completionTokens: rows.reduce((s, r) => s + r.completion_tokens, 0),
      llmCalls: rows.reduce((s, r) => s + r.llm_calls, 0),
    };
  }

  /** 某会话累计的 token 账（内存态，含缓存命中）；两次数值相减 = 这段时间的消耗。
   *  必须返回**副本**：累加器是就地自增的，直接把对象交出去的话，
   *  调用方拿到的 before 会和 after 指向同一份数据，差值恒为 0。 */
  usageSnapshot(chatId: string): UsageSnapshot {
    const s = this.usageByChat.get(chatId);
    return s ? { ...s } : { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, calls: 0 };
  }
}

export interface UsageSnapshot { prompt: number; completion: number; cacheHit: number; cacheMiss: number; calls: number }

/** 两个快照之差（work 任务用它算"本次任务"的消耗与缓存命中率） */
export function usageDelta(before: UsageSnapshot, after: UsageSnapshot): UsageSnapshot {
  return {
    prompt: Math.max(0, after.prompt - before.prompt),
    completion: Math.max(0, after.completion - before.completion),
    cacheHit: Math.max(0, after.cacheHit - before.cacheHit),
    cacheMiss: Math.max(0, after.cacheMiss - before.cacheMiss),
    calls: Math.max(0, after.calls - before.calls),
  };
}

export class ProviderError extends Error {}

/** 内核实现了请求逻辑的连接方式（三种 HTTP 线格式 + 本地 mock）；其余一律拒绝，不静默降级 */
const IMPL_PROTOCOLS = ['openai-compatible', 'openai-responses', 'anthropic', 'mock'];

function pcNeedsKey(pid: string, pc?: Record<string, any>): boolean {
  if (pc?.protocol === 'mock') return false;
  if (pc?.custom) return true;
  return pid === 'deepseek' || pid === 'openai-compatible';
}

// =====================================================================
// OpenAI-compatible 实现（流式 + 工具调用）
// =====================================================================

export class OpenAiCompatProvider implements LLMProvider {
  id: string;
  label: string;
  implemented = true;
  streaming = true;

  constructor(id: string, readonly defaultBase = '') {
    this.id = id;
    this.label = id === 'deepseek' ? 'DeepSeek' : 'OpenAI 兼容（自定义）';
  }

  async chat(_req: LLMChatRequest): Promise<LLMResponse> {
    // 内部实现走 chatVia；由 LlmService 注入 baseUrl/apiKey/流式回调
    throw new Error('internal: use chatVia');
  }

  /** 实际实现挂在这里，LlmService 调用时注入 baseUrl/key */
  async chatVia(
    baseUrl: string, apiKey: string, req: LLMChatRequest,
    onDelta?: (d: { text?: string; toolCall?: Partial<ToolCall> & { index: number } }) => void,
  ): Promise<LLMResponse> {
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const wire = req.messages.map(toWire);
    // 该模型声明了图片/音频输入才走到这里（过滤在 LlmService.shapeForModel）
    attachToLastUser(wire, await loadAttachments(req.attachments), (t) => ({ type: 'text', text: t }), chatMediaParts);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: wire,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }
    // 注：Chat Completions 没有标准的内置联网搜索开关，声明了也只是不再发 Tavily 工具
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

    const resp = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: req.signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }

    // 解析 SSE
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let finishReason = '';
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        let obj: any;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj.usage) {
          usage = {
            promptTokens: obj.usage.prompt_tokens ?? 0,
            completionTokens: obj.usage.completion_tokens ?? 0,
            ...readCacheTokens(obj.usage),
          };
        }
        const choice = obj.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (delta.content) {
          content += delta.content;
          onDelta?.({ text: delta.content });
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolAcc.set(idx, acc);
          onDelta?.({ toolCall: { index: idx, id: tc.id, function: { name: tc.function?.name, arguments: tc.function?.arguments } } as any });
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolAcc.values()]
      .filter((t) => t.name)
      .map((t, i) => ({ id: t.id || `call_${i}`, type: 'function' as const, function: { name: t.name, arguments: t.args || '{}' } }));
    return { content, toolCalls, usage, finishReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop') };
  }
}

/** 从协议端 usage 里取缓存命中/未命中：DeepSeek 给 prompt_cache_hit|miss_tokens，
 *  OpenAI 兼容端把命中放在 prompt_tokens_details.cached_tokens；
 *  两边都没报就整个不给（前端据此区分"没命中"和"这个供应商不报缓存"）。 */
function readCacheTokens(u: any): { cacheHitTokens: number; cacheMissTokens: number } | Record<string, never> {
  const hitRaw = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
  const missRaw = u.prompt_cache_miss_tokens;
  if (hitRaw === undefined && missRaw === undefined) return {};
  const hit = Number(hitRaw ?? 0) || 0;
  const miss = missRaw === undefined ? Math.max(0, (Number(u.prompt_tokens) || 0) - hit) : Number(missRaw) || 0;
  return { cacheHitTokens: hit, cacheMissTokens: miss };
}

function toWire(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
}

// ---------------- 按模型配置整形请求（附件 / 原生搜索 / 调用参数） ----------------

/** 单个附件读进内存的上限：base64 后约 11MB，再大就别发给对端了（QQ 图片语音远小于此） */
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;

interface Loaded { kind: 'image' | 'audio' | 'video'; url?: string; base64?: string; mime: string }

const MIME_BY_KIND: Record<Loaded['kind'], string> = { image: 'image/jpeg', audio: 'audio/wav', video: 'video/mp4' };

/** OpenAI 系 input_audio 认的容器格式，其余（QQ 的 slk/amr 等）不硬塞，免得对端直接 400 */
function audioFormat(mime: string): string | undefined {
  const sub = (mime.split('/')[1] ?? '').toLowerCase().replace(/^x-/, '');
  if (sub === 'mpeg' || sub === 'mp3') return 'mp3';
  if (sub === 'wav' || sub === 'wave') return 'wav';
  if (sub === 'ogg' || sub === 'opus') return 'ogg';
  if (sub === 'flac') return 'flac';
  if (sub === 'pcm' || sub === 'pcm16') return 'pcm16';
  return undefined;
}

/** 有 url 就交给对端自己取，只有本机路径的读出来转 base64；读不动就丢掉（正文里仍有 [图片]/[语音] 占位） */
async function loadAttachments(list: MessageAttachment[] | undefined): Promise<Loaded[]> {
  const out: Loaded[] = [];
  for (const a of list ?? []) {
    const mime = a.mime || MIME_BY_KIND[a.kind];
    if (a.url) { out.push({ kind: a.kind, url: a.url, mime }); continue; }
    if (!a.path) continue;
    try {
      const buf = readFileSync(a.path);
      if (!buf.length || buf.length > ATTACH_MAX_BYTES) continue;
      out.push({ kind: a.kind, base64: buf.toString('base64'), mime });
    } catch { /* 文件不在了/没权限：跳过这条 */ }
  }
  return out;
}

const dataUrl = (a: Loaded) => `data:${a.mime};base64,${a.base64}`;

/** Chat Completions：image_url 认 url 也认 data URL，音频是 input_audio { data, format }，
 *  视频走各家扩展的 video_url（Qwen-VL / Kimi / GLM 同一形状）。 */
function chatMediaParts(a: Loaded): Record<string, unknown>[] {
  if (a.kind === 'image') return [{ type: 'image_url', image_url: { url: a.url ?? dataUrl(a) } }];
  if (a.kind === 'video') return [{ type: 'video_url', video_url: { url: a.url ?? dataUrl(a) } }];
  const fmt = audioFormat(a.mime);
  if (a.kind === 'audio' && fmt && a.base64) return [{ type: 'input_audio', input_audio: { data: a.base64, format: fmt } }];
  return [];
}

/** Anthropic Messages：图片是 image + source；该格式没有音频/视频输入块 */
function anthropicMediaParts(a: Loaded): Record<string, unknown>[] {
  if (a.kind !== 'image') return [];
  return [{ type: 'image', source: a.url ? { type: 'url', url: a.url } : { type: 'base64', media_type: a.mime, data: a.base64 } }];
}

/** Responses：input_image 的 image_url 是字符串，音频同 input_audio 嵌套形状；视频该格式没有块 */
function responsesMediaParts(a: Loaded): Record<string, unknown>[] {
  if (a.kind === 'image') return [{ type: 'input_image', image_url: a.url ?? dataUrl(a) }];
  const fmt = audioFormat(a.mime);
  if (a.kind === 'audio' && fmt && a.base64) return [{ type: 'input_audio', input_audio: { data: a.base64, format: fmt } }];
  return [];
}

/** 把媒体块拼到最后一条 user 消息上：文本块形状各家不同，由 textPart 给；一条 user 都没有就不挂 */
function attachToLastUser(
  list: Record<string, unknown>[], atts: Loaded[],
  textPart: (t: string) => Record<string, unknown>, mediaParts: (a: Loaded) => Record<string, unknown>[],
): void {
  if (!atts.length) return;
  const i = list.map((m) => m.role).lastIndexOf('user');
  if (i < 0) return;
  const parts = atts.flatMap(mediaParts);
  if (!parts.length) return;
  const text = typeof list[i].content === 'string' ? list[i].content : '';
  list[i].content = [text ? textPart(text) : undefined, ...parts].filter(Boolean) as Record<string, unknown>[];
}

/** 模型声明自带联网搜索时，各家发出自己的内置搜索工具块 */
function nativeSearchTools(protocol: 'responses' | 'anthropic'): Record<string, unknown>[] {
  return protocol === 'responses' ? [{ type: 'web_search' }] : [{ type: 'web_search_20250305', name: 'web_search' }];
}

/** 按模型页声明的配置整形请求（纯函数，便于单测）：inputTypes 决定附件转不转发、
 *  webSearch 决定还给不给 Tavily 工具、maxOutput 作为请求体的输出上限。 */
export function applyModelCfg(mcfg: Record<string, any> | undefined, req: LLMChatRequest): LLMChatRequest {
  if (!mcfg) return req;                         // 没在模型页登记过：一律按原样发
  const out = { ...req };

  const allow = new Set((Array.isArray(mcfg.inputTypes) ? mcfg.inputTypes : []).map(String));
  if (out.attachments?.length) {
    const kept = out.attachments.filter((a) => allow.has(a.kind));
    if (kept.length) out.attachments = kept; else delete out.attachments;
  }

  if (Array.isArray(mcfg.capabilities) && mcfg.capabilities.map(String).includes('webSearch')) {
    out.nativeSearch = true;
    // 它自己会联网搜索，就别再花 Tavily 额度：摘掉 web_search，读网页正文的 web_fetch 保留
    if (out.tools?.some((t) => t.function.name === 'web_search')) {
      const rest = out.tools.filter((t) => t.function.name !== 'web_search');
      if (rest.length) out.tools = rest; else delete out.tools;
    }
  }

  const cap = Number(mcfg.maxOutput);
  if (!out.maxTokens && Number.isFinite(cap) && cap > 0) out.maxTokens = Math.round(cap);
  return out;
}

// =====================================================================
// 另外两种连接方式：OpenAI Responses（/responses）与 Anthropic Messages（/v1/messages）
// 三种线格式共用 chatVia 形状（内核注入 baseUrl / apiKey / 流式回调），
// 历史里的工具调用与结果各自映射成该格式要求的块，缓存命中统一折算进 LLMUsage。
// =====================================================================

/** SSE 逐行读取：回调 (事件名, data 对象)。没有 `event:` 行时事件名为空串，由调用方回退到 data 里的 type 字段。 */
async function readSse(resp: Response, onEvent: (ev: string, obj: any) => void): Promise<void> {
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ev = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { ev = ''; continue; }                  // 空行 = 一个事件结束，事件名复位
      if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj: any;
      try { obj = JSON.parse(payload); } catch { continue; }
      onEvent(ev, obj);
    }
  }
}

/** baseUrl 可能已经带 /v1（本项目惯例），别拼成 /v1/v1/messages */
function anthropicUrl(base: string): string {
  const b = base.replace(/\/+$/, '');
  return `${b}${/\/v1$/.test(b) ? '' : '/v1'}/messages`;
}

/** OpenAI 风格历史 → Anthropic：system 抽顶层，tool 结果并进一条 user 消息的 tool_result 块 */
function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: Record<string, unknown>[] } {
  let system = '';
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === 'system') { system += (system ? '\n\n' : '') + m.content; continue; }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content };
      const prev = out[out.length - 1] as { role?: string; content?: any[] } | undefined;
      if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content[0]?.type === 'tool_result') prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: Record<string, unknown>[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* 参数坏掉时给空对象，让模型重试 */ }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (m.content) out.push({ role: 'user', content: m.content });
  }
  return { system, messages: out };
}

function anthropicUsage(u: any): LLMUsage | undefined {
  if (!u) return undefined;
  const input = Number(u.input_tokens ?? 0) || 0;
  const hit = Number(u.cache_read_input_tokens ?? 0) || 0;
  const write = Number(u.cache_creation_input_tokens ?? 0) || 0;
  // Anthropic 的 input_tokens 不含缓存部分，这里加回成"本轮上下文总量"，与 OpenAI 口径对齐
  return { promptTokens: input + hit + write, completionTokens: Number(u.output_tokens ?? 0) || 0, cacheHitTokens: hit, cacheMissTokens: input + write };
}

export class AnthropicProvider implements LLMProvider {
  id: string;
  label = 'Anthropic Messages';
  implemented = true;
  streaming = true;

  constructor(id: string) { this.id = id; }

  async chat(_req: LLMChatRequest): Promise<LLMResponse> {
    throw new Error('internal: use chatVia');
  }

  async chatVia(
    baseUrl: string, apiKey: string, req: LLMChatRequest,
    onDelta?: (d: { text?: string; toolCall?: Partial<ToolCall> & { index: number } }) => void,
  ): Promise<LLMResponse> {
    const { system, messages } = toAnthropicMessages(req.messages);
    attachToLastUser(messages, await loadAttachments(req.attachments),
      (t) => ({ type: 'text', text: t }), anthropicMediaParts);
    const body: Record<string, unknown> = {
      model: req.model, max_tokens: req.maxTokens ?? 4096, messages, stream: true,
    };
    if (system) body.system = system;
    const fnTools = (req.tools ?? []).map((t) => ({
      name: t.function.name, description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
    // 服务端内置搜索工具排在前面；该格式没有音频输入，音频附件在 shapeForModel 之后仍会被 parts 构造跳过
    const search = req.nativeSearch ? nativeSearchTools('anthropic') : [];
    if (search.length || fnTools.length) body.tools = [...search, ...fnTools];
    const resp = await fetch(anthropicUrl(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'anthropic-version': '2023-06-01',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify(body), signal: req.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
    }

    let content = '';
    let stopReason = '';
    let streamErr = '';
    let usage: any;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    await readSse(resp, (_ev, obj) => {
      const type = obj?.type;
      if (type === 'error') streamErr = obj?.error?.message ?? 'anthropic 流中断';
      if (type === 'message_start') usage = obj.message?.usage ?? usage;
      if (type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
        toolAcc.set(obj.index ?? 0, { id: obj.content_block.id ?? '', name: obj.content_block.name ?? '', args: '' });
      }
      if (type === 'content_block_delta') {
        const d = obj.delta ?? {};
        if (d.type === 'text_delta' && d.text) { content += d.text; onDelta?.({ text: d.text }); }
        if (d.type === 'input_json_delta') {
          const acc = toolAcc.get(obj.index ?? 0);
          if (acc) { acc.args += d.partial_json ?? ''; onDelta?.({ toolCall: { index: obj.index ?? 0, function: { arguments: d.partial_json } } as any }); }
        }
      }
      if (type === 'message_delta') { stopReason = obj.delta?.stop_reason ?? stopReason; usage = { ...(usage ?? {}), ...(obj.usage ?? {}) }; }
    });
    if (streamErr) throw new Error(streamErr);

    const toolCalls: ToolCall[] = [...toolAcc.values()]
      .filter((t) => t.name)
      .map((t, i) => ({ id: t.id || `call_${i}`, type: 'function' as const, function: { name: t.name, arguments: t.args || '{}' } }));
    return { content, toolCalls, usage: anthropicUsage(usage), finishReason: toolCalls.length ? 'tool_calls' : stopReason || 'stop' };
  }
}

/** OpenAI 风格历史 → Responses：system 进 instructions，其余摊成 input 条目序列 */
function toResponsesInput(messages: ChatMessage[]): { instructions: string; input: Record<string, unknown>[] } {
  let instructions = '';
  const input: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === 'system') { instructions += (instructions ? '\n\n' : '') + m.content; continue; }
    if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: m.content }); continue; }
    if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
      continue;
    }
    input.push({ role: 'user', content: m.content });
  }
  return { instructions, input };
}

function responsesUsage(u: any): LLMUsage | undefined {
  if (!u) return undefined;
  const prompt = Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
  const hit = Number(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  return { promptTokens: prompt, completionTokens: Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0, cacheHitTokens: hit, cacheMissTokens: Math.max(0, prompt - hit) };
}

export class OpenAiResponsesProvider implements LLMProvider {
  id: string;
  label = 'OpenAI Responses';
  implemented = true;
  streaming = true;

  constructor(id: string) { this.id = id; }

  async chat(_req: LLMChatRequest): Promise<LLMResponse> {
    throw new Error('internal: use chatVia');
  }

  async chatVia(
    baseUrl: string, apiKey: string, req: LLMChatRequest,
    onDelta?: (d: { text?: string; toolCall?: Partial<ToolCall> & { index: number } }) => void,
  ): Promise<LLMResponse> {
    const { instructions, input } = toResponsesInput(req.messages);
    attachToLastUser(input, await loadAttachments(req.attachments),
      (t) => ({ type: 'input_text', text: t }), responsesMediaParts);
    const body: Record<string, unknown> = { model: req.model, input, stream: true };
    if (instructions) body.instructions = instructions;
    const fnTools = (req.tools ?? []).map((t) => ({
      type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters,
    }));
    const search = req.nativeSearch ? nativeSearchTools('responses') : [];
    if (search.length || fnTools.length) body.tools = [...search, ...fnTools];
    if (req.maxTokens) body.max_output_tokens = req.maxTokens;
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body), signal: req.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
    }

    let content = '';
    let streamErr = '';
    let usage: any;
    /** Responses 的工具调用按 item 分散到达，键用 item_id（回退 output_index），call_id 才是回填时要带的那个 */
    const toolAcc = new Map<string, { callId: string; name: string; args: string; idx: number }>();
    let nextIdx = 0;
    await readSse(resp, (ev, obj) => {
      const type = ev || obj?.type;
      if (type === 'error') streamErr = obj?.error?.message ?? obj?.message ?? 'responses 流中断';
      if (type === 'response.output_text.delta' && obj.delta) {
        content += obj.delta;
        onDelta?.({ text: obj.delta });
      }
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        const it = obj.item;
        if (it?.type === 'function_call') {
          const key = String(obj.item_id ?? it.id ?? obj.output_index ?? it.call_id ?? '');
          const acc = toolAcc.get(key) ?? { callId: '', name: '', args: '', idx: nextIdx++ };
          acc.callId = it.call_id ?? it.id ?? acc.callId;
          if (it.name) acc.name = it.name;
          if (typeof it.arguments === 'string' && it.arguments) acc.args = it.arguments;
          toolAcc.set(key, acc);
        }
      }
      if (type === 'response.function_call_arguments.delta') {
        const key = String(obj.item_id ?? obj.output_index ?? '');
        const acc = toolAcc.get(key);
        if (acc && obj.delta) {
          acc.args += obj.delta;
          onDelta?.({ toolCall: { index: acc.idx, function: { arguments: obj.delta } } as any });
        }
      }
      if (type === 'response.completed' || type === 'response.incomplete' || type === 'response') {
        const r = obj.response ?? obj;
        usage = r?.usage ?? usage;
        if (r?.status === 'failed') streamErr = r?.error?.message ?? 'response failed';
      }
    });
    if (streamErr) throw new Error(streamErr);

    const toolCalls: ToolCall[] = [...toolAcc.values()]
      .filter((t) => t.name)
      .map((t, i) => ({ id: t.callId || `call_${i}`, type: 'function' as const, function: { name: t.name, arguments: t.args || '{}' } }));
    return { content, toolCalls, usage: responsesUsage(usage), finishReason: toolCalls.length ? 'tool_calls' : 'stop' };
  }
}

/** 连接方式 → 线格式实现。发请求时按配置里的 protocol 选，注册在实例表里的只是元数据（label/是否接入）。 */
const WIRE_IMPL: Record<string, new (id: string) => LLMProvider> = {
  'openai-compatible': OpenAiCompatProvider,
  'openai-responses': OpenAiResponsesProvider,
  'anthropic': AnthropicProvider,
};

// =====================================================================
// gemini-3.8-flash 占位（红线 §2.2：只留接口，不真的接入）
// =====================================================================

export class GeminiPlaceholderProvider implements LLMProvider {
  id = 'gemini-3.8-flash';
  label = 'Gemini 3.8 Flash';
  implemented = false;   // ← 占位：任何调用都会得到"未接入"错误
  streaming = false;

  // TODO: 接入 Gemini API 时实现 chat()：
  //  1. config.providers['gemini-3.8-flash'].baseUrl / apiKey 填写真实值
  //  2. 将 OpenAI 格式消息映射为 Google generativelanguage contents/parts
  //  3. 实现 streamGenerateContent 的 SSE 解析
  async chat(_req: LLMChatRequest): Promise<LLMResponse> {
    throw new ProviderError(
      'gemini-3.8-flash 尚未接入：内核只保留了 Provider 接口与配置占位（enabled=false，key/baseUrl 留空标 TODO）。' +
      '请在桌面端“模型”页切换到其他已接入供应商（如 DeepSeek），或自行实现 src/kernel/services/llm.ts 中的 GeminiPlaceholderProvider.chat()。',
    );
  }
}

// =====================================================================
// Mock 供应商：测试与无 key 演示用，支持脚本化响应
// =====================================================================

export interface MockScriptStep {
  content?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

export class MockProvider implements LLMProvider {
  id = 'mock';
  label = 'Mock（测试用）';
  implemented = true;
  streaming = true;
  /** 由测试/桌面端注入的脚本队列；为空时回退到默认回声 */
  script: MockScriptStep[] = [];
  calls: { messages: ChatMessage[]; tools?: string[] }[] = [];

  async chat(req: LLMChatRequest): Promise<LLMResponse> {
    this.calls.push({ messages: req.messages, tools: req.tools?.map((t) => t.function.name) });
    const step = this.script.shift();
    if (step) {
      const toolCalls: ToolCall[] = (step.toolCalls ?? []).map((t, i) => ({
        id: `mock_${Date.now()}_${i}`, type: 'function' as const,
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      }));
      return {
        content: step.content ?? '',
        toolCalls,
        usage: { promptTokens: 100, completionTokens: 20 + (step.content?.length ?? 0), cacheHitTokens: 80, cacheMissTokens: 20 },
        finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      };
    }
    // 无脚本时的默认行为：幂运算类消息触发 run_python 工具（演示工具调用链路）。
    // 判定"最后一条 user 消息之后没有 tool 结果"，避免工具循环（尾部 system 强化消息不影响判定）。
    const roles = req.messages.map((m) => m.role);
    const idxTool = roles.lastIndexOf('tool');
    const idxUser = roles.lastIndexOf('user');
    const lastUser = idxUser > idxTool ? req.messages[idxUser].content : '';
    const pow = lastUser.match(/(\d+)\s*(?:\^|\*\*|的)\s*(\d+)\s*(?:次方|幂)?/);
    // chat 档的工具叫 run_python，work 档（容器常驻会话）叫 python_session——同一个演示意图，两边都能触发
    const pyTool = req.tools?.some((t) => t.function.name === 'run_python') ? 'run_python'
      : req.tools?.some((t) => t.function.name === 'python_session') ? 'python_session' : '';
    if (lastUser && /算|计算|幂|次方|\^|\*\*/.test(lastUser) && pow && pyTool) {
      return {
        content: '',
        toolCalls: [{
          id: `mock_tool_${Date.now()}`, type: 'function' as const,
          function: { name: pyTool, arguments: JSON.stringify({ code: `print(${pow[1]} ** ${pow[2]})` }) },
        }],
        usage: { promptTokens: 120, completionTokens: 30, cacheHitTokens: 96, cacheMissTokens: 24 },
        finishReason: 'tool_calls',
      };
    }
    return {
      content: `（mock）收到 ${req.messages.filter((m) => m.role === 'user').length} 条消息`,
      toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 20, cacheHitTokens: 80, cacheMissTokens: 20 },
      finishReason: 'stop',
    };
  }
}
