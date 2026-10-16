/**
 * 剧本体输出（移植 HDSI `src/script/authored-actions.ts` 的 `readAuthoredActions`）。
 *
 * 这一层把 chat 从"问答机器人"改成"模型在写小说"：
 *   - 模型每轮写的是**这部小说的下一段**：旁白写动作、神态、环境、别的人在做什么；
 *     主角**要说出口的话**用 `<say id="s1">…</say>` 包起来。
 *   - 只有 say 块里的字进 QQ。旁白一律留在剧本里，永远不会被发出去 ——
 *     所以「（打了个哈欠）」这类动作描写从结构上就不可能漏到群里。
 *   - `prose` 是摘掉标签后的正文（**原话原位保留**，HDSI 注释原话："The original words survive."），
 *     它作为本轮的历史回灌给模型，小说才连得下去。
 *
 * 两条照搬的硬规则：
 *   1. 只认显式 say 块，**绝不从旁白里猜台词**（"never infer an action from prose"）。
 *   2. 同一个 id 出现多次时全部作废（"duplicate ids are not executable references"），
 *      避免模型手滑复制出两条一样的引用被重复发送。
 */

/** 气泡内再分条用的分隔标记（HDSI 同款） */
export const BUBBLE_SEP = '<sep/>';

/**
 * 「这一轮不说话」的显式标记。
 * HDSI 用结构化输出里的 `interaction.reply` 表达"不回"；我们是自由文本，
 * 用一个不会被误当台词的字面量等价表达（旧写法 `SKIP` 继续兼容）。
 */
export const SILENT_MARKER = '[silent]';

export function isSilentScene(text: string): boolean {
  // 只留字母/数字/汉字：方括号、句读、空白、星号一律无视（模型有时会写成"【silent】"）
  const s = text.replace(/[^\w一-鿿]/g, '').toUpperCase();
  return s === 'SKIP' || s === 'SILENT';
}

export interface AuthoredAction {
  id: string;
  /** 在 prose 中的起止（切出来应等于 content） */
  start: number;
  end: number;
  content: string;
}

const SAY_RE = /<say id="([\w-]{1,64})">([\s\S]*?)<\/say>/g;

/**
 * 从一段剧本里摘出「作者写好的台词」。
 * 返回的 `prose` 是把 `<say>` 标签去掉、**但台词原文留在原位置**的正文。
 */
export function readAuthoredActions(script: string): { prose: string; actions: AuthoredAction[] } {
  const actions: AuthoredAction[] = [];
  let prose = '';
  let cursor = 0;
  for (const match of script.matchAll(SAY_RE)) {
    prose += script.slice(cursor, match.index);
    const start = prose.length;
    prose += match[2];
    actions.push({ id: match[1], start, end: prose.length, content: match[2] });
    cursor = (match.index ?? 0) + match[0].length;
  }
  prose += script.slice(cursor);
  // 同 id 出现多次 → 全部作废（HDSI 的去重口径）
  const unique = actions.filter((a) => actions.filter((o) => o.id === a.id).length === 1);
  return { prose, actions: unique };
}

/**
 * 一条 action 的正文按分隔标记切成多个气泡（HDSI `splitBubbles` bundle :4941，签名对齐）。
 * 没有标记时整条返回。
 *
 * 与 HDSI 的两处有意偏离：
 *  - 切完为空时返回**空数组**而不退回整条。HDSI 那句 `bubbles.length ? bubbles : [content]` 在它自己的
 *    链路里用；我们的入口是模型写的 `say` 块，若一块里只有分隔标记，回退整条会把 `<sep/>` 这串字符
 *    当台词发进群——宁可什么都不发。
 *  - **关掉拆分时把标记换成换行**（HDSI 是原样返回）。模型照样会写标记，原样返回等于把内部记号发给人看。
 */
export function splitBubbles(content: string, separator: string = BUBBLE_SEP, enabled = true): string[] {
  const sep = String(separator ?? '').trim() || BUBBLE_SEP;
  if (!content.includes(sep)) return [content];
  const pieces = content.split(sep).map((s) => s.trim()).filter(Boolean);
  return enabled ? pieces : [pieces.join('\n')];
}

/**
 * 剧本体的输出要求（进 system，order 440）。
 *
 * 这是**唯一**一段规定"输出长什么样"的指令（MaiBot 的 replyStyle 已随输出侧一起删除），
 * 所以"说几条、多长、什么时候分条"必须由它自己讲清楚 —— 措辞取自 HDSI
 * 的 `writingAffordances`（bundle :2436）与那段"出站文字有自己的会话节奏"（bundle :2375）：
 * 一条为默认、只在真有节奏需要时（真实停顿 / 打到一半改主意 / 后到的补充）才分条、
 * 分出来的气泡要长短不一、分隔标记只出现在台词里。
 */
export function scriptFormatText(opts: { separator: string; splitEnabled: boolean }): string {
  const sep = String(opts.separator ?? '').trim() || BUBBLE_SEP;
  const bubble = opts.splitEnabled
    ? [
        '- 一句话一个气泡是**默认**：一个简单的想法就说成一条，短、合并、标点可有可无、话不必说满，像真人随手打的。',
        '- **只有真有节奏需要时才分条**：一个真实的停顿、话说到一半改主意、隔一下才想起来的补充。要分就分成**长短不一**的几条，不要是一串长度相仿的短句。',
        `- 要分条就写两个 say 块，或在一个 say 里面用 ${sep} 隔开（照原样写这几个字符）。一个停顿允许落在半句中间，但**那一条的完整措辞和顺序不能变**。标记只出现在台词里，不要写进旁白。`,
        '- 主人这边先发第一条，其余几条会按打字节奏依次发出。',
      ].join('\n')
    : '- 分条已关闭：一句台词就写成一条自然消息，不要用分隔标记，长短跟着这一段剧情走。';
  return [
    '# 你的输出是一段小说',
    '你写的不是"一条回复"，而是这段故事接下来发生的一小段。像写小说那样写：',
    '- 旁白：动作、神态、环境、心里想的、别的人在做什么。直接写在外面，**不要用括号或星号包起来**，也不要放进 say 里。',
    '  旁白**不会被人看见**，它只存在于剧本里，供你自己之后接续。',
    '- 台词：主角**真的会说出口**的话，用 <say id="s1">…</say> 包起来，id 自己起短名字（s1/s2/…，同一段里不要重复）。**只有这里面的字会变成 QQ 消息发出去。**',
    bubble,
    '- 一轮别写太长：三五行旁白 + 一两句台词足够。你是在群里说话，不是在交作文。',
    '- 台词里不要写括号或星号动作（那是旁白的事），也不要 Markdown。',
    '- 开头可以给一个净变化标记 <alter>±n</alter>（-5 到 +5 的整数）：这一段相对上一轮，整体氛围变松（正）还是变沉（负）了多少。没变化就写 0，也可以不写。它同样不会被人看见。',
    `- 这一轮不想说话就只输出 ${SILENT_MARKER}（四个词都不要多写），不要写旁白也不要写 say 块。`,
  ].join('\n');
}

/** 剧本体是否可用：必须有 say 块才算（否则模型没按格式来，回落普通文本路径） */
export function hasSayBlocks(text: string): boolean {
  return /<say id="[\w-]{1,64}">/.test(text);
}
