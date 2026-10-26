import type { Bus } from '../bus.ts';
import type { Db } from '../db.ts';
import type { ConfigStore } from '../config.ts';
import type { ErrorCenter } from '../errors.ts';
import type { AgentLoop, LoopEvent } from '../agentloop.ts';
import { WORK_IDLE_REMIND_LIMIT } from '../agentloop.ts';
import type { LlmService, UsageSnapshot } from './llm.ts';
import { usageDelta } from './llm.ts';
import type { SandboxService } from './sandbox.ts';
import type { ToolDef, ChatMessage, ChatRef, LLMRequestContext, MessageAttachment, WorkAgentDef, WorkLiveStatus } from '../types.ts';
import { newId, nowMs, clip } from '../util/misc.ts';
import { busEvents } from '../bus.ts';
import { buildWorkSections, parseWorkHandoff, type PendingAsk } from '../work-prompt.ts';
import { DEFAULT_WORK_AGENT } from '../work-agent.ts';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { ARTIFACT_SKIP_DIRS, ARTIFACT_SKIP_FILE, isDeliverableArtifact } from './artifacts.ts';

/**
 * WorkRunner：work 子代理的执行器。
 *
 * 职责边界（pi 的 subagent 语义）：
 *  - 用 **work 模型链**（llm.workChain，独立于聊天链；空 = 派活没有可用模型）跑一个隔离上下文的 agent loop；
 *  - system 由「work agent 定义 + 内核具名分节」组装，工具面来自 agent 定义的白名单；
 *  - 轮次无上限（用户定稿）；上下文超窗时按 pi 的口径压缩；
 *  - 插件可通过 beforeWorkLLM 追加自己的节（与 chat 的 beforeLLM 是两条独立链）；
 *  - 全过程向 bus 发事件（work.start/step/tool/done/error），桌面端「工作」页实时展示；
 *  - 返回结构化结果（摘要 + 产物路径），交给 chat 模型做人格化转述。
 *
 * 一次 run = 一个任务。不驻留状态：上下文不跨 run 保留，产物留在会话沙箱里，
 * 而"停下来提问 → 发起人回答后接着干"靠任务描述交接（见 work-prompt 的 composeContinueTask）。
 * 「谁的活」按 `chatKey + userId` 记：同群每个人的进度/待回答互不可见。
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
  /**
   * 触发来源：chat 面的 work_dispatch 工具（新的唯一入口）、旧命令入口（仅测试/内部使用），
   * 或上一层 work 子代理的 delegate 工具。
   */
  trigger: 'chat' | 'command' | 'subagent';
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
  /** 纯文字轮的提醒等待毫秒（缺省 60s）。测试专用钩子，正常调用不传。 */
  idleRemindMs?: number;
  /**
   * 续接任务时沿用旧任务的沙箱 ref（2026-10-25 任务隔离改版）。缺省 = 新任务新沙箱
   * （`private_u{userId}__t{runId}`）；子代理委派不传它——父层已把任务 ref 放进 input.chat。
   */
  sandboxRef?: ChatRef;
  /** 随任务交给 work 的附件（用户这一轮发的图片）：挂在 work 第一轮的最后一条 user 消息上 */
  attachments?: MessageAttachment[];
}

export interface WorkRunResult {
  id: string;
  ok: boolean;
  /** 任务沙箱键（汇报轮发产物要回这份沙箱取文件；2026-10-25 任务隔离） */
  sandboxKey?: string;
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
  /** 任务沙箱键（private_u{userId}__t{taskId}；续接时沿用上一个任务的键）。老记录/降级时缺省 */
  sandboxKey?: string;
  depth: number; parentId?: string; agentName: string;
  /** 发起者：同一聊天里每个人是独立的 work 会话（沙箱/容器也按人分开） */
  userId: string; nickname?: string;
  /** 生命周期：只有 running 才算「正在跑」（await 是停下来等人回答） */
  phase: 'running' | 'done' | 'await' | 'error';
  finishedAt?: number;
}

/** 「停下来提问」等回答的有效期：超过这么久，旧问题不再自动接续 */
const PENDING_WORK_TTL_MS = 30 * 60_000;

/**
 * work 会话的作用域键：同一个群里每位发起人各有一套 work 现场。
 *
 * 为什么不用「聊天 + 发起人」当 chatKey：会话流、待答复现场、桌面端抽屉都按聊天聚合，
 * 拆开会让"这个群最近的工作"看不全。这里只把**执行面**（沙箱目录 / 常驻容器）按人分开，
 * 列表仍按聊天取、由界面按发起人分组。
 */
/**
 * 沙箱键 → ChatRef。兼容两种键：任务键（`private_u{userId}__t{taskId}`）与
 * 旧式按人键（`group_x__uY` / `private_x__uY`，2026-10-25 任务隔离改版前的运行落的就是它）。
 * 解析不了返回 undefined（调用方自行降级）。
 */
