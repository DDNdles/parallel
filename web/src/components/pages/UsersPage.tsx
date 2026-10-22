'use client';
import { FadeName } from '@/components/FadeName';
/** 用户：左列表（按角色分组）+ 右详情（档案 / 记忆事实 / 操作审计 / 拉黑 / 忘记我）
 *  顶栏四颗圆钮：重新读取、导出记忆、导入记忆、权限名单 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, fmtDT } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { BrandInput } from '@/components/BrandInput';
import { Modal, Field, Switch } from '@/components/Modal';
import Hint from '@/components/Hint';
import { PillSelect, type PillOpt } from '@/components/PillSelect';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';
import { useSave } from '@/lib/useSave';

interface U { userId: string; nickname: string; remark?: string; lastSeen: number; blocked: boolean; isMaster: boolean; isAdmin: boolean }
interface UsersApi { users: U[]; masterIds: string[]; extraAdminIds: string[] }
interface Group { groupId: string; name: string; memberCount: number }
interface Member { userId: string; nickname: string; card?: string; role?: string }
interface Fact { id: string; content: string; sourcePlugin: string; weight: number; ts: number }
interface Detail {
  profile: { userId: string; nickname: string; firstSeen: number; lastSeen: number; blocked: boolean };
  facts: Fact[];
}
interface Op { ts: number; source: string; userId: string; op: string; payload: string }

const GROUPS: { v: string; t: string }[] = [
  { v: 'master', t: '主人' }, { v: 'admin', t: '用户' }, { v: 'user', t: '普通用户' }, { v: 'blocked', t: '已拉黑' },
];
const groupOf = (u: U) => (u.blocked ? 'blocked' : u.isMaster ? 'master' : u.isAdmin ? 'admin' : 'user');

export default function UsersPage({ cmd }: { cmd?: PageCmd }) {
  const [data, setData] = useState<UsersApi | null>(null);
  const [sel, setSel] = useState('');
  const [roles, setRoles] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [ops, setOps] = useState<{ user: string; rows: Op[] }>({ user: '', rows: [] });
  const [q, setQ] = useState('');
  /** 本页写入失败就地报红（详情区共用同一条） */
  const sv = useSave();
  const { err, setErr, fail } = sv;
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    get('/api/users')
      .then((d: UsersApi) => { setData(d); setSel((s) => (s && d.users.some((u) => u.userId === s) ? s : d.users[0]?.userId ?? '')); })
      .catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const loadDetail = useCallback((userId: string, query = '') => {
    if (!userId) return;
    setDetail(null);
    get('/api/memory/user/' + userId + (query ? `?q=${encodeURIComponent(query)}` : ''))
      .then((d: Detail) => setDetail(d)).catch(() => {});
    get('/api/memory/ops?user=' + encodeURIComponent(userId))
      .then((rows: Op[]) => setOps({ user: userId, rows })).catch(() => {});
  }, []);
  useEffect(() => { loadDetail(sel, q); }, [sel, q, loadDetail]);

  const exportJson = useCallback(async () => {
    const dump = await get('/api/memory/export');
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `parallel-memory-${Date.now()}.json`;
    a.click();
  }, []);
  const importJson = useCallback(async (f: File) => {
    try {
      await post('/api/memory/import', JSON.parse(await f.text()));
      setErr('');
      reload();
      loadDetail(sel, q);
    } catch (e) { fail(e); }
  }, [reload, loadDetail, sel, q, setErr, fail]);

  usePageCmd('users', cmd, (kind) => {
    if (kind === 'roles') setRoles((v) => !v);
    else if (kind === 'export') void exportJson();
    else if (kind === 'import') fileRef.current?.click();
    else { reload(); loadDetail(sel, q); }
  });

  const cur = data?.users.find((u) => u.userId === sel);
  const groups = GROUPS.map((g) => ({ ...g, list: (data?.users ?? []).filter((u) => groupOf(u) === g.v) })).filter((g) => g.list.length);

  const forget = async () => {
    if (!confirm(`确认清空 ${sel} 的全部记忆？`)) return;
    try {
      await post(`/api/memory/user/${sel}/forget`);
      setErr('');
      setQ(''); setDetail(null); setOps({ user: '', rows: [] }); reload();
    } catch (e) { fail(e); }
  };

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          {groups.map((g) => (
            <div className="mset-group" key={g.v}>
              <div className="mset-group-t">{g.t}（{g.list.length}）</div>
              {g.list.map((u) => (
                <button key={u.userId} className={'mset-item' + (u.userId === sel ? ' sel' : '')}
                  onClick={() => { setQ(''); setSel(u.userId); }} title={`${u.nickname || ''} ${u.userId}`}>
                  <span className="mset-item-ic"><Icon name={g.v === 'blocked' ? 'block' : 'personas'} size={15} /></span>
                  <FadeName text={u.nickname || u.userId} />
                  {g.v === 'blocked' && <i className="dot plg-dot-err" />}
                </button>
              ))}
            </div>
          ))}
          {data && !data.users.length && <div className="mset-group-e">还没有用户记录</div>}
        </aside>

        {cur && (
          <UserDetail key={cur.userId} u={cur} detail={detail} ops={ops.user === cur.userId ? ops.rows : []} q={q} onQ={setQ}
            sv={sv} onChanged={reload} onReload={() => loadDetail(cur.userId, q)} onForget={forget} />
        )}
      </div>

      {roles && data && <RolesModal data={data} onClose={() => setRoles(false)} onChanged={reload} />}
      <input type="file" ref={fileRef} className="hidden" accept=".json"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ''; }} />
    </div>
  );
}

