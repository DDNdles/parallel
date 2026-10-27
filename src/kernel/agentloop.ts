// ============================================================
// Agent Loop —— 跑在 pi-agent-core 的 Agent 上
//
// 2026-09-28 起，循环本身（轮次、工具调度、terminate 早停、事件流）交给
// `@earendil-works/pi-agent-core` 的 `Agent`；内核这一层只负责：
//  - 把 parallel 的 ctx（system 分节 / 历史 / 工具面）翻译成 pi-agent-core 的形状；
//  - 把它的 AgentEvent 映射回内核自己的 bus 事件与「工作」抽屉的 LoopEvent；
//  - 模型请求走 `LlmService.chainStreamFn`（**不是**直连 pi-ai）——降级链是内核的价值面；
//  - 轮次上限、收尾（work_finish 的 finalReply）、上下文压缩这些 parallel 自己的语义。
//
// 工具执行用 sequential：parallel 的工具共享沙箱/常驻容器状态（python_session 的变量、
// 浏览器页面），并发跑会互相串味，与改造前"一次调一个"的行为保持一致。
//
// 对外契约不变：`run(ctx, opts)` 仍返回 `{reply, rounds, toolCalls, steps}`，
// bus 事件与 LoopEvent 的种类、时点也保持原样——插件与桌面端不需要知道自己换了内核。
// ============================================================

import type { ChatMessage, LLMRequestContext, ToolContext, ToolDef, ChatRef, ToolMeta, MessageAttachment } from './types.ts';
import { composeSystem } from './types.ts';
import type { LlmService, ModelChainKind } from './services/llm.ts';
import type { SessionLog } from './sessionlog.ts';
import type { Bus } from './bus.ts';
import { busEvents } from './bus.ts';
import type { ConfigStore } from './config.ts';
import type { ErrorCenter } from './errors.ts';
import { truncate } from './util/misc.ts';
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens, estimateTokens, serializeConversation, shouldCompact,
  type CompactionSettings,
} from '@earendil-works/pi-agent-core';
import { toPiMessages } from './services/pi-ai.ts';

/** 结构化步骤事件：给桌面端侧栏画 harness 式 loop（工具调用/结果/思考/用量/压缩） */
export type LoopEvent =
  | { kind: 'round'; n: number }
  /** 模型正文的增量（只给 work 面的实时流；不落库，message_end 会用完整 text 覆盖） */
  | { kind: 'delta'; round: number; text: string }
  /** 思考链的增量（同样只走实时流，message_end 用完整 thinking 覆盖） */
  | { kind: 'thinkingDelta'; round: number; text: string }
  /** 一条 assistant 消息的完整思考链（只含 thinking 块，正文不并进来） */
  | { kind: 'thinking'; round: number; text: string }
  /** 一条 assistant 消息的完整正文（与思考分开，直接作为正文显示） */
  | { kind: 'text'; round: number; text: string }
  | { kind: 'tool'; round: number; name: string; args: string }
  | { kind: 'toolResult'; round: number; name: string; text: string; meta?: ToolMeta }
  | { kind: 'usage'; round: number; prompt: number; completion: number; cacheHit: number; cacheMiss: number; ms?: number }
  | { kind: 'compaction'; round: number; dropped: number; tokensBefore: number; summary: string }
  | { kind: 'settle'; round: number; reason: 'terminate' | 'max_rounds' }
  /** 任务运行中用户改需求：转发给正在跑的 work（插话） */
  | { kind: 'steer'; text: string }
  | { kind: 'final'; text: string };

/** 一次 run 里由事件与工具回调攒起来的东西（Agent 不给我们返回值，只能边跑边收） */
interface RunCapture {
  rounds: number;
  toolCalls: number;
  /** 最后一条 assistant 的正文（没有收尾工具时的最终回答） */
  lastText: string;
  /** 收尾工具（work_finish）给的最终回答，优先级最高 */
  finalReply?: string;
  /** 收尾工具是否表示"活干完了"（pi-agent-core 自己也会据此早停，这里只为 LoopEvent 记一笔） */
  settled: boolean;
  /** 本轮开始时刻：message_end 时用它算这一轮的墙钟耗时（侧栏 TPS 用） */
  turnStartedAt?: number;
  /** 每一轮模型上报的用量（chat 轮要写进 agent_end，抽屉的 chat 段据此画圆环） */
  usage: { prompt: number; completion: number; cacheHit: number; cacheMiss: number; ms?: number }[];
}

/** 音频/视频进请求体的条数上限：它们没有 pi-ai 的 content 块，只能整批补在最后一条 user 上，
 *  几十条一起塞会把请求体顶到对端拒收（图片按消息分流，不受这个上限约束）。 */
const MEDIA_CAP = { audio: 8, video: 4 } as const;

/** work 轮「纯文字旁白」保护的节奏（2026-10-25 用户定：强制 work_finish 才算完成）：
 *  模型某轮只发文字、没调任何工具时，任务不算结束——等这么久还没下文就提醒它
 *  「继续执行或调 work_finish」。提醒满 WORK_IDLE_REMIND_LIMIT 次仍不收尾的按未完成处理。 */
export const WORK_IDLE_REMIND_MS = 60_000;
export const WORK_IDLE_REMIND_LIMIT = 5;

export class AgentLoop {
  constructor(
    private llm: LlmService,
    private sessionLog: SessionLog,
    private bus: Bus,
    private config: ConfigStore,
    private errors: ErrorCenter,
  ) {}

