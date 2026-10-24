// ============================================================
// work 轮的 system 组装（pi 式具名分节 + 工具自带的规则）
//
// pi 的两个关键做法在这里落地：
//  1. system 是一组**具名、可独立替换的节**（<tools> / <rules> / <project_context> …），
//     不是一个手写大字符串。改一处只动那一节，别的节不受影响。
//  2. 「可用工具」清单与「使用规则」都由**本轮实际生效的工具**生成：
//     每个工具自带 promptSnippet（一行说明）与 promptGuidelines（规则条目），
//     内核汇总去重。于是工具面一变，prompt 里的清单与规则自动跟着变——不会漂移。
//
// 之前 pipeline.ts 里手写的那段 work system（"用 python_session …""需要浏览网页用 browser_*"）
// 正是会漂移的写法：加一个工具、改一个工具名，prompt 不会跟着动。
// ============================================================

import type { Role, SystemSection, ToolDef, WorkAgentDef } from './types.ts';
import { CONTEXT_CONTINUITY_TEXT, TRUST_BOUNDARY_TEXT, chatLabelOf, roleLabel } from './prompt-sections.ts';

/** 「可用工具」清单：每个工具一行（pi 的 Available tools 节） */
export function renderAvailableTools(tools: ToolDef[]): string {
  const lines = tools
    .filter((t) => t.promptSnippet)
    .map((t) => `- ${t.name}: ${t.promptSnippet}`);
  if (!lines.length) return '(none)';
  return [
    lines.join('\n'),
    '',
    '除上述工具外，本会话可能还有项目自定义工具；工具的可见性由内核按角色与本群开关强制，与对话内容无关。',
  ].join('\n');
}

/**
 * 规则节：按「本轮实际生效的工具」汇总各自的 promptGuidelines，去重后成条（pi 的 buildRules）。
 * 同一句话被多个工具声明只留一条；保序（先出现的在前）。
 */
export function buildToolRules(tools: ToolDef[], extra: string[] = []): string {
  const seen = new Set<string>();
  const rules: string[] = [];
  const add = (rule: string): void => {
    const r = rule.trim();
    if (!r || seen.has(r)) return;
    seen.add(r);
    rules.push(r);
  };
  for (const t of tools) for (const g of t.promptGuidelines ?? []) add(g);
  for (const r of extra) add(r);
  return rules.map((r) => `- ${r}`).join('\n');
}

/** 交付格式：work 结束时按这个收尾，内核据此解析产物清单（pi 的子代理 handoff 格式） */
export const HANDOFF_TEXT = [
  '活干完后的收尾方式是**调用 `work_finish`**，把结论、产物、备注一次交出去；它会把内容变成最终回答并结束本次任务。',
  '',
  '`work_finish` 三个字段：',
  '- `summary`：做了什么、结论是什么（给最终用户看的自然语言，可含 Markdown）。',
  '- `artifacts`：产物在会话沙箱内的相对路径列表（与 sandbox_write 返回的路径一致）；没有就留空。',
  '  内核会把这里登记的产物**合并打包成一个合集**发给用户——只登记用户真正要的文件，',
  '  不要把进度笔记、技能文件、收件镜像这类中间产物写进来。',
  '- `notes`：需要发起者知道的风险、假设、未完成项；没有就留空。',
  '',
  '万一没法调用 `work_finish`，就按下面的 Markdown 格式把同样的内容写在回答里（内核会照样解析）：',
  '',
  '## 完成',
  '做了什么、结论是什么。',
  '',
  '## 产物',
  '- `相对路径` — 一句话说明',
  '（没有产物就写"（无）"）',
  '',
  '## 备注',
  '需要发起者知道的风险、假设、未完成项（没有就写"（无）"）。',
  '',
  '另一种结束方式是**调用 `work_ask`**：信息不足、猜错代价明显时，用它把问题交回发起者并结束本次任务，',
  '发起者回答后你会接着干（沙箱里的东西还在）。能自己合理假设的就别问——那种情况做完、把假设写进 `notes`。',
].join('\n');

