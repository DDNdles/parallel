/**
 * 后台笔记：用户画像 + 中期聊天摘要（chat 插件的两条后台通道）。
 *
 * 画像：从长期事实生成一段短印象，挂在当前发言者身上注入。它比事实列表更轻，
 *       模型一眼知道"这个人是谁、怎么相处"，不用每轮先查一次。
 * 回想：把已经滑出上下文时间窗的聊天压成一段摘要 + 召回线索。它只做背景，
 *       眼前的消息永远优先；不得把摘要当正在发生的事复述。
 *
 * 纯逻辑（提示词 / 解析 / 分节）在这里，模型调用与队列在 index.ts。
 */

export interface MidtermMessage {
  ts: number;
  role: 'user' | 'assistant';
  who: string;
  text: string;
}

export interface MidtermEntry {
  summary: string;
  cues: string[];
  fromTs: number;
  toTs: number;
  updatedAt: number;
}

export interface ProfileEntry {
  text: string;
  at: number;
  facts: number;
}

export const PROFILE_SYSTEM = [
  '你是用户画像整理助手。给你一些 bot 长期记下的、关于某位 QQ 用户的事实，写一段**短画像**。',
  '规则：',
  '- 只写稳定特征：称呼/身份、长期喜好、说话与相处方式、明确的约定或禁忌。',
  '- 不写一次性情绪、当下正在做什么、以及不确定的猜测。',
  '- 不超过 120 字，一段话，第三人称；不要罗列事实，不要编造。',
  '- 没有足够信息就只输出 NONE。',
].join('\n');

export function buildProfilePrompt(facts: string[], previous?: string): string {
  return [
    previous?.trim() ? `上一版画像（可以在此基础上更新）：\n${previous.trim()}\n` : '',
    '长期事实：',
    ...facts.slice(0, 20).map((f) => `- ${f}`),
    '',
    '写一段不超过 120 字的画像；信息不够就输出 NONE。',
  ].filter((x) => x !== '').join('\n');
}

/** 画像输出清洗：去前缀/引号、压成一行、限长；NONE → null */
export function parseProfile(text: string): string | null {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(画像|用户画像|profile)\s*[:：]\s*/i, '');
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (!t || /^none$/i.test(t) || /^无$/.test(t)) return null;
  return t.slice(0, 160);
}

export const MIDTERM_SYSTEM = [
  '你是聊天回想整理助手。给你一段**更早的聊天记录**（已经从眼前上下文中滑走），把它压成一段背景回想。',
  '规则：',
  '- 保留人物关系、正在推进的事、约定、反复出现的梗/黑话、没聊完的话题。',
  '- 不编造、不评价、不替 bot 决定下一句说什么。',
  '- 摘要不超过 200 字；另外给 3~6 个召回线索（关键词），方便之后按话题想起它。',
  '只输出一行 JSON：{"summary":"...","cues":["..."]}',
].join('\n');

export function buildMidtermPrompt(messages: MidtermMessage[], previous?: MidtermEntry): string {
  return [
    previous?.summary
      ? `更早之前的回想（本次区间从它之后开始，请合并成一段）：\n${previous.summary}\n`
      : '',
    `这次要整理的聊天（共 ${messages.length} 条，按时间正序）：`,
    ...messages.map((m) => `${m.role === 'assistant' ? '我' : (m.who || '群友')}：${m.text}`),
    '',
    '输出一行 JSON：{"summary":"...","cues":["..."]}',
  ].filter((x) => x !== '').join('\n');
}

function pickJson(text: string): unknown {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const candidates = [raw];
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  return null;
}

/** 摘要输出解析：JSON 优先；模型不听话时把整段当摘要（没有线索），空/NONE → null */
export function parseMidterm(text: string): { summary: string; cues: string[] } | null {
  const payload = pickJson(text);
  if (payload && typeof payload === 'object') {
    const o = payload as { summary?: unknown; cues?: unknown };
    const summary = String(o.summary ?? '').replace(/\s+/g, ' ').trim();
    const cues = Array.isArray(o.cues)
      ? [...new Set(o.cues.map((c) => String(c ?? '').trim()).filter(Boolean))].slice(0, 6)
      : [];
    if (!summary || /^none$/i.test(summary)) return null;
    return { summary: summary.slice(0, 600), cues };
  }
  const plain = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!plain || /^none$/i.test(plain)) return null;
  return { summary: plain.slice(0, 600), cues: [] };
}

/** 中期回想分节：背景，不是正在发生的事 */
export function midtermSection(entry: MidtermEntry): string | null {
  if (!entry?.summary?.trim()) return null;
  return [
    '# 更早的聊天（背景回想）',
    entry.summary.trim(),
    '这只是背景；正在说的话以眼前的消息为准。别主动提「摘要、回想」这类内部词。',
  ].join('\n');
}

/** 用户画像分节：背景印象，不逐条念 */
export function profileSection(profile: string): string | null {
  const t = String(profile ?? '').trim();
  if (!t) return null;
  return [
    '# 你对对方的印象（背景）',
    t,
    '这是长期相处攒下来的印象，别逐条念出来；和眼前的话对不上时，以眼前为准。',
  ].join('\n');
}
