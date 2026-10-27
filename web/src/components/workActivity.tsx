'use client';
/**
 * ZCode 形态的活动流零件（工作抽屉与工作页共用）。
 *
 * 口径照 `packages/ui/src/v4/ConversationRowView.tsx` / `ToolCallBlocks`：一行一个动作，
 * 动作图标 + 能力词 + 主体 + 灰色次级 + 行增减，正文点开才以整幅卡片出现。
 * 这里只保留 parallel 内核事件已有的字段，不引入 ZCode 的协议类型。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { fileIcon } from '@/lib/fileIcon';
import { toolAction, splitMcp, argPath, ctxBadge, type ToolMeta } from '@/lib/entries';

export interface LoopEvent {
  kind: 'round' | 'delta' | 'thinkingDelta' | 'thinking' | 'text' | 'tool' | 'toolResult' | 'usage' | 'compaction' | 'settle' | 'steer' | 'final';
  n?: number; round?: number; text?: string; name?: string; args?: string;
  meta?: ToolMeta;
  prompt?: number; completion?: number; cacheHit?: number; cacheMiss?: number;
  /** 本轮墙钟（毫秒）：只有 usage 事件带，TPS 用它当分母 */
  ms?: number;
  // compaction / settle
  dropped?: number; tokensBefore?: number; summary?: string; reason?: 'terminate' | 'max_rounds';
}

export interface WorkUsage { prompt: number; completion: number; cacheHit: number; cacheMiss: number; calls: number }

export interface WorkRun {
  id: string; chatKey: string; task: string; model: string;
  ok: boolean; summary: string; error?: string;
  rounds: number; toolCalls: number; durationMs: number;
  artifacts: string[]; startedAt: number; usage?: WorkUsage;
  /** 模型按交付格式写的备注 / 是否解析到了结构化交付 */
  notes?: string; structured?: boolean;
  /** 停下来等发起者回答（work_ask）：不是失败，也不是干完了 */
  awaiting?: { question: string; notes?: string };
  events?: LoopEvent[];
  /** 发起人：同一个群里每个人是独立的 work 会话（抽屉按人分组，不混在一起） */
  userId?: string; nickname?: string;
  /** 来自 work_runs 表（内核重启前跑完的那次），没有 live 的"运行中"语义 */
  historical?: boolean;
  /** 本次运行是怎么起来的（chat 工具 / 子代理） */
  trigger?: string;
  /** 老的粗粒度步骤行（没有 events 的历史记录才用它兜底） */
  steps?: string[];
}

/**
 * work 子代理的事件流摊平成一行一动作（不按轮次分组），收敛回答单独拿出来。
 *
 * 思考与正文分开：思考链进「思考」行（相邻的思考仍合并），模型正文进正文行、
 * 直接显示，不再塞进思考的折叠正文里。
 */
