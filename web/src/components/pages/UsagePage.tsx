'use client';
/**
 * 用量：KPI 条 + 活跃热力图 + 每日趋势折线 + 模型占比环。
 * 全部图形是手写 SVG（运行期零依赖），数据只有 GET /api/usage 一份真账，
 * 实时走事件流：有消息/调用落地就节流重拉，不靠猜。
 *
 * 口径（用户定的）：消息数不对应模型；token 按模型分，且拆「输入未命中 / 输入缓存命中 / 输出」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, onEvent } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { PillSelect } from '@/components/PillSelect';
import { usePageCmd, type PageCmd } from '@/lib/pageCmd';

type Metric = 'msg' | 'tokens' | 'calls';
type Gran = 'day' | 'week' | 'month';
type Win = '7' | '30' | 'all';

interface ModelUsage { miss: number; hit: number; out: number; calls: number }
interface DayBucket {
  day: string; prompt: number; completion: number; tokens: number; cacheHit: number; cacheMiss: number;
  calls: number; msgIn: number; msgOut: number; chats: number; byModel: Record<string, ModelUsage>;
}
interface ModelRow extends ModelUsage { model: string; providers: string[]; tokens: number; days: number }
interface Report {
  generatedAt: number; firstDay: string | null; days: DayBucket[]; today: DayBucket | null;
  totals: {
    prompt: number; completion: number; tokens: number; cacheHit: number; cacheMiss: number; calls: number;
    msgIn: number; msgOut: number; activeDays: number; streak: number; bestStreak: number;
    peak: { tokens: { day: string; value: number }; msg: { day: string; value: number }; calls: { day: string; value: number } };
  };
  models: ModelRow[];
  work: { runs: number; ok: number; totalMs: number; maxMs: number; toolCalls: number; rounds: number };
}

const METRICS: { v: Metric; t: string; unit: string }[] = [
  { v: 'msg', t: '消息', unit: '条' },
  { v: 'tokens', t: 'Token', unit: 'tk' },
  { v: 'calls', t: '模型调用', unit: '次' },
];
const GRANS: { v: Gran; t: string }[] = [{ v: 'day', t: '每日' }, { v: 'week', t: '每周' }, { v: 'month', t: '累计' }];
const WINS: { v: Win; t: string }[] = [{ v: '7', t: '近 7 日' }, { v: '30', t: '近 30 日' }, { v: 'all', t: '全部' }];
/** 分类色：环与折线共用同一个模型→颜色映射，两边一眼能对上 */
const SERIES = 6;
const colorOf = (i: number) => `var(--c${(i % SERIES) + 1})`;

const val = (d: DayBucket, m: Metric) => (m === 'msg' ? d.msgIn + d.msgOut : m === 'tokens' ? d.tokens : d.calls);
const mval = (c: ModelUsage, m: Metric) => (m === 'tokens' ? c.miss + c.hit + c.out : c.calls);
const UNKNOWN = '未知模型';
const modelName = (m: string) => m || UNKNOWN;

/** 中文数量级：1.2万 / 3.4亿 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(abs >= 1e9 ? 0 : 1)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(abs >= 1e6 ? 0 : 1)}万`;
  return String(Math.round(n));
}
/** 环与图例的口径：留一位小数（12.4亿 / 7329.2万）。坐标轴用上面那个紧凑版，否则刻度会挤成一片。 */
function fmtTok(n: number): string {
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(Math.round(n));
}
const mmdd = (day: string) => day.slice(5).replace('-', '/');
const weekStart = (day: string) => {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
};

