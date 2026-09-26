'use client';
/**
 * 会话页右侧「工作」抽屉（顶栏那个回路图标的开关）。
 *
 * 形态照 ZCode 的子代理侧栏：从最右端滑入、关闭时弹回。在流里占一列（不压住消息），
 * 打开时把中间的会话列往左挤；左缘可拖拽调宽（320px ~ 视口 30%，宽度存 localStorage）。
 * 内容按说话人分两段，都用 ZCode 活动流的形态（一行一个动作：动作图标 + 动作词 + 主体 + 文件徽章 +
 * 行增减，正文点开才以整幅卡片/灰底面板出现）：上面是 **chat 模型**在本会话的流水——按 agent loop 成组，
 * 每段头上只报「工作 Xs」，起止本身不占行，异常作为一条动作行；下面是 **work 子代理**摊平的动作序列
 * （思考 / 工具 / 收敛回答）；标题栏那颗圆环按「当前上下文 / 模型上下文窗口」填充，悬停出占比、缓存命中与总输入。
 * 没有输入框，说话仍然在会话页做。两段都空时是空页。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as RMouseEvent } from 'react';
import { get, onEvent } from '@/lib/api';
import { isWorkEntry, chatKeyOf, toolAction, splitMcp, argPath, ctxBadge, type LogEntry, type ToolMeta } from '@/lib/entries';
import { Icon } from '@/components/Icon';
import { fileIcon } from '@/lib/fileIcon';

export interface LoopEvent {
  kind: 'round' | 'thinking' | 'tool' | 'toolResult' | 'usage' | 'final';
  n?: number; round?: number; text?: string; name?: string; args?: string;
  meta?: ToolMeta;
  prompt?: number; completion?: number; cacheHit?: number; cacheMiss?: number;
}
export interface WorkUsage { prompt: number; completion: number; cacheHit: number; cacheMiss: number; calls: number }
export interface WorkRun {
  id: string; chatKey: string; task: string; model: string;
  ok: boolean; summary: string; error?: string;
  rounds: number; toolCalls: number; durationMs: number;
  artifacts: string[]; startedAt: number; usage?: WorkUsage;
  events?: LoopEvent[];
}

/** work 子代理的事件流摊平成一行一动作（不再按轮次分组），收敛回答单独拿出来 */
function loopActs(events: LoopEvent[]): { acts: ActRow[]; final?: string } {
  const acts: ActRow[] = [];
  let final: string | undefined;
  for (const ev of events) {
    if (ev.kind === 'final') final = ev.text ?? '';
    else if (ev.kind === 'thinking') acts.push({ kind: 'think', subject: '', sub: '', body: ev.text ?? '' });
    else if (ev.kind === 'tool') {
      const args = String(ev.args ?? '');
      const head = actHead(ev.name ?? '', args);
      pushAct(acts, { ...head, body: isRun(head.kind) ? `$ ${args}` : args }, true);
    } else if (ev.kind === 'toolResult') {
      pushAct(acts, { ...actHead(ev.name ?? ''), body: ev.text ?? '', meta: ev.meta }, false);
    }
  }
  return { acts, final };
}

