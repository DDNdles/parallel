'use client';
/** 报错：左列表（按级别分组）+ 右详情（内容 / 堆栈 / 建议 / 处置） */
import { useCallback, useEffect, useState } from 'react';
import { get, post, fmtDT, onEvent } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';

interface ErrItem {
  level: 'info' | 'warn' | 'error'; category: string; pluginId?: string; message: string;
  stack?: string; suggestion?: string; count: number; lastTs: number;
}

const LEVELS: { v: ErrItem['level']; t: string }[] = [
  { v: 'error', t: '错误' }, { v: 'warn', t: '警告' }, { v: 'info', t: '提示' },
];

export default function ErrorsPage({ cmd }: { cmd?: PageCmd }) {
  const [errors, setErrors] = useState<ErrItem[]>([]);
  const [sel, setSel] = useState(0);

  const reload = useCallback(() => { get('/api/errors').then(setErrors).catch(() => {}); }, []);
  useEffect(() => {
    reload();
    return onEvent('error.recorded', reload);
  }, [reload]);

  const clear = useCallback(() => {
    if (!confirm('清除全部报错记录？')) return;
    post('/api/errors/clear').then(() => { setErrors([]); setSel(0); }).catch(() => {});
  }, []);

  usePageCmd('errors', cmd, (kind) => { if (kind === 'clear') clear(); else reload(); });

  /** 稳定顺序：按级别分组排列，选中项按内容键跟随 */
  const ordered = LEVELS.flatMap((l) => errors.filter((e) => e.level === l.v));
  const keyOf = (e: ErrItem) => `${e.level}|${e.category}|${e.pluginId ?? ''}|${e.message}`;
  const cur = ordered[sel] ?? ordered[0];

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          {LEVELS.map((l) => {
            const list = ordered.filter((e) => e.level === l.v);
            if (!list.length) return null;
            return (
              <div className="mset-group" key={l.v}>
                <div className="mset-group-t">{l.t}</div>
                {list.map((e) => (
                  <button key={keyOf(e)} className={'mset-item' + (cur && keyOf(e) === keyOf(cur) ? ' sel' : '')}
                    onClick={() => setSel(ordered.indexOf(e))} title={e.message.split('\n')[0]}>
                    <span className="mset-item-ic"><Icon name={l.v === 'info' ? 'check' : 'warn'} size={15} /></span>
                    <span className="mset-item-nm">{e.category}{e.pluginId ? ` · ${e.pluginId}` : ''}</span>
                    {e.count > 1 && <span className="mset-badge">×{e.count}</span>}
                  </button>
                ))}
              </div>
            );
          })}
          {!ordered.length && <div className="mset-group-e">没有错误记录</div>}
        </aside>

        {cur ? <ErrDetail e={cur} onReload={reload} />
          : <div className="mset-detail mset-empty">没有错误记录</div>}
      </div>
    </div>
  );
}

function ErrDetail({ e, onReload }: { e: ErrItem; onReload: () => void }) {
  const lv = LEVELS.find((l) => l.v === e.level);
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); onReload(); }
    catch { /* 失败不弹提示 */ }
  };
  return (
    <section className="mset-detail">
      <div className="mset-dhead">
        <span className="mset-dic"><Icon name={e.level === 'info' ? 'check' : 'warn'} size={17} /></span>
        <h2 className="mset-dtitle">{lv?.t ?? e.level}</h2>
        <div className="mset-dright">
          {e.pluginId && <button className="mset-add" onClick={() => act(() => post(`/api/plugins/${e.pluginId}/reload`))}>重载插件</button>}
          {e.category === 'adapter' && <span className="mset-badge">等待重连</span>}
        </div>
      </div>

      <div className="mset-meta">
        <span className={'tag ' + (e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : '')}>{e.level}</span>
        <span className="tag accent">{e.category}</span>
        {e.pluginId && <span className="tag mono">{e.pluginId}</span>}
        <span className="tag">×{e.count}</span>
      </div>

      <div className="mset-sec-h"><span>内容</span></div>
      <pre className="plg-msg">{e.message}</pre>

      <div className="mset-sec-h"><span>最近发生</span><span className="plg-sec-r plg-hint">{fmtDT(e.lastTs)}</span></div>

      {e.suggestion && (
        <>
          <div className="mset-sec-h"><span>建议</span></div>
          <p className="plg-desc">{e.suggestion}</p>
        </>
      )}
      {e.stack && (
        <>
          <div className="mset-sec-h"><span>堆栈</span></div>
          <pre className="plg-stack mono">{e.stack}</pre>
        </>
      )}
    </section>
  );
}
