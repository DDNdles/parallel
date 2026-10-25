'use client';
/** 唱歌：左「服务状态 + 试唱」+ 右生成记录（行内试听 / 补发）。设置表单在插件页，这里不重复；
 *  状态与记录进页拉一次 + 生成动作后刷新，不长轮询；失败一律就地红字（全站不用 toast）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, getBlob, fmtDT } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { BrandInput } from '@/components/BrandInput';
import { PillSelect } from '@/components/PillSelect';
import Hint from '@/components/Hint';

interface SingRecord {
  id: string; ts: number; userId: string; chatId: string;
  seconds: number; provider: string; file: string; mime: string;
}
interface SingError { ts: number; chatId: string; error: string }
interface SingStatus {
  provider: string; voiceIdSet: boolean; lastGenerationAt: number | null;
  today: { userId: string; count: number };
}

const OFF = '插件未启用，可在插件页开启';
const CHAT_ID_RE = /^\d{5,12}$/;
const SEND_TYPES = [{ v: 'group', t: '群' }, { v: 'private', t: '私聊' }];
/** 秒 → m:ss（与会话页语音条同款） */
const mmss = (s: number) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
const isToday = (ts: number) => new Date(ts).toDateString() === new Date().toDateString();

/** 自制试听条（与会话页 AudioRow 同一配方）：浏览器自带控件不是黑白的。
 *  字节走 getBlob 带 token 拿 objectURL（/audio 要 x-auth-token，直挂 src 进不去），卸载即回收。 */
