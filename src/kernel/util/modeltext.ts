import type { ForwardRecord } from '../types.ts';
import { renderForward } from './forward.ts';
import { faceTokensToNames } from './qqface.ts';

/**
 * 一条入站消息「该给模型看的正文」。
 *
 * 落账文本一个字都不改（桌面端要靠原始 text + data.files/data.forward 画气泡与卡片），
 * 但直接拿 `e.text` 喂模型会留下两类读不懂的东西：
 *  - `[回复:785187325]`：那是协议端的消息号，模型既查不到也解不开，而**原文就存在同一条记录里**；
 *  - `[聊天记录]`：合并转发只在"本轮"由 pipeline 展开过一次，历史轮回读时只剩这四个字——
 *    重启一次，群友递过来的那份记录就等于没发过。
 */
export interface InboundBits {
  text: string;
  /**
   * 说话人（群聊才传：昵称优先，无昵称给 QQ 号）。私聊不传——对面是谁 system 里已写明，
   * 每条都挂名字反而白吃 token。给模型的历史与当前轮都走 这里，同一口径见 pipeline / sessionlog 两个调用点。
   */
  nickname?: string;
  replyTo?: {
    nickname?: string;
    userId?: string;
    text?: string;
    forward?: ForwardRecord | null;
  } | null;
  forward?: ForwardRecord | null;
}

/** 引用块最多摘这么长：被引用的常常是一条长消息，整段塞进正文会把本轮预算吃光 */
const QUOTE_MAX = 120;

export function inboundModelText(b: InboundBits): string {
  // QQ 表情的编号模型读不懂：落账仍是 `[表情:32]`，喂模型前换成 `[表情:疑问]`
  let text = faceTokensToNames(b.text ?? '');

  // 本条的「聊天记录」：占位先摘掉，展开后的正文在最后接上。
  // 注意顺序：先摘占位再插引用块——引用块里也可能带着一份记录的正文，
  // 事后再 replace 会把人家正文里的 `[聊天记录]` 一起削掉。
  const body = b.forward && !b.forward.failed ? renderForward(b.forward) : '';
  if (body) text = text.replace(/\[聊天记录\]/g, '').trim();

  const r = b.replyTo;
  const who = String(r?.nickname ?? r?.userId ?? '').trim();
  const quoted = faceTokensToNames(String(r?.text ?? '')).replace(/\s+/g, ' ').trim().slice(0, QUOTE_MAX);
  // 被引用的是一条「聊天记录」：它的 text 只有占位，正文得从快照里展开——
  // 不然模型只看到「（引用「某人」：[聊天记录]）」，只能回一句"点不开"。
  const quotedBody = r?.forward && !r.forward.failed ? renderForward(r.forward) : '';
  let first = true;
  text = text.replace(/\[回复:-?\d+\]\s*/g, () => {
    // 一条消息只带一个引用段；万一模型侧看到多个占位，后面的不再重复摘同一份原文
    if (!first) return '';
    first = false;
    // 记录正文后面留一个换行：否则紧接着的下半句会被粘在最后一个节点后面，读起来像同一条记录
    if (quotedBody) return `（引用${who ? `「${who}」` : ''}发来的聊天记录，原文如下）\n${quotedBody}\n`;
    if (!who && !quoted) return '';
    return `（引用${who ? `「${who}」` : ''}：${quoted || '内容已不可查'}）`;
  });

  if (body) text = `${text.trim()}\n${body}`;

  const out = text.trim();
  if (!out) return out;
  // 群聊里「谁说的」只能靠这个前缀：配好名的消息流就是模型的群身份感知
  const nick = String(b.nickname ?? '').trim();
  return nick ? `${nick}：${out}` : out;
}
