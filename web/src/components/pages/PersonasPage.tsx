'use client';
import { FadeName } from '@/components/FadeName';
/** 人格：左列表（按来源插件分组）+ 右详情（HDSI 四层结构化编辑：剧本 / 价值观 / 语气 / 世界事实，外加演化层与原始 JSON） */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { Modal, Field, Switch } from '@/components/Modal';
import { BrandInput } from '@/components/BrandInput';
import { PillSelect } from '@/components/PillSelect';
import { useSave } from '@/lib/useSave';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';
import Hint from '@/components/Hint';

/** HDSI 式剧本：canon（初始设定）/ perspective（个体价值观）/ voice（语气样例）/ lore（世界事实） */
interface Persona { id: string; pluginId: string; canon: any; raw: Record<string, string> }
interface PersonaPlugin { pluginId: string; pluginName: string; personas: Persona[] }
interface PersonasApi { default: string; plugins: PersonaPlugin[] }

interface CastRow { name: string; relation: string; [k: string]: unknown }
interface ExampleRow { user: string; assistant: string; [k: string]: unknown }
interface LoreRow { keys: string[]; constant?: boolean; priority?: number; content: string; [k: string]: unknown }

/** canon.json 的形状。各层都留着索引签名：_comment 与以后新加的键要能原样带回去，不能在编辑时被吃掉 */
interface CanonFile {
  name?: string;
  /** 群里叫它用的外号：命中即视为"在叫它"（与 QQ 昵称同一条提及通道） */
  aliases?: string[];
  canon: { protagonist: string[]; world: string[]; cast: CastRow[]; language?: string; [k: string]: unknown };
  perspective?: string;
  voice: { style?: string; examples: ExampleRow[]; post_history?: string; [k: string]: unknown };
  lore: LoreRow[];
  [k: string]: unknown;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const objRows = <T,>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as T[] : []);

/** 按标准形状取值：缺的补空数组/空串，未知字段原样保留（老文件、手写文件都能开） */
function normalize(raw: any): CanonFile {
  const c = raw && typeof raw === 'object' ? raw : {};
  const canon = c.canon && typeof c.canon === 'object' ? c.canon : {};
  const voice = c.voice && typeof c.voice === 'object' ? c.voice : {};
  return {
    ...c,
    name: typeof c.name === 'string' ? c.name : '',
    aliases: strList(c.aliases),
    canon: {
      ...canon,
      protagonist: strList(canon.protagonist),
      world: strList(canon.world),
      cast: objRows<CastRow>(canon.cast).map((r) => ({ ...r, name: String(r.name ?? ''), relation: String(r.relation ?? '') })),
      language: typeof canon.language === 'string' ? canon.language : '',
    },
    perspective: typeof c.perspective === 'string' ? c.perspective : '',
    voice: {
      ...voice,
      style: typeof voice.style === 'string' ? voice.style : '',
      examples: objRows<ExampleRow>(voice.examples).map((e) => ({ ...e, user: String(e.user ?? ''), assistant: String(e.assistant ?? '') })),
      post_history: typeof voice.post_history === 'string' ? voice.post_history : '',
    },
    lore: objRows<LoreRow>(c.lore).map((e) => ({
      ...e,
      keys: strList(e.keys),
      constant: !!e.constant,
      priority: Number.isFinite(Number(e.priority)) ? Number(e.priority) : 100,
      content: String(e.content ?? ''),
    })),
  };
}

/** 落盘前清理：编辑时必须允许留空行（否则没法换行），存下来的文件不该带着它们 */
function clean(d: CanonFile): CanonFile {
  const drop = (a: string[]) => a.map((s) => s.trim()).filter(Boolean);
  return {
    ...d,
    aliases: drop(d.aliases ?? []),
    canon: {
      ...d.canon,
      protagonist: drop(d.canon.protagonist),
      world: drop(d.canon.world),
      cast: d.canon.cast.map((r) => ({ ...r, name: r.name.trim(), relation: r.relation.trim() })).filter((r) => r.name || r.relation),
    },
    voice: {
      ...d.voice,
      examples: d.voice.examples.map((e) => ({ ...e, user: e.user.trim(), assistant: e.assistant.trim() })).filter((e) => e.user || e.assistant),
    },
    lore: d.lore.map((e) => ({ ...e, keys: drop(e.keys), content: e.content.trim() })).filter((e) => e.keys.length && e.content),
  };
}

