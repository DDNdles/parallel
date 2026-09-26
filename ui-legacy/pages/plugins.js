import { get, post, del, el, fmtDT, toast } from '../api.js';

// 插件管理（全局维度）：启停/重载/卸载/配置表单/权限展示 + 分群矩阵 + 全局默认
// 操作后原位重渲染（重新拉取数据），不做整页刷新
export async function renderPlugins(root) {
  const plugins = await get('/api/plugins');
  const chats = await get('/api/chats');
  const chatIds = [...new Set(chats.map((c) => c.chatId))];

  root.innerHTML = `
    <h2 class="page-title">插件管理 <span class="sub">全局维度 —— 全局停用的插件在所有群的 QQ 侧完全不可见</span></h2>
    <div style="margin-bottom:12px">
      <button class="btn" id="btn-install">扫描安装用户插件（data/plugins）</button>
      <button class="btn" id="btn-matrix">分群开关矩阵</button>
    </div>
    <div id="plugin-list"></div>
    <div id="matrix-box" class="card hidden">
      <h3>分群开关矩阵（插件 × 群）</h3>
      ${chatIds.length ? matrixHtml(plugins, chatIds) : '<div class="muted">还没有任何群的开关记录。在群内让管理员发送 /插件 开启 <id>，或在会话页注入测试消息后用矩阵操作。</div>'}
    </div>
  `;

  const list = root.querySelector('#plugin-list');
  for (const p of plugins) list.appendChild(pluginCard(p, root));

  root.querySelector('#btn-install').onclick = async () => {
    try {
      const r = await post('/api/plugins/install');
      toast(r.installed.length ? '已安装: ' + r.installed.join('、') : '没有发现新插件', 'ok');
      if (r.installed.length) setTimeout(() => renderPlugins(root), 600);
    } catch (e) { toast(e.message, 'err'); }
  };
  root.querySelector('#btn-matrix').onclick = () => {
    root.querySelector('#matrix-box').classList.toggle('hidden');
    bindMatrix(root);
  };
  bindMatrix(root);
}

function matrixHtml(plugins, chatIds) {
  return `<div class="matrix"><table><tr><th>插件</th>${chatIds.map((c) => `<th class="mono">${c}</th>`).join('')}</tr>
    ${plugins.filter((p) => !p.core).map((p) => `<tr>
      <td>${p.name} <span class="muted mono">${p.id}</span></td>
      ${chatIds.map((c) => {
        const st = p.groupStates.find((s) => s.chatId === c);
        const checked = st ? st.enabled : p.globalDefault;
        return `<td><input type="checkbox" class="mx" data-plugin="${p.id}" data-chat="${c}" ${checked ? 'checked' : ''}></td>`;
      }).join('')}
    </tr>`).join('')}
  </table></div>
  <div class="muted" style="margin-top:8px">勾选 = 该群开启；取消 = 关闭（写入群覆盖）。全局默认在每张插件卡上单独设置。</div>`;
}

function bindMatrix(root) {
  root.querySelectorAll('.mx').forEach((cb) => {
    cb.onchange = async () => {
      cb.disabled = true;
      try {
        await post(`/api/plugins/${cb.dataset.plugin}/group-state`, { chatId: cb.dataset.chat, enabled: cb.checked });
      } catch (e) {
        cb.checked = !cb.checked;
        toast(e.message, 'err');
      } finally { cb.disabled = false; }
    };
  });
}

