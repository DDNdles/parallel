/**
 * 圈内黑话（表达学习）—— 对齐 MaiBot `src/learners/jargon_miner.py` 的机制：
 *
 *   1. 频次阶梯 [4, 8, 25, 100]：每跨过一档才触发一次推断（量便宜、量大了再问）。
 *   2. 反事实对比：先不看用法按公共含意解释，再看它在群里的真实用法——两边读法有
 *      分歧 = 圈内黑话（圈外读者自己看不懂），读一样 = 普通词不记。判定口径
 *      `is_jargon = not is_similar` 原样保留；MaiBot 原版分两次推断，这里合成一次
 *      调用（两个解释放一个 prompt），效果同、token 减半。
 *
 * 学来的东西只进 prompt 的「圈内黑话」参考（帮她听懂），不改说话风格、不教学工作；
 * 好感度红线：不产数值、不为"会了词"刷存在感。判定是侧端异步调用，失败就当没这回事。
 */

import type { ChatEvent, ChatRef } from '../types.ts';
import type { ErrorCenter } from '../errors.ts';

export interface JargonConfig {
  enable: boolean;
}

export interface JargonInfer {
  jargon: boolean;
  /** 圈内含意，一句话（≤60 字） */
  meaning: string;
}

export interface JargonServiceOptions {
  db: Pick<import('../db.ts').Db, 'run' | 'get' | 'all'>;
  errors?: {
    record: (level: 'info' | 'warn' | 'error', category: 'kernel' | 'provider' | 'media' | 'adapter' | 'plugin' | 'sandbox' | 'storage' | 'command', message: string, opts?: { pluginId?: string; chatId?: string }) => void;
  };
  config?: () => JargonConfig;
  /** 反事实判定回调（kernel 里用 llm.chat 装配；没接/失败返回 null） */
  infer?: (payload: { term: string; count: number; contexts: string[] }) => Promise<JargonInfer | null>;
  now?: () => number;
}

export const JARGON_LADDER = [4, 8, 25, 100] as const;
const MEANING_MAX = 60;
const CONTEXT_MAX = 6;
const CONTEXT_LEN = 120;
const FLUSH_MS = 5_000;
const INFER_GAP_MS = 60_000;

