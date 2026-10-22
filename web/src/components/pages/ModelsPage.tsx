'use client';
import { FadeName } from '@/components/FadeName';
/** 模型设置页：左栏 = 供应商列表 + 两条模型优先级链（聊天/工作，可拖动改优先级），右栏 = 供应商详情
 *  刷新与添加供应商两颗圆钮在顶栏（App.tsx），经 cmd 通道打过来。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { get, post, toast } from '@/lib/api';
import { ctxBadge } from '@/lib/entries';
import { Icon } from '@/components/Icon';
import { BrandInput } from '@/components/BrandInput';
import { Modal, Field } from '@/components/Modal';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';
import { useSave } from '@/lib/useSave';

interface ModelCfg {
  id: string; contextWindow?: number; maxOutput?: number; inputTypes?: string[];
  capabilities?: string[]; reasoningLevels?: string[]; enabled?: boolean;
}
interface ProviderCfg {
  label: string; model: string; enabled: boolean; baseUrl: string; protocol: string;
  custom?: boolean; models?: ModelCfg[];
}
interface Provider {
  id: string; label: string; implemented: boolean; streaming: boolean; enabled: boolean;
  model: string; configured: boolean; hasKey: boolean; apiKey?: string; config: ProviderCfg;
}
/** 链上一条：内核按顺序取，掉线自动接后一条 */
interface ChainRef { provider: string; model: string }
interface ChainEntry extends ChainRef { fails: number; state: 'current' | 'idle' | 'down' }
interface Resp {
  active: string; activeModel: string; providers: Provider[];
  chains: { chat: ChainEntry[]; work: ChainEntry[] };
  /** 两条链各自选定的思考强度（'' = 默认） */
  reasoning?: { chat?: string; work?: string };
  failoverThreshold: number;
}

/** 思考强度：左栏宽度只放得下四档；后端的 pi-ai 还认 minimal/xhigh/max，手改配置也能用 */
const REASON_LEVELS = [
  { v: '', t: '默认' }, { v: 'low', t: '低' }, { v: 'medium', t: '中' }, { v: 'high', t: '高' },
];

/** 连接方式（内核四种线格式都已实现）；mock 是本地脚本，不发网络请求 */
const PROTOCOLS = [
  { v: 'openai-compatible', t: 'Chat Completions', p: '/chat/completions' },
  { v: 'openai-responses', t: 'OpenAI Responses', p: '/responses' },
  { v: 'anthropic', t: 'Anthropic Messages', p: '/v1/messages' },
  { v: 'gemini', t: 'Gemini', p: '/v1beta/models' },
];
/** 输入类型：声明了的媒体才会被内核转成多模态入参（见 LlmService.shapeForModel） */
const INPUT_TYPES = [
  { v: 'text', t: '文本', locked: true },
  { v: 'image', t: '图片' },
  { v: 'video', t: '视频' },
  { v: 'audio', t: '音频' },
];
/** 模型能力：勾选原生联网搜索后，本轮不再给它 Tavily 的 web_search 工具 */
const CAPS = [
  { v: 'webSearch', t: '原生联网搜索' },
];

const isUsable = (p: Provider) => p.implemented && p.enabled && p.configured;
const protoOf = (p: Provider) => p.config.protocol || 'openai-compatible';
/** 没有 models 的历史配置：用当前模型名兜一行，列表不空 */
const modelsOf = (p: Provider): ModelCfg[] =>
  p.config.models?.length ? p.config.models : (p.model ? [{ id: p.model, enabled: true }] : []);

