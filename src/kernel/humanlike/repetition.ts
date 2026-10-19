/**
 * 重复惩罚 —— 词面级反重复（2026-10-18）。
 *
 * 解决的问题：bot 会在不同轮里反复说同一个词/口癖，或反复提人设里的名字/设定
 * （典型：动不动就提「梁文峰」）。`rhythm.ts` 只看结构（气泡数/尾标点/字数），
 * 这里看**词**：最近若干轮 bot 自己的发言里，哪些短语出现得过多。
 *
 * 判定不是简单的词频：
 *  - 只算最近 windowMessages 轮 bot 发言；
 *  - 同一短语至少出现在 minMessages 个不同轮里；
 *  - 与最近入站消息对比，群里也在聊的话题词不算口癖；
 *  - 选最长词（「梁文峰」优先于「梁文」「文峰」）；
 *  - 命中后进冷却，提醒最多 5 分钟一次；重写成功即解除，连续失败到 maxStrikes 就停止重写。
 *
 * 纯函数；状态由 HumanlikeService 持有。
 */

export interface RepetitionText {
  at: number;
  text: string;
}

export interface RepetitionConfig {
  enable: boolean;
  /** 最近多少轮 bot 发言参与判定 */
  windowMessages: number;
  /** 至少在多少个不同轮里出现才判定 */
  minMessages: number;
  /** 命中后的冷却分钟数 */
  cooldownMinutes: number;
  /** 一次最多提醒/重写几个词 */
  maxPhrases: number;
  /** 命中后是否重写一次 */
  retry: boolean;
  /** 重写连续失败多少次后停止重写（仍保留提醒/冷却） */
  maxStrikes: number;
}

export interface RepetitionHit {
  phrase: string;
  /** 出现该词的不同 bot 轮数 */
  selfMsgs: number;
  /** bot 发言里的总出现次数 */
  selfCount: number;
  /** 出现该词的不同入站消息数 */
  inMsgs: number;
}

export interface AntiRepeatEntry {
  phrase: string;
  untilAt: number;
  strikes: number;
  lastNudgeAt: number;
  selfMsgs: number;
  inMsgs: number;
  retryExhausted: boolean;
}

/** 提醒之间至少隔这么久（避免提醒本身变成新口癖） */
export const REPETITION_NUDGE_GAP_MS = 5 * 60_000;
/** 单轮/单条文本参与判定的最大长度（防一条长文生成海量 n-gram） */
const MAX_TEXT_CHARS = 300;

/** 这些词太常见，不当作口癖（2~4 字中文与常见英文） */
const STOPWORDS = new Set([
  '这个', '那个', '什么', '怎么', '怎样', '如何', '为什么', '因为', '所以', '但是', '就是', '不是',
  '可以', '我们', '你们', '他们', '她们', '自己', '现在', '时候', '真的', '知道', '觉得', '应该',
  '已经', '还是', '这么', '那么', '一个', '没有', '有点', '感觉', '事情', '东西', '这样', '那样',
  '然后', '如果', '虽然', '而且', '或者', '其实', '可能', '一会儿', '一下', '一点', '一直', '一起',
  '出来', '回来', '过来', '起来', '下来', '上去', '出去', '进去', '这里', '那里', '这儿', '那儿',
  '哪里', '今天', '明天', '昨天', '现在', '哈哈', '哈哈哈', '好的', '嗯嗯', '谢谢', '你好', '在吗',
  '有人', '一样', '是不是', '有没有', '能不能', '要不要', '可不可以', '对不对', '好不好', '行不行',
  '我觉得', '我感觉', '你说', '我说', '他说', '她说', '大家', '群友', '朋友', '时间', '地方',
  '问题', '办法', '方法', '意思', '内容', '情况', '样子', '心里', '嘴上', '这么', '什么',
  'the', 'and', 'for', 'are', 'you', 'your', 'this', 'that', 'with', 'not', 'but', 'from',
  'have', 'was', 'were', 'will', 'can', 'just', 'like', 'now', 'then', 'when', 'what', 'who',
  'how', 'why', 'its', 'is', 'at', 'on', 'do', 'does', 'did', 'so', 'if', 'as', 'of', 'or',
  'in', 'to', 'be', 'me', 'my', 'we', 'us', 'up', 'out', 'no', 'yes', 'ok', 'qq', 'bot', 'ai',
]);

