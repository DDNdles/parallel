// API 访问层
let TOKEN = localStorage.getItem('parallel_token') || '';

export function setToken(t) { TOKEN = t; localStorage.setItem('parallel_token', t); }
export function hasToken() { return !!TOKEN; }

export async function api(method, path, body) {
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
export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b ?? {});
export const del = (p) => api('DELETE', p);

// 实时事件流
const listeners = new Map();
let ws = null;
export function onEvent(ev, fn) {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev).add(fn);
  return Promise.resolve(() => listeners.get(ev)?.delete(fn));
}

export function connectWS() {
  if (ws) { try { ws.close(); } catch {} }
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => document.getElementById('ws-dot')?.classList.replace('dot-off', 'dot-on');
  ws.onclose = () => document.getElementById('ws-dot')?.classList.replace('dot-on', 'dot-off');
  ws.onmessage = (m) => {
    try {
      const { ev, data } = JSON.parse(m.data);
      listeners.get(ev)?.forEach((fn) => fn(data));
      listeners.get('*')?.forEach((fn) => fn(ev, data));
    } catch {}
  };
}

export const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
export const fmtDT = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '';
export const fmtBytes = (n) => n == null ? '-' : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`;
export const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// 轻量 toast：替代 alert 的非阻断反馈（type: '' | 'ok' | 'err'）
export function toast(msg, type = '') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = el('<div class="toast-wrap" aria-live="polite"></div>');
    document.body.appendChild(wrap);
  }
  const t = el(`<div class="toast ${type}"></div>`);
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}
