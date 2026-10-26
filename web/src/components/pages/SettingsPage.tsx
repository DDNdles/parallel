'use client';
import { FadeName } from '@/components/FadeName';
/** 设置：左分节导航（QQ 接入 / 模型 / 搜索 / 风控 / 拟人化 / 记忆）+ 右表单；协议端选择与可用性检测都在「QQ 接入」里 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, fmtTime } from '@/lib/api';
import { useSave } from '@/lib/useSave';
import { BrandInput } from '@/components/BrandInput';
import { PillSelect, type PillOpt } from '@/components/PillSelect';
import { Icon } from '@/components/Icon';
import { Switch } from '@/components/Modal';
import Hint from '@/components/Hint';

/** 拟人层配置（内核 humanlike 段）：开口时机对齐 MaiBot，发出去的样子是纯程序（按句分条 + 句边截断） */
interface Humanlike {
  /** 出站投递（纯程序）：按句分条 + 句边截断 + 打字节奏 + 单条长度上限 */
  outgoing: {
    splitReplyMessages: boolean; replyMaxCharacters: number; maxReplyTokens: number;
    bubbleSoftMaxCharacters: number; expectedBubbles?: number; maxBubbles?: number; bubbleWeights?: number[];
    typingEnabled?: boolean;
    typingBaseDelaySeconds: number; typingCharactersPerSecond: number;
    typingMaxDelaySeconds: number; typingJitterRatio: number; maxMessageCharacters: number;
  };
  timing: {
    pendingThreshold: number;
    talkValue: number; privateTalkValue: number;
    mentionedBotReply: boolean; onlyReplyWhenAt: boolean; focusMode: boolean;
  };
  merge: { enable: boolean; windowMs: number; maxWaitMs: number; bufferTtlMs: number; fireDelayMinMs: number; fireDelayMaxMs: number };
  /** 出站打断（纯程序）：她还在发气泡时对面插话，按概率把剩下的气泡砍掉 */
  interrupt?: { enable: boolean; probability: number };
  backoff: { baseSeconds: number; capSeconds: number; startCount: number; bypassPendingCount: number };
  /** 圈内黑话（表达学习）：先挖本群高频词再进 prompt 的参考节 */
  jargon?: { enable: boolean };
  /** 表达学习：学群友「什么情境下怎么说」，作为语气参考注入 */
  expression?: { enable: boolean };
  /** 戳一戳（chat 工具）：开关 + 冷却 / 小时上限 */
  poke: { enable?: boolean; minIntervalSeconds: number; maxPerHour: number };
  /** 贴表情（chat 工具）：在别人的群消息下面贴 QQ 表情回应 */
  reaction?: { enable?: boolean; minIntervalSeconds: number; maxPerHour: number };
  /** 重复惩罚：最近多轮反复出现的词/人设名 → 提醒 + 一次重写 */
  repetition?: {
    enable: boolean; windowMessages: number; minMessages: number; cooldownMinutes: number;
    maxPhrases: number; retry: boolean; maxStrikes: number;
  };
  /** 跟屏复读：>=N 位群友接连说同一句，bot 完整跟一条（纯程序，不走模型） */
  repeat?: { enable: boolean; minPeople: number; delayMaxSec: number; cooldownMin: number };
  proactive: { enable: boolean; idleSeconds: number };
  /** 聊天节奏反定型（HDSI ChatRhythm） */
  rhythm: { enable: boolean; mode: 'gentle' | 'balanced' | 'aggressive'; historyLimit: number; collapseMinSamples: number; exhaustLimit: number };
  /** 主体行动窗口（HDSI Agency） */
  agency: { enable: boolean; quietHours: string; minimumProactiveIntervalMinutes: number; maxWindowMinutes: number; maxCandidateHours: number };
  /** 日程（HDSI Schedule Preplan） */
  schedule: { enable: boolean; horizonHours: number; maxRules: number; maxExceptions: number };
}

/** work 子代理（pi 内核那套）。work.agent / work.agentsDir 是进阶配置键（手改 config.json 用），页面不管 */
interface Work {
  maxDepth: number;
  compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}

interface Config {
  risk: { replyRatePerMin: number; proactive: Record<string, boolean> };
  /** flavor（协议端）与 llbot.mode（接入方式）不再有界面入口，只认手改 config.json（重启生效） */
  onebot: { host: string; port: number; reverseWsPath: string };
  ui?: { expectedQq?: string; chatPreview?: boolean };
  llm: { failoverThreshold: number };
  /** 每会话历史条数与上下文时间窗在 storage 段；旧内核没这个段，可选 */
  storage?: { historyLimit: number; contextMinutes?: number };
  /** 收件文件保留天数：内核存的是小时，界面按天给 */
  sandbox?: { inboxKeepDays: number };
  work: Work;
  persona: {
    /** 自动记忆提炼：攒够几轮、静默多久才发那一发；结果只落库，不进上下文 */
    memoryAutoSave: boolean; memoryMinTurns: number; memoryIdleSeconds: number; memoryMaxFacts: number;
    /** 后台画像与更早聊天的滚动摘要 */
    profileAuto?: boolean; midtermSummary?: boolean;
  };
  humanlike: Humanlike;
}

/** 协议端可用性检测的一条结果（/api/login/end/check） */
interface EndCheck { state: 'pass' | 'warn' | 'fail'; label: string; detail: string }

/** 当前托管协议端的状态包（/api/login/status 的 end 字段；各端字段有差异，缺当没有） */
interface EndStatus {
  running: boolean; pid?: number; home: string; webuiUrl: string; downloaded: boolean;
  restarts?: number; error?: string; mode?: 'pmhq' | 'direct'; qqProfile?: string; expectedQq?: string;
  online?: boolean; uin?: string; deviceId?: string; lastDrop?: { desc: string; at: number } | null;
  kickCode?: number; kickDesc?: string; kicksInWindow?: number; savedSessions?: string[];
}

/** GET /api/plugins/:id/config 的返回 */
interface PlugCfg { values: Record<string, unknown>; globalDefault: boolean }

const RHYTHM_MODES: PillOpt[] = [
  { v: 'gentle', t: '温和（仅完全同构才判定）' },
  { v: 'balanced', t: '平衡（加语气与字数判据）' },
  { v: 'aggressive', t: '激进（更早触发）' },
];
const SECTIONS: { v: string; t: string; icon: string }[] = [
  { v: 'onebot', t: 'QQ 接入', icon: 'plug' },
  { v: 'chat', t: '会话', icon: 'chats' },
  { v: 'model', t: '模型', icon: 'models' },
  { v: 'work', t: '工作', icon: 'work' },
  { v: 'sandbox', t: '沙箱', icon: 'file' },
  { v: 'search', t: '搜索', icon: 'globe' },
  { v: 'risk', t: '风控', icon: 'lock' },
  { v: 'humanlike', t: '拟人化', icon: 'think' },
  { v: 'persona', t: '记忆', icon: 'memory' },
  { v: 'sticker', t: '表情包', icon: 'sticker' },
  { v: 'bilibili', t: 'b站搜索', icon: 'bilibili' },
  { v: 'imagegen', t: '生图', icon: 'image' },
];

