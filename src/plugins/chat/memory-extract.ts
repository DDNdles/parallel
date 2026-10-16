/**
 * 自动记忆提炼（chat 插件的后台通道）
 *
 * 语义照"上下文压缩"那一套：对话原文不在上下文里长期留着，而是**攒一批 → 交给模型摘成几条
 * 稳定事实 → 落进 user_facts**；模型平时看不到这些事实（不占上下文、不破前缀缓存），
 * 要用时经 recall_facts 现查。
 *
 * 这里只放纯逻辑（排队/到期判定/提示词/解析去重），模型调用与定时器在 index.ts 里接，
 * 为的是这份逻辑能单测——真模型返回什么格式不可控，边界必须钉死。
 */

export interface ExtractTurn { ts: number; user: string; reply: string }
export interface ExtractGroup { userId: string; chatId: string; turns: ExtractTurn[]; fails: number; running?: boolean }
export type ExtractQueue = Record<string, ExtractGroup>;

export interface ExtractCfg { autoSave: boolean; minTurns: number; idleSeconds: number; maxFacts: number }

/** 每组最多攒这么多轮：提炼一直失败时不让它无限膨胀（超了丢最旧的） */
export const QUEUE_MAX_TURNS = 40;
/** 连败这么多次就丢掉这一组，别再拿同一坨坏输入反复烧模型 */
export const MAX_FAILS = 3;
/** 单条事实的长度上限（模型不听话时兜底） */
export const FACT_MAX_CHARS = 80;

const keyOf = (userId: string, chatId: string) => `${userId}|${chatId}`;

/** 追加一轮对话到待提炼队列（原地改，调用方负责持久化） */
export function pushTurn(queue: ExtractQueue, userId: string, chatId: string, turn: ExtractTurn): ExtractQueue {
  const key = keyOf(userId, chatId);
  const g = queue[key] ?? { userId, chatId, turns: [], fails: 0 };
  g.turns.push(turn);
  if (g.turns.length > QUEUE_MAX_TURNS) g.turns.splice(0, g.turns.length - QUEUE_MAX_TURNS);
  queue[key] = g;
  return queue;
}

/** 到点该提炼的组：攒够轮数 + 对话已静默（避开正在进行的对话），正在跑的跳过 */
export function dueGroups(queue: ExtractQueue, now: number, cfg: ExtractCfg): ExtractGroup[] {
  return Object.values(queue).filter((g) =>
    !g.running
    && g.turns.length >= cfg.minTurns
    && now - g.turns[g.turns.length - 1].ts >= cfg.idleSeconds * 1000);
}

/** 取走这一组待提炼的轮并标成在跑（期间新到的轮留下一次扫描） */
export function claimTurns(queue: ExtractQueue, g: ExtractGroup): ExtractTurn[] {
  const group = queue[keyOf(g.userId, g.chatId)];
  if (!group) return [];
  group.running = true;
  return group.turns.slice();
}

/** 模型返回后：成功就把这批轮丢掉，失败就留着重试（连败到上限直接丢组，别让坏输入卡死队列） */
export function settle(queue: ExtractQueue, g: ExtractGroup, ok: boolean): void {
  const key = keyOf(g.userId, g.chatId);
  const group = queue[key];
  if (!group) return;
  if (ok) {
    const done = group.turns.length;
    group.turns.splice(0, done);
    group.fails = 0;
    group.running = false;
    if (!group.turns.length) delete queue[key];
    return;
  }
  group.running = false;
  group.fails += 1;
  if (group.fails >= MAX_FAILS) delete queue[key];
}

/** 系统提示词。开头那句「你是记忆整理助手」是 mock 引擎认这份请求的标记（与压缩摘要同一条口径），别改字面 */
export const EXTRACT_SYSTEM = [
  '你是记忆整理助手。给你一段 bot 与某位 QQ 用户的对话，你要挑出值得长期记住的关于**这位用户**的事实。',
  '规则：',
  '- 只记稳定事实：称呼/身份、长期喜好、明确的约定、重要经历、忌口与禁忌。',
  '- 不记一次性情绪、闲聊、当下在做什么、以及 bot 自己说的话里的信息。',
  '- 与「已经记住的」重复或同义改写的，一律不要再输出。',
  '- 每条一行，不超过 40 字，用第三人称陈述句，不要引号、不要前缀说明。',
  '- 没有值得记的就只输出 NONE。',
].join('\n');

export function buildExtractPrompt(turns: ExtractTurn[], existing: string[], maxFacts: number): string {
  const said = turns.map((t) => `用户：${t.user}\n我：${t.reply}`).join('\n');
  return [
    existing.length ? `已经记住的：\n${existing.map((c) => `- ${c}`).join('\n')}` : '已经记住的：（无）',
    '',
    `对话原文（共 ${turns.length} 轮）：`,
    said,
    '',
    `最多输出 ${maxFacts} 行新事实，每行一条；没有就输出 NONE。`,
  ].join('\n');
}

/** 归一化：只留字母数字与汉字，用于"同一条事实"的判定 */
const norm = (s: string) => s.toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/g, '');

/**
 * 解析模型输出 → 可写入的事实列表。
 * 砍掉列表符号与引号、丢空行与 NONE、跳过与已有记忆同条的、批内去重、限长限量。
 */
export function parseFacts(text: string, existing: string[], cap: number): string[] {
  const seen = new Set(existing.map(norm).filter(Boolean));
  const out: string[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim().replace(/^[-*•\d]+\s*[.、)：:]\s*/, '').replace(/^[-*•]\s*/, '').trim();
    line = line.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    if (!line || /^none$/i.test(line) || /^无$/.test(line)) continue;
    const k = norm(line);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(line.slice(0, FACT_MAX_CHARS));
    if (out.length >= cap) break;
  }
  return out;
}
