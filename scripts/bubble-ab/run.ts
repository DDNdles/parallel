// 用法：REPS=4 VARIANTS=A,E npx tsx scripts/bubble-ab/run.ts（读 data/debug/chat-request.json 的 system 与 data/sessions 的真实历史，打本机 127.0.0.1:8045）
// 气泡数软约束 A/B：同一真实上下文、同一目标条数，比较不同提示写法下「模型写了几行 → 程序实际发几条」
import fs from 'node:fs';
import { normalizeVisibleContent, splitIntoBubbles, trimAtSentence } from '../../src/kernel/humanlike/delivery.ts';
import { chatOutputStyleText } from '../../src/kernel/prompt-sections.ts';
// @ts-ignore
import { buildContexts } from './ctx.mjs';

const MODEL = process.env.MODEL || 'gemini-3.8-flash-low';
const REPS = Number(process.env.REPS || 4);
const TARGETS = (process.env.TARGETS || '1,2,4').split(',').map(Number);
const VARIANTS = (process.env.VARIANTS || 'A,B,C').split(',');
const OUT = { replyMaxCharacters: 100, bubbleSoftMaxCharacters: 10, maxBubbles: 6, maxMessageCharacters: 24 };

const base = JSON.parse(fs.readFileSync('data/debug/chat-request.json', 'utf8')).messages[0].content as string;
const s440 = base.indexOf('# 你的回复');
const e440 = base.indexOf('\n\n#', s440 + 5);

const STABLE_440 = (max: number) => [
  `# 你的回复`,
  `- 像随手打的消息：口语、短句，一两句话说清就停 —— 不解释、不总结、不追着一串问。`,
  `- 一行就是一条气泡：程序按你写的行发。`,
  `- 每轮该发几条写在最新那条消息末尾的【本轮】里，照它来。`,
  `- 对面短你也短：对方发几个字，你回一大段就出戏了。`,
  `- 不用 Markdown、不用列表；不要写括号或星号包起来的动作、神态 —— 你只是在打字说话。`,
  `- 想发表情就写 [表情/微笑] 或 [表情/14]；名字必须完全匹配，拿不准就用编号。不要写 [微笑] 这种纯文字，也不要描述表情。`,
  `- 硬上限：一次回复总共不超过 100 个字、最多 ${max} 条气泡；超出字数的部分会被截掉，气泡太多会合并。`,
].join('\n');
const STABLE_440_PLUS = (max: number) => STABLE_440(max) + '\n' + [
  `- 上面历史里你以前每次发了几条不用参考，那是以前的条数；这次只看【本轮】。`,
  `- 一行只放一句话：一行里出现 。！？ 会被程序从那里拆成两条，想连着说就用逗号。`,
].join('\n');

const STABLE_440_D = (max: number) => STABLE_440(max) + '\n' + [
  `- 上面历史里你以前每次发了几条不用参考，那是以前的条数；这次只看【本轮】。`,
  `- 一行只放一句话、20 字以内：一行里出现 。！？；会被程序从那里拆开，一行太长会被截断。`,
].join('\n');

function tail(variant: string, t: number, max: number): string {
  if (variant === 'B') return `\n\n【本轮】这次回 ${t} 条：写 ${t} 行，一行一条。内容确实说不完可以多写几行，最多 ${max} 条。`;
  if (variant === 'C') return `\n\n【本轮】这次回 ${t} 条：写 ${t} 行。` + (t === 1 ? '只写一行、一句话。' : '') + `对方问的事一两句讲不清时可以多写，最多 ${max} 条；闲聊就照 ${t} 条。`;
  if (variant === 'D') return `\n\n【本轮】这次回 ${t} 条：写 ${t} 行，一行一句。只有对方问的事 ${t} 条确实讲不清时才多写几行（最多 ${max} 条）—— 宁可多一行，也别把一行写长。`;
  if (variant === 'E') return `\n\n【本轮】闲聊就回 ${t} 条：写 ${t} 行，一行一句。对方明确要你列举、讲步骤，或一次问了好几件事时，按需要写够（最多 ${max} 条），不受 ${t} 条限制 —— 但还是一行一句、别把一行写长。`;
  return '';
}