/** 容器实际宽度：折线图要按像素画，不能用 viewBox 拉伸（描边会跟着变形） */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export default function UsagePage({ cmd }: { cmd?: PageCmd }) {
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [metric, setMetric] = useState<Metric>('tokens');
  const [gran, setGran] = useState<Gran>('day');
  const [win, setWin] = useState<Win>('30');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    get('/api/usage')
      .then((r: Report) => { setRep(r); setErr(''); })
      .catch((e: unknown) => setErr(`读取用量失败：${(e as Error)?.message ?? String(e)}`))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  usePageCmd('usage', cmd, load);

  /* 实时：会话日志/调用完成/出站消息/任务进度任一落地就重拉。事件很密，2.5s 合一批；
     另加 20s 兜一轮（内核重启、事件流重连期间漏掉的靠轮询补齐）。 */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const kick = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; load(); }, 2500);
    };
    const offs = ['session.log', 'provider.changed', 'chat.out', 'work.done', 'work.error'].map((ev) => onEvent(ev, kick));
    const poll = setInterval(load, 20_000);
    return () => { offs.forEach((off) => off()); if (timer) clearTimeout(timer); clearInterval(poll); };
  }, [load]);

  /** 模型 → 颜色序号：环、折线、列表三处必须同一个色 */
  const colorIdx = useMemo(() => {
    const m = new Map<string, number>();
    (rep?.models ?? []).forEach((x, i) => m.set(x.model, i));
    return m;
  }, [rep]);
  const unit = METRICS.find((m) => m.v === metric)!.unit;
  const series = useMemo(() => (rep?.days ?? []).slice().sort((a, b) => (a.day < b.day ? -1 : 1)), [rep]);
  const windowed = useMemo(() => (win === 'all' ? series : series.slice(-Number(win))), [series, win]);
  const t = rep?.totals;

  return (
    <div className="usage">
      {err && <div className="mset-err">{err}</div>}

      {/* ---------------- KPI ---------------- */}
      <section className="usage-card usage-kpi-card">
        <div className="usage-h">
          <h3>应用用量</h3>
          <span className="usage-h-r">
            <button className={'mset-ibtn' + (busy ? ' busy' : '')} title="重新拉取用量" onClick={load}><Icon name="refresh" size={14} /></button>
          </span>
        </div>
        <div className="usage-kpis">
          <Kpi n={t ? fmt(t.tokens) : '-'} t="累计 Token 数" />
          <Kpi n={t && t.peak.tokens.value ? fmt(t.peak.tokens.value) : '-'} t="峰值单日 Token" />
          <Kpi n={t ? `${t.calls}` : '-'} t="模型调用次数" />
          <Kpi n={t ? `${t.streak} 天` : '-'} t="当前连续天数" />
          <Kpi n={t ? `${t.bestStreak} 天` : '-'} t="最长连续天数" />
        </div>
      </section>

      {/* ---------------- 热力图 ---------------- */}
      <section className="usage-card">
        <div className="usage-h">
          <h3>活跃热力</h3>
          <span className="usage-h-r">
            <PillSelect value={metric} options={METRICS.map((m) => ({ v: m.v, t: m.t }))} onChange={(v) => setMetric(v as Metric)} label="指标" />
            <span className="usage-seg">
              {GRANS.map((g) => (
                <button key={g.v} className={'usage-segb' + (g.v === gran ? ' on' : '')} onClick={() => setGran(g.v)}>{g.t}</button>
              ))}
            </span>
          </span>
        </div>
        <Heat days={series} metric={metric} gran={gran} unit={unit} />
      </section>

      {/* ---------------- 折线 ---------------- */}
      <section className="usage-card">
        <div className="usage-h">
          <h3>每日趋势</h3>
          <span className="usage-h-r">
            <span className="usage-seg">
              {WINS.map((wv) => (
                <button key={wv.v} className={'usage-segb' + (wv.v === win ? ' on' : '')} onClick={() => setWin(wv.v)}>{wv.t}</button>
              ))}
            </span>
          </span>
        </div>
        <Trend days={windowed} metric={metric} unit={unit} colorIdx={colorIdx} />
      </section>

      {/* ---------------- 模型占比 ---------------- */}
      <section className="usage-card">
        <div className="usage-h">
          <h3>模型用量</h3>
        </div>
        <Share models={rep?.models ?? []} colorIdx={colorIdx} />
      </section>
    </div>
  );
}

