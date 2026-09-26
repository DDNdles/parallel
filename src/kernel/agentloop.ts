import type {
  ChatEvent, ChatMessage, LLMRequestContext, ToolCall, ToolContext, ToolDef, ChatRef, Role, ToolMeta,
} from './types.ts';
import { composeSystem } from './types.ts';
import type { LlmService, ModelChainKind } from './services/llm.ts';
import type { SessionLog } from './sessionlog.ts';
import type { Bus } from './bus.ts';
import { busEvents } from './bus.ts';
import type { ConfigStore } from './config.ts';
import type { ErrorCenter } from './errors.ts';
import { truncate } from './util/misc.ts';

/**
 * Agent Loop（内核最小必需部分）：
 * system + few-shot + 历史 + 尾部强化 → LLM → 工具调用（≤ N 轮）→ 收敛输出。
 * 全程写 session log，工具调用对桌面端实时可见。
 */

/** 结构化步骤事件：给桌面端侧栏画 harness 式 loop（工具调用/结果/思考/用量） */
export type LoopEvent =
  | { kind: 'round'; n: number }
  | { kind: 'thinking'; round: number; text: string }
  | { kind: 'tool'; round: number; name: string; args: string }
  | { kind: 'toolResult'; round: number; name: string; text: string; meta?: ToolMeta }
  | { kind: 'usage'; round: number; prompt: number; completion: number; cacheHit: number; cacheMiss: number }
  | { kind: 'final'; text: string };

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
      /** 工具轮次上限（work 档无上限，缺省用 chat 的 maxToolRounds） */
      maxRounds?: number;
      /** 走哪条模型优先级链（缺省 chat）；providerId/model 显式指定时不走链 */
      chain?: ModelChainKind;
      /** 指定供应商/模型（覆盖链） */
      providerId?: string;
      model?: string;
      /** 每步回调（work 进度推送：工具调用/结果摘要） */
      onStep?: (step: string) => void;
      /** 结构化事件（work 侧栏的 loop 视图：轮次/思考/工具/用量） */
      onEvent?: (ev: LoopEvent) => void;
    },
  ): Promise<{ reply: string; rounds: number; toolCalls: number; steps: string[] }> {
    const { chat } = ctx;
    const chatKey = opts.chatKey;
    const steps: string[] = [];
    const step = (s: string) => { steps.push(s); opts.onStep?.(s); };
    const event = (ev: LoopEvent) => { try { opts.onEvent?.(ev); } catch { /* 订阅方问题不影响主流程 */ } };
    this.bus.emit(busEvents.agentStart, { chatKey, userId: ctx.event.userId });
    this.sessionLog.append(chat.chatId, chat.type, { type: 'agent_start', role: 'system', text: 'agent loop 开始' });

    const messages: ChatMessage[] = [
      { role: 'system', content: composeSystem(ctx.system, ctx.systemSections) },
      ...ctx.messages,
    ];
    const tools = ctx.tools.length
      ? ctx.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }))
      : undefined;

        // 轮次上限：opts.maxRounds 显式给出则生效；未给出时——chat 轮用配置值，work 轮（ctx.workTurn）无上限
    const maxRounds = opts.maxRounds ?? (ctx.workTurn ? Infinity : this.config.config.llm.maxToolRounds);
    let rounds = 0;
    let toolCallCount = 0;
    let reply = '';

    try {
      while (rounds < maxRounds) {
        rounds++;
        event({ kind: 'round', n: rounds });
        const resp = await this.llm.chat(
          { model: '', messages, tools, attachments: ctx.attachments, signal: opts.abort },
          {
            chatId: chat.chatId,
            chain: opts.chain,
            providerId: opts.providerId,
            model: opts.model,
            onDelta: (d) => {
              if (d.text) {
                this.bus.emit(busEvents.llmDelta, { chatKey, text: d.text });
              }
            },
          },
        );

        if (resp.usage) {
          event({
            kind: 'usage', round: rounds,
            prompt: resp.usage.promptTokens, completion: resp.usage.completionTokens,
            cacheHit: resp.usage.cacheHitTokens ?? 0, cacheMiss: resp.usage.cacheMissTokens ?? 0,
          });
        }
        // 本轮模型正文（有工具调用时就是"思考"，没有就是最终回答）
        if (resp.content.trim()) event({ kind: 'thinking', round: rounds, text: resp.content.trim() });

        if (resp.toolCalls.length === 0) {
          reply = resp.content.trim();
          break;
        }

        // 工具调用轮
        messages.push({ role: 'assistant', content: resp.content, tool_calls: resp.toolCalls });
        for (const tc of resp.toolCalls) {
          toolCallCount++;
          step(`▶ ${tc.function.name} ${truncate(tc.function.arguments ?? '', 160)}`);
          event({ kind: 'tool', round: rounds, name: tc.function.name, args: truncate(tc.function.arguments ?? '', 400) });
          const { text: result, meta } = await this.execTool(ctx, tc);
          step(`◀ ${tc.function.name}: ${truncate(result.replace(/\s+/g, ' '), 200)}`);
          event({ kind: 'toolResult', round: rounds, name: tc.function.name, text: truncate(result, 1200), meta });
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result });
        }
        // 无上限模式（Infinity）自然跳过收尾提示
        if (Number.isFinite(maxRounds) && rounds >= maxRounds - 1) {
          messages.push({ role: 'user', content: '（工具调用轮次已达上限，请直接给出最终回答）' });
        }
      }

      if (!reply) reply = '（这次没能好好组织回答，请再问我一次吧）';
      reply = reply.slice(0, 3500);
      event({ kind: 'final', text: reply });

      this.sessionLog.append(chat.chatId, chat.type, { type: 'agent_end', role: 'system', text: `agent loop 结束（${rounds} 轮 / ${toolCallCount} 次工具调用）` });
      this.bus.emit(busEvents.agentEnd, { chatKey, reply, rounds });
      return { reply, rounds, toolCalls: toolCallCount, steps };
    } catch (e) {
      const err = e as Error;
      this.sessionLog.append(chat.chatId, chat.type, { type: 'error', role: 'system', text: `agent loop 异常: ${err.message}` });
      throw e;
    }
  }

  private async execTool(ctx: LLMRequestContext, call: ToolCall): Promise<{ text: string; meta?: ToolMeta }> {
    const def = ctx.tools.find((t) => t.name === call.function.name);
    const chat = ctx.chat;
    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      args = {};
    }
    this.bus.emit(busEvents.toolCall, {
      chatKey: `${chat.type}_${chat.chatId}`, name: call.function.name, args, id: call.id, ts: Date.now(),
    });
    this.sessionLog.append(chat.chatId, chat.type, {
      type: 'tool_call', role: 'tool', text: call.function.name,
      data: { args: truncate(JSON.stringify(args), 600), callId: call.id },
    });

    let resultText: string;
    let meta: ToolMeta | undefined;
    if (!def) {
      resultText = `错误：工具 ${call.function.name} 不存在或在本会话不可用`;
    } else {
      const tctx: ToolContext = { event: ctx.event, chat, role: ctx.event.role ?? 'member' };
      try {
        const r = await def.handler(args, tctx);
        resultText = typeof r === 'string' ? r : r.content;
        meta = typeof r === 'string' ? undefined : r.meta;
      } catch (e) {
        const err = e as Error;
        // 权限/边界拒绝也返回给模型（诚实告知），同时留痕
        resultText = `错误：${err.message}`;
        if (!(err.name === 'PermissionDeniedError') && !err.message.includes('路径越界')) {
          this.errors.record('warn', 'plugin', `工具 ${call.function.name} 执行失败: ${err.message}`, { chatId: chat.chatId });
        }
      }
    }

    resultText = truncate(resultText, 4000);
    this.bus.emit(busEvents.toolResult, {
      chatKey: `${chat.type}_${chat.chatId}`, name: call.function.name, result: resultText, id: call.id, ts: Date.now(), meta,
    });
    this.sessionLog.append(chat.chatId, chat.type, {
      type: 'tool_result', role: 'tool', text: call.function.name,
      data: { result: truncate(resultText, 1200), callId: call.id, meta },
    });
    return { text: resultText, meta };
  }
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

  get(chat: ChatRef): ChatMessage[] {
    const k = this.key(chat);
    let h = this.map.get(k);
    if (!h) {
      h = this.rebuild(chat);
      this.map.set(k, h);
    }
    return h;
  }

  pushUser(chat: ChatRef, text: string): void {
    const h = this.get(chat);
    h.push({ role: 'user', content: text });
    this.trim(h);
  }

  pushAssistant(chat: ChatRef, text: string): void {
    const h = this.get(chat);
    h.push({ role: 'assistant', content: text });
    this.trim(h);
  }

  /** 取快照（调用方不得修改） */
  snapshot(chat: ChatRef): ChatMessage[] {
    return [...this.get(chat)];
  }

  private trim(h: ChatMessage[]): void {
    while (h.length > this.limit) h.shift();
    // 保证以 user 开头比较自然
    while (h.length && h[0].role === 'assistant') h.shift();
  }

  /** 从 session log 重建最近对话（message_in / message_out） */
  private rebuild(chat: ChatRef): ChatMessage[] {
    const entries = this.sessionLog.tail(chat.chatId, chat.type, this.limit * 2);
    const out: ChatMessage[] = [];
    for (const e of entries) {
      if (e.type === 'message_in' && e.role === 'user' && e.text) {
        out.push({ role: 'user', content: e.text });
      } else if (e.type === 'message_out' && e.role === 'assistant' && e.text) {
        out.push({ role: 'assistant', content: e.text });
      }
    }
    while (out.length > this.limit) out.shift();
    while (out.length && out[0].role === 'assistant') out.shift();
    return out;
  }
}
