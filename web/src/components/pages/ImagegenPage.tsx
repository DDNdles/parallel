'use client';
/** 生图：左「本周用量」名单 + 右画廊网格；主人可在页面里直接生成（generate 仅主人 token，401/403 就把表单藏掉）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, fmtDT } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { BrandInput } from '@/components/BrandInput';
import { BlobImg } from '@/components/BlobImg';
import { Modal } from '@/components/Modal';

interface GenImage { id: string; prompt: string; model: string; userId: string; chatId: string; ts: number; file: string }
interface Usage { weekKey: string; users: { userId: string; used: number }[] }

const OFF = '插件未启用，可在插件页开启';
/** 只有 401（api 层的 unauthorized）才是「不是主人」：插件业务错误里常带「主人/权限」字样，不能按关键词判 */
const notOwner = (e: unknown) => (e as Error)?.message === 'unauthorized';
const toDataURL = (f: File) => new Promise<string>((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result));
  fr.onerror = () => rej(new Error(`读取失败：${f.name}`));
  fr.readAsDataURL(f);
});

export default function ImagegenPage() {
  const [off, setOff] = useState<string | null>(null);
  const [images, setImages] = useState<GenImage[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [err, setErr] = useState('');
  const [prompt, setPrompt] = useState('');
  const [refs, setRefs] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  /** 生成请求吃了 401/403：不是主人，表单从此隐藏 */
  const [hideForm, setHideForm] = useState(false);
  const [view, setView] = useState<GenImage | null>(null);
  const refInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    Promise.all([
      get('/api/plugin/imagegen/gallery').catch(() => null),
      get('/api/plugin/imagegen/usage').catch(() => null),
    ]).then(([g, u]: [{ ok?: boolean; images?: GenImage[] } | null, { ok?: boolean; weekKey?: string; users?: Usage['users'] } | null]) => {
      if (!g || g.ok === false) { setOff(OFF); return; }
      setOff('');
      setImages(g.images ?? []);
      if (u && u.ok !== false) setUsage({ weekKey: u.weekKey ?? '', users: u.users ?? [] });
    });
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setErr('');
    try {
      const refsB64 = refs.length ? await Promise.all(refs.map(toDataURL)) : undefined;
      const r = await post('/api/plugin/imagegen/generate', { prompt: prompt.trim(), ...(refsB64 ? { refs: refsB64 } : {}) });
      if (r.ok === false) throw new Error(r.error || '生成失败');
      setPrompt('');
      setRefs([]);
      reload();
    } catch (e) {
      if (notOwner(e)) setHideForm(true);
      else setErr((e as Error)?.message ?? String(e));
    } finally { setBusy(false); }
  };

  if (off) return <div className="mset-body"><div className="mset-detail"><div className="mset-empty">{off}</div></div></div>;

  return (
    <div className="mset-body">
      <aside className="mset-list">
        <div className="mset-group">
          <div className="mset-group-t">本周用量{usage?.weekKey ? ` · ${usage.weekKey}` : ''}</div>
          {(usage?.users ?? []).map((u) => (
            <div className="mset-item ig-static" key={u.userId} title={u.userId}>
              <span className="mset-item-ic"><Icon name="users" size={15} /></span>
              <span className="mset-item-nm">{u.userId}</span>
              <span className="mset-badge">{u.used} 张</span>
            </div>
          ))}
          {!usage?.users.length && <div className="mset-group-e">本周还没有人生成</div>}
        </div>
      </aside>

      <section className="mset-detail">
        <div className="mset-dhead">
          <span className="mset-dic"><Icon name="image" size={17} /></span>
          <h2 className="mset-dtitle">生图</h2>
          <div className="mset-dright">
            <span className="plg-hint">{images.length} 张</span>
            <button className="mset-add" onClick={reload}><Icon name="refresh" size={13} /> 刷新</button>
          </div>
        </div>

        {!hideForm && (
          <div className="ig-form">
            <BrandInput multiline grow rows={3} value={prompt} placeholder="想要什么图，说清楚点…"
              onChange={(e) => setPrompt(String(e.target.value))} />
            <div className="ig-form-row">
              <button className="mset-add" onClick={() => refInput.current?.click()}>
                <Icon name="image" size={13} /> 参考图{refs.length ? `（${refs.length}）` : ''}
              </button>
              <input ref={refInput} type="file" accept="image/*" multiple className="hidden"
                onChange={(e) => { if (e.target.files) setRefs(Array.from(e.target.files)); e.target.value = ''; }} />
              {refs.map((f) => <span className="tag" key={f.name}>{f.name}</span>)}
              {!!refs.length && <button className="mset-link" onClick={() => setRefs([])}>清空</button>}
              <button className="btn primary ig-gen" disabled={!prompt.trim() || busy} onClick={() => void generate()}>
                {busy ? '生成中…' : '生成'}
              </button>
            </div>
          </div>
        )}
        {err && <div className="mset-err">{err}</div>}

        {!images.length && <div className="mset-empty">画廊还空着{hideForm ? '，主人在 QQ 里发「生图」或在这里配置好再来看' : '，生成第一张试试'}。</div>}
        <div className="ig-grid">
          {images.map((im) => (
            <div className="ig-card" key={im.id}>
              <BlobImg path={'/api/plugin/imagegen/image?id=' + encodeURIComponent(im.id)} className="ig-img" zoomable onZoom={() => setView(im)} />
              <div className="ig-body">
                <div className="ig-prompt" title={im.prompt}>{im.prompt}</div>
                <div className="ig-meta mono">{im.userId} · {fmtDT(im.ts)} · {im.model}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {view && (
        <Modal title={view.prompt} wide onClose={() => setView(null)}>
          <BlobImg path={'/api/plugin/imagegen/image?id=' + encodeURIComponent(view.id)} className="sb-image" />
          <div className="mset-meta">
            <span className="tag accent">{view.userId}</span>
            <span className="tag mono">{view.chatId}</span>
            <span className="tag mono">{fmtDT(view.ts)}</span>
            <span className="tag">{view.model}</span>
          </div>
        </Modal>
      )}
    </div>
  );
}
