'use client';
/** 工作：左列表（环境 / 正在执行 / 历史）+ 右详情（模型链与容器，或单次任务的结论与步骤） */
import { useCallback, useEffect, useState } from 'react';
import { get, post, onEvent, fmtDT } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';

interface WorkRun {
  id: string; chatKey: string; task: string; model: string; ok: boolean; summary: string;
  error?: string; rounds: number; toolCalls: number; durationMs: number; artifacts: string[];
  startedAt: number; steps: string[];
}
interface WorkApi {
  runs: WorkRun[];
  models: { chat: string; work: string; split: boolean };
  maxToolRounds: { chat: number; work: string };
  containers: { kind: string; chat: string; id: string; idleMs: number }[];
  images: { python?: string; browser?: string };
  docker: boolean;
}
interface LiveRun { id: string; chatKey: string; task: string; model: string; trigger: string; steps: string[] }

const ENV = '__env__';

export default function WorkPage({ cmd }: { cmd?: PageCmd }) {
  const [data, setData] = useState<WorkApi | null>(null);
  const [live, setLive] = useState<LiveRun[]>([]);
  const [sel, setSel] = useState(ENV);

  const reload = useCallback(() => {
    get('/api/work').then((d: WorkApi) => setData(d)).catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    const offStart = onEvent('work.start', (d: any) => {
      setLive((prev) => [{ id: d.id, chatKey: d.chatKey, task: d.task, model: d.model, trigger: d.trigger, steps: [] }, ...prev.filter((r) => r.id !== d.id)]);
    });
    const offStep = onEvent('work.step', (d: any) => {
      setLive((prev) => prev.map((r) => (r.id === d.id ? { ...r, steps: [...r.steps, d.step] } : r)));
    });
    const offDone = onEvent('work.done', (d: any) => { setLive((prev) => prev.filter((r) => r.id !== d.id)); reload(); });
    const offErr = onEvent('work.error', (d: any) => { setLive((prev) => prev.filter((r) => r.id !== d.id)); reload(); });
    const t = setInterval(reload, 8000);
    return () => { offStart(); offStep(); offDone(); offErr(); clearInterval(t); };
  }, [reload]);

  usePageCmd('work', cmd, () => reload());

  const runs = data?.runs ?? [];
  const lr = live.find((r) => r.id === sel);
  const hr = !lr && sel !== ENV ? runs.find((r) => r.id === sel) : undefined;

  return (
    <div>
      <div className="mset-body">
        <aside className="mset-list">
          <div className="mset-group">
            <div className="mset-group-t">环境</div>
            <button className={'mset-item' + (sel === ENV ? ' sel' : '')} onClick={() => setSel(ENV)}>
              <span className="mset-item-ic"><Icon name="models" size={15} /></span>
              <span className="mset-item-nm">运行环境</span>
              {data && !data.docker && <i className="dot plg-dot-err" />}
            </button>
          </div>

          {live.length > 0 && (
            <div className="mset-group">
              <div className="mset-group-t">正在执行（{live.length}）</div>
              {live.map((r) => (
                <button key={r.id} className={'mset-item' + (r.id === sel ? ' sel' : '')} onClick={() => setSel(r.id)} title={r.task}>
                  <span className="mset-item-ic"><Icon name="work" size={15} /></span>
                  <span className="mset-item-nm">{r.chatKey}</span>
                  <i className="dot dot-on" />
                </button>
              ))}
            </div>
          )}

          <div className="mset-group">
            <div className="mset-group-t">历史（{runs.length}）</div>
            {runs.map((r) => (
              <button key={r.id} className={'mset-item' + (r.id === sel ? ' sel' : '')} onClick={() => setSel(r.id)} title={r.task}>
                <span className="mset-item-ic"><Icon name="work" size={15} /></span>
                <span className="mset-item-nm">{r.task}</span>
                {!r.ok && <i className="dot plg-dot-err" />}
              </button>
            ))}
            {!runs.length && <div className="mset-group-e">还没有工作任务</div>}
          </div>
        </aside>

        {lr ? <RunDetail r={{ ...lr, live: true }} />
          : hr ? <RunDetail r={{ ...hr, live: false }} />
          : <EnvDetail data={data} onReload={reload} />}
      </div>
    </div>
  );
}