  async run(
    ctx: LLMRequestContext,
    opts: {
      chatKey: string;
      abort?: AbortSignal;
      /** 工具轮次上限（work 档无上限；chat 轮缺省两轮硬上限，见下） */
      maxRounds?: number;
      /** 走哪条模型优先级链（由 chainStreamFn 在链内部做降级） */
      chain?: ModelChainKind;
      /** 每步回调（work 进度推送：工具调用/结果摘要） */
      onStep?: (step: string) => void;
      /** 结构化事件（work 侧栏的 loop 视图：轮次/思考/工具/用量） */
      onEvent?: (ev: LoopEvent) => void;
      /** work 纯文字轮的提醒等待（毫秒）；缺省 60s，测试调小 */
      workIdleRemindMs?: number;
      /** 拿到正在跑的 pi Agent：work 任务插话用（只暴露 steer） */
      onAgent?: (agent: { steer: (message: any) => void }) => void;
    },
  ): Promise<{ reply: string; rounds: number; toolCalls: number; steps: string[]; finished: boolean }> {
    const { chat } = ctx;
    const chatKey = opts.chatKey;
    // 入账会话（work 轮=汇报聊天；chat 本身是任务沙箱 ref——2026-10-25 任务隔离）
    const ledger = ctx.reportChat ?? ctx.chat;
    const chain: ModelChainKind = opts.chain ?? (ctx.workTurn ? 'work' : 'chat');
    const steps: string[] = [];
    const step = (s: string) => { steps.push(s); opts.onStep?.(s); };
    const event = (ev: LoopEvent) => { try { opts.onEvent?.(ev); } catch { /* 订阅方问题不影响主流程 */ } };

    const { Agent } = await import('@earendil-works/pi-agent-core');
    const pie = await import('./services/pi-ai.ts');
    const pieMod = await pie.piAiModule();
    if (!pieMod) {
      throw new Error('未安装 @earendil-works/pi-ai：agent loop 跑在它的引擎上，请先 `npm i`');
    }

    // 轮次上限：work 轮**不设上限**（2026-10-23 用户定：工具轮次不设上限）；
    // agent 定义里的 max_rounds 只为兼容旧定义保留，不再参与截断。
    // **chat 轮仍是两轮硬上限（2026-10-17 用户裁定）**：第一轮允许走一次记忆查询（recall_facts /
    // search_history，见 prepareNextTurn 第二轮摘工具），没查就一轮答完——旧的 llm.maxToolRounds
    // 配置键已删：这是产品决定，不是旋钮。
    const maxRounds = opts.maxRounds ?? (ctx.workTurn ? Infinity : 2);
    const compaction = ctx.workTurn ? this.compactionSettings() : null;
    const contextWindow = ctx.workTurn ? this.llm.contextWindow(chain) : undefined;
    let lastSummary: string | undefined;
    let compactions = 0;

    const cap: RunCapture = { rounds: 0, toolCalls: 0, lastText: '', settled: false, usage: [] };

    this.bus.emit(busEvents.agentStart, { chatKey, userId: ctx.event.userId });
    this.sessionLog.append(ledger.chatId, ledger.type, {
      type: 'agent_start', role: 'system', text: 'agent loop 开始', lane: ctx.workTurn ? 'work' : 'chat',
    });

    // 图片能不能进这一轮：看链首模型在模型页登记的「输入类型」——与 chainStreamFn 的筛子同一条规则
    // （那行没登记就不筛；登记了不含 image 就不 seed）。不 seed 要如实报一条，别让 bot"装作没看见图"。
    const headTypes = this.chainHeadInputTypes(chain);
    const imageAllowed = headTypes ? headTypes.has('image') : true;

    // ---- 工具面：parallel 的 ToolDef → pi-agent-core 的 AgentTool ----
    // 图片回传也看链首模型的输入类型：不收图的模型只配拿到文字结果（见 toAgentTool）
    const tools = ctx.tools.map((def) => this.toAgentTool(ctx, def, cap, pieMod, imageAllowed, chatKey));

    // ---- 历史：ctx.messages 的最后一条就是本轮用户发言，交给 Agent 自己接着跑 ----
    // 中途的 system（人格插件那几条设定）在这里摘出来接到 system 末尾，不占 user 轮（见 toPiMessages 的说明）
    //
    // 媒体按消息归位：窗口内每条历史消息的附件跟着它自己那条走（图 → 该条 content 里最前的那块），
    // 本轮的 ctx.attachments 属于最后那条（本轮真人输入）。音频/视频 pi-ai 的 content 块里没有，
    // 只能收成一个数组交给走链流函数，由它在请求体的最后一条 user 上补块。
    const msgs = ctx.messages;
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    const attsAt = (i: number): MessageAttachment[] => {
      const own = msgs[i]?.attachments ?? [];
      return i === lastUser ? [...own, ...(ctx.attachments ?? [])] : own;
    };
    /** 被丢的媒体要点名"是哪条消息上的"（报错中心里只说"有一张图"等于没说） */
    const labelAt = (i: number): string => {
      if (i === lastUser) return '本轮最新那条消息';
      const ts = msgs[i]?.ts;
      const d = ts ? new Date(ts) : undefined;
      const hhmm = d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
      return hhmm ? `${hhmm} 那条消息` : `窗口内第 ${i + 1} 条消息`;
    };
    const imageCount = msgs.reduce((n, _m, i) => n + attsAt(i).filter((a) => a.kind === 'image').length, 0);
    if (!imageAllowed && imageCount) {
      this.errors.record('warn', 'provider', `链上模型不收图片（模型页那行没勾「图片」），本轮 ${imageCount} 张图片没送出`, { chatId: ledger.chatId });
    }
    const seeded = await toPiMessages(
      msgs,
      { id: chainModelId(this.config, ctx), provider: '' },
      '',
      {
        attachmentsFor: (i) => {
          const imgs = imageAllowed ? attsAt(i).filter((a) => a.kind === 'image') : [];
          return imgs.length ? imgs : undefined;
        },
      },
    );
    if (seeded.failedImages) {
      this.errors.record('warn', 'provider', `窗口内 ${seeded.failedImages} 张图片读不动（路径/URL 取不到），这一轮没送出`, { chatId: ledger.chatId });
    }
    // 动图没摊成分帧拼图：图照送（模型只看到首帧），但要在报错中心说清这张没被完整读到
    for (const w of seeded.imageWarnings ?? []) {
      this.errors.record('warn', 'provider', w, { chatId: ledger.chatId });
    }
    // 音频/视频收成一个数组（当前批次 + 窗口内历史），上限 audio ≤ 8 / video ≤ 4；
    // 超出的如实报掉——静默丢媒体正是"bot 装作没听见语音"那类 bug 藏久的原因。
    const media: MessageAttachment[] = [];
    const droppedMedia: string[] = [];
    let audioN = 0;
    let videoN = 0;
    for (let i = 0; i < msgs.length; i++) {
      for (const a of attsAt(i)) {
        if (a.kind === 'image') continue;
        if (a.kind === 'audio') {
          if (audioN >= MEDIA_CAP.audio) { droppedMedia.push(`${labelAt(i)}的语音`); continue; }
          audioN++;
        } else {
          if (videoN >= MEDIA_CAP.video) { droppedMedia.push(`${labelAt(i)}的视频`); continue; }
          videoN++;
        }
        media.push(a);
      }
    }
    if (droppedMedia.length) {
      this.errors.record('warn', 'provider', `语音最多 ${MEDIA_CAP.audio} 条、视频最多 ${MEDIA_CAP.video} 条，超出的没送出：${droppedMedia.join('、')}`, { chatId: ledger.chatId });
    }
    const history = seeded.messages;
    const modelStub = await pie.piModelFor({
      providerId: '', protocol: 'openai-compatible', baseUrl: '',
      model: { id: chainModelId(this.config, ctx) },
    });

    // chat 轮的输出 token 硬顶（humanlike.outgoing.maxReplyTokens）：短回复是产品口径，
    // 抽风写小作文时由它 + 出站句边截断兜底。work 轮不设（交付多长都行，走模型页自己的 maxOutput）。
    const replyCap = ctx.workTurn ? 0 : Math.round(Number(this.config.config.humanlike.outgoing.maxReplyTokens) || 0);
    const rawStream = this.llm.chainStreamFn(chain, {
      attachments: media,
      chatId: ledger.chatId,
      // 并发的 work 任务各钉一个起始模型；chat 链不分槽
      start: chain === 'work' ? ctx.workSlot : undefined,
    });
    const streamFn = (replyCap > 0
      ? ((model: any, context: any, options: any) => rawStream(model, context, { ...(options ?? {}), maxTokens: replyCap }))
      : rawStream) as never;

    const agent = new Agent({
      initialState: {
        systemPrompt: composeSystem(ctx.system, ctx.systemSections, seeded.extraSystem),
        model: modelStub as never,
        tools: tools as never,
        // 只播种历史；system 由 Agent 自己按 systemPrompt + tools 生成（否则会重复一条）
        messages: history as never,
      },
      // 模型请求经内核的走链流函数：保住"一个模型挂了自动换下一个"。
      // 这里只交音频/视频（图片已按消息归位到种子上下文里，不再走这条补块的路）。
      streamFn,
      getApiKey: (pid: string) => this.config.getProviderKey(pid),
      // 我们塞进去的都是标准消息，这里只挡掉未知角色（pi-agent-core 允许自定义类型）
      convertToLlm: (msgs: any[]) => msgs.filter((m) => ['system', 'user', 'assistant', 'toolResult'].includes(m?.role)),
      toolExecution: 'sequential',
      // 每轮请求前的钩子（pi-agent-core 给的边界）：
      //  - work 轮：上下文压缩（概率触发，见 compactOnce）；
      //  - chat 轮：**工具面只给第一轮**——模型一旦调过工具（记忆查询），下一次请求直接摘掉
      //    tools，只准输出正文。这就是"读取记忆工具完成后仅一轮 loop"，两轮封顶。
      prepareNextTurn: ctx.workTurn
        ? (compaction
          ? async () => {
              // pi 的 token 账：estimateContextTokens 会优先采用最后一条 assistant 报的真实 usage，
              // 再补上它之后的估算，所以不必自己维护 lastPromptTokens
              const used = estimateContextTokens(agent.state.messages as never).tokens;
              if (!contextWindow || !shouldCompact(used, contextWindow, compaction)) return undefined;
              const done = await this.compactOnce({
                messages: agent.state.messages as any[],
                chat, summaryOf: lastSummary, reserveTokens: compaction.reserveTokens,
                keepRecentTokens: compaction.keepRecentTokens, chain, signal: opts.abort, round: cap.rounds,
                ledgerChat: ledger,
              });
              if (!done) return undefined;
              lastSummary = done.summary;
              compactions++;
              event({ kind: 'compaction', round: cap.rounds, dropped: done.dropped, tokensBefore: done.tokensBefore, summary: done.summary });
              return { context: { messages: done.messages as never, tools: tools as never }, model: agent.state.model };
            }
          : undefined)
        : (async () => {
            if (cap.toolCalls === 0) return undefined;
            return { context: { messages: agent.state.messages as never, tools: [] as never }, model: agent.state.model };
          }),
    });

    // 交给调用方一个插话句柄：work 任务在跑时用户改需求，WorkRunner 用它 agent.steer()
    // 把新消息排进 transcript（pi 会在当前 assistant 轮结束后注入，见 pi-agent-core 的 steeringQueue）
    try { opts.onAgent?.(agent); } catch { /* 插话通道接不上不影响主流程 */ }

    const onAbort = () => agent.abort();
    opts.abort?.addEventListener('abort', onAbort, { once: true });

    const off = agent.subscribe((ev: any) => this.onAgentEvent(ev, ctx, cap, { chatKey, step, event, agent }));

    try {
      // 历史最后一条就是本轮用户发言：用 continue 从当前 transcript 接着跑
      await agent.continue();
      await agent.waitForIdle();

      // 模型瞬态中断重试（2026-10-25）：Gemini 生成工具调用参数时偶发
      // MALFORMED_FUNCTION_CALL，pi 把它转成 stopReason='error' 的空 assistant 收场——
      // 该轮直接作废、群里沉默。这类抽风重跑一次通常就好：把失败消息摘出 transcript
      // 再 continue（最多一次，再失败走原路 = chat 沉默 / work 按空回复判失败）。
      for (let retries = 0; retries < 1; retries++) {
        const msgs = agent.state.messages as { role?: string; stopReason?: string; errorMessage?: string; content?: unknown }[];
        const last = msgs[msgs.length - 1];
        if (last?.role !== 'assistant' || last.stopReason !== 'error' || opts.abort?.aborted) break;
        // 收尾工具落地后的主动 abort 也是 stopReason='error'（errorMessage="…aborted"）——
        // 那是任务正常收尾，不是瞬态中断，重试它会把 abort 后的空转变成多烧一次模型调用
        if (/abort/i.test(String(last.errorMessage ?? ''))) break;
        msgs.pop();
        const note = `模型瞬态中断：${truncate(String(last.errorMessage ?? ''), 140)}；重试一次`;
        event({ kind: 'text', round: cap.rounds, text: `（${note}）` });
        // chat 轮没有 work 事件流：落一条 gate 到会话日志，排障能看到
        this.sessionLog.append(ledger.chatId, ledger.type, { type: 'gate', role: 'system', text: note });
        await agent.continue();
        await agent.waitForIdle();
      }

      // work 轮只认 work_finish / work_ask 收尾（2026-10-25 用户定：强制 work_finish 才算完成）。
      // 纯文字轮（没调任何工具）在 agent 循环的默认语义里等于"跑完了"——但那多半是模型
      // 想继续干活的旁白，整场任务静默收在一句话上、work_finish 没走（Three.js 任务 178 轮
      // 实锤）。处理：等 WORK_IDLE_REMIND_MS 还没有下文，就提醒它继续执行或调 work_finish；
      // 提醒满 WORK_IDLE_REMIND_LIMIT 次仍不收尾 → finished=false 交回 WorkRunner 判未完成。
      let reminders = 0;
      while (ctx.workTurn && !cap.settled && !opts.abort?.aborted && reminders < WORK_IDLE_REMIND_LIMIT) {
        const msgs = agent.state.messages as { role?: string; content?: unknown }[];
        const last = msgs[msgs.length - 1];
        const lastText = typeof last?.content === 'string'
          ? last.content
          : Array.isArray(last?.content)
            ? (last.content as { type?: string; text?: string }[]).filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('')
            : '';
        // 末条不是带正文的 assistant（比如空回复/被中断）：不提醒，按原样结算
        if (last?.role !== 'assistant' || !lastText.trim()) break;
        const waitMs = opts.workIdleRemindMs ?? WORK_IDLE_REMIND_MS;
        await new Promise<void>((res) => {
          const t = setTimeout(res, waitMs);
          opts.abort?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
        });
        if (cap.settled || opts.abort?.aborted) break;
        // followUp 队列非空说明有消息在路上（比如插件 steer 过），让它先跑
        if (agent.hasQueuedMessages()) continue;
        reminders++;
        event({
          kind: 'text', round: cap.rounds + 1,
          text: `（内核提醒 ${reminders}/${WORK_IDLE_REMIND_LIMIT}：这条回复没有调用工具，任务未收尾——继续执行，或调用 work_finish 交付）`,
        });
        agent.followUp({
          role: 'user',
          content: [{
            type: 'text',
            text: '这条回复没有调用任何工具，任务还没有结束。请立即行动：任务没做完就继续执行（调用工具）；做完了就调用 work_finish 正式交付（summary 写给用户看的结论，artifacts 登记产物路径）；需要用户确认就调用 work_ask。不要只输出文字。',
          }],
        } as never);
        await agent.continue();
        await agent.waitForIdle();
      }

      agent.clearAllQueues();

      let reply = (cap.finalReply ?? cap.lastText ?? '').trim();
      if (ctx.workTurn && cap.settled) event({ kind: 'settle', round: cap.rounds, reason: 'terminate' });
      if (ctx.workTurn && Number.isFinite(maxRounds) && cap.rounds >= maxRounds) {
        event({ kind: 'settle', round: cap.rounds, reason: 'max_rounds' });
      }
      // 空输出不再编一句"没答好"的托词：模型没接、额度耗尽、链全挂时群里必须一个字都没有。
      // 沉默由 pipeline 落 gate 条目，错误细节走报错中心；work 链靠 WorkRunner 把空回复判成失败。
      // 2026-10-25 用户定：work 的交付正文不设上限（聊天合集里全文送出）；chat 轮保留防抽风切片
      if (!ctx.workTurn) reply = reply.slice(0, 3500);
      event({ kind: 'final', text: reply });

      // work 轮是否"正式收尾"（work_finish / work_ask）：提醒满限仍只发文字的如实报
      // unfinished，由 WorkRunner 判未完成——强制 work_finish 才算完成（2026-10-25 用户定）。
      const finished = !ctx.workTurn || cap.settled || !!opts.abort?.aborted;

      this.sessionLog.append(ledger.chatId, ledger.type, {
        type: 'agent_end', role: 'system', lane: ctx.workTurn ? 'work' : 'chat',
        text: `agent loop 结束（${cap.rounds} 轮 / ${cap.toolCalls} 次工具调用${compactions ? ` / 压缩 ${compactions} 次` : ''}）`,
        // chat 段没有 work.done 那种结算：把每轮用量挂在 agent_end 上，抽屉用最近一条画
        // 上下文圆环 / 缓存命中 / TPS（否则 chat 那一栏永远是空的）
        data: { rounds: cap.rounds, toolCalls: cap.toolCalls, usage: cap.usage, model: this.llm.servingLabel(chain) },
      });
      this.bus.emit(busEvents.agentEnd, { chatKey, reply, rounds: cap.rounds });
      return { reply, rounds: cap.rounds, toolCalls: cap.toolCalls, steps, finished };
    } catch (e) {
      const err = e as Error;
      this.sessionLog.append(ledger.chatId, ledger.type, { type: 'error', role: 'system', text: `agent loop 异常: ${err.message}` });
      throw e;
    } finally {
      off();
      opts.abort?.removeEventListener('abort', onAbort);
    }
  }

