'use client';
/**
 * parallel 桌面端主程序（Next.js 静态导出，纯客户端 SPA）。
 * 状态机：登录门（账号卡 / 接入引导）→ 主壳（侧栏 + 顶栏 + 各页面）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, connectWS, onEvent } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { useThemeSwitch } from '@/components/useThemeSwitch';
import type { PageCmd } from '@/lib/pageCmd';
import GlassDefs from '@/components/GlassDefs';
import LoginGate from '@/components/LoginGate';
import SetupGate from '@/components/SetupGate';
import ChatsPage from '@/components/pages/ChatsPage';
import PluginsPage from '@/components/pages/PluginsPage';
import PersonasPage from '@/components/pages/PersonasPage';
import ModelsPage from '@/components/pages/ModelsPage';
import UsersPage from '@/components/pages/UsersPage';
import ErrorsPage from '@/components/pages/ErrorsPage';
import WorkPage from '@/components/pages/WorkPage';
import SandboxPage from '@/components/pages/SandboxPage';
import UsagePage from '@/components/pages/UsagePage';
import SettingsPage from '@/components/pages/SettingsPage';

export interface AppState {
  adapter: { connected: boolean; selfId?: string; selfNickname?: string; endpoint?: string; mode?: string };
  model: { provider: string; model: string; usable: { ok: boolean } };
  providers: { id: string; label: string; model: string; implemented: boolean; enabled: boolean; configured: boolean }[];
  usage: { promptTokens: number; completionTokens: number; llmCalls: number; outMessages?: number };
  plugins: { total: number; loaded: number };
  errors: number;
  masterIds: string[];
  uptimeMs: number;
}

export const PAGES: { id: string; name: string; nav: string; icon: string }[] = [
  { id: 'chats', name: '会话', nav: '会话', icon: 'chats' },
  { id: 'usage', name: '用量', nav: '用量', icon: 'usage' },
  { id: 'plugins', name: '插件', nav: '插件', icon: 'plugins' },
  { id: 'personas', name: '人格', nav: '人格', icon: 'personas' },
  { id: 'models', name: '模型', nav: '模型', icon: 'models' },
  { id: 'users', name: '用户', nav: '用户', icon: 'users' },
  { id: 'errors', name: '报错', nav: '报错', icon: 'errors' },
  { id: 'work', name: '工作', nav: '工作', icon: 'work' },
  { id: 'sandbox', name: '沙箱', nav: '沙箱', icon: 'file' },
  { id: 'settings', name: '设置', nav: '设置', icon: 'settings' },
];
const ALL_PAGES = PAGES;

/** 各页顶栏的圆形工具钮（与页面内的动作走同一条 usePageCmd 通道） */
const PAGE_TOOLS: Record<string, { id: string; icon: string; title: string; kind: string }[]> = {
  plugins: [
    { id: 'btn-plugins-reload', icon: 'refresh', title: '重新读取插件', kind: 'reload' },
    { id: 'btn-plugins-install', icon: 'plus', title: '扫描安装用户插件（data/plugins）', kind: 'install' },
    { id: 'btn-plugins-matrix', icon: 'group', title: '分群开关矩阵', kind: 'matrix' },
  ],
  personas: [
    { id: 'btn-personas-reload', icon: 'refresh', title: '重新读取人格', kind: 'reload' },
    { id: 'btn-personas-add', icon: 'plus', title: '新建人格', kind: 'add' },
  ],
  models: [
    { id: 'btn-models-reload', icon: 'refresh', title: '重新读取配置', kind: 'reload' },
    { id: 'btn-models-add', icon: 'plus', title: '添加供应商', kind: 'add' },
  ],
  users: [
    { id: 'btn-users-reload', icon: 'refresh', title: '重新读取用户', kind: 'reload' },
    { id: 'btn-users-export', icon: 'download', title: '导出全部记忆为 JSON', kind: 'export' },
    { id: 'btn-users-import', icon: 'upload', title: '从 JSON 导入记忆', kind: 'import' },
    { id: 'btn-users-roles', icon: 'write', title: '主人与管理员名单', kind: 'roles' },
  ],
  errors: [
    { id: 'btn-errors-reload', icon: 'refresh', title: '重新读取报错', kind: 'reload' },
    { id: 'btn-errors-clear', icon: 'trash', title: '清除全部记录', kind: 'clear' },
  ],
  work: [{ id: 'btn-work-reload', icon: 'refresh', title: '重新读取工作状态', kind: 'reload' }],
  usage: [{ id: 'btn-usage-reload', icon: 'refresh', title: '重新拉取用量', kind: 'reload' }],
  sandbox: [
    { id: 'btn-sandbox-reload', icon: 'refresh', title: '重新读取沙箱', kind: 'reload' },
    { id: 'btn-sandbox-limits', icon: 'settings', title: '限额与清理', kind: 'limits' },
  ],
};
/** 一级侧栏「只留图标」的窄轨宽度（同时是默认宽度）= 右边框 1 + nav 内边距 10×2 + 按钮内边距 10×2 + 图标 16 */
const SIDE_ICON_W = 57;
/** 有二级侧栏的页面：内容区 no-pad（贴合主侧栏），由页面内部自行布局 */
const SUBNAV_PAGES = new Set(['chats']);
/** 窄到放不下「二级列表 + 内容」并排时，会话列表改覆盖式抽屉（顶栏那颗钮才唤得出来） */
const NARROW_Q = '(max-width: 720px)';