function Kpi({ n, t }: { n: string; t: string }) {
  return (
    <div className="usage-kpi">
      <b>{n}</b>
      <span className="usage-kpi-t">{t}</span>
    </div>
  );
}

// ============================================================
// 热力图：每日=7 行 × 周列；每周/累计=一条横带。绿色五档 + 空格
// ============================================================

interface Cell { key: string; value: number; label: string; short: string }

function bucketize(days: DayBucket[], metric: Metric, gran: Gran): Cell[] {
  const out: Cell[] = [];
  const add = (key: string, label: string, short: string, list: DayBucket[]) =>
    out.push({ key, label, short, value: list.reduce((s, d) => s + val(d, metric), 0) });
  if (gran === 'day') {
    for (const d of days) add(d.day, d.day, mmdd(d.day), [d]);
    return out;
  }
  const groups = new Map<string, DayBucket[]>();
  for (const d of days) {
    const key = gran === 'week' ? weekStart(d.day) : d.day.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }
  for (const [key, list] of [...groups.entries()].sort()) {
    if (gran === 'week') add(key, `${key} 那一周`, mmdd(key), list);
    else add(key, `${key.slice(0, 4)} 年 ${Number(key.slice(5, 7))} 月`, `${Number(key.slice(5, 7))}月`, list);
  }
  return out;
}

/** 日格按周切列：周一为一列首格。历史不足一年也铺满一年（空格照画，才看得出"这些天没活动"）；
 *  今天之后的格子给 undefined（不画），过去的空档给 null（画最浅一档）。 */