export function loopActs(events: LoopEvent[], live: boolean): { acts: ActRow[]; final?: string } {
  const acts: ActRow[] = [];
  let final: string | undefined;
  const pending = new Map<string, ActRow>();          // 工具名 → 还在跑的那一行（结果回来就销账）
  /**
   * 思考与正文可能交错流式（先 thinking_delta，再 text_delta，最后 message_end），
   * 所以收尾/合并都不能只看最后一行：否则同一段思考会先以流式行出现、完整文本再铺一行，
   * 正文同理——用户看到的就是"思考和工具重复显示了两次"，而且两条流式行各闪一个花押。
   */
  const finishStream = () => {
    for (const row of acts) if (row.streaming) { row.streaming = false; row.running = false; }
  };
  /** 同一段完整文本重复到达（provider 偶发重复 message_end）时别铺第二行 */
  const lastFull = new Map<'think' | 'text', string>();
  /** 边界（工具调用 / 新一轮）：所有增量行到此为止，别再拿上一段的旧行接新消息 */
  const closeStream = () => {
    for (const row of acts) if (row.streamed) row.settled = true;
    finishStream();
    lastFull.clear();
  };
  /** 最近一条还没收到完整正文的流式行（不一定是最后一行） */
  const openStream = (kind: 'think' | 'text'): ActRow | undefined => {
    for (let i = acts.length - 1; i >= 0; i--) {
      const r = acts[i];
      if (r.kind === kind && r.streamed && !r.settled) return r;
    }
    return undefined;
  };
  /** 流式增量：同一段并进同一行；思考↔正文切换时只把花押挪到新行，旧行留着别重复 */
  const appendStream = (kind: 'think' | 'text', text: string) => {
    let row: ActRow | undefined = acts[acts.length - 1];
    if (!(row?.kind === kind && row.streaming)) row = openStream(kind);
    if (row) {
      row.body += text;
      row.streaming = true;
      row.running = true;
      // 同时只让一块在闪：上一块的花押收掉（这是"logo 闪两次"的另一半根因）
      for (const r of acts) if (r !== row && r.streaming) { r.streaming = false; r.running = false; }
      return;
    }
    finishStream();
    // 正文常以 "\n\n" 开头；pre-wrap 会把它原样渲染成一大段空行，行首的空行直接去掉
    acts.push({ kind, subject: '', sub: '', body: text.replace(/^\n+/, ''), streaming: true, running: true, streamed: true });
  };
  /** message_end 的完整文本：替换同一段流式行（可能已经不是最后一行），不另起一行 */
  const applyFull = (kind: 'think' | 'text', text: string) => {
    const body = text.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!body.trim()) return;
    if (lastFull.get(kind) === body) return;   // 同一条完整文本重复到达
    lastFull.set(kind, body);
    const row = openStream(kind);
    if (row) {
      row.body = body;
      row.streaming = false;
      row.running = false;
      row.settled = true;
      return;
    }
    const prev = acts[acts.length - 1];
    if (prev?.kind === kind && prev.body.trim() === body.trim()) return;
    acts.push({ kind, subject: '', sub: '', body, settled: true });
  };
  for (const ev of events) {
    if (ev.kind === 'final') {
      closeStream();
      final = String(ev.text ?? '').replace(/^\n+/, '').replace(/\n+$/, '');
    }
    else if (ev.kind === 'delta') {
      // 正文增量：先长成一条流式正文行，message_end 的完整 text 会把它覆盖
      const text = String(ev.text ?? '');
      if (text) appendStream('text', text);
    } else if (ev.kind === 'thinkingDelta') {
      // 思考链增量：长成流式思考行，message_end 的完整 thinking 会把它覆盖
      const text = String(ev.text ?? '');
      if (text) appendStream('think', text);
    } else if (ev.kind === 'thinking') {
      applyFull('think', String(ev.text ?? ''));
    } else if (ev.kind === 'text') {
      applyFull('text', String(ev.text ?? ''));
    } else if (ev.kind === 'tool') {
      closeStream();
      const args = String(ev.args ?? '');
      const head = actHead(ev.name ?? '', args);
      const row: ActRow = { ...head, body: isRun(head.kind) ? `$ ${args}` : args, call: true, running: true };
      acts.push(row);
      pending.set(ev.name ?? '', row);
    } else if (ev.kind === 'toolResult') {
      closeStream();
      const running = pending.get(ev.name ?? '');
      if (running) {
        // 结果折回**发起调用的那一行**（不靠"上一行恰好是它"）：中途夹了别的事件也不会多出一条
        running.running = false;
        running.body += '\n\n' + String(ev.text ?? '').replace(/^\n+/, '');
        if (ev.meta) {
          running.meta = ev.meta;
          if (ev.meta.path && !running.path) { running.path = ev.meta.path; running.subject = ev.meta.path; }
        }
        pending.delete(ev.name ?? '');
      } else {
        pushAct(acts, { ...actHead(ev.name ?? ''), body: String(ev.text ?? '').replace(/^\n+/, ''), meta: ev.meta }, false);
      }
      // shell/python 顺手改过的文件：每次执行后按快照差异补一行「文件 path +N -M」
      for (const c of ev.meta?.changes ?? []) {
        acts.push({ kind: 'file', subject: c.path, sub: '', path: c.path, body: '',
          meta: { path: c.path, added: c.added, removed: c.removed } });
      }
    } else if (ev.kind === 'compaction') {
      closeStream();
      // 上下文压缩：丢掉的是模型看不到的那部分历史，正文给出摘要（点开可看）
      acts.push({
        kind: 'compact',
        subject: '上下文',
        sub: `-${ev.dropped ?? 0} 条${ev.tokensBefore ? ` / 原 ~${Math.round(ev.tokensBefore / 1000)}k tokens` : ''}`,
        body: ev.summary ?? '',
      });
    } else if (ev.kind === 'steer') {
      closeStream();
      // 任务运行中用户改需求：插话内容单列一行，方便回看"当时要求改成什么"
      acts.push({ kind: 'note', subject: '用户插话', sub: '', body: String(ev.text ?? '') });
    } else if (ev.kind === 'settle' && ev.reason === 'max_rounds') {
      closeStream();
      // 正常收尾（terminate）不占行；只有被轮次上限强制收尾才提示
      acts.push({ kind: 'note', subject: '已达工具轮次上限', sub: '强制收尾', body: '' });
    }
  }
  // 任务已经结束（不是 live）却还有行挂着 running：事件流缺了尾（比如中断/压缩后的老记录），
  // 不能一直转下去——收尾时把转圈停掉，避免"跑完还在转"的假象。
  if (!live) {
    for (const row of pending.values()) row.running = false;
    finishStream();
  }
  return { acts, final };
}

