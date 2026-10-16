import type { Bus } from '../bus.ts';
import type { Db } from '../db.ts';
import type { ConfigStore } from '../config.ts';
import type { ErrorCenter } from '../errors.ts';
import type { AgentLoop, LoopEvent } from '../agentloop.ts';
import type { LlmService, UsageSnapshot } from './llm.ts';
import { usageDelta } from './llm.ts';
import type { SandboxService } from './sandbox.ts';
import type { ToolDef, ChatMessage, ChatRef, LLMRequestContext, WorkAgentDef } from '../types.ts';
import { newId, nowMs, truncate } from '../util/misc.ts';
import { busEvents } from '../bus.ts';
import { buildWorkSections, parseWorkHandoff } from '../work-prompt.ts';
import { DEFAULT_WORK_AGENT } from '../work-agent.ts';

/**
 * WorkRunner：work 子代理的执行器。
 *
 * 职责边界（pi 的 subagent 语义）：
 *  - 用 **work 模型链**（llm.workChain，独立于聊天链；空 = /work 没有可用模型）跑一个隔离上下文的 agent loop；
 *  - system 由「work agent 定义 + 内核具名分节」组装，工具面来自 agent 定义的白名单；
 *  - 轮次无上限（用户定稿）；上下文超窗时按 pi 的口径压缩；
 *  - 插件可通过 beforeWorkLLM 追加自己的节（与 chat 的 beforeLLM 是两条独立链）；
 *  - 全过程向 bus 发事件（work.start/step/tool/done/error），桌面端「工作」页实时展示；
 *  - 返回结构化结果（摘要 + 产物路径），交给 chat 模型做人格化转述。
 *
 * 一次 run = 一个任务。不驻留状态：上下文不跨 run 保留，产物留在会话沙箱里，
 * 而"停下来提问 → 管理员回答后接着干"靠任务描述交接（见 work-prompt 的 composeContinueTask）。
 */

export interface WorkRunInput {
  chat: ChatRef;
  task: string;
  /**
   * 界面上显示的任务名（缺省用 task）。
   * 续接上一次提问时 task 是一段拼接文本（含上次的问题与这次的回答），展示与落库用这个短名更清楚。
   */
  taskLabel?: string;
  /** 发起者（审计与展示） */
  userId: string;
  nickname?: string;
  role: string;
  /** 生效的 work 子代理定义（内核按它组 system；缺省用内核兜底） */
  agent?: WorkAgentDef;
  /** 本轮的 work 工具（已按 agent.tools 白名单 + 角色 + 本群开关筛过） */
  tools: ToolDef[];
  /** 触发来源：/work 命令（管理员）或上一层 work 子代理的 delegate 工具 */
  trigger: 'command' | 'subagent';
  /** 嵌套深度：入口 0，子代理逐层 +1（决定工具面里还有没有 delegate） */
  depth?: number;
  /** 发起这次委派的父运行 id（桌面端表达嵌套，不参与执行） */
  parentId?: string;
  /** 可委派的子代理清单（调用方从注册表取；只在工具面里有 delegate 时进 prompt） */
  subagents?: { name: string; description: string; tools?: string[]; source?: string }[];
  /** 群名（会话节展示用） */
  groupTitle?: string;
  /** work 轮的插件钩子链（beforeWorkLLM）；缺省不跑 */
  runHooks?: (req: LLMRequestContext) => Promise<LLMRequestContext>;
  abort?: AbortSignal;
}

export interface WorkRunResult {
  id: string;
  ok: boolean;
  summary: string;          // 给 chat 模型转述用的结论
  rounds: number;
  toolCalls: number;
  durationMs: number;
  artifacts: string[];      // 会话沙箱内的产物路径
  /** 模型按交付格式写的「备注」一节（没有则为空） */
  notes?: string;
  /** 是否解析到了结构化交付格式（false = 全文当结论用） */
  structured?: boolean;
  /**
   * 这次不是"干完了"，而是停下来等发起者回答（work_ask）。
   * 与 ok 不冲突：ok=false 指跑挂了，awaiting 指跑通了但要人来拍板。
   */
  awaiting?: { question: string; notes?: string };
  error?: string;
  model: string;
  /** 本次任务的 token 账（work 侧栏显示缓存命中） */
  usage?: UsageSnapshot;
}

