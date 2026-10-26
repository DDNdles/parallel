// 从真实会话流里抽「历史 + 本轮输入」做实验上下文
import fs from 'node:fs';
const NOISE = /^（处理这条|^\[parallel 报错\]|^\[图片\]$|^\[文件|合集：/;
export function buildContexts(file, picks, histN = 24) {
  const es = fs.readFileSync('data/sessions/' + file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const isGroup = file.startsWith('group');
  // 线性化成 user/assistant 消息（assistant = 同一轮气泡用换行拼，和内核 history.pushAssistant 一致）
  const msgs = []; let cur = null;
  const flush = () => { if (cur && cur.parts.length) msgs.push({ role: 'assistant', content: cur.parts.join('\n') }); cur = null; };
  for (const e of es) {
    if (e.type === 'agent_start') { flush(); cur = { parts: [] }; continue; }
    if (e.type === 'message_out' && cur) { const t = String(e.text || ''); if (!NOISE.test(t)) cur.parts.push(t); continue; }
    if (e.type === 'message_in') {
      flush();
      const t = String(e.text || '').trim(); if (!t) continue;
      msgs.push({ role: 'user', content: isGroup ? `${e.nickname || e.userId}：${t}` : t });
    }
  }
  flush();
  // 连续同角色合并（近似内核合批）
  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content; else merged.push({ ...m });
  }
  const userIdx = merged.map((m, i) => (m.role === 'user' && merged[i + 1]?.role === 'assistant' ? i : -1)).filter((i) => i >= 0);
  return picks.map((p) => {
    const i = userIdx[userIdx.length - p];
    return { file, isGroup, history: merged.slice(Math.max(0, i - histN), i), input: merged[i].content, real: merged[i + 1].content };
  });
}