/** 缓存命中率：协议端不报缓存时（两边都 0）返回 null，UI 显示"未统计"而不是 0% */
export function cacheRate(hit?: number, miss?: number): number | null {
  const total = (hit ?? 0) + (miss ?? 0);
  return total ? (hit ?? 0) / total : null;
}

/** 生成速度（tok/s）：输出 token ÷ 该轮墙钟。没有 ms（老记录）或没输出时返回 null */
export function tpsOf(completion?: number, ms?: number): number | null {
  if (!completion || !ms) return null;
  return completion / (ms / 1000);
}

/**
 * 一组 loop 事件的指标（chat 与 work 共用同一套口径）。
 *
 * - 缓存命中率 / 总输入：各轮累计；
 * - 上下文占用：**最后一轮**上报的 prompt（累计和没有意义，那是整场任务的输入总量）；
 * - TPS：最后一轮的输出 token ÷ 那一轮墙钟。
 * 协议端不给 usage 时全部为 null（宁可不画，也不编数）。
 */
export interface Metrics {
  prompt: number; completion: number; cacheHit: number; cacheMiss: number; calls: number;
  ctxNow: number; ctxMax?: number; ctxPct: number | null;
  rate: number | null; tps: number | null;
  model?: string;
}

export function metricsOf(events: LoopEvent[], model: string | undefined, ctxByModel?: Record<string, number>): Metrics | undefined {
  const us = events.filter((e) => e.kind === 'usage');
  if (!us.length) return undefined;
  const totals = { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, calls: 0 };
  for (const u of us) {
    totals.prompt += u.prompt ?? 0;
    totals.completion += u.completion ?? 0;
    totals.cacheHit += u.cacheHit ?? 0;
    totals.cacheMiss += u.cacheMiss ?? 0;
    totals.calls++;
  }
  const last = us[us.length - 1];
  const ctxNow = last.prompt ?? 0;
  const key = model ?? '';
  const ctxMax = ctxByModel?.[key] ?? ctxByModel?.[key.replace(/^[^:]+:/, '')];
  return {
    ...totals,
    ctxNow,
    ctxMax,
    ctxPct: ctxMax && ctxNow ? Math.min(ctxNow / ctxMax, 1) : null,
    rate: cacheRate(totals.cacheHit, totals.cacheMiss),
    tps: tpsOf(last.completion, last.ms),
    model,
  };
}

export const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
export const fmtClock = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

/** 思考行的收起态摘要：取第一段有内容的行 */
export function thinkSummary(text: string): string {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (t) return t.length > 70 ? `${t.slice(0, 70)}…` : t;
  }
  return '';
}

/** 流式摘要取最后一行非空行（ZCode resolveReasoningStreamingSummary：滚动时永远跟最新的字） */
export function lastLine(text: string): string {
  const lines = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t;
  }
  return '';
}

/**
 * 思考行流式期的滚动摘要（ZCode QueuedSummaryContent 的轻量版）：
 * 最后一行换行时旧行滚出、新行从下方滚入；超宽时把视口推到末尾并两端渐隐。
 */
