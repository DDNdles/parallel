'use client';
/** 沙箱：左列表（按会话）+ 右详情（占用 / 文件浏览 / 清空），顶栏「限额与清理」弹窗
 *  文件点开：文本在弹窗里看，二进制或行尾那颗按钮交给系统默认程序（不可执行类型只在资源管理器里选中） */
import { useCallback, useEffect, useState } from 'react';
import { get, post, fmtBytes, fmtDT } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { fileIcon } from '@/lib/fileIcon';
import { BrandInput } from '@/components/BrandInput';
import { Modal, Field, Switch } from '@/components/Modal';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';

interface Stat { chat: string; files: number; bytes: number; lastActivity: number; root: string }
interface Entry { name: string; relPath: string; type: 'file' | 'dir'; size: number; mtime: number }
interface View { name: string; text: string; truncated: boolean }

const NUM_FIELDS: { k: string; t: string; size?: 'bytes' | 'ms' | 'h' }[] = [
  { k: 'ttlHours', t: '文件 TTL（小时）', size: 'h' },
  { k: 'inboxTtlHours', t: '收件文件 TTL（小时）', size: 'h' },
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
  const [path, setPath] = useState('.');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState('');

  const reload = useCallback(() => {
    get('/api/sandbox')
      .then((d: { stats?: Stat[]; config?: Record<string, number> }) => {
        const s = d.stats ?? [];
        setStats(s);
        setCfg(d.config ?? {});
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

  usePageCmd('sandbox', cmd, (kind) => { if (kind === 'limits') setLimits((v) => !v); else reload(); });

  const loadDir = useCallback((chat: string, p: string) => {
    if (!chat) { setEntries([]); return; }
    get('/api/sandbox/files?chat=' + encodeURIComponent(chat) + '&path=' + encodeURIComponent(p))
      .then((r: { entries?: Entry[] }) => { setEntries(r.entries ?? []); setErr(''); })
      .catch((x: unknown) => { setEntries([]); setErr((x as Error).message); });
  }, []);
  useEffect(() => { loadDir(sel, path); }, [sel, path, loadDir]);

  const pick = (chat: string) => { setSel(chat); setPath('.'); setErr(''); };

  const handOff = async (e: Entry) => {
    try { await post('/api/sandbox/open', { chatKey: sel, path: e.relPath }); }
    catch (x) { setErr((x as Error).message); }
  };
  const open = async (e: Entry) => {
    if (e.type === 'dir') { setPath(e.relPath); return; }
    try {
      const r = await get('/api/sandbox/read?chat=' + encodeURIComponent(sel) + '&path=' + encodeURIComponent(e.relPath));
      if (r.kind === 'text') { setView({ name: e.relPath, text: r.text ?? '', truncated: !!r.truncated }); return; }
    } catch { /* 读不动的（超限等）一律交给系统打开 */ }
    await handOff(e);
  };

  const clear = async (chat: string) => {
    if (!confirm(`清空会话 ${chat} 的沙箱文件？`)) return;
    try { await post('/api/sandbox/clear', { chatKey: chat }); setPath('.'); setErr(''); reload(); }
    catch { /* 失败不弹提示 */ }
  };

  const cur = stats.find((s) => s.chat === sel);
  const here = cur ? (path === '.' ? cur.root : cur.root + '\\' + path.replace(/\//g, '\\')) : '';

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          <div className="mset-group">
            <div className="mset-group-t">会话（{stats.length}）</div>
            {stats.map((s) => (
              <button key={s.chat} className={'mset-item' + (s.chat === sel ? ' sel' : '')} onClick={() => pick(s.chat)} title={s.chat}>
                <span className="mset-item-ic"><Icon name="file" size={15} /></span>
                <span className="mset-item-nm">{s.chat}</span>
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
              <span>目录</span>
              <span className="plg-sec-r plg-hint mono" title={here}>{tail(here)}</span>
            </div>
            <div className="mset-models">
              {path !== '.' && (
                <div className="mset-mrow">
                  <span className="mset-item-ic"><Icon name="file" size={14} /></span>
                  <button className="mset-mname" onClick={() => setPath(path.split('/').slice(0, -1).join('/') || '.')}>..</button>
                </div>
              )}
              {entries.map((e) => (
                <div className="mset-mrow" key={e.relPath}>
                  <span className="mset-item-ic"><Icon name={e.type === 'dir' ? 'file' : fileIcon(e.name)} size={14} /></span>
                  <button className="mset-mname" onClick={() => void open(e)} title={e.relPath}>{e.name}</button>
                  <span className="mset-macts">
                    {e.type === 'file' && <span className="plg-hint">{fmtBytes(e.size)}</span>}
                    <span className="plg-hint">{fmtDT(e.mtime)}</span>
                    {e.type === 'file' && (
                      <button className="mset-ibtn" title="用系统程序打开" onClick={() => void handOff(e)}>
                        <Icon name="browser" size={14} />
                      </button>
                    )}
                  </span>
                </div>
              ))}
              {!entries.length && <div className="mset-group-e">（空目录）</div>}
            </div>
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
            <span className="plg-v">沙箱工具（新群默认开启）</span>
            <span className="mset-macts">
              <Switch on={sbGlobal} title="群内在 /插件 里单独开关" onChange={() => setSbGlobal((v) => !v)} />
            </span>
          </div>
          <div className="mset-mfoot">
            <button className="btn primary" onClick={async () => {
              try {
                await post('/api/sandbox/config', cfg);
                await post('/api/plugins/sandbox/config', { values: { defaultTimeoutMs: timeoutMs } });
                await post('/api/plugins/sandbox/global-default', { enabled: sbGlobal });
                setLimits(false);
              } catch { /* 失败不弹提示 */ }
            }}>保存</button>
            <span className="plg-hint">沙箱无网络、无凭据，路径穿越由内核拦截</span>
          </div>
        </Modal>
      )}

      {view && (
        <Modal title={view.name} wide onClose={() => setView(null)}>
          <pre className="sb-view mono">{view.text}</pre>
          {view.truncated && <div className="plg-hint">（只显示前 256K 字）</div>}
        </Modal>
      )}
    </div>
  );
}

/** 路径太长时只留尾巴：文件名比盘符重要 */
const tail = (p: string) => (p.length <= 52 ? p : '…' + p.slice(-51));