function system(variant: string, t: number, isGroup: boolean, file: string): string {
  const sec = variant === 'A'
    ? chatOutputStyleText({ maxChars: 100, targetBubbles: t, maxBubbles: 6 })
    : variant === 'B' ? STABLE_440(6) : (variant === 'D' || variant === 'E') ? STABLE_440_D(6) : STABLE_440_PLUS(6);
  let s = base.slice(0, s440) + sec + base.slice(e440);
  if (!isGroup) s = s.replace(/当前会话：.*?\n/, `当前会话：QQ 私聊(${file.match(/\d+/)![0]})。\n`);
  return s;
}

async function call(messages: unknown[]): Promise<string> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch('http://127.0.0.1:8045/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: 400, temperature: 1 }),
      });
      const j = await r.json() as any;
      const c = j?.choices?.[0]?.message?.content;
      if (typeof c === 'string' && c.trim()) return c;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return '';
}

const bubblesOf = (text: string) => {
  const t = trimAtSentence(normalizeVisibleContent(text, Number.MAX_SAFE_INTEGER), OUT.replyMaxCharacters);
  return splitIntoBubbles(t, OUT.maxBubbles, OUT.bubbleSoftMaxCharacters);
};

const ctxs = [
  ...buildContexts('private_2869341708.jsonl', [3]),
  ...buildContexts('group_1044827843.jsonl', [2]),
].map((c: any, i: number) => ({ ...c, name: ['private-streak3', 'group-chat'][i] }));
// 「必要时该突破」：真需要解释的问题
const need = buildContexts('group_1044827843.jsonl', [2])[0];
ctxs.push({ ...need, name: 'need-explain', input: need.input + '\n非神即兔：@3893163081 你到底能干啥？生图、唱歌、找b站视频这些分别要怎么叫你，挨个说说' });

ctxs.push({ ...need, name: 'need-list', input: need.input + '\n非神即兔：@3893163081 明天去机场做志愿者，要带的东西给我列五样，一样一条' });
const rows: any[] = [];
const jobs: (() => Promise<void>)[] = [];
for (const c of ctxs) for (const v of VARIANTS) for (const t of (c.name.startsWith('need') ? [1, 2] : TARGETS)) for (let r = 0; r < REPS; r++) {
  jobs.push(async () => {
    const messages = [{ role: 'system', content: system(v, t, c.isGroup, c.file) }, ...c.history, { role: 'user', content: c.input + tail(v, t, 6) }];
    const text = await call(messages);
    if (!text) return;
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
    const b = bubblesOf(text);
    rows.push({ ctx: c.name, v, t, lines, bubbles: b.length, text });
  });
}
// 并发 4
let k = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (k < jobs.length) await jobs[k++](); }));
fs.writeFileSync(`data/experiments/bubble-rows-${Date.now()}.json`, JSON.stringify(rows, null, 1));

const key = (r: any) => `${r.ctx}|${r.v}|${r.t}`;
const g = new Map<string, any[]>();
for (const r of rows) (g.get(key(r)) ?? g.set(key(r), []).get(key(r))!).push(r);
console.log('ctx            var target  lines            bubbles          hit(bubbles==t)');
for (const [kk, rs] of [...g].sort()) {
  const [ctx, v, t] = kk.split('|');
  const hit = rs.filter((r) => r.bubbles === Number(t)).length;
  console.log(ctx.padEnd(16), v, ' ', t, '    ', rs.map((r) => r.lines).join(',').padEnd(16), rs.map((r) => r.bubbles).join(',').padEnd(16), `${hit}/${rs.length}`);
}
for (const v of VARIANTS) {
  const rs = rows.filter((r) => r.v === v && !r.ctx.startsWith('need'));
  const hit = rs.filter((r) => r.bubbles === r.t).length;
  const mae = rs.reduce((a, r) => a + Math.abs(r.bubbles - r.t), 0) / rs.length;
  const split = rs.filter((r) => r.bubbles > r.lines).length;
  console.log(`variant ${v}: chat hit ${hit}/${rs.length}  mean|bubbles-target| ${mae.toFixed(2)}  program-split-extra ${split}/${rs.length}`);
}
