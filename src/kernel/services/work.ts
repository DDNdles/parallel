import type { Bus } from '../bus.ts';
import type { Db } from '../db.ts';
import type { ConfigStore } from '../config.ts';
import type { ErrorCenter } from '../errors.ts';
import type { AgentLoop, LoopEvent } from '../agentloop.ts';
import type { LlmService, UsageSnapshot } from './llm.ts';
import { usageDelta } from './llm.ts';
import type { ToolDef, ChatMessage, ChatRef, LLMRequestContext } from '../types.ts';
import { newId, nowMs, truncate } from '../util/misc.ts';
import { busEvents } from '../bus.ts';

/**
 * WorkRunner：chat 模型 → work 模型的委派执行器。
 *
 * 职责边界：
 *  - 用 **work 模型链**（llm.workChain，空则跟随 llm.chatChain）跑一个独立的 agent loop；
 *  - 工具面由调用方给定（work 专属：容器 Python/浏览器/shell/文件）；
 *  - 轮次无上限（用户定稿）：work 语境由 ctx.workTurn 驱动 AgentLoop 无预算模式；
 *  - 全过程向 bus 发事件（work.start/step/tool/done/error），桌面端「工作」页实时展示；
 *  - 返回结构化结果（摘要 + 产物路径），交给 chat 模型做人格化转述。
 *
 * 一次 run = 一个任务。不驻留状态（子代理语义）。
 */

export interface WorkRunInput {
  chat: ChatRef;
  task: string;
  /** 发起者（审计与展示） */
  userId: string;
  nickname?: string;
  role: string;
  /** work 语境的 system（由 work 插件提供，保证与工具面一致） */
  system: string;
  tools: ToolDef[];
  /** 触发来源：目前仅 /work 命令（chat 模型不自主委派，用户定稿） */
  trigger: 'command';
  abort?: AbortSignal;
}

export interface WorkRunResult {
  id: string;
  ok: boolean;
  summary: string;          // 给 chat 模型转述用的结论
  rounds: number;
  toolCalls: number;
  durationMs: number;
  artifacts: string[];      // 会话沙箱内的产物路径（从工具调用里提取）
  error?: string;
  model: string;
  /** 本次任务的 token 账（work 侧栏显示缓存命中） */
  usage?: UsageSnapshot;
}

/** 一次 run 的内存记录：字符串步骤（老 UI/产物提取）+ 结构化事件（侧栏 loop 视图） */
interface RunRecord extends WorkRunResult {
  task: string; chatKey: string; startedAt: number; steps: string[]; events: LoopEvent[];
}

export class WorkRunner {
  private runs = new Map<string, RunRecord>();

  constructor(
    private agentLoop: AgentLoop,
    private llm: LlmService,
    private bus: Bus,
    private db: Db,
    private config: ConfigStore,
    private errors: ErrorCenter,
  ) {}

  /** 当前 work 模型标识（桌面端展示"chat 用 A，work 用 B"） */
  workModelLabel(): string {
    return this.llm.servingLabel('work');
  }

