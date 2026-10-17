import type { PluginContext } from '../../kernel/types.ts';
import { todayKey } from '../../kernel/util/misc.ts';

// ============================================================
// music-daily —— 每日推荐音乐（todo 骨架）
// 曲库：内置起步 + 主人经插件配置维护（每行"歌名|歌手|推荐语"），每日轮换不重复。
// TODO: 网易云外链卡片（接口受限，先只发文本）、封面图
// ============================================================

const BUILTIN: string[] = [
  '夜空中最亮的星|逃跑计划|每个人的夜里都值得有一束光',
  '海阔天空|Beyond|原谅我这一生不羁放纵爱自由',
  'Lemon|米津玄師|把苦涩的柠檬做成甜甜的汽水',
  '起风了|买辣椒也用券|风起时想起的人和事都温柔',
  '晴天|周杰伦|从前从前有个人爱你很久',
  'カタオモイ|Aimer| Straight-forward 的直白情歌',
  '平凡之路|朴树|徘徊着的 在路上的你要走吗',
  'Strange Weather|Tokyo Shoegazer|噪音里也有浪漫',
  '海底|一支榴莲|来人间这一趟值得你看看月亮',
  'Nomad|Vast & Hazy|迷路也是旅程的一部分',
];

export function setup(ctx: PluginContext): void {
  function library(): { name: string; artist: string; note: string }[] {
    const custom = String((ctx.userConfig as any).playlistText ?? '').trim();
    const rows = custom ? custom.split('\n') : BUILTIN;
    return rows.map((r) => {
      const [name, artist, note] = r.split('|').map((s) => s.trim());
      return { name: name ?? '', artist: artist ?? '', note: note ?? '' };
    }).filter((s) => s.name);
  }

  function pickOfTheDay() {
    const lib = library();
    if (!lib.length) return null;
    const day = todayKey();
    const seed = [...day].reduce((s, c) => s * 33 + c.charCodeAt(0), 11) >>> 0;
    return lib[seed % lib.length];
  }

  function fmt(s: { name: string; artist: string; note: string }): string {
    return `🎵 今日推荐：${s.name} - ${s.artist}\n“${s.note}”`;
  }

  ctx.llm.registerTool({
    name: 'music_daily',
    description: '获取今天的每日推荐音乐（歌名、歌手、推荐语）。',
    parameters: { type: 'object', properties: {} },
    handler: () => {
      const s = pickOfTheDay();
      return s ? fmt(s) : '（曲库为空，请主人在插件配置里维护曲库）';
    },
  });

  ctx.schedule.register({
    id: 'push',
    dailyAt: '09:00',
    proactive: true,
    handler: async () => {
      // TODO: 推送到开启本插件的群（需群列表查询 + 风控节流）
      ctx.log.info('每日音乐 proactive 触发（推送目标 TODO）');
    },
  });
}