  /** parallel 的工具定义 → pi-agent-core 的 AgentTool（参数用 Type.Unsafe 包一层 JSON Schema） */
  private toAgentTool(ctx: LLMRequestContext, def: ToolDef, cap: RunCapture, pie: any, vision: boolean, chatKey: string): unknown {
    return {
      name: def.name,
      label: def.name,
      description: def.description,
      // pi-ai 的工具参数是 TypeBox schema；parallel 存的就是 JSON Schema，原样包一层即可
      parameters: pie.Type.Unsafe(def.parameters),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const tctx: ToolContext = {
            event: ctx.event, chat: ctx.chat, role: ctx.event.role ?? 'member',
            batch: ctx.batch, speakers: ctx.speakers,
            historyWindowStartTs: ctx.historyWindowStartTs,
            work: ctx.workTurn ? { depth: ctx.workDepth ?? 0, runId: ctx.workRunId, agent: ctx.workAgent?.name } : undefined,
            vision,
            attachments: ctx.attachments,
            // 窗口消息快照（user/assistant）：work_dispatch 纯转发的引用源（只能逐字引用，程序转发整条原文）
            // 只读投影——工具拿不到也改不了这份上下文本身
            contextMessages: ctx.messages
              ? ctx.messages
                  .filter((m) => m.role === 'user' || m.role === 'assistant')
                  .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content ?? ''), ts: m.ts }))
              : undefined,
          };
        try {
          const r = await def.handler(params ?? {}, tctx);
          const text = typeof r === 'string' ? r : r.content;
          const meta = typeof r === 'string' ? undefined : r.meta;
          const terminate = typeof r === 'string' ? undefined : r.terminate;
          const finalReply = typeof r === 'string' ? undefined : r.finalReply;
          // 收尾工具的交付内容优先当最终回答（模型不必再复述一遍，也就不会走样）
          if (finalReply?.trim()) { cap.finalReply = finalReply.trim(); cap.settled = true; }
          else if (terminate) cap.settled = true;
          // 图片结果（浏览器截图 / 渲染复查）：模型收图就回给模型；不收图就只留文字，
          // 并如实告诉它"你看不到这张图"——否则它会以为自己检查过渲染效果。
          const images = typeof r === 'string' ? undefined : r.images;
          if (images?.length && !vision) {
            this.errors.record('warn', 'provider', `工具 ${def.name} 返回了 ${images.length} 张图片，但链首模型不收图片，已丢弃`, { chatId: ctx.chat.chatId });
          }
          // 2026-10-25 用户定：工具输出不截断——模型看不见完整输出就会瞎猜重做
          const content: any[] = [{ type: 'text', text }];
          if (vision) for (const img of images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
          return { content, details: meta, terminate };
        } catch (e) {
          const err = e as Error;
          // 权限/边界拒绝也返回给模型（诚实告知），同时留痕
          if (!(err.name === 'PermissionDeniedError') && !err.message.includes('路径越界')) {
            this.errors.record('warn', 'plugin', `工具 ${def.name} 执行失败: ${err.message}`, { chatId: ctx.chat.chatId });
          }
          return { content: [{ type: 'text', text: `错误：${err.message}` }], details: undefined };
        }
      },
    };
  }

  /** pi-agent-core 的 AgentEvent → 内核的 bus 事件 / LoopEvent / 步骤文案 / 会话日志 */
  private onAgentEvent(
    ev: any,
    ctx: LLMRequestContext,
    cap: RunCapture,
    h: { chatKey: string; step: (s: string) => void; event: (e: LoopEvent) => void; agent?: { abort(): void } },
  ): void {
    const { chat } = ctx;
    // 同一条会话日志里混着 chat 轮与 work 轮的条目：标出来，桌面端才能分成两段显示
    const lane: 'chat' | 'work' = ctx.workTurn ? 'work' : 'chat';
    switch (ev?.type) {
      case 'turn_start':
        cap.rounds++;
        cap.turnStartedAt = Date.now();
        h.event({ kind: 'round', n: cap.rounds });
        break;

      case 'message_update': {
        const a = ev.assistantMessageEvent;
        if ((a?.type === 'text_delta' || a?.type === 'thinking_delta') && a.delta) {
          // work 面把增量送进活动流（桌面端实时显示），chat 面仍只走 llmDelta。
          // 正文与思考链分两条流：正文进正文行，thinking_delta 进「思考」行，互不混。
          if (ctx.workTurn) {
            h.event(a.type === 'thinking_delta'
              ? { kind: 'thinkingDelta', round: cap.rounds, text: a.delta }
              : { kind: 'delta', round: cap.rounds, text: a.delta });
          }
          if (a.type === 'text_delta') this.bus.emit(busEvents.llmDelta, { chatKey: h.chatKey, text: a.delta });
        }
        break;
      }

      case 'message_end': {
        const m = ev.message;
        if (m?.role !== 'assistant') break;
        const text = textOf(m);
        const reasoning = thinkingOf(m);
        // 思考链与正文分开落事件：正文不再塞进「思考」行。
        if (reasoning.trim()) h.event({ kind: 'thinking', round: cap.rounds, text: reasoning });
        if (text.trim()) h.event({ kind: 'text', round: cap.rounds, text });
        if (m.usage) {
          const u = {
            prompt: Number(m.usage.input ?? 0) + Number(m.usage.cacheRead ?? 0),
            completion: Number(m.usage.output ?? 0),
            cacheHit: Number(m.usage.cacheRead ?? 0), cacheMiss: Number(m.usage.input ?? 0),
            // 本轮墙钟（模型请求到出完这一条）：侧栏据此算 TPS。不含工具执行时间——
            // 工具轮的总耗时里大头是工具，拿它除输出 token 会得到一个毫无意义的低值。
            ms: cap.turnStartedAt ? Math.max(1, Date.now() - cap.turnStartedAt) : undefined,
          };
          cap.usage.push(u);
          h.event({ kind: 'usage', round: cap.rounds, ...u });
        }
        cap.lastText = text || cap.lastText;
        break;
      }

      case 'tool_execution_start': {
        cap.toolCalls++;
        const args = safeJson(ev.args);
        h.step(`▶ ${ev.toolName} ${args}`);
        h.event({ kind: 'tool', round: cap.rounds, name: ev.toolName, args });
        this.bus.emit(busEvents.toolCall, { chatKey: h.chatKey, name: ev.toolName, args: ev.args ?? {}, id: ev.toolCallId, ts: Date.now() });
        this.sessionLog.append((ctx.reportChat ?? ctx.chat).chatId, (ctx.reportChat ?? ctx.chat).type, {
          type: 'tool_call', role: 'tool', text: ev.toolName, lane,
          data: { args, callId: ev.toolCallId },
        });
        break;
      }

      case 'tool_execution_end': {
        const text = contentText(ev.result?.content);
        h.step(`◀ ${ev.toolName}: ${text.replace(/\s+/g, ' ')}`);
        h.event({ kind: 'toolResult', round: cap.rounds, name: ev.toolName, text, meta: ev.result?.details });
        // cap.settled 由 toAgentTool 在 handler 返回后置位（finalReply 已拿到）。pi 的批终止
        // 语义是 every（整批工具都 terminate 才停），收尾工具前面混着普通工具时批不会停、
        // 会再烧一次模型调用——这里在收尾工具结果落地后直接 abort，后续工具/下一轮都不该再有。
        if (ctx.workTurn && ev.result?.terminate === true && h.agent) {
          try { h.agent.abort(); } catch { /* 已在收尾流程就不影响 */ }
        }
        this.bus.emit(busEvents.toolResult, {
          chatKey: h.chatKey, name: ev.toolName, result: text,
          id: ev.toolCallId, ts: Date.now(), meta: ev.result?.details,
        });
        this.sessionLog.append((ctx.reportChat ?? ctx.chat).chatId, (ctx.reportChat ?? ctx.chat).type, {
          type: 'tool_result', role: 'tool', text: ev.toolName, lane,
          data: { result: text, callId: ev.toolCallId, meta: ev.result?.details },
        });
        break;
      }

      default:
        break;
    }
  }

  /** work 轮的压缩设置（config.work.compaction；缺省用 pi-agent-core 的 DEFAULT_COMPACTION_SETTINGS） */
  private compactionSettings(): CompactionSettings {
    const c = (this.config.config as unknown as { work?: { compaction?: Partial<CompactionSettings> } }).work?.compaction ?? {};
    return {
      enabled: c.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
      reserveTokens: c.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      keepRecentTokens: c.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    };
  }

  /**
   * 链首模型登记的输入类型（模型页 `providers.<id>.models[]` 那行的 inputTypes）。
   * 与 chainStreamFn 的筛子是**同一条规则**：那行没在模型页登记过就不筛；
   * 登记了但没写 inputTypes，等同"什么都不收"（旧配置多半没勾，图片就会被拦下并留一条 warn）。
   */
  private chainHeadInputTypes(chain: ModelChainKind): Set<string> | undefined {
    const head = this.llm.chainConfig(chain)[0];
    if (!head) return undefined;
    const mcfg = ((this.config.config.providers as Record<string, any>)[head.provider]?.models as any[] | undefined)
      ?.find((m) => m?.id === head.model);
    if (!mcfg) return undefined;
    return new Set((Array.isArray(mcfg.inputTypes) ? mcfg.inputTypes : []).map(String));
  }

  /**
   * 压一次：把待摘要前缀交给工作链的模型生成结构化摘要，返回「摘要 + 保留段」的新消息表。
   * 失败时返回 null（宁可上下文偏大，也不能把历史弄丢）。
   */
  private async compactOnce(opts: {
    messages: any[];
    chat: ChatRef;
    summaryOf?: string;
    reserveTokens: number;
    keepRecentTokens: number;
    chain?: ModelChainKind;
    signal?: AbortSignal;
    round: number;
    /** 压缩条目落的会话（work 轮=汇报聊天，chat 本身是任务沙箱 ref） */
    ledgerChat?: ChatRef;
  }): Promise<{ summary: string; dropped: number; tokensBefore: number; messages: any[] } | null> {
    const plan = planCut(opts.messages, opts.keepRecentTokens);
    // 整段都要被丢掉（没有可保留的尾巴）时不压：压了等于把当前对话整个换成摘要，得不偿失
    if (!plan.dropped.length || plan.cutIndex >= opts.messages.length) return null;
    // 原文已经是 pi 消息了，直接交给 pi 的序列化器（它负责把工具结果截到 2000 字等细节）
    const serialized = serializeConversation(plan.dropped as never);
    if (!serialized.trim()) return null;
    try {
      const resp = await this.llm.chat(
        {
          model: '',
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM_ZH },
            { role: 'user', content: buildSummaryPrompt(serialized, opts.summaryOf) },
          ],
          stream: false,
          signal: opts.signal,
        },
        { chatId: (opts.ledgerChat ?? opts.chat).chatId, chain: opts.chain },
      );
      const summary = trimSummary(resp.content ?? '', opts.reserveTokens);
      if (!summary.trim()) return null;
      // 落一条 compaction 条目：它标记"这一刻之前的历史由这段摘要代替"。
      // firstKeptEntryId 给 null = 只保留摘要；字段留着是为了将来做更细的切分（pi 的语义）。
      try {
        const ledgerChat = opts.ledgerChat ?? opts.chat;
        this.sessionLog.appendCompaction(ledgerChat.chatId, ledgerChat.type, {
          summary, firstKeptEntryId: null, tokensBefore: plan.droppedTokens,
        });
      } catch { /* 落盘失败不影响本次请求 */ }
      return {
        summary,
        dropped: plan.dropped.length,
        tokensBefore: plan.droppedTokens,
        messages: [summaryPiMessage(summary), ...opts.messages.slice(plan.cutIndex)],
      };
    } catch (e) {
      this.errors.record('warn', 'kernel', `上下文压缩失败（跳过本次压缩）: ${(e as Error).message}`, { chatId: opts.chat.chatId });
      return null;
    }
  }
}

