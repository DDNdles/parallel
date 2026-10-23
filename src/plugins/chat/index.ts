import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginContext, LLMRequestContext, ChatMessage } from '../../kernel/types.ts';
import type { SessionLogEntry } from '../../kernel/sessionlog.ts';
import {
  EXTRACT_SYSTEM, buildExtractPrompt, claimTurns, dueGroups, parseFacts, pushTurn, settle,
  type ExtractCfg, type ExtractQueue,
} from './memory-extract.ts';
import {
  EXPRESSION_SYSTEM, buildExpressionPrompt, expressionDue, expressionSection,
  mergeExpressions, parseExpressions, selectExpressions,
  EXPRESSION_BATCH_MAX, EXPRESSION_MAX_FAILS, EXPRESSION_QUEUE_MAX,
  type ExpressionCfg, type ExpressionEntry, type ExpressionMessage, type ExpressionQueue,
} from './expression.ts';
import {
  PROFILE_SYSTEM, MIDTERM_SYSTEM, buildProfilePrompt, buildMidtermPrompt,
  midtermSection, parseMidterm, parseProfile, profileSection,
  type MidtermEntry, type MidtermMessage,
} from './notes.ts';

// ============================================================
// chat —— 角色化聊天（人格即插件）
//
// 设定层照 HDSI（HDS Interlude）的分层来组织，替代原来的「人设卡 + 世界书 + few-shot」三件套：
//   Canon       —— 初始设定（主角记号 / 世界 / 配角 / 语言），剧情起点，只由人写
//   Perspective —— 独立于 Canon 的个体价值观：「她怎么看待世界」，不是设定条目
//   Overlay     —— **演化层**：长期剧情里渐进形成的稳定变化（性格/世界/关系），非破坏性；
//                  模型侧写入 = remember_setting（chat 面专用），读/清只在桌面端人格页
//   Voice       —— 说话方式与语气样例（原 few-shot）
//   Lore        —— 关键词命中的世界事实（保留：HDSI 的 Canon 里也有世界事实）
// 注入顺序（2026-10-16 缓存裁量后的实际档位）：稳定区 script(200) → perspective(210) → overlay(220)
//   → memory(250，只给指针不给事实) → voice-style(260) / voice-examples(270) → post-history(280)；
//   变量区 ≥450：speaker-role(457) → lorebook 命中(473)
// 工具面（2026-10-17）：chat 轮 = 记忆读写三件套（recall_facts / search_history / remember_setting）。
// ============================================================

interface LorebookEntry {
  keys: string[];
  constant?: boolean;
  priority?: number;
  content: string;
  tokenBudget?: number;
}

/** HDSI 式剧本：canon.json */
interface PersonaCanon {
  name: string;
  canon: {
    /** 主角记号（原人设卡的 spec，原文保留） */
    protagonist: string[];
    /** 世界事实（剧情起点） */
    world: string[];
    /** 配角与初始关系：Canon 配角只是"可用角色"，不等于在场 */
    cast?: { name: string; relation: string }[];
    language?: string;
  };
  /** 独立于 canon 的个体价值观（HDSI Perspective） */
  perspective?: string;
  voice: {
    style?: string;
    examples: { user: string; assistant: string }[];
    post_history?: string;
  };
  lore: LorebookEntry[];
}

/** Overlay 层的一条：长期剧情里形成的稳定变化（HDSI 要求可追溯来源） */
interface OverlayEntry {
  layer: 'character' | 'world' | 'relationship' | 'perspective';
  /** relationship 层的对象（用户 QQ）；其余层留空 = 全局 */
  targetId?: string;
  content: string;
  /** 从哪句话推出来的 */
  source?: string;
  at: number;
}

