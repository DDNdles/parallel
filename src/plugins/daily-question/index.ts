import type { PluginContext } from '../../kernel/types.ts';
import { todayKey } from '../../kernel/util/misc.ts';

// ============================================================
// daily-question —— 每日一题（todo 骨架）
// 默认被动：/今日一题 命令触发。主动推送需主人开启（schedule 权限 + proactive 开关）。
// TODO: 接入 LeetCode 每日一题公开接口 / 更大题库；晚间公布答案的独立任务
// ============================================================

const BANK = [
  { q: '一个房间里有 3 支蜡烛，吹灭了 2 支，最后还剩几支蜡烛？', a: '3 支——吹灭的 2 支没有烧完，被吹灭的才留得下来喵。' },
  { q: '小明的妈妈有三个孩子，老大叫大毛，老二叫二毛，老三叫什么？', a: '小明呀。' },
  { q: '什么东西越洗越脏？', a: '水。' },
  { q: '1=5, 2=15, 3=215, 4=2145，那么 5=?', a: '1。第一行已经告诉你 1=5 了，反过来 5=1。' },
  { q: '时钟什么时候不会走？', a: '时钟本来就不会“走路”，它只会转喵。' },
  { q: '什么车寸步难行？', a: '风车。' },
  { q: '什么东西打破了大家都开心？', a: '世界纪录。' },
  { q: '三个金叫鑫，三个水叫淼，三个人叫什么？', a: '叫“众”。' },
  { q: '什么东西天气越热它爬得越高？', a: '温度计里的水银柱。' },
  { q: '什么布剪不断？', a: '瀑布。' },
];

export function setup(ctx: PluginContext): void {
  function pickOfTheDay(): { q: string; a: string } {
    // 以日期为种子稳定选择，同一天全群同一题
    const day = todayKey();
    const seed = [...day].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;
    return BANK[seed % BANK.length];
  }

  ctx.llm.registerTool({
    name: 'daily_question',
    description: '获取今天的每日一题（谜语/脑筋急转弯）。',
    promptGuidelines: ['题目抛出去后别马上揭晓，等对方猜完或主动要答案，再用 daily_question_answer 核对。'],
    parameters: { type: 'object', properties: {} },
    handler: () => `今日一题：${pickOfTheDay().q}（答案用 daily_question_answer 工具获取）`,
  });

  ctx.llm.registerTool({
    name: 'daily_question_answer',
    description: '获取今天每日一题的答案。',
    parameters: { type: 'object', properties: {} },
    handler: () => pickOfTheDay().a,
  });

  ctx.registerCommand({
    name: '今日一题',
    aliases: ['每日一题'],
    description: '查看今天的每日一题（再发一次看答案）',
    handler: (args) => {
      const item = pickOfTheDay();
      if (args[0] === '答案') return { text: `答案：${item.a}` };
      return { text: `【今日一题】\n${item.q}\n\n（想知道答案？再发一次 /今日一题 答案）` };
    },
  });

  // 主动推送：默认关闭（proactive 由主人开关控制）
  ctx.schedule.register({
    id: 'push',
    dailyAt: '20:30',
    proactive: true,
    handler: async () => {
      // TODO: 需要内核提供"开启了本插件的群列表"查询；骨架阶段留空并在 UI 标注风控风险
      ctx.log.info('每日一题主动推送触发（proactive）——推送目标群列表 TODO');
    },
  });
}