/** 链上当前生效的模型名（只给 pi-ai 的 Model 元数据用，真正发请求由 chainStreamFn 决定） */
function chainModelId(config: ConfigStore, ctx: LLMRequestContext): string {
  const llm = (config.config as unknown as { llm: { workChain?: { model: string }[]; chatChain?: { model: string }[] } }).llm;
  const list = ctx.workTurn ? (llm.workChain ?? []) : (llm.chatChain ?? []);
  return list[0]?.model ?? 'unknown';
}

/** 从 pi-ai 的 content 块里取正文（跳过思考块与工具调用块） */
function textOf(message: any): string {
  const blocks = message?.content;
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('');
}

/** 从 pi-ai 的 content 块里取思考链（type=thinking，字段是 thinking） */
function thinkingOf(message: any): string {
  const blocks = message?.content;
  const fromBlocks = Array.isArray(blocks)
    ? blocks
      .filter((b: any) => b?.type === 'thinking' || b?.type === 'reasoning')
      .map((b: any) => String(b.thinking ?? b.text ?? b.reasoning ?? ''))
      .join('')
    : '';
  return fromBlocks || (typeof message?.reasoning === 'string' ? message.reasoning : '');
}

function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('');
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v ?? {}); } catch { return '{}'; }
}

/**
 * 会话历史：内存 ring + 从 session log 重建（重启后恢复最近对话）。
 */
