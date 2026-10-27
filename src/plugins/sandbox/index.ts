import type { PluginContext, ChatRef, SandboxEntry } from '../../kernel/types.ts';
import { resolve as resolvePath } from 'node:path';

// ============================================================
// sandbox —— 会话沙箱系统插件
// 边界（红线 §3.2）：LLM 文件工具只能触达当前会话沙箱目录（内核强校验），
// 发送文件仅限沙箱内文件；脚本受限执行；文件临时性（TTL 清理）。
// ============================================================

/** 读文件的分页参数：默认 200 行、单次最多 2000 行 / 12000 字符（防一行超长的文件把上下文顶爆） */
const READ_LINES = 200;
const READ_MAX_LINES = 2000;
const READ_CHARS = 12_000;
/** 搜索的上限：扫的文件数 / 单文件大小 / 命中条数（宁可少给，也不要一次工具调用把上下文塞满） */
const GREP_MAX_SCAN = 500;
const GREP_MAX_FILE_BYTES = 512_000;
const GREP_MAX_HITS = 60;
const GLOB_MAX_SCAN = 800;
const GLOB_MAX_HITS = 100;

/**
 * 极简 glob → 正则：支持 `**`（跨层）、`*`（层内任意）、`?`（层内单字符）。
 * 不含 `/` 的模式按 `**\/模式` 处理（`*.md` 等价 `**\/*.md`），与常见的"找任意层级的这类文件"直觉一致。
 */
