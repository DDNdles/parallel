'use client';
/** 设置：左分节导航（QQ 接入 / 模型 / 搜索 / 风控 / 好感度）+ 右表单；协议端选择与可用性检测都在「QQ 接入」里 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, fmtTime } from '@/lib/api';
import { BrandInput } from '@/components/BrandInput';
import { PillSelect, type PillOpt } from '@/components/PillSelect';
import { Icon } from '@/components/Icon';
import { Switch } from '@/components/Modal';

interface Config {
  risk: { replyRatePerMin: number; jitterMinMs: number; jitterMaxMs: number; groupWake: string; wakeWords: string[]; proactive: Record<string, boolean>; forgetScope: 'self_and_admin' | 'admin_only' };
  onebot: {
    host: string; port: number; reverseWsPath: string; hasToken: boolean;
    flavor: 'llbot' | 'napcat';
    llbot?: { webuiPort: number; mode?: 'pmhq' | 'direct'; qqProfileDir?: string };
    napcat?: { webuiPort: number };
  };
  ui?: { expectedQq?: string };
  llm: { failoverThreshold: number };
  persona: {
    affection: { min: number; max: number; dailyDeltaCap: number; minIntervalMs: number; stages: { min: number; label: string }[] };
    memoryFactsTopK: number;
  };
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

const ENDS: PillOpt[] = [
  { v: 'llbot', t: 'LuckyLilliaBot' },
  { v: 'napcat', t: 'NapCat' },
];
const MODES: PillOpt[] = [
  { v: 'pmhq', t: '有头模式（PMHQ 注入本机 QQNT）' },
  { v: 'direct', t: '无头模式（纯协议直连）' },
];
const SECTIONS: { v: string; t: string; icon: string }[] = [
  { v: 'onebot', t: 'QQ 接入', icon: 'plug' },
  { v: 'model', t: '模型', icon: 'bolt' },
  { v: 'search', t: '搜索', icon: 'globe' },
  { v: 'risk', t: '风控', icon: 'lock' },
  { v: 'affection', t: '好感度', icon: 'friend' },
];

export default function SettingsPage() {
  const [c, setC] = useState<Config | null>(null);
  const [sec, setSec] = useState('onebot');
  const [protocol, setProtocol] = useState<'llbot' | 'napcat'>('llbot');
  const [end, setEnd] = useState<EndStatus | null>(null);
  const [checks, setChecks] = useState<EndCheck[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const [mode, setMode] = useState<'pmhq' | 'direct'>('pmhq');
  const [qq, setQq] = useState('');
  const [tavily, setTavily] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [maxRes, setMaxRes] = useState(3);
  const [wake, setWake] = useState('');
  /** 已从插件页挪走的几项能力：好感度（chat）、联网搜索（web-search）——含各自的全局默认 */
  const [plug, setPlug] = useState<{ chat: PlugCfg; web: PlugCfg } | null>(null);

  const loadPlug = useCallback(() => {
    Promise.all([
      get('/api/plugins/chat/config'), get('/api/plugins/web-search/config'),
    ]).then(([a, b]: PlugCfg[]) => {
      setPlug({ chat: a, web: b });
      setMaxRes(Number(b.values.maxResults ?? 3));
    }).catch(() => {});
  }, []);
  const savePlug = (id: string, values: Record<string, unknown>) =>
    post(`/api/plugins/${id}/config`, { values }).then(loadPlug).catch(() => {});
  const saveGlobal = (id: string, enabled: boolean) =>
    post(`/api/plugins/${id}/global-default`, { enabled }).then(loadPlug).catch(() => {});

  const refreshInfo = useCallback(async () => {
    try {
      const st = await get('/api/login/status');
      if (!st.end) return;
      setProtocol(st.protocol);
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
    const flavor = cfg.onebot.flavor ?? 'llbot';
    setC(cfg);
    setProtocol(flavor);
    setMode(cfg.onebot.llbot?.mode ?? 'pmhq');
    setQq(cfg.ui?.expectedQq ?? '');
    setWake(cfg.risk.wakeWords.join(','));
    refreshInfo();
    loadPlug();
    void runCheck();
  }, [refreshInfo, loadPlug, runCheck]);
  useEffect(() => { void loadCfg().catch(() => {}); }, [loadCfg]);

  if (!c) return <div className="mset-empty">加载中…</div>;
  const r = c.risk;
  const patch = (p: Partial<Config>) => setC({ ...c, ...p });
  /** Tavily key：没动过就一直跟着服务端回显（明文回传，跟模型页同一口径） */
  const storedKey = String(plug?.web.values.apiKey ?? '');
  const webKey = tavily ?? storedKey;

  /** 换协议端会停掉当前那个（QQ 登录要重来一次），所以确认过才发请求、成功才改本地状态 */
  const pickProtocol = async (to: 'llbot' | 'napcat') => {
    if (to === protocol) return;
    const name = ENDS.find((e) => e.v === to)?.t ?? '';
    if (!confirm(`切换到 ${name}？当前协议端会被停掉，QQ 登录要重新来一次。`)) return;
    try {
      await post('/api/login/protocol', { flavor: to });
      void loadCfg();     // 换端后两端各自的配置项（模式 / QQ 路径）都要重新对齐
    } catch { /* 失败不弹提示 */ }
  };
  /** 换接入方式要重启才生效（模式决定 LLBot 的启动参数） */
  const pickMode = async (m: 'pmhq' | 'direct') => {
    setMode(m);
    try {
      await post('/api/config', { onebot: { llbot: { mode: m } } });
      await post('/api/login/end/restart');
      refreshInfo();
      void runCheck();
    } catch { /* 失败不弹提示 */ }
  };
 const saveRisk = async (body: Record<string, unknown>) => {
    try { await post('/api/config', { risk: body }); }
    catch { /* 失败不弹提示 */ }
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

          {sec === 'onebot' && (
            <>
              <div className="mset-sec-h">
                <span>协议端</span>
                <span className="plg-sec-r">
                  <PillSelect value={protocol} options={ENDS} label="协议端"
                    onChange={(v) => void pickProtocol(v as 'llbot' | 'napcat')} />
                </span>
              </div>

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

              {protocol === 'llbot' && (
                <div className="mset-field">
                  <label className="mset-flabel">接入方式</label>
                  <PillSelect align="left" value={mode} options={MODES} label="接入方式" onChange={(v) => void pickMode(v as 'pmhq' | 'direct')} />
                </div>
              )}

              <div className="mset-field">
                <label className="mset-flabel">账号</label>
                <BrandInput className="mono" value={qq} placeholder="QQ 号" spellCheck={false}
                  onChange={(e) => setQq(e.target.value)}
                  onBlur={async () => {
                    try { await post('/api/config', { expectedQq: qq.trim() }); refreshInfo(); void runCheck(); }
                    catch { /* 失败不弹提示 */ }
                  }} />
              </div>

              <div className="set-row">
                <button className="btn" onClick={async () => {
                  try { await post('/api/login/end/restart'); refreshInfo(); void runCheck(); }
                  catch { /* 失败不弹提示 */ }
                }}>重启协议端</button>
                <button className="btn" onClick={() => window.open(end?.webuiUrl ?? '', '_blank')}>打开控制台</button>
              </div>
            </>
          )}

          {sec === 'model' && (
            <>
              <div className="set-grid">
                <Num label="模型降级阈值（连续失败次数）" value={c.llm.failoverThreshold}
                  onChange={(v) => patch({ llm: { ...c.llm, failoverThreshold: v } })} />
              </div>
              <div className="set-row" style={{ marginTop: 14 }}>
                <button className="btn primary" onClick={() => post('/api/config', { llm: { failoverThreshold: c.llm.failoverThreshold } })
                  .catch(() => {})}>保存</button>
              </div>
            </>
          )}

          {sec === 'search' && (!plug ? <div className="mset-empty">读取中…</div> : (
            <div key="search">
              <div className="mset-sec-h"><span>联网搜索</span></div>
              <div className="mset-field">
                <label className="mset-flabel">Tavily API Key</label>
                <div className="mset-keywrap">
                  <BrandInput type={showKey ? 'text' : 'password'} value={webKey} spellCheck={false} placeholder="未配置"
                    onChange={(e) => setTavily(e.target.value)}
                    onBlur={() => {
                      const key = webKey.trim();
                      setTavily(null);
                      if (key !== storedKey) void savePlug('web-search', { apiKey: key }); // 清空 = 删掉这把 key
                    }} />
                  <button className="mset-ibtn in" title={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey((v) => !v)}>
                    <Icon name={showKey ? 'eyeOff' : 'eye'} size={15} />
                  </button>
                </div>
              </div>
              <div className="set-grid">
                <div className="mset-field">
                  <label className="mset-flabel">返回结果数</label>
                  <BrandInput type="number" value={maxRes} spellCheck={false} onChange={(e) => setMaxRes(Number(e.target.value))} />
                </div>
              </div>
              <div className="mset-sec-h"><span>全局默认</span></div>
              <div className="mset-models">
                <div className="mset-mrow">
                  <span className="plg-v">网络搜索工具（web_search / web_fetch）</span>
                  <span className="mset-macts">
                    <Switch on={!!plug.web.globalDefault} title="新群 / 未覆盖群的默认状态"
                      onChange={() => void saveGlobal('web-search', !plug.web.globalDefault)} />
                  </span>
                </div>
              </div>
              <div className="set-row" style={{ marginTop: 14 }}>
                <button className="btn primary" onClick={() => void savePlug('web-search', { maxResults: maxRes })}>保存</button>
              </div>
            </div>
          ))}

          {sec === 'risk' && (
            <>
              <div className="set-grid">
                <Num label="每会话回复上限（条/分钟）" value={r.replyRatePerMin} onChange={(v) => patch({ risk: { ...r, replyRatePerMin: v } })} />
                <Num label="随机抖动下限（毫秒）" value={r.jitterMinMs} onChange={(v) => patch({ risk: { ...r, jitterMinMs: v } })} />
                <Num label="随机抖动上限（毫秒）" value={r.jitterMaxMs} onChange={(v) => patch({ risk: { ...r, jitterMaxMs: v } })} />
              </div>
              <div className="mset-sec-h"><span>群聊唤醒</span></div>
              <div className="mset-field">
                <select id="wake-mode" defaultValue={r.groupWake}>
                  <option value="at_or_reply">仅 @机器人 / 回复机器人</option>
                  <option value="at_reply_or_wakeword">@ / 回复 / 唤醒词</option>
                </select>
              </div>
              <div className="mset-field">
                <label className="mset-flabel">唤醒词（逗号分隔）</label>
                <BrandInput value={wake} spellCheck={false} onChange={(e) => setWake(e.target.value)} />
              </div>
              <div className="mset-sec-h"><span>忘记记忆（/忘记我、/forget）</span></div>
              <div className="mset-field">
                <select value={r.forgetScope} onChange={(e) => patch({ risk: { ...r, forgetScope: e.target.value as 'self_and_admin' | 'admin_only' } })}>
                  <option value="self_and_admin">本人可清除自己的记忆；管理员/主人可清除指定的人</option>
                  <option value="admin_only">一律需管理员/群主/主人执行（本人也不能清）</option>
                </select>
              </div>
              <div className="mset-sec-h"><span>主动推送</span></div>
              <div className="mset-models">
                {Object.keys(r.proactive ?? {}).length
                  ? Object.entries(r.proactive).map(([id, on]) => (
                    <div key={id} className="mset-mrow">
                      <span className="plg-v mono">{id}</span>
                      <span className={'tag' + (on ? ' err' : '')}>{on ? '已开启' : '关'}</span>
                    </div>
                  ))
                  : <div className="mset-group-e">全部关闭</div>}
              </div>
              <div className="set-row" style={{ marginTop: 14 }}>
                <button className="btn primary" onClick={() => saveRisk({
                  replyRatePerMin: r.replyRatePerMin, jitterMinMs: r.jitterMinMs, jitterMaxMs: r.jitterMaxMs,
                  groupWake: (document.getElementById('wake-mode') as HTMLSelectElement).value,
                  wakeWords: wake.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
                  forgetScope: r.forgetScope,
                })}>保存</button>
              </div>
            </>
          )}

          {sec === 'affection' && (
            <>
              {plug && (
                <div className="mset-models" style={{ marginBottom: 14 }}>
                  <div className="mset-mrow">
                    <span className="plg-v">启用好感度系统</span>
                    <span className="mset-macts">
                      <Switch on={plug.chat.values.affectionEnabled !== false} title="关闭后不再随聊天调整好感度，也不注入段位"
                        onChange={() => void savePlug('chat', { affectionEnabled: plug.chat.values.affectionEnabled === false })} />
                    </span>
                  </div>
                  <div className="mset-mrow">
                    <span className="plg-v">人格化回复（新群默认开启）</span>
                    <span className="mset-macts">
                      <Switch on={!!plug.chat.globalDefault} title="群内在 /插件 里单独开关"
                        onChange={() => void saveGlobal('chat', !plug.chat.globalDefault)} />
                    </span>
                  </div>
                </div>
              )}
              <div className="set-grid">
                <Num label="单用户单日变动上限（±）" value={c.persona.affection.dailyDeltaCap}
                  onChange={(v) => patch({ persona: { ...c.persona, affection: { ...c.persona.affection, dailyDeltaCap: v } } })} />
                <Num label="更新冷却（毫秒）" value={c.persona.affection.minIntervalMs}
                  onChange={(v) => patch({ persona: { ...c.persona, affection: { ...c.persona.affection, minIntervalMs: v } } })} />
                <Num label="每次注入记忆条数 Top-K" value={c.persona.memoryFactsTopK}
                  onChange={(v) => patch({ persona: { ...c.persona, memoryFactsTopK: v } })} />
              </div>
              <div className="mset-sec-h"><span>段位</span></div>
              <div className="mset-meta">
                {c.persona.affection.stages.map((s) => <span key={s.min} className="tag mono">{s.min}+ {s.label}</span>)}
              </div>
              <div className="set-row" style={{ marginTop: 14 }}>
                <button className="btn primary" onClick={() => post('/api/config', { persona: c.persona })
                  .catch(() => {})}>保存</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="mset-field">
      <label className="mset-flabel">{label}</label>
      <BrandInput type="number" value={value} spellCheck={false} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