/** 一次 run 的内存记录：字符串步骤（老 UI）+ 结构化事件（侧栏 loop 视图） */
interface RunRecord extends WorkRunResult {
  task: string; chatKey: string; startedAt: number; steps: string[]; events: LoopEvent[];
  depth: number; parentId?: string; agentName: string;
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
    private sandbox: SandboxService,
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

    const depth = input.depth ?? 0;
    const agentName = (input.agent ?? DEFAULT_WORK_AGENT).name;
    const taskLabel = input.taskLabel ?? input.task;
    const rec = { id, task: taskLabel, chatKey, startedAt, steps: [] as string[], model, events: [] as LoopEvent[], depth, parentId: input.parentId, agentName };
    this.runs.set(id, { ...rec, ok: false, summary: '', rounds: 0, toolCalls: 0, durationMs: 0, artifacts: [] });
    this.bus.emit(busEvents.workStart, { id, chatKey, task: truncate(taskLabel, 200), model, trigger: input.trigger, userId: input.userId, depth, parentId: input.parentId, agent: agentName });
    this.persist('start', rec, input);

    // 出发前记一笔会话 token 账，跑完相减 = 这次任务自己的消耗与缓存命中
    const usageBefore = this.llm.usageSnapshot(input.chat.chatId);
    /** 结构化产物：工具通过 ToolMeta.artifacts 上报（比正则扫步骤文本可靠） */
    const metaArtifacts = new Set<string>();
    /** 「停下来提问」：同样从工具 meta 来（work_ask），比在文本里认标记可靠 */
    let metaAsk: { question: string; notes?: string } | undefined;
    const track = (ev: LoopEvent) => {
      const r = this.runs.get(id);
      if (r) r.events.push(ev);
      if (ev.kind === 'toolResult') {
        for (const a of ev.meta?.artifacts ?? []) metaArtifacts.add(a.replace(/\\/g, '/'));
        if (ev.meta?.awaiting) {
          const q = String(ev.meta.question ?? '').trim();
          if (q) metaAsk = { question: q, notes: ev.meta.notes ? String(ev.meta.notes) : undefined };
        }
      }
      this.bus.emit(busEvents.workEvent, { id, chatKey, ev });
    };

