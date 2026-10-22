import type {
  LLMProvider, LLMChatRequest, LLMResponse, ToolCall, ChatMessage, LLMUsage,
} from '../types.ts';
import { REASONING_LEVELS, type ConfigStore, type ModelRef } from '../config.ts';
import type { ErrorCenter } from '../errors.ts';
import type { Db } from '../db.ts';
import { todayKey } from '../util/misc.ts';
import { mockEngine, mockStreams } from './mock-engine.ts';
import {
  chatViaPiAi, isPiProtocol, piAiModule, piApiImpl, piApiName, piModelFor, injectMedia, mapUsage, prepareMedia,
  providerBaseUrl,
} from './pi-ai.ts';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { busEvents } from '../bus.ts';
import type { Bus } from '../bus.ts';

/** 两条模型优先级链的名字：会话用 chat，work 子代理用 work */
export type ModelChainKind = 'chat' | 'work';
/** 链上一条 + 运行时健康态（桌面端左栏画降级状态用） */
export interface ChainEntry extends ModelRef {
  fails: number;
  state: 'current' | 'idle' | 'down';
  /** 硬不可用后的冷却截止时间（毫秒时间戳）；没有冷却就没有这个字段 */
  downUntil?: number;
}

/**
 * LLM 供应商抽象（红线 §2.2）：
 * - 完整支持 OpenAI-compatible chat completions（流式 + 工具调用）
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
    // 引擎统一到 pi-ai：实例表只承载"元数据 + 默认 Base URL"，发请求一律走 pi-ai（见 invoke）
    this.registerProvider(new PiEngineProvider('openai-compatible'));
    this.registerProvider(new PiEngineProvider('deepseek', 'https://api.deepseek.com'));
    this.registerProvider(mockEngine);
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
      this.registerProvider(new PiEngineProvider(id));
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

  /** 配置里的有序模型链。两条链各自独立（work 不再跟随 chat：没配就是没配）；
   *  chat 链为空时按 activeProvider 兜底一条（老配置没走过模型页也能跑）。 */
  chainConfig(kind: ModelChainKind): ModelRef[] {
    const llm = this.config.config.llm;
    const list = (kind === 'work' ? llm.workChain : llm.chatChain) ?? [];
    const clean = list.filter((r) => r && r.provider) as ModelRef[];
    if (clean.length) return clean;
    if (kind === 'work') return [];
    const pid = llm.activeProvider;
    return pid ? [{ provider: pid, model: this.modelFor(pid) }] : [];
  }

  /** 某条链选定的思考强度（'' = 默认，由模型/供应商决定）。非法值按默认处理。 */
  reasoningFor(kind: ModelChainKind): string {
    const llm = this.config.config.llm as { chatReasoning?: string; workReasoning?: string };
    const v = String((kind === 'work' ? llm.workReasoning : llm.chatReasoning) ?? '');
    return (REASONING_LEVELS as readonly string[]).includes(v) ? v : '';
  }

  /** 链上当前位置：连续掉线达到阈值后由 markFail 往后挪 */
  private cursor: Record<ModelChainKind, number> = { chat: 0, work: 0 };
  private streaks = new Map<string, number>();
  /**
   * 硬不可用后的冷却表。真不可用（连不上 / 鉴权失败 / 模型不存在）不等阈值、也不在
   * 下一次调用里再白试一遍——否则每次派活都要先付一轮网络超时。
   * 按供应商记一份（transport 故障整家都不可达）和按条目记一份（只是这个模型没了）。
   */
  private downProviders = new Map<string, number>();
  private downEntries = new Map<string, number>();
  /** 冷却时长：够让一次短暂抖动恢复，又不至于把已修好的供应商晾太久 */
  private static readonly DOWN_COOLDOWN_MS = 60_000;

  private threshold(): number {
    const n = Number(this.config.config.llm.failoverThreshold);
    return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 1;
  }

  private ptr(kind: ModelChainKind, len: number): number {
    if (len <= 0) return 0;
    return Math.min(Math.max(this.cursor[kind] | 0, 0), len - 1);
  }

  /** 这一条现在是否在冷却期 */
  private cooling(ref: ModelRef): boolean {
    const now = Date.now();
    return (this.downProviders.get(ref.provider) ?? 0) > now
      || (this.downEntries.get(`${ref.provider}|${ref.model}`) ?? 0) > now;
  }

  /** 本次调用的尝试顺序：从链上当前位置起绕一圈，冷却中的排到最后。
   *  全都在冷却时不做过滤——宁可再试一次，也别让整条链直接没模型可用。 */
  private order(kind: ModelChainKind, list: ModelRef[]): number[] {
    return this.orderAt(list, this.ptr(kind, list.length));
  }

  /** 从指定下标起绕一圈（work 并发时每个任务钉自己的起始模型，仍保留整条替代链） */
  private orderAt(list: ModelRef[], at: number): number[] {
    const len = list.length;
    if (!len) return [];
    const start = ((Math.round(at) % len) + len) % len;
    const ring: number[] = [];
    for (let i = 0; i < len; i++) ring.push((start + i) % len);
    const warm = ring.filter((i) => !this.cooling(list[i]));
    return warm.length ? warm : ring;
  }

  /** 某条链第 slot 个模型的展示名（work 并发分配 / 运行记录用） */
  modelAt(kind: ModelChainKind, slot: number): string {
    const list = this.chainConfig(kind);
    if (!list.length) return '—';
    const at = ((Math.round(slot) % list.length) + list.length) % list.length;
    const r = list[at];
    return r ? `${r.provider}:${r.model}` : '—';
  }

  /** 当前真正在服务的那条（降级后会变） */
  servingRef(kind: ModelChainKind): ModelRef | null {
    const list = this.chainConfig(kind);
    const idx = this.ptr(kind, list.length);
    return list[idx] ?? null;
  }

  servingLabel(kind: ModelChainKind): string {
    const r = this.servingRef(kind);
    return r ? `${r.provider}:${r.model}` : '—';
  }

  /**
   * 当前生效模型的上下文窗口（token）。模型行没配 contextWindow 就返回 undefined ——
   * 调用方（work 轮压缩、桌面端占比圆环）必须据此「宁可不做，也不猜一个假数」。
   */
  contextWindow(kind: ModelChainKind): number | undefined {
    const r = this.servingRef(kind);
    if (!r) return undefined;
    const models = ((this.config.config.providers as Record<string, any>)[r.provider]?.models ?? []) as { id: string; contextWindow?: number }[];
    const hit = models.find((m) => m.id === r.model)?.contextWindow;
    return hit && hit > 0 ? hit : undefined;
  }

  /** 桌面端展示：只回配置里真写过的条目（没配就是空）。发请求时 chat 链才由 chainConfig 兜底到 activeProvider。 */
  chainsView(): Record<ModelChainKind, ChainEntry[]> {
    const one = (kind: ModelChainKind): ChainEntry[] => {
      const llm = this.config.config.llm;
      const configured = (kind === 'work' ? llm.workChain : llm.chatChain) ?? [];
      const at = this.ptr(kind, this.chainConfig(kind).length);
      const th = this.threshold();
      return configured.map((r, i) => {
        const fails = this.streaks.get(`${kind}|${r.provider}|${r.model}`) ?? 0;
        const until = Math.max(
          this.downProviders.get(r.provider) ?? 0,
          this.downEntries.get(`${r.provider}|${r.model}`) ?? 0,
        );
        const state = i === at ? 'current' as const : this.cooling(r) || fails >= th ? 'down' as const : 'idle' as const;
        return { ...r, fails, state, ...(until > Date.now() ? { downUntil: until } : {}) };
      });
    };
    return { chat: one('chat'), work: one('work') };
  }

  /** 改链 / 改阈值后调用：位置与失败计数从头开始 */
  resetFailover(): void {
    this.streaks.clear();
    this.downProviders.clear();
    this.downEntries.clear();
    this.cursor = { chat: 0, work: 0 };
  }

  /** 成功一次就恢复健康：失败计数与冷却都清掉（下一次它又能按顺序当主候选） */
  private clearHealth(kind: ModelChainKind, ref: ModelRef): void {
    this.streaks.delete(`${kind}|${ref.provider}|${ref.model}`);
    this.downEntries.delete(`${ref.provider}|${ref.model}`);
    this.downProviders.delete(ref.provider);
  }

  /** 指针可能停在同一家已冷却的第二条上（第一条 transport 失败后挪过去的）；
   *  真正服务的是这一条时把指针落回来，桌面端才显示"当前 = 实际在用的模型"。 */
  private adopt(kind: ModelChainKind, idx: number, list: ModelRef[]): void {
    if (this.cursor[kind] === idx) return;
    const at = this.ptr(kind, list.length);
    if (this.cooling(list[at])) this.cursor[kind] = idx;
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
    if (!IMPL_PROTOCOLS.includes(proto)) return { ok: false, reason: `供应商 ${pid} 的连接方式 ${proto} 没有可用引擎：支持 openai-compatible / openai-responses / anthropic / gemini / mock，请在模型页改回其中一种。` };
    if (pc.enabled === false) return { ok: false, reason: `供应商 ${pid} 未启用，请在桌面端“模型”页启用或切换。` };
    if (pcNeedsKey(pid, pc) && !this.config.getProviderKey(pid)) return { ok: false, reason: `供应商 ${pid} 缺少 API Key，请在桌面端“模型”页配置。` };
    if (proto !== 'mock' && !String(pc.baseUrl ?? '') && !(p as any).defaultBase) return { ok: false, reason: `供应商 ${pid} 缺少 Base URL 配置` };
    return { ok: true };
  }

  /** 失败记账。
   *
   *  hard（连不上 / 鉴权失败 / 模型不存在 / 配置级不可用）：立刻把链上位置挪到下一条并冷却。
   *  这类错误重试同一条毫无意义，等阈值只会让每次派活都先白等一轮超时。
   *
   *  soft（5xx / 429 / 过载）：仍按 failoverThreshold 计数再挪，避免一次网络抖动把整条链带偏。
   */
  private markFail(kind: ModelChainKind, idx: number, list: ModelRef[], err: Error, mode: 'hard' | 'config' | 'soft' = 'soft', moveCursor = true): void {
    const ref = list[idx];
    const key = `${kind}|${ref.provider}|${ref.model}`;
    const n = (this.streaks.get(key) ?? 0) + 1;
    this.streaks.set(key, n);

    if (mode === 'hard') {
      const until = Date.now() + LlmService.DOWN_COOLDOWN_MS;
      this.downEntries.set(`${ref.provider}|${ref.model}`, until);
      // 连不上/鉴权失败/地区不支持是整家供应商的问题，同一家的其它模型这轮也不必再试
      if (isProviderWideFailure(err)) this.downProviders.set(ref.provider, until);
    }

    if (!moveCursor || list.length < 2) return;
    if (mode === 'soft' && n < this.threshold()) return;
    const next = (idx + 1) % list.length;
    if (this.cursor[kind] === next) return;
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
   *  当前这条失败后会在同一次调用里顺延到下一条（用户不至于收到一条错误）；
   *  硬不可用会立刻挪动链上位置并冷却，软故障才按阈值挪。
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

    const order = meta.providerId ? [0] : this.order(kind, list);
    const fails: string[] = [];
    const skipProviders = new Set<string>();
    let streamed = false;
    const onDelta = meta.onDelta
      ? (d: { text?: string; toolCall?: Partial<ToolCall> & { index: number } }) => { if (d.text) streamed = true; meta.onDelta!(d); }
      : undefined;
    let lastErr: Error = new ProviderError('模型链全部不可用');

    for (const idx of order) {
      const ref = list[idx];
      if (skipProviders.has(ref.provider)) continue;
      const check = this.preflight(ref.provider);
      if (!check.ok) {
        lastErr = new ProviderError(check.reason ?? `供应商 ${ref.provider} 不可用`);
        fails.push(`${ref.provider}: ${lastErr.message}`);
        this.markFail(kind, idx, list, lastErr, 'config');
        continue;
      }
      const pc = (this.config.config.providers as Record<string, any>)[ref.provider] ?? {};
      const model = req.model || meta.model || ref.model;
      const shaped = { ...this.shapeForModel(pc, model, { ...req, model }), reasoning: this.reasoningFor(kind) || undefined };
      this.activeRequests++;
      const started = Date.now();
      try {
        const resp = await this.invoke(ref.provider, pc, shaped, onDelta);
        this.recordUsage(ref.provider, model, meta.chatId ?? '-', resp.usage);
        this.adopt(kind, idx, list);
        this.clearHealth(kind, ref);
        if (fails.length) {
          // 已经有人接上了就不该在报错中心留下一条"失败"——记成 warn 并写明切到了谁
          this.errors.record('warn', 'provider', `已自动切换模型：${fails.join('；')} → ${ref.provider}:${ref.model}`, {
            chatId: meta.chatId, pluginId: meta.pluginId,
          });
        }
        this.bus.emit(busEvents.providerChanged, { event: 'call_ok', provider: ref.provider, model, ms: Date.now() - started });
        return resp;
      } catch (e) {
        const err = e as Error;
        lastErr = err;
        // 用户主动打断：不是模型故障，不记报错、不降级
        if (req.signal?.aborted) throw err;
        fails.push(`${ref.provider}: ${err.message}`);
        // 已经往外吐过字了：换模型只会重复输出，记下这次失败后直接抛
        if (streamed) {
          this.errors.record('error', 'provider', `${ref.provider}: ${err.message}`, {
            chatId: meta.chatId, pluginId: meta.pluginId, stack: err.stack, notifyOwner: false,
          });
          throw err;
        }
        const hard = isHardUnavailable(err);
        if (list.length > 1) this.markFail(kind, idx, list, err, hard ? 'hard' : 'soft');
        // transport/鉴权/地区问题都是整家的事：同一家的后续条目这轮直接跳过，别再白等
        if (hard && isProviderWideFailure(err)) skipProviders.add(ref.provider);
      } finally {
        this.activeRequests--;
      }
    }
    this.recordChainError(meta, fails, lastErr);
    throw lastErr;
  }

  private recordChainError(
    meta: { chatId?: string; pluginId?: string },
    fails: string[],
    err: Error,
  ): void {
    const message = fails.length ? `模型链全部不可用：${fails.join('；')}` : err.message;
    this.errors.record('error', 'provider', message, {
      chatId: meta.chatId, pluginId: meta.pluginId, stack: err.stack,
      // 模型失败彻底沉默：只进报错中心与会话日志（这条也走 QQ 私聊通知，一并关掉）
      notifyOwner: false,
    });
  }

  /** 按模型页上这条模型声明的配置整形本次请求（判定逻辑在 applyModelCfg，便于单测） */
  private shapeForModel(pc: Record<string, any>, model: string, req: LLMChatRequest): LLMChatRequest {
    const mcfg = (Array.isArray(pc.models) ? pc.models : []).find((m: any) => m?.id === model);
    return applyModelCfg(mcfg, req);
  }


  /** 按配置里的连接方式选线格式实现；mock / 占位供应商走各自的 chat() */
  private async invoke(
    pid: string, pc: Record<string, any>, req: LLMChatRequest,
    onDelta?: (d: { text?: string; toolCall?: Partial<ToolCall> & { index: number } }) => void,
  ): Promise<LLMResponse> {
    const proto = String(pc.protocol ?? 'openai-compatible');
    if (!isPiProtocol(proto) && proto !== 'mock') throw new ProviderError(`供应商 ${pid} 的连接方式 ${proto} 没有可用引擎`);
    const baseUrl = String(pc.baseUrl ?? '') || String((this.providers.get(pid) as any)?.defaultBase ?? '');
    if (proto !== 'mock' && !baseUrl) throw new ProviderError(`供应商 ${pid} 缺少 Base URL 配置`);
    const mcfg = (Array.isArray(pc.models) ? pc.models : []).find((m: any) => m?.id === req.model);
    const engine = engineFor(proto);
    try {
      return await chatViaPiAi({
        providerId: pid,
        // mock 借用 Chat Completions 的协议名走流程，真正出手的是 engine 里那个进程内引擎
        protocol: isPiProtocol(proto) ? proto : 'openai-compatible',
        baseUrl,
        apiKey: this.config.getProviderKey(pid),
        model: {
          id: req.model,
          contextWindow: mcfg?.contextWindow,
          maxTokens: mcfg?.maxOutput ?? req.maxTokens,
          image: (mcfg?.inputTypes ?? []).includes('image'),
          reasoning: !!req.reasoning,
        },
        req,
        onDelta,
        engine,
        log: { warn: (m, extra) => this.errors.record('warn', 'provider', m, extra) },
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === 'PiNotInstalledError') throw new ProviderError(`${pid}: ${err.message}`);
      if (err.name === 'ProviderError') throw err;
      throw new ProviderError(`pi-ai 调用失败（${pid}/${req.model}）: ${err.message}`);
    }
  }

  /**
   * 走链的 pi-ai 流函数：交给 pi-agent-core 的 agent loop 用（`new Agent({ streamFn })`）。
   *
   * 为什么不让 agent loop 直连 pi-ai：**降级链是内核自己的价值面**（用户 09-21 明确要的
   * "一个模型挂了自动换下一个"）。直连就等于把这条能力丢了。所以这里把
   * 「按链顺序试 → 预检不过就顺延 → 已经吐过字就抛（换了只会重复输出）」这层套在 pi-ai 外面，
   * 语义与 LlmService.chat 里那条链完全一致，只是输出变成了 pi-ai 的事件流。
   *
   * 返回的是 pi-ai 的 AssistantMessageEventStream：立刻返回，尝试过程在背后异步跑，
   * 失败会以 error 事件终结（不会挂住调用方）。
   */
  chainStreamFn(kind: ModelChainKind, o: { attachments?: LLMChatRequest['attachments']; chatId?: string; start?: number } = {}): StreamFn {
    const self = this;
    const pinned = kind === 'work' && Number.isInteger(o.start);
    return async (_model, context, options) => {
      const pie = await piAiModule();
      if (!pie) throw new Error('未安装 @earendil-works/pi-ai');
      const out = pie.createAssistantMessageEventStream();
      void (async () => {
        const fail = (err: Error) => { out.push(errorEvent(err)); out.end(); };
        const list = self.chainConfig(kind);
        if (!list.length) { fail(new ProviderError('模型链是空的：请在桌面端「模型」页的「聊天模型」里加至少一条')); return; }
        const reasoning = self.reasoningFor(kind);
        // 并发的 work 任务钉在自己的起始模型上；单个任务仍从它起绕完整条链做替代
        const order = pinned ? self.orderAt(list, Number(o.start)) : self.order(kind, list);
        const fails: string[] = [];
        const skipProviders = new Set<string>();
        let lastErr: Error = new ProviderError('模型链全部不可用');
        for (const idx of order) {
          const ref = list[idx];
          if (skipProviders.has(ref.provider)) continue;
          const check = self.preflight(ref.provider);
          if (!check.ok) {
            lastErr = new ProviderError(check.reason ?? `供应商 ${ref.provider} 不可用`);
            fails.push(`${ref.provider}: ${lastErr.message}`);
            self.markFail(kind, idx, list, lastErr, 'config', !pinned);
            continue;
          }
          const pc = (self.config.config.providers as Record<string, any>)[ref.provider] ?? {};
          const proto = String(pc.protocol ?? 'openai-compatible');
          const piProto = isPiProtocol(proto) ? proto : 'openai-compatible';
          const isMock = proto === 'mock';
          const baseUrl = String(pc.baseUrl ?? '') || String((self.providers.get(ref.provider) as any)?.defaultBase ?? '');
          if (!isMock && !baseUrl) {
            lastErr = new ProviderError(`供应商 ${ref.provider} 缺少 Base URL 配置`);
            fails.push(`${ref.provider}: ${lastErr.message}`);
            self.markFail(kind, idx, list, lastErr, 'config', !pinned);
            continue;
          }
          const mcfg = (Array.isArray(pc.models) ? pc.models : []).find((m: any) => m?.id === ref.model);
          const engine = isMock ? { apiName: 'mock', api: mockStreams() } : undefined;
          const apiName = engine ? engine.apiName : piApiName(piProto);
          let streamed = false;
          self.activeRequests++;
          const started = Date.now();
          try {
            const piModel = await piModelFor({
              providerId: ref.provider, protocol: piProto, engineApi: engine?.apiName, baseUrl,
              model: {
                id: ref.model, contextWindow: mcfg?.contextWindow,
                maxTokens: mcfg?.maxOutput, image: (mcfg?.inputTypes ?? []).includes('image'),
                // 只有链上明确选了强度才把模型标成推理模型：默认档不加 reasoning 参数，
                // 让供应商按模型自身默认走（deepseek 的推理模型默认就会思考）
                reasoning: !!reasoning,
              },
            });
            const models = pie.createModels();
            const apiImpl = engine?.api ?? await piApiImpl(piProto);
            models.setProvider(pie.createProvider({
              id: ref.provider, name: ref.provider, baseUrl: providerBaseUrl(piProto, baseUrl),
              auth: { apiKey: { name: ref.provider, resolve: async () => ({ auth: {} }) } },
              models: [piModel], api: { [apiName]: apiImpl },
            }));
            // 这一条候选能收哪种媒体，看模型页勾的「输入类型」——与 applyModelCfg 同一条规则
            // （没在模型页登记过的行不筛）。链上换供应商时这张筛子跟着换。
            const allow = mcfg ? new Set((Array.isArray(mcfg.inputTypes) ? mcfg.inputTypes : []).map(String)) : undefined;
            const atts = allow ? o.attachments?.filter((a) => allow.has(a.kind)) : o.attachments;
            // 被这张筛子滤掉的那部分要说得出来：静默丢媒体正是"bot 装作没听见语音"这种 bug 藏久的原因
            const KIND_ZH = { image: '图片', audio: '音频', video: '视频' } as Record<string, string>;
            const dropped = [...new Set((o.attachments ?? []).filter((a) => !atts?.includes(a)).map((a) => KIND_ZH[a.kind] ?? a.kind))];
            if (dropped.length) {
              self.errors.record('warn', 'provider', `模型 ${ref.model} 的「输入类型」没勾选${dropped.join('、')}，本轮这些媒体没有送出`, { providerId: ref.provider });
            }
            const prepared = atts?.length
              ? await prepareMedia({ attachments: atts, api: apiName })
              : undefined;
            if (prepared?.skipped.length) {
              self.errors.record('warn', 'provider', `附件未能全部送达：${prepared.skipped.join('；')}`, { providerId: ref.provider });
            }
            // 图片**不在这里补**：播种区（agentloop 里 toPiMessages 的 attachmentsFor）已经把每张图
            // 挂回它当时那条消息上了；这里只剩音频/视频要在 payload 上补块（pi-ai 的 content 块里没有这两类）。
            // 传进来的 o.attachments 也只含这两类。
            const inner = models.streamSimple(piModel, context as never, {
              apiKey: self.config.getProviderKey(ref.provider) || undefined,
              signal: options?.signal,
              maxTokens: options?.maxTokens ?? mcfg?.maxOutput,
              reasoning: (reasoning || undefined) as never,
              // 媒体按"这一条候选供应商的线格式"现准备：链上不同供应商能收的块不一样
              onPayload: prepared
                ? (payload: unknown) => injectMedia(payload, apiName, prepared)
                : undefined,
            });
            for await (const ev of inner as AsyncIterable<any>) {
              if (ev.type === 'text_delta') streamed = true;
              if (ev.type === 'done') {
                // 用量要记在真实会话上：WorkRunner 靠 before/after 相减算本次任务的账，
                // 记到 sessionId（pi-agent-core 的会话号）上就对不上了
                self.recordUsage(ref.provider, ref.model, o.chatId ?? '-', mapUsage(ev.message?.usage));
                if (!pinned) self.adopt(kind, idx, list);
                self.clearHealth(kind, ref);
                if (fails.length) {
                  self.errors.record('warn', 'provider', `已自动切换模型：${fails.join('；')} → ${ref.provider}:${ref.model}`, {
                    chatId: o.chatId,
                  });
                }
                self.bus.emit(busEvents.providerChanged, { event: 'call_ok', provider: ref.provider, model: ref.model, ms: Date.now() - started });
                out.push(ev);
                out.end();
                return;
              }
              if (ev.type === 'error') throw new ProviderError(ev.error?.errorMessage || '对端流以错误结束');
              out.push(ev);
            }
            out.end();
            return;
          } catch (e) {
            const err = e as Error;
            lastErr = err;
            // 用户打断：不是模型故障，不记报错、不降级
            if (options?.signal?.aborted) { fail(err); return; }
            // 已经往外吐过字：换模型只会重复输出/违背中断，记下这次失败后直接终结
            if (streamed) {
              self.errors.record('error', 'provider', `${ref.provider}: ${err.message}`, {
                stack: err.stack,
                // 模型失败彻底沉默：只进报错中心与会话日志。私聊里那条 "[parallel 报错]"
                // 会被当成 bot 自己说的话发出去（2026-10-18 用户看到过），所以这里不通知主人。
                notifyOwner: false,
              });
              fail(err);
              return;
            }
            fails.push(`${ref.provider}: ${err.message}`);
            const hard = isHardUnavailable(err);
            if (list.length > 1) self.markFail(kind, idx, list, err, hard ? 'hard' : 'soft', !pinned);
            if (hard && isProviderWideFailure(err)) skipProviders.add(ref.provider);
          } finally {
            self.activeRequests--;
          }
        }
        self.recordChainError({ chatId: o.chatId }, fails, lastErr);
        fail(lastErr);
      })();
      return out;
    };
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

  private recordUsage(provider: string, model: string, chatId: string, usage?: LLMUsage): void {
    if (!usage) return;
    const day = todayKey();
    const hit = usage.cacheHitTokens ?? 0;
    const miss = usage.cacheMissTokens ?? 0;
    // 内存账：work 侧栏要展示"这次任务 + 本会话累计"的缓存命中，落库的表结构保持不变
    const acc = this.usageByChat.get(chatId) ?? { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, calls: 0 };
    acc.prompt += usage.promptTokens;
    acc.completion += usage.completionTokens;
    acc.cacheHit += hit;
    acc.cacheMiss += miss;
    acc.calls += 1;
    this.usageByChat.set(chatId, acc);
    const m = model || '';
    const row = this.db.get<{ prompt_tokens: number; completion_tokens: number; cache_hit: number; cache_miss: number; llm_calls: number }>(
      'SELECT prompt_tokens, completion_tokens, cache_hit, cache_miss, llm_calls FROM usage_stats WHERE day=? AND provider=? AND model=? AND chat_id=?',
      day, provider, m, chatId,
    );
    if (row) {
      this.db.run(
        'UPDATE usage_stats SET prompt_tokens=?, completion_tokens=?, cache_hit=?, cache_miss=?, llm_calls=? WHERE day=? AND provider=? AND model=? AND chat_id=?',
        row.prompt_tokens + usage.promptTokens, row.completion_tokens + usage.completionTokens,
        row.cache_hit + hit, row.cache_miss + miss, row.llm_calls + 1,
        day, provider, m, chatId,
      );
    } else {
      this.db.run(
        'INSERT INTO usage_stats (day, provider, model, chat_id, prompt_tokens, completion_tokens, cache_hit, cache_miss, llm_calls) VALUES (?,?,?,?,?,?,?,?,1)',
        day, provider, m, chatId, usage.promptTokens, usage.completionTokens, hit, miss,
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

/** 网络层直接失败（连不上、断流、超时）：换下一家才有意义，同一家再试也是白等 */
const TRANSPORT_FAILURE_RE = /fetch failed|ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network.?error|connection.?refused|connection.?lost|connection\s*error|other side closed|getaddrinfo|transport error|http2 request did not get a response|terminated|timed? ?out|timeout/i;

export function isTransportFailure(err: Error): boolean {
  return TRANSPORT_FAILURE_RE.test(String(err?.message ?? ''));
}

/** 鉴权失败与"地区不支持"是整家供应商的问题：同一家的第二个模型也不用再试 */
const PROVIDER_WIDE_RE = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.?api.?key|incorrect api key|user location is not supported|failed_precondition/i;

export function isProviderWideFailure(err: Error): boolean {
  const msg = String(err?.message ?? '');
  return TRANSPORT_FAILURE_RE.test(msg) || PROVIDER_WIDE_RE.test(msg);
}

/**
 * 这条错误是不是"再试同一条也没用"的硬不可用。
 * 硬故障立刻挪链（并冷却），软故障（429 / 5xx / 过载）仍按 failoverThreshold 计数——
 * 一次网络抖动不该把整条链带偏，但"连不上/没 key/没这个模型"等下一次只会更慢。
 */
const HARD_UNAVAILABLE_RE = /\b(401|403|404)\b|unauthori[sz]ed|forbidden|invalid.?api.?key|api.?key.*(invalid|missing|expired)|incorrect api key|model.*(not found|does not exist|not available)|no such model|user location is not supported|failed_precondition|尚未接入|未启用|缺少 api key|缺少 base url|未知的模型供应商|没有可用引擎/i;

export function isHardUnavailable(err: Error): boolean {
  const msg = String(err?.message ?? '');
  return HARD_UNAVAILABLE_RE.test(msg) || TRANSPORT_FAILURE_RE.test(msg);
}

/** 内核实现了请求逻辑的连接方式（三种 HTTP 线格式 + 本地 mock）；其余一律拒绝，不静默降级 */
const IMPL_PROTOCOLS = ['openai-compatible', 'openai-responses', 'anthropic', 'gemini', 'mock'];

function pcNeedsKey(pid: string, pc?: Record<string, any>): boolean {
  if (pc?.protocol === 'mock') return false;
  if (pc?.custom) return true;
  return pid === 'deepseek' || pid === 'openai-compatible';
}

// =====================================================================
// OpenAI-compatible 实现（流式 + 工具调用）
// =====================================================================

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
// 引擎接入：模型层统一走 @earendil-works/pi-ai
//
// 四种连接方式（Chat Completions / OpenAI Responses / Anthropic Messages / Gemini 原生）由 pi-ai 的
// 四个 api 实现负责；mock 是进程内的测试引擎，同样以 pi-ai 的 ProviderStreams 形状接进来。
// 内核自己不再实现任何线格式——那是这次迁移的目的：请求整形、SSE 解析、工具调用聚合、
// 各家的缓存字段折算，全部交给 pi-ai，内核只保留自己的价值面（优先链、降级阈值、用量账、
// 模型页契约与附件整形）。
// =====================================================================

/** 走链流函数收尾用：造一个 pi-ai 认的 error 事件（消费方只读 reason 与 errorMessage） */
function errorEvent(err: Error): unknown {
  return {
    type: 'error', reason: 'error',
    error: { role: 'assistant', content: [], stopReason: 'error', errorMessage: err.message, timestamp: Date.now() },
  };
}

/** 引擎选择：mock 走进程内引擎，其余按连接方式交给 pi-ai 的对应线格式实现 */
function engineFor(protocol: string): { apiName: string; api: unknown } | undefined {
  if (protocol !== 'mock') return undefined;
  return { apiName: 'mock', api: mockStreams() };
}

/** 注册表里的引擎占位：只提供元数据（label / defaultBase / implemented），请求不走它 */
export class PiEngineProvider implements LLMProvider {
  implemented = true;
  streaming = true;
  constructor(readonly id: string, readonly label: string = id, readonly defaultBase: string = '') {}
  async chat(): Promise<LLMResponse> {
    throw new ProviderError('内部错误：请求应当走 pi-ai 引擎（LlmService.invoke）');
  }
}

