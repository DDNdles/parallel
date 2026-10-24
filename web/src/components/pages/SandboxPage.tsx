'use client';
import { FadeName } from '@/components/FadeName';
/** 沙箱：左列表（按会话）+ 右详情（占用 / 全部文件按日期装进文件夹 / 清空），顶栏「限额与清理」弹窗
 *  文件点开：图片与文本都在弹窗里看；其余类型交给系统默认程序，不确定会执行的只在资源管理器里选中 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, fmtBytes, fmtDT, fmtTime, getToken } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { fileIcon } from '@/lib/fileIcon';
import { BrandInput } from '@/components/BrandInput';
import { Modal, Field, Switch } from '@/components/Modal';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';

interface Stat { chat: string; files: number; bytes: number; lastActivity: number; root: string }
interface Entry { name: string; relPath: string; size: number; mtime: number }
interface View { name: string; kind: 'text' | 'image'; text: string; truncated: boolean }

const NUM_FIELDS: { k: string; t: string; size?: 'bytes' | 'ms' | 'h' }[] = [
  { k: 'ttlHours', t: '文件 TTL（小时）', size: 'h' },
  // 收件文件的保留期在设置页「沙箱」按天调，这里不再放第二个旋钮（同一个键两处改会互相打脸）
  { k: 'maxFileBytes', t: '单文件上限（字节）', size: 'bytes' },
  { k: 'maxSessionBytes', t: '单会话上限（字节）', size: 'bytes' },
  { k: 'execTimeoutPythonMs', t: 'Python 超时（毫秒）', size: 'ms' },
  { k: 'execTimeoutJsMs', t: 'JS 超时（毫秒）', size: 'ms' },
  { k: 'maxRunsPerMin', t: '每分钟执行次数上限' },
];

export default function SandboxPage({ cmd }: { cmd?: PageCmd }) {
  const [stats, setStats] = useState<Stat[]>([]);
  const [cfg, setCfg] = useState<Record<string, number>>({});
  const [sel, setSel] = useState('');
  const [limits, setLimits] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(15000);   // 脚本默认超时（原「沙箱」插件的可配置项）
  const [sbGlobal, setSbGlobal] = useState(true);      // 沙箱能力的全局默认
  const [workNet, setWorkNet] = useState(true);        // work 容器联网（chat 沙箱始终断网）
  const [entries, setEntries] = useState<Entry[]>([]);
  /** 折叠起来的日期文件夹（键 = YYYY-MM-DD）；默认全展开，只在本次浏览里记 */
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [imgErr, setImgErr] = useState('');
  const [err, setErr] = useState('');
  /** 限额弹窗里的写入失败就地报红（弹窗盖着页面，用 err 看不见） */
  const [limitsErr, setLimitsErr] = useState('');

  const reload = useCallback(() => {
    get('/api/sandbox')
      .then((d: { stats?: Stat[]; config?: Record<string, unknown> }) => {
        const s = d.stats ?? [];
        setStats(s);
        setCfg((d.config ?? {}) as Record<string, number>);
        setWorkNet((d.config as { workNetwork?: boolean } | undefined)?.workNetwork !== false);
        setSel((v) => (v && s.some((x) => x.chat === v) ? v : s[0]?.chat ?? ''));
      })
      .catch(() => {});
    get('/api/plugins/sandbox/config')
      .then((r: { values?: Record<string, unknown>; globalDefault?: boolean }) => {
        setTimeoutMs(Number(r.values?.defaultTimeoutMs ?? 15000));
        setSbGlobal(!!r.globalDefault);
      })
      .catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const loadFiles = useCallback((chat: string) => {
    if (!chat) { setEntries([]); setTruncated(false); return; }
    get('/api/sandbox/files?chat=' + encodeURIComponent(chat))
      .then((r: { entries?: Entry[]; truncated?: boolean }) => { setEntries(r.entries ?? []); setTruncated(!!r.truncated); setErr(''); })
      .catch((x: unknown) => { setEntries([]); setErr((x as Error).message); });
  }, []);
  useEffect(() => { loadFiles(sel); }, [sel, loadFiles]);

  usePageCmd('sandbox', cmd, (kind) => { if (kind === 'limits') { setLimits((v) => !v); return; } reload(); loadFiles(sel); });

  const pick = (chat: string) => { setSel(chat); setErr(''); };
  const toggleDay = (key: string) => setClosed((p) => {
    const n = new Set(p);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const handOff = async (e: Entry) => {
    try { await post('/api/sandbox/open', { chatKey: sel, path: e.relPath }); }
    catch (x) { setErr((x as Error).message); }
  };
  const openFile = async (e: Entry) => {
    setImgErr('');
    if (isImage(e.name)) { setView({ name: e.relPath, kind: 'image', text: '', truncated: false }); return; }
    try {
      const r = await get('/api/sandbox/read?chat=' + encodeURIComponent(sel) + '&path=' + encodeURIComponent(e.relPath));
      if (r.kind === 'text') { setView({ name: e.relPath, kind: 'text', text: r.text ?? '', truncated: !!r.truncated }); return; }
    } catch { /* 读不动的（超限等）一律交给系统打开 */ }
    await handOff(e);
  };
  /** 图片走 raw 端点：<img> 带不上请求头，所以按 ws 的同款写法用 ?token= */
  const rawUrl = (rel: string) => '/api/sandbox/raw?chat=' + encodeURIComponent(sel)
    + '&path=' + encodeURIComponent(rel) + '&token=' + encodeURIComponent(getToken());

  const clear = async (chat: string) => {
    if (!confirm(`清空会话 ${chat} 的沙箱文件？`)) return;
    try { await post('/api/sandbox/clear', { chatKey: chat }); setErr(''); reload(); }
    catch { /* 失败不弹提示 */ }
  };

  const cur = stats.find((s) => s.chat === sel);
  const here = cur?.root ?? '';
  const days = groupByDay(entries);

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          <div className="mset-group">
            <div className="mset-group-t">会话（{stats.length}）</div>
            {stats.map((s) => (
              <button key={s.chat} className={'mset-item' + (s.chat === sel ? ' sel' : '')} onClick={() => pick(s.chat)} title={s.chat}>
                <span className="mset-item-ic"><Icon name="file" size={15} /></span>
                <FadeName text={s.chat} />
                <span className="mset-badge">{s.files}</span>
              </button>
            ))}
            {!stats.length && <div className="mset-group-e">暂无沙箱会话</div>}
          </div>
        </aside>

        {cur && (
          <section className="mset-detail">
            <div className="mset-dhead">
              <span className="mset-dic"><Icon name="file" size={17} /></span>
              <h2 className="mset-dtitle">{cur.chat}</h2>
              <div className="mset-dright">
                <button className="mset-add" onClick={() => void clear(cur.chat)}>
                  <Icon name="trash" size={13} /> 清空
                </button>
              </div>
            </div>

            <div className="mset-meta">
              <span className="tag accent">{cur.files} 个文件</span>
              <span className="tag">{fmtBytes(cur.bytes)}</span>
              <span className="tag mono">{cur.lastActivity ? fmtDT(cur.lastActivity) : '—'}</span>
            </div>

            <div className="mset-sec-h">
              <span>位置</span>
              <span className="plg-sec-r plg-hint mono" title={here}>{tail(here)}</span>
            </div>
            {days.map((d) => {
              const open = !closed.has(d.key);
              return (
                <div className="mset-models sb-day" key={d.key}>
                  <button className="mset-mrow" onClick={() => toggleDay(d.key)} aria-expanded={open}>
                    <span className={'mset-chev' + (open ? ' open' : '')}><Icon name="chevron" size={12} /></span>
                    <span className="sb-fold-nm mono">{d.key}</span>
                    <span className="mset-macts">
                      <span className="plg-hint">{d.items.length} 个 · {fmtBytes(d.bytes)}</span>
                    </span>
                  </button>
                  {open && d.items.map((e) => (
                    <div className="mset-mrow sb-in" key={e.relPath}>
                      <span className="mset-item-ic"><Icon name={fileIcon(e.name)} size={14} /></span>
                      <button className="mset-mname" onClick={() => void openFile(e)} title={e.relPath}>{base(e.relPath)}</button>
                      <span className="mset-macts">
                        {dirOf(e.relPath) && <span className="plg-hint mono">{dirOf(e.relPath)}</span>}
                        <span className="plg-hint">{fmtBytes(e.size)}</span>
                        <span className="plg-hint">{fmtTime(e.mtime)}</span>
                        <button className="mset-ibtn" title="用系统程序打开" onClick={() => void handOff(e)}>
                          <Icon name="browser" size={14} />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
            {!days.length && <div className="mset-group-e">（没有文件）</div>}
            {truncated && <div className="plg-hint">（文件超过 800 个，未全部列出）</div>}
            {err && <span className="mset-err">{err}</span>}
          </section>
        )}
      </div>

      {limits && (
        <Modal title="限额与清理" onClose={() => setLimits(false)}>
          <div className="set-grid">
            {NUM_FIELDS.map((f) => (
              <Field key={f.k} label={f.t}>
                <BrandInput type="number" value={cfg[f.k] ?? ''} spellCheck={false}
                  onChange={(e) => setCfg((c) => ({ ...c, [f.k]: Number(e.target.value) }))} />
              </Field>
            ))}
            <Field label="脚本默认超时（毫秒）">
              <BrandInput type="number" value={timeoutMs} spellCheck={false} onChange={(e) => setTimeoutMs(Number(e.target.value))} />
            </Field>
          </div>
          <div className="mset-mrow" style={{ border: '1px solid var(--border)', borderRadius: 11, marginTop: 4 }}>
            <span className="plg-v">work 容器联网</span>
            <span className="mset-macts">
              <Switch on={workNet} title="work 的执行容器可出网（requests/pip/npm）；聊天沙箱不受影响，始终断网" onChange={() => setWorkNet((v) => !v)} />
            </span>
          </div>
          <div className="mset-mrow" style={{ border: '1px solid var(--border)', borderRadius: 11, marginTop: 4 }}>
            <span className="plg-v">沙箱工具（新群默认开启）</span>
            <span className="mset-macts">
              <Switch on={sbGlobal} title="按群开关在「插件」页的开关矩阵里设置" onChange={() => setSbGlobal((v) => !v)} />
            </span>
          </div>
          <div className="mset-mfoot">
            <button className="btn primary" onClick={async () => {
              try {
                await post('/api/sandbox/config', { ...cfg, workNetwork: workNet });
                await post('/api/plugins/sandbox/config', { values: { defaultTimeoutMs: timeoutMs } });
                await post('/api/plugins/sandbox/global-default', { enabled: sbGlobal });
                setLimitsErr('');
                setLimits(false);
              } catch (e) { setLimitsErr(`未保存：${(e as Error)?.message ?? String(e)}`); }
            }}>保存</button>
            <span className="plg-hint">聊天沙箱无网络；work 容器联网可开关；无凭据，路径穿越由内核拦截</span>
          </div>
          {limitsErr && <div className="mset-err">{limitsErr}</div>}
        </Modal>
      )}

      {view && (
        <Modal title={view.name} wide onClose={() => setView(null)}>
          {view.kind === 'image'
            ? <img className="sb-image" src={rawUrl(view.name)} alt={view.name} onError={() => setImgErr('图片读取失败')} />
            : <pre className="sb-view mono">{view.text}</pre>}
          {view.kind === 'text' && view.truncated && <div className="plg-hint">（只显示前 256K 字）</div>}
          {imgErr && <div className="mset-err">{imgErr}</div>}
        </Modal>
      )}
    </div>
  );
}

/** 路径太长时只留尾巴：文件名比盘符重要 */
const tail = (p: string) => (p.length <= 52 ? p : '…' + p.slice(-51));
const base = (p: string) => p.split('/').pop() ?? p;
/** 与内核 rawImage 的白名单保持一致：只有这些类型在页面里内联预览 */
const isImage = (name: string) => /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name);
/** 所在子目录（带尾斜杠），根目录下的文件返回空串 */
const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };

/** 同一天的文件收进一个以日期命名的文件夹（YYYY-MM-DD，跨年也排得对）；文件夹之间与内部都按时间倒序 */
function groupByDay(entries: Entry[]): { key: string; items: Entry[]; bytes: number }[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const dayKey = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const groups = new Map<string, { key: string; items: Entry[]; bytes: number }>();
  for (const e of [...entries].sort((a, b) => b.mtime - a.mtime)) {
    const k = dayKey(e.mtime);
    let g = groups.get(k);
    if (!g) { g = { key: k, items: [], bytes: 0 }; groups.set(k, g); }
    g.items.push(e);
    g.bytes += e.size;
  }
  return [...groups.values()];
}
