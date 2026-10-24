// ============================================================
// hello-plugin —— 用户自建插件模板
// 插件 = 一个目录：plugin.json（清单）+ index.ts/index.js（setup(ctx) 入口）
// 复制本目录到 parallel/data/plugins/ 下，然后在桌面端「插件」页执行安装（扫描 data/plugins）
// 即可热载入，无需重启内核。QQ 侧的 /插件 指令已随指令面清空删除，装在桌面端完成。
// ============================================================

import type { ChatEvent, CommandReply, PluginContext, ToolContext } from '../../src/kernel/types.ts';

export function setup(ctx: PluginContext) {
  // ---------- 1. LLM 工具（agent loop 可调用） ----------
  ctx.llm.registerTool({
    name: 'hello_greet',
    description: '用示例插件的方式向用户打招呼，并播报 TA 的好感度。',
    parameters: { type: 'object', properties: {} },
    async handler(_args: Record<string, unknown>, tctx: ToolContext) {
      // 好感度来自 chat 插件写入的 user_attrs；本插件只读（需 memory.read 权限）
      const affection = ctx.memory.getAttr(tctx.event.userId, 'affection') ?? 20;
      const word = ctx.userConfig.greetingWord ?? '哈喽';
      return `${word}！我是示例插件。你当前好感度是 ${affection}/100。`;
    },
  });

  // ---------- 2. 聊天命令 ----------
  ctx.registerCommand({
    name: '你好',
    description: '示例插件打招呼',
    async handler(_args: string[], event: ChatEvent): Promise<CommandReply> {
      const affection = ctx.memory.getAttr(event.userId, 'affection') ?? 20;
      return { text: `${ctx.userConfig.greetingWord}，${event.nickname}！你的好感度：${affection}/100（来自示例插件）` };
    },
  });

  // ---------- 3. 沙箱演示：跑一段 Python ----------
  ctx.registerCommand({
    name: '你好算数',
    description: '示例：调用沙箱计算 2^10',
    async handler(_args: string[], event: ChatEvent): Promise<CommandReply> {
      const r = await ctx.sandbox.run(
        { platform: event.platform, type: event.type, chatId: event.chatId },
        { language: 'python', code: 'print(2 ** 10)' },
      );
      return { text: `沙箱里算出来 2^10 = ${r.stdout.trim()}` };
    },
  });

  // ---------- 4. 插件专属持久化 ----------
  ctx.state.set('loaded_count', (ctx.state.get('loaded_count', 0) ?? 0) + 1);
  ctx.log.info(`hello-plugin 已载入 ${ctx.state.get('loaded_count')} 次`);

  // ---------- 5. 事件订阅（卸载时自动清理） ----------
  ctx.on('plugin.loaded', ({ id }: { id: string }) => {
    if (id !== 'hello-plugin') ctx.log.info(`有新插件上线: ${id}`);
  });

  // ---------- 6. 定时器（卸载时自动清理，不留孤儿） ----------
  ctx.setInterval(() => ctx.log.debug('hello-plugin 心跳'), 60000);

  // MCP 工具（来自 plugin.json 的 mcpServers.demo-echo）会自动注册为
  // hello-plugin__demo-echo__echo，可直接被 LLM 调用。
}