/** 缓存命中率：协议端不报缓存时（两边都 0）返回 null，UI 显示"未统计"而不是 0% */
function cacheRate(hit?: number, miss?: number): number | null {
  const total = (hit ?? 0) + (miss ?? 0);
  return total ? (hit ?? 0) / total : null;
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtClock = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

const W_KEY = 'parallel_work_width';
/** 宽度下限：栏里是缓存账和工具卡片，再窄就散了（一级侧栏窄轨是 57，这里内容更重所以抬高） */
const W_MIN = 320;
/** 宽度上限 = 视口 30%，与一级侧栏（App.tsx clampSide）同一条规则 */
const W_MAX_RATIO = 0.3;
/** chat 模型流水在面板里最多回溯这么多条原始日志（分组后再截 LOOP_MAX 个 loop） */
const FLOW_MAX = 120;
/** 面板里最多显示最近几个 chat loop（每个 loop = 一次 agent_start 到 agent_end） */
const LOOP_MAX = 8;
/** 上下文占比圆环周长（直径与标题文字同为 13px，r=5.5），用 stroke-dasharray 换算百分比 */
const RING_C = 2 * Math.PI * 5.5;

/** 动作行的图标与措辞：按能力分五类（执行/文件/联网/浏览器/其他），另加思考与异常两种行 */
const ACT = {
  run: { icon: 'console', label: '终端' },
  file: { icon: 'file', label: '文件' },
  net: { icon: 'globe', label: '联网' },
  browser: { icon: 'browser', label: '浏览器' },
  other: { icon: 'tool', label: '工具' },
  error: { icon: 'warn', label: '异常' },
  think: { icon: 'think', label: '思考' },
} as const;
type ActKind = keyof typeof ACT;

/** 一行动作：主体 + 灰色次级 + 可展开正文（没有正文就没有 chevron，也不占第二行） */
interface ActRow {
  kind: ActKind; subject: string; sub: string; body: string;
  nm?: string; call?: boolean; path?: string; meta?: ToolMeta;
}

/** 执行类（run_*、python_session、bash/powershell）的参数是命令，按 ZCode 加 $ 前缀 */
const isRun = (k: ActKind) => k === 'run';

/** ZCode 形态的动作行：动作图标 (+文件徽章) + 动作词 + 主体 + 灰色次级 + 行增减，正文点开才出现 */
function Act({ row, opened, onToggle, text }: { row: ActRow; opened: boolean; onToggle: () => void; text?: boolean }) {
  const m = ACT[row.kind];
  const has = !!row.body;
  const { added, removed } = row.meta ?? {};
  return (
    <div className={'wd-act' + (opened && has ? ' open' : '')}>
      <div className={'wd-act-h' + (has ? '' : ' plain')} onClick={has ? onToggle : undefined}>
        <span className="ic"><Icon name={m.icon} size={15} /></span>
        <span className="lbl">{m.label}</span>
        {row.path && <span className="bdg"><Icon name={fileIcon(row.path)} size={14} /></span>}
        {row.subject && <span className="nm">{row.subject}</span>}
        {row.sub && <span className="sb">{row.sub}</span>}
        {added !== undefined && <span className="add">+{added}</span>}
        {removed !== undefined && <span className="del">-{removed}</span>}
        {has && <span className="wd-chev"><Icon name="chevron" size={12} /></span>}
      </div>
      {has && opened && (text
        ? <div className="wd-act-t">{row.body}</div>
        : <pre className="wd-act-b mono">{row.body}</pre>)}
    </div>
  );
}

/** 行首显示什么：MCP 名拆成「工具名 + 服务名次级」；文件/联网/浏览器优先用参数里的路径或 URL 当主体 */
function actHead(name: string, args = '', meta?: ToolMeta): Pick<ActRow, 'kind' | 'subject' | 'sub' | 'nm' | 'path'> {
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
function pushAct(acts: ActRow[], row: ActRow, isCall: boolean) {
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

/** 一个 chat loop：一次 agent_start 到 agent_end 之间的动作，头上一行只报这一段跑了多久 */
interface FlowLoop { start: number; last: number; ms: number | null; acts: ActRow[] }

function groupFlow(entries: LogEntry[]): FlowLoop[] {
  const loops: FlowLoop[] = [];
  const open = (start = 0) => { const lp: FlowLoop = { start, last: start, ms: null, acts: [] }; loops.push(lp); return lp; };
  let cur: FlowLoop | null = null;
  for (const e of entries) {
    if (e.type === 'agent_start') { cur = open(e.ts ?? 0); continue; }
    if (e.type === 'agent_end') { if (cur && cur.start && e.ts) cur.ms = e.ts - cur.start; cur = null; continue; }
    if (!cur) cur = open();                       // tail 被裁掉起点的残段：不报耗时
    if (e.ts) cur.last = e.ts;
    const name = e.text || '';
    if (e.type === 'error') pushAct(cur.acts, { kind: 'error', subject: '', sub: '', body: name }, false);
    else if (e.type === 'tool_call') {
      const args = String(e.data?.args ?? '');
      const head = actHead(name, args);
      pushAct(cur.acts, { ...head, body: isRun(head.kind) ? `$ ${args}` : args }, true);
    } else if (e.type === 'tool_result') {
      const meta = e.data?.meta as ToolMeta | undefined;
      pushAct(cur.acts, { ...actHead(name, '', meta), body: String(e.data?.result ?? ''), meta }, false);
    }
  }
  const tail = loops[loops.length - 1];            // 还在跑的这一段：报到最近一条日志为止
  if (tail && !tail.ms && tail.start && tail.last > tail.start) tail.ms = tail.last - tail.start;
  // 纯回答、没动过工具的那段没什么可看的，不占行
  return loops.filter((l) => l.acts.length > 0).slice(-LOOP_MAX);
}

export default function WorkDrawer({ chatKey, open, onClose, ctxByModel }: {
  chatKey?: string;
  open: boolean;
  onClose: () => void;
  /** 模型 id -> 上下文窗口（token），来自模型设置页的配置；缺该模型 = 画不出占比 */
  ctxByModel?: Record<string, number>;
}) {
  const [runs, setRuns] = useState<WorkRun[]>([]);
  const [flow, setFlow] = useState<LogEntry[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [width, setWidth] = useState(420);
  const [dragging, setDragging] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const dragRef = useRef(false);
  /** mousedown 时缓存的面板右边界：整个拖拽过程它钉在行右缘不动，缓存下来就不用每个
   *  mousemove 都去读布局（读→写→读的抖动每个事件要 3~5ms，报点密时直接掉帧）。 */
  const dragRightRef = useRef(0);
  /** 本帧待落地的宽度 + 已排的 rAF：把一帧内的 N 条 mousemove 合并成一次 setState */
  const pendingRef = useRef<number | null>(null);
  const rafRef = useRef(0);

  // 左缘拖拽调宽，宽度记在 localStorage（和一级侧栏 parallel_side_width 同一套做法）
  const clampW = useCallback((w: number) => {
    const max = Math.max(W_MIN, window.innerWidth * W_MAX_RATIO);
    return Math.round(Math.min(Math.max(w, Math.min(W_MIN, max)), max));
  }, []);
  /** 直接写 DOM 变量：不经过 React 就能立刻跟手（一帧内写多次由浏览器并成一次布局） */
  const applyW = useCallback((w: number) => {
    asideRef.current?.style.setProperty('--wd-w', `${w}px`);
  }, []);
  useEffect(() => {
    setWidth(clampW(Number(localStorage.getItem(W_KEY)) || 420));
    const flush = () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      const w = pendingRef.current;
      pendingRef.current = null;
      if (w != null) setWidth(w);
    };
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      // 宽度 = mousedown 时缓存的右边界 - 指针 x。这里绝不 getBoundingClientRect()：上一步刚把
      // --wd-w 写进 DOM（布局变脏），再读就是强制同步布局，"读→写→读"每个事件要 3~5ms，鼠标
      // 报点密的时候一帧好几条，直接掉帧——这就是拖起来卡的原因。
      const w = clampW(dragRightRef.current - e.clientX);
      applyW(w);                                  // 先落 DOM：立刻跟手
      pendingRef.current = w;
      if (rafRef.current) return;                 // React 状态按帧合并，避免每条 mousemove 重渲染
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const v = pendingRef.current;
        pendingRef.current = null;
        if (v != null) setWidth(v);
      });
    };
    // dragging 只由 mousedown / window mouseup 驱动：不能挂 mouseleave——拖到一半指针移出把手会把
    // 过渡放回来，后续宽度就带着 .34s 的尾巴跟不上手了。
    const up = () => {
      if (!dragRef.current) return;
      dragRef.current = false;
      flush();                                    // 别丢掉最后一次移动
      setDragging(false);
      document.body.classList.remove('resizing');
    };
    const resize = () => setWidth((w) => clampW(w));
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('resize', resize);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('resize', resize);
    };
  }, [clampW]);
  useEffect(() => { localStorage.setItem(W_KEY, String(width)); }, [width]);

  // 把手的渐隐竖线跟随鼠标 y（与 .side-resize / .wb-list-resize 同一个 --handle-y 约定）
  const followY = (e: RMouseEvent<HTMLElement>) => {
    e.currentTarget.style.setProperty('--handle-y', `${e.clientY - e.currentTarget.getBoundingClientRect().top}px`);
  };

  const load = useCallback(() => {
    if (!chatKey) { setRuns([]); return; }
    get(`/api/work?chatKey=${encodeURIComponent(chatKey)}&limit=20`)
      .then((d: { runs: WorkRun[] }) => setRuns(d.runs ?? []))
      .catch(() => {});
  }, [chatKey]);

  /** chat 模型的流水：与会话页同一个 tail，只留被分流出去的那些条目 */
  const loadFlow = useCallback(() => {
    if (!chatKey) { setFlow([]); return; }
    get(`/api/chats/${encodeURIComponent(chatKey)}/tail?limit=300`)
      .then((d: { entries?: LogEntry[] }) => setFlow((d.entries ?? []).filter((e) => isWorkEntry(e.type)).slice(-FLOW_MAX)))
      .catch(() => {});
  }, [chatKey]);

  useEffect(() => { if (open) { load(); loadFlow(); } }, [open, load, loadFlow]);
  // 换会话：退回"看最新一次"，并清掉展开态
  useEffect(() => { setSelId(null); setExpanded({}); }, [chatKey]);

  // 实时：这个会话的 loop 事件边跑边长
  useEffect(() => {
    if (!open || !chatKey) return;
    const mine = (d: { chatKey?: string }) => d.chatKey === chatKey;
    const offs = [
      onEvent('work.start', (d: any) => {
        if (!mine(d)) return;
        setRuns((prev) => prev.some((r) => r.id === d.id) ? prev : [{
          id: d.id, chatKey: d.chatKey, task: d.task, model: d.model, ok: false, summary: '',
          rounds: 0, toolCalls: 0, durationMs: 0, artifacts: [], startedAt: Date.now(), events: [],
        }, ...prev]);
        setSelId(d.id);
      }),
      onEvent('work.event', (d: any) => {
        if (!mine(d)) return;
        setRuns((prev) => prev.map((r) => (r.id === d.id ? { ...r, events: [...(r.events ?? []), d.ev] } : r)));
      }),
      onEvent('work.done', (d: any) => {
        if (!mine(d)) return;
        setRuns((prev) => prev.map((r) => (r.id === d.id ? {
          ...r, ok: true, summary: d.summary, rounds: d.rounds, toolCalls: d.toolCalls,
          durationMs: d.durationMs, artifacts: d.artifacts ?? [],
        } : r)));
        setTimeout(load, 300);   // 收尾后重拉一次：usage 是跑完才结算的
      }),
      onEvent('work.error', (d: any) => {
        if (!mine(d)) return;
        setRuns((prev) => prev.map((r) => (r.id === d.id ? { ...r, ok: false, error: d.error } : r)));
      }),
      onEvent('session.log', (e: LogEntry) => {
        if (chatKeyOf(e) !== chatKey || !isWorkEntry(e.type)) return;
        setFlow((prev) => [...prev, e].slice(-FLOW_MAX));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [open, chatKey, load]);

  const run = runs.find((r) => r.id === selId) ?? runs[0];
  const { acts, final } = useMemo(() => loopActs(run?.events ?? []), [run]);
  const rate = cacheRate(run?.usage?.cacheHit, run?.usage?.cacheMiss);
  /** 当前上下文 = 最后一轮上报的 prompt。不能用 run.usage.prompt：那是整场任务各轮的累计和 */
  const ctxNow = useMemo(() => {
    const evs = run?.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].kind === 'usage') return evs[i].prompt ?? 0;
    return 0;
  }, [run]);
  const ctxMax = run ? ctxByModel?.[run.model] : undefined;
  /** 窗口没配置时画不出诚实的占比：宁可没有圆环 */
  const ctxPct = ctxMax && ctxNow ? Math.min(ctxNow / ctxMax, 1) : null;
  const running = !!run && !run.ok && !run.error && !final;
  /** 流水按 loop 成组（每次 agent_start 到 agent_end 一段） */
  const flowLoops = useMemo(() => groupFlow(flow), [flow]);
  /** 这次 work 任务的耗时：还在跑就按开始时间推（每来一个事件刷新一次），跑完用结算值 */
  const runMs = run ? (run.durationMs || (running && run.startedAt ? Date.now() - run.startedAt : 0)) : 0;

  // 事件往下长，跑动时贴着底
  useEffect(() => {
    const el = bodyRef.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [run?.events?.length, running]);

  return (
    <aside
      ref={asideRef}
      className={'wd-panel' + (open ? ' open' : '') + (dragging ? ' dragging' : '')}
      style={{ '--wd-w': `${width}px` } as CSSProperties}
      aria-hidden={!open}
      aria-label="当前会话的工作"
    >
      <div
        className={'wd-resize' + (dragging ? ' dragging' : '')}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整工作面板宽度"
        onMouseDown={() => {
          const el = asideRef.current;
          // 整段拖拽只在这里读一次布局
          if (el) dragRightRef.current = el.getBoundingClientRect().right;
          dragRef.current = true;
          setDragging(true);
          document.body.classList.add('resizing');
        }}
        onMouseMove={followY}
      />
      <div className="wd-clip">
        <div className="wd-inner">
          <header className="wd-head">
            <span className="wd-ic"><Icon name="work" size={15} /></span>
            <span className="wd-title">工作</span>
            {ctxPct !== null && run?.usage && (
              <span className="wd-ring" tabIndex={0}
                aria-label={`当前上下文 ${ctxBadge(ctxNow)} / ${ctxBadge(ctxMax)}（${Math.round(ctxPct * 100)}%）`}>
                <svg viewBox="0 0 13 13" width="13" height="13" aria-hidden>
                  <circle className="t" cx="6.5" cy="6.5" r="5.5" />
                  <circle className="p" cx="6.5" cy="6.5" r="5.5" transform="rotate(-90 6.5 6.5)"
                    strokeDasharray={`${RING_C} ${RING_C}`} strokeDashoffset={RING_C * (1 - ctxPct)} />
                </svg>
                <span className="wd-ring-pop">
                  <span className="r"><span className="k">上下文</span>
                    <span className="v mono">{ctxBadge(ctxNow)} / {ctxBadge(ctxMax)} · {Math.round(ctxPct * 100)}%</span></span>
                  <span className="r"><span className="k">缓存命中</span>
                    <span className="v">{rate === null ? '未统计' : `${Math.round(rate * 100)}%`}</span></span>
                  <span className="r"><span className="k">总输入</span>
                    <span className="v mono">{ctxBadge(run.usage.prompt)} tok</span></span>
                </span>
              </span>
            )}
            {run && <span className={'wd-state' + (running ? ' run' : run.ok ? '' : ' err')}>
              {running ? '执行中' : run.ok ? '已完成' : '失败'}
            </span>}
            <span className="tb-flex" />
            <button className="wd-close" onClick={onClose} aria-label="关闭工作面板" title="关闭">
              <Icon name="close" size={14} />
            </button>
          </header>

          <div className="wd-body" ref={bodyRef}>
          {flowLoops.length > 0 && (
            <>
              <div className="wd-sec-h">chat 模型</div>
              {flowLoops.map((lp, li) => (
                <section className="wd-loop" key={li}>
                  <div className="wd-loop-h">{lp.ms === null ? '工作 —' : `工作 ${fmtMs(lp.ms)}`}</div>
                  {lp.acts.map((a, ai) => {
                    const key = `f${li}-${ai}`;
                    return <Act key={ai} row={a} opened={!!expanded[key]}
                      onToggle={() => setExpanded((p) => ({ ...p, [key]: !p[key] }))} />;
                  })}
                </section>
              ))}
            </>
          )}
          {!run ? null : (
            <>
              <div className="wd-sec-h">work 子代理</div>
              {/* 同一个会话跑过多次时，上面一行小签子切换；只有一次就不占地方 */}
              {runs.length > 1 && (
                <div className="wd-runs">
                  {runs.map((r) => (
                    <button key={r.id} className={'wd-run' + (r.id === run.id ? ' sel' : '')}
                      onClick={() => setSelId(r.id)} title={r.task}>
                      <span className="t mono">{fmtClock(r.startedAt)}</span>
                      <span className={'d' + (r.ok ? '' : r.error ? ' err' : ' run')} />
                    </button>
                  ))}
                </div>
              )}

              <div className="wd-task">
                <div className="wd-task-t">{run.task}</div>
                <div className="wd-task-m mono">
                  {run.model} · {run.rounds} 轮 · {run.toolCalls} 次工具
                </div>
              </div>

              {runMs > 0 && <div className="wd-loop-h">工作 {fmtMs(runMs)}</div>}

              {acts.map((a, i) => {
                const key = `w${i}`;
                return <Act key={i} row={a} text={a.kind === 'think'} opened={!!expanded[key]}
                  onToggle={() => setExpanded((p) => ({ ...p, [key]: !p[key] }))} />;
              })}

              {run.error && <div className="wd-final err"><div className="lbl">执行失败</div><div>{run.error}</div></div>}
              {final && <div className="wd-answer">{final}</div>}
            </>
          )}
          </div>
        </div>
      </div>
    </aside>
  );
}
