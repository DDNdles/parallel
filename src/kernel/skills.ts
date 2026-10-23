// ============================================================
// 技能库（目录式）：扫描 / 解析 / 路径边界
//
// 技能 = 一个目录（或一个平铺 md）：
//   <root>/<id>/SKILL.md    + 可选的 references/、scripts/、模板文件
//   <root>/<id>.md          轻量技能，没有附带文件
//
// 两个来源，user 同名覆盖 builtin：
//   <builtin>/<id>/SKILL.md   随代码分发（现在先不放内容）
//   <user>/<id>/SKILL.md      用户自加（data/plugin-data/skills）
//
// 开关不在文件里，统一存 plugin_kv（plugin_id=skills, key=skill:<id>）：
// 默认开——新放进去的技能不用点开关就能用，只有显式停用才不进目录。
//
// 这里只做「读宿主文件」的纯逻辑；写沙箱、工具注册、prompt 注入都在 skills 插件里。
// 桌面端「工作 → 技能库」也读同一份扫描结果，避免两处口径漂移。
// ============================================================

import { existsSync, lstatSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';

/** plugin_kv 里技能开关的键（值形如 {"enabled":false}） */
export const skillStateKey = (id: string): string => `skill:${id}`;

export const SKILL_PLUGIN_ID = 'skills';

/** 单个技能目录最多收多少个附带文件（扫描/装配共用） */
export const MAX_SKILL_FILES = 300;
/** 扫描时最多递归几层（防止把大仓库误当技能目录整棵走完） */
const MAX_SCAN_DEPTH = 6;
/** 没有 frontmatter description 时，用正文首行兜底的最大长度 */
const DESCRIPTION_FALLBACK_CHARS = 120;

const SCRIPT_EXT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|r|lua)$/i;

export interface SkillAttachment {
  /** 相对技能目录的路径（统一正斜杠） */
  rel: string;
  size: number;
}

export interface SkillMeta {
  /** 目录名 / 文件名（不含 .md），调用方按它取技能 */
  id: string;
  /** frontmatter 里的展示名，缺省与 id 相同 */
  name: string;
  description: string;
  version?: string;
  /** 目录式技能的根目录；平铺 md 为空串 */
  dir: string;
  /** SKILL.md 或平铺 md 的绝对路径 */
  file: string;
  /** 附带文件（不含 SKILL.md） */
  attachments: SkillAttachment[];
  /** 附带文件里有没有脚本（UI 打个标；装配后可直接跑） */
  hasScripts: boolean;
  source: 'builtin' | 'user';
  mtimeMs: number;
}