export default function App() {
  const [entered, setEntered] = useState(false);
  /** 初始环境检查页是否已过（SetupGate 自己判定：走过且环境齐就直接放行到登录门） */
  const [setupPassed, setSetupPassed] = useState(false);
  const [page, setPage] = useState('chats');
  /** 会话页右侧「工作」抽屉（按钮在顶栏，抽屉本体在 ChatsPage 里） */
  const [workOpen, setWorkOpen] = useState(false);
  const [sideW, setSideW] = useState(SIDE_ICON_W);
  /** 会话页二级列表在窄屏是抽屉：开合状态由顶栏那颗钮控制（抽屉本体在 ChatsPage） */
  const [listOpen, setListOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  /** 会话页正在回看的那一天：非空时顶栏亮出「回到实时」（钮在这，动作回到 ChatsPage） */
  const [reviewDay, setReviewDay] = useState('');
  /** 顶栏圆钮 → 页面的一次性指令通道（page 标明发给谁，n 递增触发一次） */
  const [pageCmd, setPageCmd] = useState<PageCmd>({ page: '', kind: '', n: 0 });
  const [state, setState] = useState<AppState | null>(null);
  const [errBadge, setErrBadge] = useState(0);
  /** 磁盘上的 ui/ 比本页加载的那份新：顶栏亮一颗「界面已更新」，由用户点 */
  const [staleBuild, setStaleBuild] = useState(false);
  const buildRef = useRef(typeof window === 'undefined' ? '' : String((window as { __UI_BUILD__?: number }).__UI_BUILD__ ?? ''));
  const bootedRef = useRef(false);
  const draggingRef = useRef(false);

  // 侧栏永久常驻，可拖拽调宽：下限「只留图标」的窄轨，上限视口 30%（窄屏保底 160）
  const clampSide = useCallback((w: number) => {
    const max = Math.max(160, window.innerWidth * 0.3);
    return Math.round(Math.min(Math.max(w, SIDE_ICON_W), max));
  }, []);
  useEffect(() => {
    setSideW(clampSide(Number(localStorage.getItem('parallel_side_width')) || SIDE_ICON_W));
    const move = (e: MouseEvent) => { if (draggingRef.current) setSideW(clampSide(e.clientX)); };
    const up = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.classList.remove('resizing');
    };
    const resize = () => setSideW((w) => clampSide(w));
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('resize', resize);
    };
  }, [clampSide]);
  useEffect(() => { localStorage.setItem('parallel_side_width', String(sideW)); }, [sideW]);

  const { theme, toggle } = useThemeSwitch();

  // 左下角身份卡：登录号与昵称，协议端还没把登录信息报上来时先是空
  const selfId = String(state?.adapter?.selfId || '');
  const selfNick = String(state?.adapter?.selfNickname || '');
  const [avOK, setAvOK] = useState(true);
  useEffect(() => { setAvOK(true); }, [selfId]);   // 换号后重新试头像

  // 状态轮询 + 错误徽标。/api/state 401（内核重启换了 token）→ 弹回登录门重新校验。
  // QQ 的登录态是挡路的：登录门只在真在线时放行，主壳里持续复核，掉了/退了弹回登录门（见下方 offlineRef）。
  const refreshStatus = useCallback(async () => {
    try {
      const s = await get('/api/state');
      setState(s);
    } catch (e) {
      // 401：内核换了 token，回登录门重新校验（那里能粘新令牌）
      if ((e as Error).message === 'unauthorized') { bootedRef.current = false; setEntered(false); }
      return;
    }
  }, []);
  const updateErrBadge = useCallback(async () => {
    try {
      const s = await get('/api/state');
      setErrBadge(s.errors ?? 0);
      // 站内换页不会重新下载 JS：构建换了就亮一颗钮，点一下才刷新（绝不在用户输入时自己跳）
      const b = String(s.uiBuild ?? '');
      if (buildRef.current && b && b !== buildRef.current) setStaleBuild(true);
    } catch { /* ignore */ }
  }, []);

  const enterApp = useCallback(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    setEntered(true);
    connectWS();
    refreshStatus();
    void updateErrBadge();
    if (!intervalsRef.current) {
      intervalsRef.current = true;
      setInterval(refreshStatus, 10000);
      setInterval(updateErrBadge, 30000);
      onEvent('error.recorded', updateErrBadge);
    }
  }, [refreshStatus, updateErrBadge]);


  // 会话被弹回令牌恢复卡（401）后再进主壳时，恢复各轮询（interval 句柄只建一次）
  const intervalsRef = useRef(false);

  // QQ 掉了/退了必须把人弹回登录门（connected 以协议端自报的在线判据为准，不是反向 WS）。
  // 可靠性红线：内核重启、协议端重启、一次网络抖动都不算退出——连续两轮（≈8s）读到离线才踢。
  const offlineRef = useRef(0);
  useEffect(() => {
    offlineRef.current = 0;
    if (!entered) return;
    let alive = true;
    const timer = setInterval(async () => {
      let connected: boolean | undefined;
      try {
        connected = ((await get('/api/login/status')) as { connected: boolean }).connected;
      } catch { return; }  // 读不到状态不判离线
      if (!alive) return;
      offlineRef.current = connected ? 0 : offlineRef.current + 1;
      if (offlineRef.current >= 2) {
        bootedRef.current = false;   // 否则 enterApp 的 booted 闸门会让登录门进不去第二次
        setEntered(false);
      }
    }, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [entered]);

  // 离开会话页就把「工作」抽屉的开启状态清掉，回来时不会自己弹开
  useEffect(() => { if (page !== 'chats') setWorkOpen(false); }, [page]);
  useEffect(() => { if (page !== 'chats') setListOpen(false); }, [page]);
  // 窄屏判定：只用 matchMedia，别在 resize 里读 innerWidth（拖窗口时每帧都 setState）
  useEffect(() => {
    const mq = window.matchMedia(NARROW_Q);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  useEffect(() => { if (!narrow) setListOpen(false); }, [narrow]);

  if (!entered) {
    if (!setupPassed) {
      return <SetupGate onPass={() => setSetupPassed(true)} onToggleTheme={toggle} />;
    }
    return <LoginGate onEnter={enterApp} state={state} refreshStatus={refreshStatus} onToggleTheme={toggle} />;
  }


  const def = ALL_PAGES.find((p) => p.id === page) ?? ALL_PAGES[0];

  const pageEl = (() => {
    switch (page) {
      case 'chats': return <ChatsPage masterId={state?.masterIds?.[0]} botId={selfId} onNavigate={setPage} workOpen={workOpen} onCloseWork={() => setWorkOpen(false)} narrow={narrow} listOpen={listOpen} onCloseList={() => setListOpen(false)} cmd={pageCmd} onReview={setReviewDay} />;
      case 'plugins': return <PluginsPage cmd={pageCmd} />;
      case 'personas': return <PersonasPage cmd={pageCmd} />;
      case 'models': return <ModelsPage onChanged={refreshStatus} cmd={pageCmd} />;
      case 'users': return <UsersPage cmd={pageCmd} />;
      case 'errors': return <ErrorsPage cmd={pageCmd} />;
      case 'work': return <WorkPage cmd={pageCmd} />;
      case 'sandbox': return <SandboxPage cmd={pageCmd} />;
      case 'usage': return <UsagePage cmd={pageCmd} />;
      case 'settings': return <SettingsPage />;
      default: return null;
    }
  })();

  return (
    <div className="app">
      {/* 液态玻璃滤镜（顶栏 backdrop-filter 引用） */}
      <GlassDefs />
      <aside className={'sidebar' + (sideW <= SIDE_ICON_W ? ' rail' : '')} style={{ width: sideW }}>
        <div className="logo">
          <span className="mark"><Icon name="brand" size={22} /></span>
          <span className="wm"><b>PARALLEL</b></span>
        </div>
        <nav aria-label="主导航">
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={'nav-item' + (p.id === page ? ' active' : '')}
              onClick={() => setPage(p.id)}
            >
              <Icon name={p.icon} size={16} />
              <span>{p.nav}</span>
              {p.id === 'errors' && errBadge > 0 && <span className="badge">{errBadge}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {/* 登录号身份卡：头像（右下角挂事件流状态点）+ 昵称。
              头像走内核代理 /api/login/avatar（qlogo 有防盗链/跨域，必须由内核转），
              取不到图时回落到昵称首字。 */}
          <span className="acct">
            <span className="acct-av">
              {selfId && avOK
                ? <img src={`/api/login/avatar/${encodeURIComponent(selfId)}`} alt="" onError={() => setAvOK(false)} />
                : <span className="acct-ph">{selfNick.slice(0, 1) || '?'}</span>}
              <span id="ws-dot" className="dot dot-off" role="img" aria-label="事件流连接状态" />
            </span>
            <span className="acct-nick">{selfNick || '未登录'}</span>
          </span>
        </div>
        <div
          className="side-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整侧栏宽度"
          onMouseDown={(e) => { draggingRef.current = true; document.body.classList.add('resizing'); e.currentTarget.classList.add('dragging'); }}
          onMouseMove={(e) => { (e.currentTarget as HTMLElement).style.setProperty('--handle-y', `${e.clientY - e.currentTarget.getBoundingClientRect().top}px`); }}
          onMouseUp={(e) => e.currentTarget.classList.remove('dragging')}
          onMouseLeave={(e) => e.currentTarget.classList.remove('dragging')}
        />
      </aside>

      <main className="main">
        <header className="topbar">
          <span className="tb-title">{def.name}</span>
          <span className="tb-flex" />
          {staleBuild && (
            <button className="chip" id="btn-reload" title="界面已重新构建（站内换页不会重新下载 JS），点这里刷新才拿到新版"
              onClick={() => location.reload()}>界面已更新</button>
          )}
          {page === 'chats' && narrow && (
            <button
              className={'chip icon-chip' + (listOpen ? ' on' : '')}
              id="btn-chat-list"
              aria-pressed={listOpen}
              aria-label="会话列表"
              title="会话列表"
              onClick={() => setListOpen((v) => !v)}
            >
              <Icon name="chats" />
            </button>
          )}
          {page === 'chats' && (
            <button
              className={'chip icon-chip' + (workOpen ? ' on' : '')}
              id="btn-work"
              aria-pressed={workOpen}
              aria-label="当前会话的工作"
              title="工作"
              onClick={() => setWorkOpen((v) => !v)}
            >
              <Icon name="work" />
            </button>
          )}
          {(PAGE_TOOLS[page] ?? []).map((t) => (
            <button key={t.id} className="chip icon-chip" id={t.id} title={t.title} aria-label={t.title}
              onClick={() => setPageCmd((c) => ({ page, kind: t.kind, n: c.n + 1 }))}>
              <Icon name={t.icon} />
            </button>
          ))}
          {page === 'chats' && reviewDay && (
            <button
              className="chip icon-chip"
              id="btn-live"
              aria-label="回到实时"
              title="回到实时"
              onClick={() => setPageCmd((c) => ({ page: 'chats', kind: 'live', n: c.n + 1 }))}
            >
              <Icon name="download" />
            </button>
          )}
          <button className="chip icon-chip" id="btn-theme" onClick={toggle}>
            <span className="theme-btn-ic">
              <span className="glyph glyph-sun"><Icon name="sun" /></span>
              <span className="glyph glyph-moon"><Icon name="moon" /></span>
            </span>
          </button>
        </header>
        <section className={'content' + (SUBNAV_PAGES.has(page) ? ' no-pad' : '')} id="content">
          {pageEl}
        </section>
      </main>
    </div>
  );
}
