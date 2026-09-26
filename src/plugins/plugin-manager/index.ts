import type { PluginContext, ChatEvent, CommandReply } from '../../kernel/types.ts';

// ============================================================
// plugin-manager —— 聊天内插件管理（报告 04 §5）
// 可见性规则：生效中的插件所有人可见；未生效的仅管理员可见（普通成员完全不可见）。
// persona（locked）插件的开关/详情仅主人。
// ============================================================

export function setup(ctx: PluginContext): void {
  const containerRef = ctx.config as any; // 内核通过 bus 暴露容器查询（见下方 hooks）

  // 内核在启动时把容器与适配器查询接口挂到 ctx 上不可行（容器先于插件存在），
  // 因此插件管理通过事件 RPC 与内核交互：
  function askKernel<T>(req: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('内核响应超时')), 4000);
      ctx.bus.once('kernel.rpc.reply', (res: { ok: boolean; data?: T; error?: string; id?: string }) => {
        if (res.ok) { clearTimeout(timer); resolve(res.data as T); }
        else { clearTimeout(timer); reject(new Error(res.error ?? '内核错误')); }
      });
      ctx.bus.emit('kernel.rpc', req);
      void containerRef;
      void timer;
    });
  }

  const fmtPluginLine = (p: { id: string; name: string; version: string; category: string; enabled: boolean; locked?: boolean }) => {
    const mark = p.enabled ? '✅' : '⛔';
    return `${mark} ${p.id}  ${p.name}  v${p.version} [${p.category}]${p.locked ? ' 🔒' : ''}`;
  };

  ctx.registerCommand({
    name: '帮助',
    aliases: ['help', '帮助'],
    description: '查看当前可用的命令',
    handler: async (_args, event) => {
      const cmds = await askKernel<{ name: string; pluginId: string; description: string; enabled: boolean; minRole?: string }[]>({
        type: 'commands_visible', chatId: event.chatId, chatType: event.type, role: event.role ?? 'member',
      });
      if (!cmds.length) return { text: '当前没有可用命令。' };
      const lines = cmds.map((c) => `/${c.name} —— ${c.description}${c.enabled ? '' : '（未开启）'}`);
      return { text: `【可用命令】\n${lines.join('\n')}\n\n管理员可用 /插件 查看和管理本群插件。` };
    },
  });

  ctx.registerCommand({
    name: '状态',
    aliases: ['status'],
    description: 'bot 运行状态自检（协议端连接、模型、在线时长）',
    handler: async () => {
      const st = await askKernel<{ adapter: Record<string, unknown>; model: string; providerUsable: { ok: boolean; reason?: string }; uptimeMs: number; plugins: { total: number; enabled: number } }>({
        type: 'status',
      });
      const conn = st.adapter.connected ? '✅ 已连接' : '⛔ 未连接（等待协议端反向 WS 接入）';
      const lines = [
        `协议端: ${conn}`,
        st.adapter.selfId ? `登录号: ${st.adapter.selfId}` : null,
        st.adapter.connected && st.adapter.connectedAt ? `在线时长: ${Math.round((Date.now() - (st.adapter.connectedAt as number)) / 60000)} 分钟` : null,
        `模型: ${st.model}${st.providerUsable.ok ? '' : `（不可用：${st.providerUsable.reason}）`}`,
        `插件: ${st.plugins.enabled}/${st.plugins.total} 已载入`,
      ].filter(Boolean);
      return { text: lines.join('\n') };
    },
  });

  ctx.registerCommand({
    name: '插件',
    description: '查看与管理本群插件（开关权限：群管理员/群主/主人）',
    usage: '/插件 [列表|开启 <id>|关闭 <id>|详情 <id>|重载 <id>|全局默认 <id> on|off|安装]',
    handler: async (args, event): Promise<CommandReply> => {
      const role = event.role ?? 'member';
      const sub = args[0] ?? '列表';

      // ---- 列表 ----
      if (sub === '列表' || sub === 'list') {
        const list = await askKernel<{ id: string; name: string; version: string; category: string; enabled: boolean; locked: boolean; visible: boolean }[]>({
          type: 'plugins_visible', chatId: event.chatId, chatType: event.type, role,
        });
        if (!list.length) return { text: '没有可见的插件。' };
        const on = list.filter((p) => p.enabled);
        const off = list.filter((p) => !p.enabled);
        let text = '【本群生效中】\n' + (on.map(fmtPluginLine).join('\n') || '（无）');
        if (off.length && role !== 'member') text += '\n\n【未开启（仅管理员可见）】\n' + off.map(fmtPluginLine).join('\n');
        return { text };
      }

      // ---- 开启/关闭 ----
      if (sub === '开启' || sub === '关闭' || sub === 'on' || sub === 'off') {
        if (role === 'member') return { text: '权限不足：插件开关需要群管理员/群主/主人。' };
        const id = args[1];
        if (!id) return { text: '用法：/插件 开启 <插件id>' };
        const enabled = sub === '开启' || sub === 'on';
        try {
          const r = await askKernel<{ name: string; category: string }>({ type: 'set_group_state', pluginId: id, chatId: event.chatId, enabled, role, updatedBy: event.userId, chatType: event.type });
          return { text: `${enabled ? '已开启' : '已关闭'}「${r.name}」（仅本群生效）。` };
        } catch (e) {
          return { text: `操作失败：${(e as Error).message}` };
        }
      }

      // ---- 详情 ----
      if (sub === '详情' || sub === 'info') {
        const id = args[1];
        if (!id) return { text: '用法：/插件 详情 <插件id>' };
        try {
          const info = await askKernel<{ id: string; name: string; version: string; description: string; category: string; enabled: boolean; locked: boolean; permissions: string[]; commands: string[]; redacted: boolean }>({
            type: 'plugin_detail', pluginId: id, chatId: event.chatId, chatType: event.type, role,
          });
          if (info.redacted) {
            // persona 类插件对非主人脱敏：普通成员连人设内容都不应能套取
            return { text: `${info.name}（${info.id}）v${info.version}\n类型：人格插件（内容仅主人可见）\n本群状态：${info.enabled ? '开启' : '未开启'}` };
          }
          return {
            text: [
              `${info.name}（${info.id}）v${info.version}`,
              info.description,
              `类别: ${info.category}  本群状态: ${info.enabled ? '开启' : '未开启'}${info.locked ? '  🔒仅主人可操作' : ''}`,
              `权限: ${info.permissions.join(', ') || '无'}`,
              `命令: ${info.commands.map((c) => '/' + c).join(' ') || '无'}`,
            ].join('\n'),
          };
        } catch (e) {
          return { text: `查询失败：${(e as Error).message}` };
        }
      }

      // ---- 主人专属 ----
      if (sub === '重载' || sub === 'reload') {
        if (role !== 'owner') return { text: '权限不足：重载插件仅主人可用。' };
        const id = args[1];
        if (!id) return { text: '用法：/插件 重载 <插件id>' };
        try {
          await askKernel({ type: 'reload_plugin', pluginId: id, role });
          return { text: `插件 ${id} 已重载。` };
        } catch (e) {
          return { text: `重载失败：${(e as Error).message}` };
        }
      }
      if (sub === '全局默认') {
        if (role !== 'owner') return { text: '权限不足：全局默认仅主人可用。' };
        const id = args[1];
        const on = args[2] === 'on' || args[2] === '开';
        if (!id || !args[2]) return { text: '用法：/插件 全局默认 <插件id> on|off' };
        await askKernel({ type: 'set_global_default', pluginId: id, enabled: on, role });
        return { text: `插件 ${id} 的全局默认已设为 ${on ? '开启' : '关闭'}（影响所有未单独设置的群）。` };
      }
      if (sub === '安装') {
        if (role !== 'owner') return { text: '权限不足：安装插件仅主人可用。' };
        const installed = await askKernel<string[]>({ type: 'install_user_plugins', role });
        return { text: installed.length ? `已安装：${installed.join('、')}` : '没有发现新插件。请把插件目录放入 data/plugins 后重试。' };
      }

      return { text: '用法：/插件 [列表|开启 <id>|关闭 <id>|详情 <id>|重载 <id>|全局默认 <id> on|off|安装]' };
    },
  });
}