function UserDetail({ u, detail, ops, q, onQ, sv, onChanged, onReload, onForget }: {
  u: U; detail: Detail | null; ops: Op[]; q: string; onQ: (s: string) => void;
  sv: ReturnType<typeof useSave>;
  onChanged: () => void; onReload: () => void; onForget: () => void;
}) {
  const { err, setErr, fail } = sv;
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [qin, setQin] = useState(q);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const p = detail?.profile;

  const block = async (to: boolean) => {
    setBusy(true);
    try { await post(`/api/users/${u.userId}/block`, { blocked: to }); setErr(''); onChanged(); onReload(); }
    catch (e) { fail(e); }
    finally { setBusy(false); }
  };
  const saveFact = async (f: Fact, content: string) => {
    try { await post('/api/memory/fact', { userId: u.userId, id: f.id, content }); setErr(''); onReload(); }
    catch (e) { fail(e); }
  };
  const delFact = async (f: Fact) => {
    try { await post('/api/memory/fact', { userId: u.userId, id: f.id }); setErr(''); onReload(); }
    catch (e) { fail(e); }
  };
  const addFact = async () => {
    const content = draft.trim();
    if (!content) return;
    try { await post(`/api/memory/user/${u.userId}`, { content }); setErr(''); setDraft(''); setAdding(false); onReload(); }
    catch (e) { fail(e); }
  };

  return (
    <section className="mset-detail">
      <div className="mset-dhead">
        <span className="mset-dic"><Icon name="personas" size={17} /></span>
        <h2 className="mset-dtitle">{p?.nickname || u.nickname || u.userId}</h2>
        <span className="plg-ver mono">{u.userId}</span>
        <div className="mset-dright">
          <span className="plg-hint">{u.blocked ? '已拉黑' : '正常'}</span>
          <Switch on={!u.blocked} title={u.blocked ? '点击解除拉黑' : '点击拉黑（不再回复该用户）'}
            onChange={() => void block(!u.blocked)} />
          <div className="mset-menu-wrap">
            <button className={'mset-ibtn' + (menu ? ' on' : '')} onClick={() => setMenu((v) => !v)} title="更多" aria-label="更多操作">
              <Icon name="dots" size={16} />
            </button>
            {menu && (
              <>
                <div className="mset-scrim" onClick={() => setMenu(false)} />
                <div className="mset-menu">
                  <button className="danger" onClick={() => { setMenu(false); onForget(); }}>忘记我（清空记忆）</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {err && <div className="mset-err">{err}</div>}

      <div className="mset-meta">
        {u.isMaster && <span className="tag accent">主人</span>}
        {!u.isMaster && u.isAdmin && <span className="tag">用户</span>}
        {u.blocked && <span className="tag err">拉黑</span>}
        <span className="tag">{detail?.facts.length ?? 0} 条记忆</span>
      </div>

      <div className="mset-sec-h"><span>档案</span>{busy && <span className="plg-sec-r plg-hint">写入中…</span>}</div>
      <div className="mset-models">
        <div className="mset-mrow"><span className="plg-k">首次</span><span className="plg-v">{p?.firstSeen ? fmtDT(p.firstSeen) : '—'}</span></div>
        <div className="mset-mrow"><span className="plg-k">最近</span><span className="plg-v">{fmtDT(p?.lastSeen || u.lastSeen) || '—'}</span></div>
        <div className="mset-mrow"><span className="plg-k">权限</span><span className="plg-v">
          {u.isMaster ? '主人（最高）' : u.isAdmin ? '用户（有work权限）' : '普通用户'}</span></div>
      </div>

      <div className="mset-sec-h">
        <span>记忆</span>
        <span className="plg-sec-r">
          <BrandInput value={qin} spellCheck={false} style={{ width: 160 }}
            onChange={(e) => setQin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onQ(qin.trim()); }} />
          <button className="mset-add" onClick={() => setAdding((v) => !v)}><Icon name="plus" size={13} /> 新增</button>
        </span>
      </div>
      <div className="mset-models">
        {adding && (
          <div className="mset-mrow">
            <BrandInput value={draft} spellCheck={false} style={{ flex: 1 }} autoFocus
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addFact(); }} />
            <span className="mset-macts">
              <button className="mset-ibtn" title="取消" onClick={() => { setAdding(false); setDraft(''); }}><Icon name="close" size={14} /></button>
            </span>
          </div>
        )}
        {!detail ? <div className="mset-group-e">读取中…</div>
          : detail.facts.length ? detail.facts.map((f) => <FactRow key={f.id} f={f} onSave={saveFact} onDel={delFact} />)
          : <div className="mset-group-e">{q ? '没有匹配的记忆' : '（无记忆）'}</div>}
      </div>

      <div className="mset-sec-h"><span>操作审计</span></div>
      {ops.length
        ? <pre className="plg-stack mono">{ops.map(opLine).join('\n')}</pre>
        : <div className="mset-group-e">（无记录）</div>}
    </section>
  );
}