function SingAudio({ id, autoStart }: { id: string; autoStart?: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef('');
  const [dead, setDead] = useState('');
  const [on, setOn] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const play = useCallback(async () => {
    try {
      if (!urlRef.current) {
        const b = await getBlob(`/api/plugin/sing/audio?id=${encodeURIComponent(id)}`);
        urlRef.current = URL.createObjectURL(b);
      }
    } catch (e) { setDead(`音频取不到了（产物只留 24 小时）：${(e as Error).message}`); return; }
    const a = audioRef.current;
    if (!a) return;
    if (!a.src) a.src = urlRef.current;
    // 试唱成功后的自动播可能被浏览器的自动播放策略挡下：不算坏，用户自己点一下就行
    try { await a.play(); setOn(true); } catch { /* ignore */ }
  }, [id]);
  useEffect(() => { if (autoStart) void play(); }, [autoStart, play]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void play();
    else { a.pause(); setOn(false); }
  };
  const seek = (e: React.MouseEvent<HTMLSpanElement>) => {
    const a = audioRef.current;
    if (!a || !dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * dur;
    setT(a.currentTime);
  };

  if (dead) return <div className="mset-err">{dead}</div>;
  return (
    <div className="media-audio sing-audio">
      <audio ref={audioRef} preload="none" onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onEnded={() => setOn(false)} />
      <button type="button" className="media-play" onClick={toggle} aria-label={on ? '暂停' : '播放'}>
        <Icon name={on ? 'pause' : 'play'} size={13} />
      </button>
      <span className="media-bar" onClick={seek}>
        <span className="media-bar-f" style={{ width: `${dur ? Math.min(100, (t / dur) * 100) : 0}%` }} />
      </span>
      <span className="media-dur">{mmss(dur || t)}</span>
    </div>
  );
}

interface SendBox { id: string; type: string; chatId: string; busy: boolean; err: string; done: boolean }

export default function SingPage() {
  const [off, setOff] = useState<string | null>(null);
  const [status, setStatus] = useState<SingStatus | null>(null);
  const [records, setRecords] = useState<SingRecord[]>([]);
  const [lastErrors, setLastErrors] = useState<SingError[]>([]);
  // —— 试唱卡 ——
  const [lyrics, setLyrics] = useState('');
  const [tags, setTags] = useState('');
  const [seconds, setSeconds] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState('');
  // —— 右栏行内展开：试听（auto = 试唱成功后自动播）与补发表单，各只开一条 ——
  const [play, setPlay] = useState<{ id: string; auto: boolean } | null>(null);
  const [send, setSend] = useState<SendBox | null>(null);

  const reload = useCallback(() => Promise.all([
    get('/api/plugin/sing/status').catch(() => null),
    get('/api/plugin/sing/records').catch(() => null),
  ]).then(([s, r]: [SingStatus & { ok?: boolean } | null, { ok?: boolean; records?: SingRecord[]; lastErrors?: SingError[] } | null]) => {
    // null = 请求本身没回来（网络/内核忙）：这跟「插件停用」不是一回事，文案分开、都能重试
    if (!s || !r) { setOff('状态没拉到（内核可能正忙或刚重启）'); return; }
    if (s.ok === false || r.ok === false) { setOff(OFF); return; }
    setOff('');
    setStatus(s);
    setRecords(r.records ?? []);
    setLastErrors(r.lastErrors ?? []);
  }), []);
  useEffect(() => { void reload(); }, [reload]);

  const audition = async () => {
    if (!lyrics.trim() || busy) return;
    setBusy(true);
    setPreviewErr('');
    try {
      const r = await post('/api/plugin/sing/preview', {
        lyrics: lyrics.trim(),
        ...(tags.trim() ? { tags: tags.trim() } : {}),
        ...(seconds.trim() ? { seconds: Number(seconds) } : {}),
      }) as { ok?: boolean; id?: string; error?: string };
      if (r.ok === false) throw new Error(r.error || '试唱失败');
      await reload();
      if (r.id) setPlay({ id: r.id, auto: true });
    } catch (e) {
      setPreviewErr((e as Error)?.message ?? String(e));
    } finally { setBusy(false); }
  };

  const doSend = async () => {
    if (!send || send.busy || !CHAT_ID_RE.test(send.chatId.trim())) return;
    setSend((s) => (s ? { ...s, busy: true, err: '' } : s));
    try {
      await post('/api/plugin/sing/send', { id: send.id, type: send.type, chatId: send.chatId.trim() });
      setSend((s) => (s ? { ...s, busy: false, done: true } : s));
    } catch (e) {
      setSend((s) => (s ? { ...s, busy: false, err: (e as Error).message } : s));
    }
  };

  if (off) return (
    <div className="mset-body"><div className="mset-detail"><div className="mset-empty">
      {off}
      <div style={{ marginTop: 12 }}>
        <button className="mset-add" onClick={() => { setOff(null); void reload(); }}><Icon name="refresh" size={13} /> 重试</button>
      </div>
    </div></div></div>
  );

  const todayCount = records.filter((r) => isToday(r.ts)).length;
  return (
    <div className="mset-body">
      <aside className="mset-list sing-list">
        <div className="mset-group">
          <div className="mset-group-t">服务状态</div>
          <div className="sing-kv">
            <span>供应商</span>
            <b className="mono" title={status?.provider ?? ''}>{status?.provider ?? '—'}</b>
          </div>
          <div className="sing-kv">
            <span>音色</span>
            <b>{status?.voiceIdSet ? <span className="tag ok">已配</span> : <span className="tag warn">未配</span>}</b>
            <Hint text="refAudio / voiceId 在插件页配" />
          </div>
          <div className="sing-kv">
            <span>上次生成</span>
            <b className="mono">{status?.lastGenerationAt ? fmtDT(status.lastGenerationAt) : '—'}</b>
          </div>
          <div className="sing-kv">
            <span>今日</span>
            <b>{todayCount} 首</b>
          </div>
          {lastErrors.length > 0 && (
            <div className="sing-kv" style={{ display: 'block' }}>
              <span>最近失败</span>
              {lastErrors.slice(0, 3).map((e, i) => (
                <div key={i} className="mset-err" style={{ marginTop: 4, whiteSpace: 'normal' }}>
                  <span className="mono">{fmtDT(e.ts)}</span> · {e.error}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mset-group">
          <div className="mset-group-t">试唱</div>
          <div className="sing-field">
            <BrandInput multiline grow rows={4} value={lyrics} placeholder="歌词，可带 [verse]/[chorus]"
              onChange={(e) => setLyrics(String(e.target.value))} />
          </div>
          <div className="sing-field">
            <span className="mset-flabel">风格 <Hint text="留空用默认可爱流行" /></span>
            <BrandInput value={tags} placeholder="tags，如 pop, 120bpm" spellCheck={false}
              onChange={(e) => setTags(String(e.target.value))} />
          </div>
          <div className="sing-field">
            <span className="mset-flabel">秒数 <Hint text="部分供应商按歌词长短自动决定" /></span>
            <BrandInput type="number" value={seconds} placeholder="时长（秒）"
              onChange={(e) => setSeconds(String(e.target.value))} />
          </div>
          <button className="btn primary sing-go" disabled={!lyrics.trim() || busy} onClick={() => void audition()}>
            {busy ? '生成中…' : '试唱'}
          </button>
          {previewErr && <div className="mset-err">{previewErr}</div>}
        </div>
      </aside>

      <section className="mset-detail">
        <div className="mset-dhead">
          <span className="mset-dic"><Icon name="music" size={17} /></span>
          <h2 className="mset-dtitle">生成记录</h2>
          <div className="mset-dright">
            <span className="plg-hint">{records.length} 条</span>
            <button className="mset-add" onClick={() => void reload()}><Icon name="refresh" size={13} /> 刷新</button>
          </div>
        </div>

        {!records.length && <div className="mset-empty">还没有生成记录，左边试唱一首试试。</div>}
        {records.map((r) => (
          <div className="sing-item" key={r.id}>
            <div className="mset-mrow sing-row" title={`${r.userId} @ ${r.chatId}`}>
              <span className="mono">{fmtDT(r.ts)}</span>
              <span className="sing-user">{r.userId}</span>
              <span className="mset-badge">{r.seconds} 秒</span>
              <span className="sing-prov">{r.provider}</span>
              <span className="mset-macts">
                <button className={'mset-ibtn' + (play?.id === r.id ? ' on' : '')} title="试听"
                  onClick={() => setPlay((p) => (p?.id === r.id ? null : { id: r.id, auto: false }))}>
                  <Icon name="play" size={13} />
                </button>
                <button className={'mset-ibtn' + (send?.id === r.id ? ' on' : '')} title="补发到会话"
                  onClick={() => setSend((s) => (s?.id === r.id ? null : { id: r.id, type: 'group', chatId: '', busy: false, err: '', done: false }))}>
                  <Icon name="send" size={13} />
                </button>
              </span>
            </div>
            {play?.id === r.id && (
              <div className="sing-fold">
                <SingAudio id={r.id} autoStart={play.auto} />
              </div>
            )}
            {send?.id === r.id && (
              <div className="sing-fold">
                {send.done
                  ? <span className="tag ok">已发到 {send.type === 'group' ? '群' : '私聊'} {send.chatId.trim()}</span>
                  : (<>
                    <PillSelect compact align="left" value={send.type} options={SEND_TYPES} label="会话类型"
                      onChange={(v) => setSend((s) => (s ? { ...s, type: v } : s))} />
                    <BrandInput value={send.chatId} placeholder="QQ号/群号" spellCheck={false}
                      onChange={(e) => setSend((s) => (s ? { ...s, chatId: String(e.target.value) } : s))} />
                    <button className="btn primary small" disabled={send.busy || !CHAT_ID_RE.test(send.chatId.trim())} onClick={() => void doSend()}>
                      {send.busy ? '发送中…' : '发送'}
                    </button>
                  </>)}
                {send.err && <div className="mset-err">{send.err}</div>}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