export class HistoryStore {
  private map = new Map<string, ChatMessage[]>();
  private sessionLog: SessionLog;
  private limit: number;

  constructor(sessionLog: SessionLog, limit: number) {
    this.sessionLog = sessionLog;
    this.limit = limit;
  }

  key(chat: ChatRef): string {
    return `${chat.type}_${chat.chatId}`;
  }

  /** 运行时改环形上限（config API 保存后立即生效；已缓存的历史不回溯重建，只影响此后的裁剪与增长） */
  setLimit(n: number): void {
    this.limit = Math.max(1, Math.round(n));
  }

  get(chat: ChatRef): ChatMessage[] {
    const k = this.key(chat);
    let h = this.map.get(k);
    if (!h) {
      h = this.rebuild(chat);
      this.map.set(k, h);
    }
    return h;
  }

  /** `attachments` 只带这条消息里真有的媒体；没有就不落这个键（老条目因此天然没有附件，不留空占位） */
  pushUser(chat: ChatRef, text: string, attachments?: MessageAttachment[]): void {
    const h = this.get(chat);
    const msg: ChatMessage = { role: 'user', content: text, ts: Date.now() };
    if (attachments?.length) msg.attachments = attachments;
    h.push(msg);
    this.trim(h);
  }

  pushAssistant(chat: ChatRef, text: string): void {
    const h = this.get(chat);
    h.push({ role: 'assistant', content: text, ts: Date.now() });
    this.trim(h);
  }