const OP_LABEL: Record<string, string> = {
  create_profile: '建档',
  add_fact: '新增记忆',
  update_fact: '修改记忆',
  delete_facts: '删除记忆',
  forget: '忘记我',
  block: '拉黑',
  unblock: '解除拉黑',
};
const OP_SRC: Record<string, string> = { kernel: '内核', ui: '控制台' };

function opLine(o: Op): string {
  const attr = /^set_attr:(.+)$/.exec(o.op);
  const what = attr ? `写入属性 ${attr[1]}` : OP_LABEL[o.op] ?? o.op;
  return `${fmtDT(o.ts)} ${what}（${OP_SRC[o.source] ?? o.source}）${o.payload ? ' ' + o.payload : ''}`;
}

function FactRow({ f, onSave, onDel }: { f: Fact; onSave: (f: Fact, v: string) => void; onDel: (f: Fact) => void }) {
  const [v, setV] = useState(f.content);
  const dirty = v !== f.content;
  return (
    <div className="mset-mrow">
      <BrandInput value={v} spellCheck={false} style={{ flex: 1, minWidth: 0 }}
        onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && dirty) onSave(f, v); }} />
      <span className="mset-badge">{f.sourcePlugin}</span>
      {/* 权重 <1 = 后台自动提炼出来的（模型或人手动记的都是 1） */}
      {f.weight < 1 && <span className="mset-badge">自动</span>}
      <span className="plg-hint">{fmtDT(f.ts)}</span>
      <span className="mset-macts">
        {dirty && <button className="mset-ibtn" title="保存" onClick={() => onSave(f, v)}><Icon name="check" size={14} /></button>}
        <button className="mset-ibtn" title="删除" onClick={() => onDel(f)}><Icon name="trash" size={14} /></button>
      </span>
    </div>
  );
}