export function sandboxRefOfKey(key: string): ChatRef | undefined {
  const m = key.match(/^(group|private)_(.+?)__(.+)$/);
  if (!m) return undefined;
  return { platform: 'qq', type: m[1] as 'group' | 'private', chatId: m[2], scope: m[3] };
}

export function workScopeOf(userId: string): string {
  return `u${String(userId || '0').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 40)}`;
}

/** 补扫产物时跳过的目录/文件与投递链路共用同一口径（见 services/artifacts.ts） */
const ARTIFACT_MAX_FILES = 80;
const ARTIFACT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const ARTIFACT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/**
 * work 产物补扫：模型常用 run_bash/Python 直接写文件，这条路径不会经过 `sandbox_write`
 * 的 ToolMeta.artifacts，导致 `work_finish` 没登记时交付清单是空的（2026-10-23 论文任务就是
 * 这样：paper.tex/图/CSV 都在沙箱里，报告只带了两个技能文件）。
 *
 * 只收本次 run 期间新增/修改的文件（留 5 分钟余量），排除收件箱、技能、缓存与内部预览页；
 * 按路径排序、限 80 个/单文件 50MB/总计 200MB，避免把整个工作目录打包进转发。
 */
export function collectRecentArtifacts(root: string, startedAt: number): string[] {
  const found: { rel: string; size: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.')) continue; // .skills / .git / 隐藏文件
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        // `_` 前缀目录与同名文件同口径（_dev/_plan 一类是模型的内部工作区，不是交付物；
        // 2026-10-25 Three.js 任务把 17 个 _dev/p_*.html 迭代预览页全扫进了交付清单）
        if (name.startsWith('_') || ARTIFACT_SKIP_DIRS.has(name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!st.isFile() || st.size <= 0) continue;
      if (ARTIFACT_SKIP_FILE.test(name) || name.startsWith('_')) continue;
      if (st.mtimeMs < startedAt - 5 * 60_000) continue;
      if (st.size > ARTIFACT_MAX_FILE_BYTES) continue;
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..')) continue;
      found.push({ rel, size: st.size });
    }
  };
  walk(root, 0);
  found.sort((a, b) => a.rel.localeCompare(b.rel));
  const out: string[] = [];
  let total = 0;
  for (const f of found) {
    if (out.length >= ARTIFACT_MAX_FILES) break;
    if (total + f.size > ARTIFACT_MAX_TOTAL_BYTES) continue;
    total += f.size;
    out.push(f.rel);
  }
  return out;
}

export class WorkRunner {
  private runs = new Map<string, RunRecord>();
  /** 「停下来提问」现场：key = chatKey|userId（同群两个人各自的问题互不接管） */
  private pending = new Map<string, PendingAsk>();
  /** 并发 work 的模型槽：每个槽记正在跑的任务数，分配时挑最空的（3 个任务 → 3 个不同模型） */
  private slotBusy = new Map<number, number>();
  private slotCursor = 0;

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

  /** 领一个并发槽：优先最空的槽，平手时按游标轮转；任务结束必须 release */
  private acquireWorkSlot(): number {
    const len = Math.max(1, this.llm.chainConfig('work').length);
    let best = 0;
    let bestCount = Infinity;
    for (let i = 0; i < len; i++) {
      const idx = (this.slotCursor + i) % len;
      const c = this.slotBusy.get(idx) ?? 0;
      if (c < bestCount) { best = idx; bestCount = c; }
    }
    this.slotBusy.set(best, (this.slotBusy.get(best) ?? 0) + 1);
    this.slotCursor = (best + 1) % len;
    return best;
  }

  private releaseWorkSlot(slot: number): void {
    const n = (this.slotBusy.get(slot) ?? 0) - 1;
    if (n > 0) this.slotBusy.set(slot, n);
    else this.slotBusy.delete(slot);
  }

  // 2026-10-25 任务隔离改版：任务空间跟人走（无群聊层），提问现场也只按人记——
  // 用户在哪个会话里回答都能接回去
  private pendingKey(userId: string): string {
    return userId;
  }

  /** 取出并消费这个人等回答的现场；过期视为没有。一次派活只接一条。 */
  takePending(userId: string): PendingAsk | undefined {
    const key = this.pendingKey(userId);
    const p = this.pending.get(key);
    if (!p) return undefined;
    this.pending.delete(key);
    return Date.now() - p.at > PENDING_WORK_TTL_MS ? undefined : p;
  }

  /** 只读：还在有效期内、停下来等回答的那件事（chat 侧提醒 / work_status 用） */
  livePending(userId: string): PendingAsk | undefined {
    const p = this.pending.get(this.pendingKey(userId));
    return p && Date.now() - p.at <= PENDING_WORK_TTL_MS ? p : undefined;
  }

