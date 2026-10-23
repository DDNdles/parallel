import type { PluginContext, LLMRequestContext } from '../../kernel/types.ts';
import {
  MAX_SKILL_FILES, findSkill, readSkillBody, resolveInsideSkill, safeSkillDirName,
  scanSkills, skillCatalogLines, skillLabel, skillStateKey, type SkillMeta,
} from '../../kernel/skills.ts';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
// skills 插件 —— work 子代理的「按需手册」
//
// 与 chat 无关：工具全部 surface:'work'，目录也只注入 work 轮（beforeWorkLLM）。
//  - system 只放目录（名字 + 一句话），正文用 `skill` 取，省 token、天然热加载；
//  - `skill_file` 读技能目录里的单个文本文件（references/scripts），路径钉死在目录内；
//  - `skill_install` 把整个技能目录拷进会话沙箱 `.skills/<名>/`，容器里才能跑它带的脚本；
//  - 开关在 plugin_kv（默认开），桌面端「工作 → 技能库」按技能逐条切换。
//
// 技能目录（user 同名覆盖 builtin）：
//   src/plugins/skills/builtin/<id>/SKILL.md   随代码分发（当前为空）
//   data/plugin-data/skills/<id>/SKILL.md      用户自加
// ============================================================

/** 单次返回给模型的正文上限（字符）；超出提示用 skill_file 读完整文件 */
const MAX_BODY_CHARS = 32_000;
/** skill_file 单文件上限（字节） */
const MAX_READ_BYTES = 512 * 1024;
/** skill_install 总大小上限（字节） */
const MAX_INSTALL_BYTES = 20 * 1024 * 1024;
/** 目录节最多列多少条（再多就只说数量，防止把 system 撑爆） */
const MAX_CATALOG = 50;
/** 扫描缓存：目录 mtime 级别的热加载对 Node 不友好，3 秒够用且不会让新文件等太久 */
const SCAN_TTL_MS = 3_000;