  /**
   * 取快照（调用方不得修改）。
   * 给了 `sinceTs` 就只保留上下文时间窗内的条目：带上 ts 的按 `ts >= sinceTs` 筛，
   * **没有 ts 的保守保留**（字段缺失不该被当成"太旧"而把内容吞掉）。
   */
  snapshot(chat: ChatRef, sinceTs?: number): ChatMessage[] {
    const h = this.get(chat);
    if (sinceTs === undefined) return [...h];
    return h.filter((m) => m.ts === undefined || m.ts >= sinceTs);
  }

  private trim(h: ChatMessage[]): void {
    while (h.length > this.limit) h.shift();
    // 保证以 user 开头比较自然
    while (h.length && h[0].role === 'assistant') h.shift();
  }

  /**
   * 从 session log 重建最近对话。
   * 走 `project()`（活动分支 + 最近的 compaction 边界），所以**重启后不会把压缩过的历史又变回全文**：
   * 摘要接在最前，其后只跟压缩之后记录的消息。
   */
  private rebuild(chat: ChatRef): ChatMessage[] {
    const { messages, summary } = this.sessionLog.project(chat.chatId, chat.type, this.limit * 2);
    const out: ChatMessage[] = messages.map((m) => {
      const msg: ChatMessage = { role: m.role, content: m.content };
      // ts 与附件都要跟着回来：重启后冷启动的时间窗过滤与窗口内媒体重放全靠它们
      if (m.ts !== undefined) msg.ts = m.ts;
      if (m.attachments?.length) msg.attachments = m.attachments;
      return msg;
    });
    if (summary) out.unshift(summaryMessage(summary));
    while (out.length > this.limit) out.shift();
    while (out.length && out[0].role === 'assistant') out.shift();
    return out;
  }
}


