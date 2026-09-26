'use client';
/**
 * 会话页 —— Codex 任务页形态：
 * 会话列表（置顶/群聊/私聊 三组可折叠，长名渐隐，右键/悬停置顶删除）+ 居中会话列
 * + 宽卡片 composer（双模型选择 pill + 斜杠命令补全 + parallel 品牌 mark 插入光标）
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { get, post, onEvent, fmtTime, mdLite } from '@/lib/api';
import { isWorkEntry } from '@/lib/entries';
import { Icon } from '@/components/Icon';
import WorkDrawer from '@/components/WorkDrawer';

interface ChatInfo { chatKey: string; chatId: string; chatType: string; lastTs: number; title?: string }
interface Entry {
  type: string; chatId?: string; chatType?: string; ts?: number; text?: string;
  userId?: string; nickname?: string; data?: any;
}
interface Cmd { name: string; description: string; enabled: boolean }
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

export default function ChatsPage({ masterId, onNavigate, workOpen, onCloseWork }: {
  masterId?: string;
  onNavigate?: (page: string) => void;
  /** 顶栏「工作」按钮的开关状态（抽屉本体在这里渲染） */
  workOpen?: boolean;
  onCloseWork?: () => void;
}) {
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [current, setCurrent] = useState<{ key: string; type: string; id: string } | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [models, setModels] = useState<ModelsData | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [ac, setAc] = useState<{ items: Cmd[]; sel: number } | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  // 是否停在最底部（贴着最新消息）：是则收起渐隐遮罩——停在底部时最新消息要能看清，
  // 往上翻（正在滑动/读历史）才让下缘淡出
  const [atBottom, setAtBottom] = useState(true);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [animatingId, setAnimatingId] = useState<string | null>(null); // 正在开合的分组 id：淡化 mask 只作用于该分组自身
  const [listW, setListW] = useState(250);
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const cmdCache = useRef<{ key: string; cmds: Cmd[] }>({ key: '', cmds: [] });
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

  // 模型（chat + work）：进入页面拉一次，切完再拉，菜单里点开时也刷新
  const loadModels = useCallback(() => { get('/api/providers').then(setModels).catch(() => {}); }, []);
  useEffect(loadModels, [loadModels]);
  /** 换链首没写进去就在菜单里报一行，别让人以为已经换了 */
  const [chainErr, setChainErr] = useState('');

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
      const ty = `translateY(${-ta.scrollTop}px)`;
      if (layer.style.transform !== ty) layer.style.transform = ty;
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

  // 模型菜单：点外部或 Esc 关闭
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.cmp-menu, .cmp-pill')) setModelOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setModelOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [modelOpen]);

  /** 菜单里点某一条 = 把它提到链首（当前使用的就是它） */
  const pickChain = useCallback(async (kind: 'chat' | 'work', idx: number) => {
    const list = models?.chains[kind] ?? [];
    if (!list[idx]) return;
    const entries = [list[idx], ...list.filter((_, i) => i !== idx)]
      .map((e) => ({ provider: e.provider, model: e.model }));
    try {
      await post('/api/providers/chain', { kind, entries });
      setChainErr('');
    } catch (e) { setChainErr(`未生效：${(e as Error)?.message ?? String(e)}`); }
    loadModels();
  }, [models, loadModels]);

  /** 工作链清空 = 跟随聊天链 */
  const followChat = useCallback(async () => {
    try {
      await post('/api/providers/chain', { kind: 'work', entries: [] });
      setChainErr('');
    } catch (e) { setChainErr(`未生效：${(e as Error)?.message ?? String(e)}`); }
    loadModels();
  }, [loadModels]);

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
  /** 输入框上的模型胶囊显示当前在服务的链首（掉线降级后会自动变成接上的那条）；
   *  链还没配过时回落到内核的兜底供应商，至少告诉用户现在是谁在答 */
  const servingChat = models?.chains.chat.find((e) => e.state === 'current') ?? models?.chains.chat[0]
    ?? (models ? { provider: models.active, model: models.activeModel } as ChainEntry : null);
  const chatLabel = models
    ? (models.providers.find((p) => p.id === servingChat?.provider)?.label ?? servingChat?.model ?? '模型')
    : '模型';
  /** 模型 id -> 上下文窗口：右侧「工作」面板的占比圆环用它当分母 */
  const ctxByModel = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of models?.providers ?? []) for (const mm of p.config?.models ?? []) if (mm.contextWindow) m[mm.id] = mm.contextWindow;
    return m;
  }, [models]);

  // 消息流是页面里最重的子树（几百行 + markdown 渲染）：只在 entries 变化时重建，
  // 打字/移动光标/开关菜单都不会碰它——否则每敲一个字整屏重排一次。
  const stream = useMemo(() => entries.map((e, i) => <EntryRow key={i} e={e} />), [entries]);

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

  // 距底部 24px 内算"停在最新"；只在跨过阈值时改状态，滚动过程中不会反复重渲染
  const onStreamScroll = useCallback(() => {
    const sc = streamRef.current;
    if (!sc) return;
    setAtBottom(sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 24);
  }, []);

  // WS 实时追加（当前会话）
  useEffect(() => {
    return onEvent('session.log', (entry: Entry) => {
      if (!current) return;
      const key = `${entry.chatType}_${entry.chatId}`;
      if (key !== current.key) return;
      if (isWorkEntry(entry.type)) return;      // 工具/系统行归右侧「工作」面板
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next;
      });
    });
  }, [current]);

  useEffect(() => { scrollBottom(); }, [entries, scrollBottom]);

  const openChat = async (c: ChatInfo) => {
    setCurrent({ key: c.chatKey, type: c.chatType, id: c.chatId });
    cmdCache.current = { key: '', cmds: [] };
    const data = await get(`/api/chats/${c.chatKey}/tail?limit=300`);
    setEntries((data.entries ?? []).filter((e: Entry) => !isWorkEntry(e.type)));
    setTimeout(() => scrollBottom(true), 50);
    inputRef.current?.focus();
  };

  // 发送 = 以主人身份注入用户消息，走完整内核链路（模型回复照常回流到会话流）
  const send = async () => {
    const text = input.trim();
    if (!text || !current) return;
    setInput('');
    if (ac) setAc(null);
    await post(`/api/chats/${current.key}/inject`, { text, userId: masterId || '10000', nickname: '桌面访客' })
      .catch(() => {});
  };

  // 斜杠命令补全
  const onInput = async (v: string) => {
    setInput(v);
    if (!v.startsWith('/') || !current) { setAc(null); return; }
    if (cmdCache.current.key !== current.key) {
      const m = current.key.match(/^(group|private)_(.+)$/);
      cmdCache.current = {
        key: current.key,
        cmds: await post('/api/rpc/commands_visible', { chatId: m?.[2] ?? '', chatType: m?.[1] ?? 'group', role: 'owner' }).catch(() => []),
      };
    }
    const q = v.slice(1).split(/\s/)[0].toLowerCase();
    const items = cmdCache.current.cmds.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 12);
    setAc(items.length ? { items, sel: 0 } : null);
  };
  const pickAc = (c?: Cmd) => {
    if (!c && !ac) return;
    const cmd = c ?? ac!.items[ac!.sel];
    setInput('/' + cmd.name + ' ');
    setAc(null);
    inputRef.current?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (ac) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAc({ ...ac, sel: (ac.sel + 1) % ac.items.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAc({ ...ac, sel: (ac.sel - 1 + ac.items.length) % ac.items.length }); return; }
      if (e.key === 'Escape') { setAc(null); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pickAc(); return; }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <aside className="wb-list" style={{ width: listW }}>
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

      <section style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--bg)' }}>
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
            <div className={'conv-wrap' + (atBottom ? ' at-bottom' : '')}>
              <div className="conv-scroll" ref={streamRef} onScroll={onStreamScroll}>
                <div className="conv-col" ref={colRef} onAnimationEnd={onTurnRiseEnd}>{stream}</div>
              </div>
              {/* 消息滑到对话框上方时渐隐淡出（纯背景色渐变，比 mask 便宜，不拖累滚动） */}
              <div className="conv-fade" aria-hidden />
            </div>
            <div className="composer-wrap">
              <div className="composer-inner">
                {ac && (
                  <div className="ac-panel">
                    {ac.items.map((c, i) => (
                      <div key={c.name} className={'ac-item' + (i === ac.sel ? ' sel' : '')} onClick={() => pickAc(c)}>
                        <span className="mono">/{c.name}</span>
                        <span className="d">{c.description}{c.enabled === false ? '（未开启）' : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
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
                      onChange={(e) => { setInput(e.target.value); onInput(e.target.value); autogrow(e.target); }}
                      onKeyDown={onKey}
                      onKeyUp={syncCaret}
                      onFocus={syncCaret}
                      onScroll={syncCaret}
                    />
                  </div>
                  <div className="composer-bar">
                    <div className="cmp-wrap">
                      <button type="button" className={'cmp-pill' + (modelOpen ? ' open' : '')}
                        aria-haspopup="menu" aria-expanded={modelOpen} aria-label="选择对话模型与工作模型"
                        onClick={() => { setModelOpen((v) => !v); loadModels(); }}>
                        <span className="nm">{chatLabel}</span>
                      </button>
                    </div>
                    <span className="flex" />
                    <button className="send-btn" aria-label="发送消息" onClick={send}>
                      <Icon name="send" />
                    </button>
                  </div>
                </div>

                {modelOpen && (
                  <div className="cmp-menu" role="menu" aria-label="模型选择">
                    {!models ? <div className="mp-head">正在读取模型列表…</div> : (
                      <>
                        <div className="mp-head">对话模型</div>
                        {models.chains.chat.map((e, i) => (
                          <button key={`${e.provider}|${e.model}`} type="button" role="menuitemradio" aria-checked={e.state === 'current'}
                            className={'mp-item' + (e.state === 'current' ? ' sel' : '')}
                            onClick={() => pickChain('chat', i)}>
                            <span className="nm">{models.providers.find((p) => p.id === e.provider)?.label ?? e.provider}</span>
                            <span className="mp-desc mono">{e.model}</span>
                            <span className="mp-right">
                              {e.state === 'down' && <span className="tag err">掉线</span>}
                              {e.state !== 'current' && <span className="mp-desc">备 {i + 1}</span>}
                              {e.state === 'current' && <Icon name="check" size={14} />}
                            </span>
                          </button>
                        ))}
                        {!models.chains.chat.length && <div className="mp-item off"><span className="nm">未配置</span></div>}

                        <div className="mp-sep" />
                        <div className="mp-head">工作模型 · /work 子代理</div>
                        <button type="button" role="menuitemradio" aria-checked={!models.chains.work.length} className="mp-item"
                          onClick={followChat}>
                          <span className="nm">跟随对话模型</span>
                          <span className="mp-desc mono">{servingChat?.model ?? models.activeModel}</span>
                          <span className="mp-right">{!models.chains.work.length && <Icon name="check" size={14} />}</span>
                        </button>
                        {models.chains.work.map((e, i) => (
                          <button key={`${e.provider}|${e.model}`} type="button" role="menuitemradio" aria-checked={e.state === 'current'}
                            className={'mp-item' + (e.state === 'current' ? ' sel' : '')}
                            onClick={() => pickChain('work', i)}>
                            <span className="nm">{models.providers.find((p) => p.id === e.provider)?.label ?? e.provider}</span>
                            <span className="mp-desc mono">{e.model}</span>
                            <span className="mp-right">
                              {e.state === 'down' && <span className="tag err">掉线</span>}
                              {e.state !== 'current' && <span className="mp-desc">备 {i + 1}</span>}
                              {e.state === 'current' && <Icon name="check" size={14} />}
                            </span>
                          </button>
                        ))}

                        <div className="mp-sep" />
                        <button type="button" role="menuitem" className="mp-manage"
                          onClick={() => { setModelOpen(false); onNavigate?.('models'); }}>
                          <span>管理模型</span>
                          <span className="rt"><Icon name="chevron" size={12} /></span>
                        </button>
                        {chainErr && <div className="mset-err">{chainErr}</div>}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {/* 右侧「工作」抽屉：顶栏按钮开的，滑在主内容之上 */}
      <WorkDrawer chatKey={current?.key} open={!!workOpen} onClose={() => onCloseWork?.()} ctxByModel={ctxByModel} />
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

// memo：新消息到达时 entries 换了新数组，但旧条目还是同一批对象引用，
// 于是只有真正新增/变化的那一行会重渲染（否则 300 行 + markdown 每次全跑一遍）
const EntryRow = memo(function EntryRow({ e }: { e: Entry }) {
  if (e.type === 'message_in') {
    return (
      <div className="turn turn-user">
        <div className="meta">{e.nickname || e.userId || ''} · {fmtTime(e.ts)}{e.data?.files?.length ? '（含附件）' : ''}</div>
        <div className="bubble-user">{e.text || ''}</div>
      </div>
    );
  }
  if (e.type === 'message_out') {
    return (
      <div className="turn turn-assistant">
        <div className="text-md" dangerouslySetInnerHTML={{ __html: mdLite(e.text || '') + (e.data?.simulated ? '<span class="muted"> （桌面端模拟）</span>' : '') }} />
      </div>
    );
  }
  if (e.type === 'command') {
    return (
      <div className="turn turn-user">
        <div className="meta">{e.nickname || e.userId || ''} · {fmtTime(e.ts)}</div>
        <div className="bubble-user mono">/{e.text || ''}</div>
      </div>
    );
  }
  if (e.type === 'command_result') {
    return <div className="turn turn-assistant"><div className="text-md" dangerouslySetInnerHTML={{ __html: mdLite(e.text || '') }} /></div>;
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
