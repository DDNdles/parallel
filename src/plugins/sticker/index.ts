import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { PluginContext } from '../../kernel/types.ts';

// ============================================================
// sticker —— 表情包库（只给 LLM 工具面）
// 群级库：data/stickers/<chatKey>/ 存图（专用目录，插件无任意 fs 权限），插件 state 存索引。
// 2026-10-17 QQ 指令面清空：/表情 指令与「表情 收 名字」收图钩子一并删除，
// 现在只剩 work 面的 send_sticker / list_stickers 工具（没有收图入口，库不会再有新图）。
// ============================================================

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
}