/** 无分词器时代的黑话候选：只收带字母的词（含数字混写）。链接、@、占位符先剥掉 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'you', 'your', 'this', 'that', 'with', 'not', 'but', 'from',
  'have', 'was', 'were', 'will', 'can', 'just', 'like', 'now', 'then', 'when', 'what', 'who',
  'how', 'why', 'it', 'its', 'is', 'at', 'on', 'do', 'does', 'did', 'so', 'if', 'as', 'of',
  'or', 'in', 'to', 'be', 'me', 'my', 'we', 'us', 'up', 'out', 'no', 'yes', 'oh', 'em', 'he',
  'she', 'they', 'them', 'got', 'get', 'wow', 'ok', 'kk', 'qq', 'bot', 'uan', 'com', 'cn',
]);

export function extractCandidates(text: string): string[] {
  const clean = String(text ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\[回复[^\]]*\]/g, ' ')
    .replace(/\[聊天记录[^\]]*\]/g, ' ')
    .replace(/\[(?:图片|语音|视频|文件|表情[^[\]]*)]/g, ' ');
  const out = new Set<string>();
  for (const m of clean.matchAll(/[A-Za-z][A-Za-z0-9_'\-]{1,23}/g)) {
    const tok = m[0].toLowerCase().replace(/^[\-']+|[\-']+$/g, '');
    if (tok.length < 2 || STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return [...out];
}

interface JargonRow { term: string; chat_id: string; count: number; rung: number; meaning: string; ts?: number | null }

export class JargonService {
  /** chatId -> term -> count（内存是唯一真源，flush 时整值落库） */
  private counts = new Map<string, Map<string, number>>();
  private meta = new Map<string, { rung: number; meaning: string }>();
  /** 每个词最近见过的语境（推断时喂给反事实对比） */
  private contexts = new Map<string, string[]>();
  private dirty = false;
  private inferBusy = new Set<string>();
  private lastInferAt = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private opts: JargonServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.reloadFromDb();
    this.timer = setInterval(() => this.flush(), FLUSH_MS) as NodeJS.Timeout;
    this.timer.unref();
  }

  dispose(): void { clearInterval(this.timer); this.flush(); }

  /** 键用 chatId｜term：同一词在不同群语义独立 */
  private key(chatId: string, term: string): string { return `${chatId}｜${term}`; }

  private reloadFromDb(): void {
    let rows: JargonRow[] = [];
    try { rows = this.opts.db.all<JargonRow>('SELECT term, chat_id, count, rung, meaning, ts FROM jargon'); } catch { return; }
    for (const r of rows) {
      this.countsFor(r.chat_id).set(r.term, r.count);
      this.meta.set(this.key(r.chat_id, r.term), { rung: r.rung, meaning: r.meaning ?? '' });
    }
  }

  private countsFor(chatId: string): Map<string, number> {
    let m = this.counts.get(chatId);
    if (!m) { m = new Map(); this.counts.set(chatId, m); }
    return m;
  }

  /** 入站群消息里挖黑话候选（不阻塞：判定是异步侧端调用） */
  observe(event: ChatEvent): void {
    if (!this.opts.config?.().enable) return;
    if (event.type !== 'group' || !event.text) return;
    const terms = extractCandidates(event.text);
    if (!terms.length) return;
    for (const term of terms) {
      const counts = this.countsFor(event.chatId);
      const count = (counts.get(term) ?? 0) + 1;
      counts.set(term, count);
      const k = this.key(event.chatId, term);
      const ctx = this.contexts.get(k) ?? [];
      if (ctx.length < CONTEXT_MAX) {
        const snippet = event.text.length > CONTEXT_LEN ? `${event.text.slice(0, CONTEXT_LEN)}…` : event.text;
        ctx.push(snippet);
        this.contexts.set(k, ctx);
      }
      this.dirty = true;
      const rung = this.meta.get(k)?.rung ?? 0;
      if (rung < JARGON_LADDER.length && count >= JARGON_LADDER[rung]) this.fireInfer(event.chatId, term, count, rung);
    }
  }

  /** 跨档即开推断：rung 先进位（记本次已问过这一档），失败靠下一档的自然到点兜底，60s 节流 */
  private fireInfer(chatId: string, term: string, count: number, rung: number): void {
    const k = this.key(chatId, term);
    const t = this.now();
    if (this.inferBusy.has(k)) return;
    if (t - (this.lastInferAt.get(k) ?? 0) < INFER_GAP_MS) return;
    if (!this.opts.config?.().enable) return;
    this.inferBusy.add(k);
    this.lastInferAt.set(k, t);
    const meta = this.meta.get(k) ?? { rung: 0, meaning: '' };
    meta.rung = rung + 1;
    this.meta.set(k, meta);
    void (async () => {
      try {
        const result = await this.opts.infer?.({ term, count, contexts: [...(this.contexts.get(k) ?? [])] });
        if (result && result.jargon && result.meaning) {
          meta.meaning = result.meaning.slice(0, MEANING_MAX);
          this.dirty = true;
        }
      } catch (e) {
        this.opts.errors?.record('warn', 'kernel', `黑话推断出错（${term}）：${(e as Error).message}`);
      } finally {
        this.inferBusy.delete(k);
        this.flush();
      }
    })();
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const ts = this.now();
      for (const [chatId, terms] of this.counts) {
        for (const [term, count] of terms) {
          const meta = this.meta.get(this.key(chatId, term));
          this.opts.db.run(
            `INSERT INTO jargon (term, chat_id, count, rung, meaning, ts)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(chat_id, term)
             DO UPDATE SET count=excluded.count, rung=excluded.rung, meaning=excluded.meaning`,
            term, chatId, count, meta?.rung ?? 0, meta?.meaning ?? '', ts,
          );
        }
      }
    } catch (e) {
      this.dirty = true;
      this.opts.errors?.record('warn', 'storage', `黑话词典落库失败：${(e as Error).message}`);
    }
  }

  /**
   * 「圈内黑话」system 分节的正文：本群学到的词 + 一句话含意；没学到就 null（不发空节）。
   * 用途限定在"听懂"，措辞里也讲清楚不许拿它当教学材料。
   */
  sections(chat: ChatRef): string | null {
    if (!this.opts.config?.().enable) return null;
    let rows: { term: string; meaning: string }[] = [];
    try {
      rows = this.opts.db.all<{ term: string; meaning: string }>(
        'SELECT term, meaning FROM jargon WHERE chat_id = ? AND meaning <> ? ORDER BY ts DESC LIMIT 12',
        chat.chatId, '',
      );
    } catch { return null; }
    if (!rows.length) return null;
    return [
      '# 圈内黑话（以前从本群学来的）',
      '下面这些词在你们圈里有自己的含意。遇到就按写下的意思听、自然使用，别当词典来讲、也别主动教学——对方在用黑话时说不清楚意思反而是出戏。',
      ...rows.slice(0, 8).map((r) => `- ${r.term}：${r.meaning}`),
    ].join('\n');
  }
}

/** 反事实判定的两段式提示词 + 行结果解析（kernel 的 infer 闭包用） */
export const JARGON_SYSTEM = '你在审一个 QQ 群里逐渐长出的「圈内黑话」。判定方式是反事实对比：同一个词，不看用法与看了真实用法，意思是否读得一样。读法有分歧＝圈内黑话；没分歧＝普通词。结论只给圈内含意的一句话，不要延伸故事。';

export function buildJargonPrompt(p: { term: string; count: number; contexts: string[] }): string {
  return [
    `词：${p.term}`,
    '',
    '第 1 步（不看语境）：按最通行的公共含意解释它。',
    '第 2 步（看语境）：下面是它在群里的真实用法：',
    ...p.contexts.map((c, i) => `- 例${i + 1}：${c}`),
    '',
    '第 3 步：两边读法若有分歧——它就是圈内黑话，用一句话写下它的圈内含意；读不出分歧就当不是黑话。',
    '只输出一行 JSON：{"jargon": true|false, "meaning": "圈内含意或空字符串"}',
  ].join('\n');
}

export function parseJargonReply(text: string): JargonInfer | null {
  const raw = String(text ?? '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { jargon?: unknown; meaning?: unknown };
    if (typeof obj.jargon !== 'boolean') return null;
    return { jargon: obj.jargon, meaning: typeof obj.meaning === 'string' ? obj.meaning.trim() : '' };
  } catch { return null; }
}