  async run(input: WorkRunInput): Promise<WorkRunResult> {
    const id = newId('work_');
    const startedAt = nowMs();
    const agent = input.agent ?? DEFAULT_WORK_AGENT;
    const chainKind = agent.chain ?? 'work';
    // 并发的 work 任务轮流领不同的链上下标；每个任务仍从自己的槽起绕完整条替代链
    const slot = chainKind === 'work' ? this.acquireWorkSlot() : 0;
    const model = chainKind === 'work' ? this.llm.modelAt('work', slot) : this.llm.servingLabel('chat');
    try {
    const chatKey = `${input.chat.type}_${input.chat.chatId}`;
    /**
     * 执行面 = 任务隔离（2026-10-25 用户定）：用户层（`private_u{userId}`，跨群/跨私聊同一份）
     * 之上每个任务一份独立沙箱；群聊不再是一层隔离。汇报/落库/桌面端仍按聊天聚合（chatKey）。
     * - 新任务：现发 `private_u{userId}__t{runId}`，谁也看不到别的任务的文件；
     * - 续接（input.sandboxRef 由 dispatch/resume 带来）沿用旧任务的同一份沙箱；
     * - 子代理委派：父层已把任务 ref 放进 input.chat（scope 以 t 开头），直接沿用。
     */
    const chat: ChatRef = input.sandboxRef
      ?? (input.chat.scope && input.chat.scope.startsWith('t')
        ? input.chat
        : { platform: input.chat.platform, type: 'private', chatId: `u${input.userId}`, scope: `t${id.replace(/^work_/, '')}` });
    const sandboxKey = this.sandbox.chatKey(chat);
    // 群聊收到的文件落在聊天级 inbox：开跑前镜像进本任务沙箱，模型照旧用 inbox/xxx 读取
    try { this.sandbox.syncInbox(input.chat, chat); } catch { /* 镜像失败不阻断任务 */ }

    const depth = input.depth ?? 0;
    const agentName = (input.agent ?? DEFAULT_WORK_AGENT).name;
    const taskLabel = input.taskLabel ?? input.task;
    /** 汇报轮的投递目标：**聊天级**（不带 scope），由内核在收尾后另起一轮人格化汇报 */
    const reportChat = { platform: input.chat.platform, type: input.chat.type, chatId: input.chat.chatId };
    const rec = {
      id, task: taskLabel, chatKey, sandboxKey, startedAt, steps: [] as string[], model, events: [] as LoopEvent[],
      depth, parentId: input.parentId, agentName, userId: input.userId, nickname: input.nickname,
    };
    this.runs.set(id, { ...rec, ok: false, summary: '', rounds: 0, toolCalls: 0, durationMs: 0, artifacts: [], phase: 'running' });
    this.bus.emit(busEvents.workStart, {
      // 任务原样下发：chat → work 没有字数上限（2026-10-23 用户明令），桌面端按完整原文显示
      id, chatKey, task: taskLabel, model, trigger: input.trigger, chat: reportChat,
      userId: input.userId, nickname: input.nickname, depth, parentId: input.parentId, agent: agentName,
    });
    this.persist('start', rec, input);

    // 出发前记一笔会话 token 账，跑完相减 = 这次任务自己的消耗与缓存命中
    const usageBefore = this.llm.usageSnapshot(input.chat.chatId);
    /** 结构化产物：工具通过 ToolMeta.artifacts 上报（比正则扫步骤文本可靠） */
    const metaArtifacts = new Set<string>();
    /** 「停下来提问」：同样从工具 meta 来（work_ask），比在文本里认标记可靠 */
    let metaAsk: { question: string; notes?: string } | undefined;
    const track = (ev: LoopEvent) => {
      // 流式增量只走实时总线（桌面端边生成边显示），不落内存/数据库：
      // message_end 会送完整的 thinking / text，收尾记录里不需要再存几百个碎片
      if (ev.kind !== 'delta' && ev.kind !== 'thinkingDelta') {
        const r = this.runs.get(id);
        if (r) {
          r.events.push(ev);
          // 运行中的计数：work_status 要能实时说「第几轮 / 几次工具调用」，不能等收尾才更新
          if (ev.kind === 'round') r.rounds = ev.n;
          if (ev.kind === 'tool') r.toolCalls++;
        }
      }
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
      // 子代理清单：只在 delegate 真在本轮工具面里时才给 prompt（否则等于教模型用一个不存在的工具）
      const subagents = input.tools.some((t) => t.name === 'delegate') ? (input.subagents ?? []) : [];
      // system = 「work agent 定义（preamble）+ 内核具名分节」；插件可在 beforeWorkLLM 里追加节
      const built = buildWorkSections({
        agent,
        type: reportChat.type,
        chatId: reportChat.chatId,
        groupTitle: input.groupTitle ?? '',
        nickname: input.nickname,
        userId: input.userId,
        role: input.role,
        task: input.task,
        tools: input.tools,
        sandboxRoot: this.sandbox.root(chat),
        trigger: input.trigger,
        depth,
        subagents,
      });
      let ctx: LLMRequestContext = {
        chat,
        reportChat,
        event: { platform: reportChat.platform, type: reportChat.type, chatId: reportChat.chatId, userId: input.userId, nickname: input.nickname, text: input.task, role: input.role } as any,
        system: built.system,
        systemSections: built.sections,
        messages: [{ role: 'user', content: input.task } as ChatMessage],
        attachments: input.attachments,
        tools: input.tools,
        workTurn: true,
        workTask: input.task,
        workAgent: agent,
        workTrigger: input.trigger === 'subagent' ? undefined : input.trigger,
        workDepth: depth,
        workRunId: id,
        workSlot: chainKind === 'work' ? slot : undefined,
      };
      if (input.runHooks) ctx = await input.runHooks(ctx);

      const { reply, rounds, toolCalls, steps, finished } = await this.agentLoop.run(ctx, {
        chatKey,
        abort: input.abort,
        // 轮次：work 轮不设上限（2026-10-23 用户定）；agent 定义里的 max_rounds 不再参与截断
        // 模型链：由 agent 定义决定（缺省 work；子代理可声明 chain: chat）
        chain: agent.chain ?? 'work',
        // 纯文字轮的提醒等待（缺省 60s；测试调小）
        workIdleRemindMs: input.idleRemindMs,
        // 每一步（工具调用）推给桌面端
        onStep: (s) => {
          const r = this.runs.get(id);
          if (r) r.steps.push(s);
          this.bus.emit(busEvents.workStep, { id, chatKey, step: s });
        },
        // 结构化事件：侧栏按轮次画 thinking / 工具调用 / 工具结果 / 压缩
        onEvent: track,
      });

      // 结论与产物：优先用交付格式里的结构化字段，解析不到就回落到全文 + 正则兜底；
      // 最后再补扫沙箱——模型常用 run_bash/Python 直接写文件，不会经过 sandbox_write 的 artifact 回执。
      const handoff = parseWorkHandoff(reply);
      const sandboxRoot = this.sandbox.root(chat);
      const scanned = collectRecentArtifacts(sandboxRoot, startedAt);
      const artifacts = handoff.structured && handoff.artifacts.length
        ? dedupe([...handoff.artifacts, ...metaArtifacts, ...scanned])
        : dedupe([...metaArtifacts, ...extractArtifacts(steps, sandboxRoot), ...scanned]);
      // 停下来提问：结论就是那个问题（交付文本里的「## 待确认/## 已做到」只是留给人读的）
      const ask = metaAsk as { question: string; notes?: string } | undefined;
      // 两种"不是成功"的结局（2026-10-25 用户定：强制 work_finish 才算完成）：
      //  1. 模型链一整轮什么都没吐（没接模型/额度耗尽/链全挂被吞成空流）；
      //  2. 提醒满限仍只发文字、没调 work_finish / work_ask——按未完成处理，
      //     不能给 ok:true 让转述轮把一句旁白当"做完了"讲出去。轮次与工具账都保留。
      const unfinished = !finished && !ask && !input.abort?.aborted && reply.trim().length > 0;
      if (!ask && (!reply.trim() || unfinished)) {
        const err = !reply.trim()
          ? '模型链没有返回任何内容（请检查模型接入与额度）'
          : `模型连续 ${WORK_IDLE_REMIND_LIMIT} 次提醒后仍未调用 work_finish 交付，任务按未完成处理（最后输出已保留在摘要里）`;
        const result: WorkRunResult = {
          id, ok: false, sandboxKey, summary: clip(reply, 300), rounds, toolCalls,
          durationMs: nowMs() - startedAt, artifacts, error: err, model,
          usage: usageDelta(usageBefore, this.llm.usageSnapshot(input.chat.chatId)),
        };
        const r = this.runs.get(id);
        if (r) Object.assign(r, result, { steps, phase: 'error' as const, finishedAt: nowMs() });
        this.errors.record('warn', 'sandbox', `work 任务失败: ${err}`, { chatId: input.chat.chatId });
        this.bus.emit(busEvents.workError, {
          id, chatKey, error: err, model, trigger: input.trigger, chat: reportChat,
          userId: input.userId, nickname: input.nickname, role: input.role, task: taskLabel, result,
        });
        this.persist('error', rec, input, result);
        return result;
      }
      const result: WorkRunResult = {
        id, ok: true, sandboxKey,
        summary: ask ? ask.question : (handoff.summary.trim() || reply.trim()),
        rounds, toolCalls, durationMs: nowMs() - startedAt, artifacts, model,
        notes: (ask?.notes || handoff.notes) || undefined, structured: handoff.structured,
        awaiting: ask,
        usage: usageDelta(usageBefore, this.llm.usageSnapshot(input.chat.chatId)),
      };
      const r = this.runs.get(id);
      if (r) Object.assign(r, result, { steps, phase: (ask ? 'await' : 'done') as RunRecord['phase'], finishedAt: nowMs() });
      // 停下来提问：记下现场，等**同一个人**回答后接着干（子代理的提问回给父代理，不记在聊天上）
      if (ask && input.trigger !== 'subagent') {
        this.pending.set(this.pendingKey(input.userId), {
          task: input.task, label: taskLabel, question: ask.question, notes: ask.notes,
          at: nowMs(), userId: input.userId, sandboxKey,
        });
      }
      this.bus.emit(busEvents.workDone, {
        id, chatKey, sandboxKey, summary: clip(result.summary, 400), rounds, toolCalls, durationMs: result.durationMs,
        artifacts, model, depth, parentId: input.parentId, agent: agentName,
        awaiting: ask ? true : false, question: ask?.question,
        trigger: input.trigger, chat: reportChat, userId: input.userId, nickname: input.nickname,
        role: input.role, task: taskLabel, result,
      });
      this.persist(ask ? 'await' : 'done', rec, input, result);
      return result;
    } catch (e) {
      const err = (e as Error).message;
      const r = this.runs.get(id);
      // 跑挂了也要把已经写出来的文件带出去：失败报告至少能附上部分产物，
      // 不能因为最后一步模型链断了就把整场工作的文件全丢在沙箱里。
      const scanned = collectRecentArtifacts(this.sandbox.root(chat), startedAt);
      const artifacts = dedupe([...metaArtifacts, ...extractArtifacts(r?.steps ?? rec.steps, this.sandbox.root(chat)), ...scanned]);
      const result: WorkRunResult = {
        id, ok: false, sandboxKey, summary: '', rounds: r?.rounds ?? 0, toolCalls: r?.toolCalls ?? 0,
        durationMs: nowMs() - startedAt, artifacts, error: err, model,
        usage: usageDelta(usageBefore, this.llm.usageSnapshot(input.chat.chatId)),
      };
      if (r) Object.assign(r, result, { phase: 'error' as const, finishedAt: nowMs() });
      this.errors.record('warn', 'sandbox', `work 任务失败: ${err}`, { chatId: input.chat.chatId });
      this.bus.emit(busEvents.workError, {
        id, chatKey, error: err, model, trigger: input.trigger, chat: reportChat,
        userId: input.userId, nickname: input.nickname, role: input.role, task: taskLabel, result,
      });
      this.persist('error', rec, input, result);
      return result;
    }
    } finally {
      if (chainKind === 'work') this.releaseWorkSlot(slot);
    }
  }

