// 一次性回填：把今天私聊里甩给 bot 的表情包批量收进表情包库（2026-10-24）
// 用法：node scripts/backfill-stickers.mjs <会话jsonl> [HH:MM HH:MM]
//   从会话日志里挑出时间窗内带图消息的 inbox 文件名，逐张走 /api/plugin/sticker/upload，
//   内容 hash 自动去重，库里已有的会报 duplicate 不重复入库。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [,, sessionArg, fromArg = '00:00', toArg = '23:59'] = process.argv;
if (!sessionArg) { console.error('用法: node scripts/backfill-stickers.mjs <会话jsonl> [起HH:MM] [止HH:MM]'); process.exit(1); }

const session = join(root, 'data', 'sessions', sessionArg.endsWith('.jsonl') ? sessionArg : sessionArg + '.jsonl');
const chatId = sessionArg.replace(/^private_|^group_/, '').replace(/\.jsonl$/, '');
const isPrivate = sessionArg.startsWith('private_');
const inboxDir = join(root, 'data', 'sandbox', `${isPrivate ? 'private' : 'group'}_${chatId}`, 'inbox');

const [fh, fm] = fromArg.split(':').map(Number);
const [th, tm] = toArg.split(':').map(Number);
const inWindow = (ts) => {
  const d = new Date(ts);
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= fh * 60 + fm && mins <= th * 60 + tm;
};

const names = [];
for (const line of readFileSync(session, 'utf-8').trim().split('\n')) {
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.type !== 'message_in' || !inWindow(e.ts)) continue;
  for (const f of e.data?.files ?? []) {
    const n = f.name ?? f;
    if (typeof n === 'string' && /\.(png|jpe?g|gif|webp|bmp)$/i.test(n) && !names.includes(n)) names.push(n);
  }
}
console.log(`窗口内带图消息文件 ${names.length} 个（${inboxDir}）`);

const { uiToken } = JSON.parse(readFileSync(join(root, 'data', 'secrets.json'), 'utf-8'));
const cfg = JSON.parse(readFileSync(join(root, 'data', 'config.json'), 'utf-8'));
const base = `http://127.0.0.1:${cfg.ui?.port ?? 3080}`;

let added = 0, dup = 0, missing = 0, failed = 0;
for (const n of names) {
  const abs = join(inboxDir, n);
  if (!existsSync(abs)) { missing++; console.log(`  跳过（沙箱里已没有）: ${n}`); continue; }
  const buf = readFileSync(abs);
  const resp = await fetch(`${base}/api/plugin/sticker/upload?name=${encodeURIComponent(n)}`, {
    method: 'POST',
    headers: { 'x-auth-token': uiToken, 'content-type': 'application/json' },
    body: JSON.stringify({ data: buf.toString('base64'), desc: '来自君にも嘘をつこう的图', tags: [] }),
  });
  const r = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
  if (r.ok && r.duplicate) dup++;
  else if (r.ok) added++;
  else { failed++; console.log(`  失败 ${n}: ${r.error}`); }
}
console.log(`新增 ${added}、已存在 ${dup}、沙箱缺失 ${missing}、失败 ${failed}`);