const serialize = (d: CanonFile) => JSON.stringify(d, null, 2) + '\n';

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
                <button key={p.id} className={'mset-item' + (p.id === sel ? ' sel' : '')} onClick={() => setSel(p.id)}>
                  <span className="mset-item-ic"><Icon name="personas" size={15} /></span>
                  <FadeName text={p.canon?.name || p.id} />
                  {p.id === data?.default && <i className="dot dot-on" />}
                </button>
              ))}
            </div>
          ))}
          {data && !all.length && <div className="mset-group-e">没有可用的人格插件</div>}
        </aside>

        {cur && (
          <PersonaDetail
            key={cur.p.id}
            persona={cur.p}
            isDefault={cur.p.id === data?.default}
            onSaved={reload}
          />
        )}
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

/** 新建人格：内核在人格插件的 personas/ 下建目录并写一张空 canon.json，随后热加载 */
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
      <Field label="人格 id">
        <BrandInput value={id} onChange={(e) => setId(e.target.value)} autoFocus spellCheck={false} />
      </Field>
      <Field label="显示名称">
        <BrandInput value={name} onChange={(e) => setName(e.target.value)} spellCheck={false}
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

// ============================================================
// 详情：四层各自一段，改的是同一份 canon.json（一个文件、一次保存）
// ============================================================

const LAYER_T: Record<string, string> = { character: '性格', world: '世界', relationship: '关系', perspective: '价值观' };
const MODES: { v: string; t: string }[] = [
  { v: 'layers', t: '分层编辑' },
  { v: 'json', t: '原始 JSON' },
];

