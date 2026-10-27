'use client';
/**
 * 会话页 —— Codex 任务页形态：
 * 会话列表（置顶/群聊/私聊 三组可折叠，长名渐隐，右键/悬停置顶删除）+ 居中会话列
 * + 宽卡片 composer（双模型选择 pill + parallel 品牌 mark 插入光标）
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { get, post, onEvent, fmtTime, mdLite, getToken } from '@/lib/api';
import { isWorkEntry } from '@/lib/entries';
import { Icon } from '@/components/Icon';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';
import { QQ_FACE_NAMES } from '@/lib/qqFaceNames';
import WorkDrawer from '@/components/WorkDrawer';
import { Modal } from '@/components/Modal';

interface ChatInfo { chatKey: string; chatId: string; chatType: string; lastTs: number; title?: string }
interface Entry {
  type: string; chatId?: string; chatType?: string; ts?: number; text?: string;
  userId?: string; nickname?: string; data?: any;
}
interface Provider {
  id: string; label: string; model: string; implemented: boolean; enabled: boolean;
  configured: boolean; hasKey: boolean;
  config: { model?: string; baseUrl?: string; models?: { id: string; contextWindow?: number }[] };
}
interface ChainEntry { provider: string; model: string; fails: number; state: 'current' | 'idle' | 'down' }
interface ModelsData {
  active: string; activeModel: string; providers: Provider[];
  /** 两条模型优先级链：靠前的优先，掉线自动接后一条 */
  chains: { chat: ChainEntry[]; work: ChainEntry[] };
  failoverThreshold: number;
}

const MAX_TURNS = 400;
/** 日轨没量到高度时的兜底格数，以及一节的间距（热区 12px + gap 2px，与 .conv-rail 一致） */
const RAIL_VIEW = 10;
const RAIL_PITCH = 14;
/** 会话左侧日轨的一格（内核按本地日期聚合整份 jsonl 算出来的） */
interface ChatDay { day: string; count: number; firstTs: number; lastTs: number }

