'use client';
/** 翻唱：左「服务状态 + 试翻」+ 右翻唱记录（行内试听 / 补发）。配置表单在「设置 → 翻唱」，这里不重复；
 *  试翻是异步任务：POST /preview 回 202 后轮询 /job，完成即刷新记录并自动试听；
 *  整首歌 CPU 分离可能要十几分钟，按钮全程显示等待秒数。失败一律就地红字（全站不用 toast）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, getBlob, fmtDT } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { BrandInput } from '@/components/BrandInput';
import { PillSelect } from '@/components/PillSelect';
import Hint from '@/components/Hint';

interface CoverRecord {
  id: string; ts: number; userId: string; chatId: string;
  song: string; artist: string; seconds: number; file: string; mime: string;
}
interface CoverError { ts: number; chatId: string; error: string }
interface CoverStatus {
  baseUrlSet: boolean; cookieSet?: boolean; lastGenerationAt: number | null;
  today: { userId: string; count: number };
}
interface LoginStatus { status: 'idle' | 'running' | 'done' | 'failed'; ts?: number; error?: string }
interface DeskJob {
  ok?: boolean; status: 'running' | 'done' | 'failed'; error?: string; elapsed?: number;
  id?: string; song?: string; artist?: string; seconds?: number;
}

const OFF = '插件未启用，可在插件页开启';
const CHAT_ID_RE = /^\d{5,12}$/;
const SEND_TYPES = [{ v: 'group', t: '群' }, { v: 'private', t: '私聊' }];
/** 秒 → m:ss（与会话页语音条同款） */
const mmss = (s: number) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
/** 等待秒数 → 「3分12秒」 */
const dur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`);

/** 自制试听条（与会话页 AudioRow 同一配方）：浏览器自带控件不是黑白的。
 *  字节走 getBlob 带 token 拿 objectURL（/audio 要 x-auth-token，直挂 src 进不去），卸载即回收。 */
function CoverAudio({ id, autoStart }: { id: string; autoStart?: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef('');
  const [dead, setDead] = useState('');
  const [on, setOn] = useState(false);
  const [t, setT] = useState(0);
  const [durSec, setDurSec] = useState(0);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const play = useCallback(async () => {
    try {
      if (!urlRef.current) {
        const b = await getBlob(`/api/plugin/cover/audio?id=${encodeURIComponent(id)}`);
        urlRef.current = URL.createObjectURL(b);
      }
    } catch (e) { setDead(`音频取不到了（产物只留 24 小时）：${(e as Error).message}`); return; }
    const a = audioRef.current;
    if (!a) return;
    if (!a.src) a.src = urlRef.current;
    // 试翻成功后的自动播可能被浏览器的自动播放策略挡下：不算坏，用户自己点一下就行
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
    if (!a || !durSec) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * durSec;
    setT(a.currentTime);
  };

  if (dead) return <div className="mset-err">{dead}</div>;
  return (
    <div className="media-audio cover-audio">
      <audio ref={audioRef} preload="none" onLoadedMetadata={(e) => setDurSec(e.currentTarget.duration)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onEnded={() => setOn(false)} />
      <button type="button" className="media-play" onClick={toggle} aria-label={on ? '暂停' : '播放'}>
        <Icon name={on ? 'pause' : 'play'} size={13} />
      </button>
      <span className="media-bar" onClick={seek}>
        <span className="media-bar-f" style={{ width: `${durSec ? Math.min(100, (t / durSec) * 100) : 0}%` }} />
      </span>
      <span className="media-dur">{mmss(durSec || t)}</span>
    </div>
  );
}

interface SendBox { id: string; type: string; chatId: string; busy: boolean; err: string; done: boolean }

export default function CoverPage() {
  const [off, setOff] = useState<string | null>(null);
  const [status, setStatus] = useState<CoverStatus | null>(null);
  const [records, setRecords] = useState<CoverRecord[]>([]);
  const [lastErrors, setLastErrors] = useState<CoverError[]>([]);
  // —— 试翻卡（异步任务：提交 → 轮询 → 完成刷新） ——
  const [song, setSong] = useState('');
  const [artist, setArtist] = useState('');
  const [withInst, setWithInst] = useState(true);
  const [job, setJob] = useState<{ id: string; elapsed: number } | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const pollRef = useRef<number | null>(null);
  /** 插件重载/内核重启的瞬间会短暂 404：连续几次才算真丢，别吓人 */
  const lostHits = useRef(0);
  // —— 右栏行内展开：试听（auto = 试翻成功后自动播）与补发表单，各只开一条 ——
  const [play, setPlay] = useState<{ id: string; auto: boolean } | null>(null);
  const [send, setSend] = useState<SendBox | null>(null);
  // —— 107 半自动登录：打开浏览器 → 人过验证码 → 回写 Cookie ——
  const [login, setLogin] = useState<LoginStatus>({ status: 'idle' });
  const [loginErr, setLoginErr] = useState('');

  const reload = useCallback(() => Promise.all([
    get('/api/plugin/cover/status').catch(() => null),
    get('/api/plugin/cover/records').catch(() => null),
  ]).then(([s, r]: [CoverStatus & { ok?: boolean } | null, { ok?: boolean; records?: CoverRecord[]; lastErrors?: CoverError[] } | null]) => {
    // null = 请求本身没回来（网络/内核忙）：这跟「插件停用」不是一回事，文案分开、都能重试
    if (!s || !r) { setOff('状态没拉到（内核可能正忙或刚重启）'); return; }
    if (s.ok === false || r.ok === false) { setOff(OFF); return; }
    setOff('');
    setStatus(s);
    setRecords(r.records ?? []);
    setLastErrors(r.lastErrors ?? []);
  }), []);
  useEffect(() => { void reload(); }, [reload]);

  // 进页面先问一次登录状态（内核重启后状态文件还在）
  useEffect(() => {
    get('/api/plugin/cover/login').then((s) => setLogin(s as LoginStatus)).catch(() => { /* 未登录也能看别的 */ });
  }, []);

  // 登录向导在跑：2 秒看一次；完成/失败就停
  useEffect(() => {
    if (login.status !== 'running') return;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await get('/api/plugin/cover/login') as LoginStatus;
        if (stopped) return;
        setLogin(s);
        if (s.status === 'done') { setLoginErr(''); void reload(); }
        if (s.status === 'failed') setLoginErr(s.error || '登录失败，再试一次');
      } catch { /* 单次拉不到等下一轮 */ }
    };
    const h = window.setInterval(() => void tick(), 2000);
    void tick();
    return () => { stopped = true; window.clearInterval(h); };
  }, [login.status, reload]);

  const startLogin = async () => {
    if (login.status === 'running') return;
    setLoginErr('');
    try {
      const r = await post('/api/plugin/cover/login', {}) as { ok?: boolean; error?: string };
      if (r.ok === false) throw new Error(r.error || '拉起登录向导失败');
      setLogin({ status: 'running', ts: Date.now() });
    } catch (e) {
      setLoginErr((e as Error)?.message ?? String(e));
    }
  };


  // 轮询在途任务：4s 一次；页面刷新丢了句柄也没关系，只是不再显示进度
  useEffect(() => {
    if (!job) return;
    let stopped = false;
    const tick = async () => {
      try {
        const j = await get(`/api/plugin/cover/job?id=${encodeURIComponent(job.id)}`) as DeskJob;
        if (stopped) return;
        lostHits.current = 0;
        if (j.status === 'done') {
          setJob(null);
          await reload();
          if (j.id) setPlay({ id: j.id, auto: true });
          return;
        }
        if (j.status === 'failed') {
          setJob(null);
          setPreviewErr(j.error || '试翻失败');
          await reload();
          return;
        }
        setJob((x) => (x ? { ...x, elapsed: j.elapsed ?? x.elapsed + 4 } : x));
      } catch (e) {
        // 任务句柄丢了（插件重载/内核重启）：短暂 404 先重试，连续 3 次（约 12 秒）才算真丢
        if (/没有这个试翻任务/.test((e as Error).message)) {
          lostHits.current += 1;
          if (lostHits.current < 3) return;
          setJob(null);
          setPreviewErr('试翻任务的进度丢了（服务可能刚重启），完成与否看下面的记录。');
          return;
        }
        if (!stopped) setJob((x) => (x ? { ...x, elapsed: x.elapsed + 4 } : x)); // 单次轮询失败等下一轮
      }
    };
    pollRef.current = window.setInterval(() => void tick(), 4000);
    void tick();
    return () => { stopped = true; if (pollRef.current) window.clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  const audition = async () => {
    if (!song.trim() || job) return;
    setPreviewErr('');
    lostHits.current = 0;
    try {
      const r = await post('/api/plugin/cover/preview', {
        song: song.trim(),
        ...(artist.trim() ? { artist: artist.trim() } : {}),
        withInstrumental: withInst,
      }) as { ok?: boolean; id?: string; error?: string };
      if (r.ok === false) throw new Error(r.error || '提交失败');
      if (r.id) setJob({ id: r.id, elapsed: 0 });
    } catch (e) {
      setPreviewErr((e as Error)?.message ?? String(e));
    }
  };

  const doSend = async () => {
    if (!send || send.busy || !CHAT_ID_RE.test(send.chatId.trim())) return;
    setSend((s) => (s ? { ...s, busy: true, err: '' } : s));
    try {
      await post('/api/plugin/cover/send', { id: send.id, type: send.type, chatId: send.chatId.trim() });
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

  const todayCount = records.filter((r) => r.userId !== 'desktop' && new Date(r.ts).toDateString() === new Date().toDateString()).length;
  return (
    <div className="mset-body">
      <aside className="mset-list cover-list">
        <div className="mset-group">
          <div className="mset-group-t">服务状态</div>
          <div className="cover-kv">
            <span>翻唱服务</span>
            <b>{status?.baseUrlSet ? <span className="tag ok">已配</span> : <span className="tag warn">未配</span>}</b>
            <Hint text="服务地址 / Key / Cookie 在设置 → 翻唱配" />
          </div>
          <div className="cover-kv">
            <span>上次翻唱</span>
            <b className="mono">{status?.lastGenerationAt ? fmtDT(status.lastGenerationAt) : '—'}</b>
          </div>
          <div className="cover-kv">
            <span>今日（成员）</span>
            <b>{todayCount} 首</b>
          </div>
          {lastErrors.length > 0 && (
            <div className="cover-kv" style={{ display: 'block' }}>
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
          <div className="mset-group-t">107 登录</div>
          <div className="cover-kv">
            <span>Cookie</span>
            <b>
              {login.status === 'running' ? <span className="tag warn">等待浏览器登录</span>
                : login.status === 'done' ? <span className="tag ok">已更新</span>
                  : login.status === 'failed' ? <span className="tag warn">上次失败</span>
                    : status?.cookieSet ? <span className="tag ok">已有 Cookie</span>
                      : <span className="tag">未配置</span>}
            </b>
            <Hint text="打开浏览器后输入账号密码 + 验证码；登录成功会自动写回，不用手动复制 Cookie" />
          </div>
          {login.status === 'running' ? (
            <div className="cover-kv" style={{ display: 'block' }}>
              <span className="plg-hint">在刚打开的浏览器窗口里完成登录（账号密码 + 验证码，或统一认证），这个页面会自动更新。</span>
            </div>
          ) : (
            <button className="mset-add" style={{ marginTop: 8 }} onClick={() => void startLogin()}>
              <Icon name="refresh" size={13} /> {login.status === 'done' ? '再登录一次' : '打开登录页'}
            </button>
          )}
          {login.status === 'done' && (
            <div className="plg-hint" style={{ marginTop: 6 }}>Cookie 已写回，守护进程下一轮会自动重新接线（约 2 分钟）。</div>
          )}
          {loginErr && <div className="mset-err">{loginErr}</div>}
        </div>

        <div className="mset-group">
          <div className="mset-group-t">试翻</div>
          <div className="cover-field">
            <span className="mset-flabel">歌名 <Hint text="去网易云搜原曲，VIP/版权曲可能没有播放地址" /></span>
            <BrandInput value={song} placeholder="如「起风了」" spellCheck={false}
              onChange={(e) => setSong(String(e.target.value))} />
          </div>
          <div className="cover-field">
            <span className="mset-flabel">原唱 <Hint text="同名歌多时用歌手名消歧" /></span>
            <BrandInput value={artist} placeholder="可选" spellCheck={false}
              onChange={(e) => setArtist(String(e.target.value))} />
          </div>
          <div className="cover-field">
            <span className="mset-flabel">伴奏 <Hint text="关掉只发换声后的人声（清唱）" /></span>
            <div className={'switch' + (withInst ? ' on' : '')} role="switch" aria-checked={withInst}
              onClick={() => setWithInst((v) => !v)} />
          </div>
          <button className="btn primary cover-go" disabled={!song.trim() || !!job} onClick={() => void audition()}>
            {job ? `翻唱中… ${dur(job.elapsed)}` : '试翻'}
          </button>
          {previewErr && <div className="mset-err">{previewErr}</div>}
        </div>
      </aside>

      <section className="mset-detail">
        <div className="mset-dhead">
          <span className="mset-dic"><Icon name="mic" size={17} /></span>
          <h2 className="mset-dtitle">翻唱记录</h2>
          <div className="mset-dright">
            <span className="plg-hint">{records.length} 条</span>
            <button className="mset-add" onClick={() => void reload()}><Icon name="refresh" size={13} /> 刷新</button>
          </div>
        </div>

        {!records.length && <div className="mset-empty">还没有翻唱记录，左边点一首试试。整首歌可能要十几分钟。</div>}
        {records.map((r) => (
          <div className="cover-item" key={r.id}>
            <div className="mset-mrow cover-row" title={`${r.userId} @ ${r.chatId}`}>
              <span className="mono">{fmtDT(r.ts)}</span>
              <span className="cover-user" title={r.song}>《{r.song}》</span>
              <span className="cover-prov">{r.artist}</span>
              <span className="mset-badge">{mmss(r.seconds)}</span>
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
              <div className="cover-fold">
                <CoverAudio id={r.id} autoStart={play.auto} />
              </div>
            )}
            {send?.id === r.id && (
              <div className="cover-fold">
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