function RollLine({ text }: { text: string }) {
  const [snap, setSnap] = useState(() => ({ text: lastLine(text), k: 0 }));
  const hostRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const l = lastLine(text);
    if (!l) return;
    setSnap((p) => (p.text === l ? p : { text: l, k: p.k + 1 }));
  }, [text]);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    // 最新 token 会被右侧裁掉，普通 ellipsis 固定显示旧前缀——直接推到末尾
    el.scrollLeft = el.scrollWidth;
    setOverflow(el.scrollWidth > el.clientWidth + 1);
  }, [snap]);
  return (
    <span ref={hostRef} className="wd-roll" data-mask={overflow ? 'both' : 'none'}>
      <span key={snap.k} className="wd-roll-line">{snap.text}</span>
    </span>
  );
}

/** 上下文占比圆环周长（直径 15px 与标题同高，r=6），用 stroke-dasharray 换算百分比 */
const RING_C = 2 * Math.PI * 6;

/** 上下文占比圆环（chat / work 各一颗，悬停出缓存命中、TPS、总输入；带上模型与用时就一起放进浮卡） */
export function CtxRing({ m, label, model, duration }: { m: Metrics; label: string; model?: string; duration?: string }) {
  const pct = m.ctxPct;
  // `provider:model` 拆成两行：整串塞一行会折成三段，读起来很丑
  const colon = model ? model.indexOf(':') : -1;
  const provider = colon > 0 ? model!.slice(0, colon) : '';
  const modelName = colon > 0 ? model!.slice(colon + 1) : model;
  return (
    <span className="wd-ring" tabIndex={0}
      aria-label={`${label}上下文 ${ctxBadge(m.ctxNow)} / ${ctxBadge(m.ctxMax)}（${pct === null ? '窗口未配置' : `${Math.round(pct * 100)}%`}）`}>
      <svg viewBox="0 0 15 15" width="15" height="15" aria-hidden>
        <circle className="t" cx="7.5" cy="7.5" r="6" />
        {pct !== null && (
          <circle className="p" cx="7.5" cy="7.5" r="6" transform="rotate(-90 7.5 7.5)"
            strokeDasharray={`${RING_C} ${RING_C}`} strokeDashoffset={RING_C * (1 - pct)} />
        )}
      </svg>
      <span className="wd-ring-pop">
        {provider && <span className="r"><span className="k">供应商</span><span className="v mono">{provider}</span></span>}
        {modelName && <span className="r"><span className="k">模型</span><span className="v wd-ring-model mono" title={model}>{modelName}</span></span>}
        {duration && <span className="r"><span className="k">工作</span><span className="v mono">{duration}</span></span>}
        <span className="r"><span className="k">{label}上下文</span>
          <span className="v mono">{ctxBadge(m.ctxNow)} / {ctxBadge(m.ctxMax) ?? '—'} · {pct === null ? '未配置窗口' : `${Math.round(pct * 100)}%`}</span></span>
        <span className="r"><span className="k">缓存命中</span>
          <span className="v">{m.rate === null ? '未统计' : `${Math.round(m.rate * 100)}%`}</span></span>
        <span className="r"><span className="k">生成速度</span>
          <span className="v mono">{m.tps === null ? '—' : `${m.tps.toFixed(1)} tok/s`}</span></span>
        <span className="r"><span className="k">总输入</span>
          <span className="v mono">{ctxBadge(m.prompt)} tok</span></span>
      </span>
    </span>
  );
}

/** 一段的小标题行：名字 + 该段自己的圆环 + 一行灰字指标 */
export function SecHead({ title, m, extra }: { title: string; m?: Metrics; extra?: string }) {
  return (
    <div className="wd-sec-h">
      <span>{title}</span>
      {m && <CtxRing m={m} label="" />}
      {m && (
        <span className="wd-sec-m mono">
          {m.rate !== null && <span>缓存 {Math.round(m.rate * 100)}%</span>}
          {m.tps !== null && <span>{m.tps.toFixed(1)} tok/s</span>}
          {m.ctxPct !== null && <span>上下文 {Math.round(m.ctxPct * 100)}%</span>}
          {extra && <span>{extra}</span>}
        </span>
      )}
    </div>
  );
}