function dayGrid(cells: Cell[], weeks: number, todayK: string): { grid: (Cell | null | undefined)[][]; mondays: string[] } {
  const byDay = new Map(cells.map((c) => [c.key, c]));
  const start = Date.parse(`${weekStart(todayK)}T00:00:00Z`) - (weeks - 1) * 7 * 86_400_000;
  const grid: (Cell | null | undefined)[][] = [];
  const mondays: string[] = [];
  for (let w = 0; w < weeks; w++) {
    const mon = new Date(start + w * 7 * 86_400_000).toISOString().slice(0, 10);
    mondays.push(mon);
    const col: (Cell | null | undefined)[] = [];
    for (let d = 0; d < 7; d++) {
      const key = new Date(Date.parse(`${mon}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
      col.push(key > todayK ? undefined : byDay.get(key) ?? null);
    }
    grid.push(col);
  }
  return { grid, mondays };
}

/** 档位：非零按最大值四等分，0 走 h0（GitHub 那套对比度） */
function heatCls(v: number, max: number): string {
  if (v <= 0) return 'h0';
  const r = v / max;
  return `h${r > 0.75 ? 4 : r > 0.45 ? 3 : r > 0.2 ? 2 : 1}`;
}

/** 月份刻度：按每列周一的日期定月（空格子也要有月份，否则一年宽的空网格底下只有两个月名）；
 *  格子很密时按最小间距抽稀，免得标签叠字。 */
function monthTicks(mondays: string[], minGap: number): { key: string; col: number; label: string }[] {
  const out: { key: string; col: number; label: string }[] = [];
  let last = -99;
  mondays.forEach((mon, ci) => {
    const m = mon.slice(0, 7);
    if (out.some((o) => o.key === m) || ci - last < minGap) return;
    out.push({ key: m, col: ci, label: `${Number(mon.slice(5, 7))}月` });
    last = ci;
  });
  return out;
}

function Heat({ days, metric, gran, unit }: { days: DayBucket[]; metric: Metric; gran: Gran; unit: string }) {
  /* 钩子必须无条件跑完：数据到达前 cells 是空的，一旦在 useMemo 之前 return，
     下一次渲染就多出一个钩子，React 直接报 #310（整页白屏）。 */
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Cell | null>(null);
  const cells = useMemo(() => bucketize(days, metric, gran), [days, metric, gran]);
  const todayK = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const avail = Math.max(0, w - 2);
  /** 每日视图铺满"一年"：53 周起步，历史更长跟着长，格子尺寸 = 可用宽 / 列数（贴右边缘） */
  const weeks = useMemo(() => {
    const span = cells.length
      ? Math.ceil((Date.parse(`${todayK}T00:00:00Z`) - Date.parse(`${cells[0].key}T00:00:00Z`)) / (7 * 86_400_000)) + 1
      : 0;
    return Math.max(53, span);
  }, [cells, todayK]);
  /** 铺满卡片：列数按"一格 ~16px"反推（至少一年），步长再用余数摊平，所以最后一列正好贴右边缘。
   *  横带视图同理，一格宽 = 可用宽 / 段数。 */
  const STEP = gran === 'day'
    ? (avail > 0 ? avail / weeks : 15)
    : Math.max(26, cells.length ? avail / cells.length : avail);
  const cols = useMemo(() => (gran === 'day' ? dayGrid(cells, weeks, todayK) : { grid: [] as (Cell | null | undefined)[][], mondays: [] as string[] }), [cells, weeks, gran, todayK]);
  const max = cells.reduce((m, c) => Math.max(m, c.value), 0);
  const CELL = Math.max(4, STEP - 3);
  const months = monthTicks(cols.mondays, Math.ceil(46 / STEP));

  const read = hover ?? cells[cells.length - 1];
  const head = read && (
    <div className="usage-read">
      <b>{fmt(read.value)}</b> {unit}
      <span className="usage-read-d">{read.label}</span>
      <span className="usage-scale">
        <i className="usage-heat-c h0" /><i className="usage-heat-c h1" /><i className="usage-heat-c h2" /><i className="usage-heat-c h3" /><i className="usage-heat-c h4" />
      </span>
    </div>
  );

  return (
    <div ref={ref} className="usage-heatwrap">
      {head}
      {!cells.length || max <= 0
        ? <div className="usage-blank">这段时间没有可统计的记录。</div>
        : gran !== 'day'
          ? <>
            <svg className="usage-heat" width={cells.length * STEP} height={34} role="img" aria-label="活跃热力图">
              {cells.map((c, i) => (
                <rect key={c.key} className={heatCls(c.value, max)} x={i * STEP} y={4} width={STEP - 4} height={26} rx={4}
                  onMouseEnter={() => setHover(c)} onMouseLeave={() => setHover(null)} />
              ))}
            </svg>
            <div className="usage-axis">
              {/* 同折线：一格放不下 46px 就继续抽稀，否则窄屏刻度会连成一片 */}
              {cells.map((c, i) => (
                <span key={c.key} className="usage-axis-i" style={{ width: STEP }}>{i % Math.max(1, Math.ceil(cells.length / 12), Math.ceil(46 / STEP)) === 0 ? c.short : ''}</span>
              ))}
            </div>
          </>
          : <>
            <svg className="usage-heat" width={cols.grid.length * STEP} height={7 * STEP + 16} role="img" aria-label="活跃热力图">
              {cols.grid.map((col, ci) => col.map((c, ri) => c === undefined ? null : (
                <rect key={`${ci}-${ri}`} className={c ? heatCls(c.value, max) : 'h0'}
                  x={ci * STEP} y={ri * STEP} width={CELL} height={CELL} rx={Math.min(3, CELL / 4)}
                  onMouseEnter={() => c && setHover(c)} onMouseLeave={() => setHover(null)} />
              )))}
              {months.map((m) => {
                // 最后几个月的标签右对齐，否则 "10月" 会顶出 svg 右边缘
                const end = m.col > cols.grid.length - 3;
                return (
                  <text key={m.key} x={end ? (m.col + 1) * STEP : m.col * STEP} y={7 * STEP + 12}
                    textAnchor={end ? 'end' : 'start'} className="usage-tick">{m.label}</text>
                );
              })}
            </svg>
          </>}
    </div>
  );
}

// ============================================================
// 折线：总量实线 + 各模型同色细线（消息指标只画一条）
// ============================================================

function Trend({ days, metric, unit, colorIdx }: { days: DayBucket[]; metric: Metric; unit: string; colorIdx: Map<string, number> }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 260, PL = 52, PR = 16, PT = 16, PB = 28;

  const names = useMemo(() => {
    if (metric === 'msg') return [];
    const acc = new Map<string, number>();
    for (const d of days) for (const [m, c] of Object.entries(d.byModel)) acc.set(m, (acc.get(m) ?? 0) + mval(c, metric));
    return [...acc.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, SERIES).map(([m]) => m);
  }, [days, metric]);

  const max = Math.max(1, ...days.map((d) => val(d, metric)));
  const perModel = metric !== 'msg';
  if (days.length < 2 || w <= 0) {
    return <div ref={ref} className="usage-blank">{days.length < 2 ? '记录还不足两天，攒一攒再来画曲线。' : ''}</div>;
  }
  const iw = w - PL - PR, ih = H - PT - PB;
  const x = (i: number) => PL + (i * iw) / (days.length - 1);
  const y = (v: number) => PT + ih - (v / max) * ih;
  const line = (f: (d: DayBucket) => number) => days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(f(d)).toFixed(1)}`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => ({ v: max * r, y: y(max * r) }));
  /* 抽稀要按像素说话：一枚「09/11」要 ~46px，只按条数（10 等分）在窄屏会叠成一排糊字；
     同时最多 10 个标签，宽屏也别铺满。 */
  const labelEvery = Math.max(1, Math.ceil(days.length / 10), Math.ceil((46 * (days.length - 1)) / iw));
  const cur = hover == null ? days.length - 1 : hover;
  const d0 = days[cur];

  return (
    <div ref={ref} className="usage-plot">
      <div className="usage-read">
        <b>{fmt(val(d0, metric))}</b> {unit}
        <span className="usage-read-d">{d0.day}</span>
        {names.length > 0 && (
          <span className="usage-leg">
            {names.map((n) => (
              <span key={n} className="usage-leg-i">
                <i style={{ background: colorOf(colorIdx.get(n) ?? 0) }} />{modelName(n)}
              </span>
            ))}
          </span>
        )}
      </div>
      <svg width={w} height={H} role="img" aria-label="每日趋势折线图"
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - box.left - PL) / iw) * (days.length - 1));
          setHover(Math.min(days.length - 1, Math.max(0, i)));
        }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PL} x2={w - PR} y1={t.y} y2={t.y} stroke="var(--border-strong)" strokeDasharray={i ? '2 4' : ''} />
            <text x={PL - 8} y={t.y + 3.5} textAnchor="end" className="usage-tick">{fmt(t.v)}</text>
          </g>
        ))}
        {/* 消息是全局一条，才配中性色的总量线 + 面积底 */}
        {perModel ? null : (
          <>
            <path d={`${line((d) => val(d, metric))}L${x(days.length - 1)} ${PT + ih}L${x(0)} ${PT + ih}Z`} style={{ fill: 'var(--text)' }} opacity={0.06} />
            <path d={line((d) => val(d, metric))} fill="none" strokeWidth={2} strokeLinejoin="round" style={{ stroke: 'var(--text)' }} />
          </>
        )}
        {/* 按模型时每条线吃自己那个颜色，与占比环同一份映射；这里再叠一条白色总量线会把彩色压没 */}
        {names.map((n) => (
          <path key={n} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
            style={{ stroke: colorOf(colorIdx.get(n) ?? 0) }}
            d={line((d) => (d.byModel[n] ? mval(d.byModel[n]!, metric) : 0))} />
        ))}
        <line x1={x(cur)} x2={x(cur)} y1={PT} y2={PT + ih} stroke="var(--border-stronger)" />
        {perModel
          ? names.filter((n) => d0.byModel[n]).map((n) => (
            <circle key={n} cx={x(cur)} cy={y(mval(d0.byModel[n]!, metric))} r={3.4}
              style={{ fill: colorOf(colorIdx.get(n) ?? 0) }} />
          ))
          : <circle cx={x(cur)} cy={y(val(d0, metric))} r={3.4} style={{ fill: 'var(--text)' }} />}
        {days.map((d, i) => (i % labelEvery === 0 || i === days.length - 1) && (
          <text key={d.day} x={x(i)} y={H - 8} textAnchor="middle" className="usage-tick">{mmdd(d.day)}</text>
        ))}
      </svg>
    </div>
  );
}

