'use client';
/** 设置：左分节导航（QQ 接入 / 模型 / 搜索 / 风控 / 拟人化 / 记忆）+ 右表单；协议端选择与可用性检测都在「QQ 接入」里 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, fmtTime } from '@/lib/api';
import { useSave } from '@/lib/useSave';
import { BrandInput } from '@/components/BrandInput';
import { PillSelect, type PillOpt } from '@/components/PillSelect';
import { Icon } from '@/components/Icon';
import { Switch } from '@/components/Modal';
import Hint from '@/components/Hint';

/** 拟人层配置（内核 humanlike 段）：开口时机对齐 MaiBot，发送方式对齐 HDSI */
interface Humanlike {
  /** 剧本体：模型写小说，仅 <say> 内的台词进 QQ */
  script: { enable: boolean };
  /** 出站投递（HDSI runtime）：分隔标记切分 + 打字节奏 + 单条长度上限 */
  outgoing: {
    splitReplyMessages: boolean; messageSeparator: string;
    typingBaseDelaySeconds: number; typingCharactersPerSecond: number;
    typingMaxDelaySeconds: number; typingJitterRatio: number; maxMessageCharacters: number;
  };
  timing: {
    replyTriggerMode: 'likelihood' | 'necessity' | 'frequency';
    pendingThreshold: number; necessityThreshold: number;
    talkValue: number; privateTalkValue: number;
    enableRules: boolean; rules: { platform: string; itemId: string; ruleType: 'group' | 'private' | 'any'; time: string; value: number }[];
    mentionedBotReply: boolean; inevitableAtReply: boolean; focusMode: boolean;
  };
  merge: { enable: boolean; windowMs: number; maxWaitMs: number; bufferTtlMs: number };
  backoff: { baseSeconds: number; capSeconds: number; startCount: number; bypassPendingCount: number };
  proactive: { enable: boolean; idleSeconds: number };
  /** 聊天节奏反定型（HDSI ChatRhythm） */
  rhythm: { enable: boolean; mode: 'gentle' | 'balanced' | 'aggressive'; historyLimit: number; collapseMinSamples: number; exhaustLimit: number };
  /** 情绪偏移（HDSI Alter） */
  alter: { enabled: boolean; baseThreshold: number; densityFactor: number; sameDirectionBoost: number; oppositeDecay: number; minWeight: number; maxIntensity: number };
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
  llm: { failoverThreshold: number; maxToolRounds?: number };
  /** 每会话历史条数在 storage 段（历史环形缓冲真正读的键）；旧内核没这个段，可选 */
  storage?: { historyLimit: number; contextMinutes?: number };
  /** 收件文件保留天数：内核存的是小时，界面按天给 */
  sandbox?: { inboxKeepDays: number };
  work: Work;
  persona: {
    memoryFactsTopK: number;
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

const TRIGGERS: PillOpt[] = [
  { v: 'likelihood', t: '拟合概率' },
  { v: 'necessity', t: '必要性' },
  { v: 'frequency', t: '频率' },
];
const RHYTHM_MODES: PillOpt[] = [
  { v: 'gentle', t: '温和（仅完全同构才判定）' },
  { v: 'balanced', t: '平衡（加语气与字数判据）' },
  { v: 'aggressive', t: '激进（更早触发）' },
];
const SECTIONS: { v: string; t: string; icon: string }[] = [
  { v: 'onebot', t: 'QQ 接入', icon: 'plug' },
  { v: 'chat', t: '会话', icon: 'chats' },
  { v: 'model', t: '模型', icon: 'bolt' },
  { v: 'work', t: '工作', icon: 'work' },
  { v: 'sandbox', t: '沙箱', icon: 'file' },
  { v: 'search', t: '搜索', icon: 'globe' },
  { v: 'risk', t: '风控', icon: 'lock' },
  { v: 'humanlike', t: '拟人化', icon: 'think' },
  { v: 'persona', t: '记忆', icon: 'memory' },
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
  /** 已从插件页挪走的能力：联网搜索（web-search）——含其全局默认 */
  const [plug, setPlug] = useState<{ web: PlugCfg } | null>(null);
  /** 本页所有写入失败都在这里就地报红 */
  const { err, setErr, save, run, fail } = useSave();
  /** 即时保存的防抖句柄：同一节的连续修改只发最后一拍 */
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  /** 插件配置读取的序号：慢的旧响应不许覆盖新状态，否则删掉的 key 会被端回来 */
  const plugSeq = useRef(0);
  const loadPlug = useCallback((): Promise<void> => {
    const seq = ++plugSeq.current;
    return get('/api/plugins/web-search/config').then((b: PlugCfg) => {
      if (seq !== plugSeq.current) return;
      setPlug({ web: b });
      setMaxRes(Number(b.values.maxResults ?? 3));
    }).catch(() => {});
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

  /** 全部已知会话（频率规则的「选群聊」下拉数据源）；进拟人化分节时拉一次 */
  const [chats, setChats] = useState<{ chatId: string; chatType: string; title?: string }[]>([]);
  useEffect(() => {
    if (sec !== 'humanlike') return;
    get('/api/chats').then((list: unknown) => setChats(Array.isArray(list) ? list : [])).catch(() => {});
  }, [sec]);

  if (!c) return <div className="mset-empty">加载中…</div>;
  const r = c.risk;
  const h = c.humanlike;
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
    if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => {
      delete saveTimers.current[key];
      savePlug(id, values);
    }, delay);
  };
  const patchH = (p: Partial<Humanlike>, immediate = false) => {
    const nh = { ...h, ...p } as Humanlike;
    patch({ humanlike: nh });
    autoSave('humanlike', immediate ? 0 : 600, { humanlike: nh });
  };
  /** 改第 i 条频率规则的某个字段（rules 编辑器用） */
  const setRule = (i: number, part: Partial<Humanlike['timing']['rules'][number]>) =>
    patchH({ timing: { ...h.timing, rules: h.timing.rules.map((r, j) => (j === i ? { ...r, ...part } : r)) } });
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

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          <div className="mset-group">
            <div className="mset-group-t">设置</div>
            {SECTIONS.map((s) => (
              <button key={s.v} className={'mset-item' + (s.v === sec ? ' sel' : '')} onClick={() => setSec(s.v)}>
                <span className="mset-item-ic"><Icon name={s.icon} size={15} /></span>
                <span className="mset-item-nm">{s.t}</span>
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

          {sec === 'chat' && (
            <div className="mset-models">
              <div className="mset-mrow">
                <span className="plg-v">群友头像与图片缩略图</span>
                <span className="mset-macts"><Switch on={c.ui?.chatPreview !== false}
                  onChange={() => { const on = !(c.ui?.chatPreview !== false); patch({ ui: { ...c.ui, chatPreview: on } }); autoSave('ui', 0, { ui: { chatPreview: on } }); }} /></span>
              </div>
              {/* 旧内核没有这个键就不渲染：重启内核后出现 */}
              {c.storage && c.storage.contextMinutes !== undefined && (
                <div className="set-grid" style={{ marginTop: 14 }}>
                  <Num label="传入上下文时限分钟" value={c.storage.contextMinutes}
                    onChange={(v) => { const st = c.storage; if (!st) return; patch({ storage: { ...st, contextMinutes: v } }); autoSave('storage', 600, { storage: { contextMinutes: v } }); }} />
                </div>
              )}
            </div>
          )}

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
                <Num label="chat 工具轮上限" value={c.llm.maxToolRounds ?? 8}
                  onChange={(v) => { patch({ llm: { ...c.llm, maxToolRounds: v } }); autoSave('llm', 600, { llm: { maxToolRounds: v } }); }} />
                {c.storage && <Num label="每会话历史条数" hint="模型每次读取的最近消息条数" value={c.storage.historyLimit}
                  onChange={(v) => { patch({ storage: { historyLimit: v } }); autoSave('storage', 600, { storage: { historyLimit: v } }); }} />}
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

          {sec === 'humanlike' && (!h.script || !h.outgoing || !h.rhythm || !h.alter || !h.agency || !h.schedule ? <div className="mset-empty">内核尚未重启，这个分节还读不到：重启内核后出现。</div> : (
            <>
              <div className="mset-sec-h"><span>回复时机</span></div>
              <div className="mset-field">
                <PillSelect align="left" value={h.timing.replyTriggerMode} options={TRIGGERS} label="触发方式"
                  onChange={(v) => patchH({ timing: { ...h.timing, replyTriggerMode: v as 'likelihood' | 'necessity' | 'frequency' } }, true)} />
              </div>
              <div className="set-grid">
                <Num label="触发所需积压条数" hint="频率模式的开口门槛，默认 12" value={h.timing.pendingThreshold}
                  onChange={(v) => patchH({ timing: { ...h.timing, pendingThreshold: v } })} />
                <Num label="必要性分数阈值（0-200）" hint="必要性模式的开口分数线" value={h.timing.necessityThreshold}
                  onChange={(v) => patchH({ timing: { ...h.timing, necessityThreshold: v } })} />
                <Num label="群聊频率（0-1）" value={h.timing.talkValue}
                  onChange={(v) => patchH({ timing: { ...h.timing, talkValue: v } })} />
                <Num label="私聊频率（0-1）" value={h.timing.privateTalkValue}
                  onChange={(v) => patchH({ timing: { ...h.timing, privateTalkValue: v } })} />
              </div>
              <div className="mset-models" style={{ marginTop: 14 }}>
                <div className="mset-mrow">
                  <span className="plg-v">被 @ 时必定回复</span>
                  <span className="mset-macts"><Switch on={h.timing.inevitableAtReply}
                    onChange={() => patchH({ timing: { ...h.timing, inevitableAtReply: !h.timing.inevitableAtReply } }, true)} /></span>
                </div>
                <div className="mset-mrow">
                  <span className="plg-v">提到名字时倾向回复</span>
                  <span className="mset-macts"><Switch on={h.timing.mentionedBotReply}
                    onChange={() => patchH({ timing: { ...h.timing, mentionedBotReply: !h.timing.mentionedBotReply } }, true)} /></span>
                </div>
                <div className="mset-mrow">
                  <span className="plg-v">专注模式<Hint text="不参与群聊活跃度打分，只对强相关的内容说话。" /></span>
                  <span className="mset-macts"><Switch on={h.timing.focusMode}
                    onChange={() => patchH({ timing: { ...h.timing, focusMode: !h.timing.focusMode } }, true)} /></span>
                </div>
                <div className="mset-mrow">
                  <span className="plg-v">按群聊与时段单独调整频率<Hint text="开启后可用「某个群 + 某个时段」的规则覆盖上面的基准频率，比如夜里调低。" /></span>
                  <span className="mset-macts"><Switch on={h.timing.enableRules}
                    onChange={() => patchH({ timing: { ...h.timing, enableRules: !h.timing.enableRules } }, true)} /></span>
                </div>
              </div>
              {h.timing.enableRules && (
                <div style={{ marginTop: 12 }}>
                  <div className="mset-group-t" style={{ marginBottom: 6 }}>
                    <span className="mset-flabel" style={{ margin: 0 }}>频率规则<Hint text="时段留空＝兜底值；带时段的规则优先，同会话同时段多条命中取最后一条。" /></span>
                    <button className="chain-add" title="添加规则"
                      onClick={() => patchH({ timing: { ...h.timing, rules: [...h.timing.rules, { platform: '', itemId: '', ruleType: 'group', time: '', value: 1 }] } }, true)}>
                      <Icon name="plus" size={14} />
                    </button>
                  </div>
                  <div className="mset-models">
                    {!h.timing.rules.length && <div className="mset-group-e">还没有规则，点右上 + 添加</div>}
                    {h.timing.rules.map((rule, i) => (
                      <div key={i} className="mset-mrow" style={{ gap: 8 }}>
                        <BrandInput style={{ width: 150 }} type="text" value={rule.time} spellCheck={false}
                          onChange={(e) => setRule(i, { time: e.target.value })} />
                        <PillSelect align="left" value={rule.ruleType} label="聊天类型"
                          options={[{ v: 'group', t: '群聊' }, { v: 'private', t: '私聊' }, { v: 'any', t: '不限' }]}
                          onChange={(v) => setRule(i, { ruleType: v as 'group' | 'private' | 'any' })} />
                        <PillSelect align="left" value={rule.itemId} label="作用会话"
                          options={[
                            { v: '', t: '全部会话' },
                            ...chats.map((c) => ({ v: c.chatId, t: c.title ? `${c.title}（${c.chatId}）` : c.chatId })),
                          ]}
                          onChange={(v) => {
                            const chat = chats.find((c) => c.chatId === v);
                            // 选中具体会话时把类型一并对齐，避免「选了群、类型却停在私聊」这条永不命中的规则
                            setRule(i, v && chat ? { itemId: v, ruleType: chat.chatType === 'private' ? 'private' : 'group' } : { itemId: v });
                          }} />
                        <span style={{ fontSize: 12, color: 'var(--faint)', flex: 'none' }}>频率%</span>
                        <BrandInput style={{ width: 70 }} type="number" value={Math.round(rule.value * 100)} spellCheck={false}
                          onChange={(e) => setRule(i, { value: Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100 })} />
                        <button className="chain-add" title="删除这条规则"
                          onClick={() => patchH({ timing: { ...h.timing, rules: h.timing.rules.filter((_, j) => j !== i) } }, true)}>
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mset-sec-h"><span>发送方式</span></div>
              <div className="set-grid" style={{ marginTop: 14 }}>
                <Num label="打字基础延迟（秒）" value={h.outgoing.typingBaseDelaySeconds}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, typingBaseDelaySeconds: v } })} />
                <Num label="打字速度（字/秒）" value={h.outgoing.typingCharactersPerSecond}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, typingCharactersPerSecond: v } })} />
                <Num label="单条最大打字时长" value={h.outgoing.typingMaxDelaySeconds}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, typingMaxDelaySeconds: v } })} />
                <Num label="打字抖动比例（%）" value={Math.round(h.outgoing.typingJitterRatio * 100)}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, typingJitterRatio: Math.min(50, Math.max(0, v)) / 100 } })} />
                <Num label="单条最大字符数" value={h.outgoing.maxMessageCharacters}
                  onChange={(v) => patchH({ outgoing: { ...h.outgoing, maxMessageCharacters: v } })} />
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
                <Num label="主动发言所需静默时长（秒）" value={h.proactive.idleSeconds}
                  onChange={(v) => patchH({ proactive: { ...h.proactive, idleSeconds: v } })} />
                <Num label="退避起点（轮）" hint="退避：连续多轮评估未发言后，下次评估前的等待逐轮翻倍" value={h.backoff.startCount}
                  onChange={(v) => patchH({ backoff: { ...h.backoff, startCount: v } })} />
                <Num label="退避基准（秒）" value={h.backoff.baseSeconds}
                  onChange={(v) => patchH({ backoff: { ...h.backoff, baseSeconds: v } })} />
                <Num label="退避上限（秒）" value={h.backoff.capSeconds}
                  onChange={(v) => patchH({ backoff: { ...h.backoff, capSeconds: v } })} />
                <Num label="绕过退避的积压条数" value={h.backoff.bypassPendingCount}
                  onChange={(v) => patchH({ backoff: { ...h.backoff, bypassPendingCount: v } })} />
              </div>

              <div className="mset-sec-h"><span>剧本体</span></div>
              <div className="mset-models">
                <div className="mset-mrow">
                  <span className="plg-v">节奏反定型<Hint text="回复结构固化时纠偏" /></span>
                  <span className="mset-macts"><Switch on={h.rhythm.enable}
                    onChange={() => patchH({ rhythm: { ...h.rhythm, enable: !h.rhythm.enable } }, true)} /></span>
                </div>
                <div className="mset-mrow">
                  <span className="plg-v">情绪偏移<Hint text="长期氛围累积" /></span>
                  <span className="mset-macts"><Switch on={h.alter.enabled}
                    onChange={() => patchH({ alter: { ...h.alter, enabled: !h.alter.enabled } }, true)} /></span>
                </div>
                <div className="mset-mrow">
                  <span className="plg-v">行动容量<Hint text="日程与安静时段限制主动发言" /></span>
                  <span className="mset-macts"><Switch on={h.agency.enable}
                    onChange={() => patchH({ agency: { ...h.agency, enable: !h.agency.enable } }, true)} /></span>
                </div>
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
                <Num label="氛围阈值（1-100）" value={h.alter.baseThreshold}
                  onChange={(v) => patchH({ alter: { ...h.alter, baseThreshold: v } })} />
                <Num label="氛围密度系数（%）" value={Math.round(h.alter.densityFactor * 100)}
                  onChange={(v) => patchH({ alter: { ...h.alter, densityFactor: Math.min(100, Math.max(0, v)) / 100 } })} />
                <Num label="氛围强度上限（1-5）" value={h.alter.maxIntensity}
                  onChange={(v) => patchH({ alter: { ...h.alter, maxIntensity: v } })} />
                <Num label="同向加成（%）" value={Math.round(h.alter.sameDirectionBoost * 100)}
                  onChange={(v) => patchH({ alter: { ...h.alter, sameDirectionBoost: Math.min(100, Math.max(0, v)) / 100 } })} />
                <Num label="反向衰减（%）" value={Math.round(h.alter.oppositeDecay * 100)}
                  onChange={(v) => patchH({ alter: { ...h.alter, oppositeDecay: Math.min(100, Math.max(0, v)) / 100 } })} />
                <Num label="权重过期线（%）" value={Math.round(h.alter.minWeight * 100)}
                  onChange={(v) => patchH({ alter: { ...h.alter, minWeight: Math.min(100, Math.max(0, v)) / 100 } })} />
                <Num label="主动最小间隔（分钟）" value={h.agency.minimumProactiveIntervalMinutes}
                  onChange={(v) => patchH({ agency: { ...h.agency, minimumProactiveIntervalMinutes: v } })} />
                <Num label="行动窗口有效期（分钟）" value={h.agency.maxWindowMinutes}
                  onChange={(v) => patchH({ agency: { ...h.agency, maxWindowMinutes: v } })} />
              </div>
              <div className="mset-field" style={{ marginTop: 14 }}>
                <label className="mset-flabel">安静时段（格式 HH:MM-HH:MM）</label>
                <BrandInput value={h.agency.quietHours} spellCheck={false}
                  onChange={(e) => patchH({ agency: { ...h.agency, quietHours: e.target.value } })} />
              </div>
            </>
          ))}

          {sec === 'persona' && (
            <div className="set-grid">
              <Num label="每次注入记忆条数 Top-K" value={c.persona.memoryFactsTopK}
                onChange={(v) => { const np = { ...c.persona, memoryFactsTopK: v }; patch({ persona: np }); autoSave('persona', 600, { persona: np }); }} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Num({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
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
      <BrandInput type="number" value={value} spellCheck={false} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