// =====================================================================
// 压缩的"胶水"（算法/阈值/序列化用 pi-agent-core 的，这里只留三件它管不到的事）
//
//  ① 切点：pi 的 `findCutPoint` 是面向它自己的会话条目的，我们手上是消息数组，
//     所以在数组下标上做等价的事——从后往前攒够 keepRecent，**切点避开 toolResult**
//     （工具结果必须跟着自己的 tool_call 一起走，否则线格式会收到孤儿消息）。
//  ② 摘要提示词与中文口径：pi 的 `SUMMARIZATION_SYSTEM_PROMPT` 没有从包入口导出、
//     深路径也不在它的 exports map 里，所以这段我们自己写，但照搬它"不要继续对话、
//     只输出结构化摘要"的两条硬要求，字段结构也与它一致。
//  ③ 摘要回填的形状：并行侧的历史是 ChatMessage（字符串 content），
//     pi-agent-core 的上下文是块数组消息——两者都要，别混用（混过一次：ch.codePointAt is not a function）。
// =====================================================================

/** 摘要的系统提示词（见上面 ②） */
const SUMMARY_SYSTEM_ZH = [
  '你是一个上下文压缩助手。读下面的对话（用户与 AI 助手之间），产出一段结构化摘要。',
  '不要继续这段对话，不要回答里面的任何问题，只输出摘要本身。',
  '',
  '用中文、Markdown，严格按这个结构输出（没有内容的小节写"（无）"）：',
  '',
  '## 目标',
  '用户要达成什么。',
  '',
  '## 约束与偏好',
  '- 用户明确提出过的要求',
  '',
  '## 进展',
  '### 已完成',
  '### 进行中',
  '### 受阻',
  '',
  '## 关键决定',
  '- **决定**：理由',
  '',
  '## 下一步',
  '',
  '## 关键上下文',
  '- 继续任务必须知道的数据、路径、结论、报错原文',
  '',
  '要求：保留具体的事实与数值（路径、命令、变量名、错误信息），不要写"做了一些分析"这种没有信息量的句子；',
  '不要复述工具调用的过程，只留结果；不要编造对话里没有的内容。',
].join('\n');

