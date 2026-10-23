// ============================================================
// work 子代理的 agent 注册表（对齐 pi 的 `agents/*.md` + 子代理扩展）
//
// pi 把子代理写成一个 markdown 文件：frontmatter 声明能力（工具白名单、模型），正文写身份与工作方式；
// 目录里的 `*.md` 每次调用重新扫（允许中途加/改 agent，不必重启）。
// parallel 照此办理，两个来源：
//
//   src/plugins/work/agents/*.md   内置（随仓库分发）
//   <data>/agents/*.md             用户自加（同名覆盖内置）
//
//   例：
//   ---
//   name: research
//   description: 查资料并给出来源
//   tools: web_search, web_fetch, sandbox_write, work_finish
//   chain: work                 # 跑哪条模型链（缺省 work）
//   max_rounds: 0               # 兼容保留：work 轮已不设轮次上限（2026-10-23），写多少都不截断
//   ---
//   正文：身份 / 工作方式 / 交付要求
//
// 注：`tools` 不写（或留空）= 不设白名单，拿到全部 work 面工具；写了就严格按名单来。
// 内置兜底 agent 与"只写身份没写工具"的自定义 agent 都走前者。
//
// 关键约定：正文只是 system 的一个分节，不是整张 prompt——内核固定节 + 按实际工具面生成的规则仍然生效。
// 这样"工具面"与"规则"永远不会和定义漂移。
// ============================================================

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { WorkAgentDef } from './types.ts';

/** 无定义文件时的兜底：让 work 在没有 agents/ 目录的环境里依然可用（不声明 tools = 全部 work 面工具） */
export const DEFAULT_WORK_AGENT: WorkAgentDef = {
  name: 'work',
  description: 'work 子代理：由管理员以 /work 触发的通用执行体',
  instructions: [
    '你是 parallel 的 work 子代理：由管理员以 /work 触发，专注完成这一件事。',
    '面向交付：先把任务拆成几步，逐步执行，最后汇报做了什么、产物在哪。',
    '遇到需要用户决策的点，简明列出选项再继续；不要为了省事跳过验证。',
  ].join('\n'),
};

/** 入口 agent 的名字（/work 与委派缺省都用它） */
export const ENTRY_AGENT_NAME = 'work';

/** 极简 YAML 子集解析：只认 `key: value`，value 支持逗号分隔列表与 [a, b] 形式 */
function parseFrontmatter(raw: string): { front: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { front: {}, body: text.trim() };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { front: {}, body: text.trim() };
  const front: Record<string, string> = {};
  for (const line of text.slice(3, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^[\s]/.test(line)) continue; // 不解析嵌套结构
    const i = line.indexOf(':');
    if (i === -1) continue;
    front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { front, body: text.slice(end + 4).trim() };
}

function parseList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const inner = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
  const items = inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return items.length ? items : undefined;
}

/** 把一份 agent markdown 解析成定义；正文为空视为无效（返回 null，调用方回落默认） */
export function parseWorkAgent(raw: string, fallbackName = ENTRY_AGENT_NAME): WorkAgentDef | null {
  const { front, body } = parseFrontmatter(raw);
  if (!body) return null;
  // 没写这个键就是"没声明"（undefined = 无上限）；写了 0 也按无上限处理
  const rawRounds = front.max_rounds ?? front.maxRounds;
  const maxRounds = rawRounds === undefined ? undefined : Number(rawRounds);
  const chain = front.chain === 'chat' ? 'chat' as const : front.chain === 'work' ? 'work' as const : undefined;
  return {
    name: front.name || fallbackName,
    description: front.description || DEFAULT_WORK_AGENT.description,
    tools: parseList(front.tools),
    maxRounds: Number.isFinite(maxRounds) ? maxRounds : undefined,
    chain,
    instructions: body,
  };
}

/** 按 mtime 缓存单文件解析结果，避免每次 work 轮都读盘 */
const fileCache = new Map<string, { mtimeMs: number; def: WorkAgentDef }>();

/** 读定义文件；不存在/读失败/正文为空时返回 null（由调用方决定回落） */
export function loadWorkAgentFile(file: string): WorkAgentDef | null {
  try {
    if (!existsSync(file)) return null;
    const { mtimeMs } = statSync(file);
    const hit = fileCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.def;
    const def = parseWorkAgent(readFileSync(file, 'utf8'));
    if (!def) return null;
    fileCache.set(file, { mtimeMs, def });
    return def;
  } catch {
    return null;
  }
}

function listAgentFiles(dir: string): string[] {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => `${dir}/${f}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 扫描 agent 目录（pi 的口径：每次调用重新扫，允许中途增删改）。
 * `userDir` 同名覆盖内置；内置里至少保证有入口 agent（否则用常量兜底）。
 */
export function discoverWorkAgents(opts: { pluginDir: string; userDir?: string }): WorkAgentDef[] {
  const byName = new Map<string, WorkAgentDef>();
  for (const file of listAgentFiles(`${opts.pluginDir}/agents`)) {
    const def = loadWorkAgentFile(file);
    if (def) byName.set(def.name, { ...def, source: 'builtin' });
  }
  if (!byName.size) byName.set(DEFAULT_WORK_AGENT.name, { ...DEFAULT_WORK_AGENT, source: 'builtin' });
  if (opts.userDir) {
    for (const file of listAgentFiles(opts.userDir)) {
      const def = loadWorkAgentFile(file);
      if (def) byName.set(def.name, { ...def, source: 'user' });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 解析生效的**入口** agent 定义：
 *  - `config.work.agent` 非空 → 把它当文件路径读；读不到再退回按名字找
 *  - 否则取 name === 入口名 的那条
 *  - 都没有 → 内置兜底常量
 */
export function resolveWorkAgent(opts: { agentFile?: string; pluginDir: string; userDir?: string }): WorkAgentDef {
  const agents = discoverWorkAgents(opts);
  const explicit = opts.agentFile?.trim();
  if (explicit) {
    const loaded = loadWorkAgentFile(explicit);
    if (loaded) return loaded;
    const byName = agents.find((a) => a.name === explicit);
    if (byName) return byName;
  }
  return agents.find((a) => a.name === ENTRY_AGENT_NAME) ?? agents[0] ?? DEFAULT_WORK_AGENT;
}

/** 按名字取子代理；找不到返回 undefined（调用方给模型一个明确的错误） */
export function resolveWorkAgentByName(name: string, agents: WorkAgentDef[]): WorkAgentDef | undefined {
  const key = name.trim().toLowerCase();
  return agents.find((a) => a.name.toLowerCase() === key);
}
