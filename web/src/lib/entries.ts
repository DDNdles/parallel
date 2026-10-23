/** 会话流的分流判据：会话页只放对话本身，工具调用/系统行/异常一律进右侧「工作」面板。 */
export const isWorkEntry = (type: string) =>
  type === 'tool_call' || type === 'tool_result' || type === 'agent_start' || type === 'agent_end' || type === 'error';

/** session log 里的一条（内核 SessionLog.append 的形状，UI 侧只用到这些字段） */
export interface LogEntry {
  type: string; ts?: number; text?: string; role?: string;
  chatId?: string; chatType?: string; userId?: string; nickname?: string; data?: any;
  /** 这条属于哪条执行线：chat 会话模型 / work 子代理（老记录没有 = chat） */
  lane?: 'chat' | 'work';
}

export const chatKeyOf = (e: LogEntry) => `${e.chatType}_${e.chatId}`;

/** 工具动作的结构化说明（与内核 types.ts 的 ToolMeta 同形，随 tool_result 一起传过来） */
export interface ToolMeta {
  path?: string; added?: number; removed?: number;
  /** shell/python 执行顺手改过的文件（工作页逐行显示 +N -M） */
  changes?: { path: string; added: number; removed: number }[];
}

/** 工具能力归类（决定「工作」面板那行的图标与措辞）：执行 / 文件 / 联网 / 浏览器 / 协议动作 / 其他 */
export type ToolKind = 'run' | 'file' | 'net' | 'browser' | 'todo' | 'ask' | 'done' | 'delegate' | 'skill' | 'other';

/** 协议类工具（清单/回问/交付/派生/技能）没有"能力词素"可判，按整名精确取形状 */
const PROTO: Record<string, ToolKind> = {
  todo: 'todo', work_ask: 'ask', work_finish: 'done', delegate: 'delegate',
  skill: 'skill', skill_file: 'skill', skill_install: 'skill',
};

/**
 * 按名字里的词素判能力，MCP 名（pluginId__serverId__tool）拿最后一段来判——
 * 这样 browser_* 、*search* 之类的 MCP 工具也能归到对的那类。落不上的算「其他」。
 */
export function toolAction(name: string): ToolKind {
  const n = (name || '').toLowerCase();
  const seg = n.split('__');
  const t = seg.length > 1 ? seg[seg.length - 1] : n;
  if (PROTO[t]) return PROTO[t];
  if (/(^|_)(browser|chrome|playwright|puppeteer)(_|$)/.test(t)) return 'browser';
  if (/(^|_)(web|http|url|link|search|fetch|crawl|query)(_|$)/.test(t)) return 'net';
  if (/(^|_)(run|exec|shell|bash|zsh|powershell|python|node|js|ts|deno|eval|command|script)(_|$)/.test(t)) return 'run';
  if (/(^|_)(file|fs|sandbox|path|dir|read|write|edit|save|artifact|folder)(_|$)/.test(t)) return 'file';
  return 'other';
}

/** MCP 工具名拆成「服务 · 工具」两段（ZCode 那行是 `MCP Playwright · Browser run code unsafe`） */
export function splitMcp(name: string): { server: string; tool: string } {
  const seg = name.split('__');
  if (seg.length >= 3) return { server: seg[1], tool: seg.slice(2).join('__') };   // pluginId__serverId__tool
  return { server: seg[0], tool: seg[1] ?? '' };                                    // serverId__tool
}

/** 参数里的文件路径/目标（ZCode 那行显示的是文件不是工具名）；取不到返回 null */
export function argPath(args: string): string | null {
  const m = /"(?:path|file(?:_?path|name)?|target|url|query|key|fact)"\s*:\s*"([^"]{1,120})"/i.exec(args || '');
  return m?.[1] ?? null;
}

/** token 数徽标：1048576 → 1M、65536 → 64K（整除 1024 走二进制单位），200000 → 200K */
export function ctxBadge(n?: number): string | null {
  if (!n) return null;
  const bin = n % 1048576 === 0 ? n / 1048576 : n % 1024 === 0 ? n / 1024 : 0;
  if (bin) return n % 1048576 === 0 ? `${bin}M` : `${bin}K`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}
