// parallel 桌面端主程序：路由 + 顶栏（模型选择器/状态芯片）+ 导航
import { get, post, hasToken, setToken, connectWS, onEvent } from './api.js';
import { icon, icons } from './icons.js';
import { renderConsole } from './pages/console.js';
import { renderChats } from './pages/chats.js';
import { renderPlugins } from './pages/plugins.js';
import { renderPersonas } from './pages/personas.js';
import { renderModels } from './pages/models.js';
import { renderMemory } from './pages/memory.js';
import { renderUsers } from './pages/users.js';
import { renderErrors } from './pages/errors.js';
import { renderSandbox } from './pages/sandbox.js';
import { renderSettings } from './pages/settings.js';

// 页面分级：核心工作区 → 内容运营 → 系统运维（三级视觉分组）
const PAGES = [
  { group: '工作区', items: [
    { id: 'console', name: '控制台', icon: 'console', render: renderConsole },
    { id: 'chats', name: '会话', icon: 'chats', render: renderChats },
  ]},
  { group: '内容与人格', items: [
    { id: 'plugins', name: '插件管理', icon: 'plugins', render: renderPlugins },
    { id: 'personas', name: '人格管理', icon: 'personas', render: renderPersonas },
    { id: 'memory', name: '记忆', icon: 'memory', render: renderMemory },
    { id: 'models', name: '模型', icon: 'models', render: renderModels },
  ]},
  { group: '系统', items: [
    { id: 'users', name: '用户', icon: 'users', render: renderUsers },
    { id: 'errors', name: '报错中心', icon: 'errors', render: renderErrors, badge: () => get('/api/state').then((s) => s.errors).catch(() => 0) },
    { id: 'sandbox', name: '沙箱管理', icon: 'sandbox', render: renderSandbox },
    { id: 'settings', name: '设置', icon: 'settings', render: renderSettings },
  ]},
];

const ALL_PAGES = PAGES.flatMap((g) => g.items);

let current = 'console';

function buildNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const g of PAGES) {
    const label = document.createElement('div');
    label.className = 'nav-label';
    label.textContent = g.group;
    nav.appendChild(label);
    for (const p of g.items) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'nav-item' + (p.id === current ? ' active' : '');
      item.dataset.page = p.id;
      item.innerHTML = `${icon(p.icon)}<span>${p.name}</span><span class="badge hidden"></span>`;
      item.onclick = () => navigate(p.id);
      nav.appendChild(item);
      if (p.badge) {
        p.badge().then((n) => {
          if (n > 0) {
            const b = item.querySelector('.badge');
            b.textContent = n;
            b.classList.remove('hidden');
          }
        });
      }
    }
  }
}

async function navigate(page) {
  current = page;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  const def = ALL_PAGES.find((p) => p.id === page);
  document.getElementById('tb-title').textContent = def.name;
  const content = document.getElementById('content');
  content.innerHTML = `<div class="muted" style="padding:30px">加载中…</div>`;
  try {
    content.classList.toggle('no-pad', page === 'chats');
    await def.render(content);
  } catch (e) {
    if (e.message === 'unauthorized') { showLogin(); return; }
    content.innerHTML = `<div class="card" style="color:var(--err)">页面加载失败：${e.message}</div>`;
  }
}

// ---------------- 顶栏状态 ----------------
let lastState = null;

async function refreshStatus() {
  try {
    const s = await get('/api/state');
    lastState = s;
    // 协议端芯片
    const a = s.adapter;
    const dot = document.querySelector('#chip-adapter .dot');
    const text = document.getElementById('chip-adapter-text');
    dot.className = 'dot ' + (a.connected ? 'dot-on' : 'dot-off');
    text.innerHTML = a.connected
      ? `协议端 <b>${a.selfId ? (a.selfNickname ? a.selfNickname + ' · QQ ' + a.selfId : 'QQ ' + a.selfId) : '已连接'}</b>`
      : '协议端未连接';
    // 用量芯片
    const total = s.usage.promptTokens + s.usage.completionTokens;
    document.getElementById('chip-usage').textContent = `Token ${total.toLocaleString()} · 调用 ${s.usage.llmCalls}`;
    // 侧栏脚注
    document.getElementById('foot-plugins').textContent = `${s.plugins.loaded}/${s.plugins.total}`;
    renderModelPicker();
  } catch { /* 401 由页面处理 */ }
}