export interface WorkPromptInput {
  agent: WorkAgentDef;
  type: 'group' | 'private';
  chatId: string;
  groupTitle: string;
  nickname?: string;
  userId: string;
  role: Role | string;
  task: string;
  tools: ToolDef[];
  /** 会话沙箱根目录的展示路径（内核保证写只发生在这里） */
  sandboxRoot: string;
  trigger?: 'chat' | 'command' | 'subagent';
  /** 嵌套深度（入口 0）：子代理在自己的 prompt 里知道"我是被谁叫来的" */
  depth?: number;
  /** 可委派的子代理清单（仅在工具面里有 delegate 时给） */
  subagents?: { name: string; description: string; tools?: string[]; source?: string }[];
}

/** 「可委派的子代理」节：只在 delegate 工具可用时出现（工具面无此工具就不该提它） */
function renderSubagents(list: { name: string; description: string; tools?: string[]; source?: string }[]): string {
  const lines = list.map((a) => `- ${a.name}${a.source === 'user' ? '（用户自定义）' : ''}: ${a.description}${a.tools?.length ? `（可用工具 ${a.tools.length} 个）` : ''}`);
  return [
    '# 可委派的子代理',
    lines.join('\n'),
    '',
    '给子代理的是**独立上下文**：它看不到你现在的对话。所以任务描述要自带前因后果、给全它需要的输入',
    '（路径、数字、约束、要遵守的格式），并说清你要它交回什么。它能用的工具面比你的窄，别让它做它没有工具的事。',
    '子代理返回的是它的结论与产物清单（不是它的过程）。多件互不依赖的事可以用 tasks 一次并行派出去；',
    '有先后依赖的，就等前一个的结果再派下一个——不要把还没拿到的东西写进任务里。',
  ].join('\n');
}

/**
 * 组装 work 轮的 system：正文 = agent 定义的身份（preamble），其余是可独立替换的具名节。
 * 插件可以在 beforeWorkLLM 里往 systemSections 追加自己的节（order 1000+）。
 */
