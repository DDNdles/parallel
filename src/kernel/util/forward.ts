import type { ForwardRecord } from '../types.ts';

/**
 * 合并转发的上限：一次转发动辄上百条，不设限的话一条记录就能把上下文窗口吃空。
 * 存储、显示、进模型是三件事，各有一档，都在适配器取回时就切好。
 */
export const FORWARD_MAX_NODES = 100;
export const FORWARD_MAX_NODE_CHARS = 300;
/** 已废：进模型的条数不再另设一档，直接照单全收 FORWARD_MAX_NODES（适配器取回时已按它切好，
 *  超出的记在 dropped 里；"其余 N 条未展开"只在真被截断时才出现）。
 *  留着导出只为不打断既有引用，别再拿它当进模型的闸门。 */
export const FORWARD_PROMPT_NODES = FORWARD_MAX_NODES;
/** 一份记录里最多下载几张图：一条转发可能夹几十张图，全拉会把协议端打死 */
export const FORWARD_MAX_NODE_IMAGES = 20;
/** 语音 + 视频合起来的条数上限：这两样比图重得多，另开一档 */
export const FORWARD_MAX_NODE_MEDIA = 6;
/** 单文件体积上限（字节）：QQ 视频动辄几十 MB，超了就不下、只留占位 */
export const FORWARD_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const FORWARD_MAX_MEDIA_BYTES = 48 * 1024 * 1024;
/** 已废：补传口径 = 下载口径（下载预算已在适配器守住），进模型这边照单全收、不再二次砍。
 *  留着导出只为不打断既有引用；本条不再参与任何截断。 */
export const FORWARD_PROMPT_IMAGES = FORWARD_MAX_NODE_IMAGES;
/** 记录套记录最多展开到第几层（0 = 最外面那份）：QQ 本身没有限制，得我们自己掐 */
export const FORWARD_MAX_DEPTH = 2;

/** 记录里的总条数（含因为超限被丢掉的） */
export function forwardTotal(f: ForwardRecord): number {
  return f.nodes.length + f.dropped;
}

/**
 * 聊天记录 → 模型看到的正文块。
 * 界面显示读的是会话日志里的 data.forward.nodes，不经过这里，所以这里的取舍不影响人在桌面上看到的完整性。
 */
export function renderForward(f: ForwardRecord): string {
  const total = forwardTotal(f);
  if (!f.nodes.length || !total) return '';
  // 进模型口径 = 存储/显示口径（FORWARD_MAX_NODES）：适配器取回时已经把超限的部分记进 dropped，
  // 这里不再砍一刀。下面那句"其余 N 条未展开"只在真的截断（老日志里条数超上限）时才出现。
  const shown = f.nodes.slice(0, FORWARD_MAX_NODES);
  // 展开过的嵌套记录加一层缩进标记，模型才分得清"这条是里面那层说的"
  const lines = shown.map((n) => `${n.depth ? '  '.repeat(n.depth) + '↳ ' : ''}${n.nickname || n.userId || '未知'}：${n.text}`);
  if (shown.length < total) lines.push(`（其余 ${total - shown.length} 条未展开）`);
  return [`【聊天记录${f.title ? '·' + f.title : ''}·共 ${total} 条】`, ...lines].join('\n');
}
