import type { ForwardRecord } from '../types.ts';

/**
 * 合并转发的上限：一次转发动辄上百条，不设限的话一条记录就能把上下文窗口吃空。
 * 存储、显示、进模型是三件事，各有一档，都在适配器取回时就切好。
 */
export const FORWARD_MAX_NODES = 100;
export const FORWARD_MAX_NODE_CHARS = 300;
/** 进模型的条数：其余的只报个数目，模型知道"后面还有"就够了 */
export const FORWARD_PROMPT_NODES = 40;
/** 一份记录里最多下载几张图：一条转发可能夹几十张图，全拉会把协议端打死 */
export const FORWARD_MAX_NODE_IMAGES = 20;
/** 语音 + 视频合起来的条数上限：这两样比图重得多，另开一档 */
export const FORWARD_MAX_NODE_MEDIA = 6;
/** 单文件体积上限（字节）：QQ 视频动辄几十 MB，超了就不下、只留占位 */
export const FORWARD_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const FORWARD_MAX_MEDIA_BYTES = 48 * 1024 * 1024;
/** 其中最多几张交给模型：视觉模型按图计 token，一条记录塞 20 张图没意义也很贵 */
export const FORWARD_PROMPT_IMAGES = 8;
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
  const shown = f.nodes.slice(0, FORWARD_PROMPT_NODES);
  // 展开过的嵌套记录加一层缩进标记，模型才分得清"这条是里面那层说的"
  const lines = shown.map((n) => `${n.depth ? '  '.repeat(n.depth) + '↳ ' : ''}${n.nickname || n.userId || '未知'}：${n.text}`);
  if (shown.length < total) lines.push(`（其余 ${total - shown.length} 条未展开）`);
  return [`【聊天记录${f.title ? '·' + f.title : ''}·共 ${total} 条】`, ...lines].join('\n');
}