export function buildWorkSections(input: WorkPromptInput): { system: string; sections: SystemSection[] } {
  const { agent, tools } = input;
  const sections: SystemSection[] = [
    {
      order: 300,
      name: 'trust_boundary',
      title: 'trust-boundary',
      text: TRUST_BOUNDARY_TEXT,
    },
    {
      order: 400,
      name: 'context_continuity',
      title: 'context-continuity',
      text: CONTEXT_CONTINUITY_TEXT,
    },
    {
      order: 420,
      name: 'task',
      title: 'work-task',
      text: [
        `# 本次任务`,
        input.task,
        '',
        `（触发方式：${input.trigger === 'subagent'
          ? `上一层 work 子代理委派（第 ${(input.depth ?? 0)} 层）`
          : input.trigger === 'chat' ? '聊天里由助手派发（管理员授权）' : '管理员命令'}。只做这一件事；范围外的改动不要顺手做。）`,
      ].join('\n'),
    },
    {
      order: 600,
      name: 'tools',
      title: 'work-tools',
      text: `# 可用工具\n${renderAvailableTools(tools)}`,
    },
    {
      order: 700,
      name: 'sandbox',
      title: 'work-sandbox',
      text: [
        `# 环境`,
        `- 会话沙箱：${input.sandboxRoot}（可读写；这是唯一可写的地方，路径越界会被内核拒绝）。`,
        `- 计算容器**有外网**：脚本里可直接联网（requests/urllib/curl，缺库就 pip install，node 也可用）；`,
        `  要渲染网页或带登录态的操作仍用 browser_*，那才是浏览器。`,
        `- 脚本 / shell / 浏览器都在 **Linux 容器**里跑：容器内会话目录是 \`/ws\`（= 上面那个沙箱根），`,
        `  python_session、run_python_work、run_bash 里的相对路径都相对 \`/ws\`。`,
        `- **不要在脚本里写宿主机的 Windows 路径**（C:\\...）：容器里不存在它，按它写文件会造出一个名字很怪的空文件。`,
        `  要打开自己写的网页用 browser_open + \`file:///ws/文件名\`，不要用宿主路径的 file:// URL。`,
        `- 宿主机桌面与它上面装的程序（本机 Chrome/Edge 等）在沙箱里看不到、也不该去调用；`,
        `  需要渲染网页就用 browser_*，不要试图启动本机浏览器。`,
        `- 这个沙箱是本会话里**发起人自己的**一份（同一群其他人看不到它的内容）；`,
        `  群聊里收到的文件已放在 \`inbox/\`，用相对路径读即可。`,
        `- 产物留在会话沙箱内，按下面的格式登记；**不要在过程中自己发文件**（不要 send_file）：`,
        `  内核会把所有产物打包成一个合集，连结论一起发给用户。`,
      ].join('\n'),
    },
    {
      order: 800,
      name: 'handoff',
      title: 'work-handoff',
      text: `# 交付\n${HANDOFF_TEXT}`,
    },
  ];

  const rules = buildToolRules(tools);
  if (rules) {
    sections.push({ order: 620, name: 'rules', title: 'work-rules', text: `# 规则\n${rules}` });
  }

  // 子代理清单：只在 delegate 真的在本轮工具面里时才给（否则等于教模型用一个不存在的工具）
  if (tools.some((t) => t.name === 'delegate') && input.subagents?.length) {
    sections.push({ order: 640, name: 'subagents', title: 'work-subagents', text: renderSubagents(input.subagents) });
  }

  // 会话节（发起者与权限）：供 work 判断"该不该做"的最小上下文
  sections.push({
    order: 100,
    name: 'session',
    title: 'work-session',
    text: [
      `当前会话：${chatLabelOf(input.type, input.chatId, input.groupTitle)}。`,
      `发起人：${input.nickname || input.userId}（QQ ${input.userId}，权限等级 ${roleLabel(input.role as Role)}）。`,
    ].join('\n'),
  });

  // 返回前排好序：调用方不必知道 push 顺序（composeSystem 也按 order 排，这边对齐口径）
  sections.sort((a, b) => a.order - b.order);
  return { system: agent.instructions.trim(), sections };
}

/**
 * 把结构化的交付内容渲染成与 HANDOFF_TEXT 同形状的文本。
 * 收尾工具走这条路，于是「工具交付」与「模型自己写」共用同一个解析入口（parseWorkHandoff）。
 */
export function renderHandoff(input: { summary: string; artifacts?: string[]; notes?: string }): string {
  const files = (input.artifacts ?? []).map((p) => p.trim()).filter(Boolean);
  return [
    '## 完成',
    input.summary.trim(),
    '',
    '## 产物',
    files.length ? files.map((p) => `- \`${p.replace(/\\/g, '/')}\``).join('\n') : '（无）',
    '',
    '## 备注',
    input.notes?.trim() || '（无）',
  ].join('\n');
}

/**
 * 「停下来提问」的交付文本（work_ask 的 finalReply）。
 * 故意**不**用「## 完成」这套标题：它表达的不是交付，parseWorkHandoff 也就不该把它当交付解析
 * （真值走 ToolMeta.awaiting，比在文本里认标记可靠）。
 */
export function renderAsk(input: { question: string; notes?: string }): string {
  return [
    '## 待确认',
    input.question.trim(),
    '',
    '## 已做到',
    input.notes?.trim() || '（无）',
  ].join('\n');
}

/** 一次"停下来等回答"的现场（内核按会话记着，等管理员回来回答） */
export interface PendingAsk {
  /** 上次交给它的任务原文（可能是更早一次续接拼出来的，所以链式提问也能一路带上） */
  task: string;
  /** 界面上显示的短任务名（task 是拼接文本时拿它做标题） */
  label: string;
  question: string;
  notes?: string;
  at: number;
  /** 谁问的（回答要同一个人来给） */
  userId: string;
}

