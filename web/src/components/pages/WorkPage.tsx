'use client';
import { FadeName } from '@/components/FadeName';
/**
 * 工作：左列表（环境 / 正在执行 / 历史）+ 右详情。
 *
 * 详情形态照 ZCode 的 workbench（`packages/ui/src/v4/ConversationRowView.tsx` 与
 * `ToolCallBlocks`）：顶部是状态头与本次运行的几个数，下面按轮次铺一条活动脊线——
 * 一行一个动作（图标 + 能力词 + 主体 + 灰色次级 + 行增减），正文点开才展开；
 * 结论、待回答的问题、失败原因与产物各占一张卡。没有 events 的老记录退回原来的步骤文本。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, onEvent, fmtDT, mdLite } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';
import { fileIcon } from '@/lib/fileIcon';
import { ctxBadge } from '@/lib/entries';
import { Switch } from '@/components/Modal';
import {
  Act, CtxRing, SecHead, WorkPulse, cacheRate, fmtMs, loopActs, metricsOf,
  type ActRow, type LoopEvent, type Metrics, type WorkRun,
} from '@/components/workActivity';

interface WorkApi {
  runs: WorkRun[];
  models: { chat: string; work: string };
  containers: { kind: string; chat: string; id: string; idleMs: number }[];
  images: { python: boolean; browser: boolean; build?: { python?: 'building' | 'failed'; browser?: 'building' | 'failed' } };
  docker: boolean;
}

const ENV = '__env__';
const SKILLS = '__skills__';

interface SkillInfo {
  id: string; name: string; description: string; version?: string;
  attachments: { rel: string; size: number }[];
  hasScripts: boolean; source: string; mtimeMs: number; enabled: boolean;
}
interface SkillsApi { dir: string; dirLabel: string; skills: SkillInfo[] }

/** 还在跑：没结束、没失败、没停下来提问，也还没收到收敛回答 */
const isRunning = (r: WorkRun): boolean => {
  if (r.historical || r.ok || r.error || r.awaiting) return false;
  return !(r.events ?? []).some((e) => e.kind === 'final');
};

interface RoundActs { n: number; acts: ActRow[] }

/** 把事件流按 round 切开，每段再交给共享的 loopActs 摊平（思考归并、工具结果折回同一行） */
function roundTimeline(events: LoopEvent[], live: boolean): { rounds: RoundActs[]; final?: string; total: number } {
  const rounds: RoundActs[] = [];
  let current: RoundActs | null = null;
  let buffer: LoopEvent[] = [];
  let final: string | undefined;
  let n = 0;
  const flush = () => {
    if (!buffer.length) return;
    const { acts } = loopActs(buffer, live);
    buffer = [];
    if (!acts.length) return;
    if (!current) {
      current = { n: 0, acts: [] };
      rounds.push(current);
    }
    current.acts.push(...acts);
  };
  for (const ev of events) {
    if (ev.kind === 'round') {
      flush();
      n += 1;
      current = { n: ev.round ?? ev.n ?? n, acts: [] };
      rounds.push(current);
    } else if (ev.kind === 'final') {
      final = ev.text ?? '';
    } else {
      buffer.push(ev);
    }
  }
  flush();
  const used = rounds.filter((r) => r.acts.length);
  return { rounds: used, final, total: used.reduce((s, r) => s + r.acts.length, 0) };
}