export default function ModelsPage({ onChanged, cmd }: {
  onChanged: () => void;
  cmd?: PageCmd;
}) {
  const [data, setData] = useState<Resp | null>(null);
  const [sel, setSel] = useState('');
  const [addingProvider, setAddingProvider] = useState(false);
  const [modelDlg, setModelDlg] = useState<{ provider: Provider; edit?: ModelCfg } | null>(null);
  const [picking, setPicking] = useState<'chat' | 'work' | null>(null);
  /** 供应商/链/模型的写入失败统一就地报红 */
  const { err, setErr, fail } = useSave();

  const reload = useCallback(() => {
    get('/api/providers').then((d: Resp) => {
      setData(d);
      setSel((s) => (s && d.providers.some((p) => p.id === s) ? s : d.active));
    }).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);
  /** 顶栏圆钮的一次性指令：只认发给本页的，挂载那次不算 */
  usePageCmd('models', cmd, (kind) => {
    if (kind === 'add') setAddingProvider(true);
    else reload();
  });

  const save = useCallback(async (id: string, patch: Record<string, unknown>) => {
    try {
      await post(`/api/providers/${id}`, patch);
      setErr('');
      reload();
      onChanged();
    } catch (e) { fail(e); }
  }, [reload, onChanged, setErr, fail]);

  /** 整条链一次写回（拖动排序 / 增删都走这里，落盘即时生效） */
  const commitChain = useCallback(async (kind: 'chat' | 'work', entries: ChainRef[]) => {
    try {
      await post('/api/providers/chain', { kind, entries });
      setErr('');
      reload();
      onChanged();
    } catch (e) { fail(e); }
  }, [reload, onChanged, setErr, fail]);

  /** 思考强度即时落盘（左右两条链各自独立）；失败时回滚到服务端值 */
  const commitReasoning = useCallback(async (kind: 'chat' | 'work', level: string) => {
    setData((d) => (d ? { ...d, reasoning: { ...(d.reasoning ?? {}), [kind]: level } } : d));
    try {
      const r: { reasoning?: Resp['reasoning'] } = await post('/api/providers/chain', { kind, reasoning: level });
      setErr('');
      if (r?.reasoning) setData((d) => (d ? { ...d, reasoning: r.reasoning } : d));
    } catch (e) {
      fail(e);
      reload();
    }
  }, [fail, reload, setErr]);

  if (!data) return <div className="muted" style={{ padding: 30 }}>加载中…</div>;
  /** 只列被链引用的 + 用户自己建的；未分配的内置项不占地方（要用得先添加成自定义供应商） */
  const chainPids = new Set([...data.chains.chat, ...data.chains.work].map((e) => e.provider));
  const listed = data.providers.filter((p) => p.config.custom || chainPids.has(p.id) || p.id === data.active);
  const cur = listed.find((p) => p.id === sel) ?? listed[0];
  const models = cur ? modelsOf(cur) : [];

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          <div className="mset-group">
            <div className="mset-group-t">供应商（{listed.length}）</div>
            {listed.map((p) => (
              <button key={p.id} className={'mset-item' + (p.id === cur?.id ? ' sel' : '')} onClick={() => setSel(p.id)} title={p.label}>
                <span className="mset-item-ic"><Icon name="models" size={15} /></span>
                <FadeName text={p.label} />
                <i className={isUsable(p) ? 'dot dot-on' : 'dot mset-dot-off'} />
              </button>
            ))}
            {!listed.length && <div className="mset-group-e">还没有供应商</div>}
          </div>

          <ChainGroup kind="chat" title="聊天模型" entries={data.chains.chat} providers={data.providers}
            reasoning={data.reasoning?.chat ?? ''} onReasoning={(v) => void commitReasoning('chat', v)}
            onPick={() => setPicking('chat')} onCommit={(e) => void commitChain('chat', e)} />
          <ChainGroup kind="work" title="工作模型" entries={data.chains.work} providers={data.providers}
            reasoning={data.reasoning?.work ?? ''} onReasoning={(v) => void commitReasoning('work', v)}
            onPick={() => setPicking('work')} onCommit={(e) => void commitChain('work', e)} />
        </aside>

        {cur ? (
          <ProviderDetail
            key={cur.id} p={cur} resp={data} models={models} err={err}
            onSave={save}
            onRemove={(id) => {
              post(`/api/providers/${id}/remove`, {})
                .then(() => { setErr(''); setSel(''); reload(); onChanged(); })
                .catch(fail);
            }}
            onAddModel={() => setModelDlg({ provider: cur })}
            onEditModel={(m) => setModelDlg({ provider: cur, edit: m })}
            onSaveModels={(list) => save(cur.id, { models: list })}
          />
        ) : (
          <section className="mset-detail">
            <div className="mset-empty">还没有供应商</div>
          </section>
        )}
      </div>

      {addingProvider && (
        <ProviderForm
          onClose={() => setAddingProvider(false)}
          onSubmit={async (v) => {
            const r = await post('/api/providers/create', v);
            setErr('');
            setAddingProvider(false);
            if (r.id) setSel(r.id);
            reload();
            onChanged();
          }}
        />
      )}
      {picking && (
        <ChainPicker
          kind={picking} providers={data.providers} existing={data.chains[picking]}
          onClose={() => setPicking(null)}
          onAdd={(ref) => {
            // 顺手切到该供应商详情：内置供应商可能还没配 key，加完就能填
            void commitChain(picking, [...data.chains[picking], ref]);
            setSel(ref.provider);
            setPicking(null);
          }}
        />
      )}
      {modelDlg && (
        <ModelForm
          provider={modelDlg.provider} edit={modelDlg.edit}
          onClose={() => setModelDlg(null)}
          onSave={async (m) => {
            const list = modelsOf(modelDlg.provider);
            const next = modelDlg.edit
              ? list.map((x) => (x.id === modelDlg.edit!.id ? m : x))
              : [...list, m];
            await save(modelDlg.provider.id, { models: next });
            setModelDlg(null);
          }}
        />
      )}
    </div>
  );
}