/** 动作行的图标与措辞：按能力分五类（执行/文件/联网/浏览器/其他），另加思考、异常、压缩、收尾四种行 */
const ACT = {
  run: { icon: 'console', label: '终端' },
  read: { icon: 'search', label: '读取' },
  file: { icon: 'file', label: '文件' },
  net: { icon: 'globe', label: '联网' },
  browser: { icon: 'browser', label: '浏览器' },
  other: { icon: 'tool', label: '工具' },
  // 协议类动作（toolAction 按整名判）：措辞跟着图标一起换，别再顶着「工具」二字
  todo: { icon: 'todo', label: '清单' },
  ask: { icon: 'ask', label: '回问' },
  done: { icon: 'done', label: '交付' },
  delegate: { icon: 'delegate', label: '派生' },
  skill: { icon: 'plugins', label: '技能' },
  error: { icon: 'warn', label: '异常' },
  think: { icon: 'think', label: '思考' },
  text: { icon: 'chats', label: '正文' },
  compact: { icon: 'collapse', label: '压缩' },
  note: { icon: 'bolt', label: '收尾' },
} as const;
export type ActKind = keyof typeof ACT;

/** 一行动作：主体 + 灰色次级 + 可展开正文（没有正文就没有 chevron，也不占第二行） */
export interface ActRow {
  kind: ActKind; subject: string; sub: string; body: string;
  nm?: string; call?: boolean; path?: string; meta?: ToolMeta;
  /** 这一行还在跑（工具已调用、结果没回来）：行首图标换成转圈 */
  running?: boolean;
  /** 正在流式接收正文（delta 行）：自动展开，message_end 后收起成普通思考行 */
  streaming?: boolean;
  /** 这一行来自流式增量：message_end 的完整文本要替换它，而不是再铺一行 */
  streamed?: boolean;
  /** 已经收到完整文本：之后的同类增量属于新的一段 */
  settled?: boolean;
}

/** 执行类（run_*、python_session、bash）的参数是命令，按 ZCode 加 $ 前缀 */
export const isRun = (k: ActKind) => k === 'run';

/** 正在工作的花押：工作页、会话页 work 抽屉共用；与会话页光标同款的 parallel 图标闪烁，跑完消失 */
export function WorkPulse() {
  return (
    <span className="work-loader" title="工作子代理正在执行" aria-label="工作子代理正在执行">
      <Icon name="brand" size={15} />
    </span>
  );
}

/**
 * 行入场的「已播过」名册（ZCode ToolCallBlocks 同一手法）：按稳定 key 记一次，
 * 切换任务 / 列表重挂不重播。超过上限按最旧删，历史行反正不再入场。
 */
const ENTER_MAX = 800;
const playedEnter = new Map<string, number>();

/**
 * ZCode 形态的动作行：动作图标 + 动作词（运行中换时态措辞并扫光）+ 主体 + 灰色次级 + 行增减，
 * 正文点开才出现。图标在运行中保持静态——旋转 loader 会长期占渲染资源，
 * 运行态由动作词表达（对齐 ZCode ToolLayout / reasoning 的取舍）。
 */