function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/');
  if (!g.includes('/')) g = `**/${g}`;
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; out += '(?:[^/]+/)*'; }   // `**/` 也匹配零层
        else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function setup(ctx: PluginContext): void {
  const sb = ctx.sandbox;
  const chatRefOf = (tctx: { chat: ChatRef }): ChatRef => tctx.chat;

  ctx.llm.registerTool({
    name: 'sandbox_list',
    description: '列出当前会话沙箱目录下的文件（只能看到本会话的沙箱）。',
    promptSnippet: '列出会话沙箱里的文件',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径，默认根目录' } },
    },
    handler: (args, tctx) => {
      const entries = sb.list(chatRefOf(tctx), String(args.path ?? '.'));
      if (!entries.length) return '（沙箱为空）';
      return entries.map((e) => `${e.type === 'dir' ? '[目录]' : '[文件]'} ${e.relPath} (${e.size}B)`).join('\n');
    },
  });

  ctx.llm.registerTool({
    name: 'sandbox_read',
    description: '读取当前会话沙箱内的文件。文本文件按行分页（先用默认读开头，再用 offset 续读，会告诉你还有多少行）；图片文件（png/jpg/webp/gif）直接把图片本身返回给你看。',
    promptSnippet: '读会话沙箱内的文件：文本分页读，图片直接看',
    promptGuidelines: [
      '读大文件先看开头再决定读哪一段：一次全读进来既费上下文，也常被截断。',
      '要看沙箱里的图片（题图、截图、参考图）就直接 sandbox_read 它——图片会作为画面返回，不要用 OCR 去抠字，也不用装任何库。',
      '超过 8 MB 的图片会读不了：先用 Python（PIL 可用）缩小另存一份，再读那个小文件。',
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '沙箱内相对路径' },
        offset: { type: 'number', description: '起始行号（1 起，默认 1）' },
        limit: { type: 'number', description: '最多读多少行（默认 200，上限 2000）' },
      },
      required: ['path'],
    },
    handler: (args, tctx) => {
      const rel = String(args.path ?? '');
      try {
        // 图片走视觉通道：模型直接看见画面；非图片扩展名 readImage 返回 null，照旧按文本读
        const img = sb.readImage(chatRefOf(tctx), rel);
        if (img) {
          const kb = Math.max(1, Math.round(img.size / 1024));
          return {
            content: `[图片] ${rel}（${img.mime}，${kb} KB）已随这条结果附上，直接看这张图。`,
            images: [{ data: img.data, mimeType: img.mime }],
            meta: { path: rel },
          };
        }
        const content = sb.read(chatRefOf(tctx), rel);
        const lines = content.split('\n');
        const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
        const limit = Math.min(Math.max(1, Math.floor(Number(args.limit) || READ_LINES)), READ_MAX_LINES);
        const picked: string[] = [];
        let chars = 0;
        for (let i = offset - 1; i < lines.length && picked.length < limit; i++) {
          const l = lines[i];
          // 单行就超预算时也要给出这一行（否则会在同一行上原地打转）
          if (picked.length && chars + l.length + 1 > READ_CHARS) break;
          picked.push(l);
          chars += l.length + 1;
        }
        const text = picked.join('\n');
        const end = offset - 1 + picked.length;
        // 一次读完的小文件不加脚注，与旧行为一致
        if (offset === 1 && end >= lines.length) return text;
        const more = end < lines.length;
        return `${text}\n…（第 ${offset}-${end} 行 / 共 ${lines.length} 行${more ? `；继续读用 offset=${end + 1}` : ''}）`;
      } catch (e) {
        return `读取失败：${(e as Error).message}`;
      }
    },
  });

  ctx.llm.registerTool({
    name: 'sandbox_edit',
    description: '按精确文本替换修改沙箱内已存在的文件。每个 edits[].oldText 必须在原文里唯一出现，且各处的范围不能重叠——要改相邻位置就合并成一次编辑。',
    promptSnippet: '按精确文本替换改文件（不必整文件重写）',
    promptGuidelines: [
      '改已有文件的局部用 sandbox_edit：oldText 带够上下文保证唯一（含缩进与换行），改完的文件不会丢别的段落。',
      'oldText 匹配失败或匹配到多处，先 sandbox_read 看清原文再改，不要改用 sandbox_write 整文件覆盖。',
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '沙箱内相对路径（必须已存在）' },
        edits: {
          type: 'array',
          description: '一处或多处替换，按顺序应用',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: '要被替换的原文（必须在文件里唯一出现）' },
              newText: { type: 'string', description: '替换成什么（删掉就留空串）' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    handler: (args, tctx) => {
      const chat = chatRefOf(tctx);
      const rel = String(args.path ?? '').trim();
      if (!rel) return '编辑被拒绝：要给 path。';
      const raw = Array.isArray(args.edits) ? args.edits : [];
      const edits = raw.map((e: any) => ({ oldText: String(e?.oldText ?? ''), newText: String(e?.newText ?? '') }));
      if (!edits.length) return '编辑被拒绝：edits 不能为空（改一处也要写成一条）。';
      const blank = edits.findIndex((e) => !e.oldText);
      if (blank !== -1) return `编辑被拒绝：第 ${blank + 1} 处 oldText 是空的。`;
      let before: string;
      try { before = sb.read(chat, rel); } catch (e) { return `编辑失败：${(e as Error).message}`; }

      const spots: { start: number; end: number; newText: string; index: number }[] = [];
      for (let i = 0; i < edits.length; i++) {
        const { oldText, newText } = edits[i];
        const first = before.indexOf(oldText);
        if (first === -1) return `第 ${i + 1} 处没匹配上：oldText 在 ${rel} 里找不到（空白与缩进要一模一样）。先 sandbox_read 看清原文。`;
        if (before.indexOf(oldText, first + 1) !== -1) {
          return `第 ${i + 1} 处的 oldText 在 ${rel} 里出现多次，无法确定改哪一处：把上下文写长一点（带上前后行）让它唯一。`;
        }
        spots.push({ start: first, end: first + oldText.length, newText, index: i });
      }
      spots.sort((a, b) => a.start - b.start);
      for (let i = 1; i < spots.length; i++) {
        if (spots[i].start < spots[i - 1].end) {
          return `第 ${spots[i - 1].index + 1} 处与第 ${spots[i].index + 1} 处的范围重叠：相邻改动请合并成一次编辑。`;
        }
      }
      let out = '';
      let cursor = 0;
      for (const s of spots) { out += before.slice(cursor, s.start) + s.newText; cursor = s.end; }
      out += before.slice(cursor);
      try {
        const w = sb.write(chat, rel, out);
        return {
          content: `已改 ${w.relPath}：${spots.length} 处（+${w.added} -${w.removed} 行，共 ${w.size} 字节）`,
          // artifacts 与 sandbox_write 同口径：改过的文件也算交付产物
          meta: { path: w.relPath, added: w.added, removed: w.removed, artifacts: [w.relPath] },
        };
      } catch (e) {
        return `编辑失败：${(e as Error).message}`;
      }
    },
  });

  ctx.llm.registerTool({
    name: 'sandbox_grep',
    description: '在会话沙箱内按正则搜索文本内容，返回「路径:行号: 内容」。可用 path 限定子目录、用 glob 只搜某类文件（如 **/*.md）。',
    promptSnippet: '在沙箱里按正则搜内容（path 限定目录 / glob 限定文件类型）',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则（默认忽略大小写；不支持时先转义）' },
        path: { type: 'string', description: '从哪个子目录开始搜，默认沙箱根' },
        glob: { type: 'string', description: '只搜匹配的文件，如 **/*.md 或 *.csv' },
        case_sensitive: { type: 'boolean', description: 'true = 区分大小写（默认忽略）' },
      },
      required: ['pattern'],
    },
    handler: (args, tctx) => {
      const pattern = String(args.pattern ?? '');
      if (!pattern) return '搜索被拒绝：pattern 不能为空。';
      let re: RegExp;
      try { re = new RegExp(pattern, args.case_sensitive === true ? '' : 'i'); }
      catch (e) { return `正则不合法：${(e as Error).message}`; }
      let fileRe: RegExp | undefined;
      if (args.glob) {
        try { fileRe = globToRegExp(String(args.glob)); } catch { return 'glob 不合法。'; }
      }
      let walked: { files: SandboxEntry[]; truncated: boolean };
      try { walked = sb.walkFiles(chatRefOf(tctx), String(args.path ?? '.'), { maxFiles: GREP_MAX_SCAN }); }
      catch (e) { return `搜索失败：${(e as Error).message}`; }

      const hits: string[] = [];
      let scanned = 0;
      let skipped = 0;
      for (const f of walked.files) {
        if (fileRe && !fileRe.test(f.relPath)) continue;
        if (f.size > GREP_MAX_FILE_BYTES) { skipped++; continue; }
        let text: string;
        try { text = sb.read(chatRefOf(tctx), f.relPath); } catch { continue; }
        if (text.includes('\0')) { skipped++; continue; }   // 二进制
        scanned++;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          hits.push(`${f.relPath}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          if (hits.length >= GREP_MAX_HITS) break;
        }
        if (hits.length >= GREP_MAX_HITS) break;
      }
      if (!hits.length) {
        return `（没有匹配：扫了 ${scanned} 个文件${skipped ? `，跳过 ${skipped} 个（二进制或过大）` : ''}）`;
      }
      const notes = [`扫了 ${scanned} 个文件，命中 ${hits.length} 处`];
      if (hits.length >= GREP_MAX_HITS) notes.push(`只给到 ${GREP_MAX_HITS} 处，收窄 pattern 或加 glob/path 再搜`);
      if (walked.truncated) notes.push('目录太大只扫了一部分，建议加 path 限定');
      if (skipped) notes.push(`跳过 ${skipped} 个二进制/过大文件`);
      return `${hits.join('\n')}\n（${notes.join('；')}）`;
    },
  });

  ctx.llm.registerTool({
    name: 'sandbox_glob',
    description: '按文件名模式找会话沙箱内的文件（**/*.csv、reports/**、*.md 这类），按最近修改时间排序。',
    promptSnippet: '按模式找沙箱里的文件（**/*.csv）',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式；不含 / 时按任意层级匹配（如 *.md = **/*.md）' },
        path: { type: 'string', description: '从哪个子目录开始找，默认沙箱根' },
      },
      required: ['pattern'],
    },
    handler: (args, tctx) => {
      const pattern = String(args.pattern ?? '').trim();
      if (!pattern) return '查找被拒绝：pattern 不能为空。';
      let re: RegExp;
      try { re = globToRegExp(pattern); } catch { return 'glob 不合法。'; }
      let walked: { files: SandboxEntry[]; truncated: boolean };
      try { walked = sb.walkFiles(chatRefOf(tctx), String(args.path ?? '.'), { maxFiles: GLOB_MAX_SCAN }); }
      catch (e) { return `查找失败：${(e as Error).message}`; }
      const found = walked.files.filter((f) => re.test(f.relPath)).sort((a, b) => b.mtime - a.mtime);
      if (!found.length) return `（没有匹配 ${pattern} 的文件）`;
      const shown = found.slice(0, GLOB_MAX_HITS);
      const lines = shown.map((f) => `${f.relPath} (${f.size}B, ${new Date(f.mtime).toISOString().slice(0, 16).replace('T', ' ')})`);
      const tail = found.length > shown.length ? `\n（共 ${found.length} 个，只列出最近修改的 ${shown.length} 个）` : '';
      return `${lines.join('\n')}${tail}`;
    },
  });

  ctx.llm.registerTool({
    name: 'sandbox_write',
    description: '在当前会话沙箱内创建/修改文本文件（如脚本、笔记）。临时性文件，一段时间不访问会自动清理。',
    promptSnippet: '在会话沙箱内写/改文本文件（产物就落在这里）',
    promptGuidelines: ['产物一律写进会话沙箱（sandbox_write），并把相对路径登记到交付的 artifacts 里。'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '沙箱内相对路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
    handler: (args, tctx) => {
      try {
        const r = sb.write(chatRefOf(tctx), String(args.path), String(args.content ?? ''));
        return {
          content: `已写入 ${r.relPath}（${r.size} 字节）`,
          // artifacts 是给 work 侧汇总产物清单用的结构化字段（不进模型上下文）
          meta: { path: r.relPath, added: r.added, removed: r.removed, artifacts: [r.relPath] },
        };
      } catch (e) {
        return `写入失败：${(e as Error).message}`;
      }
    },
  });

  ctx.llm.registerTool({
    name: 'run_python',
    description: '在沙箱内运行 Python 脚本（无网络、限时、输出截断），可用于计算、处理文本、生成临时文件。',
    promptSnippet: '在沙箱里跑一次性 Python（无网络）',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python 源码' },
        timeout_ms: { type: 'number', description: '可选超时（毫秒），默认 15000，上限 20000' },
      },
      required: ['code'],
    },
    handler: async (args, tctx) => {
      const code = String(args.code ?? '');
      // work 轮的 run_python 也必须是容器隔离：走 runAny(work:true)，容器不可用就报错，
      // 不能回落到宿主机子进程（那条路能读整台机器）。
      const r = tctx.work
        ? await sb.runAny(chatRefOf(tctx), { language: 'python', code, timeoutMs: Number(args.timeout_ms) || undefined, work: true })
        : await sb.run(chatRefOf(tctx), { language: 'python', code, timeoutMs: Number(args.timeout_ms) || undefined });
      const parts: string[] = [`exit=${r.exitCode} (${r.durationMs}ms)`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      if (r.timedOut) parts.push('（超时被终止）');
      const text = parts.join('\n') || '（无输出）';
      const changes = (r as { changes?: { path: string; added: number; removed: number }[] }).changes;
      return changes?.length ? { content: text, meta: { changes } } : text;
    },
  });

  ctx.llm.registerTool({
    name: 'run_js',
    description: '在沙箱内运行 JavaScript（Node ESM，无网络、限时、输出截断）。用 console.log 输出。',
    promptSnippet: '在沙箱里跑一次 Node JS（无网络）',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JS 源码（ESM）' },
        timeout_ms: { type: 'number', description: '可选超时（毫秒），默认 10000' },
      },
      required: ['code'],
    },
    handler: async (args, tctx) => {
      const code = String(args.code ?? '');
      const r = tctx.work
        ? await sb.runAny(chatRefOf(tctx), { language: 'javascript', code, timeoutMs: Number(args.timeout_ms) || undefined, work: true })
        : await sb.run(chatRefOf(tctx), { language: 'javascript', code, timeoutMs: Number(args.timeout_ms) || undefined });
      const parts: string[] = [`exit=${r.exitCode} (${r.durationMs}ms)`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      if (r.timedOut) parts.push('（超时被终止）');
      const text = parts.join('\n') || '（无输出）';
      const changes = (r as { changes?: { path: string; added: number; removed: number }[] }).changes;
      return changes?.length ? { content: text, meta: { changes } } : text;
    },
  });

  ctx.llm.registerTool({
    name: 'send_file',
    description: '把当前会话沙箱内的文件发送到聊天（仅限沙箱内文件）。先确认文件存在。',
    promptSnippet: '把会话沙箱里的文件直接发给用户',
    promptGuidelines: ['用户说"发给我""发文件"时用 send_file 直接把沙箱里的产物发过去，不要只给路径。'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '沙箱内相对路径' } },
      required: ['path'],
    },
    handler: async (args, tctx) => {
      const rel = String(args.path ?? '');
      // work 轮拿到的 chat 是任务沙箱的合成引用（private_u<QQ>__t<task>），不是真实收件人；
      // 直接发会把合成 id 当 QQ 号传给协议端。产物一律走 work_finish 的 artifacts。
      if (tctx.work || /^u\d+$/.test(tctx.chat.chatId)) {
        return 'work 轮不要直接发文件：把路径登记进 work_finish 的 artifacts，交付轮会统一发给用户。';
      }
      let abs: string;
      try {
        abs = joinPath(sb.root(chatRefOf(tctx)), rel);
      } catch (e) {
        return `路径不合法：${(e as Error).message}`;
      }
      try {
        await ctx.chat.sendFile(chatRefOf(tctx), abs);
        return `已发送 ${rel}`;
      } catch (e) {
        return `发送失败：${(e as Error).message}`;
      }
    },
  });
}

function joinPath(root: string, rel: string): string {
  // 由内核 resolveInside 做边界校验，这里仅拼接展示用
  return resolvePath(root, rel);
}