/** 去掉引用/记录/媒体/URL/@ 与标点，只留中文、英文、数字；英文转小写 */
export function normalizeRepetitionText(text: unknown): string {
  return String(text ?? '')
    .slice(0, MAX_TEXT_CHARS * 2)
    .replace(/\[(?:CQ:[^\]]+|回复[^\]]*|聊天记录[^\]]*|图片[^\]]*|语音[^\]]*|视频[^\]]*|文件[^\]]*|表情[^\]]*|卡片[^\]]*)\]/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/[^\u4e00-\u9fff0-9a-z]+/gi, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_TEXT_CHARS);
}

/**
 * 候选短语：中文连续段取 2~8 字 n-gram；英文/数字词取 2~16 字符。
 * 停用词、纯数字、单字不产出。
 */
export function extractRepetitionCandidates(text: unknown): string[] {
  const norm = normalizeRepetitionText(text);
  const out = new Set<string>();
  for (const run of norm.match(/[\u4e00-\u9fff]+|[a-z0-9_]+/g) ?? []) {
    if (/^[a-z0-9_]+$/.test(run)) {
      if (run.length >= 2 && run.length <= 16 && !STOPWORDS.has(run)) out.add(run);
      continue;
    }
    const chars = [...run];
    const max = Math.min(8, chars.length);
    for (let len = 2; len <= max; len++) {
      for (let i = 0; i + len <= chars.length; i++) {
        const g = chars.slice(i, i + len).join('');
        if (!STOPWORDS.has(g)) out.add(g);
      }
    }
  }
  return [...out];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * 从最近 bot 发言里找反复出现的短语。
 * 入站频率对比：群里也在说的词不罚，避免把话题词当口癖。
 */
export function detectRepetition(
  selfTexts: RepetitionText[],
  inboundTexts: RepetitionText[],
  cfg: RepetitionConfig,
): RepetitionHit[] {
  if (!cfg.enable) return [];
  const window = Math.max(1, Math.round(cfg.windowMessages));
  const min = Math.max(2, Math.round(cfg.minMessages));
  const self = selfTexts.slice(-window).map((x) => normalizeRepetitionText(x.text)).filter(Boolean);
  if (self.length < min) return [];
  const inbound = inboundTexts.slice(-window).map((x) => normalizeRepetitionText(x.text)).filter(Boolean);

  const stats = new Map<string, { selfMsgs: number; selfCount: number; inMsgs: number }>();
  for (const text of self) {
    const seen = new Set<string>();
    for (const phrase of extractRepetitionCandidates(text)) {
      let st = stats.get(phrase);
      if (!st) {
        st = { selfMsgs: 0, selfCount: 0, inMsgs: 0 };
        stats.set(phrase, st);
      }
      if (!seen.has(phrase)) {
        st.selfMsgs++;
        seen.add(phrase);
      }
      st.selfCount += countOccurrences(text, phrase);
    }
  }
  for (const text of inbound) {
    const seen = new Set<string>();
    for (const phrase of extractRepetitionCandidates(text)) {
      const st = stats.get(phrase);
      if (!st || seen.has(phrase)) continue;
      st.inMsgs++;
      seen.add(phrase);
    }
  }

  const hits: RepetitionHit[] = [];
  for (const [phrase, st] of stats) {
    if (st.selfMsgs < min) continue;
    // 群里也在聊的不罚；只罚 bot 自己明显说得比群里多的词
    if (!(st.selfMsgs > st.inMsgs * 1.5)) continue;
    hits.push({ phrase, selfMsgs: st.selfMsgs, selfCount: st.selfCount, inMsgs: st.inMsgs });
  }

  hits.sort((a, b) =>
    b.selfMsgs - a.selfMsgs
    || [...b.phrase].length - [...a.phrase].length
    || b.selfCount - a.selfCount
    || a.phrase.localeCompare(b.phrase));
  const selected: RepetitionHit[] = [];
  for (const hit of hits) {
    // 已经选了更长的词（且它包含当前候选）就不再重复报子串
    if (selected.some((s) => s.phrase.includes(hit.phrase))) continue;
    selected.push(hit);
    if (selected.length >= Math.max(1, Math.round(cfg.maxPhrases))) break;
  }
  return selected;
}

/** 生效中的冷却词（按剩余冷却时间排序） */
export function activeAntiRepeat(state: AntiRepeatEntry[], now: number): AntiRepeatEntry[] {
  return state
    .filter((e) => e.untilAt > now)
    .sort((a, b) => b.untilAt - a.untilAt);
}

/** 把本轮命中的词写进冷却状态；新词建冷却，旧词延长 */
export function touchAntiRepeat(
  state: AntiRepeatEntry[],
  hits: RepetitionHit[],
  now: number,
  cfg: RepetitionConfig,
): AntiRepeatEntry[] {
  const by = new Map(state.map((e) => [e.phrase, { ...e }] as const));
  const cooldown = Math.max(1, Math.round(cfg.cooldownMinutes)) * 60_000;
  for (const hit of hits) {
    const old = by.get(hit.phrase);
    if (old) {
      old.untilAt = Math.max(old.untilAt, now + cooldown);
      old.selfMsgs = hit.selfMsgs;
      old.inMsgs = hit.inMsgs;
    } else {
      by.set(hit.phrase, {
        phrase: hit.phrase,
        untilAt: now + cooldown,
        strikes: 0,
        lastNudgeAt: 0,
        selfMsgs: hit.selfMsgs,
        inMsgs: hit.inMsgs,
        retryExhausted: false,
      });
    }
  }
  return [...by.values()]
    .filter((e) => e.untilAt > now)
    .sort((a, b) => b.untilAt - a.untilAt)
    .slice(0, 20);
}

/** 是否有冷却词到了该提醒的时间（新词或距上次提醒超过 gap） */
export function repetitionNudgeDue(state: AntiRepeatEntry[], now: number, gapMs = REPETITION_NUDGE_GAP_MS): boolean {
  return activeAntiRepeat(state, now).some((e) => !e.lastNudgeAt || now - e.lastNudgeAt >= gapMs);
}

/** 记一次提醒，避免下一轮又提醒同一个词 */
export function markRepetitionNudged(state: AntiRepeatEntry[], now: number): AntiRepeatEntry[] {
  return state.map((e) => e.untilAt > now ? { ...e, lastNudgeAt: now } : e);
}

/**
 * 重写结果回执：成功（去掉了词）就解除冷却；失败累加 strike，到 maxStrikes 后
 * 标记 retryExhausted（不再重写，但提醒/冷却继续到到期）。
 */
export function markRepetitionRetry(
  state: AntiRepeatEntry[],
  phrase: string,
  ok: boolean,
  now: number,
  cfg: RepetitionConfig,
): AntiRepeatEntry[] {
  if (ok) return state.filter((e) => e.phrase !== phrase);
  const cooldown = Math.max(1, Math.round(cfg.cooldownMinutes)) * 60_000;
  return state.map((e) => {
    if (e.phrase !== phrase) return e;
    const strikes = e.strikes + 1;
    return {
      ...e,
      strikes,
      retryExhausted: strikes >= Math.max(1, Math.round(cfg.maxStrikes)),
      untilAt: Math.max(e.untilAt, now + cooldown),
    };
  });
}

/** 最终回复里是否又出现了生效中的冷却词（取最长的那个，返回 null 表示没有） */
export function repetitionHitInText(
  text: string,
  state: AntiRepeatEntry[],
  now: number,
): AntiRepeatEntry | null {
  const norm = normalizeRepetitionText(text);
  if (!norm) return null;
  const candidates = activeAntiRepeat(state, now)
    .filter((e) => !e.retryExhausted)
    .sort((a, b) => [...b.phrase].length - [...a.phrase].length);
  return candidates.find((e) => norm.includes(normalizeRepetitionText(e.phrase))) ?? null;
}

/** 提醒分节（order 462） */
export function repetitionSection(entries: AntiRepeatEntry[], windowSize: number): string | null {
  const list = entries.filter((e) => e.phrase).slice(0, 3);
  if (!list.length) return null;
  return [
    '# 重复提醒',
    `最近 ${Math.max(1, Math.round(windowSize))} 轮里你反复提到：`,
    ...list.map((e) => `- ${e.phrase}（出现 ${e.selfMsgs} 轮）`),
    '这轮不要再提这些词；它们不是当前话题，除非对方明确问起。',
    '人设里的名字和设定只是背景，不是聊天素材；不要主动复述身份、角色名或设定。',
    '换一种说法，不要解释你在避免重复，也不要提「重复提醒」。',
  ].join('\n');
}

/** 重写约束分节（order 463） */
export function repetitionRetryConstraint(draft: string, phrases: string[]): string {
  const list = phrases.filter(Boolean).slice(0, 3);
  return [
    '# 重写这条回复',
    `你刚写好的草稿是：「${String(draft ?? '').slice(0, 500)}」`,
    list.length
      ? `它又提到了：${list.map((p) => `「${p}」`).join('、')}。重写：去掉这些词，保持原意，短一点；只输出重写后的正文，不要解释。`
      : '重写：保持原意，短一点；只输出重写后的正文，不要解释。',
    '人设里的名字和设定不是聊天素材，别主动复述。',
  ].join('\n');
}
