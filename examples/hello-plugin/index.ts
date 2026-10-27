// ============================================================
// hello-plugin —— 用户自建插件模板
// 插件 = 一个目录：plugin.json（清单）+ index.ts/index.js（setup(ctx) 入口）
// 复制本目录到 parallel/data/plugins/ 下，然后在桌面端「插件」页执行安装（扫描 data/plugins）
// 即可热载入，无需重启内核。QQ 侧已不再有任何斜杠命令，装在桌面端完成。
// ============================================================

import type { PluginContext, ToolContext } from '../../src/kernel/types.ts';

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

  // ---------- 2. 沙箱演示：LLM 工具里跑一段 Python ----------
  ctx.llm.registerTool({
    name: 'hello_math',
    description: '示例：在沙箱里计算 2^10。',
    parameters: { type: 'object', properties: {} },
    async handler(_args: Record<string, unknown>, tctx: ToolContext) {
      const r = await ctx.sandbox.run(
        { platform: tctx.event.platform, type: tctx.event.type, chatId: tctx.event.chatId },
        { language: 'python', code: 'print(2 ** 10)' },
      );
      return `沙箱里算出来 2^10 = ${r.stdout.trim()}`;
    },
  });

  // ---------- 3. 插件专属持久化 ----------
  ctx.state.set('loaded_count', (ctx.state.get('loaded_count', 0) ?? 0) + 1);
  ctx.log.info(`hello-plugin 已载入 ${ctx.state.get('loaded_count')} 次`);

  // ---------- 4. 事件订阅（卸载时自动清理） ----------
  ctx.on('plugin.loaded', ({ id }: { id: string }) => {
    if (id !== 'hello-plugin') ctx.log.info(`有新插件上线: ${id}`);
  });

  // ---------- 5. 定时器（卸载时自动清理，不留孤儿） ----------
  ctx.setInterval(() => ctx.log.debug('hello-plugin 心跳'), 60000);

  // MCP 工具（来自 plugin.json 的 mcpServers.demo-echo）会自动注册为
  // hello-plugin__demo-echo__echo，可直接被 LLM 调用。
}