export function setup(ctx: PluginContext): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const builtinDir = join(here, 'builtin');
  const userDir = ctx.pluginDataDir;

  let cache: { at: number; list: SkillMeta[] } | null = null;
  const all = (force = false): SkillMeta[] => {
    if (!force && cache && Date.now() - cache.at < SCAN_TTL_MS) return cache.list;
    const list = scanSkills({ builtinDir, userDir });
    cache = { at: Date.now(), list };
    return list;
  };
  /** 默认开：没写过开关的技能直接用；只有显式 {"enabled":false} 才算停用 */
  const enabledOf = (id: string): boolean => {
    const v = ctx.state.get<{ enabled?: boolean }>(skillStateKey(id)) as { enabled?: boolean } | undefined;
    return v?.enabled !== false;
  };
  const active = (): SkillMeta[] => all().filter((s) => enabledOf(s.id));

  const listHint = (list: SkillMeta[]): string =>
    list.length ? list.map((s) => skillLabel(s)).join('、') : '（还没有技能）';

  const unknown = (name: string): string => {
    const list = all();
    return `没有名为「${name}」的技能。现有：${listHint(list)}。`;
  };

  // ---------------- 技能工具（work 面） ----------------

  ctx.llm.registerTool({
    name: 'skill',
    description: '读取一个技能的完整操作手册（SKILL.md 正文）。技能目录在 system 里列出；任务与其中某条描述明显相关时先读它，再照手册执行。',
    minRole: 'admin',
    surface: 'work',
    promptSnippet: '读取技能的完整操作手册（先看 system 里的技能目录）',
    promptGuidelines: [
      '任务与技能目录里的某条描述明显相关时，先用 skill 读它的正文；不相关就不要读，别把技能库当资料翻一遍。',
      '技能正文里提到的附带脚本/模板要真用起来：先 skill_install 把技能拷进会话沙箱，再在容器里执行。',
    ],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名（system 目录里括号中的 id，或展示名）' },
      },
      required: ['name'],
    },
    handler: (args) => {
      const wanted = String(args.name ?? '').trim();
      if (!wanted) return '要读哪个技能？给技能名（见 system 里的技能目录）。';
      const skill = findSkill(all(), wanted);
      if (!skill) return unknown(wanted);
      if (!enabledOf(skill.id)) {
        return `技能「${skill.name}」已停用（桌面端「工作 → 技能库」里可以打开）。`;
      }
      const body = readSkillBody(skill, MAX_BODY_CHARS);
      const head = [
        `[技能：${skillLabel(skill)}]`,
        skill.description ? `说明：${skill.description}` : '',
        skill.attachments.length
          ? `附带文件：${skill.attachments.map((a) => a.rel).join('、')}（文本用 skill_file 读；脚本/模板用 skill_install 拷进沙箱）`
          : '',
      ].filter(Boolean).join('\n');
      const tail = body.truncated ? '\n\n（正文超过上限已截断；完整内容用 skill_file 读 SKILL.md）' : '';
      return `${head}\n\n${body.text}${tail}`;
    },
  });

  ctx.llm.registerTool({
    name: 'skill_file',
    description: '读取技能目录里的单个文本文件（references/、scripts/ 等）。只能读该技能目录内的文件；二进制或要执行的文件用 skill_install。',
    minRole: 'admin',
    surface: 'work',
    promptSnippet: '读技能目录里的单个文本文件（路径只能在该技能目录内）',
    promptGuidelines: [
      '读技能附带资料用 skill_file；要执行脚本或使用模板，先用 skill_install 把整个技能拷进沙箱。',
    ],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名' },
        path: { type: 'string', description: '相对技能目录的路径（如 references/format.md）；缺省读 SKILL.md' },
      },
      required: ['name'],
    },
    handler: (args) => {
      const wanted = String(args.name ?? '').trim();
      const skill = findSkill(all(), wanted);
      if (!skill) return unknown(wanted);
      if (!enabledOf(skill.id)) return `技能「${skill.name}」已停用（桌面端「工作 → 技能库」里可以打开）。`;
      const rel = String(args.path ?? '').trim() || 'SKILL.md';
      const abs = resolveInsideSkill(skill, rel);
      if (!abs) return `路径越界：只能读技能「${skill.name}」目录里的文件。`;
      if (!existsSync(abs)) {
        const have = skill.attachments.length ? skill.attachments.map((a) => a.rel).join('、') : '（没有附带文件）';
        return `技能「${skill.name}」里没有 ${rel}。现有：${have}`;
      }
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || !st.isFile()) return `${rel} 不是普通文件，拒绝读取。`;
      if (st.size > MAX_READ_BYTES) return `${rel} 太大（${st.size} 字节），超过单文件读取上限。`;
      const buf = readFileSync(abs);
      if (buf.subarray(0, 4096).includes(0)) {
        return `${rel} 是二进制文件，skill_file 读不了；需要的话用 skill_install 拷进沙箱再处理。`;
      }
      return `[${skill.id}/${rel}]\n\n${buf.toString('utf-8')}`;
    },
  });

  ctx.llm.registerTool({
    name: 'skill_install',
    description: '把技能目录（含脚本、模板等附带文件）拷进会话沙箱的 .skills/<技能名>/ 下，之后可用 run_bash / run_python_work / sandbox_read 直接使用。',
    minRole: 'admin',
    surface: 'work',
    promptSnippet: '把技能目录拷进会话沙箱 .skills/（要跑技能自带脚本/用模板时）',
    promptGuidelines: [
      '技能附带脚本或模板时，先 skill_install，再用沙箱相对路径 .skills/<技能名>/... 去执行或读取。',
      'skill_install 会覆盖沙箱里上一次装进去的同名技能目录；不要把它当交付物登记进 artifacts。',
    ],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名' },
      },
      required: ['name'],
    },
    handler: (args, tctx) => {
      const wanted = String(args.name ?? '').trim();
      const skill = findSkill(all(), wanted);
      if (!skill) return unknown(wanted);
      if (!enabledOf(skill.id)) return `技能「${skill.name}」已停用（桌面端「工作 → 技能库」里可以打开）。`;

      const items: { rel: string; abs: string }[] = [{ rel: 'SKILL.md', abs: skill.file }];
      for (const a of skill.attachments) items.push({ rel: a.rel, abs: join(skill.dir, a.rel) });
      if (items.length > MAX_SKILL_FILES + 1) return `技能文件太多（${items.length} 个），超过装配上限。`;

      // 先整体校验再动沙箱：中途失败不会留下半份（旧的那份也还在）
      let total = 0;
      for (const it of items) {
        let st;
        try { st = lstatSync(it.abs); } catch { return `技能文件 ${it.rel} 读不到，装配中止。`; }
        if (st.isSymbolicLink() || !st.isFile()) return `技能文件 ${it.rel} 不是普通文件，装配中止。`;
        if (st.size > MAX_READ_BYTES) return `技能文件 ${it.rel} 太大（${st.size} 字节），装配中止。`;
        total += st.size;
        if (total > MAX_INSTALL_BYTES) return `技能体积超过装配上限（${MAX_INSTALL_BYTES} 字节），装配中止。`;
      }

      const dest = `.skills/${safeSkillDirName(skill.id)}`;
      try { ctx.sandbox.delete(tctx.chat, dest); } catch (e) {
        if (!/不存在/.test((e as Error).message)) return `清理旧目录失败：${(e as Error).message}`;
      }
      const written: string[] = [];
      try {
        for (const it of items) {
          const buf = readFileSync(it.abs);
          ctx.sandbox.write(tctx.chat, `${dest}/${it.rel}`, buf, { work: true });
          written.push(`${dest}/${it.rel}`);
        }
      } catch (e) {
        return `装配失败（已写入 ${written.length}/${items.length} 个文件）：${(e as Error).message}`;
      }

      const kb = Math.max(1, Math.round(total / 1024));
      const shown = written.slice(0, 20);
      return [
        `已装配技能「${skill.name}」到 ${dest}（${written.length} 个文件，约 ${kb} KB）。`,
        ...shown.map((p) => `- ${p}`),
        written.length > shown.length ? `- …等 ${written.length} 个` : '',
        `容器里相对 /ws 用这个路径；要读技能目录里的文本也可以继续用 skill_file。`,
      ].filter(Boolean).join('\n');
    },
  });

  // ---------------- work system：只放目录 ----------------
  ctx.hooks.beforeWorkLLM = (req: LLMRequestContext): LLMRequestContext => {
    // 工具面里没有 skill（例如 research/data 子代理没把 skill 写进 tools）就不提技能，避免 prompt 与工具面漂移
    if (!req.tools.some((t) => t.name === 'skill')) return req;
    const list = active();
    if (!list.length) return req;
    const shown = list.slice(0, MAX_CATALOG);
    const more = list.length > shown.length ? `（另有 ${list.length - shown.length} 个未列出；按名字也能取）` : '';
    req.systemSections = [...(req.systemSections ?? []), {
      order: 1000,
      name: 'skill-catalog',
      title: 'skill-catalog',
      text: [
        `# 可用技能（${list.length} 个）`,
        '技能正文不在这里展开。任务和某条技能明显相关时，先用 `skill` 取正文再照手册做；不相关不要取。',
        ...skillCatalogLines(shown),
        more,
      ].filter(Boolean).join('\n'),
    }];
    return req;
  };

  ctx.log.info?.(`skills 已加载：技能库 ${userDir}`);
}