// ---------------- 模型选择器（Codex pill 下拉） ----------------
function renderModelPicker() {
  const btnLabel = document.getElementById('mp-label');
  if (!lastState) return;
  const s = lastState;
  const active = s.providers.find((p) => p.id === s.model.provider);
  const ok = s.model.usable.ok;
  btnLabel.innerHTML = `<b>${active?.label ?? s.model.provider}</b> <span style="color:var(--faint)">${s.model.model}</span>` +
    (ok ? '' : ` <span style="color:var(--warn)">未接入</span>`);
  const menu = document.getElementById('mp-menu');
  menu.innerHTML = `<div class="mp-head">模型供应商</div>` + s.providers.map((p) => {
    const badges = !p.implemented ? '<span style="color:var(--warn)">未接入</span>'
      : !p.enabled ? '<span style="color:var(--faint)">未启用</span>'
      : !p.configured ? '<span style="color:var(--warn)">缺配置</span>'
      : '<span style="color:var(--ok)">就绪</span>';
    return `<button type="button" class="mp-item" data-id="${p.id}">
      <span>${p.label}<div class="mp-desc mono">${p.id} · ${p.model || '-'}</div></span>
      <span class="flex"></span>${p.id === s.model.provider ? '<span class="check">✓</span>' : badges}
    </button>`;
  }).join('');
  menu.querySelectorAll('.mp-item').forEach((item) => {
    item.onclick = async (e) => {
      e.stopPropagation();
      await post('/api/providers/active', { providerId: item.dataset.id });
      menu.classList.add('hidden');
      await refreshStatus();
    };
  });
}

document.getElementById('mp-btn').onclick = (e) => {
  e.stopPropagation();
  const menu = document.getElementById('mp-menu');
  const opening = menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  document.getElementById('mp-btn').setAttribute('aria-expanded', String(opening));
};
document.addEventListener('click', () => {
  document.getElementById('mp-menu')?.classList.add('hidden');
  document.getElementById('mp-btn')?.setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('mp-menu')?.classList.add('hidden');
    document.getElementById('mp-btn')?.setAttribute('aria-expanded', 'false');
  }
});

// 侧栏折叠
document.getElementById('btn-collapse').onclick = () => {
  document.getElementById('app').classList.toggle('collapsed');
  localStorage.setItem('parallel_side_collapsed', document.getElementById('app').classList.contains('collapsed') ? '1' : '');
};
if (localStorage.getItem('parallel_side_collapsed')) document.getElementById('app').classList.add('collapsed');

// 主题切换（顶栏图标按钮 + localStorage 持久化）—— 图标示意当前可切换到的目标
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('parallel_theme', t);
  const btn = document.getElementById('btn-theme');
  if (btn) {
    // 深色主题下显示太阳（点击去浅色），浅色下显示月亮
    btn.innerHTML = t === 'light' ? icons.sun : icons.moon;
    btn.title = `切换到${t === 'light' ? '深' : '浅'}色主题`;
    btn.setAttribute('aria-label', `当前${t === 'light' ? '浅' : '深'}色主题，点击切换到${t === 'light' ? '深' : '浅'}色`);
  }
}
document.getElementById('btn-theme').onclick = () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
};
applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