export default function ChatsPage({ botId, workOpen, onCloseWork, narrow, listOpen, onCloseList, cmd, onReview }: {
  /** 保留给调用方传参兼容：输入框已改为 bot 身份发言，测试用户注入不再由页面发起 */
  masterId?: string;
  /** bot 自己的登录号：会话流里 bot 那条消息右侧的头像用它取图 */
  botId?: string;
  onNavigate?: (page: string) => void;
  /** 顶栏「工作」按钮的开关状态（抽屉本体在这里渲染） */
  workOpen?: boolean;
  onCloseWork?: () => void;
  /** 窄屏（≤720）：二级会话列表改覆盖式抽屉，开合状态在顶栏那颗钮上 */
  narrow?: boolean;
  listOpen?: boolean;
  onCloseList?: () => void;
  /** 顶栏「回到实时」的页指令（kind='live'） */
  cmd?: PageCmd;
  /** 把「正在回看哪一天」报给顶栏：非空时顶栏才亮出那颗钮 */
  onReview?: (day: string) => void;
}) {
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [current, setCurrent] = useState<{ key: string; type: string; id: string } | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [models, setModels] = useState<ModelsData | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  // 是否停在最底部（贴着最新消息）：是则收起渐隐遮罩——停在底部时最新消息要能看清，
  // 往上翻（正在滑动/读历史）才让下缘淡出
  const [atBottom, setAtBottom] = useState(true);
  /** 左侧日轨：一格 = 有消息的一天；railTop 是可见窗口的起点，窗口大小按列高实测（装不下才滚轮滑） */
  const [days, setDays] = useState<ChatDay[]>([]);
  const [railTop, setRailTop] = useState(0);
  const [railView, setRailView] = useState(RAIL_VIEW);
  const railRef = useRef<HTMLDivElement>(null);
  /** 回看时已经加载的日子区间（days 下标）：滑到顶就往前并一天、滑到底就往后追一天。null = 实时窗口 */
  const dayWinRef = useRef<{ from: number; to: number } | null>(null);
  const daysRef = useRef<ChatDay[]>([]);
  const edgeBusyRef = useRef(false);
  /** 上一次 scrollTop（判划动方向用）与"刚跳过天，先别翻页"的短锁时刻 */
  const lastScrollTopRef = useRef(0);
  const edgeLockRef = useRef(0);
  /** 往前并了一天之后多出来的高度：布局阶段补回 scrollTop，视野才不会被推走 */
  const prependHRef = useRef(0);
  /** 回看的那一天（'' = 实时窗口）。回看态下新消息不追加进列表，看完点箭头回实时 */
  const [viewDay, setViewDay] = useState('');
  const viewDayRef = useRef('');
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [animatingId, setAnimatingId] = useState<string | null>(null); // 正在开合的分组 id：淡化 mask 只作用于该分组自身
  const [listW, setListW] = useState(250);
  /** 会话页预览（群友头像 + 收来的图片缩略图）：设置页「会话」里的那个开关 */
  const [preview, setPreview] = useState(true);
  const [zoom, setZoom] = useState<{ rel: string; name: string } | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const listDragRef = useRef(false);
  /** mousedown 时缓存的会话列表左边界 + 元素本身 + 一帧合并一次写入（避免拖拽时读写布局互相打架） */
  const listElRef = useRef<HTMLElement>(null);
  const listLeftRef = useRef(0);
  const listPendingRef = useRef<number | null>(null);
  const listRafRef = useRef(0);
  /** 消息列惰性布局用的三个 ref：容器、每行的稳定键、每行的实测高度 */
  const colRef = useRef<HTMLDivElement>(null);
  const rowKeysRef = useRef<string[]>([]);
  const rowHeightsRef = useRef(new Map<string, number>());
  /** 上一次做"全量重量"时的列宽：宽度没变就不用重排所有行 */
  const measuredWRef = useRef(0);

  // 会话列表宽：下限 160px，上限视口 40%
  const clampListW = useCallback((w: number) => {
    const max = Math.max(160, Math.round(window.innerWidth * 0.4));
    return Math.round(Math.min(Math.max(w, Math.min(160, max)), max));
  }, []);

  // 会话列表 + 偏好（置顶/隐藏存内核配置，按 bot 登录号区分，随 QQ 账号走）
  const loadChats = useCallback(() => { get('/api/chats').then(setChats).catch(() => {}); }, []);
  useEffect(() => {
    loadChats();
    // 旧版 localStorage 数据一次性迁移到服务端
    const legacyPin = localStorage.getItem('parallel_pinned_chats');
    const legacyHide = localStorage.getItem('parallel_hidden_chats');
    if (legacyPin || legacyHide) {
      const parse = (s: string | null) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
      post('/api/chat-prefs', { pinned: parse(legacyPin), hidden: parse(legacyHide) })
        .then(() => { localStorage.removeItem('parallel_pinned_chats'); localStorage.removeItem('parallel_hidden_chats'); })
        .catch(() => {});
    }
    get('/api/chat-prefs').then((p: { pinned?: string[]; hidden?: string[]; listWidth?: number }) => {
      setPinned(new Set(p.pinned ?? []));
      setHidden(new Set(p.hidden ?? []));
      if (p.listWidth) setListW(clampListW(p.listWidth));
    }).catch(() => {});
  }, [loadChats, clampListW]);

  // 会话名可能后到（群名按需补、陌生人昵称随消息带上来），收到消息顺带刷新列表；
  // 群聊刷屏时按 8 秒节流，别把 /api/chats 也拖着一起打
  useEffect(() => {
    let last = 0;
    return onEvent('session.log', () => {
      const t = Date.now();
      if (t - last < 8000) return;
      last = t;
      loadChats();
    });
  }, [loadChats]);

  // 拖拽调宽（与主侧栏同模式：window 级 mousemove/mouseup，松手即止）
  useEffect(() => {
    const flush = () => {
      if (listRafRef.current) { cancelAnimationFrame(listRafRef.current); listRafRef.current = 0; }
      const w = listPendingRef.current;
      listPendingRef.current = null;
      if (w != null) setListW(w);
    };
    const move = (e: MouseEvent) => {
      if (!listDragRef.current) return;
      // 左边界在 mousedown 时缓存过了：每帧都去 querySelector + getBoundingClientRect 会形成
      // "读→写→读"的强制同步布局，消息一多就掉帧
      const w = clampListW(e.clientX - listLeftRef.current);
      listElRef.current?.style.setProperty('width', `${w}px`);   // 先落 DOM：立刻跟手
      listPendingRef.current = w;
      if (listRafRef.current) return;
      listRafRef.current = requestAnimationFrame(() => {
        listRafRef.current = 0;
        const v = listPendingRef.current;
        listPendingRef.current = null;
        if (v != null) setListW(v);
      });
    };
    const up = () => {
      if (!listDragRef.current) return;
      listDragRef.current = false;
      flush();
      document.body.classList.remove('resizing');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      if (listRafRef.current) cancelAnimationFrame(listRafRef.current);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [clampListW]);

  // 偏好变更后写回内核（对 Set 做了不可变替换，引用变化即可靠触发）
  const prefsRef = useRef({ pinned, hidden, listW });
  prefsRef.current = { pinned, hidden, listW };
  useEffect(() => {
    const t = setTimeout(() => {
      post('/api/chat-prefs', { pinned: [...prefsRef.current.pinned], hidden: [...prefsRef.current.hidden], listWidth: prefsRef.current.listW }).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [pinned, hidden, listW]);

  // 模型（chat + work）：进入页面拉一次；右侧抽屉的上下文占比圆环要按模型窗口当分母
  const loadModels = useCallback(() => { get('/api/providers').then(setModels).catch(() => {}); }, []);
  useEffect(loadModels, [loadModels]);

  // 插入光标：文字由文本层显示、光标是文本层里的内联元素（自己占一格，把后面的字挤开）。
  // 这里只做两件事：把光标位（选区起点）与焦点态同步给文本层，以及把 textarea 的滚动位移带过去。
  const [caretPos, setCaretPos] = useState(0);
  const [caretOn, setCaretOn] = useState(false);
  const syncCaret = useCallback(() => {
    const ta = inputRef.current, layer = textRef.current;
    if (!ta) return;
    const focused = document.activeElement === ta;
    const collapsed = ta.selectionStart === ta.selectionEnd;
    setCaretOn(focused && collapsed);   // 选中一段文字时不摆光标（否则会把选区撑开）
    if (focused && collapsed) setCaretPos(ta.selectionStart ?? ta.value.length);
    if (layer) {
      // 让层自己滚，别用 transform——那会把裁剪框一起搬走，长消息滚起来时整块文字飘到输入框外
      if (layer.scrollTop !== ta.scrollTop) layer.scrollTop = ta.scrollTop;
    }
  }, []);

  useEffect(() => { syncCaret(); }, [input, current, syncCaret]);
  useEffect(() => {
    // 光标移动的真实信号：点选、方向键、拖选都会触发 selectionchange；
    // 焦点进出/点按再补一轮（延后一拍等 activeElement 落定；用定时器而非 rAF——被遮挡的标签页 rAF 会停摆）
    const onFocusShift = () => { setTimeout(syncCaret, 0); };
    document.addEventListener('selectionchange', syncCaret);
    document.addEventListener('focusin', onFocusShift);
    document.addEventListener('focusout', onFocusShift);
    document.addEventListener('mousedown', onFocusShift);
    window.addEventListener('resize', syncCaret);
    return () => {
      document.removeEventListener('selectionchange', syncCaret);
      document.removeEventListener('focusin', onFocusShift);
      document.removeEventListener('focusout', onFocusShift);
      document.removeEventListener('mousedown', onFocusShift);
      window.removeEventListener('resize', syncCaret);
    };
  }, [syncCaret]);

  const togglePin = useCallback((key: string) => {
    setPinned((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);
  const toggleHide = useCallback((key: string) => {
    setHidden((p) => { const n = new Set(p); n.add(key); return n; });
    setCurrent((c) => (c && c.key === key ? null : c));
  }, []);
  const unhide = useCallback((key: string) => {
    setHidden((p) => { const n = new Set(p); n.delete(key); return n; });
  }, []);

  // 分组渲染数据：置顶 / 群聊 / 私聊（隐藏的不进组）
  const groups = useMemo(() => {
    const visible = chats.filter((c) => !hidden.has(c.chatKey));
    const byOrder = (list: ChatInfo[]) => [...list].sort((a, b) => b.lastTs - a.lastTs);
    const pin = byOrder(visible.filter((c) => pinned.has(c.chatKey)));
    const groups = visible.filter((c) => !pinned.has(c.chatKey) && c.chatType === 'group');
    const privates = visible.filter((c) => !pinned.has(c.chatKey) && c.chatType !== 'group');
    return [
      { id: 'pinned', label: '置顶', icon: 'pin', items: pin },
      { id: 'group', label: '群聊', icon: 'group', items: byOrder(groups) },
      { id: 'private', label: '私聊', icon: 'friend', items: byOrder(privates) },
    ].filter((g) => g.items.length > 0 || g.id !== 'pinned');
  }, [chats, pinned, hidden]);

  const chatTitle = useCallback((c: ChatInfo) => c.title || `${c.chatType === 'group' ? '群' : '私聊'} ${c.chatId}`, []);
  /** 模型 id -> 上下文窗口：右侧「工作」面板的占比圆环用它当分母 */
  const ctxByModel = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of models?.providers ?? []) for (const mm of p.config?.models ?? []) if (mm.contextWindow) m[mm.id] = mm.contextWindow;
    return m;
  }, [models]);

  // 预览开关在设置页「会话」里改；回到这页会重挂载，所以拉一次就够
  useEffect(() => {
    get('/api/config').then((d: { ui?: { chatPreview?: boolean } }) => setPreview(d?.ui?.chatPreview !== false)).catch(() => {});
  }, []);
  /** 缩略图与大图都走沙箱 raw 端点：<img> 带不上请求头，按 ws 的同款写法用 ?token= */
  const srcOf = useCallback((rel: string) => '/api/sandbox/raw?chat=' + encodeURIComponent(current?.key ?? '')
    + '&path=' + encodeURIComponent(rel) + '&token=' + encodeURIComponent(getToken()), [current?.key]);

  // 消息号 → 条目：给引用块兜底。内核快照是落账那一刻抄的，改口之前的条目没带附件（甚至没带快照），
  // 只要被引用那条还在已加载的流里，这里就能现查出来，不必等用户重新发一遍。
  const quoteIndexRef = useRef<Map<string, Entry>>(new Map());
  quoteIndexRef.current = new Map(
    entries.filter((e) => e.data?.messageId).map((e) => [String(e.data.messageId), e]));
  const findQuoted = useCallback((id: string) => quoteIndexRef.current.get(id), []);

  // 消息流是页面里最重的子树（几百行 + markdown 渲染）：只在 entries 变化时重建，
  // 打字/移动光标/开关菜单都不会碰它——否则每敲一个字整屏重排一次。
  const stream = useMemo(
    () => entries.map((e, i) => <EntryRow key={i} e={e} preview={preview} botId={botId} srcOf={srcOf} findQuoted={findQuoted} onZoom={setZoom} />),
    [entries, preview, botId, srcOf, findQuoted]);

  /** 消息行的稳定键：列表会从头部裁掉（MAX_TURNS），索引会变，所以不能用索引当键 */
  const rowKeyOf = (e: Entry) => `${e.type}|${e.ts}|${e.userId ?? ''}`;

  /** 把屏幕外的消息行标成"跳过布局/绘制"，用**该行自己上次实测的高度**占位。
   *  滚动几何因此是准的（实测只差 0.3%，而用固定估值会差 49%）。没有实测高度的行先不跳过，
   *  让它正常布局、下一次 sync 时被量到。 */
  const applyContainment = useCallback(() => {
    const col = colRef.current;
    if (!col) return;
    const rows = col.children;
    const keys = rowKeysRef.current;
    const hs = rowHeightsRef.current;
    for (let i = 0; i < rows.length; i++) {
      const el = rows[i] as HTMLElement;
      const h = hs.get(keys[i]);
      if (h) {
        el.style.contentVisibility = 'auto';
        el.style.containIntrinsicSize = `auto ${h}px`;
      } else {
        el.style.contentVisibility = '';
        el.style.containIntrinsicSize = '';
      }
    }
  }, []);

  /** 量一遍每行的真实高度再交回惰性布局。整段只在"布局纪元"变化时跑：
   *  换会话 / 来了新消息 / 拖拽或改窗口停下之后——也就是"等移动结束再慢慢渲染"。 */
  const syncRowHeights = useCallback(() => {
    const col = colRef.current;
    const sc = streamRef.current;
    if (!col) return;
    const rows = col.children;
    const keys = rowKeysRef.current;
    // 宽度变了高度就会变，重排后总高度跟着变：先记下"停在最底"和"第一条可见行"两个锚点，
    // 量完再把视野放回原处——否则停在中间读历史的人会看到内容跳一下。
    const atBottom = !!sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 24;
    let anchorIdx = -1, anchorOff = 0, scTop = 0;
    if (sc && !atBottom) {
      scTop = sc.getBoundingClientRect().top;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (r.bottom > scTop + 1) { anchorIdx = i; anchorOff = r.top - scTop; break; }
      }
    }
    for (let i = 0; i < rows.length; i++) {          // 先放开跳过，让每行回到真实布局
      const el = rows[i] as HTMLElement;
      el.style.contentVisibility = '';
      el.style.containIntrinsicSize = '';
    }
    const hs = rowHeightsRef.current;
    for (let i = 0; i < rows.length; i++) {          // 读一轮：这里只有一次布局
      const k = keys[i];
      if (k) hs.set(k, Math.round(rows[i].getBoundingClientRect().height));
    }
    applyContainment();                              // 占位高度与真实高度一致，这一步不会造成跳动
    measuredWRef.current = col.clientWidth;          // 记下这次全量重量对应的列宽
    if (!sc) return;
    if (atBottom) sc.scrollTop = sc.scrollHeight;    // 停在底部就继续贴住底部
    else if (anchorIdx >= 0) {
      const off = rows[anchorIdx].getBoundingClientRect().top - scTop;
      if (Math.abs(off - anchorOff) > 1) sc.scrollTop += off - anchorOff;
    }
  }, [applyContainment]);

  // entries 变化 = 新消息 / 换会话。
  // 只是往尾部追加（流式回复最常见）且列宽没变时，已有行的高度都还成立——只量新增的几行，
  // 别为了量一行把 300 行全放开来重排一遍。换会话、或被 MAX_TURNS 从头部裁掉时走全量。
  useLayoutEffect(() => {
    const col = colRef.current;
    const prevKeys = rowKeysRef.current;
    const keys = entries.map(rowKeyOf);
    rowKeysRef.current = keys;
    if (!col) return;

    // 往前并了一天：多出来的高度要加回 scrollTop，不然视野会被新塞进来的旧消息推走
    const sc0 = streamRef.current;
    if (sc0 && prependHRef.current) {
      sc0.scrollTop += sc0.scrollHeight - prependHRef.current;
      prependHRef.current = 0;
    }

    const rows = col.children;
    const hs = rowHeightsRef.current;
    const width = col.clientWidth;
    let appendOnly = keys.length > prevKeys.length;
    if (appendOnly) {
      for (let i = 0; i < prevKeys.length; i++) {
        if (prevKeys[i] !== keys[i]) { appendOnly = false; break; }
      }
    }
    if (appendOnly && width === measuredWRef.current) {
      for (let i = prevKeys.length; i < rows.length; i++) {
        hs.set(keys[i], Math.round(rows[i].getBoundingClientRect().height));
      }
      applyContainment();                            // 新行也套上跳过；已有行的跳过状态不动
      return;
    }
    syncRowHeights();
  }, [entries, syncRowHeights, applyContainment]);

  // 拖拽调宽/改窗口期间先按旧高度跳过屏外（宽度变了高度会不准，但这时候屏幕外的行不该参与重排），
  // 停下之后再量一遍把几何修准
  const syncTimerRef = useRef(0);
  useEffect(() => {
    const settle = () => { clearTimeout(syncTimerRef.current); syncTimerRef.current = window.setTimeout(syncRowHeights, 260); };
    const mo = new MutationObserver(() => {
      if (document.body.classList.contains('resizing')) { clearTimeout(syncTimerRef.current); return; }
      settle();                                      // body.resizing 摘掉 = 拖拽结束
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', settle);
    return () => { mo.disconnect(); window.removeEventListener('resize', settle); clearTimeout(syncTimerRef.current); };
  }, [syncRowHeights]);

  const scrollBottom = useCallback((force = false) => {
    const sc = streamRef.current;
    if (!sc) return;
    const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
    if (force || near) { sc.scrollTop = sc.scrollHeight; setAtBottom(true); }
  }, []);

  // 距底部 24px 内算"停在最新"；只在跨过阈值时改状态，滚动过程中不会反复重渲染。
  // 故意不做成 useCallback：它要读到"当前是哪个会话"的最新闭包，否则换会话后翻页会打错 key。
  const onStreamScroll = () => {
    const sc = streamRef.current;
    if (!sc) return;
    const distBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    setAtBottom(distBottom <= 24);
    const w = dayWinRef.current;
    // 翻页只认"人在往那个方向划"：程序改 scrollTop（跳当天、补 prepend 的高度）不算，
    // 否则一天内容不够一屏时会连着把好几天并进来。
    const dir = sc.scrollTop < lastScrollTopRef.current - 1 ? -1 : sc.scrollTop > lastScrollTopRef.current + 1 ? 1 : 0;
    lastScrollTopRef.current = sc.scrollTop;
    if (w) {
      const locked = Date.now() < edgeLockRef.current;
      if (!locked && dir < 0 && sc.scrollTop <= 40 && w.from > 0) void loadEdge(-1);
      else if (!locked && dir > 0 && distBottom <= 40 && w.to < daysRef.current.length - 1) void loadEdge(1);
      // 窗口已经含到最新一天、又翻到底 = 眼前的就是最新消息，那颗「回到实时」的钮没有存在意义了
      if (distBottom <= 24 && w.to >= daysRef.current.length - 1) { setReview(''); setWin(null); }
    }
  };

  // WS 实时追加（当前会话）
  useEffect(() => {
    return onEvent('session.log', (entry: Entry) => {
      if (!current) return;
      const key = `${entry.chatType}_${entry.chatId}`;
      if (key !== current.key) return;
      if (isWorkEntry(entry.type)) return;      // 工具/系统行归右侧「工作」面板
      if (viewDayRef.current) return;           // 回看某一天时别把实时消息插进去，列表会跳
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next;
      });
    });
  }, [current]);

  // 实时态下停在底部就来新消息 → 继续贴住底部。回看态一律不自动滚：跨天翻页往尾部并进来时，
  // 把人一把拽到最新那端等于把他从正在读的那一页踢走。
  useEffect(() => { if (!viewDayRef.current) scrollBottom(); }, [entries, scrollBottom]);

  /** 日轨一列能摆几格：按内容盒实测（量不到时退回 10）。回看条会让内边距变，所以它也进依赖 */
  useEffect(() => {
    const el = railRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const usable = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const n = Math.floor((usable + 2) / RAIL_PITCH);
      if (n >= 3) setRailView(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [days.length > 1, viewDay]);

  /** 窗口起点钳到合法区间：容量变大（日子全装得下）时自动回到"从最早那天铺起" */
  const railMax = Math.max(0, days.length - railView);
  const railTopClamped = Math.min(railTop, railMax);

  /** 日轨数据：扫的是整份 jsonl，所以能看到 300 条窗口之外的日子 */
  const loadDays = useCallback(async (chatKey: string) => {
    try {
      const d = await get(`/api/chats/${chatKey}/days`);
      const list: ChatDay[] = d.days ?? [];
      setDays(list);
      daysRef.current = list;
      setRailTop(list.length);   // 贴最新那端（真正的起点由 railMax 钳出来）
      return list;
    } catch { return []; }
  }, []);

  const setReview = (day: string) => { viewDayRef.current = day; setViewDay(day); };
  const setWin = (w: { from: number; to: number } | null) => { dayWinRef.current = w; };

  /** 点日轨的一格 = 换成看那一天的消息（内核按本地日期取，不受 tail 的 300 条上限约束）。
   *  同时把"已加载窗口"标成这一天，之后往上/往下滑会连着并前后天（见 loadEdge）。 */
  const gotoDay = async (day: string) => {
    if (!current) return;
    const idx = daysRef.current.findIndex((d) => d.day === day);
    const d = await get(`/api/chats/${current.key}/day?day=${day}`);
    setReview(day);
    setWin(idx < 0 ? null : { from: idx, to: idx });
    setEntries((d.entries ?? []).filter((e: Entry) => !isWorkEntry(e.type)));
    const sc = streamRef.current;
    if (sc) { sc.scrollTop = 0; lastScrollTopRef.current = 0; }
    edgeLockRef.current = Date.now() + 500;   // 置顶这一动作本身会发 scroll 事件，别让它当成"用户在往上翻"
  };

  /** 贴着边界还在往那个方向划 = 想跨天。到顶时 scrollTop 已经是 0，滚不动也就没有 scroll 事件，
   *  所以"滚轮意图"单独接一份（触摸板连划、滚轮到底都算）。 */
  const onStreamWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const sc = streamRef.current, w = dayWinRef.current;
    if (!sc || !w || edgeBusyRef.current || Date.now() < edgeLockRef.current) return;
    if (e.deltaY < 0 && sc.scrollTop <= 40 && w.from > 0) void loadEdge(-1);
    else if (e.deltaY > 0 && sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 40 && w.to < daysRef.current.length - 1) void loadEdge(1);
  };

  /** 连续翻阅：回看窗口往外扩一天。往前并要补 scrollTop（否则视野被新内容推走），往后追不用。 */
  const loadEdge = async (dir: -1 | 1) => {
    const w = dayWinRef.current, list = daysRef.current;
    if (!w || !current || edgeBusyRef.current) return;
    const idx = dir < 0 ? w.from - 1 : w.to + 1;
    if (idx < 0 || idx >= list.length) return;
    edgeBusyRef.current = true;
    try {
      const d = await get(`/api/chats/${current.key}/day?day=${list[idx].day}`);
      const add: Entry[] = (d.entries ?? []).filter((e: Entry) => !isWorkEntry(e.type));
      if (dir < 0) {
        const sc = streamRef.current;
        prependHRef.current = sc ? sc.scrollHeight : 0;
        setEntries((prev) => [...add, ...prev]);
      } else {
        setEntries((prev) => [...prev, ...add]);
      }
      setWin(dir < 0 ? { from: idx, to: w.to } : { from: w.from, to: idx });
    } finally { edgeBusyRef.current = false; }
  };

  /** 回到实时：重取 tail 窗口（顺带补上回看期间漏掉的新消息） */
  const backToLive = async () => {
    if (!current) return;
    setReview('');
    setWin(null);
    const data = await get(`/api/chats/${current.key}/tail?limit=300`);
    setEntries((data.entries ?? []).filter((e: Entry) => !isWorkEntry(e.type)));
    void loadDays(current.key);
    setTimeout(() => scrollBottom(true), 50);
  };

  // 「回到实时」那颗钮做在顶栏与主题切换同排：钮的显隐报给上层，点击动作走页指令通道回来。
  usePageCmd('chats', cmd, (kind) => { if (kind === 'live') void backToLive(); });
  useEffect(() => { onReview?.(viewDay); }, [viewDay]);
  useEffect(() => () => onReview?.(''), []);   // 离开会话页时收掉那颗钮，别让它悬在别的页上

  const openChat = async (c: ChatInfo) => {
    setCurrent({ key: c.chatKey, type: c.chatType, id: c.chatId });
    if (narrow) onCloseList?.();   // 窄屏选完就把抽屉收起来，别让它压在对话上
    setReview('');
    setWin(null);
    setDays([]);
    daysRef.current = [];
    void loadDays(c.chatKey);
    const data = await get(`/api/chats/${c.chatKey}/tail?limit=300`);
    setEntries((data.entries ?? []).filter((e: Entry) => !isWorkEntry(e.type)));
    setTimeout(() => scrollBottom(true), 50);
    inputRef.current?.focus();
  };

  // 发送 = 以 bot 身份发言（限速与会话日志照常，历史里也是它自己的回合）。
  // 测试用户注入（/inject）保留在后端作调试接口，页面不再用。
  const send = async () => {
    const text = input.trim();
    if (!text || !current) return;
    setInput('');
    await post(`/api/chats/${current.key}/send`, { text })
      .catch(() => {});
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // 窄屏还没选会话时列表必须看得见，否则进来只剩一片空白
  const listShown = !narrow || listOpen || !current;
  return (
    <div className={'wb' + (narrow ? ' narrow' : '')}>
      <aside className={'wb-list' + (narrow && listShown ? ' open' : '')} style={narrow ? undefined : { width: listW }}>
        <div className="wb-groups">
          {groups.map((g) => (
            <div key={g.id} className="wb-group">
              <button className="wb-group-head" onClick={() => { setAnimatingId(g.id); setFolded((f) => ({ ...f, [g.id]: !f[g.id] })); }}
                aria-expanded={!folded[g.id]} aria-label={`${folded[g.id] ? '展开' : '折叠'}${g.label}分组`}>
                <Icon name={g.icon} size={14} />
                <span>{g.label}</span>
                <span className="cnt mono">{g.items.length}</span>
                <span className={'chev' + (folded[g.id] ? ' closed' : '')}><Icon name="chevron" size={12} /></span>
              </button>
              <div className={'wb-fold' + (folded[g.id] ? '' : ' open') + (animatingId === g.id ? ' animating' : '')}
                onTransitionEnd={(e) => { if (e.propertyName === 'grid-template-rows') setAnimatingId(null); }}>
                <div className="wb-fold-inner">
                  <div className="wb-fold-layer">
                    {g.items.length ? g.items.map((c) => (
                    <div key={c.chatKey} className={'chat-item-wrap' + (current?.key === c.chatKey ? ' active' : '')}>
                      <button className={'chat-item' + (current?.key === c.chatKey ? ' active' : '')}
                        onClick={() => openChat(c)} aria-label={`打开会话 ${chatTitle(c)}`}>
                        <ChatName text={chatTitle(c)} />
                      </button>
                      <span className="chat-acts">
                        <button className="chat-act" aria-label={pinned.has(c.chatKey) ? '取消置顶' : '置顶'}
                          onClick={() => togglePin(c.chatKey)}>
                          <Icon name="pin" size={13} />
                        </button>
                        <button className="chat-act" aria-label="从列表删除"
                          onClick={() => { toggleHide(c.chatKey); }}>
                          <Icon name="trash" size={13} />
                        </button>
                      </span>
                    </div>
                  )) : <div className="wb-group-empty">（无）</div>}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="wb-hidden">
          <button className={'wb-group-head' + (adding ? ' open' : '')} onClick={() => { setAnimatingId('hidden'); setAdding((v) => !v); }}
            aria-expanded={adding} aria-label={`${adding ? '折叠' : '展开'}已隐藏的会话`}>
            <Icon name="eyeOff" size={14} />
            <span>已隐藏</span>
            <span className="cnt mono">{hidden.size}</span>
            <span className={'chev' + (adding ? '' : ' closed')}><Icon name="chevron" size={12} /></span>
          </button>
          <div className={'wb-fold' + (adding ? ' open' : '') + (animatingId === 'hidden' ? ' animating' : '')}
            onTransitionEnd={(e) => { if (e.propertyName === 'grid-template-rows') setAnimatingId(null); }}>
            <div className="wb-fold-inner">
              <div className="wb-fold-layer">
                {hidden.size ? [...hidden].map((key) => {
                const c = chats.find((x) => x.chatKey === key);
                return (
                  <div key={key} className="chat-item-wrap">
                    <button className="chat-item" onClick={() => unhide(key)}>
                      <ChatName text={c ? chatTitle(c) : key} />
                    </button>
                    <span className="chat-acts">
                      <button className="chat-act" aria-label="添加回列表" onClick={() => unhide(key)}>
                        <Icon name="plus" size={13} />
                      </button>
                    </span>
                  </div>
                );
              }) : <div className="wb-group-empty">没有隐藏的会话</div>}
              </div>
            </div>
          </div>
        </div>
        <div
          className="wb-list-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整会话列表宽度"
          onMouseDown={(e) => {
            // 整段拖拽只在这里读一次布局
            const el = document.querySelector<HTMLElement>('.wb-list');
            listElRef.current = el;
            listLeftRef.current = el?.getBoundingClientRect().left ?? 0;
            listDragRef.current = true;
            document.body.classList.add('resizing');
            e.currentTarget.classList.add('dragging');
          }}
          onMouseMove={(e) => { (e.currentTarget as HTMLElement).style.setProperty('--handle-y', `${e.clientY - e.currentTarget.getBoundingClientRect().top}px`); }}
          onMouseUp={(e) => e.currentTarget.classList.remove('dragging')}
          onMouseLeave={(e) => e.currentTarget.classList.remove('dragging')}
        />
      </aside>
      {/* 窄屏抽屉的遮罩：点空白处收起列表（宽屏不渲染，别抢正常点击） */}
      {narrow && listShown && <div className="wb-scrim" onClick={() => onCloseList?.()} aria-hidden />}

      <section className="conv-side">
        {!current ? (
          <div className="wb-empty">
            <svg className="empty-illo" viewBox="0 0 200 120" fill="none" aria-hidden>
              <rect x="52" y="14" width="96" height="62" rx="16" className="illo-bubble" />
              <path d="M78 76l-6 16 20-14" className="illo-bubble" />
              <circle cx="84" cy="45" r="4.5" className="illo-dot" />
              <circle cx="102" cy="45" r="4.5" className="illo-dot d2" />
              <circle cx="120" cy="45" r="4.5" className="illo-dot d3" />
              <path d="M28 96c14-8 30-8 44 0M128 96c14-8 30-8 44 0" className="illo-line" />
              <circle cx="100" cy="99" r="3" className="illo-heart" />
            </svg>
            <div className="big">一段对话还没有开始</div>
          </div>
        ) : (
          <>
            <div className={'conv-wrap' + (atBottom ? ' at-bottom' : '') + (days.length > 1 ? ' has-rail' : '') + (viewDay ? ' reviewing' : '')}>
              {/* 回看哪天：透明的一行字浮在会话列上方，不占行也不画分界，消息照旧从顶栏毛玻璃底下走过去。
                  回去的口在顶栏那一排（与主题切换同列） */}
              {viewDay && <div className="conv-review mono">{viewDay}</div>}
              {/* 日轨：一格一天，铺满「日期下方 → 输入框上方」这一列，装不下才用滚轮滑窗 */}
              {days.length > 1 && (
                <div className="conv-rail" ref={railRef} aria-label="按天回看" onWheel={(e) => {
                  const max = Math.max(0, days.length - railView);
                  if (max) setRailTop((t) => Math.min(max, Math.max(0, t + (e.deltaY > 0 ? 1 : -1))));
                }}>
                  {days.slice(railTopClamped, railTopClamped + railView).map((d) => (
                    <button key={d.day}
                      className={'conv-tick' + (d.day === (viewDay || days[days.length - 1].day) ? ' on' : '')}
                      title={`${d.day} · ${d.count} 条`} aria-label={d.day}
                      onClick={() => void gotoDay(d.day)} />
                  ))}
                </div>
              )}
              <div className="conv-scroll" ref={streamRef} onScroll={onStreamScroll} onWheel={onStreamWheel}>
                <div className="conv-col" ref={colRef} onAnimationEnd={onTurnRiseEnd}>{stream}</div>
              </div>
              {/* 消息滑到对话框上方时渐隐淡出（纯背景色渐变，比 mask 便宜，不拖累滚动） */}
              <div className="conv-fade" aria-hidden />
            </div>
            <div className="composer-wrap">
              <div className="composer-inner">
                <div className="composer-box">
                  <div className="composer-input">
                    {/* 文本层：负责"看得见的字"，光标位作为内联元素插在中间（挤开后面的字） */}
                    <div className="composer-text" ref={textRef} aria-hidden>
                      {input.slice(0, caretOn ? caretPos : input.length)}
                      {caretOn && (
                        <span className="caret-slot">
                          <Icon name="brand" size={15} />
                        </span>
                      )}
                      {caretOn ? input.slice(caretPos) : ''}
                    </div>
                    <textarea
                      id="composer-input"
                      ref={inputRef}
                      rows={1}
                      value={input}
                      aria-label="消息输入框"
                      onChange={(e) => { setInput(e.target.value); autogrow(e.target); }}
                      onKeyDown={onKey}
                      onKeyUp={syncCaret}
                      onFocus={syncCaret}
                      onScroll={syncCaret}
                    />
                  </div>
                  <div className="composer-bar">
                    <span className="flex" />
                    <button className="send-btn" aria-label="发送消息" onClick={send}>
                      <Icon name="send" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      {/* 窄屏「工作」栏是覆盖式的：点栏外的对话区收起它（宽屏它占着流里的一栏，不需要遮罩） */}
      {narrow && workOpen && <div className="wb-scrim" onClick={() => onCloseWork?.()} aria-hidden />}
      {/* 右侧「工作」抽屉：顶栏按钮开的，滑在主内容之上 */}
      <WorkDrawer chatKey={current?.key} open={!!workOpen} onClose={() => onCloseWork?.()} ctxByModel={ctxByModel} narrow={narrow} />

      {zoom && (
        <Modal title={zoom.name} wide onClose={() => setZoom(null)}>
          <img className="sb-image" src={srcOf(zoom.rel)} alt={zoom.name} />
        </Modal>
      )}
    </div>
  );
}

/** 入场动画播完就把动画从元素上摘掉（配合 globals.css 里的 .turn[data-rise]）。
 *  rise-in 是 `both` 填充的，播完会永久挂在元素上——300 条消息就是 306 个常驻动画元素，
 *  浏览器每帧都得为它们重算一遍动画样式，实测拖拽调宽时每帧多花 8~9ms（掉到 36fps）。
 *  摘掉没有视觉差别：rise-in 的终态（opacity 1 / transform none）就等于常态。
 *  挂在 .conv-col 上用事件委托（动画事件会冒泡），不必给每个 .turn 都加处理函数。 */
const onTurnRiseEnd = (e: React.AnimationEvent<HTMLDivElement>) => {
  // 委托在 .conv-col 上：真正跑动画的元素是 target，不是 currentTarget
  const el = e.target as HTMLElement;
  if (e.animationName === 'rise-in' && el.classList.contains('turn')) el.dataset.rise = 'done';
};

/** 群友头像：qlogo 取不到（离线/无效号）时回落首字，不留破图 */
function Avatar({ userId }: { userId: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return <span className="turn-avatar turn-avatar-x">{(userId || '?').slice(0, 1)}</span>;
  return <img className="turn-avatar" src={`/api/login/avatar/${encodeURIComponent(userId)}`} alt=""
    loading="lazy" decoding="async" onError={() => setOk(false)} />;
}

/** 缩略图：消息会一直留着，图却可能被 TTL 清掉或从未落盘，取不到就整块不占位（不留破图）。
 *  同时要报给所在的那一行，让它把 [图片] 字样留住——不然纯图片消息会一个字都不剩。 */
function Thumb({ f, srcOf, onZoom, onDead }:
  { f: { rel: string; name: string }; srcOf: (rel: string) => string; onZoom: (f: { rel: string; name: string }) => void; onDead: (rel: string) => void }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return <img className="thumb" src={srcOf(f.rel)} alt={f.name} title={f.name}
    loading="lazy" decoding="async" onClick={() => onZoom(f)}
    onError={() => { setOk(false); onDead(f.rel); }} />;
}

/** 图片已经以缩略图摆在面前了，文本里那个 [图片] 占位就删掉：只删这几个字（连同它前面那个空格），
 *  其余文本一个字不动。适配器是每个图片段塞一个 ' [图片]'，所以连发多图会连着出现好几个。 */
const stripImageMark = (t: string) => t.replace(/[ \t]*\[图片\]/g, '').replace(/^ +/, '');

/** 适配器把 reply 段拼成 [回复:消息号]：内核已经查回原文（data.replyTo）时，这个占位就该让位给引用块 */
const stripReplyMark = (t: string) => t.replace(/[ \t]*\[回复:[^\]]*\]/g, '').replace(/^ +/, '');

/** 适配器把合并转发段拼成 [聊天记录]：内核取回了节点（data.forward）时，这个占位让位给卡片 */
const stripForwardMark = (t: string) => t.replace(/[ \t]*\[聊天记录\]/g, '').replace(/^ +/, '');

/** 协议端在 at 段里带了昵称（群里显示的那个名字）：文本里的 @号码 换成 @名字。
 *  号码是给机器看的，人在群里看到的是名字；段里没给 name 就留着号码，不猜。 */
function decorateAt(t: string, segs: { type: string; data?: Record<string, unknown> }[]): string {
  const names: Record<string, string> = {};
  for (const s of segs) {
    const qq = s.type === 'at' ? String(s.data?.qq ?? '') : '';
    if (qq && s.data?.name) names[qq] = String(s.data.name);
  }
  return Object.keys(names).length ? t.replace(/@(\d{4,})/g, (m, qq: string) => (names[qq] ? '@' + names[qq] : m)) : t;
}

/** 条目里的图片附件 → 沙箱内相对路径。data.files 有两种形状：10-10 之前只存名字，之后存 {name,rel,size} */
function imageRefs(raw: unknown): { rel: string; name: string }[] {
  const list: any[] = Array.isArray(raw) ? raw : [];
  return list
    .map((f: any): { rel: string; name: string } => (typeof f === 'string'
      ? { name: f, rel: 'inbox/' + f }
      : { name: String(f?.name ?? ''), rel: String(f?.rel ?? '') }))
    .filter((f) => f.rel && /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(f.name || f.rel));
}

/** 内核取回来的聊天记录节点（合并转发正文）。老条目没这个字段，前端就什么都不画 */
interface FwdNode { nickname?: string; userId?: string; text?: string; ts?: number; depth?: number; files?: unknown }
interface FwdData { title?: string; nodes?: FwdNode[]; dropped?: number; failed?: boolean }
interface FRef { rel: string; name: string }

const AUDIO_EXT_RE = /\.(mp3|wav|ogg|opus|m4a|aac|flac|amr|silk|slk)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi)$/i;

/** 节点附件按类型分堆：图走缩略图，语音/视频走播放器（同一批 inbox 文件，扩展名三类互不重叠） */
function mediaRefs(raw: unknown): { imgs: FRef[]; audio: FRef[]; video: FRef[] } {
  const all = normRefs(raw);
  return {
    imgs: imageRefs(raw),
    audio: all.filter((f) => AUDIO_EXT_RE.test(f.name || f.rel)),
    video: all.filter((f) => VIDEO_EXT_RE.test(f.name || f.rel)),
  };
}
const normRefs = (raw: unknown): FRef[] => (Array.isArray(raw) ? raw : [])
  .map((f: any): FRef => (typeof f === 'string' ? { name: f, rel: 'inbox/' + f } : { name: String(f?.name ?? ''), rel: String(f?.rel ?? '') }))
  .filter((f) => f.rel);

/** 有真内容就删占位：图/语音/视频各自渲染出来了，正文里那几个字样就是重复信息 */
function stripMediaMarks(t: string, has: { img?: boolean; audio?: boolean; video?: boolean }): string {
  let s = t;
  if (has.img) s = s.replace(/[ \t]*\[图片\]/g, '');
  if (has.audio) s = s.replace(/[ \t]*\[语音\]/g, '');
  if (has.video) s = s.replace(/[ \t]*\[视频\]/g, '');
  return s.replace(/^ +/, '');
}

/** QQ 经典表情：消息正文里的 `[表情:32]` 换成 `/face/32.webp`（资源由 scripts/build-qq-faces.mjs 生成） */
function QqFace({ id }: { id: string }) {
  const [dead, setDead] = useState(false);
  const name = QQ_FACE_NAMES[id] ?? `表情${id}`;
  if (dead) return <span className="qq-face-t">[{name}]</span>;
  return (
    <img className="qq-face" src={`/face/${id}.webp`} alt={name} title={name} loading="lazy"
      onError={() => setDead(true)} />
  );
}

/** 把一段正文按表情占位切开：文字保持原样，表情位置渲染成内联图 */
function FaceText({ text }: { text: string }) {
  const parts = String(text ?? '').split(/(\[表情[:：]\d+\])/g);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[表情[:：](\d+)\]$/);
        return m ? <QqFace key={i} id={m[1]} /> : <span key={i}>{p}</span>;
      })}
    </>
  );
}

/** message_out 走 mdLite 的 HTML，这里把占位换成图片；图片缺失时回落到中文名 */
function faceHtml(html: string): string {
  return html.replace(/\[表情[:：](\d+)\]/g, (_, id: string) => {
    const name = QQ_FACE_NAMES[id] ?? `表情${id}`;
    return `<img class="qq-face" src="/face/${id}.webp" alt="${name}" title="${name}" loading="lazy" onerror="this.replaceWith(document.createTextNode('[' + this.alt + ']'))">`;
  });
}

const mmss = (s: number) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

/**
 * 语音条。浏览器自带的那枚控件是浅色的，压在这页的黑白底上不协调，所以自己画一条：
 * 播放/暂停 + 进度（可点选位置）+ 时长。字节仍走 /api/sandbox/raw，服务端支持 Range。
 * preload 关掉：一条记录里可能好几条语音，展开卡片不该顺手把它们全拉下来。
 */
function AudioRow({ f, srcOf, onDead }: { f: FRef; srcOf: (rel: string) => string; onDead: (rel: string) => void }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [on, setOn] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [dead, setDead] = useState(false);
  if (dead) return null;
  const drop = () => { setDead(true); setOn(false); onDead(f.rel); };
  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) { a.play().then(() => setOn(true), drop); } else { a.pause(); setOn(false); }
  };
  const seek = (e: React.MouseEvent<HTMLSpanElement>) => {
    const a = ref.current;
    if (!a || !dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * dur;
    setT(a.currentTime);
  };
  return (
    <div className="media-audio">
      <audio ref={ref} src={srcOf(f.rel)} preload="none" onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onEnded={() => setOn(false)} onError={drop} />
      <button type="button" className="media-play" onClick={toggle} aria-label={on ? '暂停' : '播放'}>
        <Icon name={on ? 'pause' : 'play'} size={13} />
      </button>
      <span className="media-bar" onClick={seek}>
        <span className="media-bar-f" style={{ width: `${dur ? Math.min(100, (t / dur) * 100) : 0}%` }} />
      </span>
      <span className="media-dur">{mmss(dur || t)}</span>
    </div>
  );
}

/** 视频：交给浏览器自带的控件（深色叠加条与本页不冲突），取不到就整块不占位、正文留着 [视频] */
function VideoRow({ f, srcOf, onDead }: { f: FRef; srcOf: (rel: string) => string; onDead: (rel: string) => void }) {
  const [dead, setDead] = useState(false);
  if (dead) return null;
  return <video className="media-video" src={srcOf(f.rel)} controls preload="metadata"
    onError={() => { setDead(true); onDead(f.rel); }} />;
}

/** failed / 空节点都不算"有内容"：这时候正文里的 [聊天记录] 字样要留着 */
const forwardOf = (e: Entry): FwdData | null => {
  const f = e.data?.forward as FwdData | undefined;
  return f && !f.failed && Array.isArray(f.nodes) && f.nodes.length ? f : null;
};

/**
 * 聊天记录（合并转发）卡片：默认收起只报条数，点开才列逐条——
 * 一次转发动辄上百条，全展开会把整屏会话挤走。展开区限高内部滚，不动会话流的位置。
 * 外壳与 .bubble-user 同档（同底色、同圆角、同字号），它本身就是这条消息的正文。
 */
function ForwardCard({ fwd, srcOf, onZoom }:
  { fwd: FwdData; srcOf: (rel: string) => string; onZoom: (f: { rel: string; name: string }) => void }) {
  const [open, setOpen] = useState(false);
  /** 取不到的图（被 TTL 删了/从未落盘）：那张不算已预览，[图片] 字样要留在正文里 */
  const [dead, setDead] = useState<string[]>([]);
  const onDead = useCallback((rel: string) => setDead((p) => (p.includes(rel) ? p : [...p, rel])), []);
  const nodes = fwd.nodes ?? [];
  const total = nodes.length + (fwd.dropped ?? 0);
  return (
    <div className={'fwd' + (open ? ' fwd-open' : '')}>
      <button type="button" className="fwd-head" onClick={() => setOpen((v) => !v)}>
        <Icon name="chats" size={15} />
        <span className="fwd-title">{fwd.title || '聊天记录'}</span>
        <span className="fwd-cnt">{total} 条</span>
        <span className="fwd-caret"><Icon name="chevron" size={14} /></span>
      </button>
      {open && (
        <div className="fwd-list">
          {nodes.map((n, i) => {
            const m = mediaRefs(n.files);
            const live = (list: FRef[]) => list.filter((f) => !dead.includes(f.rel));
            const imgs = live(m.imgs), aud = live(m.audio), vid = live(m.video);
            const played = new Set([...imgs, ...aud, ...vid].map((f) => f.rel));
            const files = normRefs(n.files).filter((f) => !played.has(f.rel) && !dead.includes(f.rel));
            const text = stripMediaMarks(n.text || '', { img: imgs.length > 0, audio: aud.length > 0, video: vid.length > 0 });
            return (
              <div className={'fwd-row' + ((n.depth ?? 0) > 0 ? ' fwd-nested' : '')} key={i}>
                <div className="fwd-who">
                  <span className="fwd-name">{n.nickname || n.userId || '未知'}</span>
                  {!!n.ts && <span className="fwd-time">{fmtTime(n.ts)}</span>}
                </div>
                {!!text && <div className="fwd-text">{text}</div>}
                {imgs.length > 0 && (
                  <div className="turn-thumbs fwd-thumbs">
                    {imgs.map((f) => <Thumb key={f.rel} f={f} srcOf={srcOf} onZoom={onZoom} onDead={onDead} />)}
                  </div>
                )}
                {aud.map((f) => <AudioRow key={f.rel} f={f} srcOf={srcOf} onDead={onDead} />)}
                {vid.map((f) => <VideoRow key={f.rel} f={f} srcOf={srcOf} onDead={onDead} />)}
                {files.map((f) => (
                  <div className="fwd-file" key={f.rel} title={f.name}>
                    <Icon name="file" size={14} />
                    <span className="mono">{f.name}</span>
                  </div>
                ))}
              </div>
            );
          })}
          {!!fwd.dropped && <div className="fwd-more">（另有 {fwd.dropped} 条超出上限，内核没留下）</div>}
        </div>
      )}
    </div>
  );
}

// memo：新消息到达时 entries 换了新数组，但旧条目还是同一批对象引用，
// 于是只有真正新增/变化的那一行会重渲染（否则 300 行 + markdown 每次全跑一遍）
const EntryRow = memo(function EntryRow({ e, preview, botId, srcOf, findQuoted, onZoom }:
  {
    e: Entry; preview: boolean; botId?: string; srcOf: (rel: string) => string; onZoom: (f: { rel: string; name: string }) => void;
    findQuoted: (id: string) => Entry | undefined;
  }) {
  /** 取不到图的附件（被 TTL 删了/从未落盘）：这些不算"已预览"，[图片] 字样得留着 */
  const [dead, setDead] = useState<string[]>([]);
  const onDead = useCallback((rel: string) => setDead((p) => (p.includes(rel) ? p : [...p, rel])), []);

  if (e.type === 'poke') {
    const p = (e.data as any)?.poke;
    return (
      <div className="turn turn-poke">
        <span className="poke-line">{e.text || `戳了戳 ${p?.nickname || p?.userId || ''}`}</span>
      </div>
    );
  }

  // 贴表情（消息下面的表情回应）：一行居中的小提示，表情直接用 /face 图标（与会话里的脸图同一套资源）
  if (e.type === 'reaction') {
    const r = (e.data as any)?.reaction;
    if (!r) {
      return (
        <div className="turn turn-poke"><span className="poke-line">{e.text || '贴了个表情'}</span></div>
      );
    }
    return (
      <div className="turn turn-poke">
        <span className="poke-line reaction-line">
          贴了个表情
          {r.emojiId
            ? <img className="reaction-face" src={`/face/${r.emojiId}.webp`} alt={r.emojiName || ''} title={r.emojiName || ''} loading="lazy"
                onError={(ev) => { (ev.target as HTMLImageElement).style.display = 'none'; }} />
            : <span>{r.emojiName || ''}</span>}
          {r.nickname ? <span className="reaction-who">· {r.nickname}</span> : null}
        </span>
      </div>
    );
  }

  if (e.type === 'message_in') {
    const media = mediaRefs(e.data?.files);
    const live = (list: FRef[]) => list.filter((f) => !dead.includes(f.rel));
    // 预览开关只管头像与图片缩略图（设置页那条的原文就这么写的）；语音/视频是内容本体，不给关
    const imgs = preview ? live(media.imgs) : [];
    const aud = live(media.audio), vid = live(media.video);
    const segs: { type: string; data?: Record<string, unknown> }[] = Array.isArray(e.data?.segments) ? e.data.segments : [];
    const rid = String(segs.find((s) => s.type === 'reply')?.data?.id ?? '');
    const src = rid ? findQuoted(rid) : undefined;
    const snap = e.data?.replyTo as { userId?: string; nickname?: string; text?: string; files?: unknown } | undefined;
    let quote = snap ?? (src && (src.text || src.data?.files)
      ? { userId: src.userId, nickname: src.nickname, text: src.text, files: src.data?.files }
      : undefined) as { userId?: string; nickname?: string; text?: string; files?: unknown } | undefined;
    // 快照是落账那一刻抄的：带文件那轮之前的老快照没有 files，源条目还在就把它补齐
    if (quote && !quote.files && src?.data?.files) quote = { ...quote, files: src.data.files };
    const raw = e.text || '';
    const fwd = forwardOf(e);
    let text = stripMediaMarks(raw, { img: imgs.length > 0, audio: aud.length > 0, video: vid.length > 0 });
    if (quote) text = stripReplyMark(text);
    if (fwd) text = stripForwardMark(text);
    text = decorateAt(text, segs);
    // 附件里既不是图也不是音视频的那部分（比如文件）没有任何渲染形式，靠这句告诉人这轮带了东西
    const played = new Set([...media.imgs, ...media.audio, ...media.video].map((f) => f.rel));
    const otherFiles = normRefs(e.data?.files).filter((f) => !played.has(f.rel) && !dead.includes(f.rel));
    // 被引用的常常是一张图：快照/源条目里的附件一起端上来，引用块里也出预览图，
    // 出了图就把那句 [图片] 删掉（跟正文同一套口径）
    const qImgs = quote ? imageRefs(quote.files).filter((f) => !dead.includes(f.rel)) : [];
    const qTextRaw = quote?.text || '';
    const qText = qImgs.length ? stripImageMark(qTextRaw) : qTextRaw;
    return (
      <div className="turn turn-user">
        {preview && e.userId ? <Avatar userId={e.userId} /> : null}
        <div className="turn-body">
          <div className="meta">{e.nickname || e.userId || ''} · {fmtTime(e.ts)}{otherFiles.length > 0 ? '（含附件）' : ''}</div>
          {(!!text || quote) && (
            <div className="bubble-user">
              {quote && (
                <div className="quote">
                  <span className="q-nm">{quote.nickname || quote.userId || ''}</span>
                  {!!qText && <span className="q-tx"><FaceText text={qText} /></span>}
                  {qImgs.length > 0 && (
                    <span className="turn-thumbs q-imgs">
                      {qImgs.map((f) => <Thumb key={f.rel} f={f} srcOf={srcOf} onZoom={onZoom} onDead={onDead} />)}
                    </span>
                  )}
                </div>
              )}
              {!!text && <span className="q-body"><FaceText text={text} /></span>}
            </div>
          )}
          {fwd && <ForwardCard fwd={fwd} srcOf={srcOf} onZoom={onZoom} />}
          {imgs.length > 0 && (
            <div className="turn-thumbs">
              {imgs.map((f) => <Thumb key={f.rel} f={f} srcOf={srcOf} onZoom={onZoom} onDead={onDead} />)}
            </div>
          )}
          {/* 语音/视频与记录里同一套播放器：顶层消息以前只有 [语音] 三个字，等于没给 */}
          {aud.map((f) => <AudioRow key={f.rel} f={f} srcOf={srcOf} onDead={onDead} />)}
          {vid.map((f) => <VideoRow key={f.rel} f={f} srcOf={srcOf} onDead={onDead} />)}
        </div>
      </div>
    );
  }
  if (e.type === 'message_out') {
    const fwd = forwardOf(e);
    return (
      <div className="turn turn-assistant">
        {botId ? <Avatar userId={botId} /> : null}
        <div className="turn-body">
          {fwd
            ? <ForwardCard fwd={fwd} srcOf={srcOf} onZoom={onZoom} />
            : <div className="text-md" dangerouslySetInnerHTML={{ __html: faceHtml(mdLite(e.text || '')) + (e.data?.simulated ? '<span class="muted"> （桌面端模拟）</span>' : '') }} />}
        </div>
      </div>
    );
  }
  return null;
});

function autogrow(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

const NAME_FADE = 24;   // px，右端渐隐带宽度（globals.css 里 .t.ovf 的 --nm-fade 用同一个值）

/** 会话名：不截断不打点，超出就把右端渐隐掉；悬停/选中时整行来回滚动把名字读完。
 *  滚多远只能实测——于是量一次"文字宽 - 容器宽"，作为位移距离和时长写进 CSS 变量。 */
function ChatName({ text }: { text: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState<{ shift: number; dur: number } | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const tt = box.firstElementChild as HTMLElement | null;
      if (!tt || box.clientWidth < 40) return;   // 折叠中/未布局时量出来的宽度没意义
      // 多滚一个渐隐带 + 4px：滚到最远端时名字尾巴停在渐隐带之前，整名是全亮的
      const over = tt.scrollWidth - box.clientWidth;
      const shift = over > 1 ? over + NAME_FADE + 4 : 0;
      setScroll((p) => {
        if (!shift) return p ? null : p;
        // 滚动速度 ~24px/s（比初版慢 30%，长名字也来得及读）
        return p && p.shift === shift ? p : { shift, dur: Math.max(2.9, shift / 23.8) };
      });
    };
    measure();
    // 侧边栏可拖宽、分组折叠会改宽，都得重量
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    // 悬停时文字区要给右侧浮出的按键让宽度，这一进一出也补量一次（不等 ResizeObserver 的下一帧）
    const wrap = box.closest(".chat-item-wrap");
    wrap?.addEventListener("mouseenter", measure);
    wrap?.addEventListener("mouseleave", measure);
    // 字体晚于首屏装载时文字宽会变
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
    return () => {
      ro.disconnect();
      wrap?.removeEventListener("mouseenter", measure);
      wrap?.removeEventListener("mouseleave", measure);
    };
  }, [text]);

  return (
    <span ref={boxRef} className={'t' + (scroll ? ' ovf' : '')}
      style={scroll ? ({ '--nm-fade': `${NAME_FADE}px`, '--nm-shift': `${scroll.shift}px`, '--nm-dur': `${scroll.dur.toFixed(2)}s` } as CSSProperties) : undefined}>
      <span className="tt">{text}</span>
    </span>
  );
}