const parse = (s: string) => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

function RolesModal({ data, onClose, onChanged }: { data: UsersApi; onClose: () => void; onChanged: () => void }) {
  const [masters, setMasters] = useState(data.masterIds.join(','));
  const [users, setUsers] = useState<string[]>(data.extraAdminIds);
  const [q, setQ] = useState('');
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState('');
  const byId = new Map(data.users.map((u) => [u.userId, u]));
  const master = new Set(data.masterIds);
  const key = q.trim().toLowerCase();
  const found = key
    ? data.users.filter((u) => `${u.nickname ?? ''} ${u.remark ?? ''} ${u.userId}`.toLowerCase().includes(key)).slice(0, 8)
    : [];
  const rawQq = /^\d{5,12}$/.test(key) && !byId.has(key) && !users.includes(key) && !master.has(key);

  const add = (...ids: string[]) => setUsers((xs) => {
    const out = [...xs];
    for (const id of ids) if (id && !out.includes(id) && !master.has(id)) out.push(id);
    return out;
  });
  const save = async () => {
    try {
      await post('/api/users', { masterIds: parse(masters), extraAdminIds: users });
      setErr('');
      onClose();
      onChanged();
    } catch (e) { setErr(`未保存：${(e as Error)?.message ?? String(e)}`); }
  };
  return (
    <Modal title="权限名单" wide onClose={onClose}>
      <Field label="主人">
        <BrandInput value={masters} onChange={(e) => setMasters(e.target.value)} spellCheck={false} />
      </Field>

      <div className="mset-field">
        <label className="mset-flabel">用户<Hint text="有work权限" /></label>
        <div className="perm-search">
          <BrandInput value={q} placeholder="搜索名字或 QQ 号" spellCheck={false}
            onChange={(e) => setQ(e.target.value)} />
          <button className="mset-add" onClick={() => setPicking(true)}>
            <Icon name="plus" size={13} /> 从群聊添加
          </button>
        </div>

        {!!q.trim() && (
          <div className="mset-models perm-results">
            {found.map((u) => {
              const has = users.includes(u.userId) || master.has(u.userId);
              return (
                <button key={u.userId} disabled={has} className="mset-mrow perm-row"
                  title={has ? '已经在名单里' : undefined}
                  onClick={() => { if (!has) { add(u.userId); setQ(''); } }}>
                  <span className="ic"><Icon name="personas" size={14} /></span>
                  <FadeName className="perm-row-nm" text={u.nickname || u.remark || u.userId} />
                  <span className="perm-row-qq mono">{u.userId}</span>
                  {has ? <span className="mset-badge">已有</span> : <span className="mset-macts"><Icon name="plus" size={13} /></span>}
                </button>
              );
            })}
            {rawQq && (
              <button className="mset-mrow perm-row" onClick={() => { add(q.trim()); setQ(''); }}>
                <span className="ic"><Icon name="plus" size={14} /></span>
                <span className="perm-row-nm">添加 QQ {q.trim()}</span>
              </button>
            )}
            {!found.length && !rawQq && <div className="mset-group-e">没有匹配的用户</div>}
          </div>
        )}

        <div className="mset-chips wrap perm-chips">
          {users.length ? users.map((id) => {
            const u = byId.get(id);
            return (
              <span className="mset-chip perm-chip" key={id} title={u?.nickname ? `${u.nickname} ${id}` : id}>
                <span className="perm-chip-nm">{u?.nickname || u?.remark || id}</span>
                {!!u?.nickname && <span className="perm-chip-qq mono">{id}</span>}
                <button className="perm-chip-x" title="移除"
                  onClick={() => setUsers((xs) => xs.filter((x) => x !== id))}>
                  <Icon name="close" size={11} />
                </button>
              </span>
            );
          }) : <span className="mset-group-e">还没有用户，搜索或从群聊添加</span>}
        </div>
      </div>

      <div className="mset-mfoot">
        <button className="btn primary" onClick={save}>保存</button>
        <button className="mset-link" onClick={onClose}>取消</button>
      </div>
      {err && <div className="mset-err">{err}</div>}

      {picking && (
        <GroupPicker existing={users} masters={data.masterIds}
          onClose={() => setPicking(false)}
          onAdd={(ids) => { add(...ids); setPicking(false); }} />
      )}
    </Modal>
  );
}

