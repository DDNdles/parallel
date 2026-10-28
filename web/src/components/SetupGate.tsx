'use client';
/**
 * 初始环境检查页：首次运行（或必备依赖没齐）时排在登录门之前。
 *
 * 背景沿用登录页那张 mesh，但面板**不加 backdrop-filter**——这页是给人读字的，不做透底模糊。
 *
 * 缺失项的两条出路：协议端发行包由内核自己下载（POST /api/setup/install，后台跑，页面轮询进度），
 * 其余第三方软件只给官方下载页链接——parallel 不替人装软件。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from '@/lib/api';
import { Icon } from '@/components/Icon';

interface DepItem {
  id: string; label: string; required: boolean;
  state: 'ok' | 'idle' | 'missing'; detail: string; download?: string;
  install?: 'llbot' | 'docker' | 'ffmpeg'; launch?: 'docker';
}
interface DepsResp { items: DepItem[]; ready: boolean; setupDoneAt: number; managesEnd: boolean }

const POLL_MS = 3000;

/** 内核代下载那条渠道的进度回包（/api/setup/fetch） */
interface FetchState { id: string; dest: string; bytes: number; total: number; done: boolean; error: string }

/** 只有这三项需要解释"是干什么的"（其余项名字自明）。文案一句到底，别替用户扩写。 */
const DEP_HINTS: Record<string, string> = {
  llbot: '登录 QQ 用的协议端本体，可以点这里让它自己下载，也可以去官网拿',
  docker: '工作模式跑脚本与浏览器的强隔离沙箱靠它；没起来时 work 的脚本执行会被直接拒绝，不再降级到宿主机',
  ffmpeg: '语音消息要转成模型能读的格式，缺了语音不进模型',
};