export default function SettingsPage() {
  const [c, setC] = useState<Config | null>(null);
  const [sec, setSec] = useState('onebot');
  const [end, setEnd] = useState<EndStatus | null>(null);
  const [checks, setChecks] = useState<EndCheck[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const [qq, setQq] = useState('');
  const [tavily, setTavily] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [maxRes, setMaxRes] = useState(3);
  /** 已从插件页挪走的能力：联网搜索（web-search）+ 三个插件页的配置分节；读不到的插件为 null（分节给「未启用」空态） */
  const [plug, setPlug] = useState<{ web: PlugCfg; sticker: PlugCfg | null; bilibili: PlugCfg | null; imagegen: PlugCfg | null } | null>(null);
  /** 插件配置的可编辑镜像：本地先行，写入走 autoSavePlug 防抖（密钥不进这份、不随普通字段回写） */
  const [pv, setPv] = useState<{ sticker: Record<string, unknown>; bilibili: Record<string, unknown>; imagegen: Record<string, unknown> } | null>(null);
  const [showBili, setShowBili] = useState(false);
  const [showGen, setShowGen] = useState(false);
  /** sessdata / apiKey 这类密钥的本地输入：null = 没动过，跟着服务端回显 */
  const [biliKey, setBiliKey] = useState<string | null>(null);
  const [genKey, setGenKey] = useState<string | null>(null);
  /** 本页所有写入失败都在这里就地报红 */
  const { err, setErr, save, run, fail } = useSave();
  /** 即时保存的防抖句柄：同一节的连续修改只发最后一拍 */
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** 防抖窗口内同一插件改过的字段要累加：只留最后一拍的值会把前一个字段的修改吞掉 */
  const pendingPlug = useRef<Record<string, Record<string, unknown>>>({});

  /** 插件配置读取的序号：慢的旧响应不许覆盖新状态，否则删掉的 key 会被端回来 */
  const plugSeq = useRef(0);
  const loadPlug = useCallback((): Promise<void> => {
    const seq = ++plugSeq.current;
    return Promise.all([
      get('/api/plugins/web-search/config').catch(() => null),
      get('/api/plugins/sticker/config').catch(() => null),
      get('/api/plugins/bilibili/config').catch(() => null),
      get('/api/plugins/imagegen/config').catch(() => null),
    ] as const).then(([web, sticker, bilibili, imagegen]: (PlugCfg | null)[]) => {
      if (seq !== plugSeq.current) return;
      // 四个全读不通多半是内核没起来，维持「读取中」而不是满屏「未启用」
      if (!web && !sticker && !bilibili && !imagegen) return;
      setPlug({ web: web ?? { values: {}, globalDefault: true }, sticker, bilibili, imagegen });
      setMaxRes(Number(web?.values.maxResults ?? 3));
      const rec = (p: PlugCfg | null) => { const { apiKey: _a, sessdata: _s, ...rest } = p?.values ?? {}; return rest; };
      setPv({ sticker: rec(sticker), bilibili: rec(bilibili), imagegen: rec(imagegen) });
    });
  }, []);
  const savePlug = (id: string, values: Record<string, unknown>) =>
    run(() => post(`/api/plugins/${id}/config`, { values }), loadPlug);

  const refreshInfo = useCallback(async () => {
    try {
      const st = await get('/api/login/status');
      if (!st.end) return;
      setEnd(st.end);
    } catch { setEnd(null); }
  }, []);

  /** 可用性检测：内核逐项实测（发行包 / 前提 / 进程 / 控制台 / 反向 WS） */
  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const r = await post('/api/login/end/check');
      setChecks((r.checks ?? []) as EndCheck[]);
    } catch {
      setChecks([{ state: 'fail', label: '检测', detail: '检测请求未走通' }]);
    } finally {
      setCheckedAt(Date.now());
      setChecking(false);
    }
  }, []);

  const loadCfg = useCallback(async () => {
    const cfg: Config = await get('/api/config');
    setC(cfg);
    setQq(cfg.ui?.expectedQq ?? '');
    refreshInfo();
    loadPlug();
    void runCheck();
  }, [refreshInfo, loadPlug, runCheck]);
  useEffect(() => { void loadCfg().catch(() => {}); }, [loadCfg]);

  /** 停留在 QQ 接入分节时自动体检（15s 一拍，本地探针很轻）；手动检测在跑就让路，节拍顺延 */
  useEffect(() => {
    if (sec !== 'onebot') return;
    const t = setInterval(() => { if (!checking) void runCheck(); }, 15000);
    return () => clearInterval(t);
  }, [sec, checking, runCheck]);

  /** 回复时机的编辑范围：群聊 / 私聊（2026-10-23 起不再按单个会话覆盖） */
  const [timingScope, setTimingScope] = useState<'group' | 'private'>('group');

  if (!c) return <div className="mset-empty">加载中…</div>;
  const r = c.risk;
  const h = c.humanlike;
  const rep = h.repetition ?? {
    enable: true, windowMessages: 20, minMessages: 3, cooldownMinutes: 30,
    maxPhrases: 3, retry: true, maxStrikes: 3,
  };
  const intr = h.interrupt;
  const patch = (p: Partial<Config>) => setC({ ...c, ...p });
  /** 即时保存：本地 state 先行；immediate=true（开关/选择类单次事件）立即发，输入框默认 600ms 防抖只发最后一拍 */
  const autoSave = (key: string, delay: number, body: Record<string, unknown>) => {
    if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => {
      delete saveTimers.current[key];
      save('/api/config', body);
    }, delay);
  };
  const autoSavePlug = (id: string, delay: number, values: Record<string, unknown>) => {
    const key = `plug:${id}`;
    pendingPlug.current[key] = { ...(pendingPlug.current[key] ?? {}), ...values };
    if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => {
      delete saveTimers.current[key];
      const merged = pendingPlug.current[key] ?? values;
      delete pendingPlug.current[key];
      savePlug(id, merged);
    }, delay);
  };
  const patchH = (p: Partial<Humanlike>, immediate = false) => {
    const nh = { ...h, ...p } as Humanlike;
    patch({ humanlike: nh });
    autoSave('humanlike', immediate ? 0 : 600, { humanlike: nh });
  };
  /** 改「回复时机」：群聊/私聊各一套字段，都写全局配置 */
  const patchTiming = (part: Partial<Humanlike['timing']>, immediate = false) => {
    const nt = { ...h.timing, ...part };
    patch({ humanlike: { ...h, timing: nt } });
    autoSave('humanlike', immediate ? 0 : 600, { humanlike: { ...h, timing: nt } });
  };
  /** Tavily key：没动过就一直跟着服务端回显（明文回传，跟模型页同一口径） */
  const storedKey = String(plug?.web.values.apiKey ?? '').trim();
  const webKey = tavily ?? storedKey;

  /**
   * Tavily key 落库（空串 = 真删）。成功后先本地认账再刷新：
   * 直接 setTavily(null) 会让输入框回落到 plug 里那个旧 storedKey，
   * 删掉的 key 于是当场"复活"，刷新没落地时切页回来还挂着 —— 就是这次要修的根因。
   */
  const saveWebKey = (key: string, extra: Record<string, unknown> = {}) => {
    run(() => post('/api/plugins/web-search/config', { values: { apiKey: key, ...extra } }), () => {
      setPlug((p) => (p ? { ...p, web: { ...p.web, values: { ...p.web.values, apiKey: key } } } : p));
      setTavily(null);
      void loadPlug();
    });
  };

  /** 插件页配置分节的字段写入：本地镜像先行，开关 0ms 即发、数字/文本 600ms 防抖（镜像不含密钥，整包回写也带不走密钥） */
  const setPlugVal = (id: 'sticker' | 'bilibili' | 'imagegen', part: Record<string, unknown>, delay = 600) => {
    if (!pv) return;
    setPv({ ...pv, [id]: { ...pv[id], ...part } });
    autoSavePlug(id, delay, part);
  };
  /** 密钥落库（空串 = 真删）：与 Tavily key 同一口径——先本地认账再刷新，删掉的不许当场"复活" */
  const savePlugKey = (id: 'bilibili' | 'imagegen', key: string, val: string, cleared: () => void) => {
    run(() => post(`/api/plugins/${id}/config`, { values: { [key]: val } }), () => {
      setPlug((p) => (p && p[id] ? { ...p, [id]: { ...p[id]!, values: { ...p[id]!.values, [key]: val } } } : p));
      cleared();
      void loadPlug();
    });
  };

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          <div className="mset-group">
            <div className="mset-group-t">设置</div>
            {SECTIONS.map((s) => (
              <button key={s.v} className={'mset-item' + (s.v === sec ? ' sel' : '')} onClick={() => setSec(s.v)}>
                <span className="mset-item-ic"><Icon name={s.icon} size={15} /></span>
                <FadeName text={s.t} />
              </button>
            ))}
          </div>
        </aside>

        <section className="mset-detail">
          <div className="mset-dhead">
            <span className="mset-dic"><Icon name={SECTIONS.find((s) => s.v === sec)!.icon} size={17} /></span>
            <h2 className="mset-dtitle">{SECTIONS.find((s) => s.v === sec)!.t}</h2>
          </div>
          {err && <div className="mset-err">{err}</div>}

          {sec === 'onebot' && (
            <>
              <div className="mset-sec-h"><span>协议端</span></div>

              <div className="mset-models">
                <div className="mset-mrow"><span className="plg-k">端点</span><span className="plg-v mono">ws://{c.onebot.host}:{c.onebot.port}{c.onebot.reverseWsPath}</span></div>
              </div>

              <div className="mset-sec-h">
                <span>可用性</span>
                <span className="plg-sec-r">
                  {checkedAt > 0 && <span className="plg-hint mono">{fmtTime(checkedAt)}</span>}
                  <button className="btn" disabled={checking} onClick={() => void runCheck()}>检测</button>
                </span>
              </div>
              <div className="mset-models ck-live" key={checkedAt}>
                {checks.map((ck) => (
                  <div className="mset-mrow" key={ck.label}>
                    <i className={'ck-dot ck-' + ck.state} />
                    <span className="ck-k">{ck.label}</span>
                    <span className="plg-v mono">{ck.detail}</span>
                  </div>
                ))}
              </div>

              <div className="mset-field">
                <label className="mset-flabel">账号</label>
                <BrandInput className="mono" value={qq} spellCheck={false}
                  onChange={(e) => setQq(e.target.value)}
                  onBlur={async () => {
                    try { await post('/api/config', { expectedQq: qq.trim() }); setErr(''); refreshInfo(); void runCheck(); }
                    catch (e) { fail(e); }
                  }} />
              </div>

              <div className="set-row">
                <button className="btn" onClick={async () => {
                  try { await post('/api/login/end/restart'); setErr(''); refreshInfo(); void runCheck(); }
                  catch (e) { setErr(`重启协议端失败：${(e as Error)?.message ?? String(e)}`); }
                }}>重启协议端</button>
                <button className="btn" onClick={() => window.open(end?.webuiUrl ?? '', '_blank')}>打开控制台</button>
              </div>
            </>
          )}

          {sec === 'chat' && (() => {
            // 旧内核没有这些键就不渲染：重启内核后出现
            const rp = h?.repeat;
            const setRp = (p: Partial<NonNullable<Humanlike['repeat']>>, immediate = false) =>
              rp && patchH({ repeat: { ...rp, ...p } }, immediate);
            return (
              <>
                {c.storage?.contextMinutes !== undefined && (
                  <div className="set-grid">
                    <Num label="传入上下文时限分钟" value={c.storage.contextMinutes}
                      onChange={(v) => { patch({ storage: { ...c.storage!, contextMinutes: v } }); autoSave('storage', 600, { storage: { contextMinutes: v } }); }} />
                  </div>
                )}
                {rp && (
                  <div className="set-grid">
                    <Num label="复读触发人数" value={rp.minPeople} onChange={(v) => setRp({ minPeople: v })} />
                    <Num label="复读延迟秒数" value={rp.delayMaxSec} onChange={(v) => setRp({ delayMaxSec: v })} />
                    <Num label="复读冷却分钟" value={rp.cooldownMin} onChange={(v) => setRp({ cooldownMin: v })} />
                  </div>
                )}

                <div className="mset-sec-h"><span>开关</span></div>
                <div className="mset-models">
                  <div className="mset-mrow">
                    <span className="plg-v">群友头像与图片缩略图</span>
                    <span className="mset-macts"><Switch on={c.ui?.chatPreview !== false}
                      onChange={() => { const on = !(c.ui?.chatPreview !== false); patch({ ui: { ...c.ui, chatPreview: on } }); autoSave('ui', 0, { ui: { chatPreview: on } }); }} /></span>
                  </div>
                  {rp && (
                    <div className="mset-mrow">
                      <span className="plg-v">跟屏复读</span>
                      <span className="mset-macts"><Switch on={rp.enable !== false}
                        onChange={() => setRp({ enable: !(rp.enable !== false) }, true)} /></span>
                    </div>
                  )}
                </div>
              </>
            );
          })()}

          {sec === 'model' && (
            <>
              <div className="set-grid">
                <Num label="模型降级阈值" hint="切换到下一个模型的连续失败次数" value={c.llm.failoverThreshold}
                  onChange={(v) => { patch({ llm: { ...c.llm, failoverThreshold: v } }); autoSave('llm', 600, { llm: { failoverThreshold: v } }); }}
                />
              </div>
            </>
          )}

          {sec === 'work' && (!c.work ? <div className="mset-empty">内核尚未重启，这个分节还读不到：重启内核后出现。</div> : (
            <>
              <div className="set-grid">
                <Num label="嵌套上限" hint="子代理继续派生子代理的层数上限，取值 0-5"
                  value={c.work.maxDepth}
                  onChange={(v) => { patch({ work: { ...c.work, maxDepth: v } }); autoSave('work', 600, { work: { maxDepth: v } }); }} />
              </div>
              <div className="set-grid" style={{ marginTop: 14 }}>
                <Num label="保留最近原文" hint="触发压缩时，最近这段对话保留原文"
                  value={c.work.compaction.keepRecentTokens}
                  onChange={(v) => { const comp = { ...c.work.compaction, keepRecentTokens: v }; patch({ work: { ...c.work, compaction: comp } }); autoSave('work', 600, { work: { compaction: comp } }); }} />
                <Num label="为回复预留" hint="为模型即将生成的回复在上下文窗口里留出的空间"
                  value={c.work.compaction.reserveTokens}
                  onChange={(v) => { const comp = { ...c.work.compaction, reserveTokens: v }; patch({ work: { ...c.work, compaction: comp } }); autoSave('work', 600, { work: { compaction: comp } }); }} />
              </div>

              <div className="set-grid" style={{ marginTop: 14 }}>
                {c.storage && <Num label="每会话历史条数" hint="模型每次读取的最近消息条数" value={c.storage.historyLimit}
                  onChange={(v) => { patch({ storage: { ...c.storage!, historyLimit: v } }); autoSave('storage', 600, { storage: { historyLimit: v } }); }} />}
              </div>

              <div className="mset-models" style={{ marginTop: 14 }}>
                <div className="mset-mrow">
                  <span className="plg-v">上下文超窗自动压缩</span>
                  <span className="mset-macts"><Switch on={c.work.compaction.enabled}
                    onChange={() => { const comp = { ...c.work.compaction, enabled: !c.work.compaction.enabled }; patch({ work: { ...c.work, compaction: comp } }); autoSave('work', 0, { work: { compaction: comp } }); }} /></span>
                </div>
              </div>
            </>
          ))}

          {sec === 'sandbox' && (!c.sandbox ? <div className="mset-empty">内核尚未重启，这个分节还读不到：重启内核后出现。</div> : (
            <div className="set-grid">
              <Num label="收件文件保留天数"
                value={c.sandbox.inboxKeepDays}
                onChange={(v) => { patch({ sandbox: { inboxKeepDays: v } }); autoSave('sandbox', 600, { sandbox: { inboxKeepDays: v } }); }} />
            </div>
          ))}

          {sec === 'search' && (!plug ? <div className="mset-empty">读取中…</div> : (
            <div key="search">
              <div className="mset-field">
                <label className="mset-flabel">Tavily API Key
                  {/* 新标签页打开官网（注册/取 key），不触碰当前页的未保存输入 */}
                  <a className="mset-keylink" style={{ marginLeft: 8 }} href="https://www.tavily.com" target="_blank" rel="noreferrer">获取</a>
                </label>
                <div className="mset-keywrap">
                  <BrandInput type={showKey ? 'text' : 'password'} value={webKey} spellCheck={false}
                    autoComplete="new-password"
                    onChange={(e) => setTavily(e.target.value)}
                    onBlur={() => {
                      const key = webKey.trim();
                      if (key === storedKey) { setTavily(null); return; }
                      // 写成功才放弃本地输入；失败就留着用户填的内容 + 就地报红，别静默弹回旧值
                      saveWebKey(key);
                    }} />
                  <button className="mset-ibtn in" title={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey((v) => !v)}>
                    <Icon name={showKey ? 'eyeOff' : 'eye'} size={15} />
                  </button>
                </div>
              </div>
              <div className="set-grid">
                <div className="mset-field">
                  <label className="mset-flabel">返回结果数</label>
                  <BrandInput type="number" value={maxRes} spellCheck={false}
                    onChange={(e) => { const n = Number(e.target.value); setMaxRes(n); autoSavePlug('web-search', 600, { maxResults: n }); }} />
                </div>
              </div>
            </div>
          ))}

          {sec === 'risk' && (
            <>
              <div className="set-grid">
                <Num label="发言上限" hint="每会话发言上限（条/分钟），默认 12" value={r.replyRatePerMin}
                  onChange={(v) => { patch({ risk: { ...r, replyRatePerMin: v } }); autoSave('risk', 600, { risk: { replyRatePerMin: v } }); }} />
              </div>
            </>
          )}

          {sec === 'humanlike' && (!h.outgoing || !h.rhythm || !h.agency || !h.schedule || !h.poke || !h.reaction || !intr ? <div className="mset-empty">内核尚未重启，这个分节还读不到：重启内核后出现。</div> : (
            <>
              <div className="mset-sec-h"><span>回复时机</span></div>
              <div className="set-grid">
                <div className="mset-field timing-scope">
                  <label className="mset-flabel">作用会话</label>
                  <PillSelect align="left" value={timingScope} label="作用会话"
                    options={[
                      { v: 'group', t: '群聊' },
                      { v: 'private', t: '私聊' },
                    ]}
                    onChange={(v) => setTimingScope(v === 'private' ? 'private' : 'group')} />
                </div>
                {timingScope === 'group' ? (<>
                  <Num label="触发所需积压条数"
                    hint="快群攒够这么多条开口；慢群按节奏自动放宽（最低 5）。问句减半、刷屏加倍、深夜更矜持；攒到八成五起按概率提前开口"
                    value={h.timing.pendingThreshold}
                    onChange={(v) => patchTiming({ pendingThreshold: v })} />
                  <Num label="群聊频率（0-1）"
                    hint="0 = 静默；大于 0 时开口条数只看上面的积压条数"
                    decimal value={h.timing.talkValue}
                    onChange={(v) => patchTiming({ talkValue: v })} />
                </>) : (
                  <Num label="私聊频率（0-1）" decimal value={h.timing.privateTalkValue}
                    onChange={(v) => patchTiming({ privateTalkValue: v })} />
                )}
              </div>
              {timingScope === 'group' && (
                <div className="mset-models" style={{ marginTop: 14 }}>
                  <div className="mset-mrow">
                    <span className="plg-v">仅 @ 后才回复</span>
                    <span className="mset-macts"><Switch on={h.timing.onlyReplyWhenAt}
                      onChange={() => patchTiming({ onlyReplyWhenAt: !h.timing.onlyReplyWhenAt }, true)} /></span>
                  </div>
                  {!h.timing.onlyReplyWhenAt && (
                    <div className="mset-mrow">
                      <span className="plg-v">提到名字时倾向回复</span>
                      <span className="mset-macts"><Switch on={h.timing.mentionedBotReply}
                        onChange={() => patchTiming({ mentionedBotReply: !h.timing.mentionedBotReply }, true)} /></span>
                    </div>
                  )}
                  <div className="mset-mrow">
                    <span className="plg-v">专注模式<Hint text="不参与群聊活跃度打分，只对强相关的内容说话。" /></span>
                    <span className="mset-macts"><Switch on={h.timing.focusMode}
                      onChange={() => patchTiming({ focusMode: !h.timing.focusMode }, true)} /></span>
                  </div>
                </div>
              )}

              <div className="mset-sec-h"><span>发送方式</span></div>
              <div className="set-grid" style={{ marginTop: 14 }}>
                <Num label="回复最长字符数" hint="硬上限；提示里的推荐字数与气泡数见下面两项" value={h.outgoing.replyMaxCharacters}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, replyMaxCharacters: v } })} />
                <Num label="回复 token 上限" value={h.outgoing.maxReplyTokens}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, maxReplyTokens: v } })} />
                <Num label="预期气泡数（提示推荐）" hint="写进提示词的推荐条数，模型尽量照着来；必要时可突破" value={h.outgoing.expectedBubbles ?? 3}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, expectedBubbles: Math.max(1, Math.round(v)) } })} />
                <Num label="最大气泡数（硬上限）" hint="程序分条的条数上限：超出的气泡会被合并成一条" value={h.outgoing.maxBubbles ?? 6}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, maxBubbles: Math.max(1, Math.round(v)) } })} />
                <BubbleSlider h={h} patchH={patchH} />
                <Num label="单条气泡目标字数" value={h.outgoing.bubbleSoftMaxCharacters}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, bubbleSoftMaxCharacters: v } })} />
                {h.outgoing.typingEnabled === true && (<>
                  <Num label="打字基础延迟（秒）" value={h.outgoing.typingBaseDelaySeconds}
                    onChange={(v) => patchH({ outgoing: { ...h.outgoing, typingBaseDelaySeconds: v } })} />
                  <Num label="打字速度（字/秒）" value={h.outgoing.typingCharactersPerSecond}
                    onChange={(v) => patchH({ outgoing: { ...h.outgoing, typingCharactersPerSecond: v } })} />
                  <Num label="单条最大打字时长" value={h.outgoing.typingMaxDelaySeconds}
                    onChange={(v) => patchH({ outgoing: { ...h.outgoing, typingMaxDelaySeconds: v } })} />
                  <Num label="打字抖动比例（%）" value={Math.round(h.outgoing.typingJitterRatio * 100)}
                    onChange={(v) => patchH({ outgoing: { ...h.outgoing, typingJitterRatio: Math.min(50, Math.max(0, v)) / 100 } })} />
                </>)}
                <Num label="单条最大字符数" value={h.outgoing.maxMessageCharacters}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, maxMessageCharacters: v } })} />
              </div>
              <div className="mset-models" style={{ marginTop: 14 }}>
                <div className="mset-mrow">
                  <span className="plg-v">模拟打字延迟</span>
                  <span className="mset-macts"><Switch on={h.outgoing.typingEnabled === true}
                    onChange={() => patchH({ outgoing: { ...h.outgoing, typingEnabled: !(h.outgoing.typingEnabled === true) } }, true)} /></span>
                </div>
              </div>

              <div className="mset-sec-h"><span>消息合并与主动发言</span></div>
              <div className="mset-models">
                <div className="mset-mrow">
                  <span className="plg-v">合并多条消息后回复<Hint text="群友连续多条消息发送时等待" /></span>
                  <span className="mset-macts"><Switch on={h.merge.enable}
                    onChange={() => patchH({ merge: { ...h.merge, enable: !h.merge.enable } }, true)} /></span>
                </div>
                <div className="mset-mrow">
                  <span className="plg-v">无人发言时主动发起话题</span>
                  <span className="mset-macts"><Switch on={h.proactive.enable}
                    onChange={() => patchH({ proactive: { ...h.proactive, enable: !h.proactive.enable } }, true)} /></span>
                </div>
              </div>
              <div className="set-grid" style={{ marginTop: 14 }}>
                <Num label="合并静默窗口（毫秒）" hint="判定一段连续对话结束的静默阈值" value={h.merge.windowMs}
                  onChange={(v) => patchH({ merge: { ...h.merge, windowMs: v } })} />
                <Num label="合并最长等待（毫秒）" hint="一段连续对话存在的最大时间" value={h.merge.maxWaitMs}
                  onChange={(v) => patchH({ merge: { ...h.merge, maxWaitMs: v } })} />
                <Num label="攒着消息作废（毫秒）" value={h.merge.bufferTtlMs}
                  onChange={(v) => patchH({ merge: { ...h.merge, bufferTtlMs: v } })} />
                <Num label="起跳随机延时下限（毫秒）" value={h.merge.fireDelayMinMs}
                  onChange={(v) => patchH({ merge: { ...h.merge, fireDelayMinMs: v } })} />
                <Num label="起跳随机延时上限（毫秒）" value={h.merge.fireDelayMaxMs}
                  onChange={(v) => patchH({ merge: { ...h.merge, fireDelayMaxMs: v } })} />
                <Num label="主动发言所需静默时长（秒）" value={h.proactive.idleSeconds}
                  onChange={(v) => patchH({ proactive: { ...h.proactive, idleSeconds: v } })} />
                <Num label="退避起点（轮）" hint="连续多轮评估未发言后，等待逐轮翻倍；群热闹起来（近 5 分钟 ≥3 条真人消息）会清零" value={h.backoff.startCount}
                  onChange={(v) => patchH({ backoff: { ...h.backoff, startCount: v } })} />
                <Num label="退避基准（秒）" value={h.backoff.baseSeconds}
                  onChange={(v) => patchH({ backoff: { ...h.backoff, baseSeconds: v } })} />
                <Num label="退避上限（秒）" value={h.backoff.capSeconds}
                  onChange={(v) => patchH({ backoff: { ...h.backoff, capSeconds: v } })} />
                <Num label="绕过退避的积压条数" hint="积压到这么多条直接跳过退避开口评估" value={h.backoff.bypassPendingCount}
                  onChange={(v) => patchH({ backoff: { ...h.backoff, bypassPendingCount: v } })} />
              </div>

              <div className="mset-sec-h"><span>插话打断</span></div>
              <div className="mset-models">
                <div className="mset-mrow">
                  <span className="plg-v">说话时被插话就停下<Hint text="她还在生成回复或逐条发气泡时，群里有人插话：生成中的整轮会作废，剩余没发出的气泡按概率砍掉。" /></span>
                  <span className="mset-macts"><Switch on={intr.enable !== false}
                    onChange={() => patchH({ interrupt: { ...intr, enable: !(intr.enable !== false) } }, true)} /></span>
                </div>
              </div>
              <div className="set-grid" style={{ marginTop: 14 }}>
                <Num label="插话打断概率（%）" hint="0 = 从不打断，100 = 每句插话都打断。@ 触发的回复目前也受这个概率影响。" value={Math.round(intr.probability * 100)}
                  onChange={(v) => patchH({ interrupt: { ...intr, probability: Math.min(100, Math.max(0, v)) / 100 } })} />
              </div>

              <div className="mset-sec-h"><span>群聊行为</span></div>
              <div className="mset-models">
                <div className="mset-mrow">
                  <span className="plg-v">圈内黑话<Hint text="先记本群高频词，判准了才进 prompt 参考" /></span>
                  <span className="mset-macts"><Switch on={h.jargon?.enable !== false}
                    onChange={() => patchH({ jargon: { enable: !(h.jargon?.enable !== false) } }, true)} /></span>
                </div>
                <div className="mset-mrow">
                  <span className="plg-v">表达学习</span>
                  <span className="mset-macts"><Switch on={h.expression?.enable !== false}
                    onChange={() => patchH({ expression: { enable: !(h.expression?.enable !== false) } }, true)} /></span>
                </div>
                <div className="mset-mrow">
                  <span className="plg-v">重复惩罚</span>
                  <span className="mset-macts"><Switch on={rep.enable !== false}
                    onChange={() => patchH({ repetition: { ...rep, enable: !(rep.enable !== false) } }, true)} /></span>
                </div>
                <div className="mset-mrow">
                  <span className="plg-v">节奏反定型<Hint text="回复结构固化时纠偏" /></span>
                  <span className="mset-macts"><Switch on={h.rhythm.enable}
                    onChange={() => patchH({ rhythm: { ...h.rhythm, enable: !h.rhythm.enable } }, true)} /></span>
                </div>
                <div className="mset-mrow">
                  <span className="plg-v">行动容量<Hint text="日程与安静时段限制主动发言" /></span>
                  <span className="mset-macts"><Switch on={h.agency.enable}
                    onChange={() => patchH({ agency: { ...h.agency, enable: !h.agency.enable } }, true)} /></span>
                </div>
              </div>
              <div className="mset-sec-h"><span>戳一戳</span></div>
              <div className="mset-models">
                <div className="mset-mrow">
                  <span className="plg-v">允许在聊天里戳人<Hint text="QQ 双击头像；只在有明确对象时由她自己判断要不要戳" /></span>
                  <span className="mset-macts"><Switch on={h.poke.enable !== false}
                    onChange={() => patchH({ poke: { ...h.poke, enable: !(h.poke.enable !== false) } }, true)} /></span>
                </div>
              </div>
              <div className="set-grid" style={{ marginTop: 14 }}>
                <Num label="两次戳的最小间隔（秒）" value={h.poke.minIntervalSeconds}
                  onChange={(v) => patchH({ poke: { ...h.poke, minIntervalSeconds: v } })} />
                <Num label="每小时最多戳几次（0=不限）" value={h.poke.maxPerHour}
                  onChange={(v) => patchH({ poke: { ...h.poke, maxPerHour: v } })} />
              </div>
              <div className="mset-sec-h"><span>贴表情</span></div>
              <div className="mset-models">
                <div className="mset-mrow">
                  <span className="plg-v">允许在别人的消息下贴表情<Hint text="QQ 消息下面的表情回应；只在群聊可用，贴不贴由她自己判断" /></span>
                  <span className="mset-macts"><Switch on={h.reaction!.enable !== false}
                    onChange={() => patchH({ reaction: { ...h.reaction!, enable: !(h.reaction!.enable !== false) } }, true)} /></span>
                </div>
              </div>
              <div className="set-grid" style={{ marginTop: 14 }}>
                <Num label="两次贴表情的最小间隔（秒）" value={h.reaction!.minIntervalSeconds}
                  onChange={(v) => patchH({ reaction: { ...h.reaction!, minIntervalSeconds: v } })} />
                <Num label="每小时最多贴几次（0=不限）" value={h.reaction!.maxPerHour}
                  onChange={(v) => patchH({ reaction: { ...h.reaction!, maxPerHour: v } })} />
              </div>
              <div className="mset-field" style={{ marginTop: 14 }}>
                <label className="mset-flabel">节奏反定型档位</label>
                <PillSelect align="left" value={h.rhythm.mode} options={RHYTHM_MODES} label="档位"
                  onChange={(v) => patchH({ rhythm: { ...h.rhythm, mode: v as 'gentle' | 'balanced' | 'aggressive' } })} />
              </div>
              <div className="set-grid" style={{ marginTop: 14 }}>
                <Num label="节奏窗口轮数（5-20）" value={h.rhythm.historyLimit}
                  onChange={(v) => patchH({ rhythm: { ...h.rhythm, historyLimit: v } })} />
                <Num label="判定定型样本数（3-10）" value={h.rhythm.collapseMinSamples}
                  onChange={(v) => patchH({ rhythm: { ...h.rhythm, collapseMinSamples: v } })} />
                <Num label="熔断轮数（3-12）" value={h.rhythm.exhaustLimit}
                  onChange={(v) => patchH({ rhythm: { ...h.rhythm, exhaustLimit: v } })} />
                <Num label="主动最小间隔（分钟）" value={h.agency.minimumProactiveIntervalMinutes}
                  onChange={(v) => patchH({ agency: { ...h.agency, minimumProactiveIntervalMinutes: v } })} />
                <Num label="行动窗口有效期（分钟）" value={h.agency.maxWindowMinutes}
                  onChange={(v) => patchH({ agency: { ...h.agency, maxWindowMinutes: v } })} />
                <Num label="重复判定窗口轮数" value={rep.windowMessages}
                  onChange={(v) => patchH({ repetition: { ...rep, windowMessages: v } })} />
                <Num label="重复判定条数" value={rep.minMessages}
                  onChange={(v) => patchH({ repetition: { ...rep, minMessages: v } })} />
                <Num label="重复冷却分钟" value={rep.cooldownMinutes}
                  onChange={(v) => patchH({ repetition: { ...rep, cooldownMinutes: v } })} />
              </div>
              <div className="mset-field" style={{ marginTop: 14 }}>
                <label className="mset-flabel">安静时段（格式 HH:MM-HH:MM）</label>
                <BrandInput value={h.agency.quietHours} spellCheck={false}
                  onChange={(e) => patchH({ agency: { ...h.agency, quietHours: e.target.value } })} />
              </div>
            </>
          ))}

          {sec === 'persona' && (() => {
            const setP = (p: Partial<Config['persona']>, immediate = false) => {
              const np = { ...c.persona, ...p };
              patch({ persona: np });
              autoSave('persona', immediate ? 0 : 600, { persona: np });
            };
            return (
              <>
                <div className="set-grid">
                  <Num label="提炼所需轮数" value={c.persona.memoryMinTurns} onChange={(v) => setP({ memoryMinTurns: v })} />
                  <Num label="对话静默秒数" value={c.persona.memoryIdleSeconds} onChange={(v) => setP({ memoryIdleSeconds: v })} />
                  <Num label="每次最多记录条数" value={c.persona.memoryMaxFacts} onChange={(v) => setP({ memoryMaxFacts: v })} />
                </div>
                <div className="mset-models">
                  <div className="mset-mrow">
                    <span className="plg-v">自动保存记忆</span>
                    <span className="mset-macts"><Switch on={c.persona.memoryAutoSave !== false}
                      onChange={() => setP({ memoryAutoSave: c.persona.memoryAutoSave === false }, true)} /></span>
                  </div>
                  <div className="mset-mrow">
                    <span className="plg-v">用户画像</span>
                    <span className="mset-macts"><Switch on={c.persona.profileAuto !== false}
                      onChange={() => setP({ profileAuto: c.persona.profileAuto === false }, true)} /></span>
                  </div>
                  <div className="mset-mrow">
                    <span className="plg-v">聊天回想</span>
                    <span className="mset-macts"><Switch on={c.persona.midtermSummary !== false}
                      onChange={() => setP({ midtermSummary: c.persona.midtermSummary === false }, true)} /></span>
                  </div>
                </div>
              </>
            );
          })()}

          {sec === 'sticker' && (!plug || !pv ? <div className="mset-empty">读取中…</div> : !plug.sticker ? <div className="mset-empty">插件未启用，可在插件页开启。</div> : (() => {
            const sc = pv.sticker;
            const tagging = sc.modelTagging !== false;
            return (
              <>
                <div className="mset-models">
                  <div className="mset-mrow">
                    <span className="plg-v">自动打标签<Hint text="收录时模型看图写描述、标签与使用时机；只收用户明确要求收录的图" /></span>
                    <span className="mset-macts"><Switch on={tagging}
                      onChange={() => setPlugVal('sticker', { modelTagging: !tagging }, 0)} /></span>
                  </div>
                </div>
                <div className="set-grid" style={{ marginTop: 14 }}>
                  <Num label="列表最多列几张" value={Number(sc.promptListMax ?? 0)}
                    onChange={(v) => setPlugVal('sticker', { promptListMax: v })} />
                  <Num label="表情库上限" hint="满了拒收新图" value={Number(sc.maxLibrary ?? 0)}
                    onChange={(v) => setPlugVal('sticker', { maxLibrary: v })} />
                </div>
              </>
            );
          })())}

          {sec === 'bilibili' && (!plug || !pv ? <div className="mset-empty">读取中…</div> : !plug.bilibili ? <div className="mset-empty">插件未启用，可在插件页开启。</div> : (() => {
            const bc = pv.bilibili;
            const stored = String(plug.bilibili.values.sessdata ?? '').trim();
            const val = biliKey ?? stored;
            return (
              <>
                <div className="mset-field">
                  <label className="mset-flabel">SESSDATA<Hint text={'获取步骤：\n1. 浏览器先登录 b 站，在 b 站页面按 F12\n2. 顶部标签找「应用程序」，窗口窄时藏在 » 菜单里\n3. 左侧「存储」点 Cookie → www.bilibili.com；列表里没有它就是没登录过，先登录\n4. 中间表格名称列找 SESSDATA，点中那一行\n5. 底部「值」框里 Ctrl+A 全选复制（表格里那列值是截断的，直接复制会缺一截）\n粘进输入框点到别处自动保存。选填，不填只是拿不到 AI 字幕'} /></label>
                  <div className="mset-keywrap">
                    <BrandInput type={showBili ? 'text' : 'password'} value={val} spellCheck={false}
                      autoComplete="new-password"
                      onChange={(e) => setBiliKey(e.target.value)}
                      onBlur={() => {
                        const k = val.trim();
                        if (k === stored) { setBiliKey(null); return; }
                        // 写成功才放弃本地输入；失败留着用户填的内容 + 就地报红
                        savePlugKey('bilibili', 'sessdata', k, () => setBiliKey(null));
                      }} />
                    <button className="mset-ibtn in" title={showBili ? '隐藏密钥' : '显示密钥'} onClick={() => setShowBili((v) => !v)}>
                      <Icon name={showBili ? 'eyeOff' : 'eye'} size={15} />
                    </button>
                  </div>
                </div>
                <div className="set-grid">
                  <Num label="搜索返回条数" value={Number(bc.searchLimit ?? 0)}
                    onChange={(v) => setPlugVal('bilibili', { searchLimit: v })} />
                  <Num label="评论每页条数" value={Number(bc.commentLimit ?? 0)}
                    onChange={(v) => setPlugVal('bilibili', { commentLimit: v })} />
                  <Num label="请求间隔（毫秒）" hint="压一压别被 b 站风控" value={Number(bc.requestDelayMs ?? 0)}
                    onChange={(v) => setPlugVal('bilibili', { requestDelayMs: v })} />
                </div>
              </>
            );
          })())}

          {sec === 'imagegen' && (!plug || !pv ? <div className="mset-empty">读取中…</div> : !plug.imagegen ? <div className="mset-empty">插件未启用，可在插件页开启。</div> : (() => {
            const gc = pv.imagegen;
            const stored = String(plug.imagegen.values.apiKey ?? '').trim();
            const val = genKey ?? stored;
            const unlimited = gc.ownerUnlimited !== false;
            return (
              <>
                <div className="mset-field">
                  <label className="mset-flabel">API Key</label>
                  <div className="mset-keywrap">
                    <BrandInput type={showGen ? 'text' : 'password'} value={val} spellCheck={false}
                      autoComplete="new-password"
                      onChange={(e) => setGenKey(e.target.value)}
                      onBlur={() => {
                        const k = val.trim();
                        if (k === stored) { setGenKey(null); return; }
                        savePlugKey('imagegen', 'apiKey', k, () => setGenKey(null));
                      }} />
                    <button className="mset-ibtn in" title={showGen ? '隐藏密钥' : '显示密钥'} onClick={() => setShowGen((v) => !v)}>
                      <Icon name={showGen ? 'eyeOff' : 'eye'} size={15} />
                    </button>
                  </div>
                </div>
                <div className="mset-field">
                  <label className="mset-flabel">模型</label>
                  <BrandInput value={String(gc.model ?? '')} spellCheck={false}
                    onChange={(e) => setPlugVal('imagegen', { model: e.target.value })} />
                </div>
                <div className="mset-field">
                  <label className="mset-flabel">备用模型</label>
                  <BrandInput value={String(gc.fallbackModel ?? '')} spellCheck={false}
                    placeholder="留空 = 不轮换"
                    onChange={(e) => setPlugVal('imagegen', { fallbackModel: e.target.value })} />
                </div>
                <div className="mset-field">
                  <label className="mset-flabel">接口地址</label>
                  <BrandInput value={String(gc.baseUrl ?? '')} spellCheck={false}
                    placeholder="留空 = 官方地址"
                    onChange={(e) => setPlugVal('imagegen', { baseUrl: e.target.value })} />
                </div>
                <div className="set-grid">
                  <Num label="每人每周张数" value={Number(gc.weeklyQuota ?? 0)}
                    onChange={(v) => setPlugVal('imagegen', { weeklyQuota: v })} />
                </div>
                <div className="mset-models" style={{ marginTop: 14 }}>
                  <div className="mset-mrow">
                    <span className="plg-v">主人不限张数</span>
                    <span className="mset-macts"><Switch on={unlimited}
                      onChange={() => setPlugVal('imagegen', { ownerUnlimited: !unlimited }, 0)} /></span>
                  </div>
                </div>
              </>
            );
          })())}
        </section>
      </div>
    </div>
  );
}