    try {
      const agent = input.agent ?? DEFAULT_WORK_AGENT;
      // 子代理清单：只在 delegate 真在本轮工具面里时才给 prompt（否则等于教模型用一个不存在的工具）
      const subagents = input.tools.some((t) => t.name === 'delegate') ? (input.subagents ?? []) : [];
      // system = 「work agent 定义（preamble）+ 内核具名分节」；插件可在 beforeWorkLLM 里追加节
      const built = buildWorkSections({
        agent,
        type: input.chat.type,
        chatId: input.chat.chatId,
        groupTitle: input.groupTitle ?? '',
        nickname: input.nickname,
        userId: input.userId,
        role: input.role,
        task: input.task,
        tools: input.tools,
        sandboxRoot: this.sandbox.root(input.chat),
        trigger: input.trigger,
        depth,
        subagents,
      });
      let ctx: LLMRequestContext = {
        chat: input.chat,
        event: { platform: input.chat.platform, type: input.chat.type, chatId: input.chat.chatId, userId: input.userId, nickname: input.nickname, text: input.task, role: input.role } as any,
        system: built.system,
        systemSections: built.sections,
        messages: [{ role: 'user', content: input.task } as ChatMessage],
        tools: input.tools,
        workTurn: true,
        workTask: input.task,
        workAgent: agent,
        workTrigger: input.trigger === 'subagent' ? undefined : input.trigger,
        workDepth: depth,
        workRunId: id,
      };
      if (input.runHooks) ctx = await input.runHooks(ctx);

      const { reply, rounds, toolCalls, steps } = await this.agentLoop.run(ctx, {
        chatKey,
        abort: input.abort,
        // 轮次：由 work agent 定义的 max_rounds 决定（0/缺省 = 无上限，用户定稿的 work 语义）；
        // 模型链：由 agent 定义决定（缺省 work；子代理可声明 chain: chat）
        chain: agent.chain ?? 'work',
        // 每一步（工具调用）推给桌面端
        onStep: (s) => {
          const r = this.runs.get(id);
          if (r) r.steps.push(s);
          this.bus.emit(busEvents.workStep, { id, chatKey, step: s });
        },
        // 结构化事件：侧栏按轮次画 thinking / 工具调用 / 工具结果 / 压缩
        onEvent: track,
      });

      // 结论与产物：优先用交付格式里的结构化字段，解析不到就回落到全文 + 正则兜底
      const handoff = parseWorkHandoff(reply);
      const artifacts = handoff.structured && handoff.artifacts.length
        ? dedupe([...handoff.artifacts, ...metaArtifacts])
        : dedupe([...metaArtifacts, ...extractArtifacts(steps)]);
      // 停下来提问：结论就是那个问题（交付文本里的「## 待确认/## 已做到」只是留给人读的）
      const ask = metaAsk as { question: string; notes?: string } | undefined;
      // 模型链一整轮什么都没吐（没接模型/额度耗尽/链全挂被吞成空流）：判成失败，
      // 不能给 ok:true 的空摘要让转述轮把"空结果"当完成讲出去。轮次与工具账都还在，一并保留。
      if (!ask && !reply.trim()) {
        const err = '模型链没有返回任何内容（请检查模型接入与额度）';
        const result: WorkRunResult = {
          id, ok: false, summary: '', rounds, toolCalls,
          durationMs: nowMs() - startedAt, artifacts, error: err, model,
          usage: usageDelta(usageBefore, this.llm.usageSnapshot(input.chat.chatId)),
        };
        const r = this.runs.get(id);
        if (r) Object.assign(r, result, { steps });
        this.errors.record('warn', 'sandbox', `work 任务失败: ${err}`, { chatId: input.chat.chatId });
        this.bus.emit(busEvents.workError, { id, chatKey, error: err, model });
        this.persist('error', rec, input, result);
        return result;
      }
      const result: WorkRunResult = {
        id, ok: true,
        summary: ask ? ask.question : (handoff.summary.trim() || reply.trim()),
        rounds, toolCalls, durationMs: nowMs() - startedAt, artifacts, model,
        notes: (ask?.notes || handoff.notes) || undefined, structured: handoff.structured,
        awaiting: ask,
        usage: usageDelta(usageBefore, this.llm.usageSnapshot(input.chat.chatId)),
      };
      const r = this.runs.get(id);
      if (r) Object.assign(r, result, { steps });
      this.bus.emit(busEvents.workDone, { id, chatKey, summary: truncate(result.summary, 400), rounds, toolCalls, durationMs: result.durationMs, artifacts, model, depth, parentId: input.parentId, agent: agentName, awaiting: ask ? true : false, question: ask?.question });
      this.persist(ask ? 'await' : 'done', rec, input, result);
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
        agent: r.agentName, depth: r.depth, parentId: r.parentId,
        ok: r.ok, summary: truncate(r.summary, 500), error: r.error,
        rounds: r.rounds, toolCalls: r.toolCalls, durationMs: r.durationMs,
        artifacts: r.artifacts, startedAt: r.startedAt, steps: r.steps.slice(-30),
        notes: r.notes, structured: r.structured, awaiting: r.awaiting,
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

/**
 * 正则兜底：模型没按交付格式登记产物时，从步骤文本里捞路径。
 * 正常路径是工具通过 ToolMeta.artifacts 上报 + 交付格式的「产物」一节，这里只保底。
 */
export function extractArtifacts(steps: string[]): string[] {
  const out = new Set<string>();
  for (const s of steps) {
    for (const m of s.matchAll(/(?:写入|已写入|saved|wrote)\s+([^\s（(]+\.\w{1,8})/gi)) out.add(m[1]);
    for (const m of s.matchAll(/([A-Za-z0-9_\-./]+\.(?:png|jpg|jpeg|csv|xlsx|md|txt|json|pdf|html|py|js))/g)) out.add(m[1]);
  }
  return [...out].slice(0, 20);
}

/** 去重（保序），并把反斜杠归一成正斜杠——沙箱相对路径统一用 / */
function dedupe(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const p = raw.trim().replace(/\\/g, '/');
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.slice(0, 30);
}