export default function WorkPage({ cmd }: { cmd?: PageCmd }) {
  const [data, setData] = useState<WorkApi | null>(null);
  const [live, setLive] = useState<Record<string, WorkRun>>({});
  const [sel, setSel] = useState(ENV);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [ctxByModel, setCtxByModel] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  /** 已经点开看过的失败运行：红点只提示一次，点掉后不再回来（存 localStorage） */
  const [acked, setAcked] = useState<Set<string>>(() => new Set());
  const [skills, setSkills] = useState<SkillsApi | null>(null);
  const [skillErr, setSkillErr] = useState('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem('parallel_work_ack_fail');
      if (!raw) return;
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) setAcked(new Set(ids.map(String)));
    } catch { /* 坏数据当没看过 */ }
  }, []);

  const ackFail = useCallback((id: string) => {
    setAcked((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      try { localStorage.setItem('parallel_work_ack_fail', JSON.stringify([...next])); } catch { /* 存不下就只在本页生效 */ }
      return next;
    });
  }, []);

  const reload = useCallback(() => {
    get('/api/work?limit=200').then((d: WorkApi) => setData(d)).catch(() => {});
  }, []);

  const loadSkills = useCallback(() => {
    get('/api/skills')
      .then((d: SkillsApi) => { setSkills(d); setSkillErr(''); })
      .catch((e) => setSkillErr((e as Error).message || '读取技能库失败'));
  }, []);

  // 挂载就读一次（左栏要显示数量）；进「技能库」时再刷新一遍，文件是现放现认的
  useEffect(() => { loadSkills(); }, [loadSkills]);

  /** 开关即时落盘：先翻 UI，失败再回滚并就地红字（全站不弹 toast） */
  const toggleSkill = useCallback((s: SkillInfo) => {
    const enabled = !s.enabled;
    setSkillErr('');
    setSkills((prev) => prev
      ? { ...prev, skills: prev.skills.map((x) => (x.id === s.id ? { ...x, enabled } : x)) }
      : prev);
    post('/api/skills/toggle', { name: s.id, enabled }).catch((e) => {
      setSkillErr((e as Error).message || '保存失败');
      loadSkills();
    });
  }, [loadSkills]);

  const loadModels = useCallback(() => {
    get('/api/providers').then((d: any) => {
      const m: Record<string, number> = {};
      for (const p of d?.providers ?? []) for (const mm of p.config?.models ?? []) if (mm.contextWindow) m[mm.id] = mm.contextWindow;
      setCtxByModel(m);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    loadModels();
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, [reload, loadModels]);

  // 实时运行：work.start 先落一条空记录，work.event 往里长，收尾后 300ms 重拉完整记录（usage 是跑完才结算的）
  useEffect(() => {
    const offStart = onEvent('work.start', (d: any) => {
      setLive((prev) => ({
        ...prev,
        [d.id]: {
          id: d.id, chatKey: d.chatKey, task: d.task, model: d.model, ok: false, summary: '',
          rounds: 0, toolCalls: 0, durationMs: 0, artifacts: [], startedAt: Date.now(),
          events: [], userId: d.userId, nickname: d.nickname, trigger: d.trigger,
        },
      }));
    });
    const offEvent = onEvent('work.event', (d: any) => {
      setLive((prev) => {
        const r = prev[d.id];
        if (!r) return prev;
        const evs = r.events ?? [];
        // 流式增量在本地合并成一条（思考与正文各自一条），别让 events 数组按 token 膨胀
        if (d.ev?.kind === 'delta' || d.ev?.kind === 'thinkingDelta') {
          const last = evs[evs.length - 1];
          if (last?.kind === d.ev.kind) {
            return {
              ...prev,
              [d.id]: { ...r, events: [...evs.slice(0, -1), { ...last, text: `${last.text ?? ''}${d.ev.text ?? ''}` }] },
            };
          }
        }
        return { ...prev, [d.id]: { ...r, events: [...evs, d.ev] } };
      });
    });
    const offDone = onEvent('work.done', (d: any) => {
      setLive((prev) => {
        const r = prev[d.id];
        if (!r) return prev;
        return {
          ...prev,
          [d.id]: {
            ...r, ok: true, summary: d.summary ?? '', rounds: d.rounds ?? r.rounds,
            toolCalls: d.toolCalls ?? r.toolCalls, durationMs: d.durationMs ?? 0,
            artifacts: d.artifacts ?? [],
            awaiting: d.awaiting ? { question: String(d.question ?? d.summary ?? '') } : undefined,
          },
        };
      });
      setTimeout(reload, 300);
    });
    const offErr = onEvent('work.error', (d: any) => {
      setLive((prev) => {
        const r = prev[d.id];
        if (!r) return prev;
        return { ...prev, [d.id]: { ...r, ok: false, error: d.error } };
      });
      setTimeout(reload, 300);
    });
    return () => { offStart(); offEvent(); offDone(); offErr(); };
  }, [reload]);

  usePageCmd('work', cmd, () => reload());

  /** 实时记录优先于轮询快照（event 流比 8s 轮询新）；快照里才有的 usage/历史标记补回来 */
  const runs = useMemo(() => {
    const by = new Map<string, WorkRun>((data?.runs ?? []).map((r) => [r.id, r]));
    for (const l of Object.values(live)) {
      const a = by.get(l.id);
      by.set(l.id, a ? { ...a, ...l, usage: l.usage ?? a.usage, historical: a.historical } : l);
    }
    return [...by.values()].sort((a, b) => b.startedAt - a.startedAt);
  }, [data, live]);

  const runningRuns = runs.filter(isRunning);
  const historyRuns = runs.filter((r) => !isRunning(r));

  // 正在跑的任务让列表上的用时自己走（WorkPage 只在这一段时间里有秒针）
  useEffect(() => {
    if (!runningRuns.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [runningRuns.length]);

  // 选中的运行被清理 / 还没加载出来：退回环境页（技能库不是运行，别被误判）
  useEffect(() => {
    if (sel !== ENV && sel !== SKILLS && !runs.some((r) => r.id === sel)) setSel(ENV);
  }, [runs, sel]);

  const run = sel !== ENV && sel !== SKILLS ? runs.find((r) => r.id === sel) : undefined;
  const running = !!run && isRunning(run);
  const metrics = useMemo(() => {
    if (!run) return undefined;
    const m = metricsOf(run.events ?? [], run.model, ctxByModel);
    if (!m) return undefined;
    if (run.usage && run.usage.calls > 0) {
      return { ...m, ...run.usage, rate: cacheRate(run.usage.cacheHit, run.usage.cacheMiss) };
    }
    return m;
  }, [run, ctxByModel]);
  const duration = run ? (run.durationMs || (running ? Math.max(0, now - run.startedAt) : 0)) : 0;

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          <div className="mset-group">
            <div className="mset-group-t">环境</div>
            <button className={'mset-item' + (sel === ENV ? ' sel' : '')} onClick={() => setSel(ENV)}>
              <span className="mset-item-ic"><Icon name="models" size={15} /></span>
              <FadeName text="运行环境" />
              {data && !data.docker && <i className="dot plg-dot-err" />}
            </button>
          </div>

          <div className="mset-group">
            <div className="mset-group-t">技能</div>
            <button className={'mset-item' + (sel === SKILLS ? ' sel' : '')}
              onClick={() => { setSel(SKILLS); loadSkills(); }}>
              <span className="mset-item-ic"><Icon name="plugins" size={15} /></span>
              <FadeName text="技能库" />
              {skills && <span className="mset-badge mono">{skills.skills.length}</span>}
            </button>
          </div>

          {runningRuns.length > 0 && (
            <div className="mset-group">
              <div className="mset-group-t">正在执行（{runningRuns.length}）</div>
              {runningRuns.map((r) => (
                <button key={r.id} className={'mset-item' + (r.id === sel ? ' sel' : '')} onClick={() => setSel(r.id)} title={r.task}>
                  <span className="mset-item-ic"><span className="wd-spin"><Icon name="spinner" size={15} /></span></span>
                  <FadeName text={r.task} />
                  <span className="mset-badge mono">{fmtMs(Math.max(0, now - r.startedAt))}</span>
                </button>
              ))}
            </div>
          )}

          <div className="mset-group">
            <div className="mset-group-t">历史（{historyRuns.length}）</div>
            {historyRuns.map((r) => (
              <button key={r.id} className={'mset-item' + (r.id === sel ? ' sel' : '')}
                onClick={() => { setSel(r.id); if (!r.ok && !r.awaiting) ackFail(r.id); }} title={r.task}>
                <span className="mset-item-ic"><Icon name="work" size={15} /></span>
                <FadeName text={r.task} />
                {!r.ok && !r.awaiting && !acked.has(r.id) && <i className="dot plg-dot-err" />}
              </button>
            ))}
            {!historyRuns.length && <div className="mset-group-e">还没有历史任务</div>}
          </div>
        </aside>

        {sel === SKILLS ? (
          <SkillsDetail data={skills} err={skillErr} onToggle={toggleSkill} onReload={loadSkills} />
        ) : run ? (
          <RunDetail
            run={run} running={running} metrics={metrics} duration={duration}
            expanded={expanded} onToggle={(k) => setExpanded((p) => ({ ...p, [k]: !p[k] }))}
          />
        ) : (
          <EnvDetail data={data} onReload={reload} />
        )}
      </div>
    </div>
  );
}

function RunDetail({ run, running, metrics, duration, expanded, onToggle }: {
  run: WorkRun; running: boolean; metrics?: Metrics; duration: number;
  expanded: Record<string, boolean>; onToggle: (k: string) => void;
}) {
  const timeline = useMemo(() => roundTimeline(run.events ?? [], running), [run.events, running]);
  /** 有流式行时行尾已经有一个花押在闪，底部不再重复闪第二个 */
  const streaming = timeline.rounds.some((r) => r.acts.some((a) => a.streaming));
  // awaiting 时 summary 就是那个问题，已经单独成卡，不再重复一遍
  const answer = timeline.final || (!run.awaiting ? run.summary : '');
  const state: [string, string] = running ? ['执行中', 'run'] : run.awaiting ? ['等你回答', 'ask'] : run.error ? ['失败', 'err'] : run.ok ? ['已完成', 'ok'] : ['已结束', 'idle'];
  // 顶栏已经写着「工作」了，详情头不再重复：用任务首行当标题（完整任务在下面那张卡里）
  const headTitle = run.task.split('\n')[0].replace(/^任务：/, '').trim().slice(0, 48) || '工作';

  return (
    <section className="mset-detail wk-detail">
      <div className="mset-dhead">
        <span className="mset-dic">{running ? <span className="wd-spin"><Icon name="spinner" size={17} /></span> : <Icon name="work" size={17} />}</span>
        <h2 className="mset-dtitle" title={run.task}>{headTitle}</h2>
        <div className="mset-dright">
          {metrics && <CtxRing m={metrics} label="" model={run.model} duration={duration > 0 ? fmtMs(duration) : undefined} />}
          <span className={`tag wk-state ${state[1]}`}>{state[0]}</span>
        </div>
      </div>

      <div className="mset-meta wk-meta">
        <span className="tag mono">{run.model}</span>
        <span className="tag mono">{run.chatKey}</span>
        {run.nickname && <span className="tag">{run.nickname}</span>}
        <span className="tag mono">{fmtDT(run.startedAt)}</span>
        {duration > 0 && <span className="tag mono">{fmtMs(duration)}</span>}
        {metrics && <span className="tag mono">{ctxBadge(metrics.prompt + metrics.completion)} tok</span>}
      </div>

      <div className="wk-task">
        <div className="wk-task-t">{run.task}</div>
        {run.trigger && <div className="wk-task-m mono">{run.trigger === 'chat' ? '由 chat 派活' : run.trigger}</div>}
      </div>

      {run.awaiting && (
        <div className="wk-callout ask">
          <div className="wk-callout-h">它在等你回答</div>
          <div className="wk-callout-b">{run.awaiting.question}</div>
          {run.awaiting.notes && <pre className="wk-callout-note mono">{run.awaiting.notes}</pre>}
        </div>
      )}

      {run.error && (
        <div className="wk-callout err">
          <div className="wk-callout-h">执行失败</div>
          <div className="wk-callout-b">{run.error}</div>
        </div>
      )}

      {timeline.total === 0 ? (
        running
          ? <div className="wk-wait">等待模型响应…</div>
          : (run.steps?.length
            ? <pre className="plg-stack mono">{run.steps.slice(-60).join('\n')}</pre>
            : <div className="wk-wait">（无执行记录）</div>)
      ) : (
        <div className="wk-spine">
          {timeline.rounds.map((rd, ri) => (
            <Fragment key={ri}>
              {rd.acts.map((a, ai) => {
                const key = `${ri}-${ai}`;
                // 只有 live 运行给入场 key：新行淡入一次，历史回放不重播（ZCode 同法）
                return (
                  <Act key={key} row={a} opened={!!expanded[key]} onToggle={() => onToggle(key)}
                    enter={running ? `${run.id}:${key}` : undefined} />
                );
              })}
            </Fragment>
          ))}
        </div>
      )}

      {running && !streaming && <div className="wk-running"><WorkPulse /></div>}

      {answer && <div className="wk-answer" dangerouslySetInnerHTML={{ __html: mdLite(answer) }} />}

      {run.notes && run.notes !== answer && (
        <div className="wk-answer" dangerouslySetInnerHTML={{ __html: mdLite(run.notes) }} />
      )}

      {!!run.artifacts?.length && (
        <>
          <SecHead title="产物" />
          <div className="wk-artifacts">
            {run.artifacts.map((a) => (
              <div key={a} className="wk-artifact" title={a}>
                <Icon name={fileIcon(a)} size={14} />
                <span className="mono">{a.split(/[\\/]/).pop() || a}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function EnvDetail({ data, onReload }: { data: WorkApi | null; onReload: () => void }) {
  const reset = async (chat: string) => { await post('/api/work/reset', { chatKey: chat }); onReload(); };
  const m = data?.models;
  return (
    <section className="mset-detail">
      <div className="mset-dhead">
        <span className="mset-dic"><Icon name="models" size={17} /></span>
        <h2 className="mset-dtitle">运行环境</h2>
      </div>

      <div className="mset-meta">
        <span className={'tag' + (data && !data.docker ? ' err' : '')}>Docker {data?.docker ? '就绪' : '不可用'}</span>
        <span className={'tag' + (data && !data.images?.python && data.images?.build?.python !== 'building' ? ' err' : '')}>
          {data?.images?.build?.python === 'building' ? 'Python 镜像构建中…'
            : data?.images?.build?.python === 'failed' ? 'Python 镜像构建失败'
              : `Python${data?.images?.python ? '可用' : '未构建'}`}
        </span>
        <span className={'tag' + (data && !data.images?.browser && data.images?.build?.browser !== 'building' ? ' err' : '')}>
          {data?.images?.build?.browser === 'building' ? '浏览器镜像构建中…'
            : data?.images?.build?.browser === 'failed' ? '浏览器镜像构建失败'
              : `浏览器${data?.images?.browser ? '可用' : '未构建'}`}
        </span>
      </div>

      <div className="mset-sec-h"><span>模型链</span></div>
      <div className="mset-models">
        <div className="mset-mrow"><span className="plg-k">chat</span><span className="plg-v mono">{m?.chat ?? '—'}</span></div>
        <div className="mset-mrow">
          <span className="plg-k">work</span>
          <span className="plg-v mono">{m?.work ?? '—'}</span>
        </div>
      </div>

      <div className="mset-sec-h"><span>常驻会话容器</span></div>
      <div className="mset-models">
        {data?.containers.length ? data.containers.map((c, i) => (
          <div key={i} className="mset-mrow">
            <span className="plg-k">{c.kind === 'compute' ? 'Python' : '浏览器'}</span>
            <span className="plg-v mono">{c.chat}</span>
            <span className="mset-badge">{Math.round(c.idleMs / 1000)}s</span>
            <span className="mset-macts">
              <button className="mset-ibtn" title="回收" onClick={() => void reset(c.chat)}><Icon name="trash" size={14} /></button>
            </span>
          </div>
        )) : <div className="mset-group-e">当前没有常驻容器</div>}
      </div>
    </section>
  );
}

/**
 * 技能库：技能是宿主上的一组 md（目录式可带脚本/模板）。
 * 这里只做「看一眼 + 逐条开关」——文件由用户自己放进 data/plugin-data/skills，
 * 放进来默认就是开的，关掉的不会进 work 的 system 目录。
 */
function SkillsDetail({ data, err, onToggle, onReload }: {
  data: SkillsApi | null; err: string; onToggle: (s: SkillInfo) => void; onReload: () => void;
}) {
  const on = data?.skills.filter((s) => s.enabled).length ?? 0;
  return (
    <section className="mset-detail">
      <div className="mset-dhead">
        <span className="mset-dic"><Icon name="plugins" size={17} /></span>
        <h2 className="mset-dtitle">技能库</h2>
        <div className="mset-dright">
          {data && <span className="tag mono">{on}/{data.skills.length}</span>}
          <button className="mset-ibtn" title="重新扫描" onClick={onReload}><Icon name="refresh" size={14} /></button>
        </div>
      </div>

      <div className="mset-meta">
        <span className="tag mono" title={data?.dir}>{data?.dirLabel ?? 'data/plugin-data/skills'}</span>
      </div>

      <div className="mset-models" style={{ marginTop: 14 }}>
        {data?.skills.length ? data.skills.map((s) => (
          <div className={'mset-mrow' + (s.enabled ? '' : ' off')} key={s.id}>
            <span className="sk-name" title={s.name}>{s.name}</span>
            {s.name !== s.id && <span className="mset-badge mono">{s.id}</span>}
            {!!s.attachments.length && <span className="mset-badge">{s.attachments.length} 文件</span>}
            {s.hasScripts && <span className="mset-badge">脚本</span>}
            <span className="sk-desc" title={s.description}>{s.description || '（未写 description）'}</span>
            <span className="mset-macts"><Switch on={s.enabled} onChange={() => onToggle(s)} /></span>
          </div>
        )) : <div className="mset-group-e">{data ? '还没有技能' : '正在读取…'}</div>}
      </div>

      {err && <div className="sk-err">{err}</div>}
    </section>
  );
}