/**
 * 「接着上次的活干」：work 不驻留上下文（一次 run = 一个任务），
 * 所以续接靠任务描述交接——把上次停下的问题与这次的回答拼成新任务。
 * 末尾两句是给模型的兜底：万一管理员其实是在派另一件事，别被这段历史带偏。
 */
export function composeContinueTask(pending: { task: string; question: string; notes?: string }, answer: string): string {
  return [
    '【接着上次没做完的活】',
    `上次交给你的事：${pending.task}`,
    `你上次停下来问发起者的：${pending.question}`,
    pending.notes ? `（当时你已经做到：${pending.notes}）` : '',
    '',
    `发起者这次说的是：${answer}`,
    '',
    '沙箱里上次的东西还在，先看一眼接着干，别从零重来；「发起者这次说的是」就是他对那个问题的回答——',
    '如果读起来是另一件事，就按新任务做，上面几行只当背景。',
  ].filter(Boolean).join('\n');
}

export interface WorkHandoff {
  /** 给 chat 模型转述用的结论（「完成」一节；解析不到就给全文） */
  summary: string;
  /** 「产物」一节里登记的文件（相对路径） */
  artifacts: string[];
  /** 「备注」一节 */
  notes: string;
  /** 是否解析到了结构化格式 */
  structured: boolean;
}

const SECTION_ALIASES: Record<keyof Pick<WorkHandoff, 'summary' | 'artifacts' | 'notes'>, string[]> = {
  summary: ['完成', 'completed', 'done'],
  artifacts: ['产物', 'files changed', 'artifacts', '交付物'],
  notes: ['备注', 'notes'],
};

/** 从「## 完成 / ## 产物 / ## 备注」里取值；容错标题层级与中英文名 */
function pickSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^#{1,4}\s*(.+?)\s*$/gm;
  const marks: { key: string; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const title = m[1].trim().toLowerCase();
    for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
      if (aliases.includes(title)) {
        marks.push({ key, start: m.index, bodyStart: m.index + m[0].length });
        break;
      }
    }
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out.set(marks[i].key, text.slice(marks[i].bodyStart, end).trim());
  }
  return out;
}

/** 占位符（模型按格式写的"没有内容"）归一化成空串，别把「（无）」当成真备注传下去 */
const PLACEHOLDERS = new Set(['（无）', '(无)', '无', 'none', 'n/a', 'na', '-', '—']);
function blankIfPlaceholder(s: string): string {
  const t = s.trim();
  return PLACEHOLDERS.has(t.toLowerCase()) ? '' : t;
}

/** 从产物节里抽路径：支持 `- \`a/b.md\` — 说明` 与 `- a/b.md: 说明` 两种写法 */
function parseArtifactLines(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const item = t.replace(/^[-*]\s*/, '');
    if (!item || PLACEHOLDERS.has(item.toLowerCase()) || PLACEHOLDERS.has(item.split(/[\s—:：]/)[0]?.toLowerCase() ?? '')) continue;
    const m = item.match(/^`([^`]+)`/) ?? item.match(/^([^\s（(]+\.\w{1,8})\b/);
    if (m) out.push(m[1].replace(/\\/g, '/'));
  }
  return [...new Set(out)];
}

/**
 * 解析 work 的最终回答。解析不到结构化格式时 `structured=false`，
 * 调用方应回落到"全文即结论"（老模型/未按格式作答时不能把结论丢掉）。
 */
export function parseWorkHandoff(text: string): WorkHandoff {
  const trimmed = (text ?? '').trim();
  const sec = pickSections(trimmed);
  const summary = blankIfPlaceholder(sec.get('summary') ?? '');
  const artifacts = parseArtifactLines(sec.get('artifacts') ?? '');
  const notes = blankIfPlaceholder(sec.get('notes') ?? '');
  const structured = Boolean(summary || artifacts.length || notes);
  return {
    summary: summary || trimmed,
    artifacts,
    notes,
    structured,
  };
}
