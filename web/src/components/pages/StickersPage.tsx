'use client';
/** 表情包库：左标签筛选 + 右网格。描述就地编辑（600ms 防抖保存），标签失焦保存，悬停出删除；
 *  顶栏「上传」钮或把图直接拖进页面（原始字节走 upload 端点）。 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { get, post, postRaw, fmtDT } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { BrandInput } from '@/components/BrandInput';
import { BlobImg } from '@/components/BlobImg';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';

interface Sticker {
  id: string; desc: string; tags: string[]; count: number;
  lastUsed: number; addedAt: number; source?: { userId: string; nickname: string };
}

const OFF = '插件未启用，可在插件页开启';

export default function StickersPage({ cmd }: { cmd?: PageCmd }) {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  /** null = 读取中；'' = 正常；其余是空态一句话 */
  const [off, setOff] = useState<string | null>(null);
  /** 校验与写入失败一律就地红字（全站不用 toast） */
  const [err, setErr] = useState('');
  const [tag, setTag] = useState('');
  const [drag, setDrag] = useState(false);
  /** 标签输入草稿：编辑中保留逗号与空格，失焦才拆成数组存 */
  const [tagDraft, setTagDraft] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const reload = useCallback(() => {
    get('/api/plugin/sticker/library')
      .then((r: { ok: boolean; stickers?: Sticker[] }) => {
        if (r.ok === false) { setOff(OFF); return; }
        setOff('');
        setStickers(r.stickers ?? []);
      })
      .catch(() => setOff(OFF));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const upload = useCallback((files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) { setErr(`只能上传图片：${f.name}`); continue; }
      postRaw('/api/plugin/sticker/upload?name=' + encodeURIComponent(f.name), f)
        .then(() => { setErr(''); reload(); })
        .catch((e: Error) => setErr(`上传失败：${e.message}`));
    }
  }, [reload]);
  // 顶栏「上传」圆钮 → 打开文件选择
  usePageCmd('stickers', cmd, (kind) => { if (kind === 'upload') fileRef.current?.click(); });

  const saveDesc = (s: Sticker, desc: string) => {
    setStickers((v) => v.map((x) => (x.id === s.id ? { ...x, desc } : x)));
    const key = 'desc:' + s.id;
    if (timers.current[key]) clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      delete timers.current[key];
      post('/api/plugin/sticker/desc', { id: s.id, desc }).catch((e: Error) => setErr(`未保存：${e.message}`));
    }, 600);
  };
  const saveTags = (s: Sticker) => {
    const draft = tagDraft[s.id];
    if (draft === undefined) return;
    const tags = draft.split(/[,，、\s]+/).filter(Boolean);
    if (tags.join(' ') === s.tags.join(' ')) { setTagDraft((d) => { const n = { ...d }; delete n[s.id]; return n; }); return; }
    setStickers((v) => v.map((x) => (x.id === s.id ? { ...x, tags } : x)));
    post('/api/plugin/sticker/desc', { id: s.id, desc: s.desc, tags })
      .then(() => setTagDraft((d) => { const n = { ...d }; delete n[s.id]; return n; }))
      .catch((e: Error) => setErr(`未保存：${e.message}`));
  };
  const remove = async (s: Sticker) => {
    if (!confirm(`删除表情包「${s.desc || s.id}」？`)) return;
    try {
      await post('/api/plugin/sticker/delete', { id: s.id });
      setErr('');
      setStickers((v) => v.filter((x) => x.id !== s.id));
    } catch (e) { setErr((e as Error).message); }
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
  };

  if (off) return <div className="mset-body"><div className="mset-detail"><div className="mset-empty">{off}</div></div></div>;

  const tags = Array.from(new Set(stickers.flatMap((s) => s.tags))).sort();
  const shown = tag ? stickers.filter((s) => s.tags.includes(tag)) : stickers;
  return (
    <div className={'mset-body' + (drag ? ' stk-drag' : '')}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={drop}>
      <aside className="mset-list">
        <div className="mset-group">
          <div className="mset-group-t">标签</div>
          <button className={'mset-item' + (tag === '' ? ' sel' : '')} onClick={() => setTag('')}>
            <span className="mset-item-ic"><Icon name="sticker" size={15} /></span>
            <span className="mset-item-nm">全部</span>
            <span className="mset-badge">{stickers.length}</span>
          </button>
          {tags.map((t) => (
            <button key={t} className={'mset-item' + (t === tag ? ' sel' : '')} onClick={() => setTag(t)}>
              <span className="mset-item-ic"><Icon name="pin" size={15} /></span>
              <span className="mset-item-nm">{t}</span>
              <span className="mset-badge">{stickers.filter((s) => s.tags.includes(t)).length}</span>
            </button>
          ))}
          {!stickers.length && <div className="mset-group-e">还没有表情包</div>}
        </div>
      </aside>

      <section className="mset-detail">
        <div className="mset-dhead">
          <span className="mset-dic"><Icon name="sticker" size={17} /></span>
          <h2 className="mset-dtitle">表情包</h2>
          <div className="mset-dright">
            <button className="mset-add" onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={13} /> 上传
            </button>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
        {err && <div className="mset-err">{err}</div>}
        {!shown.length && <div className="mset-empty">{tag ? `没有带「${tag}」的表情` : '还没有表情包，点右上角上传或把图拖进来'}</div>}
        <div className="stk-grid">
          {shown.map((s) => (
            <div className="stk-card" key={s.id}>
              <span className="stk-thumb">
                <BlobImg path={'/api/plugin/sticker/image?id=' + encodeURIComponent(s.id)} className="stk-img" />
                <button className="stk-del" title="删除" onClick={() => void remove(s)}>
                  <Icon name="trash" size={13} />
                </button>
              </span>
              <span className="stk-body">
                <BrandInput value={s.desc} placeholder="描述" spellCheck={false}
                  onChange={(e) => saveDesc(s, e.target.value)} />
                <BrandInput value={tagDraft[s.id] ?? s.tags.join(', ')} placeholder="标签，逗号分隔" spellCheck={false}
                  onChange={(e) => setTagDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                  onBlur={() => saveTags(s)} />
                <span className="stk-meta">
                  用 {s.count} 次
                  {s.source && <> · {s.source.nickname || s.source.userId}</>}
                  {' · '}{s.lastUsed ? fmtDT(s.lastUsed) : '还没用过'}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
