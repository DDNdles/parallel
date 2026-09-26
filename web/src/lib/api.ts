'use client';
/** API 访问层 + 实时事件流（与旧版 ui/api.js 行为一致） */

let TOKEN = '';
if (typeof window !== 'undefined') {
  // 旧版 UI 键名兼容：hachimi_token → parallel_token（迁移一次后删除旧键）
  const legacy = localStorage.getItem('hachimi_token');
  if (legacy && !localStorage.getItem('parallel_token')) {
    localStorage.setItem('parallel_token', legacy);
    localStorage.removeItem('hachimi_token');
  }
  TOKEN = localStorage.getItem('parallel_token') || '';
}

export function setToken(t: string) { TOKEN = t; localStorage.setItem('parallel_token', t); }
export function getToken() { return TOKEN; }
export function hasToken() { return !!TOKEN; }

export async function api(method: string, path: string, body?: unknown): Promise<any> {
  const resp = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-token': TOKEN },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401) throw new Error('unauthorized');
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}
export const get = (p: string) => api('GET', p);
export const post = (p: string, b?: unknown) => api('POST', p, b ?? {});
export const del = (p: string) => api('DELETE', p);

// ---------------- 实时事件流 ----------------
type Listener = (data?: any, ev?: string) => void;
const listeners = new Map<string, Set<Listener>>();
let ws: WebSocket | null = null;

export function onEvent(ev: string, fn: Listener): () => void {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev)!.add(fn);
  return () => { listeners.get(ev)?.delete(fn); };
}

export function connectWS() {
  if (ws) {
    ws.onclose = null; // 手动替换连接：不让旧 socket 的 close 触发重连循环
    try { ws.close(); } catch { /* ignore */ }
  }
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  const setDot = (on: boolean) => {
    const dot = document.getElementById('ws-dot');
    if (dot) dot.className = 'dot ' + (on ? 'dot-on' : 'dot-off');
  };
  ws.onopen = () => { setDot(true); wsRetry = 0; };
  // 断线自动重连（指数退避，封顶 15s）。内核重启/网络闪断后事件流自愈，
  // 不再出现"红点常亮、页面数据停摆"的假未登录状态。
  ws.onclose = () => {
    setDot(false);
    if (wsRetryTimer) return;
    const delay = Math.min(1000 * 2 ** wsRetry, 15000);
    wsRetry++;
    wsRetryTimer = setTimeout(() => { wsRetryTimer = null; connectWS(); }, delay);
  };
  ws.onmessage = (m) => {
    try {
      const { ev, data } = JSON.parse(m.data);
      listeners.get(ev)?.forEach((fn) => fn(data, ev));
      listeners.get('*')?.forEach((fn) => fn(data, ev));
    } catch { /* ignore */ }
  };
}
let wsRetry = 0;
let wsRetryTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------- 格式化工具 ----------------
export const fmtTime = (ts?: number) => ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
export const fmtDT = (ts?: number) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '';
export const fmtBytes = (n?: number | null) =>
  n == null ? '-' : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`;

export function toast(msg: string, type = '') {
  if (typeof document === 'undefined') return;
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

/** 极简 Markdown：代码块/行内代码/粗体/链接（与旧版 mdLite 行为一致） */
export function mdLite(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks: string[] = [];
  let out = esc(text).replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    blocks.push(`<div class="md-code">${code.replace(/\n$/, '')}</div>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  out = out
    .replace(/`([^`\n]+)`/g, '<code class="mono" style="background:var(--code-bg);padding:1px 5px;border-radius:4px;font-size:.92em">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  return out;
}
