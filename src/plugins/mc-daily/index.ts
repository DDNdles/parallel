import type { PluginContext } from '../../kernel/types.ts';
import { todayKey } from '../../kernel/util/misc.ts';

// ============================================================
// mc-daily —— MC 每日推荐（todo 骨架）
// 数据源：Modrinth 公开 API（无需 key）。用 daily_items 表记录已推荐项避免重复。
// TODO: 加载器/版本过滤参数、CurseForge 备源、封面图发送
// ============================================================

interface ModrinthHit { slug: string; title: string; description: string; project_type: string; downloads: number; }

export function setup(ctx: PluginContext): void {
  async function fetchRandom(type: 'modpack' | 'mod'): Promise<ModrinthHit | null> {
    const resp = await fetch(
      `https://api.modrinth.com/v2/search?limit=20&index=downloads&project_type=${type}`,
      { headers: { 'user-agent': 'parallel-bot/0.1' }, signal: AbortSignal.timeout(10000) },
    );
    if (!resp.ok) throw new Error(`Modrinth HTTP ${resp.status}`);
    const data = await resp.json() as any;
    const hits = (data.hits ?? []) as ModrinthHit[];
    // 避免重复：过滤最近推荐过的
    const seen = new Set((ctx.state.get<string[]>(`seen:${type}`, []) ?? []));
    const fresh = hits.filter((h) => !seen.has(h.slug));
    const pick = (fresh.length ? fresh : hits)[Math.floor(Math.random() * (fresh.length ? fresh.length : hits.length))];
    if (!pick) return null;
    seen.add(pick.slug);
    ctx.state.set(`seen:${type}`, [...seen].slice(-50)); // 保留最近 50 个
    return pick;
  }

  function fmt(h: ModrinthHit): string {
    return `⛏ [MC ${h.project_type === 'modpack' ? '整合包' : 'Mod'}] ${h.title}\n${h.description.slice(0, 100)}\n⬇ ${h.downloads}  https://modrinth.com/${h.project_type}/${h.slug}`;
  }

  ctx.llm.registerTool({
    name: 'mc_recommend',
    description: '推荐一个 Minecraft 整合包或 Mod。',
    parameters: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['modpack', 'mod'], description: '推荐类型' } },
      required: ['type'],
    },
    handler: async (args) => {
      const h = await fetchRandom(args.type === 'mod' ? 'mod' : 'modpack');
      return h ? fmt(h) : '（暂时没有找到推荐）';
    },
  });

  // 每日主动推送骨架（默认关）
  ctx.schedule.register({
    id: 'daily-push',
    dailyAt: '10:00',
    proactive: true,
    handler: async () => {
      // TODO: 推送到开启本插件的群（需群列表查询 + 风控节流）
      ctx.state.set('last_daily', todayKey());
      ctx.log.info('MC 每日推荐 proactive 触发（推送目标 TODO）');
    },
  });
}
