import type { ForwardRecord } from '../types.ts';
import { renderForward } from './forward.ts';

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
  replyTo?: { nickname?: string; userId?: string; text?: string } | null;
  forward?: ForwardRecord | null;
}

/** 引用块最多摘这么长：被引用的常常是一条长消息，整段塞进正文会把本轮预算吃光 */
const QUOTE_MAX = 120;

export function inboundModelText(b: InboundBits): string {
  let text = b.text ?? '';

  const r = b.replyTo;
  const who = String(r?.nickname ?? r?.userId ?? '').trim();
  const quoted = String(r?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, QUOTE_MAX);
  let first = true;
  text = text.replace(/\[回复:-?\d+\]\s*/g, () => {
    // 一条消息只带一个引用段；万一模型侧看到多个占位，后面的不再重复摘同一份原文
    if (!first) return '';
    first = false;
    if (!who && !quoted) return '';
    return `（引用${who ? `「${who}」` : ''}：${quoted || '内容已不可查'}）`;
  });

  const body = b.forward && !b.forward.failed ? renderForward(b.forward) : '';
  if (body) text = `${text.replace(/\[聊天记录\]/g, '').trim()}\n${body}`;

  return text.trim();
}