  async run(input: WorkRunInput): Promise<WorkRunResult> {
    const id = newId('work_');
    const startedAt = nowMs();
    const model = this.workModelLabel();
    const chatKey = `${input.chat.type}_${input.chat.chatId}`;

    const rec = { id, task: input.task, chatKey, startedAt, steps: [] as string[], model, events: [] as LoopEvent[] };
    this.runs.set(id, { ...rec, ok: false, summary: '', rounds: 0, toolCalls: 0, durationMs: 0, artifacts: [] });
    this.bus.emit(busEvents.workStart, { id, chatKey, task: truncate(input.task, 200), model, trigger: input.trigger, userId: input.userId });
    this.persist('start', rec, input);

    // 出发前记一笔会话 token 账，跑完相减 = 这次任务自己的消耗与缓存命中
    const usageBefore = this.llm.usageSnapshot(input.chat.chatId);
    const track = (ev: LoopEvent) => {
      const r = this.runs.get(id);
      if (r) r.events.push(ev);
      this.bus.emit(busEvents.workEvent, { id, chatKey, ev });
    };

    try {
      const ctx: LLMRequestContext = {
        chat: input.chat,
        event: { platform: input.chat.platform, type: input.chat.type, chatId: input.chat.chatId, userId: input.userId, nickname: input.nickname, text: input.task, role: input.role } as any,
        system: input.system,
        messages: [{ role: 'user', content: input.task } as ChatMessage],
        tools: input.tools,
        workTurn: true,
        workTask: input.task,
      };

      const { reply, rounds, toolCalls, steps } = await this.agentLoop.run(ctx, {
        chatKey,
        abort: input.abort,
        // 轮次无上限（用户定稿）：work 语境由 ctx.workTurn 驱动 AgentLoop 的无预算模式，
        // 不再传 maxRounds。中断仍可用（abort 由桌面端/打断按钮触发）。
        chain: 'work',
        // 每一步（工具调用）推给桌面端
        onStep: (s) => {
          const r = this.runs.get(id);
          if (r) r.steps.push(s);
          this.bus.emit(busEvents.workStep, { id, chatKey, step: s });
        },
        // 结构化事件：侧栏按轮次画 thinking / 工具调用 / 工具结果
        onEvent: track,
      });

      const artifacts = extractArtifacts(steps);
      const result: WorkRunResult = {
        id, ok: true, summary: reply.trim(), rounds, toolCalls,
        durationMs: nowMs() - startedAt, artifacts, model,
        usage: usageDelta(usageBefore, this.llm.usageSnapshot(input.chat.chatId)),
      };
      const r = this.runs.get(id);
      if (r) Object.assign(r, result, { steps });
      this.bus.emit(busEvents.workDone, { id, chatKey, summary: truncate(result.summary, 400), rounds, toolCalls, durationMs: result.durationMs, artifacts, model });
      this.persist('done', rec, input, result);
      return result;
    } catch (e) {
      const err = (e as Error).message;
      const result: WorkRunResult = {
        id, ok: false, summary: '', rounds: 0, toolCalls: 0,
        durationMs: nowMs() - startedAt, artifacts: [], error: err, model,
        usage: usageDelta(usageBefore, this.llm.usageSnapshot(input.chat.chatId)),
      };
      const r = this.runs.get(id);
      if (r) Object.assign(r, result);
      this.errors.record('warn', 'sandbox', `work 任务失败: ${err}`, { chatId: input.chat.chatId });
      this.bus.emit(busEvents.workError, { id, chatKey, error: err, model });
      this.persist('error', rec, input, result);
      return result;
    }
  }

  /** 最近的任务记录（桌面端「工作」页）；chatKey 给了就只回该会话的（会话页右侧「工作」抽屉） */
  list(limit = 30, chatKey?: string): any[] {
    return [...this.runs.values()]
      .filter((r) => !chatKey || r.chatKey === chatKey)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((r) => ({
        id: r.id, chatKey: r.chatKey, task: truncate(r.task, 200), model: r.model,
        ok: r.ok, summary: truncate(r.summary, 500), error: r.error,
        rounds: r.rounds, toolCalls: r.toolCalls, durationMs: r.durationMs,
        artifacts: r.artifacts, startedAt: r.startedAt, steps: r.steps.slice(-30),
        usage: r.usage,
        // 侧栏 loop 视图要按轮次分组，给全量事件（单次任务的事件量很小）
        events: r.events,
      }));
  }

  get(id: string): any | undefined {
    return this.list(200).find((r) => r.id === id);
  }

  private persist(phase: string, rec: any, input: WorkRunInput, result?: WorkRunResult): void {
    try {
      this.db.run(
        `INSERT INTO work_runs (id, chat_key, task, model, trigger, phase, ok, rounds, tool_calls, duration_ms, summary, error, user_id, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, ok=excluded.ok, rounds=excluded.rounds,
           tool_calls=excluded.tool_calls, duration_ms=excluded.duration_ms, summary=excluded.summary, error=excluded.error, ts=excluded.ts`,
        rec.id, rec.chatKey, truncate(input.task, 1000), rec.model, input.trigger, phase,
        result?.ok ? 1 : 0, result?.rounds ?? 0, result?.toolCalls ?? 0, result?.durationMs ?? 0,
        truncate(result?.summary ?? '', 4000), result?.error ?? null, input.userId, nowMs(),
      );
    } catch { /* 表缺失等不影响主流程 */ }
  }
}

/** 从工具调用步骤文本里提取产物路径（沙箱内文件），供聊天侧提示/发送 */
export function extractArtifacts(steps: string[]): string[] {
  const out = new Set<string>();
  for (const s of steps) {
    for (const m of s.matchAll(/(?:写入|已写入|saved|wrote)\s+([^\s（(]+\.\w{1,8})/gi)) out.add(m[1]);
    for (const m of s.matchAll(/([A-Za-z0-9_\-./]+\.(?:png|jpg|jpeg|csv|xlsx|md|txt|json|pdf|html|py|js))/g)) out.add(m[1]);
  }
  return [...out].slice(0, 20);
}