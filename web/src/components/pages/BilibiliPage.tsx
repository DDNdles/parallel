'use client';
/** b站搜索：左搜索结果列表（缩略图/标题/UP/播放/弹幕）+ 右视频详情（简介统计 + 评论区，热门/时间切换与翻页） */
import { useCallback, useEffect, useState } from 'react';
import { get, fmtDT } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { BrandInput } from '@/components/BrandInput';
import { PillSelect } from '@/components/PillSelect';

interface Video {
  bvid: string; aid: number; title: string; author: string; authorMid: number;
  pic: string; duration: number; play: number; danmaku: number; desc: string;
}
interface VideoDetail {
  bvid: string; title: string; desc: string; author: string; duration: number;
  view: number; like: number; coin: number; favorite: number; share: number; subtitleAvailable: boolean;
}
interface Comment { rpid: number; user: string; content: string; likes: number; time: number }

const OFF = '插件未启用，可在插件页开启';
const SORTS = [{ v: 'hot', t: '热门' }, { v: 'time', t: '时间' }];

/** hdslb 图床只认 https 且查 referer：补协议并把 http 换成 https */
const fixPic = (u: string) => (u.startsWith('//') ? 'https:' + u : u.replace(/^http:/, 'https:'));
/** 播放/弹幕这类大数：过万说万 */
const fmtN = (n: number) => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n));
/** 秒 → h:mm:ss / m:ss */
const fmtDur = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
};

export default function BilibiliPage() {
  const [kw, setKw] = useState('');
  const [off, setOff] = useState<string | null>(null);
  const [list, setList] = useState<Video[] | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState('');
  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [total, setTotal] = useState(0);
  const [cpage, setCpage] = useState(1);
  const [sort, setSort] = useState('hot');

  /** 首查兼作插件在否的探活：读不通 / ok:false 都收进「未启用」空态 */
  const search = useCallback(async (kw2: string, p: number) => {
    if (!kw2.trim()) return;
    setBusy(true);
    try {
      const r = await get(`/api/plugin/bilibili/search?kw=${encodeURIComponent(kw2.trim())}&page=${p}`);
      if (r.ok === false) { setOff(OFF); return; }
      setOff('');
      setList(r.videos ?? []);
      setPage(p);
    } catch { setOff(OFF); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void search('parallel', 1); }, [search]);

  const pick = useCallback((bvid: string) => {
    setSel(bvid);
    get('/api/plugin/bilibili/video?bvid=' + encodeURIComponent(bvid))
      .then((r: { ok: boolean; video?: VideoDetail }) => setVideo(r.ok === false ? null : r.video ?? null))
      .catch(() => setVideo(null));
  }, []);
  const loadComments = useCallback((bvid: string, p: number, s: string) => {
    if (!bvid) return;
    get(`/api/plugin/bilibili/comments?bvid=${encodeURIComponent(bvid)}&page=${p}&sort=${s}`)
      .then((r: { ok: boolean; comments?: Comment[]; total?: number }) => {
        setComments(r.ok === false ? [] : r.comments ?? []);
        setTotal(r.total ?? 0);
        setCpage(p);
      })
      .catch(() => { setComments([]); setTotal(0); });
  }, []);
  useEffect(() => { if (sel) loadComments(sel, 1, sort); }, [sel, sort, loadComments]);

  if (off) return <div className="mset-body"><div className="mset-detail"><div className="mset-empty">{off}</div></div></div>;

  return (
    <div className="mset-body">
      <aside className="mset-list bili-list">
        <div className="bili-search">
          <BrandInput value={kw} placeholder="搜 b 站，回车" spellCheck={false}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(kw, 1); }} />
        </div>
        <div className="mset-group">
          <div className="mset-group-t">{list ? `结果（第 ${page} 页）` : '搜索'}</div>
          {(list ?? []).map((v) => (
            <button key={v.bvid} className={'bili-row' + (v.bvid === sel ? ' sel' : '')} onClick={() => pick(v.bvid)} title={v.title}>
              <img className="bili-thumb" src={fixPic(v.pic)} alt="" loading="lazy" referrerPolicy="no-referrer" />
              <span className="bili-t">
                <span className="bili-title">{v.title}</span>
                <span className="bili-sub mono">{v.author} · {fmtDur(v.duration)}</span>
                <span className="bili-sub">{fmtN(v.play)} 播放 · {fmtN(v.danmaku)} 弹幕</span>
              </span>
            </button>
          ))}
          {list && !list.length && <div className="mset-group-e">{busy ? '搜索中…' : '没有结果'}</div>}
          {!!list?.length && (
            <div className="bili-pager">
              <button className="btn" disabled={busy || page <= 1} onClick={() => void search(kw, page - 1)}>上一页</button>
              <span className="plg-hint mono">{page}</span>
              <button className="btn" disabled={busy} onClick={() => void search(kw, page + 1)}>下一页</button>
            </div>
          )}
        </div>
      </aside>

      <section className="mset-detail">
        {!sel && <div className="mset-empty">左边挑一条视频看详情。</div>}
        {sel && !video && <div className="mset-empty">视频信息读取失败。</div>}
        {video && (<>
          <div className="mset-dhead">
            <span className="mset-dic"><Icon name="bilibili" size={17} /></span>
            <h2 className="mset-dtitle bili-dtitle" title={video.title}>{video.title}</h2>
          </div>
          <div className="mset-meta">
            <span className="tag accent">{video.author}</span>
            <span className="tag mono">{fmtDur(video.duration)}</span>
            <span className="tag">{fmtN(video.view)} 播放</span>
            <span className="tag">{fmtN(video.like)} 点赞</span>
            <span className="tag">{fmtN(video.coin)} 投币</span>
            <span className="tag">{fmtN(video.favorite)} 收藏</span>
            <span className="tag">{fmtN(video.share)} 分享</span>
            {video.subtitleAvailable && <span className="tag ok">有字幕</span>}
          </div>
          {video.desc && <p className="plg-desc bili-desc">{video.desc}</p>}

          <div className="mset-sec-h">
            <span>评论（{fmtN(total)}）</span>
            <span className="plg-sec-r">
              <PillSelect align="right" value={sort} options={SORTS} label="排序" compact
                onChange={(v) => setSort(v)} />
            </span>
          </div>
          {!comments.length && <div className="mset-group-e">{total ? '这一页没有评论' : '还没有评论'}</div>}
          {comments.map((c) => (
            <div className="bili-cmt" key={c.rpid}>
              <div className="bili-cmt-h">
                <b className="bili-cmt-u">{c.user}</b>
                <span className="mono">{fmtDT(c.time)}</span>
                {c.likes > 0 && <span>{fmtN(c.likes)} 赞</span>}
              </div>
              <div className="bili-cmt-c">{c.content}</div>
            </div>
          ))}
          {!!comments.length && (
            <div className="bili-pager">
              <button className="btn" disabled={cpage <= 1} onClick={() => loadComments(sel, cpage - 1, sort)}>上一页</button>
              <span className="plg-hint mono">{cpage}</span>
              <button className="btn" disabled={comments.length === 0} onClick={() => loadComments(sel, cpage + 1, sort)}>下一页</button>
            </div>
          )}
        </>)}
      </section>
    </div>
  );
}
