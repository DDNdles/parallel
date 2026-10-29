'use client';
/**
 * 首次安装的初始化界面（只在第一次运行时出现）。
 *
 * 与「环境检查页」的分工：检查页每次开机都拦（缺东西就挡），这一页**只负责把新机器一次装好**——
 * 一个「立即安装」，内核按顺序把能自动装的依赖全部装上，装不了的如实标成「需要你处理」。
 *
 * 视觉沿用登录页：同一张 mesh 底、同一个品牌行、同一颗胶囊主钮；面板不加 backdrop-filter
 * （这页是给人读字的，不做透底模糊）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from '@/lib/api';
import { Icon } from '@/components/Icon';

export interface DepItem {
  id: string; label: string; required: boolean;
  state: 'ok' | 'idle' | 'missing'; detail: string; download?: string;
  install?: 'llbot' | 'docker' | 'ffmpeg'; launch?: 'docker';
}
export interface DepsResp { items: DepItem[]; ready: boolean; setupDoneAt: number; managesEnd: boolean }

type StepState = 'queued' | 'running' | 'waiting' | 'ok' | 'skipped' | 'failed' | 'manual';
interface Step { id: string; label: string; state: StepState; detail: string; percent: number | null }
interface Job { running: boolean; startedAt: number; finishedAt: number; steps: Step[]; ready: boolean; error: string }

const POLL_MS = 1200;

/** 状态 → 图标/色档。运行与等待都用转圈：一个是内核在干活，一个是在等安装器/UAC。 */
function markOf(s: StepState): { icon: string; spin?: boolean } {
  switch (s) {
    case 'ok': return { icon: 'done' };
    case 'running': return { icon: 'spinner', spin: true };
    case 'waiting': return { icon: 'spinner', spin: true };
    case 'failed': return { icon: 'warn' };
    case 'manual': return { icon: 'help' };
    case 'skipped': return { icon: 'stop' };
    default: return { icon: 'download' };
  }
}

const TAG_TEXT: Record<StepState, string> = {
  queued: '待安装', running: '进行中', waiting: '进行中', ok: '就绪',
  skipped: '不需要', failed: '失败', manual: '待处理',
};