  /**
   * 最近的任务记录（桌面端「工作」页）；chatKey 给了就只回该会话的（会话页右侧「工作」抽屉）。
   *
   * 内存只有本次内核生命周期里的运行；内核重启后回落到 work_runs 表（events/usage 一并落库），
   * 否则抽屉一重启就变成空白——圆环与缓存/TPS 全部没有数据可画（2026-10-20 用户实测）。
   */
  list(limit = 30, chatKey?: string): any[] {
    // 内存是本次内核生命周期的真实现场（含运行中与刚收尾的 notes），必须优先；
    // 只在库里补那些内存没有的老运行（重启前的）。
    const live = [...this.runs.values()]
      .filter((r) => !chatKey || r.chatKey === chatKey)
      .map((r) => this.view(r));
    const seen = new Set(live.map((r) => r.id));
    const fromDb = this.dbList(limit, chatKey).filter((r) => !seen.has(r.id));
    return [...live, ...fromDb]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  /**
   * chat 的 work_status 工具：只看**这位发起人自己**在**这个会话**里的活。
   * 在跑 → 轮次/工具调用/token 从已收到的 loop 事件实时累加（不必等收尾）；
   * 没在跑 → 给最近一次跑完的（内存优先，重启过就从库里补）。
   */
  liveStatus(userId: string): WorkLiveStatus {
    // 只看入口层（depth 0）：子代理是这件活的内部实现，不该出现在「你做的那件事」进度里。
    // 2026-10-25 任务隔离改版：任务空间跟人走，这里只按 userId 过滤（跨会话）
    const mine = [...this.runs.values()].filter(
      (r) => r.userId === userId && (r.depth ?? 0) === 0,
    );
    const now = nowMs();
    const active = mine
      .filter((r) => r.phase === 'running')
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((r) => ({
        id: r.id, task: clip(r.task, 120), startedAt: r.startedAt,
        elapsedMs: Math.max(0, now - r.startedAt), rounds: r.rounds, toolCalls: r.toolCalls,
        ...usageOfEvents(r.events), step: lastStepOf(r.events),
      }));

    const ended = mine
      .filter((r) => r.phase !== 'running')
      .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))[0];
    let last: WorkLiveStatus['last'];
    if (ended) {
      last = {
        id: ended.id, task: clip(ended.task, 120), ok: ended.ok, awaiting: !!ended.awaiting,
        durationMs: ended.durationMs, finishedAt: ended.finishedAt ?? ended.startedAt + ended.durationMs,
        summary: clip(ended.summary, 300), artifacts: ended.artifacts, error: ended.error,
      };
    } else {
      // 内核重启过：内存里没有，但那次活确实跑过 —— 从库里补最近一条（仍按 user_id 过滤）
      try {
        const row = this.db.get<any>(
          `SELECT id, task, ok, phase, summary, error, duration_ms, ts, artifacts
           FROM work_runs WHERE user_id=? AND phase IN ('done','await','error')
           ORDER BY ts DESC LIMIT 1`,
          userId,
        );
        if (row) {
          last = {
            id: row.id, task: clip(String(row.task ?? ''), 120), ok: !!row.ok,
            awaiting: row.phase === 'await', durationMs: Number(row.duration_ms ?? 0),
            finishedAt: Number(row.ts ?? 0), summary: clip(String(row.summary ?? ''), 300),
            artifacts: parseJsonArray(row.artifacts).map(String), error: row.error ?? undefined,
          };
        }
      } catch { /* 表缺失等不影响状态查询 */ }
    }