// ============================================================
// 模型占比：环（每段之间留缝）+ 右侧两行图例（名字·占比 / token 数）
// ============================================================

function Share({ models, colorIdx }: { models: ModelRow[]; colorIdx: Map<string, number> }) {
  const rows = useMemo(() => {
    const list = models.map((m) => ({ ...m, v: m.tokens })).filter((m) => m.v > 0);
    const top = list.slice(0, SERIES);
    const rest = list.slice(SERIES);
    if (!rest.length) return top;
    const merged = rest.reduce((a, m) => ({
      ...a, model: '其他模型', providers: [], days: 0,
      miss: a.miss + m.miss, hit: a.hit + m.hit, out: a.out + m.out, calls: a.calls + m.calls, tokens: a.tokens + m.tokens, v: a.v + m.v,
      // v 也要归零：漏了它，合并段会把 top[0] 的 token 再算一遍，环的总量凭空多出一整个头号模型
    }), { ...top[0], miss: 0, hit: 0, out: 0, calls: 0, tokens: 0, v: 0 });
    return [...top, merged];
  }, [models]);
  const total = rows.reduce((s, r) => s + r.v, 0);
  if (!total) return <div className="usage-blank">还没有模型回报过用量。</div>;

  const R = 99, C = 2 * Math.PI * R;
  /** 段间缝隙（沿中径的弧长）：只有一段时不镂空，否则环上凭空多一道缺口 */
  const GAP = rows.length > 1 ? 6 : 0;
  let acc = 0;
  return (
    <div className="usage-share">
      <svg className="usage-donut" width={260} height={260} viewBox="0 0 260 260" role="img" aria-label="模型用量占比">
        {rows.map((r) => {
          const frac = r.v / total;
          const len = Math.max(1.5, C * frac - GAP);
          const el = (
            <circle key={r.model} cx={130} cy={130} r={R} fill="none" strokeWidth={42}
              strokeDasharray={`${len.toFixed(2)} ${(C - len).toFixed(2)}`} strokeDashoffset={-(C * acc + GAP / 2)}
              style={{ stroke: colorOf(colorIdx.get(r.model) ?? 0) }} transform="rotate(-90 130 130)" />
          );
          acc += frac;
          return el;
        })}
        <text x={130} y={124} textAnchor="middle" className="usage-donut-n">{fmtTok(total)}</text>
        <text x={130} y={150} textAnchor="middle" className="usage-donut-t">tokens</text>
      </svg>
      <div className="usage-legend">
        {rows.map((r) => {
          const pct = (r.v / total) * 100;
          return (
            <div className="usage-li" key={r.model}>
              <i className="usage-sw" style={{ background: colorOf(colorIdx.get(r.model) ?? 0) }} />
              <div className="usage-lc">
                <div className="usage-lrow">
                  <span className="usage-nm mono" title={r.providers.join(' / ')}>{modelName(r.model)}</span>
                  <b className="usage-pct">{pct.toFixed(pct < 10 ? 1 : 0)}%</b>
                </div>
                <div className="usage-sub mono">{fmtTok(r.tokens)} tokens</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