type View = (LiveRun & { live: true }) | (WorkRun & { live: false });

function RunDetail({ r }: { r: View }) {
  return (
    <section className="mset-detail">
      <div className="mset-dhead">
        <span className="mset-dic"><Icon name="work" size={17} /></span>
        <h2 className="mset-dtitle">{r.live ? '正在执行' : r.ok ? '已完成' : '失败'}</h2>
        <span className="plg-ver mono">{r.chatKey}</span>
      </div>

      <div className="wk-task">{r.task}</div>

      <div className="mset-meta">
        <span className="tag mono">{r.model}</span>
        {!r.live && <span className="tag accent">{r.rounds} 轮 · {r.toolCalls} 工具</span>}
        {!r.live && <span className="tag">{(r.durationMs / 1000).toFixed(1)}s</span>}
        {!r.live && <span className="tag mono">{fmtDT(r.startedAt)}</span>}
        {r.live && <span className="tag mono">{r.trigger === 'command' ? '/work' : r.trigger}</span>}
      </div>

      {!r.live && !r.ok && r.error && (
        <>
          <div className="mset-sec-h"><span>错误</span></div>
          <pre className="plg-msg">{String(r.error)}</pre>
        </>
      )}
      {!r.live && r.summary && (
        <>
          <div className="mset-sec-h"><span>结论</span></div>
          <pre className="plg-msg">{r.summary}</pre>
        </>
      )}
      {!r.live && r.artifacts?.length > 0 && (
        <>
          <div className="mset-sec-h"><span>产物</span></div>
          <div className="mset-models">
            {r.artifacts.map((a) => <div key={a} className="mset-mrow"><span className="plg-v mono">{a}</span></div>)}
          </div>
        </>
      )}

      <div className="mset-sec-h">
        <span>执行步骤</span>
        <span className="plg-sec-r plg-hint">{r.steps.length} 步</span>
      </div>
      <pre className="plg-stack mono">{r.steps.slice(-60).join('\n') || (r.live ? '等待模型响应…' : '（无）')}</pre>
    </section>
  );
}

function EnvDetail({ data, onReload }: { data: WorkApi | null; onReload: () => void }) {
  const reset = async (chat: string) => { await post('/api/work/reset', { chatKey: chat }); onReload(); };
  const m = data?.models;
  return (
    <section className="mset-detail">
      <div className="mset-dhead">
        <span className="mset-dic"><Icon name="models" size={17} /></span>
        <h2 className="mset-dtitle">运行环境</h2>
      </div>

      <div className="mset-meta">
        <span className={'tag' + (data && !data.docker ? ' warn' : '')}>Docker {data?.docker ? '就绪' : '不可用'}</span>
        <span className="tag mono">Python {data?.images?.python ?? '—'}</span>
        <span className="tag mono">浏览器 {data?.images?.browser ?? '—'}</span>
        <span className="tag">轮次预算 chat {data?.maxToolRounds.chat ?? '—'} / work 无上限</span>
      </div>

      <div className="mset-sec-h"><span>模型链</span></div>
      <div className="mset-models">
        <div className="mset-mrow"><span className="plg-k">chat</span><span className="plg-v mono">{m?.chat ?? '—'}</span></div>
        <div className="mset-mrow">
          <span className="plg-k">work</span>
          <span className="plg-v mono">{m?.work ?? '—'}</span>
          {m && !m.split && <span className="mset-badge">跟随 chat</span>}
        </div>
      </div>

      <div className="mset-sec-h"><span>常驻会话容器</span></div>
      <div className="mset-models">
        {data?.containers.length ? data.containers.map((c, i) => (
          <div key={i} className="mset-mrow">
            <span className="plg-k">{c.kind === 'compute' ? 'Python' : '浏览器'}</span>
            <span className="plg-v mono">{c.chat}</span>
            <span className="mset-badge">{Math.round(c.idleMs / 1000)}s</span>
            <span className="mset-macts">
              <button className="mset-ibtn" title="回收" onClick={() => void reset(c.chat)}><Icon name="trash" size={14} /></button>
            </span>
          </div>
        )) : <div className="mset-group-e">当前没有常驻容器</div>}
      </div>
    </section>
  );
}
