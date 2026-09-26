import type { PluginContext, ChatRef } from '../../kernel/types.ts';
import { resolve as resolvePath } from 'node:path';

// ============================================================
// sandbox —— 会话沙箱系统插件
// 边界（红线 §3.2）：LLM 文件工具只能触达当前会话沙箱目录（内核强校验），
// 发送文件仅限沙箱内文件；脚本受限执行；文件临时性（TTL 清理）。
// ============================================================

export function setup(ctx: PluginContext): void {
  const sb = ctx.sandbox;
  const chatRefOf = (tctx: { chat: ChatRef }): ChatRef => tctx.chat;

  ctx.llm.registerTool({
    name: 'sandbox_list',
    description: '列出当前会话沙箱目录下的文件（只能看到本会话的沙箱）。',
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
    description: '读取当前会话沙箱内的文本文件。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '沙箱内相对路径' } },
      required: ['path'],
    },
    handler: (args, tctx) => {
      try {
        const content = sb.read(chatRefOf(tctx), String(args.path));
        return content.length > 6000 ? content.slice(0, 6000) + '\n…(过长截断)' : content;
      } catch (e) {
        return `读取失败：${(e as Error).message}`;
      }
    },
  });

  ctx.llm.registerTool({
    name: 'sandbox_write',
    description: '在当前会话沙箱内创建/修改文本文件（如脚本、笔记）。临时性文件，一段时间不访问会自动清理。',
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
          meta: { path: r.relPath, added: r.added, removed: r.removed },
        };
      } catch (e) {
        return `写入失败：${(e as Error).message}`;
      }
    },
  });

  ctx.llm.registerTool({
    name: 'run_python',
    description: '在沙箱内运行 Python 脚本（无网络、限时、输出截断），可用于计算、处理文本、生成临时文件。',
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
      const r = await sb.run(chatRefOf(tctx), { language: 'python', code, timeoutMs: Number(args.timeout_ms) || undefined });
      const parts: string[] = [`exit=${r.exitCode} (${r.durationMs}ms)`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      if (r.timedOut) parts.push('（超时被终止）');
      return parts.join('\n') || '（无输出）';
    },
  });

  ctx.llm.registerTool({
    name: 'run_js',
    description: '在沙箱内运行 JavaScript（Node ESM，无网络、限时、输出截断）。用 console.log 输出。',
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
      const r = await sb.run(chatRefOf(tctx), { language: 'javascript', code, timeoutMs: Number(args.timeout_ms) || undefined });
      const parts: string[] = [`exit=${r.exitCode} (${r.durationMs}ms)`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      if (r.timedOut) parts.push('（超时被终止）');
      return parts.join('\n') || '（无输出）';
    },
  });

  ctx.llm.registerTool({
    name: 'send_file',
    description: '把当前会话沙箱内的文件发送到聊天（仅限沙箱内文件）。先确认文件存在。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '沙箱内相对路径' } },
      required: ['path'],
    },
    handler: async (args, tctx) => {
      const rel = String(args.path ?? '');
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

  ctx.registerCommand({
    name: '沙箱',
    description: '查看/清空本会话沙箱（清空需管理员）',
    usage: '/沙箱 [查看|清空]',
    handler: async (args, event) => {
      const chat: ChatRef = { platform: event.platform, type: event.type, chatId: event.chatId };
      const sub = args[0] ?? '查看';
      if (sub === '清空') {
        if (event.role === 'member') return { text: '权限不足：清空沙箱需要群管理员/主人。' };
        sb.clear(chat);
        return { text: '本会话沙箱已清空。' };
      }
      const stats = sb.stats().find((s) => s.chat === `${event.type}_${event.chatId}`);
      if (!stats || stats.files === 0) return { text: '本会话沙箱为空。LLM 可通过工具读写文件、运行脚本；聊天收到的文件也会落在这里。' };
      const entries = sb.list(chat);
      const lines = entries.slice(0, 20).map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.relPath} (${e.size}B)`);
      return {
        text: `本会话沙箱（${stats.files} 个文件，共 ${(stats.bytes / 1024).toFixed(1)}KB）：\n${lines.join('\n')}\n\n临时文件超期自动清理。${event.role !== 'member' ? '\n管理员可发 /沙箱 清空' : ''}`,
      };
    },
  });
}

function joinPath(root: string, rel: string): string {
  // 由内核 resolveInside 做边界校验，这里仅拼接展示用
  return resolvePath(root, rel);
}