// 错误数徽标：只更新报错中心那一枚徽标，不重建整个导航
function setErrorBadge(n) {
  const item = document.querySelector('.nav-item[data-page="errors"]');
  const b = item?.querySelector('.badge');
  if (!b) return;
  if (n > 0) { b.textContent = n; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}
async function updateErrorBadge() {
  try {
    const s = await get('/api/state');
    setErrorBadge(s.errors ?? 0);
  } catch { /* 401 由页面处理 */ }
}
onEvent('error.recorded', updateErrorBadge);

// ---------------- 登录 ----------------
// 状态机：qrcode（扫码登录）→ account（账号卡）→ showApp
// token 免输入：内核启动时自动打开浏览器并带 #token=<uiToken>，此处接收后写入 localStorage 并清掉 URL
const $ = (id) => document.getElementById(id);
const AUTO_KEY = 'parallel_auto_login';
let loginTimers = [];

(function acceptTokenFromHash() {
  const m = location.hash.match(/^#token=([0-9a-f]+)$/i);
  if (m) { setToken(m[1]); history.replaceState(null, '', location.pathname + location.search); }
})();

function loginView(name) {
  for (const v of ['login-view-account', 'login-view-qrcode']) $(v).classList.add('hidden');
  if (name) $(name).classList.remove('hidden');
}
function setLoginState(msg, cls = '') {
  const el = document.querySelector('#login-view-account:not(.hidden) .login-state') || $('login-state');
  el.textContent = msg || '';
  el.className = 'login-state' + (cls ? ' ' + cls : '');
}

/** 进入主界面（自动登录状态已由勾选事件实时持久化，此处不写） */
function commitEnter() {
  loginTimers.forEach(clearInterval);
  loginTimers = [];
  showApp();
}

/** 自动登录勾选：勾选即存、取消即清（change 事件实时生效，不等到点按钮/刷新） */
function bindAutoChk(id) {
  $(id).onchange = () => {
    if ($(id).checked) localStorage.setItem(AUTO_KEY, '1');
    else localStorage.removeItem(AUTO_KEY);
  };
}

/** 账号卡视图：头像 + 昵称 + QQ 号 + 状态行 */
function showAccountCard(st) {
  // <img> 无法带 header，走 query token（服务端两种鉴权都接受）
  const token = localStorage.getItem('parallel_token') || '';
  $('login-avatar').src = st.qq ? `/api/login/avatar/${encodeURIComponent(st.qq)}?token=${encodeURIComponent(token)}` : '';
  $('login-nick').textContent = st.nickname || (st.qq ? `QQ ${st.qq}` : '未命名账号');
  $('login-qq').textContent = st.qq ? `QQ ${st.qq}` : '';
  const online = !!st.connected;
  $('login-enter').disabled = !online;
  setLoginState(online ? 'QQ 已登录，协议端在线' : 'QQ 未在线，请完成 QQ 客户端登录并接入', online ? 'ok' : '');
  loginView('login-view-account');
  $('login-enter').onclick = () => commitEnter();
  // 自动登录：仅当在线且用户勾过时，1 秒自动进入
  if (online && localStorage.getItem(AUTO_KEY) === '1') {
    setLoginState('QQ 已登录，1 秒后自动进入…', 'ok');
    loginTimers.push(setTimeout(() => {
      // 期间用户取消勾选则中止（localStorage 已被 onchange 清掉）
      if (localStorage.getItem(AUTO_KEY) === '1') commitEnter();
    }, 1000));
  }
}

/**
 * 接入引导视图（SnowLuma 托管）：内核自动下载并拉起 SnowLuma，
 * 扫码登录在 QQ 客户端窗口 / SnowLuma WebUI 完成；反向 WS 已由托管预配，
 * 协议端一连入（QQ 登录成功）即自动进入主界面。
 */
async function showQrcode() {
  loginView('login-view-qrcode');
  const img = $('login-qr-img'), tip = $('login-qr-tip'), status = $('login-qr-status');
  img.classList.add('hidden'); img.src = '';
  tip.textContent = '正在启动协议端…';
  status.textContent = '首次运行会自动下载 SnowLuma（约 5MB），请稍候';
  const poll = async () => {
    const st = await get('/api/login/status');
    // QQ 登录成功 → 协议端连入 → 直接进主界面
    if (st.connected) { commitEnter(); return true; }
    const m = st.snowluma;
    if (m?.managed && !m.running) {
      tip.textContent = '正在启动协议端…';
      status.textContent = m.downloaded ? 'SnowLuma 启动中…' : '正在下载 SnowLuma（约 5MB，国内镜像加速）…';
    } else if (m?.running) {
      tip.textContent = '等待 QQ 登录';
      status.innerHTML = 'SnowLuma 已就绪。请登录 QQ 客户端（或到 <a href="' + (m.webuiUrl || 'http://127.0.0.1:5099') + '" target="_blank">SnowLuma 控制台</a> 按引导接入 QQ），登录成功后自动进入';
    }
    return false;
  };
  poll().catch(() => {});
  loginTimers.push(setInterval(() => poll().catch(() => {}), 2000));
}

/** 初始路由：按登录状态分流（token 已由 hash/持久化解决，不再有输入框） */
async function routeLogin() {
  bindAutoChk('login-auto-chk');
  try {
    await get('/api/state'); // token 有效性
    const st = await get('/api/login/status').catch(() => null);
    if (st && (st.connected || st.qq)) {
      $('login-auto-chk').checked = localStorage.getItem(AUTO_KEY) === '1';
      showAccountCard(st);
    } else {
      // 从未登录过或协议端离线且无历史账号 → 扫码登录
      showQrcode();
    }
  } catch {
    // token 无效且 URL 也没有新 token：提示重新从内核入口进入
    loginView('login-view-account');
    $('login-nick').textContent = '无法连接';
    $('login-qq').textContent = '令牌缺失或已失效';
    $('login-enter').disabled = true;
    setLoginState('请回到 parallel 内核控制台重新打开桌面端', 'err');
  }
}

function showLogin() {
  loginTimers.forEach(clearInterval);
  loginTimers = [];
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  routeLogin();
}
function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  connectWS();
  buildNav();
  navigate(current);
  refreshStatus();
  if (!showApp._timers) {
    showApp._timers = true;
    setInterval(refreshStatus, 10000);
    setInterval(updateErrorBadge, 30000);
  }
}

$('login-qr-back').onclick = () => { loginTimers.forEach(clearInterval); loginTimers = []; routeLogin(); };
// 账号卡：使用其他账号 → 回扫码视图；token 失效时 navigate/showApp 也会走 showLogin
$('login-switch').onclick = () => { loginTimers.forEach(clearInterval); loginTimers = []; showQrcode(); };

showLogin();