/** 极简 YAML 头（只认 name / description / version 这类单行键） */
export function parseSkillDoc(raw: string): { head: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { head: {}, body: text.trim() };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { head: {}, body: text.trim() };
  const head: Record<string, string> = {};
  for (const line of text.slice(3, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue; // 不解析嵌套结构
    const i = line.indexOf(':');
    if (i === -1) continue;
    head[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { head, body: text.slice(end + 4).trim() };
}

/** frontmatter 没写 description 时，拿正文第一行当说明（去掉标题符号，截断） */
function descriptionOf(head: Record<string, string>, body: string): string {
  const explicit = (head.description ?? '').trim();
  if (explicit) return explicit;
  for (const line of body.split('\n')) {
    const t = line.replace(/^#{1,6}\s*/, '').replace(/[*_`]/g, '').trim();
    if (!t) continue;
    return t.length > DESCRIPTION_FALLBACK_CHARS ? `${t.slice(0, DESCRIPTION_FALLBACK_CHARS)}…` : t;
  }
  return '';
}

/** 走一个技能目录，收集附带文件（跳过点目录 / node_modules / 符号链接） */
function walkAttachments(root: string): SkillAttachment[] {
  const out: SkillAttachment[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (out.length >= MAX_SKILL_FILES || depth > MAX_SCAN_DEPTH) return;
    let names: string[];
    try { names = readdirSync(abs).sort(); } catch { return; }
    for (const name of names) {
      if (out.length >= MAX_SKILL_FILES) return;
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = join(abs, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      const relP = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) { walk(p, relP, depth + 1); continue; }
      if (!st.isFile() || relP.toLowerCase() === 'skill.md') continue;
      out.push({ rel: relP, size: st.size });
    }
  };
  walk(root, '', 0);
  return out;
}

/** 一个来源目录里的技能：平铺 md 先收，同名目录式技能再覆盖它（目录形态更完整） */
function collectRoot(root: string, source: 'builtin' | 'user'): SkillMeta[] {
  if (!existsSync(root)) return [];
  let entries: Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const byId = new Map<string, SkillMeta>();

  const flat: SkillMeta[] = [];
  const dirs: SkillMeta[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = join(root, e.name);
    if (e.isDirectory()) {
      const file = ['SKILL.md', 'skill.md'].map((n) => join(abs, n)).find((p) => existsSync(p));
      if (!file) continue;
      let raw: string;
      let mtimeMs: number;
      try {
        const st = lstatSync(file);
        if (!st.isFile()) continue;      // SKILL.md 是符号链接/目录：不跟
        raw = readFileSync(file, 'utf8');
        mtimeMs = st.mtimeMs;
      } catch { continue; }
      const { head, body } = parseSkillDoc(raw);
      const id = e.name;
      const attachments = walkAttachments(abs);
      dirs.push({
        id,
        name: (head.name || id).trim(),
        description: descriptionOf(head, body),
        version: head.version?.trim() || undefined,
        dir: abs,
        file,
        attachments,
        hasScripts: attachments.some((a) => SCRIPT_EXT.test(a.rel)),
        source,
        mtimeMs,
      });
    } else if (e.isFile() && /\.md$/i.test(e.name)) {
      let raw: string;
      let mtimeMs: number;
      try { raw = readFileSync(abs, 'utf8'); mtimeMs = statSync(abs).mtimeMs; } catch { continue; }
      const { head, body } = parseSkillDoc(raw);
      const id = basename(e.name, extname(e.name));
      flat.push({
        id,
        name: (head.name || id).trim(),
        description: descriptionOf(head, body),
        version: head.version?.trim() || undefined,
        dir: '',
        file: abs,
        attachments: [],
        hasScripts: false,
        source,
        mtimeMs,
      });
    }
  }
  for (const s of flat) byId.set(s.id.toLowerCase(), s);
  for (const s of dirs) byId.set(s.id.toLowerCase(), s);
  return [...byId.values()];
}

/** 扫描两个来源目录；user 的同名技能覆盖 builtin */
export function scanSkills(opts: { builtinDir?: string; userDir: string }): SkillMeta[] {
  const byId = new Map<string, SkillMeta>();
  if (opts.builtinDir) for (const s of collectRoot(opts.builtinDir, 'builtin')) byId.set(s.id.toLowerCase(), s);
  for (const s of collectRoot(opts.userDir, 'user')) byId.set(s.id.toLowerCase(), s);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 按 id 或展示名找技能（大小写不敏感；先精确 id，再展示名） */
export function findSkill(list: SkillMeta[], name: string): SkillMeta | undefined {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return undefined;
  return list.find((s) => s.id.toLowerCase() === key) ?? list.find((s) => s.name.toLowerCase() === key);
}

/** 读技能正文（去掉 frontmatter）；超过上限截断并回报 */
export function readSkillBody(skill: SkillMeta, cap = 32_000): { text: string; truncated: boolean } {
  const raw = readFileSync(skill.file, 'utf8');
  const { body } = parseSkillDoc(raw);
  const text = body || raw.trim();
  return text.length > cap
    ? { text: text.slice(0, cap), truncated: true }
    : { text, truncated: false };
}

/**
 * 技能目录内的相对路径 → 绝对路径；越界/绝对路径一律返回 null。
 * 平铺 md 只允许读它自己（SKILL.md 或原文件名）。
 */
export function resolveInsideSkill(skill: SkillMeta, relPath: string): string | null {
  const rel = String(relPath ?? '').trim().replace(/\\/g, '/');
  if (!skill.dir) {
    if (!rel || rel.toLowerCase() === 'skill.md' || rel === basename(skill.file)) return skill.file;
    return null;
  }
  if (!rel) return skill.file;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return null;
  const root = resolve(skill.dir);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/** 装配到沙箱时用的目录名（id 来自文件名，清掉路径分隔符一类字符） */
export function safeSkillDirName(id: string): string {
  return id.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '_') || 'skill';
}

/** 技能目录里「展示名（调用 id）」的统一写法（system 目录与工具返回共用） */
export function skillLabel(s: SkillMeta): string {
  return s.name && s.name !== s.id ? `${s.name}（${s.id}）` : s.id;
}

/** 给 work system 用的目录行：只放名称与一句话说明，正文按需用 tool 取 */
export function skillCatalogLines(list: SkillMeta[]): string[] {
  return list.map((s) => `- ${skillLabel(s)}：${s.description || '（未写 description）'}`);
}
