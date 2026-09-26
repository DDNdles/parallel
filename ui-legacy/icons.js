// parallel 图标系统：24×24 网格 · stroke 2 · currentColor · 统一 outline 风格
// 规格与 mcp-icon 源（alipayfaces lucide 系）一致；装饰性图标调用处须加 aria-hidden
const I = (paths, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;

export const icons = {
  // —— 导航 ——
  console: I('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M13 15h4"/>'),
  chats: I('<path d="M8 9h8M8 13h6M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z"/>'),
  plugins: I('<path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/><rect x="6" y="6" width="12" height="12" rx="3"/>'),
  personas: I('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
  models: I('<path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7z"/><path d="M12 8v4l3 2"/>'),
  memory: I('<path d="M12 4a6 6 0 0 1 6 6c0 2.5-1.5 4-2.5 5.5-.6.9-.5 2.5-.5 2.5h-6s.1-1.6-.5-2.5C7.5 14 6 12.5 6 10a6 6 0 0 1 6-6z"/><path d="M10 21h4"/>'),
  users: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1.2-3.2 3.6-5 6.5-5s5.3 1.8 6.5 5"/><circle cx="17.5" cy="9.5" r="2.5"/><path d="M16.5 15.5c2.6.3 4.4 1.9 5 4.5"/>'),
  errors: I('<path d="M12 3 2.5 20h19z"/><path d="M12 9.5V14M12 17.2v.3"/>'),
  sandbox: I('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M8 15l2-2-2-2"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19"/>'),
  // —— 通用 ——
  send: I('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  stop: I('<rect x="7" y="7" width="10" height="10" rx="2"/>'),
  chevron: I('<path d="M6 9l6 6 6-6"/>'),
  collapse: I('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>'),
  sun: I('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>'),
  moon: I('<path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5z"/>'),
  search: I('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  trash: I('<path d="M4 7h16M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/>'),
  download: I('<path d="M12 4v11M7 11l5 5 5-5M4 20h16"/>'),
  upload: I('<path d="M12 15V4M7 8l5-5 5 5M4 20h16"/>'),
  refresh: I('<path d="M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6"/>'),
  warn: I('<path d="M12 3 2.5 20h19z"/><path d="M12 9.5V14M12 17.2v.3"/>'),
  check: I('<path d="m4.5 12.5 5 5 10-11"/>'),
  block: I('<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>'),
  // —— 品牌花押：parallel 花朵犬签（花瓣 + 叶） ——
  brand: I('<path d="M12 3.5c1.8 0 3 1.3 3 3s-1.2 3-3 3-3-1.3-3-3 1.2-3 3-3z" class="petal"/><path d="M19 8c.9 1.6.3 3.2-1.2 4s-3.2.3-4-1.2-.3-3.2 1.2-4 3.1-.4 4 1.2z" class="petal"/><path d="M19 16c-.9 1.6-2.5 2-4 1.2s-2-2.4-1.2-4 2.5-2 4-1.2 2.1 2.4 1.2 4z" class="petal"/><path d="M5 16c.9 1.6 2.5 2 4 1.2s2-2.4 1.2-4-2.5-2-4-1.2-2.1 2.4-1.2 4z" class="petal"/><path d="M5 8c.9-1.6 2.5-2 4-1.2s2 2.4 1.2 4-2.5 2-4 1.2S4.1 9.6 5 8z" class="petal"/><circle cx="12" cy="12" r="2.2"/><path d="M12 14.5c0 3-1.5 5-4 6.5"/>'),
};

/** 装饰性图标 span（aria-hidden 由 svg 自带） */
export function icon(name, cls = 'ic') {
  return `<span class="${cls}">${icons[name] || ''}</span>`;
}
