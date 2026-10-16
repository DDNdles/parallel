/**
 * 聊天节奏反定型（HDSI `ChatRhythm`）。
 *
 * 解决的问题：「回复结构定型」—— 连着好几轮都是同一个形状（一样几个气泡、一样以问号收尾、
 * 一样长），看久了就像模板。检测到定型后，**以主角视角注入一段"描写"**，把节奏多样性召唤回来
 * （HDSI 的配置说明原话："以主角视角的描写召唤她本来的节奏多样性"）。
 *
 * 三档判据（HDSI 配置说明逐条对应）：
 *   gentle     仅结构完全同构时判定
 *   balanced   增加「尾段语气复读」与「字数箱体」两条判据（默认）
 *   aggressive 收紧样本要求，更早触发
 *
 * 熔断：连续 exhaustLimit 次注入都没能改变节奏就停止注入（HDSI 的 exhaustLimit），
 * 免得每轮都在念同一句提醒反而变成新的定型。
 */

export interface RhythmConfig {
  enable: boolean;
  mode: 'gentle' | 'balanced' | 'aggressive';
  /** 节奏签名的历史窗口轮数（HDSI 5~20，默认 12） */
  historyLimit: number;
  /** 开始判定定型所需的最少样本轮数（宽限期，HDSI 3~10，默认 5） */
  collapseMinSamples: number;
  /** 连续注入失败多少次就熔断（HDSI 3~12，默认 6） */
  exhaustLimit: number;
}

export const DEFAULT_RHYTHM: RhythmConfig = {
  enable: true,
  mode: 'balanced',
  historyLimit: 12,
  collapseMinSamples: 5,
  exhaustLimit: 6,
};

/** 一档判据要看的三个维度：结构（几个气泡）/ 尾段语气 / 字数箱体 */
const TAIL_MARKS = ['？', '！', '。', '…', ''] as const;

function lengthBin(n: number): string {
  if (n <= 4) return 'xs';
  if (n <= 10) return 's';
  if (n <= 20) return 'm';
  if (n <= 40) return 'l';
  return 'xl';
}

function tailMark(text: string): string {
  const t = text.trim();
  const last = t[t.length - 1] ?? '';
  return TAIL_MARKS.includes(last as never) ? last : '';
}

/**
 * 一条回复的「节奏签名」。
 * 结构 = 气泡数（1 / 2 / 3+）；尾段语气 = 最后一条的收尾标点；字数箱体 = 全部字数落在哪一档。
 */
export function rhythmSignature(bubbles: string[]): string {
  const n = bubbles.length;
  const structure = n <= 1 ? '1' : n === 2 ? '2' : '3+';
  const last = bubbles[n - 1] ?? '';
  const chars = bubbles.join('').length;
  return `${structure}|${tailMark(last)}|${lengthBin(chars)}`;
}

/** 只取结构维度（gentle 档） */
function structureOf(sig: string): string {
  return sig.split('|')[0];
}

/** 只取结构 + 尾段语气（balanced 档） */
function structureTailOf(sig: string): string {
  const [s, t] = sig.split('|');
  return `${s}|${t}`;
}

export interface CollapseResult {
  collapsed: boolean;
  dimension: 'structure' | 'tail' | 'length' | '';
  detail: string;
}

/**
 * 判定是否定型。只看**最近 collapseMinSamples 条**是否同构 ——
 * 窗口更长是为了算密度/留证据，判定本身用最少样本（宽限期）。
 */
export function detectCollapse(signatures: string[], cfg: RhythmConfig): CollapseResult {
  const need = cfg.mode === 'aggressive'
    ? Math.max(3, cfg.collapseMinSamples - 2)     // 更早触发：样本要求收紧
    : cfg.mode === 'gentle'
      ? Math.max(3, cfg.collapseMinSamples) + 1   // 更保守
      : Math.max(3, cfg.collapseMinSamples);
  const recent = signatures.slice(-cfg.historyLimit).slice(-need);
  if (recent.length < need) {
    return { collapsed: false, dimension: '', detail: `样本 ${recent.length}/${need}` };
  }
  const uniq = (f: (s: string) => string) => new Set(recent.map(f)).size;

  if (uniq(structureOf) === 1 && uniq((s) => s) === 1) {
    return { collapsed: true, dimension: 'structure', detail: `最近 ${need} 轮结构、语气、字数完全同构：${recent[0]}` };
  }
  if (cfg.mode === 'gentle') {
    return { collapsed: false, dimension: '', detail: '结构未完全同构（gentle 档）' };
  }
  if (uniq(structureOf) === 1 && uniq(structureTailOf) === 1) {
    return { collapsed: true, dimension: 'tail', detail: `最近 ${need} 轮都是 ${structureOf(recent[0])} 个气泡 + 同样的收尾语气` };
  }
  if (uniq(structureOf) === 1 && uniq((s) => s.split('|')[2]) === 1) {
    return { collapsed: true, dimension: 'length', detail: `最近 ${need} 轮都是 ${structureOf(recent[0])} 个气泡 + 同样的字数档` };
  }
  return { collapsed: false, dimension: '', detail: '节奏有变化' };
}

/** 以主角视角写的纠偏"描写"（HDSI 的做法：不是下指令，而是提醒她本来就有别的节奏） */
export function rhythmNudge(detail: string, mode: RhythmConfig['mode']): string {
  const how = mode === 'aggressive'
    ? '这次换一种完全不同的说法：要么只说一个词，要么把话拆成好几条，要么干脆先写一句旁白再开口。'
    : '这次换个节奏：可以只回一个字，可以把一句话拆成两条发，也可以先沉默一轮。';
  return [
    '# 节奏提醒',
    `你最近的回复定型了（${detail}）。`,
    how,
    '不用刻意解释，自然换一下就好。',
  ].join('\n');
}