    const p = this.livePending(userId);
    // 最近任务（跨会话）：chat 模型据此判断用户要「接着旧任务」还是开新任务
    let recent: WorkLiveStatus['recent'];
    try {
      const rows = this.db.all<any>(
        `SELECT id, task, phase, ok, ts FROM work_runs
         WHERE user_id=? AND (trigger IS NULL OR trigger != 'subagent')
         ORDER BY ts DESC LIMIT 6`,
        userId,
      );
      recent = rows.map((r) => ({
        id: r.id, task: clip(String(r.task ?? ''), 60), ok: !!r.ok,
        phase: String(r.phase ?? ''), at: Number(r.ts ?? 0),
      }));
    } catch { /* 表缺失不影响 */ }
    return {
      active,
      pending: p ? { question: p.question, notes: p.notes, at: p.at } : undefined,
      last,
      recent,
    };
  }

  /** 内存记录 → 列表项（list 与 get 共用，字段口径只写一处） */
  private view(r: RunRecord): any {
    return {
      id: r.id, chatKey: r.chatKey, sandboxKey: r.sandboxKey, task: r.task, model: r.model,
      agent: r.agentName, depth: r.depth, parentId: r.parentId,
      ok: r.ok, summary: clip(r.summary, 500), error: r.error,
      rounds: r.rounds, toolCalls: r.toolCalls, durationMs: r.durationMs,
      artifacts: r.artifacts, startedAt: r.startedAt, steps: r.steps.slice(-30),
      notes: r.notes, structured: r.structured, awaiting: r.awaiting,
      usage: r.usage, userId: r.userId, nickname: r.nickname,
      // 侧栏 loop 视图要按轮次分组，给全量事件（单次任务的事件量很小）
      events: r.events,
    };
  }

  /** 落库的历史运行 → 列表项。events/usage 是 JSON 列，解析失败就当没有（老行） */
  private dbList(limit: number, chatKey?: string): any[] {
    try {
      const rows = chatKey
        ? this.db.all<any>(
            `SELECT id, chat_key, task, model, trigger, phase, ok, rounds, tool_calls, duration_ms,
                    summary, error, user_id, nickname, ts, artifacts, events, usage
             FROM work_runs WHERE chat_key=? ORDER BY ts DESC LIMIT ?`, chatKey, limit)
        : this.db.all<any>(
            `SELECT id, chat_key, task, model, trigger, phase, ok, rounds, tool_calls, duration_ms,
                    summary, error, user_id, nickname, ts, artifacts, events, usage
             FROM work_runs ORDER BY ts DESC LIMIT ?`, limit);
      return rows.map((r) => ({
        id: r.id, chatKey: r.chat_key, task: String(r.task ?? ''), model: r.model,
        agent: undefined, depth: 0, parentId: undefined,
        ok: !!r.ok, summary: clip(String(r.summary ?? ''), 500), error: r.error ?? undefined,
        rounds: Number(r.rounds ?? 0), toolCalls: Number(r.tool_calls ?? 0), durationMs: Number(r.duration_ms ?? 0),
        artifacts: parseJsonArray(r.artifacts), startedAt: Number(r.ts ?? 0), steps: [],
        notes: undefined, structured: undefined,
        // 只有 phase=await 才是"等你回答"；其余（done/error/start）不该挂这个状态
        awaiting: r.phase === 'await' ? { question: String(r.summary ?? '') } : undefined,
        usage: parseJsonObj(r.usage), userId: r.user_id ?? '', nickname: r.nickname ?? undefined,
        events: parseJsonArray(r.events),
        /** 来自库：没有 live 的 running 语义（重启前的那次已经结束了） */
        historical: true,
      }));
    } catch { return []; }
  }

  /**
   * 该会话最近一次**成功交付**的产物（chat 的 deliver_file 工具用）。
   *
   * 为什么按会话记：work 只由管理员派活，产物落在会话沙箱；chat 模型在后续对话里
   * 被要求"发给我看看"时要能找到它们——而 chat 轮的上下文里只有交付摘要，没有文件清单
   * 的可靠记忆。只认最近一次成功、且不处于 awaiting 的运行。
   *
   * 产物按**聊天**找（chatKey 不带 scope），但沙箱是按发起人分的：调用方还要给出
   * `userId`，这样才能定位到那个人自己的沙箱目录。内存里没有（内核重启过）就回落到
   * work_runs 表——那次交付确实发生过、文件也还在沙箱里。
   */
  /** 最近任务（给续接定位）：按 runId 或「最近一个」取，必须属于本人——续别人的任务等于偷沙箱 */
  runForUser(runId: string | undefined, userId: string): { id: string; task: string; sandboxKey: string | null } | undefined {
    try {
      const row = runId
        ? this.db.get<{ id: string; task: string; sandbox_key: string | null }>(
            'SELECT id, task, sandbox_key FROM work_runs WHERE id=? AND user_id=? LIMIT 1', runId, userId)
        : this.db.get<{ id: string; task: string; sandbox_key: string | null }>(
            "SELECT id, task, sandbox_key FROM work_runs WHERE user_id=? AND (trigger IS NULL OR trigger != 'subagent') ORDER BY ts DESC LIMIT 1", userId);
      if (!row) return undefined;
      return { id: row.id, task: String(row.task ?? ''), sandboxKey: row.sandbox_key ?? null };
    } catch { return undefined; }
  }

  latestArtifacts(userId: string): { runId: string; task: string; artifacts: string[]; at: number; userId: string; ok: boolean; sandboxKey?: string } | undefined {
    const hit = [...this.runs.values()]
      // 按发起人过滤（跨会话）：别人的产物一根手指都碰不到
      .filter((r) => r.userId === userId)
      // 失败/中断的活也可能已经产出文件（2026-10-23 论文任务）：有产物就能发，不再要求 ok
      .filter((r) => !r.awaiting && r.artifacts.length > 0)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (hit) {
      const artifacts = hit.artifacts.filter(isDeliverableArtifact);
      if (artifacts.length) return { runId: hit.id, task: hit.task, artifacts, at: hit.startedAt, userId: hit.userId, ok: hit.ok, sandboxKey: hit.sandboxKey };
    }
    try {
      const rows = this.db.all<{ id: string; task: string; summary: string; artifacts: string | null; ts: number; user_id: string | null; ok: number; sandbox_key: string | null }>(
        "SELECT id, task, summary, artifacts, ts, user_id, ok, sandbox_key FROM work_runs WHERE user_id=? AND artifacts IS NOT NULL AND artifacts <> '[]' ORDER BY ts DESC LIMIT 5",
        userId,
      );
      for (const r of rows) {
        let artifacts: string[] = [];
        try {
          const parsed = JSON.parse(r.artifacts ?? '[]');
          if (Array.isArray(parsed)) artifacts = parsed.map(String).filter(Boolean);
        } catch { /* 老行没有 artifacts 列值时回落到摘要解析 */ }
        if (!artifacts.length) artifacts = parseWorkHandoff(r.summary ?? '').artifacts;
        artifacts = artifacts.map((a) => a.trim().replace(/\\/g, '/')).filter(isDeliverableArtifact);
        if (artifacts.length) {
          return { runId: r.id, task: clip(r.task, 200), artifacts, at: r.ts, userId: r.user_id ?? userId, ok: !!r.ok, sandboxKey: r.sandbox_key ?? undefined };
        }
      }
    } catch { /* 表缺失等不影响主流程 */ }
    return undefined;
  }
  get(id: string): any | undefined {
    const live = this.runs.get(id);
    if (live) return this.view(live);
    return this.dbList(200, undefined).find((r) => r.id === id);
  }

  private persist(phase: string, rec: any, input: WorkRunInput, result?: WorkRunResult): void {
    try {
      // 落库的是**整份快照**（含 events 与 usage）：重启后抽屉还要按同一份数据画 loop、
      // 圆环、缓存与 TPS。运行中每来一条事件都写一次太重，所以 start/收尾各写一次，
      // 中途的事件靠内存；崩掉的那次至少留下已完结前的最近一次快照。
      const live = this.runs.get(rec.id);
      this.db.run(
        `INSERT INTO work_runs (id, chat_key, sandbox_key, task, model, trigger, phase, ok, rounds, tool_calls, duration_ms, summary, error, user_id, nickname, ts, artifacts, events, usage)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, ok=excluded.ok, rounds=excluded.rounds,
           tool_calls=excluded.tool_calls, duration_ms=excluded.duration_ms, summary=excluded.summary,
           error=excluded.error, ts=excluded.ts, artifacts=excluded.artifacts,
           events=excluded.events, usage=excluded.usage, nickname=excluded.nickname`,
        // 落库也存全文：工作页/抽屉从库里回放时不能再出现「…(截断,原长 N)」
        rec.id, rec.chatKey, rec.sandboxKey ?? null, input.task, rec.model, input.trigger, phase,
        result?.ok ? 1 : 0, result?.rounds ?? live?.rounds ?? 0, result?.toolCalls ?? live?.toolCalls ?? 0,
        result?.durationMs ?? live?.durationMs ?? 0,
        clip(result?.summary ?? '', 4000), result?.error ?? null, input.userId, input.nickname ?? null, nowMs(),
        JSON.stringify(result?.artifacts ?? live?.artifacts ?? []),
        JSON.stringify(live?.events ?? []),
        JSON.stringify(result?.usage ?? null),
      );
    } catch { /* 表缺失等不影响主流程 */ }
  }
}