interface Persona {
  id: string;
  canon: PersonaCanon;
  dir: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Overlay 层的容量：太多了会淹没 Canon，超过就把最旧的挤掉 */
const OVERLAY_MAX = 24;
const OVERLAY_LAYERS = ['character', 'world', 'relationship', 'perspective'] as const;
const OVERLAY_LAYER_LABEL: Record<string, string> = {
  character: '性格', world: '世界', relationship: '关系', perspective: '价值观',
};

/** 自动提炼出的事实权重：<1 既是"用户页打「自动」徽标"的记号，也让它排在明说的事实后面 */
const AUTO_FACT_WEIGHT = 0.5;

export function setup(ctx: PluginContext): void {
  const personas = new Map<string, Persona>();

  function loadPersonas(): void {
    personas.clear();
    const root = join(here, 'personas');
    if (!existsSync(root)) return;
    for (const id of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
      const dir = join(root, id);
      try {
        const canon = JSON.parse(readFileSync(join(dir, 'canon.json'), 'utf-8')) as PersonaCanon;
        if (!canon?.canon || !Array.isArray(canon.canon.protagonist)) throw new Error('canon.json 缺少 canon.protagonist');
        canon.lore = Array.isArray(canon.lore) ? canon.lore : [];
        canon.voice = canon.voice ?? { examples: [] };
        personas.set(id, { id, canon, dir });
      } catch (e) {
        ctx.log.error(`人格 ${id} 加载失败: ${(e as Error).message}`);
      }
    }
  }
  loadPersonas();

  // ---------- 人格选择 ----------

  function activePersonaId(): string {
    const selected = ctx.state.get<string>('active_persona', 'auto');
    if (selected && selected !== 'auto' && personas.has(selected)) return selected;
    return String((ctx.config as any)?.persona?.default ?? 'whale-girl');
  }

  // ---------- 后台学习：表达 / 画像 / 聊天回想 ----------
  // 三条通道共用「session.log」这一份入站/出站流水：
  //  - 表达学习：只拿群聊里群友的消息，学「情境 → 说法」；
  //  - 中期回想：把已经滑出上下文时间窗的聊天压成一段背景摘要；
  //  - 用户画像：从长期事实生成一段短印象（在记忆提炼成功后刷新）。
  // 状态落在插件 KV（小、可清、随插件卸载保留），写盘只在 10s 扫描时发生一次。

  const EXPR_STORE_KEY = 'expressions';
  const EXPR_QUEUE_KEY = 'expression_queue';
  const MIDTERM_STORE_KEY = 'midterm_notes';
  const MIDTERM_QUEUE_KEY = 'midterm_queue';
  const PROFILE_ATTR = 'profile';
  const PROFILE_GAP_MS = 30 * 60_000;
  const EXPR_LEARN_GAP_MS = 5 * 60_000;
  const MIDTERM_GAP_MS = 10 * 60_000;
  const MIDTERM_MIN_MESSAGES = 24;
  /** 中期回想的队列上限随 historyLimit 走：比模型可见窗口多留 80 条，够切出"窗口之外"的一段 */
  const midtermCap = () => Math.max(240, historyLimit() + 80);

  const clampInt = (v: unknown, lo: number, hi: number, def: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const chatKeyOf = (chat: { type: string; chatId: string }) => `${chat.type}_${chat.chatId}`;

  const objOr = <T>(v: T, def: T): T => (v && typeof v === 'object' && !Array.isArray(v) ? v : def);
  const exprStore = objOr<Record<string, ExpressionEntry[]>>(ctx.state.get(EXPR_STORE_KEY, {}), {});
  const exprQueue = objOr<ExpressionQueue>(ctx.state.get(EXPR_QUEUE_KEY, {}), {});
  const midtermStore = objOr<Record<string, MidtermEntry>>(ctx.state.get(MIDTERM_STORE_KEY, {}), {});
  const midtermQueue = objOr<Record<string, { messages: MidtermMessage[]; lastSummaryAt: number; fails: number }>>(
    ctx.state.get(MIDTERM_QUEUE_KEY, {}), {},
  );

  const activeChats = new Set<string>();
  const runningExpr = new Set<string>();
  const runningMid = new Set<string>();
  const profileBusy = new Set<string>();
  const profileLastAt = new Map<string, number>();
  let lastProfileSweep = 0;
  let learningDirty = false;
  let disposed = false;

  function saveLearning(): void {
    if (!learningDirty) return;
    learningDirty = false;
    try {
      ctx.state.set(EXPR_STORE_KEY, exprStore);
      ctx.state.set(EXPR_QUEUE_KEY, exprQueue);
      ctx.state.set(MIDTERM_STORE_KEY, midtermStore);
      ctx.state.set(MIDTERM_QUEUE_KEY, midtermQueue);
    } catch (e) {
      ctx.log.warn(`学习状态写盘失败：${(e as Error).message}`);
    }
  }
  ctx.onDispose(() => { disposed = true; saveLearning(); });

  function exprCfg(): ExpressionCfg {
    const p = (ctx.config as any)?.humanlike?.expression ?? {};
    return {
      enable: p.enable !== false,
      minMessages: clampInt(p.minMessages, 4, 200, 20),
      idleSeconds: clampInt(p.idleSeconds, 0, 3600, 120),
      maxPerChat: clampInt(p.maxPerChat, 4, 100, 24),
      injectMax: clampInt(p.injectMax, 1, 10, 4),
    };
  }
  function notesCfg(): { profileAuto: boolean; midtermSummary: boolean } {
    const p = (ctx.config as any)?.persona ?? {};
    return { profileAuto: p.profileAuto !== false, midtermSummary: p.midtermSummary !== false };
  }
  function historyLimit(): number {
    return clampInt((ctx.config as any)?.storage?.historyLimit, 1, 500, 200);
  }

  /** 学习素材清洗：去掉引用/记录/媒体占位，命令与纯符号不进入学习 */
  function learningText(raw: unknown): string {
    const t = String(raw ?? '')
      .replace(/\[回复[^\]]*\]/g, ' ')
      .replace(/\[聊天记录[^\]]*\]/g, ' ')
      .replace(/\[(?:图片|语音|视频|文件|表情包?|动图|GIF|卡片)[^\]]*\]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || t.length < 2 || t.length > 300) return '';
    if (t.startsWith('/') || t.startsWith('／')) return '';
    if (!/[0-9A-Za-z\u4e00-\u9fff]/.test(t)) return '';
    return t;
  }

  function markActive(chat: { type: string; chatId: string }): void {
    activeChats.add(chatKeyOf(chat));
  }

  /** 取最近的一批、但总字数不超过预算（表达学习用：宁可少学几条，也别把请求顶爆） */
  function tailByChars<T extends { text: string }>(list: T[], maxChars: number): T[] {
    const out: T[] = [];
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if (out.length && n + t.text.length > maxChars) break;
      out.unshift(t);
      n += t.text.length;
    }
    return out;
  }

  /** 取最旧的一批、但总字数不超过预算（中期回想用：老的先总结，剩下的下一轮继续） */
  function headByChars<T extends { text: string }>(list: T[], maxChars: number): T[] {
    const out: T[] = [];
    let n = 0;
    for (const t of list) {
      if (out.length && n + t.text.length > maxChars) break;
      out.push(t);
      n += t.text.length;
    }
    return out;
  }

  /** 转述轮（work 结果回讲）不注入"本群说法 / 画像 / 回想"：那轮要讲清楚事，不是闲聊 */
  function isRelayTurn(req: LLMRequestContext): boolean {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i];
      if (m.role !== 'user') continue;
      return String(m.content ?? '').includes('【工作子代理');
    }
    return false;
  }

  function observeLearning(entry: SessionLogEntry): void {
    if (disposed) return;
    if (entry.type !== 'message_in' && entry.type !== 'message_out') return;
    if (entry.role !== 'user' && entry.role !== 'assistant') return;
    const key = `${entry.chatType}_${entry.chatId}`;
    if (!activeChats.has(key)) return;
    const text = learningText(entry.text);
    if (!text) return;

    // 表达学习：只要群聊里群友说的话
    if (entry.chatType === 'group' && entry.type === 'message_in' && entry.role === 'user' && exprCfg().enable) {
      const g = exprQueue[key] ?? { messages: [], lastLearnAt: 0, fails: 0 };
      g.messages.push({
        ts: Number(entry.ts) || Date.now(),
        userId: String(entry.userId ?? ''),
        nickname: String(entry.nickname ?? '') || String(entry.userId ?? '群友'),
        text,
      });
      if (g.messages.length > EXPRESSION_QUEUE_MAX) g.messages.splice(0, g.messages.length - EXPRESSION_QUEUE_MAX);
      exprQueue[key] = g;
      learningDirty = true;
    }

    // 中期回想：入站与出站都收（bot 自己的话也要在背景里对得上）
    if (notesCfg().midtermSummary) {
      const g = midtermQueue[key] ?? { messages: [], lastSummaryAt: 0, fails: 0 };
      g.messages.push({
        ts: Number(entry.ts) || Date.now(),
        role: entry.type === 'message_out' ? 'assistant' : 'user',
        who: entry.type === 'message_out' ? '我' : (entry.nickname || String(entry.userId ?? '') || '群友'),
        text,
      });
      if (g.messages.length > midtermCap()) g.messages.splice(0, g.messages.length - midtermCap());
      midtermQueue[key] = g;
      learningDirty = true;
    }

    // 到达即试着扫一遍：静默/条数门槛在 due 判定里，平时只是一次读内存
    void sweepExpressions();
    void sweepMidterm();
  }

  async function sweepExpressions(): Promise<void> {
    if (disposed) return;
    const cfg = exprCfg();
    if (!cfg.enable) return;
    const now = Date.now();
    for (const [key, g] of Object.entries(exprQueue)) {
      if (runningExpr.has(key)) continue;
      if (!Array.isArray(g?.messages) || !expressionDue(g.messages, cfg, now)) continue;
      if (now - (g.lastLearnAt || 0) < EXPR_LEARN_GAP_MS) continue;
      const snapshot = tailByChars(g.messages.slice(-EXPRESSION_BATCH_MAX), 8000);
      if (!snapshot.length) continue;
      runningExpr.add(key);
      try {
        const existing = Array.isArray(exprStore[key]) ? exprStore[key] : [];
        const resp = await ctx.llm.chat({
          model: '',
          messages: [
            { role: 'system', content: EXPRESSION_SYSTEM },
            { role: 'user', content: buildExpressionPrompt(snapshot, existing.map((e) => e.style)) },
          ],
          stream: false,
        });
        if (disposed) return;
        const learned = parseExpressions(resp.content ?? '', existing, 6, now);
        if (learned.length) {
          exprStore[key] = mergeExpressions(existing, learned, cfg.maxPerChat);
          ctx.log.info(`表达学习：${key} 学到 ${learned.length} 条`);
        }
        const lastTs = snapshot[snapshot.length - 1].ts;
        g.messages = g.messages.filter((m) => m.ts > lastTs);
        g.lastLearnAt = now;
        g.fails = 0;
        learningDirty = true;
      } catch (e) {
        g.lastLearnAt = now;   // 失败也退避 5 分钟，别每 10s 再打一次
        g.fails = (g.fails || 0) + 1;
        if (g.fails >= EXPRESSION_MAX_FAILS) {
          g.messages.splice(0, Math.ceil(g.messages.length / 2));
          g.fails = 0;
        }
        ctx.log.warn(`表达学习失败（${key}）：${(e as Error).message}`);
      } finally {
        runningExpr.delete(key);
        if (!disposed) {
          if (!g.messages.length) delete exprQueue[key];
          saveLearning();
        }
      }
    }
  }

  async function sweepMidterm(): Promise<void> {
    if (disposed || !notesCfg().midtermSummary) return;
    const now = Date.now();
    // 时间窗已删：模型可见的是最近 historyLimit 条，中期回想只总结落在窗口之外的那一段
    const keep = historyLimit();
    for (const [key, g] of Object.entries(midtermQueue)) {
      if (runningMid.has(key)) continue;
      if (!Array.isArray(g?.messages) || !g.messages.length) continue;
      const eligible = g.messages.slice(0, Math.max(0, g.messages.length - keep));
      if (eligible.length < MIDTERM_MIN_MESSAGES) continue;
      const last = eligible[eligible.length - 1];
      if (now - last.ts < 60_000) continue;
      if (now - (g.lastSummaryAt || 0) < MIDTERM_GAP_MS) continue;
      const snapshot = headByChars(eligible, 12000);
      if (!snapshot.length) continue;
      runningMid.add(key);
      try {
        const previous = midtermStore[key];
        const resp = await ctx.llm.chat({
          model: '',
          messages: [
            { role: 'system', content: MIDTERM_SYSTEM },
            { role: 'user', content: buildMidtermPrompt(snapshot, previous) },
          ],
          stream: false,
        });
        if (disposed) return;
        const parsed = parseMidterm(resp.content ?? '');
        const lastTs = snapshot[snapshot.length - 1].ts;
        if (parsed?.summary) {
          midtermStore[key] = {
            summary: parsed.summary,
            cues: parsed.cues,
            fromTs: snapshot[0].ts,
            toTs: lastTs,
            updatedAt: now,
          };
          ctx.log.info(`聊天回想：${key} 总结 ${snapshot.length} 条`);
        }
        g.messages = g.messages.filter((m) => m.ts > lastTs);
        g.lastSummaryAt = now;
        g.fails = 0;
        learningDirty = true;
      } catch (e) {
        g.lastSummaryAt = now;   // 失败也退避 10 分钟
        g.fails = (g.fails || 0) + 1;
        if (g.fails >= 3) {
          g.messages.splice(0, Math.ceil(g.messages.length / 2));
          g.fails = 0;
        }
        ctx.log.warn(`聊天回想失败（${key}）：${(e as Error).message}`);
      } finally {
        runningMid.delete(key);
        if (!disposed) {
          if (!g.messages.length) delete midtermQueue[key];
          saveLearning();
        }
      }
    }
  }

  async function refreshProfile(userId: string, now = Date.now()): Promise<void> {
    if (disposed || !notesCfg().profileAuto) return;
    if (!userId || profileBusy.has(userId)) return;
    const prev = ctx.memory.getAttr<{ text?: string; at?: number }>(userId, PROFILE_ATTR);
    // 内存里的节流 + 落库时间一起看：插件重载后不会把刚生成的画像再花一次模型重做
    const lastAt = Math.max(profileLastAt.get(userId) ?? 0, Number(prev?.at) || 0);
    if (now - lastAt < PROFILE_GAP_MS) return;
    const facts = ctx.memory.topFacts(userId, 20);
    if (facts.length < 3) return;
    profileBusy.add(userId);
    profileLastAt.set(userId, now);
    try {
      const resp = await ctx.llm.chat({
        model: '',
        messages: [
          { role: 'system', content: PROFILE_SYSTEM },
          { role: 'user', content: buildProfilePrompt(facts.map((f) => f.content), prev?.text) },
        ],
        stream: false,
      });
      if (disposed) return;
      const text = parseProfile(resp.content ?? '');
      if (text) {
        ctx.memory.setAttr(userId, PROFILE_ATTR, { text, at: now, facts: facts.length });
        ctx.log.info(`用户画像：${userId} 已更新`);
      }
    } catch (e) {
      ctx.log.warn(`用户画像生成失败（${userId}）：${(e as Error).message}`);
    } finally {
      profileBusy.delete(userId);
    }
  }

  async function sweepProfiles(): Promise<void> {
    if (disposed || !notesCfg().profileAuto) return;
    const now = Date.now();
    if (now - lastProfileSweep < 10 * 60_000) return;
    lastProfileSweep = now;
    for (const u of ctx.memory.listUsers().slice(0, 50)) {
      if (disposed) break;
      if (u.blocked) continue;
      await refreshProfile(u.userId, Date.now());
    }
  }

  // ---------- 工具 ----------
  // 2026-10-17 起 chat 工具面收窄为**记忆读写**（recall_facts / search_history / remember_setting）：
  // remember_fact / forget_me / plan_schedule / reply_quote 仍删除——
  //   · 用户事实的写入由后台自动提炼（memory-extract）承担；忘记走桌面端用户页；
  //   · 引用回复改由内核程序自动锚定触发消息（pipeline.quoteTargetOf），模型零成本；
  //   · 演化层（Overlay）的写入入口 2026-10-17 晚按用户要求加回（remember_setting，surface:'chat'：
  //     chat 面可见、work 面严格缺席——work 轮不套人格，演化层在那种语境里没有意义）。

  /**
   * 一轮之内的调用计数（键 = 会话 + 本轮事件 id/ts）。
   * 认不出是哪一轮就别计数（返回 1），否则这个群会被永久卡住。
   * 条数上限只防 Map 泄漏。
   */
  function perTurn(map: Map<string, number>, tctx: { chat: { chatId: string }; event: { id?: string; ts?: number } }): number {
    const turn = tctx.event.id ?? tctx.event.ts;
    if (turn === undefined) return 1;
    const tk = `${tctx.chat.chatId}|${turn}`;
    const n = (map.get(tk) ?? 0) + 1;
    map.set(tk, n);
    if (map.size > 400) map.clear();
    return n;
  }

  /**
   * 一轮之内的"查资料"预算（recall_facts + search_history 合计）。
   * 活体报文实测：模型会为了一句裸名字连查 5 次（每查多吃一轮），回复迟到半分钟，
   * 到达时对面已经换了话题。chat 轮现在两轮封顶（第二轮摘工具），预算再兜一层：
   * 超预算直接回一句劝它照字面回答。
   */
  const probeTurns = new Map<string, number>();
  const PROBE_MAX = 3;
  const probeQuota = (tctx: { chat: { chatId: string }; event: { id?: string; ts?: number } }) => perTurn(probeTurns, tctx);
  const overQuota = (n: number) => n > PROBE_MAX
    ? `（这一轮已经查过 ${PROBE_MAX} 次了，别再查：手上没有的信息就是没有，照对方这句的字面回答，或者反问一句。）` : '';

  /**
   * 一轮最多写一条演化：第一轮的并行工具调用可能一次带好几条，后面的直接拒掉——
   * 演化层容量 24 条，一口气刷满就把 Canon 挤没了。
   */
  const writeTurns = new Map<string, number>();
  const WRITE_MAX = 1;
  const overWriteQuota = (n: number) => n > WRITE_MAX
    ? '（这一轮已经写过一条演化了，别再写；把该说的话继续说完。）' : '';
  /** 戳一戳的会话内节流（进程内存，重启清零）：只做硬护栏，正不正常由模型按语境判断 */
  const pokeHits = new Map<string, number[]>();

  ctx.llm.registerTool({
    name: 'recall_facts',
    description: '检索 bot 为这位用户存过的长期事实（称呼、身份、喜好、约定、经历）。这些事实平时**不在上下文里**，要查才知道；凡对方提到「上次、以前、说好了的」而眼前信息对不上，就先查这里再回答。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索关键词' } },
      required: ['query'],
    },
    // 记忆读取类：chat 面唯一的工具类（内核对 chat 面只放 surface:'memory'，见 container.toolsForChat）
    surface: 'memory',
    // 这轮 work 面也用得上（work agent 白名单里有它），所以必须自带一行清单说明
    promptSnippet: '查这位用户的长期事实（称呼/身份/喜好/约定/经历）；这些事实不随上下文给出，要查才知道',
    handler: (args, tctx) => {
      const stop = overQuota(probeQuota(tctx));
      if (stop) return stop;
      const q = String(args.query ?? '');
      const facts = ctx.memory.searchFacts(tctx.event.userId, q, 5);
      if (!facts.length) return '（这位用户没有相关记忆——这事没记过，别换个词再查。）';
      return '找到的记忆：\n' + facts.map((f) => `- ${f.content}`).join('\n');
    },
  });

  // 上下文窗口外的旧消息平时看不到，这是她"翻旧账"的通道：按关键词搜本会话的历史原文。
  // 只搜当前会话（群/私聊各自独立），工具面不提供跨会话检索。
  // 只翻窗口**之外**的：把模型眼前就有的那几条当"新线索"还回去，它会认定还有前文没看到，
  // 于是换词连查四五次、每查一次多吃一轮，回复迟到半分钟（2026-10-16 活体报文实测）。
  ctx.llm.registerTool({
    name: 'search_history',
    description: '检索本会话更早的聊天记录原文（**上下文之外**的旧消息，带时间与说话人）。当话题涉及「之前、上次、我们说过什么」而最近几分钟的上下文不够时使用。只搜当前会话，按关键词匹配。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，在消息原文里匹配' },
        limit: { type: 'number', description: '最多返回几条，缺省 20' },
      },
      required: ['query'],
    },
    surface: 'memory',
    handler: (args, tctx) => {
      const q = String(args.query ?? '').trim();
      if (!q) return '（关键词为空）';
      const stop = overQuota(probeQuota(tctx));
      if (stop) return stop;
      const limit = Math.max(1, Math.min(Math.round(Number(args.limit) || 20), 50));
      let hits;
      try {
        hits = ctx.history.searchMessages(tctx.chat, q, limit, tctx.historyWindowStartTs);
      } catch (e) {
        return `（检索不可用：${(e as Error).message}）`;
      }
      if (!hits.length) return '（更早的记录里没有相关消息——这事没在你们之前聊过。）';
      const fmt = (ts: number) => {
        const d = new Date(ts);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      // 每条截 200 字：50 条 × 200 字封顶，别让一次翻旧账把上下文顶爆
      return `找到 ${hits.length} 条相关消息：\n` +
        hits.map((h) => `- [${fmt(h.ts)}] ${h.role === 'user' ? (h.nickname || '用户') : '我'}：${h.text.slice(0, 200)}`).join('\n');
    },
  });

  // 戳一戳（QQ 双击头像）：不是所有说话都要戳，是有明确指向/犯贱时的社交动作。
  // 指向性靠模型自己判断（它看得到「昵称：正文」与 @）；内核只做冷却与小时上限的硬护栏。
  ctx.llm.registerTool({
    name: 'poke',
    description: '戳一戳对方（QQ 里双击头像那个动作）。明确对着某个人说话、想吐槽/催/撒娇/犯贱时用；只是聊到某人、没有指向性时不要用。',
    surface: 'chat',
    promptSnippet: '戳一戳对方（QQ 双击头像）',
    promptGuidelines: [
      '只在有明确对象时戳：对方正在跟你说（点名、接你的话、@你）而你恰好想吐槽/催/撒娇/犯贱；不要在闲聊里随机戳人。',
      'target 填对方 QQ 号或最近说话人的昵称；私聊可以省略（默认对面）。一次回复最多戳一次，别连着戳同一个人。',
      '戳完不用在正文里描述这个动作，正常把话说完；对方没惹你也别拿它当打招呼。',
    ],
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '对方 QQ 号或最近说话人的昵称；私聊省略 = 对面' },
      },
    },
    handler: async (args, tctx) => {
      const cfg = ((ctx.config as Record<string, any>)?.humanlike?.poke ?? {}) as {
        enable?: boolean; minIntervalSeconds?: number; maxPerHour?: number;
      };
      if (cfg.enable === false) return '（戳一戳现在关着，别调用；用你自己的语气继续。）';
      const key = `${tctx.chat.type}_${tctx.chat.chatId}`;
      const now = Date.now();
      const hits = (pokeHits.get(key) ?? []).filter((t) => now - t < 3600_000);
      const minGap = Math.max(0, Number(cfg.minIntervalSeconds ?? 30)) * 1000;
      if (minGap && hits.length && now - hits[hits.length - 1] < minGap) {
        return '（刚戳过，最小间隔还没到；这一轮别戳，正常接话。）';
      }
      const max = Math.max(0, Number(cfg.maxPerHour ?? 6));
      if (max && hits.length >= max) return '（这一小时戳得够多了；别再戳，正常接话。）';
      try {
        const r = await ctx.chat.poke(tctx.chat, String(args.target ?? '').trim() || undefined);
        hits.push(now);
        pokeHits.set(key, hits);
        return `（已戳了戳 ${r.nickname || r.userId}。这一轮别再戳同一个人；正文里不用描述这个动作。）`;
      } catch (e) {
        // 错误只回给模型（别让它转述给用户）：戳不成就正常说话
        return `（没戳成：${(e as Error).message}。不要向对方提这个错误，接着正常说话。）`;
      }
    },
  });

  // ---------- 命令 ----------
  // 清除记忆**不再提供 QQ 侧入口**（2026-10-16 用户明令）：群里一句话就能清掉一个人的全部记忆，
  // 既容易被套也容易被自己手滑。入口只剩桌面端用户页（⋯ → 忘记我）。

  // ---------- Overlay 层（HDSI 的演化层） ----------
  // Canon 只由人写；长期剧情里渐进形成的稳定变化写在这里，非破坏性、可清、可追溯来源。
  // 写入由模型在聊天里随手提议（remember_setting），读/清在桌面端人格页（2026-10-17 QQ 指令面清空）。

  function overlayOf(personaId: string): OverlayEntry[] {
    const raw = ctx.state.get<OverlayEntry[]>(`overlay:${personaId}`, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((e) => e && typeof e.content === 'string'
      && (OVERLAY_LAYERS as readonly string[]).includes(String(e.layer)));
  }

  /** 写一条演化。同一层同一句话不重复记；超上限挤掉最旧的（Canon 不能被淹没）。 */
  function addOverlay(personaId: string, entry: { layer: OverlayEntry['layer']; targetId?: string; content: string; source?: string }): string {
    const content = entry.content.trim().slice(0, 160);
    if (!content) return '（内容为空，未写入）';
    const list = overlayOf(personaId);
    if (list.some((e) => e.layer === entry.layer && e.content === content)) return '（这句已经记过了）';
    list.push({ ...entry, content, at: Date.now() });
    while (list.length > OVERLAY_MAX) list.shift();
    ctx.state.set(`overlay:${personaId}`, list);
    return `（已写入「${OVERLAY_LAYER_LABEL[entry.layer]}」演化层：${content}）`;
  }

  function clearOverlay(personaId: string, layer?: string): number {
    const list = overlayOf(personaId);
    const kept = layer ? list.filter((e) => e.layer !== layer) : [];
    ctx.state.set(`overlay:${personaId}`, kept);
    return list.length - kept.length;
  }

  ctx.llm.registerTool({
    name: 'remember_setting',
    description: [
      '把长期聊天里稳定形成的新设定写进演化层。',
      '适用：性格被磨出了新的一面、和某人的关系定型、世界/环境有了既定变化。',
      '不适用：一次性的情绪、闲聊、你当场编的东西。写之前先问自己「这件事之后还成立吗」。',
      '每条要说得出来是从哪句话/哪件事推出来的，一句话讲完。一轮最多写一条，写完照常把该说的话说完。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: [...OVERLAY_LAYERS], description: 'character 性格 / world 世界 / relationship 关系 / perspective 价值观' },
        content: { type: 'string', description: '一句话，第三人称陈述句，如「她开始接受被叫小名」' },
        source: { type: 'string', description: '从哪句话或哪件事推出来的' },
      },
      required: ['layer', 'content'],
    },
    // chat 专用（surface:'chat'）：work 轮不套人格，演化层在那种语境里没有意义，必须严格缺席
    surface: 'chat',
    handler: (args, tctx) => {
      const layer = String(args.layer ?? '');
      if (!(OVERLAY_LAYERS as readonly string[]).includes(layer)) return `（layer 只能是 ${OVERLAY_LAYERS.join('/')}）`;
      const stop = overWriteQuota(perTurn(writeTurns, tctx));
      if (stop) return stop;
      return addOverlay(activePersonaId(), {
        layer: layer as OverlayEntry['layer'],
        targetId: layer === 'relationship' ? String(tctx.event.userId) : undefined,
        content: String(args.content ?? ''),
        source: String(args.source ?? '').slice(0, 120),
      });
    },
  });

  // ---------- beforeLLM：HDSI 式分层组装 ----------

  ctx.hooks.beforeLLM = (req: LLMRequestContext): LLMRequestContext => {
    const persona = personas.get(activePersonaId()) ?? personas.values().next().value;
    if (!persona) return req;
    const userId = req.event.userId;
    const role = req.event.role ?? 'member';
    markActive(req.chat);

    // 设定层按 HDSI 分层追加到 systemSections，各自独立节
    // （不整体覆盖 system：内核固定节——身份/会话/回复风格/剧本体/信任边界/压缩说明——全部保留）
    if (!req.systemSections) req.systemSections = [];
    const sections = req.systemSections;
    const canon = persona.canon.canon;

    // Canon：初始设定（剧情起点，只由人写）
    // —— 缓存裁量（2026-10-16 用户裁定①）：大块**跨轮稳定**的设定节全部排进 200~280，
    //    全部每轮变大块（lore 命中/对方是谁/本轮媒体等）留在 450+；供应商的前缀缓存
    //    遇变即断，稳定大块排在变量节后面就永远吃不到命中。
    sections.push({
      order: 200,
      title: 'script',
      text: [
        `# 剧本：${persona.canon.name}`,
        ...canon.protagonist,
        canon.world?.length ? `\n世界：\n${canon.world.map((w) => `- ${w}`).join('\n')}` : '',
        canon.cast?.length ? `\n配角（只是可用角色，不等于在场）：\n${canon.cast.map((c) => `- ${c.name}：${c.relation}`).join('\n')}` : '',
        canon.language ? `语言：${canon.language}` : '',
      ].filter(Boolean).join('\n'),
    });

    // Perspective：独立于 Canon 的个体价值观（HDSI 的"外壳人格层"）
    if (persona.canon.perspective?.trim()) {
      sections.push({
        order: 210,
        title: 'perspective',
        text: `# 她看世界的方式\n${persona.canon.perspective.trim()}`,
      });
    }

    // Overlay：演化层（长期剧情里稳定下来的变化；按既定事实对待，不要逐条念出来）。
    // 常驻（哪怕是空的）：模型得先知道这一层存在、入口是什么，才可能在合适的时候往里写。
    const own = overlayOf(persona.id).filter((e) => e.layer !== 'relationship' || !e.targetId || e.targetId === userId);
    sections.push({
      order: 220,
      title: 'overlay',
      text: [
        '# 长期演化',
        '- 长期相处里稳定形成的变化（性格磨出新的一面、关系定型、世界既定变化）记在这一层；下面已有的按既定事实对待，不要逐条念出来。',
        '- 确实沉淀出这种稳定变化时，用 remember_setting 写进来：一轮最多一条，每条要说得出来是从哪句话推出来的。一次性的情绪、闲聊、你当场编的东西不要写。',
        ...own.map((e) => `- [${OVERLAY_LAYER_LABEL[e.layer]}] ${e.content}`),
      ].join('\n'),
    });

    // 记忆（250，稳定区）：**事实列表不再随上下文给出**（2026-10-16 用户裁定）——长期事实由后台
    //  提炼落库，模型要用时经 recall_facts 现查，语义与压缩掉的旧历史一致：不在眼前，但查得到。
    //  这一节只剩指针，跨轮完全稳定，既省 token 也不破前缀缓存。chat 轮 2026-10-17 起两轮封顶：
    //  查一次就必须作答，所以这里写清"一次就够"。
    sections.push({
      order: 250,
      title: 'memory',
      text: [
        `# 关于该用户的记忆`,
        `bot 为这位用户记着的长期事实**不随上下文给出**（事实一多就会把眼前的对话挤掉）。需要时自己查：`,
        `- recall_facts <关键词>：查这位用户的长期事实（称呼、身份、喜好、约定、经历）。`,
        `- search_history <关键词>：翻本会话上下文之外的旧消息原文。`,
        `对方提到「上次、以前、说好了的」而眼前几分钟的上下文对不上时，**先查再答**，别凭空猜；一次就够，查不到就是真没有。`,
      ].join('\n'),
    });

    // Voice：说话方式 + 语气样例 + 尾部强化（260~280，全部稳定）。
    // 用户 2026-10-16 明令：语气样例**不能以上下文（user/assistant 假对话）的形式进请求**，
    // 必须在 system 里告诉它"这是语气样例"——模型才有机会既没把它们当真对话，也吃得到稳定前缀。
    // 样例是**短句聊天体**（2026-10-17 随剧本体删除改写）：一行一句、想分条就换行，不写旁白。
    const voice = persona.canon.voice;
    if (voice.style?.trim()) {
      sections.push({ order: 260, title: 'voice-style', text: `（说话方式：${voice.style.trim()}）` });
    }
    if (voice.examples?.length) {
      sections.push({
        order: 270,
        title: 'voice-examples',
        text: [
          `# 语气样例（不是正在进行的对话）`,
          `下面每一对是「群友这样说 → 你怎么回」的**示范**，供你学口吻和"说多长、什么时候分条"的感觉；它们不是发生过的对话，内容也别照抄。`,
          ...voice.examples.slice(0, 6).map((ex) => `【对方说】${ex.user}\n【你回】${ex.assistant}`),
        ].join('\n'),
      });
    }
    if (voice.post_history?.trim()) {
      // 2026-10-18 反重复：当前 canon 的 protagonist 与 post_history 是同一整段，
      // 逐字注入两次会把「梁文峰」这类人设名字强化两遍。归一化后相同/互为子串就跳过尾部强化；
      // 以后把 post_history 改成真正的短强化语时照常注入。
      const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
      const post = norm(voice.post_history.trim());
      const main = norm(canon.protagonist.join('\n'));
      const duplicate = !!post && (post === main || main.includes(post) || post.includes(main));
      if (!duplicate) {
        sections.push({
          order: 280,
          title: 'post-history',
          text: voice.post_history.trim(),
        });
      }
    }

    // 变量区（≥450，每一轮都可能变的前置排完，稳定前缀吃到这一节为止）：

    // 458 用户画像：当前发言者的背景印象（不是事实列表；事实仍走 recall_facts 现查）
    const relayTurn = isRelayTurn(req);
    if (!relayTurn && notesCfg().profileAuto) {
      const prof = ctx.memory.getAttr<{ text?: string }>(userId, PROFILE_ATTR);
      const text = profileSection(prof?.text ?? '');
      if (text) sections.push({ order: 458, title: 'user-profile', text });
    }

    // 465 中期回想：已经滑出时间窗的那段聊天，只当背景
    if (!relayTurn && notesCfg().midtermSummary) {
      const text = midtermSection(midtermStore[chatKeyOf(req.chat)]);
      if (text) sections.push({ order: 465, title: 'midterm-recall', text });
    }

    // 474 表达学习：本群真实出现过的说法，参考口吻，不照抄
    if (!relayTurn && exprCfg().enable) {
      const entries = exprStore[chatKeyOf(req.chat)] ?? [];
      if (Array.isArray(entries) && entries.length) {
        const recent = [req.event.text, ...req.messages.slice(-8).map((m) => m.content)].join('\n');
        const text = expressionSection(selectExpressions(entries, recent, exprCfg().injectMax));
        if (text) sections.push({ order: 474, title: 'expressions', text });
      }
    }

    // Lore：关键词命中的世界事实（常驻 + 命中）——按轮命中，是变量
    const recentText = [req.event.text, ...req.messages.slice(-8).map((m) => m.content)].join('\n');
    const matched = persona.canon.lore
      .filter((e) => e.constant || e.keys.some((k) => recentText.toLowerCase().includes(k.toLowerCase())))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    if (matched.length) {
      sections.push({
        order: 473,
        title: 'lorebook',
        text: '# 世界事实（相关背景）\n' + matched.map((e) => `- ${e.content}`).join('\n'),
      });
    }

    // L5 状态注入：这一轮对面是谁（身份与权限）——每轮变，457
    sections.push({
      order: 457,
      title: 'speaker-role',
      text: [
        `# 对方是谁（本次发言的用户 ${req.event.nickname || userId}）`,
        `- 权限等级：${role === 'owner' ? 'owner（bot 的主人）' : role === 'admin' ? 'admin（群管理员）' : 'member（普通成员）'}${role === 'owner' ? '。这是你的主人，可以切换人格与管理插件。' : ''}`,
      ].join('\n'),
    });

    // 消息数组回归干净：没有 few-shot 假对话、没有中途 system 尾巴（toPiMessages 那套摘尾部逻辑不再需要）
    return { ...req, messages: [...req.messages] };
  };

  // ---------- afterLLM：L6 输出校验插槽 ----------

  ctx.hooks.afterLLM = (req: LLMRequestContext, reply: string, opts?: { sideEffects?: boolean }): string => {
    // 规则式轻校验：阻止配置内容外泄的兜底（LLM 校验器插槽留待接入轻量模型）
    let out = reply;
    const leakPatterns = [
      /system\s*prompt/i, /system_prompt/i, /post_history_instructions/i, /人设卡[:：]/, /世界书[:：]/, /【人格强化/,
      // 分层设定（剧本 / 演化层 / 看世界的方式）也是配置内容，同样不许念出来
      /剧本[:：]/, /长期演化/, /看世界的方式/,
    ];
    for (const re of leakPatterns) {
      if (re.test(out)) {
        ctx.log.warn(`afterLLM 校验：回复疑似泄露配置内容，已拦截改写（${req.event.userId}）`);
        out = '（把话头咽了回去）这个可不能告诉你哦。';
        break;
      }
    }
    // TODO: L6 完整实现——用轻量模型按人设卡核对语气/称呼/越界内容后重写
    // 重复惩罚的重写只借用校验；原回复已经入过队，别把重写再算一轮记忆
    if (opts?.sideEffects !== false) queueTurn(req, out);
    return out;
  };

  // ---------- 自动记忆提炼（后台，不进上下文） ----------
  // 每轮对话先攒进插件 KV；某个人安静下来（idleSeconds）且攒够 minTurns 轮，才单独发一次
  // 「记忆整理」请求给模型，回来的几条写进 user_facts（权重 0.5 = 自动）。
  // 与上下文压缩同一条思路：原文不长期留着，摘要进可检索的库，用的时候现查。

  const MEMQ_KEY = 'memory_queue';
  function memCfg(): ExtractCfg {
    const p = (ctx.config as any)?.persona ?? {};
    return {
      autoSave: p.memoryAutoSave !== false,
      minTurns: clampInt(p.memoryMinTurns, 2, 40, 6),
      idleSeconds: clampInt(p.memoryIdleSeconds, 10, 3600, 180),
      maxFacts: clampInt(p.memoryMaxFacts, 1, 10, 5),
    };
  }
  const readQueue = () => { const q = ctx.state.get<ExtractQueue>(MEMQ_KEY, {}); return q && typeof q === 'object' ? q : {}; };
  function queueTurn(req: LLMRequestContext, reply: string): void {
    try {
      if (!memCfg().autoSave) return;
      const user = String(req.event.text ?? '').trim();
      if (!user) return;   // 主动发言轮没有对方说的话，不配开一组
      const q = readQueue();
      pushTurn(q, String(req.event.userId), String(req.chat.chatId), {
        ts: Date.now(), user: user.slice(0, 500), reply: String(reply ?? '').slice(0, 500),
      });
      ctx.state.set(MEMQ_KEY, q);
      void sweepMemory();   // 顺手扫一遍：上一组刚好静默够久的话，不必等下一拍
    } catch (e) {
      ctx.log.warn(`记忆队列写入失败：${(e as Error).message}`);
    }
  }
  async function sweepMemory(): Promise<void> {
    const cfg = memCfg();
    if (!cfg.autoSave) return;
    const q = readQueue();
    for (const g of dueGroups(q, Date.now(), cfg)) {
      const turns = claimTurns(q, g);
      ctx.state.set(MEMQ_KEY, q);   // 先落 running 标记，别被下一拍重复领走
      let ok = false;
      try {
        const existing = ctx.memory.topFacts(g.userId, 50).map((f) => f.content);
        const resp = await ctx.llm.chat({
          model: '',
          messages: [
            { role: 'system', content: EXTRACT_SYSTEM },
            { role: 'user', content: buildExtractPrompt(turns, existing, cfg.maxFacts) },
          ],
          stream: false,
        });
        // 成功与否以"解析出的条目"为准；一条都没有也算这次提炼走通了（NONE 就是正常答案）
        const facts = parseFacts(resp.content ?? '', existing, cfg.maxFacts);
        for (const c of facts) ctx.memory.addFact(g.userId, { content: c, sourceChat: g.chatId, weight: AUTO_FACT_WEIGHT });
        ok = true;
        if (facts.length) {
          ctx.log.info(`自动记忆：为 ${g.userId} 记下 ${facts.length} 条`);
          // 事实变了就顺手刷新画像（内部有 30 分钟节流；失败不影响记忆主流程）
          void refreshProfile(g.userId);
        }
      } catch (e) {
        ctx.log.warn(`自动记忆提炼失败（${g.userId}，第 ${g.fails + 1} 次）：${(e as Error).message}`);
      }
      // 模型那一下 await 期间可能有新轮进队列，落盘前重读一次再结算，别把新轮覆盖掉
      const q2 = readQueue();
      settle(q2, g, ok);
      ctx.state.set(MEMQ_KEY, q2);
    }
  }
  // 10s 一拍只是"别忘了有人安静下来了"的兜底（每轮回复后还会顺手扫一次）；
  // 真正的门槛在 dueGroups（轮数 + 静默时长）里，空转一次只读一条 KV。
  ctx.setInterval(() => { void sweepMemory(); }, 10_000);

  // ---------- beforeWorkLLM：work 轮的记忆指针 ----------
  // work 轮不套人格，但发消息的人的记忆照样该查得到（2026-10-16 修：work 面此前完全看不到记忆）。
  // 只在 recall_facts 真在这轮工具面里时才说这句话——子代理的面更窄，别教它用没有的工具。
  ctx.hooks.beforeWorkLLM = (req: LLMRequestContext): LLMRequestContext => {
    if (!req.tools.some((t) => t.name === 'recall_facts')) return req;
    const sections = req.systemSections ?? (req.systemSections = []);
    sections.push({
      order: 1000,
      title: 'memory',
      text: [
        `# 关于发消息这位用户的记忆`,
        `bot 为 TA 记着的长期事实不随上下文给出。任务里用到「他的偏好、以前说好的事、称呼」这类信息时，`,
        `先调 recall_facts <关键词> 查，查不到就按合理假设做并把假设写进交付说明。`,
      ].join('\n'),
    });
    return req;
  };

  // ---------- 演化层（桌面端人格页读/清，经 API 一问一答） ----------
  // 演化层存在插件的 state 里，内核 API 读不到，所以走 bus 回旋：
  // 请求带 requestId，插件把结果用 persona.overlay_reply 发回来。

  ctx.bus.on('persona.overlay_request', (payload: { requestId: string; personaId?: string; op?: string; layer?: string; requesterRole?: string }) => {
    if (!payload?.requestId) return;
    const pid = payload.personaId && personas.has(payload.personaId) ? payload.personaId : activePersonaId();
    let removed: number | undefined;
    if (payload.op === 'clear') {
      if (payload.requesterRole !== 'owner') return;   // 改设定仅主人（红线 §2.1）
      removed = clearOverlay(pid, payload.layer);
    }
    ctx.bus.emit('persona.overlay_reply', { requestId: payload.requestId, personaId: pid, entries: overlayOf(pid), removed });
  });

  // ---------- 人格文件编辑（桌面端人格管理页调用，经 API） ----------

  ctx.bus.on('persona.edit_request', (payload: { personaId: string; file: string; content: string; requesterRole: string }) => {
    // 每条路径都要回 edit_done：API 在等它（3s 超时会报"没有收到插件响应"），
    // 只写日志不回话，桌面端就会在**已经保存成功**的情况下弹一句失败。
    const done = (ok: boolean, error?: string) => ctx.bus.emit('persona.edit_done', { ok, error });
    if (payload.requesterRole !== 'owner') return done(false, '仅主人可改人格文件');   // 人设内容仅主人可改（红线 §2.1）
    const p = personas.get(payload.personaId);
    if (!p) return done(false, `没有名为 ${payload.personaId} 的人格`);
    if (payload.file !== 'canon.json') return done(false, `不允许写 ${payload.file}（目前只开放 canon.json）`);
    const content = typeof payload.content === 'string' ? payload.content : '';
    try {
      const parsed = JSON.parse(content);
      if (!parsed?.canon || !Array.isArray(parsed.canon.protagonist)) {
        return done(false, 'canon.json 缺少 canon.protagonist（主角记号那一段）');
      }
      writeFileSync(join(p.dir, payload.file), content, 'utf-8');
      loadPersonas();
      ctx.log.info(`人格 ${payload.personaId}/${payload.file} 已更新并热加载`);
      done(true);
    } catch (e) {
      const msg = (e as Error).message;
      ctx.log.error(`人格文件保存失败: ${msg}`);
      done(false, `保存失败：${msg}`);
    }
  });

  // ---------- 新建人格（桌面端人格页右上角 + 号，经 API） ----------

  ctx.bus.on('persona.create_request', (payload: { personaId: string; name: string; requesterRole: string }) => {
    const done = (ok: boolean, error?: string) => ctx.bus.emit('persona.create_done', { ok, error });
    if (payload.requesterRole !== 'owner') return done(false, '仅主人可新建人格');
    const id = String(payload.personaId ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) return done(false, '人格 id 需为小写字母/数字/连字符（2~31 位）');
    const dir = join(here, 'personas', id);
    if (existsSync(dir)) return done(false, `人格 ${id} 已存在`);
    const name = String(payload.name ?? '').trim().slice(0, 40) || id;
    try {
      mkdirSync(dir);
      const write = (f: string, obj: unknown) => writeFileSync(join(dir, f), JSON.stringify(obj, null, 2) + '\n', 'utf-8');
      write('canon.json', {
        name,
        canon: { protagonist: ['PERSONA_LOAD', id.toUpperCase()], world: [], cast: [], language: '简体中文。' },
        perspective: '',
        voice: { style: '', examples: [], post_history: '' },
        lore: [],
      });
      loadPersonas();
      ctx.log.info(`人格 ${id}（${name}）已创建`);
      done(true);
    } catch (e) {
      done(false, (e as Error).message);
    }
  });

  // ---------- 后台学习接线 ----------
  // onChatMessage 只在本插件对这群生效时触发；用它把"活跃会话"圈出来，
  // 后续 session.log 再按这个集合过滤——不学没在聊的群，也不替别人攒数据。
  ctx.hooks.onChatMessage = (event) => { markActive(event); };
  // 群里把 chat 插件关掉后就不再学习：activeChats 只是"学习范围"，不是权限本身，
  // 但它不清会让关掉的群继续被后台摘要/学说法。
  ctx.on('plugin.state_changed', (p: { id?: string; chatId?: string; enabled?: boolean }) => {
    if (p?.id !== 'chat') return;
    if (!p.chatId) { activeChats.clear(); return; }
    activeChats.delete(`group_${p.chatId}`);
    activeChats.delete(`private_${p.chatId}`);
    if (p.enabled === false && p.chatId) {
      // 关掉就停学：丢掉未消化的队列；已经学到的说法/回想留着，重新打开还能用
      delete exprQueue[`group_${p.chatId}`];
      delete midtermQueue[`group_${p.chatId}`];
      delete midtermQueue[`private_${p.chatId}`];
      learningDirty = true;
      saveLearning();
    }
  });
  ctx.on('session.log', (entry: SessionLogEntry) => {
    try { observeLearning(entry); } catch (e) {
      ctx.log.warn(`学习观察失败：${(e as Error).message}`);
    }
  });
  // 10s 一拍：只做内存判定（条数/静默/间隔），到点才发模型请求；学习状态顺带落盘。
  ctx.setInterval(() => {
    void sweepExpressions();
    void sweepMidterm();
    saveLearning();
  }, 10_000);
  ctx.setTimeout(() => { void sweepProfiles(); }, 30_000);
  ctx.setInterval(() => { void sweepProfiles(); }, 10 * 60_000);

  ctx.state.set('_personas_ready', true);
}