/** 一条模型优先级链：靠前的优先、掉线自动接后一条；行尾把手上下拖动改优先级（换位有动画） */
function ChainGroup({ kind, title, entries, providers, note, reasoning, onReasoning, onPick, onCommit }: {
  kind: 'chat' | 'work'; title: string; entries: ChainEntry[]; providers: Provider[];
  note?: string | null; reasoning: string; onReasoning: (v: string) => void;
  onPick: () => void; onCommit: (e: ChainRef[]) => void;
}) {
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const tops = useRef(new Map<string, number>());
  const label = (pid: string) => providers.find((p) => p.id === pid)?.label ?? pid;
  const strip = (list: ChainEntry[]): ChainRef[] => list.map((e) => ({ provider: e.provider, model: e.model }));

  /** FLIP：按行身份记住上一次的 offsetTop，位置变了就从旧位滑过来（offsetTop 不受滚动干扰） */
  useLayoutEffect(() => {
    for (const [key, el] of rows.current) {
      const top = el.offsetTop;
      const before = tops.current.get(key);
      if (before !== undefined && before !== top) {
        el.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'translateY(0)' }],
          { duration: 260, easing: 'cubic-bezier(.22,.8,.26,1)' });
      }
      tops.current.set(key, top);
    }
    for (const k of [...tops.current.keys()]) if (!rows.current.has(k)) tops.current.delete(k);
  });

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = strip(entries);
    const [it] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, it);
    onCommit(next);
  };
  const drop = (i: number) => {
    const next = strip(entries);
    next.splice(i, 1);
    onCommit(next);
  };

  return (
    <div className="mset-group" data-chain={kind}>
      <div className="mset-group-t" title={`${title}从上到下依次使用；前一条不可用时自动由下一条接替`}>
        <span>{title}</span>
        <button className="chain-add" title={`添加${title}`} aria-label={`添加${title}`} onClick={onPick}>
          <Icon name="plus" size={13} />
        </button>
      </div>
      <div className="chain-reason" title="交给推理模型的思考强度；默认 = 不额外指定">
        <span>思考</span>
        <span className="mset-chips">
          {REASON_LEVELS.map((r) => (
            <button key={r.v} className={'mset-chip' + (r.v === reasoning ? ' on' : '')}
              onClick={() => { if (r.v !== reasoning) onReasoning(r.v); }}>{r.t}</button>
          ))}
        </span>
      </div>
      {note && <div className="mset-group-e">{note}</div>}
      {entries.map((e, i) => {
        const key = `${e.provider}|${e.model}`;
        return (
          <div
            key={key}
            ref={(el) => { if (el) rows.current.set(key, el); else rows.current.delete(key); }}
            className={'mset-item chain-item' + (e.state === 'current' ? ' on' : '') + (drag.current === i ? ' dragging' : '') + (over === i && drag.current !== null && drag.current !== i ? ' over' : '')}
            draggable
            onDragStart={() => { drag.current = i; }}
            onDragEnd={() => { drag.current = null; setOver(null); }}
            onDragOver={(ev) => { ev.preventDefault(); if (over !== i) setOver(i); }}
            onDrop={(ev) => {
              ev.preventDefault();
              const from = drag.current;
              drag.current = null; setOver(null);
              if (from !== null) move(from, i);
            }}
            title={`${label(e.provider)} · ${e.model}${e.state === 'down' ? ' · 已掉线' : ''}`}
          >
            <FadeName text={e.model} />
            {e.state === 'current' && <span className="chain-cur">当前</span>}
            {e.state === 'down' && <i className="dot plg-dot-err" />}
            <button className="chain-del" aria-label="从链上移除" title="从链上移除" onClick={() => drop(i)}><Icon name="trash" /></button>
            <span className="mset-grip" aria-hidden><Icon name="grip" size={13} /></span>
          </div>
        );
      })}
    </div>
  );
}

/** 挑选器：只列你自己创建的供应商下的模型（预置供应商的模型不进这个列表） */
function ChainPicker({ kind, providers, existing, onClose, onAdd }: {
  kind: 'chat' | 'work'; providers: Provider[]; existing: ChainEntry[];
  onClose: () => void; onAdd: (ref: ChainRef) => void;
}) {
  const [q, setQ] = useState('');
  const have = new Set(existing.map((e) => `${e.provider}|${e.model}`));
  const rows = providers.filter((p) => p.config.custom).flatMap((p) => (p.config.models ?? [])
    .filter((m) => m.enabled !== false)
    .map((m) => ({ pid: p.id, label: p.label, model: m.id, dup: have.has(`${p.id}|${m.id}`) })))
    .filter((r) => !q || (r.label + ' ' + r.model).toLowerCase().includes(q.toLowerCase()));

  return (
    <Modal title={`添加${kind === 'chat' ? '聊天' : '工作'}模型`} onClose={onClose}>
      <BrandInput value={q} spellCheck={false} autoFocus
        style={{ width: '100%', marginBottom: 10 }} onChange={(e) => setQ(e.target.value)} />
      <div className="mset-models chain-pick">
        {rows.length ? rows.map((r) => (
          <button key={`${r.pid}|${r.model}`} className="mset-mrow" disabled={r.dup} onClick={() => onAdd({ provider: r.pid, model: r.model })}>
            <span className="plg-v mono">{r.model}</span>
            <span className="mset-badge">{r.label}</span>
            {r.dup && <span className="mset-macts mset-badge">已在链上</span>}
          </button>
        )) : <div className="mset-group-e">还没有自建供应商的模型，先在「供应商」里添加一个</div>}
      </div>
    </Modal>
  );
}