/** 气泡数概率条（2026-10-25 第二版）：一条横向轨道按概率切成 N 段（每段=一种气泡条数），
 *  **段本身可拖动**——左右拖改变这一档的占比，其余段按比例让位（旧版拖边界一次牵动两档，
 *  被否）。拖没（占比 0）= 停用该档，下方数字标签仍可抓住拖回来。数据仍是 bubbleWeights
 *  权重数组（内核 pickBubbleTarget 逐档取权），段宽 = 权重/总和 的归一化占比。
 *  空 bubbleWeights = 自动三角分布（峰值=预期气泡数）预览，动一段即写入自定义。 */
function BubbleSlider({ h, patchH }: {
  h: Humanlike;
  patchH: (p: Partial<Humanlike>, immediate?: boolean) => void;
}) {
  const max = Math.max(1, Math.min(20, Math.round(h.outgoing.maxBubbles ?? 6)));
  const expected = Math.max(1, Math.min(max, Math.round(h.outgoing.expectedBubbles ?? 3)));
  const custom = h.outgoing.bubbleWeights ?? [];
  const isAuto = !custom.some((w) => Number.isFinite(w) && w > 0);
  // 自动三角分布（同 delivery.autoBubbleWeights）作预览与首次拖动的种子；自定义直接用存储权重
  const base = isAuto
    ? Array.from({ length: max }, (_v, i) => Math.max(0.15, 1 - Math.abs(i + 1 - expected) * 0.45))
    : Array.from({ length: max }, (_v, i) => {
      const w = custom[i];
      return Number.isFinite(w) ? Math.max(0, Math.min(100, w as number)) : 0;
    });
  const sum = base.reduce((a, b) => a + b, 0) || 1;
  const shares = base.map((w) => (w / sum) * 100);

  const [drag, setDrag] = useState<{ idx: number; startX: number; trackW: number; start: number[]; next: number[] } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const shown = drag ? drag.next : shares;

  const commit = (s: number[]) => {
    const clean = s.slice(0, max).map((x) => Math.max(0, Math.min(100, Math.round(x))));
    // 全 0 = 等于没配：清回空数组走自动分布（内核同口径）
    patchH({ outgoing: { ...h.outgoing, bubbleWeights: clean.some((x) => x > 0) ? clean : [] } }, true);
  };

  // 指针监听挂 window：拖出轨道不丢事件（不用 setPointerCapture，合成事件下会抛错）
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const dShare = ((e.clientX - drag.startX) / drag.trackW) * 100;
      const target = Math.max(0, Math.min(100, drag.start[drag.idx] + dShare));
      const rest = 100 - target;
      const oSum = drag.start.reduce((a, b, i) => (i === drag.idx ? a : a + b), 0);
      const next = drag.start.map((s, i) => {
        if (i === drag.idx) return target;
        return oSum > 0 ? (s * rest) / oSum : rest / Math.max(1, max - 1);
      });
      setDrag({ ...drag, next });
    };
    const up = () => { commit(drag.next); setDrag(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  const start = (i: number) => (e: React.PointerEvent) => {
    if (e.button !== 0 || max === 1) return;
    e.preventDefault();
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return;
    setDrag({ idx: i, startX: e.clientX, trackW: r.width, start: shares.slice(), next: shares.slice() });
  };

  return (
    <div className="mset-field" style={{ gridColumn: '1 / -1', marginBottom: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <label className="mset-flabel" style={{ marginBottom: 0 }}>气泡数概率
          <Hint text={'一条轨道切 N 段，每段=一种气泡条数，段宽=该档抽取概率。\n拖动任意一段改变它的概率，其余段按比例让位；拖没=停用该档（拖下方数字可恢复）'} />
        </label>
        {!isAuto && <button className="mset-add" onClick={() => commit([])}>恢复自动</button>}
      </div>
      <div ref={trackRef} className={`bbs-track${isAuto ? ' bbs-auto' : ''}${drag ? ' bbs-drag' : ''}`}>
        {shown.map((s, i) => (
          <div key={i} className={`bbs-seg${drag?.idx === i ? ' bbs-on' : ''}`}
            style={{ flexGrow: Math.max(s, 0.0001), flexBasis: 0 }}
            onPointerDown={start(i)}
            title={`${i + 1} 条 · ${Math.round(s)}%${!isAuto && s < 0.5 ? '（已停用）' : ''}`}>
            {s >= 10 && <span className="bbs-t">{i + 1} 条 · {Math.round(s)}%</span>}
          </div>
        ))}
      </div>
      <div className="bbs-labels">
        {shown.map((s, i) => (
          <span key={i} className={`bbs-lb${i + 1 === expected ? ' bbs-peak' : ''}`}
            style={{ flexGrow: Math.max(s, 0.0001), flexBasis: 0 }} onPointerDown={start(i)}>{i + 1}</span>
        ))}
      </div>
      <div className="plg-hint" style={{ marginTop: 8 }}>
        {isAuto
          ? '自动分布：峰值=预期气泡数，拖动任意一段即进入自定义'
          : `自定义 ${shown.filter((x) => x >= 0.5).length}/${max} 档参与抽取，每轮按段宽抽签`}
      </div>
    </div>
  );
}

function Num({ label, hint, value, onChange, decimal = false }: { label: string; hint?: string; value: number; onChange: (v: number) => void; decimal?: boolean }) {
  return (
    <div className="mset-field">
      <label className="mset-flabel">{label}
        {hint && (
          <span className="mset-hint" tabIndex={0} aria-label={hint}>
            <Icon name="help" size={13} />
            <span className="mset-hint-pop">{hint}</span>
          </span>
        )}
      </label>
      <BrandInput type="number" decimal={decimal} value={value} spellCheck={false} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