/** 摘要回填时的包装（与 pi 的 COMPACTION_SUMMARY_PREFIX 同义，这里用中文） */
const SUMMARY_PREFIX = '【历史压缩】到此为止之前的对话已被压缩成下面这段摘要：\n\n<summary>\n';
const SUMMARY_SUFFIX = '\n</summary>';

/** 摘要内容超出预算时的硬上限（字符），防一段摘要又把窗口顶爆 */
const SUMMARY_MAX_CHARS = 8000;

/**
 * 切点（见上面 ①）：pi 消息原生——用 pi 的 `estimateTokens` 估算，
 * 并避开 `toolResult`（pi 的角色名）。
 */
export function planCut(messages: any[], keepRecentTokens: number): { cutIndex: number; dropped: any[]; droppedTokens: number } {
  let acc = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i]) + 4;
    if (acc >= keepRecentTokens) { cut = i; break; }
  }
  // 切点不能落在工具结果上：向后滑到发起这次调用的那条 assistant，
  // 让"调用 + 结果"整体落在保留段里（向前滑会滑过末尾，等于什么都没压）。
  while (cut > 0 && messages[cut]?.role === 'toolResult') cut--;
  const dropped = messages.slice(0, cut);
  return { cutIndex: cut, dropped, droppedTokens: dropped.reduce((n, m) => n + estimateTokens(m) + 4, 0) };
}

/** 拼摘要请求的用户消息：上一版摘要作为迭代上下文带上（pi 的 previousSummary 语义） */
function buildSummaryPrompt(serialized: string, previousSummary?: string): string {
  const parts: string[] = [];
  if (previousSummary) {
    parts.push('这是更早一次压缩产出的摘要（本次压缩的区间从它之后开始），请把它一并纳入新的摘要：', '', previousSummary, '', '---', '');
  }
  parts.push('需要压缩的对话：', '', serialized);
  return parts.join('\n');
}

/** 摘要太长时按预留预算截断 */
function trimSummary(summary: string, reserveTokens: number): string {
  const budget = Math.max(1200, Math.min(SUMMARY_MAX_CHARS, reserveTokens * 2));
  const t = summary.trim();
  return t.length > budget ? `${t.slice(0, budget)}…（摘要过长已截断）` : t;
}

/** 摘要回填成并行侧的历史消息（HistoryStore 重建时用；之后会被转成 pi 消息） */
function summaryMessage(summary: string): ChatMessage {
  return { role: 'user', content: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}` };
}

/** 同上，但回填进 pi-agent-core 的上下文（content 是块数组） */
function summaryPiMessage(summary: string): unknown {
  return { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}` }], timestamp: Date.now() };
}
