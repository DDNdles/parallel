import { get, post, onEvent, fmtTime, fmtDT, el } from '../api.js';
import { icons } from '../icons.js';

// 会话页 —— Codex 任务页形态：
// 会话列表 + 40rem 居中会话列（用户右对齐气泡 / 助手纯排版 / 工具调用灰文本折叠行）
// + 大圆角 composer（身份 pill 切换、白圆发送钮、斜杠命令补全键盘导航）
let currentChat = null;
let sendMode = 'user'; // 'user' 注入为用户 | 'bot' 以 bot 身份发送
let unsubLog = null;   // session.log 监听退订句柄（防止重复渲染时叠加监听）

export async function renderChats(root) {
  const chats = await get('/api/chats');
  root.innerHTML = `
    <div class="wb">
      <aside class="wb-list">
        <div class="wb-list-head"><span>会话</span><span class="mono">${chats.length}</span></div>
        <div id="chat-list"></div>
      </aside>
      <section class="wb-main">
        <div class="wb-empty hidden" id="wb-empty">
          <svg class="empty-illo" viewBox="0 0 200 120" fill="none" aria-hidden="true">
            <rect x="52" y="14" width="96" height="62" rx="16" class="illo-bubble"/>
            <path d="M78 76l-6 16 20-14" class="illo-bubble"/>
            <circle cx="84" cy="45" r="4.5" class="illo-dot"/>
            <circle cx="102" cy="45" r="4.5" class="illo-dot d2"/>
            <circle cx="120" cy="45" r="4.5" class="illo-dot d3"/>
            <path d="M28 96c14-8 30-8 44 0M128 96c14-8 30-8 44 0" class="illo-line"/>
            <circle cx="100" cy="99" r="3" class="illo-heart"/>
          </svg>
          <div class="big">一段对话还没有开始</div>
          <div class="env">从左侧挑一个会话，或在 <b>下方</b> 注入一条模拟消息 —— 无需真实 QQ，内核链路完整运行</div>
        </div>
        <div class="wb-conv hidden" id="wb-conv" style="display:flex;flex-direction:column;flex:1;min-height:0">
          <div class="conv-scroll" id="chat-stream"><div class="conv-col" id="conv-col"></div></div>
          <div class="composer-wrap">
            <div class="composer-inner">
              <div class="ac-panel hidden" id="ac-panel"></div>
              <div class="composer-box">
                <textarea id="composer-input" rows="1" placeholder="向 parallel 发送消息，或输入 / 唤起命令…" aria-label="消息输入框"></textarea>
                <div class="composer-bar">
                  <div class="seg" id="mode-seg" role="radiogroup" aria-label="发送模式">
                    <button type="button" class="seg-btn active" data-mode="user" role="radio" aria-checked="true">注入为用户</button>
                    <button type="button" class="seg-btn" data-mode="bot" role="radio" aria-checked="false">以 bot 身份</button>
                  </div>
                  <div class="id-chips" id="id-chips">
                    <input id="inject-user" value="10001" title="用户 QQ" aria-label="用户 QQ">
                    <input id="inject-name" value="测试用户" title="昵称" aria-label="昵称">
                  </div>
                  <span class="flex"></span>
                  <span class="muted" id="cmd-hint" aria-live="polite"></span>
                  <button class="icon-btn" id="send-abort" title="打断当前轮次" aria-label="打断当前轮次">${icons.stop}</button>
                  <button class="send-btn" id="btn-send" title="发送 (Enter)" aria-label="发送消息">${icons.send}</button>
                </div>
              </div>
              <div class="composer-hint">Enter 发送 · Shift+Enter 换行 · / 唤起命令补全 · 注入消息走完整内核链路</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  `;

  renderChatList(chats);

  // 每次渲染先退订旧监听，避免同一事件触发多次（消息重复追加）
  unsubLog?.();
  onEvent('session.log', (entry) => {
    if (!currentChat) return;
    const key = `${entry.chatType}_${entry.chatId}`;
    if (key !== currentChat) return;
    appendEntry(entry);
  }).then((un) => { unsubLog = un; });

  const input = document.getElementById('composer-input');
  const seg = document.getElementById('mode-seg');
  seg.querySelectorAll('.seg-btn').forEach((b) => {
    b.onclick = () => {
      sendMode = b.dataset.mode;
      seg.querySelectorAll('.seg-btn').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      document.getElementById('id-chips').style.visibility = sendMode === 'user' ? 'visible' : 'hidden';
      input.placeholder = sendMode === 'user' ? '向 parallel 发送消息，或输入 / 唤起命令…' : '以 bot 身份直接发言（QQ 侧可见）';
    };
  });

  // 未选择会话时：隐藏会话列与 composer，显示空状态引导
  if (!currentChat) {
    document.getElementById('wb-conv').classList.add('hidden');
    document.getElementById('wb-empty').classList.remove('hidden');
  }

  input.addEventListener('input', () => { autogrow(input); maybeAutocomplete(input); });
  input.addEventListener('keydown', (e) => {
    if (acActive) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); return; }
      if (e.key === 'Escape') { closeAc(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pickAc(); return; }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  document.getElementById('btn-send').onclick = () => send();
  document.getElementById('send-abort').onclick = async () => {
    if (!currentChat) return;
    await post(`/api/chats/${currentChat}/abort`);
  };
}

function renderChatList(chats) {
  const list = document.getElementById('chat-list');
  list.innerHTML = chats.length ? '' : '<div class="muted" style="padding:14px">暂无会话</div>';
  for (const c of chats) {
    const item = el(`<button type="button" class="chat-item" data-key="${c.chatKey}" aria-label="打开会话 ${c.chatType === 'group' ? '群' : '私聊'} ${c.chatId}">
      <div class="t">${c.chatType === 'group' ? '群' : '私聊'} · ${c.chatId}</div>
      <div class="s">${fmtDT(c.lastTs)}</div>
    </button>`);
    item.onclick = () => openChat(c.chatKey, c.chatType, c.chatId);
    list.appendChild(item);
  }
}

async function openChat(chatKey, chatType, chatId) {
  currentChat = chatKey;
  document.querySelectorAll('.chat-item').forEach((n) => n.classList.toggle('active', n.dataset.key === chatKey));
  document.getElementById('wb-empty').classList.add('hidden');
  const conv = document.getElementById('wb-conv');
  conv.classList.remove('hidden');
  conv.style.display = 'flex';
  const data = await get(`/api/chats/${chatKey}/tail?limit=300`);
  const col = document.getElementById('conv-col');
  col.innerHTML = '';
  for (const e of data.entries) appendEntry(e, true);
  scrollBottom(true);
  document.getElementById('composer-input').focus();
}

function scrollBottom(force) {
  const sc = document.getElementById('chat-stream');
  if (!sc) return;
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
  if (force || nearBottom) sc.scrollTop = sc.scrollHeight;
}

// ---------- 会话流渲染 ----------

const MAX_TURN_NODES = 400; // 会话流 DOM 软上限，超出移除最旧节点

function appendEntry(e, noScroll) {
  const col = document.getElementById('conv-col');
  if (!col) return;
  let node = null;
  if (e.type === 'message_in') {
    node = el(`<div class="turn turn-user">
      <div class="meta">${escapeHtml(e.nickname || e.userId || '')} · ${fmtTime(e.ts)}${e.data?.files?.length ? '（含附件）' : ''}</div>
      <div class="bubble-user">${escapeHtml(e.text || '')}</div>
    </div>`);
  } else if (e.type === 'message_out') {
    node = el(`<div class="turn turn-assistant">
      <div class="text-md">${mdLite(e.text || '')}${e.data?.simulated ? '<span class="muted"> （桌面端模拟）</span>' : ''}</div>
    </div>`);
  } else if (e.type === 'tool_call' || e.type === 'tool_result') {
    const last = col.querySelector(`.tool-row[data-call="${e.data?.callId}"]`);
    if (e.type === 'tool_call') {
      // Codex 式折叠态：纯灰文本行 + 行尾 chevron（无图标无边框）
      node = el(`<div class="tool-row" data-call="${e.data?.callId}">
        <button type="button" class="tool-head" aria-expanded="false"><span class="chev">${icons.chevron}</span><span class="tool-name">${escapeHtml(e.text)}</span><span class="tool-sum">${escapeHtml(String(e.data?.args ?? '').slice(0, 48))}</span></button>
        <div class="tool-body hidden"><pre>${escapeHtml(String(e.data?.args ?? ''))}</pre></div>
      </div>`);
      node.querySelector('.tool-head').onclick = () => toggleTool(node);
    } else if (last) {
      const body = last.querySelector('.tool-body pre');
      body.textContent += `\n\n→ ${e.data?.result ?? ''}`;
      const sum = last.querySelector('.tool-sum');
      if (sum && e.data?.result) sum.textContent = String(e.data.result).slice(0, 48).replace(/\n/g, ' ');
    } else {
      node = el(`<div class="tool-row"><button type="button" class="tool-head" aria-expanded="false"><span class="chev">${icons.chevron}</span><span class="tool-name">${escapeHtml(e.text)}</span><span class="tool-sum">（结果）</span></button>
        <div class="tool-body hidden"><pre>${escapeHtml(String(e.data?.result ?? ''))}</pre></div></div>`);
      node.querySelector('.tool-head').onclick = () => toggleTool(node);
    }
  } else if (e.type === 'command') {
    node = el(`<div class="turn turn-user">
      <div class="meta">${escapeHtml(e.nickname || e.userId || '')} · ${fmtTime(e.ts)}</div>
      <div class="bubble-user mono">${escapeHtml('/' + (e.text || ''))}</div>
    </div>`);
  } else if (e.type === 'command_result') {
    node = el(`<div class="turn turn-assistant"><div class="text-md">${mdLite(e.text || '')}</div></div>`);
  } else if (e.type === 'error') {
    node = el(`<div class="turn-sys turn-sys-err">${escapeHtml(e.text || '')} · ${fmtTime(e.ts)}</div>`);
  } else if (e.type === 'agent_start' || e.type === 'agent_end') {
    node = el(`<div class="turn-sys">${escapeHtml(e.text || '')} · ${fmtTime(e.ts)}</div>`);
  }
  if (node) {
    col.appendChild(node);
    while (col.children.length > MAX_TURN_NODES) col.firstElementChild.remove();
    if (!noScroll) scrollBottom();
  }
}

function toggleTool(row) {
  const body = row.querySelector('.tool-body');
  const hidden = body.classList.toggle('hidden');
  const head = row.querySelector('.tool-head');
  head.querySelector('.chev').classList.toggle('open', !hidden);
  head.setAttribute('aria-expanded', String(!hidden));
}

/** 轻量 Markdown：代码围栏 + 行内代码（先转义再渲染，安全） */
function mdLite(s) {
  const esc = escapeHtml(s);
  return esc
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) =>
      `<div class="codeblock"><div class="codehead"><span>${escapeHtml(lang || 'code')}</span></div><pre>${code}</pre></div>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 发送 ----------

async function send() {
  const input = document.getElementById('composer-input');
  const text = input.value.trim();
  if (!text || !currentChat) return;
  input.value = '';
  autogrow(input);
  const hint = document.getElementById('cmd-hint');
  if (sendMode === 'user') {
    hint.innerHTML = '已注入，等待回复 <span class="typing-dots"><i></i><i></i><i></i></span>';
    await post(`/api/chats/${currentChat}/inject`, {
      text,
      userId: document.getElementById('inject-user').value.trim() || '10001',
      nickname: document.getElementById('inject-name').value.trim() || '测试用户',
    });
    setTimeout(() => { const h = document.getElementById('cmd-hint'); if (h) h.textContent = ''; }, 6000);
  } else {
    await post(`/api/chats/${currentChat}/send`, { text });
  }
}

function autogrow(input) {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

// ---------- 斜杠命令补全（键盘导航） ----------

let acItems = [];
let acActive = false;
let acSel = 0;
let cmdCache = null;
let cmdCacheKey = '';

async function maybeAutocomplete(input) {
  const v = input.value;
  const panel = document.getElementById('ac-panel');
  if (!v.startsWith('/')) { panel.classList.add('hidden'); acActive = false; return; }
  if (!cmdCache || cmdCacheKey !== currentChat) {
    const m = currentChat?.match(/^(group|private)_(.+)$/);
    cmdCache = await post('/api/rpc/commands_visible', { chatId: m?.[2] ?? '', chatType: m?.[1] ?? 'group', role: 'owner' }).catch(() => []);
    cmdCacheKey = currentChat;
  }
  const q = v.slice(1).split(/\s/)[0].toLowerCase();
  acItems = cmdCache.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 12);
  if (!acItems.length) { panel.classList.add('hidden'); acActive = false; return; }
  acActive = true;
  acSel = 0;
  panel.innerHTML = acItems.map((c, i) =>
    `<div class="ac-item ${i === 0 ? 'sel' : ''}" data-i="${i}"><span class="mono">/${c.name}</span><span class="d">${escapeHtml(c.description)}${c.enabled === false ? '（未开启）' : ''}</span></div>`).join('');
  panel.classList.remove('hidden');
  panel.querySelectorAll('.ac-item').forEach((n) => n.onclick = () => pickAc());
}

function moveSel(d) {
  acSel = (acSel + d + acItems.length) % acItems.length;
  const panel = document.getElementById('ac-panel');
  panel.querySelectorAll('.ac-item').forEach((n, i) => n.classList.toggle('sel', i === acSel));
  panel.querySelector('.ac-item.sel')?.scrollIntoView({ block: 'nearest' });
}

function pickAc() {
  if (!acItems.length) return;
  const c = acItems[acSel];
  const input = document.getElementById('composer-input');
  input.value = '/' + c.name + ' ';
  closeAc();
  input.focus();
}

function closeAc() {
  document.getElementById('ac-panel')?.classList.add('hidden');
  acActive = false;
}