export default function InitWizard({ deps, onRefresh, onFinish, onSkip, onToggleTheme }: {
  deps: DepsResp;
  /** 重新探测（返回最新依赖状态；失败不影响页面） */
  onRefresh: () => Promise<DepsResp | null>;
  /** 装完/确认后进入登录门（同时记一笔 setupDoneAt） */
  onFinish: () => void;
  onSkip: () => void;
  onToggleTheme: () => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = () => { if (timer.current) clearInterval(timer.current); timer.current = null; };

  const busy = !!job?.running || starting;

  const loadJob = useCallback(async () => {
    try {
      const r = (await get('/api/setup/install-all')) as { job?: Job | null };
      setJob(r.job ?? null);
      return r.job ?? null;
    } catch {
      return null;   // 轮询失败不弹红字：下一次自己会好
    }
  }, []);

  // 页面刷新/从别的标签页回来时接上正在跑的那一轮
  useEffect(() => {
    void loadJob();
    return stopPoll;
  }, [loadJob]);

  // 有任务在跑就轮：跑完再拉一次依赖，保证「进入」用的是新状态
  useEffect(() => {
    if (!job?.running) { stopPoll(); return; }
    timer.current = setInterval(async () => {
      const j = await loadJob();
      if (j && !j.running) {
        stopPoll();
        void onRefresh();
      }
    }, POLL_MS);
    return stopPoll;
  }, [job?.running, loadJob, onRefresh]);

  const start = async () => {
    setErr('');
    setStarting(true);
    try {
      const r = (await post('/api/setup/install-all', {})) as { job?: Job };
      if (r.job) setJob(r.job);
    } catch (e) {
      setErr(`启动安装失败：${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };

  // 行数据：跑着就跟任务（能显示每步进度）；没任务就跟探测结果；
  // 任务已结束则**合并**——探测说 ok 的一律转绿（用户手动补装后点重新检测要立刻反映），
  // 没 ok 的保留任务里的「失败/待处理」说明（比探测的「未安装」更有信息量）。
  const rows: Step[] = (() => {
    const fromDeps = new Map<string, Step>(deps.items.map((it) => [it.id, {
      id: it.id,
      label: it.label,
      state: it.state === 'ok' ? 'ok' : 'queued',
      detail: it.state === 'ok' ? it.detail : (it.state === 'idle' ? '已安装但未启动' : '待安装'),
      percent: it.state === 'ok' ? 100 : null,
    }]));
    if (!job?.steps?.length) return [...fromDeps.values()];
    if (job.running) return job.steps;
    return job.steps.map((j) => {
      const d = fromDeps.get(j.id);
      if (!d) return j;
      if (d.state === 'ok') return { ...j, state: 'ok', detail: d.detail, percent: 100 };
      if (j.state === 'failed' || j.state === 'manual' || j.state === 'skipped') return j;
      return { ...j, state: d.state, detail: d.detail, percent: d.percent };
    });
  })();
  const required = new Map(deps.items.map((i) => [i.id, i.required]));
  const done = rows.filter((r) => r.state === 'ok' || r.state === 'skipped').length;
  const pct = rows.length ? Math.round((done / rows.length) * 100) : 0;
  const blocked = rows.filter((r) => r.state === 'failed' || r.state === 'manual' || r.state === 'waiting').length;
  // 是否放行以**最新探测**为准：任务里的 ready 只是收尾那一刻的结论，
  // 用户手动补装后点「重新检测」不该还被旧任务按住。
  const ready = !busy && deps.ready;

  const primary = (() => {
    if (busy) return { label: '安装中…', action: () => {}, disabled: true };
    if (ready) return { label: '进入控制台', action: onFinish, disabled: false };
    // 装过一轮但没齐：再跑一次只会补装缺的那几项（已就绪的会被跳过）
    if (job && !job.running) return { label: '重试安装', action: () => void start(), disabled: false };
    return { label: '立即安装', action: () => void start(), disabled: false };
  })();

  return (
    <div className="login-overlay">
      <div className="init-panel">
        <div className="setup-brand">
          <Icon name="brand" size={14} />
          <span className="wm"><b>PARALLEL</b></span> console
        </div>

        <div className="init-head">
          <h1 className="init-title">初始化</h1>
          <p className="init-sub">首次运行，把运行环境一次装好。装完这一页不会再出现。</p>
        </div>

        <div className="init-bar" aria-hidden><span style={{ width: `${pct}%` }} /></div>

        <ol className="init-list">
          {rows.map((r, i) => {
            const m = markOf(r.state);
            const req = required.get(r.id);
            return (
              <li key={r.id} className={'init-row is-' + r.state}>
                <span className="init-idx">{String(i + 1).padStart(2, '0')}</span>
                <span className={'init-mark' + (m.spin ? ' wd-spin' : '')}><Icon name={m.icon} size={15} /></span>
                <span className="init-main">
                  <span className="init-name">
                    {r.label}
                    {req !== undefined && <span className="init-req">{req ? '必备' : '可选'}</span>}
                  </span>
                  <span className="init-detail">{r.detail}</span>
                </span>
                <span className="init-right">
                  {r.state === 'running' && r.percent !== null && <span className="init-pct">{r.percent}%</span>}
                  <span className={'init-tag t-' + r.state}>{TAG_TEXT[r.state]}</span>
                </span>
              </li>
            );
          })}
        </ol>

        {job?.error && <div className="setup-err">{job.error}</div>}
        {err && <div className="setup-err">{err}</div>}
        {!busy && job && !job.running && !ready && blocked > 0 && (
          <div className="setup-note">还有 {blocked} 项需要你处理：点「重试安装」补齐，或按提示手动装好后点「重新检测」。</div>
        )}

        <div className="setup-foot">
          <button className="setup-ghost" disabled={refreshing || busy} onClick={() => void refresh()}>
            <Icon name="refresh" size={13} />{refreshing ? '检测中' : '重新检测'}
          </button>
          <button className="setup-skip" disabled={busy} onClick={onSkip}>跳过</button>
          <button className="setup-next" disabled={primary.disabled} onClick={primary.action}>{primary.label}</button>
        </div>

        <div className="setup-theme">
          <button className="chip icon-chip" onClick={onToggleTheme}>
            <span className="theme-btn-ic">
              <span className="glyph glyph-sun"><Icon name="sun" /></span>
              <span className="glyph glyph-moon"><Icon name="moon" /></span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
