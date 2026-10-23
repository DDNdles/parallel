'use client';
/**
 * ZCode 形态的活动流零件（工作抽屉与工作页共用）。
 *
 * 口径照 `packages/ui/src/v4/ConversationRowView.tsx` / `ToolCallBlocks`：一行一个动作，
 * 动作图标 + 能力词 + 主体 + 灰色次级 + 行增减，正文点开才以整幅卡片出现。
 * 这里只保留 parallel 内核事件已有的字段，不引入 ZCode 的协议类型。
 */
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { fileIcon } from '@/lib/fileIcon';
import { toolAction, splitMcp, argPath, ctxBadge, type ToolMeta } from '@/lib/entries';

export interface LoopEvent {
  kind: 'round' | 'delta' | 'thinkingDelta' | 'thinking' | 'text' | 'tool' | 'toolResult' | 'usage' | 'compaction' | 'settle' | 'final';
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
  const finishStream = () => {
    const prev = acts[acts.length - 1];
    if (prev?.streaming) { prev.streaming = false; prev.running = false; }
  };
  /** 流式增量只并进同类型的最后一行；思考/正文切换时各起一行 */
  const appendStream = (kind: 'think' | 'text', text: string) => {
    const prev = acts[acts.length - 1];
    if (prev?.kind === kind && prev.streaming) prev.body += text;
    else acts.push({ kind, subject: '', sub: '', body: text, streaming: true, running: true });
  };
  for (const ev of events) {
    if (ev.kind === 'final') { finishStream(); final = ev.text ?? ''; }
    else if (ev.kind === 'delta') {
      // 正文增量：先长成一条流式正文行，message_end 的完整 text 会把它覆盖
      const text = String(ev.text ?? '');
      if (text) appendStream('text', text);
    } else if (ev.kind === 'thinkingDelta') {
      // 思考链增量：长成流式思考行，message_end 的完整 thinking 会把它覆盖
      const text = String(ev.text ?? '');
      if (text) appendStream('think', text);
    } else if (ev.kind === 'thinking') {
      const text = String(ev.text ?? '');
      if (!text.trim()) continue;
      const prev = acts[acts.length - 1];
      if (prev?.kind === 'think' && prev.streaming) {
        prev.body = text;                 // 以完整文本为准，补上丢掉的增量
        prev.streaming = false;
        prev.running = false;
      } else if (prev?.kind === 'think') prev.body = prev.body ? `${prev.body}\n\n${text}` : text;
      else acts.push({ kind: 'think', subject: '', sub: '', body: text });
    } else if (ev.kind === 'text') {
      const text = String(ev.text ?? '');
      if (!text.trim()) continue;
      const prev = acts[acts.length - 1];
      if (prev?.kind === 'text' && prev.streaming) {
        prev.body = text;
        prev.streaming = false;
        prev.running = false;
      } else if (prev?.kind === 'text') prev.body = prev.body ? `${prev.body}\n\n${text}` : text;
      else acts.push({ kind: 'text', subject: '', sub: '', body: text });
    } else if (ev.kind === 'tool') {
      finishStream();
      const args = String(ev.args ?? '');
      const head = actHead(ev.name ?? '', args);
      const row: ActRow = { ...head, body: isRun(head.kind) ? `$ ${args}` : args, call: true, running: true };
      acts.push(row);
      pending.set(ev.name ?? '', row);
    } else if (ev.kind === 'toolResult') {
      finishStream();
      const running = pending.get(ev.name ?? '');
      if (running) { running.running = false; pending.delete(ev.name ?? ''); }
      pushAct(acts, { ...actHead(ev.name ?? ''), body: ev.text ?? '', meta: ev.meta }, false);
      // shell/python 顺手改过的文件：每次执行后按快照差异补一行「文件 path +N -M」
      for (const c of ev.meta?.changes ?? []) {
        acts.push({ kind: 'file', subject: c.path, sub: '', path: c.path, body: '',
          meta: { path: c.path, added: c.added, removed: c.removed } });
      }
    } else if (ev.kind === 'compaction') {
      finishStream();
      // 上下文压缩：丢掉的是模型看不到的那部分历史，正文给出摘要（点开可看）
      acts.push({
        kind: 'compact',
        subject: '上下文',
        sub: `-${ev.dropped ?? 0} 条${ev.tokensBefore ? ` / 原 ~${Math.round(ev.tokensBefore / 1000)}k tokens` : ''}`,
        body: ev.summary ?? '',
      });
    } else if (ev.kind === 'settle' && ev.reason === 'max_rounds') {
      finishStream();
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

/** 思考行的收起态摘要：取第一段有内容的行（ZCode 在流式时显示最后一行；我们拿到的是整段） */
export function thinkSummary(text: string): string {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (t) return t.length > 70 ? `${t.slice(0, 70)}…` : t;
  }
  return '';
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

/** ZCode 形态的动作行：动作图标 (+文件徽章) + 动作词 + 主体 + 灰色次级 + 行增减，正文点开才出现 */
export function Act({ row, opened, onToggle, text, thinkSummary: isThink }: {
  row: ActRow; opened: boolean; onToggle: () => void; text?: boolean; thinkSummary?: boolean;
}) {
  const m = ACT[row.kind];
  const has = !!row.body;
  const { added, removed } = row.meta ?? {};
  // 展开：与会话左栏分组同一套高度滑动（grid 0fr→1fr），但不带渐变蒙版；
  // 正文首次打开后才挂载，收起时留在 0 高度里等着，才能把收起也做成滑动
  const [everOpen, setEverOpen] = useState(opened);
  useEffect(() => { if (opened) setEverOpen(true); }, [opened]);
  // 模型正文：不挂在「思考」行里，直接按普通正文铺开，没有动作头也没有折叠
  if (row.kind === 'text') {
    return (
      <div className="wd-text">
        {row.body}
        {row.streaming && <span className="caret-slot wd-caret"><Icon name="brand" size={13} /></span>}
      </div>
    );
  }
  const toggle = has ? () => { setEverOpen(true); onToggle(); } : undefined;
  return (
    <div className={'wd-act' + (opened && has ? ' open' : '') + (row.running ? ' running' : '')}>
      <div className={'wd-act-h' + (has ? '' : ' plain')} onClick={toggle}>
        <span className="ic">{row.running
          ? <span className="wd-spin"><Icon name="spinner" size={15} /></span>
          : <Icon name={m.icon} size={15} />}</span>
        <span className="lbl">{m.label}</span>
        {row.path && <span className="bdg"><Icon name={fileIcon(row.path)} size={14} /></span>}
        {row.subject && <span className="nm">{row.subject}</span>}
        {row.sub && <span className={'sb' + (isThink ? ' wd-think-sum' : '')}>{row.sub}</span>}
        {added !== undefined && <span className="add">+{added}</span>}
        {removed !== undefined && <span className="del">-{removed}</span>}
        {has && <span className="wd-chev"><Icon name="chevron" size={12} /></span>}
      </div>
      {has && (
        <div className={'wd-fold' + (opened ? ' open' : '')}>
          <div className="wd-fold-inner">
            {opened || everOpen
              ? (text ? <div className="wd-act-t">{row.body}</div> : <pre className="wd-act-b mono">{row.body}</pre>)
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
  if (kind === 'file' || kind === 'net' || kind === 'browser') {
    const p = meta?.path || argPath(args);
    if (p) {
      // 只有文件类带文件类型徽章（path 字段），联网/浏览器的主体是 URL 或查询词
      return kind === 'file' && /[./\\]/.test(p) && !/\s/.test(p)
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
