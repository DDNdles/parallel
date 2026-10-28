'use client';
/** 设置 → 语气学习：只列学到的说法，按群切换；可手动补一条、可删。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post } from '@/lib/api';
import { BrandInput } from '@/components/BrandInput';
import { PillSelect, type PillOpt } from '@/components/PillSelect';
import { Icon } from '@/components/Icon';

interface Group { groupId: string; name?: string; memberCount?: number }
interface Learned { style: string; at?: number }
interface ExpressionsResp { groups: { chatKey: string; entries: Learned[] }[] }

export function VoiceLearningPanel() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [store, setStore] = useState<Record<string, Learned[]>>({});
  const [chatKey, setChatKey] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, e] = await Promise.all([
        get('/api/groups').catch(() => ({ groups: [] })),
        get('/api/plugin/chat/expressions'),
      ]);
      setGroups(Array.isArray(g?.groups) ? g.groups : []);
      const next: Record<string, Learned[]> = {};
      for (const item of (e?.groups ?? []) as ExpressionsResp['groups']) {
        if (item?.chatKey) next[item.chatKey] = Array.isArray(item.entries) ? item.entries : [];
      }
      setStore(next);
      setChatKey((cur) => (cur && Object.prototype.hasOwnProperty.call(next, cur))
        ? cur
        : (Object.entries(next).find(([, list]) => list.length > 0)?.[0] ?? ''));
      setErr('');
    } catch (e) {
      setErr(`读取失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const opts = useMemo<PillOpt[]>(() => {
    const out: PillOpt[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
      const key = `group_${g.groupId}`;
      out.push({ v: key, t: g.name || `群${g.groupId}` });
      seen.add(key);
    }
    for (const key of Object.keys(store)) {
      if (seen.has(key)) continue;
      out.push({ v: key, t: key.replace(/^group_/, '群') });
    }
    return out;
  }, [groups, store]);

  // 选中的群被删掉/列表还没回来时，优先落到第一个已学到词的群；都为空才用第一项
  const learnedKey = useMemo(
    () => Object.entries(store).find(([, list]) => Array.isArray(list) && list.length > 0)?.[0] ?? '',
    [store],
  );
  useEffect(() => {
    if (opts.length && !opts.some((o) => o.v === chatKey)) {
      setChatKey(learnedKey && opts.some((o) => o.v === learnedKey) ? learnedKey : opts[0].v);
    }
  }, [chatKey, opts, learnedKey]);

  const entries = useMemo(
    () => [...(store[chatKey] ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
    [store, chatKey],
  );

  const add = async () => {
    const style = text.trim();
    if (!style || !chatKey || busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await post('/api/plugin/chat/expressions', { action: 'add', chatKey, style });
      setStore((s) => ({ ...s, [chatKey]: Array.isArray(r?.entries) ? r.entries : [] }));
      setText('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: Learned) => {
    if (!chatKey || busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await post('/api/plugin/chat/expressions', { action: 'delete', chatKey, style: entry.style, at: entry.at });
      const next = Array.isArray(r?.entries) ? r.entries : [];
      setStore((s) => {
        const out = { ...s };
        if (next.length) out[chatKey] = next;
        else delete out[chatKey];
        return out;
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="mset-empty">读取中…</div>;

  return (
    <>
      <div className="mset-sec-h"><span>词表</span></div>

      <div className="mset-field">
        <label className="mset-flabel">群</label>
        <PillSelect value={chatKey} options={opts} onChange={setChatKey} label="选择群" align="left" portal />
      </div>

      <div className="mset-field">
        <label className="mset-flabel">新增</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BrandInput
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="群友的说法，最多 40 字"
            style={{ flex: '1 1 auto', minWidth: 0 }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
          />
          <button className="mset-add" style={{ marginLeft: 0, flex: 'none' }}
            disabled={busy || !text.trim()} onClick={() => void add()}>
            <Icon name="plus" size={13} />添加
          </button>
        </div>
      </div>

      {err && <div className="mset-err">{err}</div>}

      <div className="mset-sec-h"><span>已学 {entries.length} 条</span></div>
      {entries.length ? (
        <div className="mset-models">
          {entries.map((e, i) => (
            <div className="mset-mrow" key={`${e.at ?? 0}-${e.style}-${i}`}>
              <span className="plg-v">{e.style}</span>
              <span className="mset-macts">
                <button className="mset-ibtn" title="删除" aria-label={`删除 ${e.style}`}
                  disabled={busy} onClick={() => void remove(e)}>
                  <Icon name="trash" size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        /* 空态不套带边框的列表容器：一条短句撑满整栏会变成一张巨大的空卡片 */
        <div className="mset-empty">这个群还没学到说法</div>
      )}
    </>
  );
}
