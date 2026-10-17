import type { PluginContext } from '../../kernel/types.ts';
import { todayKey } from '../../kernel/util/misc.ts';

// ============================================================
// poem-daily —— 每日推荐诗歌（todo 骨架）
// 内置语料起步；TODO: 今日诗词 API 接入、300 篇完整语料、定时推送
// ============================================================

const POEMS = [
  { title: '静夜思', author: '李白', dynasty: '唐', lines: '床前明月光，疑是地上霜。举头望明月，低头思故乡。', note: '想家的时候就抬头看看月亮吧。' },
  { title: '春晓', author: '孟浩然', dynasty: '唐', lines: '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。', note: '睡懒觉是春天的一部分。' },
  { title: '登鹳雀楼', author: '王之涣', dynasty: '唐', lines: '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。', note: '想看得更远，就站得更高一点。' },
  { title: '江雪', author: '柳宗元', dynasty: '唐', lines: '千山鸟飞绝，万径人踪灭。孤舟蓑笠翁，独钓寒江雪。', note: '孤独也可以很体面。' },
  { title: '相思', author: '王维', dynasty: '唐', lines: '红豆生南国，春来发几枝。愿君多采撷，此物最相思。', note: '想念一个人的时候，就想想红豆。' },
  { title: '饮湖上初晴后雨', author: '苏轼', dynasty: '宋', lines: '水光潋滟晴方好，山色空蒙雨亦奇。欲把西湖比西子，淡妆浓抹总相宜。', note: '晴也好雨也好，都是好天气。' },
  { title: '游子吟', author: '孟郊', dynasty: '唐', lines: '慈母手中线，游子身上衣。临行密密缝，意恐迟迟归。谁言寸草心，报得三春晖。', note: '记得给家里打个电话。' },
  { title: '山居秋暝', author: '王维', dynasty: '唐', lines: '空山新雨后，天气晚来秋。明月松间照，清泉石上流。', note: '雨后的空气最好闻了。' },
  { title: '黄鹤楼送孟浩然之广陵', author: '李白', dynasty: '唐', lines: '故人西辞黄鹤楼，烟花三月下扬州。孤帆远影碧空尽，唯见长江天际流。', note: '送别不是结束，是惦记的开始。' },
  { title: '枫桥夜泊', author: '张继', dynasty: '唐', lines: '月落乌啼霜满天，江枫渔火对愁眠。姑苏城外寒山寺，夜半钟声到客船。', note: '失眠的夜，古人和你一样。' },
];

export function setup(ctx: PluginContext): void {
  function pickOfTheDay() {
    const day = todayKey();
    const seed = [...day].reduce((s, c) => s * 37 + c.charCodeAt(0), 5) >>> 0;
    return POEMS[seed % POEMS.length];
  }

  ctx.llm.registerTool({
    name: 'poem_daily',
    description: '获取今天的每日一诗（标题、作者、诗句、一句碎碎念）。',
    parameters: { type: 'object', properties: {} },
    handler: () => {
      const p = pickOfTheDay();
      return `【${p.title}】${p.dynasty}·${p.author}\n${p.lines}\n（${p.note}）`;
    },
  });

  ctx.schedule.register({
    id: 'push',
    dailyAt: '21:00',
    proactive: true,
    handler: async () => {
      // TODO: 推送到开启本插件的群（需群列表查询 + 风控节流）
      ctx.log.info('每日一诗 proactive 触发（推送目标 TODO）');
    },
  });
}
