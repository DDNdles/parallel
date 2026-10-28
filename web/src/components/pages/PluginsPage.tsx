'use client';
import { FadeName } from '@/components/FadeName';
/** 插件管理：左列表（按归属分组，行内只放图标 + 名字 + 状态点）+ 右详情页
 *  （归属与权限 / 能力 / 分群开关）。可配置项已整体挪到「设置」页各分节（2026-10-28 用户定），
 *  简介也不再展示。外壳与「模型」页共用 mset-* 一套类。 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { Modal, Switch } from '@/components/Modal';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';

interface PluginInfo {
  id: string; name: string; version: string; description: string; category: string; trust: string;
  permissions: string[]; core: boolean; locked: boolean; state: string; source: string;
  tools: string[]; groupStates: { chatId: string; enabled: boolean }[];
  defaultGroupState: string; globalDefault: boolean; globalDefaultOverridden: boolean; hasMcp: boolean;
}
interface ChatInfo { chatKey: string; chatId: string; chatType: string; lastTs: number }

const TRUST: Record<string, string> = { builtin: '内置', example: '示例', user: '用户自建' };

export default function PluginsPage({ cmd }: { cmd?: PageCmd }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [chats, setChats] = useState<string[]>([]);
  const [sel, setSel] = useState('');
  const [matrix, setMatrix] = useState(false);

  const reload = useCallback(() => {
    Promise.all([get('/api/plugins') as Promise<PluginInfo[]>, get('/api/chats') as Promise<ChatInfo[]>])
      .then(([ps, cs]) => {
        setPlugins(ps);
        setChats([...new Set(cs.map((c) => c.chatId))]);
        setSel((s) => (s && ps.some((p) => p.id === s) ? s : ps[0]?.id ?? ''));
      })
      .catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const install = useCallback(() => {
    post('/api/plugins/install')
      .then((r: { installed?: string[] }) => {
        reload();
      })
      .catch(() => {});
  }, [reload]);

  usePageCmd('plugins', cmd, (kind) => {
    if (kind === 'install') install();
    else if (kind === 'matrix') setMatrix((v) => !v);
    else reload();
  });

  const cur = plugins.find((p) => p.id === sel) ?? plugins[0];
  const groups = ['builtin', 'example', 'user']
    .map((t) => ({ t, list: plugins.filter((p) => p.trust === t) }))
    .filter((g) => g.list.length);

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          {groups.map((g) => (
            <div className="mset-group" key={g.t}>
              <div className="mset-group-t">{TRUST[g.t]}</div>
              {g.list.map((p) => (
                <button key={p.id} className={'mset-item' + (p.id === cur?.id ? ' sel' : '')}
                  onClick={() => setSel(p.id)} title={p.name}>
                  <span className="mset-item-ic"><Icon name="plugins" size={15} /></span>
                  <FadeName text={p.name} />
                  <i className={p.state === 'loaded' ? 'dot dot-on' : p.state === 'error' ? 'dot plg-dot-err' : 'dot mset-dot-off'} />
                </button>
              ))}
            </div>
          ))}
          {!plugins.length && <div className="mset-group-e">没有载入的插件</div>}
        </aside>

        {cur && <PluginDetail key={cur.id} p={cur} chats={chats} onChanged={reload} />}
      </div>

      {matrix && (
        <MatrixModal plugins={plugins} chats={chats} onClose={() => setMatrix(false)} onChanged={reload} />
      )}
    </div>
  );
}

function PluginDetail({ p, chats, onChanged }: { p: PluginInfo; chats: string[]; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  /** 本页写入失败就地报红（全站不用 toast） */
  const [saveErr, setSaveErr] = useState('');

  const run = (fn: () => Promise<unknown>) => async () => {
    try { await fn(); setSaveErr(''); setTimeout(onChanged, 300); }
    catch (e) { setSaveErr(`未保存：${(e as Error)?.message ?? String(e)}`); }
  };

  const loaded = p.state === 'loaded';
  const err = p.state === 'error';

  return (
    <section className="mset-detail">
      <div className="mset-dhead">
        <span className="mset-dic"><Icon name="plugins" size={17} /></span>
        <h2 className="mset-dtitle">{p.name}</h2>
        <span className="plg-ver mono">v{p.version}</span>
        {!loaded && <span className={'tag ' + (err ? 'err' : 'warn')}>{err ? '错误' : '已停用'}</span>}
        <div className="mset-dright">
          <Switch on={loaded} title={loaded ? '点击停用' : '点击启用'}
            onChange={run(() => post(`/api/plugins/${p.id}/${loaded ? 'disable' : 'enable'}`))} />
          <div className="mset-menu-wrap">
            <button className={'mset-ibtn' + (menu ? ' on' : '')} onClick={() => setMenu((v) => !v)} title="更多" aria-label="更多操作">
              <Icon name="dots" size={16} />
            </button>
            {menu && (
              <>
                <div className="mset-scrim" onClick={() => setMenu(false)} />
                <div className="mset-menu">
                  <button onClick={() => { setMenu(false); void run(() => post(`/api/plugins/${p.id}/reload`))(); }}>重载</button>
                  {p.globalDefaultOverridden && (
                    <button onClick={() => { setMenu(false); void run(
                      () => post(`/api/plugins/${p.id}/global-default`, { enabled: p.defaultGroupState === 'on' }))(); }}>
                      恢复 manifest 默认
                    </button>
                  )}
                  {p.source === 'user' && (
                    <button className="danger" onClick={() => {
                      setMenu(false);
                      if (confirm(`卸载插件 ${p.name}？其持久化状态将被清除。`)) {
                        void run(() => del(`/api/plugins/${p.id}/uninstall`))();
                      }
                    }}>卸载插件</button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {saveErr && <div className="mset-err">{saveErr}</div>}

      <div className="mset-meta">
        <span className="tag accent">{p.category}</span>
        <span className={'tag' + (p.trust === 'user' ? ' warn' : '')}>{TRUST[p.trust]}</span>
        {p.core && <span className="tag">core</span>}
        {p.locked && <span className="tag">仅主人可操作</span>}
        {p.hasMcp && <span className="tag">MCP</span>}
        {p.permissions.map((x) => <span key={x} className="tag mono">{x}</span>)}
      </div>

      <div className="mset-sec-h"><span>能力</span></div>
      <div className="mset-models">
        <div className="mset-mrow">
          <span className="plg-k">工具</span>
          <span className="plg-v mono">{p.tools.length ? p.tools.join(' · ') : '无'}</span>
        </div>
        <div className="mset-mrow">
          <span className="plg-k">来源</span>
          <span className="plg-v mono">{p.id} · {p.source}</span>
        </div>
      </div>

      <div className="mset-sec-h">
        <span>分群开关</span>
        <span className="plg-sec-r">
          <span className="plg-hint">全局默认</span>
          <Switch on={p.globalDefault} title="新群 / 未覆盖群的默认状态"
            onChange={run(() => post(`/api/plugins/${p.id}/global-default`, { enabled: !p.globalDefault }))} />
        </span>
      </div>
      <div className="mset-models">
        {chats.length === 0 && <div className="mset-group-e">还没有会话记录，收到过消息的群会出现在这里</div>}
        {chats.map((c) => {
          const st = p.groupStates.find((s) => s.chatId === c);
          const on = st ? st.enabled : p.globalDefault;
          return (
            <div key={c} className="mset-mrow">
              <span className="plg-chat mono">{c}</span>
              <span className="mset-badge">{st ? '已覆盖' : '跟随默认'}</span>
              <span className="mset-macts">
                <Switch on={on} title={st ? '该群的开关' : '改动会为这个群写入覆盖'}
                  onChange={run(() => post(`/api/plugins/${p.id}/group-state`, { chatId: c, enabled: !on }))} />
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** 分群开关矩阵：插件 × 群，一屏看全并直接改 */
function MatrixModal({ plugins, chats, onClose, onChanged }: {
  plugins: PluginInfo[]; chats: string[]; onClose: () => void; onChanged: () => void;
}) {
  const rows = plugins.filter((p) => !p.core);
  const [saveErr, setSaveErr] = useState('');
  const flip = async (pid: string, chatId: string, enabled: boolean) => {
    try { await post(`/api/plugins/${pid}/group-state`, { chatId, enabled }); setSaveErr(''); onChanged(); }
    catch (e) { setSaveErr(`未保存：${(e as Error)?.message ?? String(e)}`); }
  };
  return (
    <Modal title="分群开关矩阵" wide onClose={onClose}>
      {saveErr && <div className="mset-err">{saveErr}</div>}
      {!chats.length ? (
        <div className="mset-group-e">还没有任何群的开关记录。等该群来一条消息后，就能在这里为它单独开关。</div>
      ) : (
        <>
          <div className="matrix">
            <table className="table">
              <thead><tr><th>插件</th>{chats.map((c) => <th key={c} className="mono">{c}</th>)}</tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name} <span className="muted mono">{p.id}</span></td>
                    {chats.map((c) => {
                      const st = p.groupStates.find((s) => s.chatId === c);
                      const on = st ? st.enabled : p.globalDefault;
                      return (
                        <td key={c}>
                          <Switch on={on} title={st ? '该群的开关' : '跟随全局默认，改动会写入覆盖'}
                            onChange={() => void flip(p.id, c, !on)} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