/** 从群聊批量加人：群列表现拉协议端，成员按昵称/QQ 再筛一遍，已在名单里的置灰。 */
function GroupPicker({ existing, masters, onClose, onAdd }: {
  existing: string[]; masters: string[]; onClose: () => void; onAdd: (ids: string[]) => void;
}) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [gid, setGid] = useState('');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const blocked = new Set([...existing, ...masters]);

  useEffect(() => {
    get('/api/groups').then((d: { groups: Group[] }) => {
      setGroups(d.groups);
      setGid(d.groups[0]?.groupId ?? '');
      if (!d.groups.length) setErr('没有读到群聊：协议端可能还没连上');
    }).catch((e) => { setGroups([]); setErr((e as Error)?.message ?? String(e)); });
  }, []);

  useEffect(() => {
    if (!gid) return;
    setMembers(null); setSel([]); setQ(''); setErr('');
    get(`/api/groups/${encodeURIComponent(gid)}/members`)
      .then((d: { members: Member[] }) => setMembers(d.members))
      .catch((e) => { setMembers([]); setErr((e as Error)?.message ?? String(e)); });
  }, [gid]);

  const key = q.trim().toLowerCase();
  const list = (members ?? []).filter((m) => !key
    || `${m.card ?? ''} ${m.nickname} ${m.userId}`.toLowerCase().includes(key));
  const toggle = (id: string) => setSel((xs) => xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]);
  const opts: PillOpt[] = (groups ?? []).map((g) => ({
    v: g.groupId,
    t: `${g.name || '未命名群'}${g.memberCount ? `（${g.memberCount}）` : ''}`,
  }));

  return (
    <Modal title="从群聊添加用户" onClose={onClose}>
      <div className="perm-pick">
        <PillSelect align="left" value={gid} options={opts} label="群聊" onChange={setGid} />
        <BrandInput value={q} placeholder="筛选成员" spellCheck={false} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="mset-models perm-members">
        {members === null ? <div className="mset-group-e">{err || '读取中…'}</div>
          : list.length ? list.map((m) => {
            const has = blocked.has(m.userId);
            const on = sel.includes(m.userId);
            return (
              <button key={m.userId} disabled={has}
                className={'mset-mrow perm-row' + (on ? ' on' : '')}
                title={has ? '已经在名单里' : undefined}
                onClick={() => { if (!has) toggle(m.userId); }}>
                <span className="ic"><Icon name={on ? 'check' : has ? 'personas' : 'plus'} size={14} /></span>
                <FadeName className="perm-row-nm" text={m.card || m.nickname || m.userId} />
                <span className="perm-row-qq mono">{m.userId}</span>
                {has && <span className="mset-badge">已有</span>}
              </button>
            );
          }) : <div className="mset-group-e">{err ? '读取失败' : '这个群没有可添加的成员'}</div>}
      </div>

      <div className="perm-pick perm-pick-foot">
        <button className="mset-link" onClick={() => setSel(list.filter((m) => !blocked.has(m.userId)).map((m) => m.userId))}>全选</button>
        <button className="mset-link" onClick={() => setSel([])}>清空</button>
        <span className="plg-hint">已选 {sel.length} 人</span>
        <button className="btn primary" style={{ marginLeft: 'auto' }} disabled={!sel.length}
          onClick={() => onAdd(sel)}>添加</button>
      </div>
      {err && members !== null && <div className="mset-err">{err}</div>}
    </Modal>
  );
}
