import { get, post, fmtDT, toast } from '../api.js';

// 记忆管理：按 QQ 号浏览/搜索/编辑/删除、忘记我、导入导出、审计流
let selected = '';

export async function renderMemory(root) {
  const users = await get('/api/memory');
  root.innerHTML = `
    <h2 class="page-title">记忆 <span class="sub">按 QQ 号存储 —— 事实 / 属性（好感度等）/ 审计</span></h2>
    <div class="grid" style="grid-template-columns:280px 1fr">
      <div class="card" style="max-height:70vh;overflow-y:auto">
        <h3>用户（${users.length}）</h3>
        ${users.length ? users.map((u) => `<div class="chat-item ${u.userId === selected ? 'active' : ''}" data-u="${u.userId}">
          <div class="t">${u.nickname || '(无昵称)'} <span class="muted mono">${u.userId}</span>${u.blocked ? ' <span class="tag err">拉黑</span>' : ''}</div>
        </div>`).join('') : '<div class="muted">暂无记忆。与 bot 聊天后产生。</div>'}
        <div style="margin-top:10px;display:flex;gap:6px">
          <button class="btn small" id="mem-export">导出 JSON</button>
          <button class="btn small" id="mem-import">导入</button>
        </div>
        <input type="file" id="mem-file" class="hidden" accept=".json">
      </div>
      <div id="mem-detail" class="muted">选择左侧用户查看记忆。</div>
    </div>
  `;
  root.querySelectorAll('[data-u]').forEach((n) => {
    n.onclick = () => { selected = n.dataset.u; renderMemory(root); };
  });
  root.querySelector('#mem-export').onclick = async () => {
    const data = await get('/api/memory/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `parallel-memory-${Date.now()}.json`;
    a.click();
  };
  root.querySelector('#mem-import').onclick = () => root.querySelector('#mem-file').click();
  root.querySelector('#mem-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const r = await post('/api/memory/import', data);
      toast(`已导入 ${r.users} 个用户`, 'ok');
      renderMemory(root);
    } catch (err) { toast('导入失败：' + err.message, 'err'); }
  };
  if (selected) await renderDetail(root);
}

async function renderDetail(root) {
  const d = await get(`/api/memory/user/${selected}`);
  const el = root.querySelector('#mem-detail');
  el.className = 'card';
  el.innerHTML = `
    <h3>${d.profile.nickname || d.profile.userId} <span class="muted mono">${d.profile.userId}</span></h3>
    <div class="kv" style="margin-bottom:12px">
      <span class="k">好感度</span><span>${d.attrs.affection ?? 20} / 100</span>
      <span class="k">心情</span><span>${d.attrs.mood ?? '平静'}</span>
      <span class="k">首次见面</span><span>${fmtDT(d.profile.firstSeen)}</span>
      <span class="k">最近活跃</span><span>${fmtDT(d.profile.lastSeen)}</span>
      <span class="k">拉黑</span><span>${d.profile.blocked ? '是' : '否'}</span>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input type="text" id="mem-q" placeholder="搜索事实（FTS 全文检索）…" style="flex:1">
      <button class="btn small" id="mem-add-btn">新增事实</button>
      <button class="btn small danger" id="mem-forget">忘记我（清空）</button>
    </div>
    <div id="mem-add-row" class="hidden" style="display:flex;gap:8px;margin-bottom:12px">
      <input type="text" id="mem-add-in" placeholder="输入新事实内容，Enter 保存" style="flex:1" aria-label="新事实内容">
      <button class="btn small primary" id="mem-add-save">保存</button>
      <button class="btn small" id="mem-add-cancel">取消</button>
    </div>
    <table><tr><th>事实</th><th>来源</th><th>时间</th><th></th></tr>
      <tbody id="facts"></tbody></table>
    <div class="ops muted" id="audit" style="margin-top:14px"></div>
  `;
  const factsEl = el.querySelector('#facts');
  async function loadFacts(q) {
    const url = `/api/memory/user/${selected}` + (q ? `?q=${encodeURIComponent(q)}` : '');
    const dd = await get(url);
    factsEl.innerHTML = dd.facts.map((f) => `<tr>
      <td><input type="text" class="fact-in" data-id="${f.id}" value="${escapeAttr(f.content)}" style="width:100%"></td>
      <td class="muted">${f.sourcePlugin}</td><td class="muted">${fmtDT(f.ts)}</td>
      <td><button class="btn small" data-save="${f.id}">存</button> <button class="btn small danger" data-del="${f.id}">删</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">（无事实）</td></tr>';
    bindFactActions();
  }
  function bindFactActions() {
    factsEl.querySelectorAll('[data-save]').forEach((b) => {
      b.onclick = async () => {
        const content = factsEl.querySelector(`.fact-in[data-id="${b.dataset.save}"]`).value;
        try {
          await post('/api/memory/fact', { userId: selected, id: b.dataset.save, content });
          toast('已保存', 'ok');
        } catch (err) { toast(err.message, 'err'); }
        loadFacts(el.querySelector('#mem-q').value);
      };
    });
    factsEl.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        try {
          await post('/api/memory/fact', { userId: selected, id: b.dataset.del });
          toast('已删除', 'ok');
        } catch (err) { toast(err.message, 'err'); }
        loadFacts(el.querySelector('#mem-q').value);
      };
    });
  }
  await loadFacts('');
  el.querySelector('#mem-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadFacts(e.target.value.trim());
  });
  el.querySelector('#mem-add-btn').onclick = () => {
    el.querySelector('#mem-add-row').classList.remove('hidden');
    el.querySelector('#mem-add-in').focus();
  };
  async function saveNewFact() {
    const content = el.querySelector('#mem-add-in').value.trim();
    if (!content) return;
    try {
      await post(`/api/memory/user/${selected}`, { content });
      toast('已新增事实', 'ok');
      el.querySelector('#mem-add-in').value = '';
      el.querySelector('#mem-add-row').classList.add('hidden');
      loadFacts('');
    } catch (err) { toast(err.message, 'err'); }
  }
  el.querySelector('#mem-add-save').onclick = saveNewFact;
  el.querySelector('#mem-add-in').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNewFact();
    if (e.key === 'Escape') el.querySelector('#mem-add-row').classList.add('hidden');
  });
  el.querySelector('#mem-add-cancel').onclick = () => el.querySelector('#mem-add-row').classList.add('hidden');
  el.querySelector('#mem-forget').onclick = async () => {
    if (!confirm(`确认清空 ${selected} 的全部记忆？（"忘记我"）`)) return;
    await post(`/api/memory/user/${selected}/forget`);
    selected = '';
    renderMemory(root);
  };
  const ops = await get('/api/memory/ops');
  el.querySelector('#audit').innerHTML = '<b>最近记忆操作审计</b><br>' + ops.slice(0, 20).map((o) =>
    `${fmtDT(o.ts)} [${o.source}] ${o.userId} ${o.op} ${o.payload}`).join('<br>');
}

function escapeAttr(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
