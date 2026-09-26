'use client';
/** 人格：左列表（按来源插件分组）+ 右详情（人设卡 / JSON 文件编辑），顶栏「重新读取」 */
import { useCallback, useEffect, useState } from 'react';
import { get, post } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { Modal, Field } from '@/components/Modal';
import { BrandInput } from '@/components/BrandInput';
import { PillSelect } from '@/components/PillSelect';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';

interface Persona { id: string; pluginId: string; card: any; lore: any; fewshot: any; raw: Record<string, string> }
interface PersonaPlugin { pluginId: string; pluginName: string; personas: Persona[] }
interface PersonasApi { default: string; plugins: PersonaPlugin[] }

const FILES: { v: string; t: string }[] = [
  { v: 'card.json', t: 'card.json · 人设卡' },
  { v: 'fewshot.json', t: 'fewshot.json · 语气样例' },
  { v: 'lorebook.json', t: 'lorebook.json · 世界书' },
];

export default function PersonasPage({ cmd }: { cmd?: PageCmd }) {
  const [data, setData] = useState<PersonasApi | null>(null);
  const [sel, setSel] = useState('');
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    get('/api/personas')
      .then((d: PersonasApi) => {
        setData(d);
        setSel((s) => (s && d.plugins.some((pp) => pp.personas.some((p) => p.id === s)) ? s : d.plugins[0]?.personas[0]?.id ?? ''));
      })
      .catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);

  usePageCmd('personas', cmd, (kind) => { if (kind === 'add') setCreating(true); else reload(); });

  const all = (data?.plugins ?? []).flatMap((pp) => pp.personas.map((p) => ({ p, pp })));
  const cur = all.find(({ p }) => p.id === sel);

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          {(data?.plugins ?? []).map((pp) => (
            <div className="mset-group" key={pp.pluginId}>
              <div className="mset-group-t">{pp.pluginName}</div>
              {pp.personas.map((p) => (
                <button key={p.id} className={'mset-item' + (p.id === sel ? ' sel' : '')} onClick={() => setSel(p.id)} title={p.id}>
                  <span className="mset-item-ic"><Icon name="personas" size={15} /></span>
                  <span className="mset-item-nm">{p.card?.name || p.id}</span>
                  {p.id === data?.default && <i className="dot dot-on" />}
                </button>
              ))}
            </div>
          ))}
          {data && !all.length && <div className="mset-group-e">没有可用的人格插件</div>}
        </aside>

        {cur && <PersonaDetail persona={cur.p} pluginId={cur.pp.pluginId} isDefault={cur.p.id === data?.default} />}
      </div>

      {creating && (
        <PersonaCreateModal
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); setSel(id); reload(); }}
        />
      )}
    </div>
  );
}

/** 新建人格：内核在人格插件的 personas/ 下建目录并写三张空文件，随后热加载 */
function PersonaCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    const pid = id.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(pid)) { setErr('id 需为小写字母/数字/连字符（2~31 位）'); return; }
    try {
      await post('/api/personas/create', { personaId: pid, name: name.trim() });
      onCreated(pid);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title="新建人格" onClose={onClose}>
      <Field label="人格 id（目录名）">
        <BrandInput value={id} onChange={(e) => setId(e.target.value)} placeholder="如 rabbit-girl" autoFocus spellCheck={false} />
      </Field>
      <Field label="显示名称">
        <BrandInput value={name} onChange={(e) => setName(e.target.value)} placeholder="留空则用 id" spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      </Field>
      <div className="mset-mfoot">
        <button className="btn primary" onClick={submit}>创建</button>
        <button className="mset-link" onClick={onClose}>取消</button>
      </div>
      {err && <div className="mset-err">{err}</div>}
    </Modal>
  );
}

function PersonaDetail({ persona, pluginId, isDefault }: { persona: Persona; pluginId: string; isDefault: boolean }) {
  const c = persona.card ?? {};
  const [file, setFile] = useState('card.json');
  const [content, setContent] = useState(persona.raw['card.json'] || '');
  const [err, setErr] = useState('');
  const pick = (f: string) => { setFile(f); setContent(persona.raw[f] || ''); };

  const save = async () => {
    try { JSON.parse(content); } catch (e) { setErr('JSON 解析失败：' + (e as Error).message); return; }
    try {
      await post('/api/personas/edit', { personaId: persona.id, file, content });
      setErr('');
    } catch (e) { setErr(`未保存：${(e as Error)?.message ?? String(e)}`); }
  };
  return (
    <section className="mset-detail">
      <div className="mset-dhead">
        <span className="mset-dic"><Icon name="personas" size={17} /></span>
        <h2 className="mset-dtitle">{c.name || persona.id}</h2>
        <span className="plg-ver mono">{persona.id}</span>
      </div>

      {c.description && <p className="plg-desc">{c.description}</p>}

      <div className="mset-meta">
        <span className="tag mono">{pluginId}</span>
        {isDefault && <span className="tag accent">默认人格</span>}
        <span className="tag">{persona.lore?.entries?.length ?? persona.lore?.length ?? 0} 条世界书</span>
        <span className="tag">{(persona.fewshot?.examples ?? []).length} 条样例</span>
      </div>

      <div className="mset-sec-h"><span>人设</span></div>
      {c.spec ? <pre className="persona-card mono">{c.spec}</pre> : (
        <div className="mset-models">
          <div className="mset-mrow"><span className="plg-k">性格</span><span className="plg-v">{c.personality || '—'}</span></div>
          <div className="mset-mrow"><span className="plg-k">场景</span><span className="plg-v">{c.scenario || '—'}</span></div>
          <div className="mset-mrow"><span className="plg-k">开场</span><span className="plg-v" style={{ whiteSpace: 'pre-wrap' }}>{c.first_mes || '—'}</span></div>
        </div>
      )}

      <div className="mset-sec-h">
        <span>人格文件</span>
        <span className="plg-sec-r">
          <PillSelect value={file} options={FILES} onChange={pick} label="人格文件" />
        </span>
      </div>
      <BrandInput multiline className="persona-card mono" value={content} spellCheck={false} rows={12}
        style={{ width: '100%' }} onChange={(e) => setContent(e.target.value)} />
      <div className="mset-mfoot">
        <button className="btn primary" onClick={save}>保存并重载</button>
        {err && <span className="mset-err">{err}</span>}
      </div>
    </section>
  );
}