export function Act({ row, opened, onToggle, enter }: {
  row: ActRow; opened: boolean; onToggle: () => void;
  /** 行入场 key（只在 live 运行中给）：首次出现淡入一次 */
  enter?: string;
}) {
  const m = ACT[row.kind];
  const has = !!row.body;
  const { added, removed } = row.meta ?? {};
  // 展开：与会话左栏分组同一套高度滑动（grid 0fr→1fr），但不带渐变蒙版；
  // 正文首次打开后才挂载，收起时留在 0 高度里等着，才能把收起也做成滑动
  const [everOpen, setEverOpen] = useState(opened);
  useEffect(() => { if (opened) setEverOpen(true); }, [opened]);
  // 入场只在本行挂载那一刻判定一次；标记放 effect 里延迟执行，避免开发态双挂载把动画误吞（ZCode 同法）
  const [playEnter] = useState(() => !!enter && !playedEnter.has(enter));
  useEffect(() => {
    if (!playEnter || !enter) return;
    const t = setTimeout(() => {
      playedEnter.set(enter, Date.now());
      if (playedEnter.size > ENTER_MAX) {
        for (const k of [...playedEnter.entries()].sort((a, b) => a[1] - b[1])
          .slice(0, playedEnter.size - ENTER_MAX).map(([k]) => k)) playedEnter.delete(k);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [playEnter, enter]);
  const enterCls = playEnter ? ' wd-enter' : '';
  // 模型正文：不挂在「思考」行里，直接按普通正文铺开，没有动作头也没有折叠
  if (row.kind === 'text') {
    return (
      <div className={'wd-text' + enterCls}>
        {row.body}
        {row.streaming && <span className="caret-slot wd-caret"><Icon name="brand" size={13} /></span>}
      </div>
    );
  }
  // 动作词的时态（ZCode）：execute 跑起来说「正在执行」、思考链说「正在思考」，跑完回到能力词
  const lbl = row.kind === 'think'
    ? (row.running || row.streaming ? '正在思考' : '思考')
    : row.kind === 'run' && row.running ? '正在执行' : m.label;
  const toggle = has ? () => { setEverOpen(true); onToggle(); } : undefined;
  // 收起态的摘要（ZCode ReasoningTrigger）：流式中滚动跟显示最后一行，静止后显示首行摘要；展开就不重复
  const thinkCol = row.kind === 'think';
  const rolling = thinkCol && row.streaming && !opened;
  const sub = opened ? '' : thinkCol ? (rolling ? '' : thinkSummary(row.body)) : row.sub;
  return (
    <div className={'wd-act' + (opened && has ? ' open' : '') + (row.running ? ' running' : '') + enterCls}>
      <div className={'wd-act-h' + (has ? '' : ' plain')} onClick={toggle}>
        <span className="ic"><Icon name={m.icon} size={15} /></span>
        <span className="lbl">{lbl}</span>
        {row.path && <span className="bdg"><Icon name={fileIcon(row.path)} size={14} /></span>}
        {row.subject && <span className="nm">{row.subject}</span>}
        {rolling && <span className="sb sb-dot">·</span>}
        {rolling
          ? <RollLine text={row.body} />
          : sub && <span className="sb">{sub}</span>}
        {added !== undefined && <span className="add">+{added}</span>}
        {removed !== undefined && <span className="del">-{removed}</span>}
        {has && <span className="wd-chev"><Icon name="chevron" size={12} /></span>}
      </div>
      {has && (
        <div className={'wd-fold' + (opened ? ' open' : '')}>
          <div className="wd-fold-inner">
            {opened || everOpen
              ? (thinkCol ? <div className="wd-act-t">{row.body}</div> : <pre className="wd-act-b mono">{row.body}</pre>)
              : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** 行首显示什么：MCP 名拆成「工具名 + 服务名次级」；文件/联网/浏览器优先用参数里的路径或 URL 当主体 */
export function actHead(name: string, args = '', meta?: ToolMeta): Pick<ActRow, 'kind' | 'subject' | 'sub' | 'nm' | 'path'> {
  const kind = toolAction(name);
  const mcp = name.includes('__') ? splitMcp(name) : null;
  const sub = mcp ? mcp.server : '';
  const base = mcp ? mcp.tool : name;
  if (kind === 'read' || kind === 'file' || kind === 'net' || kind === 'browser') {
    const p = meta?.path || argPath(args);
    if (p) {
      // 读取/文件类带文件类型徽章（path 字段），联网/浏览器的主体是 URL 或查询词
      return (kind === 'read' || kind === 'file') && /[./\\]/.test(p) && !/\s/.test(p)
        ? { kind, subject: p, sub, nm: name, path: p }
        : { kind, subject: p, sub, nm: name };
    }
  }
  return { kind, subject: base, sub, nm: name };
}

/** 一次调用 = 一行：返回折进同名的上一条（中间空一行），并把返回带来的 meta（路径 / 行增减）挂到这一行 */
export function pushAct(acts: ActRow[], row: ActRow, isCall: boolean) {
  const prev = acts[acts.length - 1];
  if (!isCall && prev?.call && prev.nm === row.nm) {
    prev.body += '\n\n' + row.body;
    if (row.meta) {
      prev.meta = row.meta;
      if (row.meta.path && !prev.path) { prev.path = row.meta.path; prev.subject = row.meta.path; }
    }
    return;
  }
  acts.push({ ...row, call: isCall || undefined });
}