function pluginCard(p, root) {
  const stateTag = p.state === 'loaded' ? '<span class="tag ok">已载入</span>'
    : p.state === 'disabled' ? '<span class="tag warn">已停用</span>' : '<span class="tag err">错误</span>';
  const trustTag = `<span class="tag ${p.trust === 'user' ? 'warn' : ''}">${p.trust === 'builtin' ? '内置' : p.trust === 'example' ? '示例' : '用户自建'}</span>`;
  const card = el(`<div class="card">
    <h3>${p.name} <span class="muted mono">${p.id} v${p.version}</span></h3>
    <div style="margin:6px 0 10px">${stateTag} ${trustTag}
      <span class="tag accent">${p.category}</span>
      ${p.core ? '<span class="tag">core</span>' : ''}
      ${p.locked ? '<span class="tag">仅主人可操作</span>' : ''}
      ${p.hasMcp ? '<span class="tag">MCP</span>' : ''}
    </div>
    <div class="muted" style="margin-bottom:8px">${p.description}</div>
    <div style="margin-bottom:8px"><span class="muted">权限：</span>${p.permissions.length ? p.permissions.map((x) => `<span class="tag">${x}</span>`).join('') : ' <span class="muted">无</span>'}</div>
    <div style="margin-bottom:8px"><span class="muted">工具：</span><span class="mono muted">${p.tools.join(', ') || '无'}</span>
      &nbsp;<span class="muted">命令：</span><span class="mono muted">${p.commands.map((x) => '/' + x).join(' ') || '无'}</span></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn small ${p.state === 'loaded' ? '' : 'primary'}" data-act="toggle">${p.state === 'loaded' ? '停用' : '启用'}</button>
      <button class="btn small" data-act="reload">重载</button>
      ${p.source === 'user' ? '<button class="btn small danger" data-act="uninstall">卸载</button>' : ''}
      <span style="flex:1"></span>
      <span class="muted">全局默认（新群/未覆盖群）：</span>
      <div class="switch ${p.globalDefault ? 'on' : ''}" data-act="global"></div>
      ${p.globalDefaultOverridden ? '<button class="btn small" data-act="clear-global">恢复 manifest 默认</button>' : ''}
    </div>
    <div class="config-box" style="margin-top:12px"></div>
    <details style="margin-top:8px"><summary class="muted">插件配置（userConfig）</summary><div class="cfg-form" style="margin-top:10px"></div></details>
  </div>`);

  card.querySelector('[data-act="toggle"]').onclick = async () => {
    try {
      await post(`/api/plugins/${p.id}/${p.state === 'loaded' ? 'disable' : 'enable'}`);
      toast(p.state === 'loaded' ? '已停用' : '已启用', 'ok');
      setTimeout(() => renderPlugins(root), 600);
    } catch (e) { toast(e.message, 'err'); }
  };
  card.querySelector('[data-act="reload"]').onclick = async () => {
    try { await post(`/api/plugins/${p.id}/reload`); toast('已重载', 'ok'); setTimeout(() => renderPlugins(root), 600); } catch (e) { toast(e.message, 'err'); }
  };
  const un = card.querySelector('[data-act="uninstall"]');
  if (un) un.onclick = async () => {
    if (!confirm(`卸载插件 ${p.id}？其持久化状态将被清除。`)) return;
    try { await del(`/api/plugins/${p.id}/uninstall`); toast('已卸载', 'ok'); setTimeout(() => renderPlugins(root), 600); } catch (e) { toast(e.message, 'err'); }
  };
  card.querySelector('[data-act="global"]').onclick = async (e) => {
    const on = !e.target.classList.contains('on');
    try {
      await post(`/api/plugins/${p.id}/global-default`, { enabled: on });
      toast(on ? '全局默认已开启' : '全局默认已关闭', 'ok');
      setTimeout(() => renderPlugins(root), 600);
    } catch (err) { toast(err.message, 'err'); }
  };
  const cg = card.querySelector('[data-act="clear-global"]');
  if (cg) cg.onclick = async () => {
    // 恢复 manifest 默认：反向写回当前 manifest 默认（on/off 由 defaultGroupState 决定）
    try {
      await post(`/api/plugins/${p.id}/global-default`, { enabled: p.defaultGroupState === 'on' });
      toast('已恢复 manifest 默认', 'ok');
      setTimeout(() => renderPlugins(root), 600);
    } catch (err) { toast(err.message, 'err'); }
  };

  // 配置表单
  const form = card.querySelector('.cfg-form');
  if (!Object.keys(p.userConfigSchema).length) {
    form.innerHTML = '<span class="muted">本插件无可配置项</span>';
  } else {
    loadConfigForm(p, form);
  }
  return card;
}

async function loadConfigForm(p, form) {
  const cfg = await get(`/api/plugins/${p.id}/config`);
  form.innerHTML = Object.entries(p.userConfigSchema).map(([k, f]) => {
    const val = cfg.values[k] ?? '';
    if (f.secret) {
      return `<div style="margin-bottom:8px"><div class="muted">${k}（敏感，脱敏显示）： ${f.description}</div>
        <input type="password" class="cfg-in" data-k="${k}" value="${val.includes('•') ? '' : escapeAttr(val)}" placeholder="${val || '未设置'}" style="width:420px"></div>`;
    }
    if (f.type === 'boolean') {
      return `<div style="margin-bottom:8px"><span class="muted">${k} —— ${f.description}</span>
        <input type="checkbox" class="cfg-in" data-k="${k}" data-type="boolean" ${val ? 'checked' : ''}></div>`;
    }
    if (f.type === 'text') {
      return `<div style="margin-bottom:8px"><div class="muted">${k} —— ${f.description}</div>
        <textarea class="cfg-in" data-k="${k}" style="width:520px;height:90px">${escapeHtml(val)}</textarea></div>`;
    }
    return `<div style="margin-bottom:8px"><span class="muted">${k} —— ${f.description}</span>
      <input type="${f.type === 'number' ? 'number' : 'text'}" class="cfg-in" data-k="${k}" value="${escapeAttr(String(val))}" style="width:300px"></div>`;
  }).join('') + `<div><button class="btn primary small" data-save="1">保存并重载</button> <span class="muted">敏感信息保存在 secrets.json，清单文件中不落 key</span></div>`;
  form.querySelector('[data-save]').onclick = async () => {
    const values = {};
    form.querySelectorAll('.cfg-in').forEach((inp) => {
      const k = inp.dataset.k;
      if (inp.dataset.type === 'boolean') values[k] = inp.checked;
      else values[k] = inp.value;
    });
    try {
      await post(`/api/plugins/${p.id}/config`, { values });
      toast('已保存，插件已重载', 'ok');
      setTimeout(() => renderPlugins(root), 600);
    } catch (e) { toast(e.message, 'err'); }
  };
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
