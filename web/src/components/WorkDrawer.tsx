'use client';
/**
 * 会话页右侧「工作」抽屉（顶栏那个回路图标的开关）。
 *
 * 形态照 ZCode 的子代理侧栏：从最右端滑入、关闭时弹回。在流里占一列（不压住消息），
 * 打开时把中间的会话列往左挤；左缘可拖拽调宽（320px ~ 视口 30%，宽度存 localStorage）。
 * 内容只显示 **work 子代理** 的活动流（chat 模型的流水不在这个抽屉里展示），用 ZCode 的形态
 * （一行一个动作：动作图标 + 动作词 + 主体 + 文件徽章 + 行增减，正文点开才以整幅卡片/灰底面板出现）；
 * 标题栏那颗圆环按 work 的「当前上下文 / 模型上下文窗口」填充，悬停出占比、缓存命中与总输入。
 * 没有输入框，说话仍然在会话页做。没有 work 运行时是空页。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as RMouseEvent } from 'react';
import { get, onEvent } from '@/lib/api';
import { Icon } from '@/components/Icon';
import {
  Act, CtxRing, WorkPulse, cacheRate, fmtMs, loopActs, metricsOf,
  type WorkRun,
} from '@/components/workActivity';

const W_KEY = 'parallel_work_width';
/** 宽度下限：栏里是缓存账和工具卡片，再窄就散了（一级侧栏窄轨是 57，这里内容更重所以抬高） */
const W_MIN = 320;
/** 宽度上限 = 视口 30%，与一级侧栏（App.tsx clampSide）同一条规则 */
const W_MAX_RATIO = 0.3;
/** 挤压式面板必须给会话列留下的下限：低于这个宽度，气泡和输入框就没法读了 */
const W_CONV_MIN = 280;
/** 上面那条留不出来时的面板地板宽（再窄就散，宁可让会话列短一点） */
const W_FLOOR = 240;
export default function WorkDrawer({ chatKey, open, onClose, ctxByModel, narrow }: {
  chatKey?: string;
  open: boolean;
  onClose: () => void;
  /** 模型 id -> 上下文窗口（token），来自模型设置页的配置；缺该模型 = 画不出占比 */
  ctxByModel?: Record<string, number>;
  /** 窄屏：面板改覆盖式浮出（见 globals.css 的 .wb.narrow .wd-panel），不再挤会话列 */
  narrow?: boolean;
}) {
  const [runs, setRuns] = useState<WorkRun[]>([]);
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
    /* 面板是在流里挤会话列的，光按视口比例算不够：820 宽下 30% 是 320，扣掉一级侧栏和会话列表
       只剩 190px 给对话（560 更夸张）。所以量「面板关掉时对话能拿到的宽度」，再给它留一条下限。
       窄屏另有媒体查询把面板改成覆盖式（不占位），这里的 cap 自然不生效。 */
    const conv = document.querySelector<HTMLElement>('.conv-side')?.clientWidth ?? 0;
    const avail = conv + (asideRef.current?.clientWidth ?? 0);
    const cap = narrow ? max : Math.max(W_FLOOR, Math.min(max, avail - W_CONV_MIN));
    return Math.round(Math.min(Math.max(w, Math.min(W_MIN, cap)), cap));
  }, [narrow]);
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

  useEffect(() => { if (open) load(); }, [open, load]);
  // 换会话：退回"看最新一次"，并清掉展开态
  useEffect(() => { setExpanded({}); }, [chatKey]);

  // 实时：这个会话的 loop 事件边跑边长
  useEffect(() => {
    if (!open || !chatKey) return;
    const mine = (d: { chatKey?: string }) => d.chatKey === chatKey;
    const offs = [
      onEvent('work.start', (d: any) => {
        if (!mine(d)) return;
        // 新任务开跑：把选中人切到它的发起者，否则事件会落进别人的视图里看不见
        if (d.userId) setOwnerSel(String(d.userId));
        setRuns((prev) => prev.some((r) => r.id === d.id) ? prev : [{
          id: d.id, chatKey: d.chatKey, task: d.task, model: d.model, ok: false, summary: '',
          rounds: 0, toolCalls: 0, durationMs: 0, artifacts: [], startedAt: Date.now(), events: [],
          userId: d.userId ? String(d.userId) : '', nickname: d.nickname ? String(d.nickname) : undefined,
        }, ...prev]);
      }),
      onEvent('work.event', (d: any) => {
        if (!mine(d)) return;
        setRuns((prev) => prev.map((r) => {
          if (r.id !== d.id) return r;
          const evs = r.events ?? [];
          // 流式增量在本地合并成一条（思考与正文各自一条），别让 events 数组按 token 膨胀
          if (d.ev?.kind === 'delta' || d.ev?.kind === 'thinkingDelta') {
            const last = evs[evs.length - 1];
            if (last?.kind === d.ev.kind) {
              return { ...r, events: [...evs.slice(0, -1), { ...last, text: `${last.text ?? ''}${d.ev.text ?? ''}` }] };
            }
          }
          return { ...r, events: [...evs, d.ev] };
        }));
      }),
      onEvent('work.done', (d: any) => {
        if (!mine(d)) return;
        setRuns((prev) => prev.map((r) => (r.id === d.id ? {
          ...r, ok: true, summary: d.summary, rounds: d.rounds, toolCalls: d.toolCalls,
          durationMs: d.durationMs, artifacts: d.artifacts ?? [],
          // 停下来提问：状态先按事件里的 question 标上，300ms 后 load 会用完整记录覆盖
          awaiting: d.awaiting ? { question: String(d.question ?? d.summary ?? '') } : undefined,
        } : r)));
        setTimeout(load, 300);   // 收尾后重拉一次：usage 是跑完才结算的
      }),
      onEvent('work.error', (d: any) => {
        if (!mine(d)) return;
        setRuns((prev) => prev.map((r) => (r.id === d.id ? { ...r, ok: false, error: d.error } : r)));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [open, chatKey, load]);

  /**
   * work 运行按发起人分组：同一个群里每个人 /work 是独立会话（各自的沙箱与常驻容器）。
   * 抽屉只显示「本群 + 当前选中的那个人」那串运行，不让 A 的任务混进 B 的视图。
   */
  const owners = useMemo(() => {
    const by = new Map<string, { userId: string; nickname: string; runs: WorkRun[] }>();
    for (const r of runs) {
      const id = r.userId || '';
      let g = by.get(id);
      if (!g) { g = { userId: id, nickname: r.nickname || (id ? id : '未知'), runs: [] }; by.set(id, g); }
      if (!g.nickname && r.nickname) g.nickname = r.nickname;
      g.runs.push(r);
    }
    // 最近有任务的人排前面（每个组内 runs 已按时间倒序）
    return [...by.values()].sort((a, b) => (b.runs[0]?.startedAt ?? 0) - (a.runs[0]?.startedAt ?? 0));
  }, [runs]);
  const [ownerSel, setOwnerSel] = useState<string | null>(null);
  // 换会话 / 列表变化：选中项失效就退回最近有任务的那位
  useEffect(() => {
    if (!owners.length) { setOwnerSel(null); return; }
    if (!ownerSel || !owners.some((o) => o.userId === ownerSel)) setOwnerSel(owners[0].userId);
  }, [owners, ownerSel]);
  const owner = owners.find((o) => o.userId === ownerSel) ?? owners[0];
  const ownerRuns = owner?.runs ?? [];
  // 抽屉只看这位发起人最近的一次；过往运行统一去「工作」页看
  const run = ownerRuns[0];
  const running = !!run && !run.historical && !run.ok && !run.error && !(run.events ?? []).some((e) => e.kind === 'final');
  const { acts, final } = useMemo(() => loopActs(run?.events ?? [], running), [run, running]);
  /** 有流式行时行尾已经有一个花押在闪，底部不再重复闪第二个 */
  const streaming = acts.some((a) => a.streaming);
  /** work 段的指标：优先用结算的 usage（跑完才有），运行中就用事件流里各轮 usage 的累计 */
  const workMetrics = useMemo(() => {
    const m = metricsOf(run?.events ?? [], run?.model, ctxByModel);
    if (!m) return undefined;
    if (run?.usage && run.usage.calls > 0) {
      return { ...m, ...run.usage, rate: cacheRate(run.usage.cacheHit, run.usage.cacheMiss) };
    }
    return m;
  }, [run, ctxByModel]);
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
            <span className="wd-ic">{running ? <span className="wd-spin"><Icon name="spinner" size={15} /></span> : <Icon name="work" size={15} />}</span>
            <span className="wd-title">工作</span>
            {workMetrics && <CtxRing m={workMetrics} label="" model={run?.model} duration={runMs > 0 ? fmtMs(runMs) : undefined} />}
            {run && <span className={'wd-state' + (running ? ' run' : run.awaiting ? ' ask' : run.ok ? '' : ' err')}>
              {running ? '执行中' : run.awaiting ? '等你回答' : run.ok ? '已完成' : '失败'}
            </span>}
            <span className="tb-flex" />
            <button className="wd-close" onClick={onClose} aria-label="关闭工作面板" title="关闭">
              <Icon name="close" size={14} />
            </button>
          </header>

          <div className="wd-body" ref={bodyRef}>
          {!run ? null : (
            <>
              {/* 每个群友是独立的 work 会话：先选人，再看这个人的运行；只有一个人时不占地方 */}
              {owners.length > 1 && (
                <div className="wd-runs" role="tablist" aria-label="选择发起人">
                  {owners.map((o) => (
                    <button key={o.userId || 'unknown'} role="tab" aria-selected={o.userId === owner?.userId}
                      className={'wd-run' + (o.userId === owner?.userId ? ' sel' : '')}
                      onClick={() => setOwnerSel(o.userId)} title={o.userId ? `QQ ${o.userId}` : o.nickname}>
                      <span>{o.nickname}</span>
                      <span className="n mono">{o.runs.length}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="wd-task">
                <div className="wd-task-t">{run.task}</div>
              </div>

              {acts.map((a, i) => (
                // ZCode 配方：思考行收起态滚动显示最新一行，正文点开才展开；
                // 只有 live 运行给入场 key，新行淡入一次（同工作页）
                <Act key={i} row={a} opened={!!expanded[`w${i}`]}
                  onToggle={() => setExpanded((p) => ({ ...p, [`w${i}`]: !p[`w${i}`] }))}
                  enter={running ? `${run.id}:w${i}` : undefined} />
              ))}

              {run.error && <div className="wd-final err"><div className="lbl">执行失败</div><div>{run.error}</div></div>}
              {final && <div className="wd-answer">{final}</div>}
              {running && !streaming && <div className="wd-running"><WorkPulse /></div>}
            </>
          )}
          </div>
        </div>
      </div>
    </aside>
  );
}