/**
 * 正则兜底：模型没按交付格式登记产物时，从步骤文本里捞路径。
 * 正常路径是工具通过 ToolMeta.artifacts 上报 + 交付格式的「产物」一节，这里只保底。
 */
/**
 * 从步骤文本里兜底提取产物路径。正则天生会把 ls 输出、日志里出现过的**任何文件名**都当产物
 * （2026-10-25 Three.js 任务的交付里混进了上一个任务的图——只因模型 ls 时看到过它），
 * 所以给了 root 就逐个验存在且在沙箱内：验不过的一律不信。
 */
export function extractArtifacts(steps: string[], root?: string): string[] {
  const out = new Set<string>();
  const realInRoot = (p: string): boolean => {
    if (!root) return true;
    try {
      const abs = resolve(root, p);
      const top = resolve(root);
      if (abs !== top && !abs.startsWith(top + sep)) return false;
      return statSync(abs).isFile();
    } catch { return false; }
  };
  for (const s of steps) {
    for (const m of s.matchAll(/(?:写入|已写入|saved|wrote)\s+([^\s（(]+\.\w{1,8})/gi)) out.add(m[1]);
    for (const m of s.matchAll(/([A-Za-z0-9_\-./]+\.(?:png|jpg|jpeg|csv|xlsx|md|txt|json|pdf|html|py|js))/g)) out.add(m[1]);
  }
  return [...out].filter(realInRoot).slice(0, 20);
}

/** 运行中的 token 账：loop 的 usage 事件是每轮累加的原料（收尾前的 status 也拿得到） */
function usageOfEvents(events: LoopEvent[]): { prompt: number; completion: number; cacheHit: number; cacheMiss: number } {
  const u = { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 };
  for (const e of events) {
    if (e.kind !== 'usage') continue;
    u.prompt += e.prompt;
    u.completion += e.completion;
    u.cacheHit += e.cacheHit;
    u.cacheMiss += e.cacheMiss;
  }
  return u;
}

/** 最近一步（只给种类/工具名，不给思考原文）：让 status 能说"刚在跑什么" */
function lastStepOf(events: LoopEvent[]): WorkLiveStatus['active'][number]['step'] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'tool' || e.kind === 'toolResult') return { kind: e.kind, name: e.name };
    if (e.kind === 'round') return { kind: 'round' };
    if (e.kind === 'thinking') return { kind: 'thinking' };
    if (e.kind === 'compaction') return { kind: 'compaction' };
  }
  return undefined;
}

/** 去重（保序）、把反斜杠归一成正斜杠，并丢掉内部文件——沙箱相对路径统一用 / */
function dedupe(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const p = raw.trim().replace(/\\/g, '/');
    if (!p || seen.has(p) || !isDeliverableArtifact(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.slice(0, 30);
}

/** JSON 列 → 数组（老行/坏值一律当空数组，不让列表因为一条脏数据整片失败） */
function parseJsonArray(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/** JSON 列 → 对象（usage 这类；坏值返回 undefined） */
function parseJsonObj(raw: unknown): Record<string, any> | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch { return undefined; }
}