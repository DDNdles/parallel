import type { MsgSegment } from '../types.ts';
import { QQ_FACE_NAMES } from './qqface-names.ts';

/**
 * QQ 经典表情（OneBot `face` 段）的 ID ↔ 名称。
 *
 * - 入站：适配器把 face 段落成 `[表情:32]`；喂模型前换成 `[表情:疑问]`（见 util/modeltext.ts）。
 * - 出站：模型写 `[表情/疑问]`（或 `[表情:14]` / `[表情/14]`），发送前切成真正的 face 段。
 * - 桌面端：会话日志保留 `[表情:32]`，前端按 ID 换成 `/face/32.webp`。
 *
 * 名称表由 `scripts/build-qq-faces.mjs` 从 `scripts/qq-faces.json` 生成，别手改。
 */

const NAME_TO_ID = new Map(Object.entries(QQ_FACE_NAMES).map(([id, name]) => [name, id] as const));

/**
 * 常见手滑/简称 → 编号。只补语义明确的，不猜多义：
 * 「笑」能对上微笑/大笑/偷笑等十几个名字，不进这张表；这类拿不准时让模型写编号。
 */
const FACE_ALIASES: Record<string, string> = {
  '呜呜': '386',   // 呜呜呜
  '哭': '9',       // 大哭
};

/** 出站令牌：`[表情/微笑]` / `[表情:14]` / `[表情：呲牙]` */
const TOKEN = /\[表情[:：/／]([^\[\]\n]+)\]/g;

export function qqFaceName(id: unknown): string {
  const s = String(id ?? '').trim();
  return QQ_FACE_NAMES[s] ?? `表情${s || '?'}`;
}

/** 名称或编号 → 编号；认不出来返回 undefined（原样留在正文里，不硬猜） */
export function qqFaceId(raw: unknown): string | undefined {
  const s = String(raw ?? '').trim().replace(/^\[|\]$/g, '').replace(/^表情[:：/／]?/, '').trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return s;
  const exact = NAME_TO_ID.get(s);
  if (exact) return exact;
  const alias = FACE_ALIASES[s];
  if (alias) return alias;
  // 唯一的子串命中才认（「呜呜」→「呜呜呜」）；有多个候选就说明有歧义，继续不猜
  if ([...s].length >= 2) {
    const hits = Object.entries(QQ_FACE_NAMES).filter(([, name]) => name.includes(s) || s.includes(name));
    if (hits.length === 1) return hits[0][0];
  }
  return undefined;
}

/** 正文里的编号占位换成中文名（给模型读）；不认识的编号保留原样 */
export function faceTokensToNames(text: string): string {
  return String(text ?? '').replace(/\[表情[:：](\d+)\]/g, (all, id: string) => {
    const name = QQ_FACE_NAMES[id];
    return name ? `[表情:${name}]` : all;
  });
}

/** 一段可见正文 → 发送段：认得出的表情令牌变成 face 段，其余保持 text（不丢字） */
export function faceTokensToSegments(text: string): MsgSegment[] {
  const src = String(text ?? '');
  const out: MsgSegment[] = [];
  let last = 0;
  let found = false;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(src); m; m = TOKEN.exec(src)) {
    const id = qqFaceId(m[1]);
    if (!id) continue;
    found = true;
    const before = src.slice(last, m.index);
    if (before) out.push({ type: 'text', data: { text: before } });
    out.push({ type: 'face', data: { id } });
    last = m.index + m[0].length;
  }
  if (!found) return [{ type: 'text', data: { text: src } }];
  const tail = src.slice(last);
  if (tail) out.push({ type: 'text', data: { text: tail } });
  return out;
}
