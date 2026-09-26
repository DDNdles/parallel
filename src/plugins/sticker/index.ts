import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import type { PluginContext } from '../../kernel/types.ts';

// ============================================================
// sticker —— 表情包发送/搜索/建库
// 群级库：data/stickers/<chatKey>/ 存图，插件 state 存索引。
// 收图：回复一张图片 + 「/表情 收 名字」；发送：/表情 名字；搜索：/表情 搜 关键词；
// 随机：/表情 随机；删除（管理员）：/表情 删 名字。LLM 工具：send_sticker。
// ============================================================

const here = dirname(fileURLToPath(import.meta.url));
// 图片存放在数据目录（由内核 dataDir 推导：data/../../.. 不稳，改用内核 bus 提供）——
// 简化：存放在 data/stickers（通过 sandbox 之外的专用目录，插件有 state 但无任意 fs 权限，
// 因此图片文件走「聊天图片下载」通道由适配器落入沙箱 inbox，此处复制进专用库）。

interface StickerItem { name: string; file: string; tags: string; count: number; lastUsed: number; }

export function setup(ctx: PluginContext): void {
  const storeDir = join(ctx.pluginDataDir, 'stickers');
  mkdirSync(storeDir, { recursive: true });

  const indexKey = (chatKey: string) => `index:${chatKey}`;

  function list(chatKey: string): StickerItem[] {
    return ctx.state.get<StickerItem[]>(indexKey(chatKey), []) ?? [];
  }
  function save(chatKey: string, items: StickerItem[]): void {
    ctx.state.set(indexKey(chatKey), items);
  }

  function resolveFile(chatKey: string, file: string): string {
    return join(storeDir, chatKey, file);
  }

  // ---------- 收图 ----------

  ctx.hooks.onChatMessage = (event) => {
    const text = event.text.trim();
    const m = text.match(/^(?:\/?表情)\s+收\s+(\S+)\s*$/);
    if (!m) return;
    const name = m[1];
    // 找图片段（适配器已把消息内图片落入沙箱 inbox）
    const imgSeg = event.segments.find((s) => s.type === 'image');
    const inbox = event.files?.[0];
    if (!imgSeg && !inbox) {
      void ctx.chat.reply(event, '收表情要用「回复一张图片 + /表情 收 名字」的方式喵。');
      return;
    }
    void (async () => {
      try {
        const chatKey = `${event.type}_${event.chatId}`;
        // inbox 优先（适配器已落盘），否则按 file id 从沙箱找
        let src: string | undefined = inbox?.sandboxPath;
        if (!src) {
          // 图片段在纯文本里没有本地路径：提示先让图片进沙箱（适配器会在同一条消息带上 files）
          src = undefined;
        }
        if (!src || !existsSync(src)) {
          await ctx.chat.reply(event, '没有拿到图片本体（需要图片和命令在同一条消息里发出）。');
          return;
        }
        mkdirSync(join(storeDir, chatKey), { recursive: true });
        const ext = (name.match(/\.(png|jpe?g|gif|webp)$/i)?.[1] ?? 'png').toLowerCase();
        const fileName = `${sanitize(name)}.${ext}`;
        const dest = resolveFile(chatKey, fileName);
        writeFileSync(dest, readFileSync(src));
        const items = list(chatKey).filter((s) => s.name !== name);
        items.push({ name, file: fileName, tags: '', count: 0, lastUsed: 0 });
        save(chatKey, items);
        await ctx.chat.reply(event, `已收录表情「${name}」（库里现有 ${items.length} 张）`);
      } catch (e) {
        ctx.log.error(`收表情失败: ${(e as Error).message}`);
      }
    })();
  };

  function sanitize(s: string): string {
    return s.replace(/[\\/:*?"<>|.]/g, '_').slice(0, 40);
  }

  // ---------- 发送 ----------

  async function sendSticker(chatKey: string, chat: { platform: string; type: 'group' | 'private'; chatId: string }, name: string): Promise<boolean> {
    const items = list(chatKey);
    const item = items.find((s) => s.name === name);
    if (!item) return false;
    const abs = resolveFile(chatKey, item.file);
    if (!existsSync(abs)) return false;
    await ctx.chat.send(chat, [{ type: 'image', data: { file: abs } }]);
    item.count += 1;
    item.lastUsed = Date.now();
    save(chatKey, items);
    return true;
  }

  ctx.llm.registerTool({
    name: 'send_sticker',
    description: '从本群表情库里发一张表情包。先用 list_stickers 看有什么。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '表情名' } },
      required: ['name'],
    },
    handler: async (args, tctx) => {
      const chatKey = `${tctx.chat.type}_${tctx.chat.chatId}`;
      const ok = await sendSticker(chatKey, tctx.chat, String(args.name ?? ''));
      return ok ? `已发送表情「${args.name}」` : `表情库里没有「${args.name}」`;
    },
  });

  ctx.llm.registerTool({
    name: 'list_stickers',
    description: '列出本群表情库（名称列表）。',
    parameters: { type: 'object', properties: {} },
    handler: (_args, tctx) => {
      const items = list(`${tctx.chat.type}_${tctx.chat.chatId}`);
      return items.length ? '表情库：' + items.map((s) => s.name).join('、') : '（本群表情库为空）';
    },
  });

  // ---------- 命令 ----------

  ctx.registerCommand({
    name: '表情',
    description: '表情包库：/表情 名字（发送）、/表情 搜 关键词、/表情 随机、/表情 收 名字（回复图片）、/表情 删 名字（管理员）',
    handler: async (args, event) => {
      const chatKey = `${event.type}_${event.chatId}`;
      const chat = { platform: event.platform, type: event.type, chatId: event.chatId };
      const items = list(chatKey);
      const sub = args[0] ?? '随机';

      if (sub === '搜') {
        const kw = (args[1] ?? '').toLowerCase();
        const hits = items.filter((s) => s.name.toLowerCase().includes(kw) || s.tags.toLowerCase().includes(kw));
        return { text: hits.length ? `找到 ${hits.length} 张：${hits.map((s) => s.name).join('、')}` : `没有叫「${kw}」的表情。` };
      }
      if (sub === '随机') {
        if (!items.length) return { text: '本群表情库还是空的。回复一张图片发「/表情 收 名字」就能建库喵！' };
        const pick = items[Math.floor(Math.random() * items.length)];
        await sendSticker(chatKey, chat, pick.name);
        return {};
      }
      if (sub === '删') {
        if (event.role === 'member') return { text: '权限不足：删表情需要群管理员/主人。' };
        const name = args[1];
        const item = items.find((s) => s.name === name);
        if (!item) return { text: `没有「${name}」这张表情。` };
        try { unlinkSync(resolveFile(chatKey, item.file)); } catch { /* ignore */ }
        save(chatKey, items.filter((s) => s.name !== name));
        return { text: `已删除「${name}」。` };
      }
      if (sub === '列表') {
        return { text: items.length ? `本群表情（${items.length}）：${items.map((s) => s.name).join('、')}` : '（空库）' };
      }
      // 发送指定
      if (items.some((s) => s.name === sub)) {
        await sendSticker(chatKey, chat, sub);
        return {};
      }
      return { text: '用法：/表情 名字（发送）、/表情 搜 关键词、/表情 随机、/表情 收 名字、/表情 列表、/表情 删 名字' };
    },
  });
}