function PersonaDetail({ persona, isDefault, onSaved }: {
  persona: Persona; isDefault: boolean; onSaved: () => void;
}) {
  /** 文件本身不是合法 JSON 时（手改坏了），只允许在原始 JSON 模式里修 */
  const broken = !persona.canon;
  const initial = serialize(normalize(persona.canon));
  const [draft, setDraft] = useState<CanonFile>(() => normalize(persona.canon));
  const [text, setText] = useState(initial);
  const [orig, setOrig] = useState(initial);
  const [mode, setMode] = useState<'layers' | 'json'>(broken ? 'json' : 'layers');
  const { err, setErr, run } = useSave();
  const [ov, setOv] = useState<{ layer: string; content: string; source?: string }[]>([]);

  const dirty = text !== orig;

  // HDSI 的 Overlay 层：长期剧情里稳定形成的变化，可整层或全部清掉（Canon 不动）
  const loadOv = useCallback(() => {
    get(`/api/personas/overlay?personaId=${persona.id}`)
      .then((d: { entries?: typeof ov }) => setOv(d.entries ?? []))
      .catch(() => {});
  }, [persona.id]);
  useEffect(() => { loadOv(); }, [loadOv]);
  const clearOv = async (layer?: string) => {
    try { const r = await post('/api/personas/overlay', { personaId: persona.id, layer }); setOv(r.entries ?? []); setErr(''); }
    catch (e) { setErr(`清空演化层失败：${(e as Error)?.message ?? String(e)}`); }
  };

  /** 改一层：draft 与 text 同步推进，切到原始 JSON 看到的就是当前草稿。
   *  用 ref 兜住"同一拍里连着改两处"——只读 state 的话后一次会拿旧值把前一次盖掉。 */
  const draftRef = useRef(draft);
  const applyDraft = (next: CanonFile) => { draftRef.current = next; setDraft(next); setText(serialize(next)); };
  const patch = (p: Partial<CanonFile>) => applyDraft({ ...draftRef.current, ...p });
  const patchCanon = (p: Partial<CanonFile['canon']>) => patch({ canon: { ...draftRef.current.canon, ...p } });
  const patchVoice = (p: Partial<CanonFile['voice']>) => patch({ voice: { ...draftRef.current.voice, ...p } });

  const switchMode = (m: string) => {
    if (m === mode) return;
    if (m === 'layers') {
      let parsed: CanonFile;
      try { parsed = normalize(JSON.parse(text)); }
      catch (e) { setErr('JSON 解析失败，先修好再切回分层编辑：' + (e as Error).message); return; }
      draftRef.current = parsed;      // 只换草稿，text 留着用户自己那段原样（切回来不该被重排）
      setDraft(parsed);
    }
    setErr('');
    setMode(m as 'layers' | 'json');
  };

  const save = () => {
    let next = draft;
    if (mode === 'json') {
      try { next = normalize(JSON.parse(text)); }
      catch (e) { setErr('JSON 解析失败：' + (e as Error).message); return; }
    }
    const cleaned = clean(next);
    const content = serialize(cleaned);
    run(() => post('/api/personas/edit', { personaId: persona.id, file: 'canon.json', content }), () => {
      draftRef.current = cleaned;
      setDraft(cleaned); setText(content); setOrig(content);
      onSaved();
      loadOv();
    });
  };

  const reset = () => {
    const d = normalize(JSON.parse(orig));
    draftRef.current = d;
    setDraft(d); setText(orig); setErr('');
  };

  return (
    <section className="mset-detail">
      <div className="mset-dhead">
        <span className="mset-dic"><Icon name="personas" size={17} /></span>
        <h2 className="mset-dtitle">{draft.name || persona.id}</h2>
        <span className="mset-dright">
          <PillSelect value={mode} options={MODES} onChange={switchMode} label="编辑方式" />
        </span>
      </div>

      <div className="mset-meta">
        {isDefault && <span className="tag accent">默认人格</span>}
        <span className="tag">{draft.canon.protagonist.length} 条主角记号</span>
        <span className="tag">{draft.canon.world.length} 条世界</span>
        <span className="tag">{draft.aliases?.length ?? 0} 个叫醒词</span>
        <span className="tag">{draft.lore.length} 条世界事实</span>
        <span className="tag">{draft.voice.examples.length} 条语气样例</span>
        {dirty && <span className="tag warn">未保存</span>}
      </div>

      {mode === 'json' ? (
        <>
          <div className="mset-sec-h">
            <span>canon.json</span>
            <span className="plg-sec-r"><Hint text={broken ? '这个文件不是合法 JSON，先在下面修好' : '与分层编辑同一份内容，改哪边都行'} /></span>
          </div>
          <BrandInput multiline className="persona-card mono" value={text} spellCheck={false} rows={22}
            onChange={(e) => setText(e.target.value)} />
        </>
      ) : (
        <>
          {/* ---------- ① 剧本 Canon ---------- */}
          <div className="mset-sec-h"><span>剧本</span><span className="plg-sec-r"><Hint text="初始设定，只由人写" /></span></div>
          <div className="mset-field">
            <label className="mset-flabel">名称</label>
            <BrandInput value={draft.name ?? ''} spellCheck={false} onChange={(e) => patch({ name: e.target.value })} />
          </div>
          <div className="mset-field">
            <label className="mset-flabel">叫醒词<Hint text="群聊里说到这些词就算在叫它；@ 与回复它的消息始终直接唤醒" /></label>
            <KeyInput value={draft.aliases ?? []} onChange={(v) => patch({ aliases: v })} />
          </div>
          <Lines label="主角记号" value={draft.canon.protagonist} rows={3}
            onChange={(v) => patchCanon({ protagonist: v })} />
          <Lines label="世界" value={draft.canon.world} rows={2}
            onChange={(v) => patchCanon({ world: v })} />

          <div className="mset-sec-h">
            <span>配角</span>
            <button className="mset-add" onClick={() => patchCanon({ cast: [...draft.canon.cast, { name: '', relation: '' }] })}>
              <Icon name="plus" size={13} /> 添加配角
            </button>
          </div>
          <div className="mset-models">
            {draft.canon.cast.length === 0 && <div className="persona-empty">还没有配角</div>}
            {draft.canon.cast.map((r, i) => (
              <div className="persona-entry" key={i}>
                <div className="persona-2">
                  <BrandInput value={r.name} spellCheck={false}
                    onChange={(e) => patchCanon({ cast: draft.canon.cast.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <BrandInput value={r.relation} spellCheck={false}
                    onChange={(e) => patchCanon({ cast: draft.canon.cast.map((x, j) => (j === i ? { ...x, relation: e.target.value } : x)) })} />
                </div>
                <DelBtn onClick={() => patchCanon({ cast: draft.canon.cast.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </div>

          <div className="mset-field" style={{ marginTop: 14 }}>
            <label className="mset-flabel">语言</label>
            <BrandInput value={draft.canon.language ?? ''} spellCheck={false}
              onChange={(e) => patchCanon({ language: e.target.value })} />
          </div>

          {/* ---------- ② 价值观 Perspective ---------- */}
          <div className="mset-sec-h"><span>价值观 <Hint text="她看世界的方式" /></span></div>
          <div className="mset-field">
            <BrandInput multiline grow rows={3} value={draft.perspective ?? ''} spellCheck={false}
              onChange={(e) => patch({ perspective: e.target.value })} />
          </div>

          {/* ---------- ③ 语气 Voice ---------- */}
          <div className="mset-sec-h"><span>语气 <Hint text="说话方式" /></span></div>
          <div className="mset-field">
            <BrandInput value={draft.voice.style ?? ''} spellCheck={false}
              onChange={(e) => patchVoice({ style: e.target.value })} />
          </div>

          <div className="mset-sec-h">
            <span>语气样例</span>
            <button className="mset-add" onClick={() => patchVoice({ examples: [...draft.voice.examples, { user: '', assistant: '' }] })}>
              <Icon name="plus" size={13} /> 添加样例
            </button>
          </div>
          <div className="mset-models">
            {draft.voice.examples.length === 0 && <div className="persona-empty">还没有样例</div>}
            {draft.voice.examples.map((ex, i) => (
              <div className="persona-entry" key={i}>
                <div>
                  <div className="persona-line">
                    <span className="persona-k">对方</span>
                    <BrandInput value={ex.user} spellCheck={false}
                      onChange={(e) => patchVoice({ examples: draft.voice.examples.map((x, j) => (j === i ? { ...x, user: e.target.value } : x)) })} />
                  </div>
                  <div className="persona-line">
                    <span className="persona-k">她回</span>
                    <BrandInput multiline grow rows={2} value={ex.assistant} spellCheck={false}
                      onChange={(e) => patchVoice({ examples: draft.voice.examples.map((x, j) => (j === i ? { ...x, assistant: e.target.value } : x)) })} />
                  </div>
                </div>
                <DelBtn onClick={() => patchVoice({ examples: draft.voice.examples.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </div>

          <div className="mset-field" style={{ marginTop: 14 }}>
            <label className="mset-flabel">尾部强化</label>
            <BrandInput multiline grow rows={3} value={draft.voice.post_history ?? ''} spellCheck={false}
              onChange={(e) => patchVoice({ post_history: e.target.value })} />
          </div>

          {/* ---------- ④ 世界事实 Lore ---------- */}
          <div className="mset-sec-h">
            <span>世界事实</span>
            <button className="mset-add" onClick={() => patch({ lore: [...draft.lore, { keys: [], constant: false, priority: 100, content: '' }] })}>
              <Icon name="plus" size={13} /> 添加事实
            </button>
          </div>
          <div className="mset-models">
            {draft.lore.length === 0 && <div className="persona-empty">还没有世界事实</div>}
            {draft.lore.map((e, i) => {
              const set = (p: Partial<LoreRow>) => patch({ lore: draft.lore.map((x, j) => (j === i ? { ...x, ...p } : x)) });
              return (
                <div className="persona-entry" key={i}>
                  <div>
                    <div className="persona-line">
                      <span className="persona-k">命中词</span>
                      <KeyInput value={e.keys} onChange={(keys) => set({ keys })} />
                      <span className="persona-k">优先级</span>
                      <BrandInput className="persona-num" type="number" value={e.priority ?? 100} onChange={(ev) => set({ priority: Number(ev.target.value) })} />
                      <Switch on={!!e.constant} onChange={() => set({ constant: !e.constant })} />
                      <Hint text="常驻：不看命中词，每轮都注入" />
                    </div>
                    <div className="persona-line">
                      <span className="persona-k">内容</span>
                      <BrandInput multiline grow rows={2} value={e.content} spellCheck={false}
                        onChange={(ev) => set({ content: ev.target.value })} />
                    </div>
                  </div>
                  <DelBtn onClick={() => patch({ lore: draft.lore.filter((_, j) => j !== i) })} />
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ---------- 演化层 Overlay（不在 canon.json 里，由 remember_setting 写入） ---------- */}
      <div className="mset-sec-h">
        <span>演化层 <Hint text="长期剧情里稳定形成的设定会自动写进来。" /></span>
        <span className="plg-sec-r">
          {ov.length > 0 && <button className="btn" onClick={() => void clearOv()}>全部清空</button>}
        </span>
      </div>
      {ov.length === 0 ? <div className="mset-group-e">还没有演化</div> : (
        <div className="mset-models">
          {ov.map((e, i) => (
            <div className="mset-mrow" key={i}>
              <span className="persona-ovl-k">{LAYER_T[e.layer] ?? e.layer}</span>
              <span className="persona-ovl-v">{e.content}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mset-mfoot">
        <button className="btn primary" onClick={save}>保存并重载</button>
        {dirty && <button className="mset-link" onClick={reset}>撤销改动</button>}
        {err && <span className="mset-err">{err}</span>}
      </div>
    </section>
  );
}

function DelBtn({ onClick }: { onClick: () => void }) {
  return (
    <button className="mset-ibtn persona-del" title="删除" onClick={onClick}><Icon name="trash" size={14} /></button>
  );
}

/** 一行一条的字符串列表（主角记号 / 世界）：编辑时保留空行，存盘前统一清掉 */
function Lines({ label, value, onChange, rows = 3, hint }: {
  label: string; value: string[]; onChange: (v: string[]) => void; rows?: number; hint?: string;
}) {
  return (
    <div className="mset-field">
      <label className="mset-flabel">{label}{hint && <Hint text={hint} />}</label>
      <BrandInput multiline grow rows={rows} value={value.join('\n')} spellCheck={false}
        onChange={(e) => onChange(e.target.value.split('\n'))} />
    </div>
  );
}

/**
 * 逗号分隔的列表输入（世界事实的命中词）。
 *
 * 编辑期间**显示用户原样的文本**，不拿数组去 join/split 回填：`a, b` 拆开是 `['a', ' b']`
 * （逗号后的空格并进第二项），拼回去就成了 `a,  b` —— 第一次按键就会多出一个空格，
 * 而且此后每次编辑都重新拼一遍，那个空格再也删不掉。失焦时才归一成 `a, b`；
 * 数组这边取 trim 过的值，所以草稿里不会留着分隔符空格。
 */
function KeyInput({ value, onChange }: {
  value: string[]; onChange: (v: string[]) => void;
}) {
  const [buf, setBuf] = useState<string | null>(null);
  return (
    <BrandInput value={buf ?? value.join(', ')} spellCheck={false}
      onBlur={() => setBuf(null)}
      onChange={(e) => {
        setBuf(e.target.value);
        onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean));
      }} />
  );
}