function ProviderDetail({ p, resp, models, err, onSave, onRemove, onSaveModels, onAddModel, onEditModel }: {
  p: Provider; resp: Resp; models: ModelCfg[]; err: string;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
  onSaveModels: (list: ModelCfg[]) => void;
  onAddModel: () => void; onEditModel: (m: ModelCfg) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(p.config.baseUrl ?? '');
  const [key, setKey] = useState(p.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [menu, setMenu] = useState(false);
  const [testing, setTesting] = useState('');
  const protocol = protoOf(p);
  /** 该供应商的某条模型挂在哪些链上、排第几（左栏两条链的行首序号与此对应） */
  const inChain = (model: string) => [
    ...resp.chains.chat.map((e, i) => (['聊天', i, e] as const)),
    ...resp.chains.work.map((e, i) => (['工作', i, e] as const)),
  ].filter(([, , e]) => e.provider === p.id && e.model === model).map(([t, i]) => `${t} #${i + 1}`);

  const dropModel = (m: ModelCfg) => {
    if (!confirm(`从 ${p.label} 删除模型 ${m.id}？`)) return;
    onSaveModels(models.filter((x) => x.id !== m.id));
  };
  const testModel = async (m: ModelCfg) => {
    setTesting(m.id);
    try {
      const r = await post(`/api/providers/${p.id}/test`, { model: m.id }) as { ok: boolean; error?: string };
      toast(r.ok ? `${m.id} 连接正常` : `${m.id} 连接失败：${r.error ?? '接口不可用'}`, r.ok ? 'ok' : 'err');
    } catch { /* 失败不弹提示 */ } finally { setTesting(''); }
  };

  return (
    <section className="mset-detail">
      <div className="mset-dhead">
        <span className="mset-dic"><Icon name="models" size={17} /></span>
        <h2 className="mset-dtitle">{p.label}</h2>
        {!p.implemented && <span className="tag warn">未接入</span>}
        <div className="mset-dright">
          <div className={'switch' + (p.enabled ? ' on' : '')} role="switch" aria-checked={p.enabled}
            title={p.enabled ? '点击停用' : '点击启用'}
            onClick={() => onSave(p.id, { enabled: !p.enabled })} />
          {p.config.custom && (
            <div className="mset-menu-wrap">
              <button className={'mset-ibtn' + (menu ? ' on' : '')} onClick={() => setMenu((v) => !v)} title="更多" aria-label="更多操作">
                <Icon name="dots" size={16} />
              </button>
              {menu && (
                <>
                  <div className="mset-scrim" onClick={() => setMenu(false)} />
                  <div className="mset-menu">
                    <button className="danger" onClick={() => { setMenu(false); if (confirm(`删除供应商 ${p.label}？其 API Key 一并清除，两条模型链上的相关条目同时移除。`)) onRemove(p.id); }}>删除供应商</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {err && <div className="mset-err">{err}</div>}

      <Field label="连接方式">
        <ProtoPicker value={protocol} onPick={(v) => onSave(p.id, { protocol: v })} />
      </Field>

      {protocol !== 'mock' && (
        <Field label="Base URL">
          <BrandInput value={baseUrl} spellCheck={false}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => { if (baseUrl !== (p.config.baseUrl ?? '')) onSave(p.id, { baseUrl }); }} />
        </Field>
      )}
      <Field label="API Key">
        <div className="mset-keywrap">
          <BrandInput type={showKey ? 'text' : 'password'} value={key} spellCheck={false}
            autoComplete="new-password"
            onChange={(e) => setKey(e.target.value)}
            onBlur={() => { if (key !== (p.apiKey ?? '')) { onSave(p.id, { apiKey: key.trim() }); setKey(key.trim()); } }} />
          <button className="mset-ibtn in" title={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey((v) => !v)}>
            <Icon name={showKey ? 'eyeOff' : 'eye'} size={15} />
          </button>
        </div>
      </Field>

      <div className="mset-sec-h">
        <span>模型列表</span>
        <button className="mset-add" onClick={onAddModel}><Icon name="plus" size={13} /> 添加模型</button>
      </div>
      <div className="mset-models">
        {models.length === 0 && <div className="mset-group-e">还没有模型，点右上「添加模型」</div>}
        {models.map((m) => (
          <div key={m.id} className={'mset-mrow' + (m.enabled === false ? ' off' : '')}>
            <button className="mset-mname mono" title={p.model === m.id ? '正在使用' : '设为该供应商当前使用的模型'}
              onClick={() => { if (p.model !== m.id && m.enabled !== false) onSave(p.id, { model: m.id }); }}>
              {m.id}
            </button>
            {ctxBadge(m.contextWindow) && <span className="mset-badge">{ctxBadge(m.contextWindow)}</span>}
            {m.inputTypes?.includes('image') && <span className="mset-badge">视觉</span>}
            {m.inputTypes?.includes('video') && <span className="mset-badge">视频</span>}
            {m.inputTypes?.includes('audio') && <span className="mset-badge">音频</span>}
            {m.capabilities?.includes('webSearch') && <span className="mset-badge">联网</span>}
            {inChain(m.id).map((x) => <span key={x} className="mset-badge mset-badge-rank">{x}</span>)}
            <span className="mset-macts">
              {protocol !== 'mock' && (
                <button className={'mset-ibtn' + (testing === m.id ? ' busy' : '')} disabled={!!testing}
                  title={testing === m.id ? '测试中…' : '测试该模型连接'}
                  onClick={() => testModel(m)}>
                  <Icon name="plug" size={15} />
                </button>
              )}
              <button className="mset-ibtn" title="编辑模型" onClick={() => onEditModel(m)}><Icon name="write" size={15} /></button>
              <button className="mset-ibtn" title="删除模型" onClick={() => dropModel(m)}><Icon name="trash" size={15} /></button>
              <div className={'switch' + (m.enabled === false ? '' : ' on')} role="switch" aria-checked={m.enabled !== false}
                title={m.enabled === false ? '已停用' : '启用中'}
                onClick={() => onSaveModels(models.map((x) => (x.id === m.id ? { ...x, enabled: x.enabled === false } : x)))} />
            </span>
          </div>
        ))}
      </div>

      <div className="mset-meta">
        {!!resp.chains.chat.filter((e) => e.provider === p.id).length && <span className="tag accent">聊天模型 ×{resp.chains.chat.filter((e) => e.provider === p.id).length}</span>}
        {!!resp.chains.work.filter((e) => e.provider === p.id).length && <span className="tag accent">工作模型 ×{resp.chains.work.filter((e) => e.provider === p.id).length}</span>}
      </div>
    </section>
  );
}

type Box = { x: number; y: number; w: number; h: number };

/** 连接方式选择器：四张卡排 2×2、共用一条轨道，选中块像水一样从旧项流向新项。
 *  做法：块按新位置排版，再把它逐帧"搬"回旧位置弹过来。每帧先算出想占的盒子、
 *  裁进轨道范围、最后才换算成 transform，所以水线拉多长都不会溢出轨道。
 *  旧位置另留一滴尾滴，被拖着吸回主体——两层都过 #goo 滤镜，重叠即融合、拉开即掐断。 */
function ProtoPicker({ value, onPick }: { value: string; onPick: (v: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const blob = useRef<HTMLSpanElement>(null);
  const drop = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);

  /** 卡片相对轨道的位置（offset* 不受 transform/滚动影响，比 rect 稳） */
  const rectOf = (v: string) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-proto="${v}"]`);
    return el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null;
  };
  const put = (el: HTMLElement, r: Box) => {
    el.style.transform = 'none';
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
  };

  useEffect(() => {
    const b = blob.current;
    const track = box.current;
    const to = rectOf(value);
    const from = prev.current === value ? null : rectOf(prev.current);
    prev.current = value;
    if (!b || !track || !to) return;
    put(b, to);
    if (!from || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // 裁剪范围＝轨道 padding 盒（overflow:hidden 就切在这里）
    const inner: Box = { x: 0, y: 0, w: track.clientWidth, h: track.clientHeight };
    const cf = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
    const ct = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
    const vx = ct.x - cf.x, vy = ct.y - cf.y;
    const horiz = Math.abs(vx) >= Math.abs(vy);
    const dist = horiz ? vx : vy;

    /** 沿运动方向拉长成一条水线：中心走到行程 t 处，长度带上剩余行程，厚度压扁 */
    const stream = (t: number, len: number, thick: number): Box => {
      const cx = cf.x + vx * t, cy = cf.y + vy * t;
      const w = horiz ? to.w + Math.abs(vx) * len : to.w * thick;
      const h = horiz ? to.h * thick : to.h + Math.abs(vy) * len;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    };
    /** 落点回弹：朝来路退一小口（最多 11px），纵向摊扁一点 */
    const back = Math.sign(dist) * Math.min(11, Math.abs(dist) * .04);
    const land: Box = horiz
      ? { x: to.x - back, y: to.y + (to.h - to.h * .965) / 2, w: to.w + Math.abs(back) + 4, h: to.h * .965 }
      : { x: to.x + (to.w - to.w * .965) / 2, y: to.y - back, w: to.w * .965, h: to.h + Math.abs(back) + 4 };

    const clip = <T extends Box>(r: T): T => {
      const w = Math.min(r.w, inner.w), h = Math.min(r.h, inner.h);
      return {
        ...r, w, h,
        x: Math.max(inner.x, Math.min(r.x, inner.x + inner.w - w)),
        y: Math.max(inner.y, Math.min(r.y, inner.y + inner.h - h)),
      };
    };
    /** 盒子 → transform：scale 以自身中心放大，故中心位移即 translate 量 */
    const xf = (r: Box) =>
      `translate(${r.x + r.w / 2 - (to.x + to.w / 2)}px, ${r.y + r.h / 2 - (to.y + to.h / 2)}px)`
      + ` scale(${r.w / to.w}, ${r.h / to.h})`;

    const frames: Array<Box & { offset: number }> = [
      { ...from, offset: 0 },
      { ...stream(.5, .4, .72), offset: .46 },
      { ...stream(.93, .06, .99), offset: .7 },
      { ...land, offset: .86 },
      { ...to, offset: 1 },
    ].map(clip);
    b.animate(frames.map((r) => ({ transform: xf(r), offset: r.offset })), {
      duration: 560, easing: 'cubic-bezier(.34,.9,.32,1)',
    });

    // 尾滴：先赖在旧位置，等主体拉开距离后被"掐"成独立水滴，再缩小着追上去——缩到临界尺寸以下时
    // #goo 的 alpha 阈值会把它自然抹掉，看起来就像被吸回水流里
    const d = drop.current;
    if (d && dist !== 0) {
      const sz = Math.round(Math.min(from.w, from.h) * .34);
      d.style.left = `${cf.x}px`;
      d.style.top = `${cf.y}px`;
      d.style.width = d.style.height = `${sz}px`;
      const at = (f: number) => `translate(calc(-50% + ${vx * f}px), calc(-50% + ${vy * f}px))`;
      d.animate([
        { transform: `${at(0)} scale(1)`, opacity: .95 },
        { transform: `${at(.04)} scale(.8)`, opacity: .95, offset: .35 },
        { transform: `${at(.3)} scale(.55)`, opacity: .95, offset: .7 },
        { transform: `${at(.62)} scale(.25)`, opacity: .95 },
      ], { duration: 300, easing: 'cubic-bezier(.45,.05,.7,.9)' });
    }
  }, [value]);

  useEffect(() => {
    const on = () => { const b = blob.current, r = rectOf(value); if (b && r) put(b, r); };
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [value]);

  return (
    <div className="mset-proto" ref={box} role="radiogroup" aria-label="连接方式">
      <span className="mset-goo" aria-hidden>
        <span className="mset-blob" ref={blob} />
        <span className="mset-drop" ref={drop} />
      </span>
      {PROTOCOLS.map((o) => (
        <button key={o.v} data-proto={o.v} role="radio" aria-checked={value === o.v}
          className={'mset-proc' + (value === o.v ? ' sel' : '')}
          onClick={() => { if (value !== o.v) onPick(o.v); }}>
          <span className="mset-proc-n">{o.t}</span>
          <span className="mset-proc-p mono">{o.p}</span>
        </button>
      ))}
    </div>
  );
}

interface NewProvider { label: string; baseUrl: string; protocol: string; apiKey: string; models: ModelCfg[] }

/** 上面填的字段会落到请求体里的那几项：与内核 applyModelCfg 一一对应，只读展示 */
function bodyPreview(m: ModelCfg, protocol?: string): string {
  const o: Record<string, unknown> = { model: m.id.trim() || '…' };
  if (m.maxOutput) o[protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'] = m.maxOutput;
  const tools: Record<string, unknown>[] = [];
  if (m.capabilities?.includes('webSearch')) {
    if (protocol === 'openai-responses') tools.push({ type: 'web_search' });
    else if (protocol === 'anthropic') tools.push({ type: 'web_search_20250305', name: 'web_search' });
    // Chat Completions 没有标准内置开关：勾了只是本轮不再给它 Tavily 的 web_search 工具，请求体里没有新键
  }
  if (tools.length) o.tools = tools;
  return JSON.stringify(o, null, 2);
}

const blankModel = (): ModelCfg => ({
  id: '', contextWindow: undefined, maxOutput: undefined, inputTypes: ['text'],
  capabilities: [], reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'], enabled: true,
});

/** 智能配置开关行：开启后向供应商探一次 /models，用它校验模型 ID 并把返回的 id 作为候选 */
function SmartRow({ smart, onToggle, probe, onRetry }: {
  smart: boolean; onToggle: (v: boolean) => void; probe: string; onRetry?: () => void;
}) {
  return (
    <div className="mset-smart">
      <span>智能配置</span>
      <span className="mset-help" title="开启后向供应商查询模型列表：用它校验模型 ID，并把返回的 id 作为候选">?</span>
      <div className={'switch' + (smart ? ' on' : '')} role="switch" aria-checked={smart} onClick={() => onToggle(!smart)} />
      {probe && <em className="mset-probe">{probe}</em>}
      {onRetry && probe && <button className="mset-link" onClick={onRetry}>重试</button>}
    </div>
  );
}

/** 单条模型的明细字段：ID（带远端候选）/ 上下文窗口 / 最大输出 / 高级配置。
 *  「添加供应商」的多模型卡与「添加/编辑模型」弹窗共用这一份，保证两处字段一致。 */
function ModelFields({ m, on, remote, protocol, advDefault = false, autoFocus }: {
  m: ModelCfg; on: (patch: Partial<ModelCfg>) => void; remote?: string[] | null; protocol?: string;
  advDefault?: boolean; autoFocus?: boolean;
}) {
  const [adv, setAdv] = useState(advDefault);
  const num = (s: string) => (s.trim() ? Number(s.trim()) : undefined);
  const toggleIn = (v: string, locked?: boolean) => {
    if (locked) return;
    const cur = m.inputTypes?.length ? m.inputTypes : ['text'];
    on({ inputTypes: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const toggleCap = (v: string) => {
    const cur = m.capabilities ?? [];
    on({ capabilities: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  return (
    <>
      <Field label="模型 ID">
        <BrandInput value={m.id} spellCheck={false} autoFocus={autoFocus}
          onChange={(e) => on({ id: e.target.value })} />
        {(remote?.length ?? 0) > 0 && (
          <div className="mset-cands">
            {remote!.filter((x) => !m.id || x.includes(m.id.trim())).slice(0, 8).map((x) => (
              <button key={x} className="mset-cand mono" onClick={() => on({ id: x })}>{x}</button>
            ))}
          </div>
        )}
      </Field>
      <Field label="上下文窗口">
        <BrandInput type="number" value={m.contextWindow ?? ''}
          onChange={(e) => on({ contextWindow: num(e.target.value) })} />
      </Field>
      <Field label="最大输出 Token">
        <BrandInput type="number" value={m.maxOutput ?? ''}
          onChange={(e) => on({ maxOutput: num(e.target.value) })} />
      </Field>

      <button className="mset-adv" onClick={() => setAdv((v) => !v)}>
        <span className={'mset-chev' + (adv ? ' open' : '')}><Icon name="chevron" size={12} /></span> 高级配置
      </button>
      {adv && (
        <div className="mset-adv-b">
          <Field label="输入类型">
            <div className="mset-chips">
              {INPUT_TYPES.map((t) => (
                <button key={t.v} className={'mset-chip' + ((m.inputTypes ?? []).includes(t.v) ? ' on' : '')}
                  onClick={() => toggleIn(t.v, t.locked)}>
                  {t.locked && <Icon name="lock" size={11} />}{t.t}
                </button>
              ))}
            </div>
          </Field>
          <Field label="模型能力">
            <div className="mset-chips">
              {CAPS.map((t) => (
                <button key={t.v} className={'mset-chip' + ((m.capabilities ?? []).includes(t.v) ? ' on' : '')}
                  onClick={() => toggleCap(t.v)}>{t.t}</button>
              ))}
            </div>
          </Field>
          <Field label="推理等级（从低到高）">
            <div className="mset-chips wrap">
              {(m.reasoningLevels ?? []).map((lv, i) => (
                <span key={i} className="mset-lvl">
                  <BrandInput value={lv} onChange={(e) => {
                    const next = [...(m.reasoningLevels ?? [])];
                    next[i] = e.target.value;
                    on({ reasoningLevels: next });
                  }} />
                  <button className="mset-ibtn in" aria-label="删除该等级"
                    onClick={() => on({ reasoningLevels: (m.reasoningLevels ?? []).filter((_, j) => j !== i) })}>
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))}
              <button className="mset-chip sq" aria-label="添加等级"
                onClick={() => on({ reasoningLevels: [...(m.reasoningLevels ?? []), ''] })}>
                <Icon name="plus" size={13} />
              </button>
            </div>
          </Field>
          <Field label="调用参数">
            <pre className="mset-json mono">{bodyPreview(m, protocol)}</pre>
          </Field>
        </div>
      )}
    </>
  );
}

/** 添加供应商里的一条模型行：uid 只当稳定 key（模型 id 可被编辑改） */
interface Row { uid: number; m: ModelCfg }

function ProviderForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (v: NewProvider) => Promise<void> | void }) {
  const [v, setV] = useState({ label: '', baseUrl: '', protocol: 'openai-compatible', apiKey: '' });
  const [rows, setRows] = useState<Row[]>([]);        // 一开始没有模型行，填完卡片才落一行
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [smart, setSmart] = useState(true);
  const [remote, setRemote] = useState<string[] | null>(null);
  const [probe, setProbe] = useState('');
  const [err, setErr] = useState('');
  const [nonce, setNonce] = useState(0);
  const uidRef = useRef(0);
  const set = (k: keyof typeof v, x: string) => setV((s) => ({ ...s, [k]: x }));
  const saveRow = (m: ModelCfg) => {
    if (editing === 'new') {
      const uid = ++uidRef.current;
      setRows((rs) => [...rs, { uid, m }]);
    } else {
      setRows((rs) => rs.map((r) => (r.uid === editing ? { ...r, m } : r)));
    }
    setEditing(null);
  };
  const delRow = (uid: number) => setRows((rs) => rs.filter((r) => r.uid !== uid));

  useEffect(() => {
    if (!smart) { setRemote(null); setProbe(''); return; }
    const base = v.baseUrl.trim();
    if (!/^https?:\/\//.test(base)) { setRemote(null); setProbe(''); return; }
    let alive = true;
    setProbe('正在读取该供应商的模型列表…');
    const t = setTimeout(() => {
      post('/api/providers/probe', { baseUrl: base, protocol: v.protocol, apiKey: v.apiKey })
        .then((r: { ok: boolean; models?: string[]; error?: string }) => {
          if (!alive) return;
          setRemote(r.ok ? r.models ?? [] : null);
          setProbe(r.ok ? `已连接：发现 ${r.models?.length ?? 0} 个模型` : `未连接：${r.error ?? '接口不可用'}`);
        })
        .catch((e) => { if (alive) { setRemote(null); setProbe(`未连接：${(e as Error).message}`); } });
    }, 800);
    return () => { alive = false; clearTimeout(t); };
  }, [smart, v.baseUrl, v.protocol, v.apiKey, nonce]);

  const submit = () => {
    if (!v.label.trim()) { setErr('请填写供应商名称'); return; }
    if (v.baseUrl.trim() && !/^https?:\/\//.test(v.baseUrl.trim())) { setErr('Base URL 需以 http(s):// 开头'); return; }
    setErr('');
    Promise.resolve(onSubmit({ label: v.label.trim(), baseUrl: v.baseUrl.trim(), protocol: v.protocol, apiKey: v.apiKey, models: rows.map((r) => r.m) }))
      .catch((e) => setErr(`未保存：${(e as Error)?.message ?? String(e)}`));
  };

  return (
    <Modal title="添加供应商" wide onClose={onClose}>
      <Field label="名称">
        <BrandInput value={v.label} autoFocus onChange={(e) => set('label', e.target.value)} />
      </Field>
      <Field label="Base URL">
        <BrandInput value={v.baseUrl} spellCheck={false}
          onChange={(e) => set('baseUrl', e.target.value)} />
      </Field>
      <Field label="连接方式">
        <ProtoPicker value={v.protocol} onPick={(x) => set('protocol', x)} />
      </Field>
      <Field label="API Key">
        <BrandInput type="password" value={v.apiKey} spellCheck={false} autoComplete="new-password" onChange={(e) => set('apiKey', e.target.value)} />
      </Field>

      <div className="mset-sec-h">
        <span>模型</span>
        <button className="mset-add" onClick={() => setEditing('new')}><Icon name="plus" size={13} /> 添加模型</button>
      </div>
      <SmartRow smart={smart} onToggle={setSmart} probe={probe} onRetry={() => setNonce((n) => n + 1)} />
      {rows.length > 0 && (
        <div className="mset-models">
          {rows.map((r) => (
            <div key={r.uid} className="mset-mrow">
              <button className="mset-mname mono" title="编辑该模型" onClick={() => setEditing(r.uid)}>{r.m.id}</button>
              {ctxBadge(r.m.contextWindow) && <span className="mset-badge">{ctxBadge(r.m.contextWindow)}</span>}
              {r.m.inputTypes?.includes('image') && <span className="mset-badge">视觉</span>}
              {r.m.inputTypes?.includes('video') && <span className="mset-badge">视频</span>}
              {r.m.inputTypes?.includes('audio') && <span className="mset-badge">音频</span>}
              {r.m.capabilities?.includes('webSearch') && <span className="mset-badge">联网</span>}
              <span className="mset-macts">
                <button className="mset-ibtn" title="编辑模型" onClick={() => setEditing(r.uid)}><Icon name="write" size={15} /></button>
                <button className="mset-ibtn" title="删除该模型" onClick={() => delRow(r.uid)}><Icon name="trash" size={15} /></button>
              </span>
            </div>
          ))}
        </div>
      )}

      {editing !== null && (
        <ModelCard
          title={editing === 'new' ? '添加模型' : '编辑模型'}
          value={editing === 'new' ? blankModel() : rows.find((r) => r.uid === editing)!.m}
          remote={smart ? remote : null} protocol={v.protocol}
          dupIds={rows.filter((r) => r.uid !== editing).map((r) => r.m.id)}
          advDefault={editing !== 'new'}
          onClose={() => setEditing(null)} onSave={saveRow}
        />
      )}

      <div className="mset-mfoot">
        <span />
        <div className="mset-mfoot-r">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit}>保存</button>
        </div>
      </div>
      {err && <div className="mset-err">{err}</div>}
    </Modal>
  );
}

/** 模型明细弹窗：模型页的「添加/编辑模型」与「添加供应商」里的模型行共用这一张卡片 */
function ModelCard({ title, value, remote, protocol, dupIds = [], smart, advDefault = false, onClose, onSave }: {
  title: string; value: ModelCfg; remote?: string[] | null; protocol?: string;
  dupIds?: string[]; smart?: ReactNode; advDefault?: boolean;
  onClose: () => void; onSave: (m: ModelCfg) => void;
}) {
  const [m, setM] = useState<ModelCfg>(value);
  const [gen, setGen] = useState(0);      // 重置表单时 bump，让 ModelFields 连同「高级配置」一起归位
  const [err, setErr] = useState('');
  const on = (p: Partial<ModelCfg>) => setM((s) => ({ ...s, ...p }));
  const submit = () => {
    const id = m.id.trim();
    if (!id) { setErr('请填写模型 ID'); return; }
    if (dupIds.includes(id)) { setErr('该模型已在列表里'); return; }
    if (remote && !remote.includes(id)) { setErr('该模型 ID 不在供应商返回的列表里（可关闭智能配置强制添加）'); return; }
    setErr('');
    onSave({
      ...m, id, reasoningLevels: (m.reasoningLevels ?? []).map((s) => s.trim()).filter(Boolean),
    });
  };
  return (
    <Modal title={title} wide onClose={onClose}>
      {smart}
      <ModelFields key={gen} m={m} on={on} remote={remote} protocol={protocol}
        advDefault={advDefault} autoFocus />
      <div className="mset-mfoot">
        <button className="mset-link" onClick={() => { setM(value); setGen((g) => g + 1); setErr(''); }}>重置表单</button>
        <div className="mset-mfoot-r">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit}>保存</button>
        </div>
      </div>
      {err && <div className="mset-err">{err}</div>}
    </Modal>
  );
}

/** 模型表单：智能配置开启时向该供应商探一次 /models，用真实返回的 id 做候选与校验 */
function ModelForm({ provider, edit, onClose, onSave }: {
  provider: Provider; edit?: ModelCfg; onClose: () => void; onSave: (m: ModelCfg) => void;
}) {
  const [smart, setSmart] = useState(true);
  const [remote, setRemote] = useState<string[] | null>(null);
  const [probe, setProbe] = useState('');

  useEffect(() => {
    if (!smart || !provider.config.baseUrl) return;
    let alive = true;
    setProbe('正在读取该供应商的模型列表…');
    post(`/api/providers/${provider.id}/test`, {})
      .then((r: { ok: boolean; models?: string[]; error?: string }) => {
        if (!alive) return;
        setRemote(r.ok ? r.models ?? [] : null);
        setProbe(r.ok ? `已连接：发现 ${r.models?.length ?? 0} 个模型` : `未连接：${r.error ?? '接口不可用'}`);
      })
      .catch((e) => { if (alive) { setRemote(null); setProbe(`未连接：${(e as Error).message}`); } });
    return () => { alive = false; };
  }, [smart, provider.id, provider.config.baseUrl]);

  return (
    <ModelCard
      title={edit ? '编辑模型' : '添加模型'}
      value={edit ? { ...blankModel(), ...edit } : blankModel()}
      remote={smart ? remote : null} protocol={protoOf(provider)}
      dupIds={edit ? [] : modelsOf(provider).map((x) => x.id)}
      advDefault={!!edit}
      smart={<SmartRow smart={smart} onToggle={setSmart} probe={probe} />}
      onClose={onClose} onSave={onSave}
    />
  );
}