export default function SetupGate({ onPass, onToggleTheme }: {
  onPass: () => void;
  onToggleTheme: () => void;
}) {
  const [data, setData] = useState<DepsResp | null>(null);
  const [err, setErr] = useState('');
  const [rechecking, setRechecking] = useState(false);
  /** 正在等哪一项变就绪（下载 / 启动都是这一条路） */
  const [waitingId, setWaitingId] = useState('');
  /** 内核代下载的百分比（只有走 /api/setup/fetch 那条渠道才有） */
  const [pct, setPct] = useState(0);
  /** 下载完成后的那句话（装不装由人，所以 Docker 要说清东西放哪儿了） */
  const [note, setNote] = useState('');
  const passedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };

  const pass = useCallback(() => {
    if (passedRef.current) return;
    passedRef.current = true;
    if (pollRef.current) clearInterval(pollRef.current);
    onPass();
  }, [onPass]);

  const load = useCallback(async (fresh: boolean) => {
    if (fresh) setRechecking(true);
    try {
      const d = (await get(`/api/setup/deps${fresh ? '?fresh=1' : ''}`)) as DepsResp;
      setData(d);
      setErr('');
      // 已经走过这一页：不再重复拦截。以前还要求「当前环境全绿」，于是某次开机
      // Docker Desktop 没先起来就又把人挡回去——环境问题在控制台/报错中心可见，不该堵登录。
      if (!fresh && d.setupDoneAt > 0) pass();
      return d;
    } catch (e) {
      setErr(`读不到环境状态：${(e as Error).message}`);
      return null;
    } finally {
      setRechecking(false);
    }
  }, [pass]);

  useEffect(() => { void load(false); return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, [load]);

  /**
   * 让内核代办一件事，然后轮到达标。两条路：
   * - 代下载（docker/ffmpeg）：轮 /api/setup/fetch 看字节数，下完报落脚点（Docker 的包**不代装**）；
   * - 其余（发行包就位、拉起 Docker Desktop）：轮 /api/setup/deps?fresh=1 直到那一项变 ok。
   */
  const runOnKernel = async (path: string, body: Record<string, string>, id: string) => {
    setErr('');
    setNote('');
    try {
      const r = await post(path, body) as { state?: FetchState };
      setWaitingId(id);
      stopPoll();
      const job = r?.state;
      if (job && path.endsWith('/install')) {
        pollRef.current = setInterval(async () => {
          const f = (await get(`/api/setup/fetch?id=${encodeURIComponent(id)}`).catch(() => null)) as { state?: FetchState } | null;
          const s = f?.state;
          if (!s) return;
          setPct(s.total ? Math.min(99, Math.floor((s.bytes / s.total) * 100)) : 0);
          if (s.error) { stopPoll(); setWaitingId(''); setPct(0); setErr(`下载失败：${s.error}`); return; }
          if (s.done) {
            stopPoll(); setWaitingId(''); setPct(0);
            // Docker 装不装是人的事（要管理员权限、会动 Hyper-V/WSL），内核不静默跑别人的安装程序
            setNote(id === 'docker' ? `安装器已放在 ${s.dest}，双击装好后回来点「启动」` : '已就位');
            await load(true);
          }
        }, 1500);
        return;
      }
      pollRef.current = setInterval(async () => {
        const d = await load(true);
        if (d && d.items.find((i) => i.id === id)?.state === 'ok') {
          stopPoll();
          setWaitingId('');
        }
      }, POLL_MS);
    } catch (e) {
      setErr((e as Error).message === 'unauthorized' ? '内核令牌不匹配：重启内核' : `操作失败：${(e as Error).message}`);
    }
  };

  const next = async () => {
    try { await post('/api/setup/done', {}); } catch { /* 记不上时间戳也要让人进去，下次再看一眼这页而已 */ }
    pass();
  };

  const items = data?.items ?? [];
  const ready = !!data?.ready;

  return (
    <div className="login-overlay">
      <div className="setup-panel">
        <div className="setup-brand">
          <Icon name="brand" size={14} />
          <span className="wm"><b>PARALLEL</b></span> console
        </div>

        <h1 className="setup-title">环境检查</h1>

        <div className="setup-rows">
          {!data && !err && <div className="setup-loading">探测中…</div>}
          {items.map((it) => {
            const ok = it.state === 'ok';
            const waiting = waitingId === it.id;
            const hint = DEP_HINTS[it.id];
            // 协议端发行包只有带桌面端的内核才托管（noApi 测试内核绝不能下），其余代下载项都能点
            const canInstall = !!it.install && (it.install !== 'llbot' || !!data?.managesEnd);
            return (
              // 只留名字：探测到的版本/路径不再挂悬停注释，需要解释的那三项改走问号浮卡
              <div key={it.id} className={'setup-row ' + (ok ? 'ok' : it.state === 'idle' ? 'idle' : it.required ? 'bad' : 'opt')}>
                <span className="setup-mark"><Icon name={ok ? 'done' : 'warn'} size={15} /></span>
                <span className="setup-name">
                  {it.label}
                  {hint && (
                    <span className="mset-hint" tabIndex={0} aria-label={hint}>
                      <Icon name="help" size={13} />
                      <span className="mset-hint-pop">{hint}</span>
                    </span>
                  )}
                  <span className="setup-tag">{it.required ? '必备' : '可选'}</span>
                </span>
                {/* 装了但没跑（idle）：要的是「启动」，给下载钮就是误导 */}
                {it.state === 'idle' && it.launch === 'docker' && (
                  <button className="setup-get" disabled={waiting} onClick={() => void runOnKernel('/api/setup/start', { id: 'docker' }, 'docker')}>
                    <Icon name="upload" size={13} />{waiting ? '启动中' : '启动'}
                  </button>
                )}
                {/* 缺一项给两个渠道：pill = 让内核代下（带进度），旁边的裸链接 = 自己去官网拿 */}
                {it.state === 'missing' && canInstall && (
                  <button className="setup-get" disabled={waiting} onClick={() => void runOnKernel('/api/setup/install', { id: it.install! }, it.id)}>
                    <Icon name="download" size={13} />{waiting ? (pct ? `下载中 ${pct}%` : '下载中') : '下载'}
                  </button>
                )}
                {/* 只有缺的东西才给下载入口；已经装好的不挂链接（全站口径：解释性/冗余的字删掉） */}
                {it.state === 'missing' && it.download && (canInstall ? (
                  <a className="setup-link" href={it.download} target="_blank" rel="noreferrer">官网</a>
                ) : (
                  <a className="setup-get" href={it.download} target="_blank" rel="noreferrer">
                    <Icon name="download" size={13} />下载
                  </a>
                ))}
              </div>
            );
          })}
        </div>

        {note && <div className="setup-note">{note}</div>}
        {err && <div className="setup-err">{err}</div>}

        <div className="setup-foot">
          <button className="setup-ghost" disabled={rechecking} onClick={() => void load(true)}>
            <Icon name="refresh" size={13} />{rechecking ? '检测中' : '重新检测'}
          </button>
          {/* 探测本身坏了也别把人锁死：跳过只是这次不拦，下次进来还会看到这一页 */}
          <button className="setup-skip" onClick={pass}>跳过</button>
          {ready ? (
            <button className="setup-next" onClick={next}>继续</button>
          ) : (
            <button className="setup-next" disabled>必备项未齐</button>
          )}
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
