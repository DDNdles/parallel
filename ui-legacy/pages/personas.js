import { get, post, toast } from '../api.js';

// 人格管理：人格插件卡片视图 + 编辑器（JSON 源码）+ provider 绑定展示
export async function renderPersonas(root) {
  const data = await get('/api/personas');
  const providers = await get('/api/providers');

  root.innerHTML = `
    <h2 class="page-title">人格管理 <span class="sub">人格以插件形式提供 —— 仅主人可查看/修改/切换（QQ 侧普通成员不可见内容）</span></h2>
    <div class="card">
      <h3>模型 → 人格 绑定</h3>
      <div class="kv">
        <span class="k">默认人格</span><span>${data.default}</span>
        <span class="k">绑定规则</span><span class="mono">${Object.entries(data.bindings).map(([k, v]) => `${k} → ${v}`).join('；') || '无'}</span>
        <span class="k">当前模型</span><span>${providers.active}（DeepSeek 系将自动使用鲸鱼娘；gemini-3.8-flash 占位未接入）</span>
      </div>
    </div>
    <div id="persona-list"></div>
  `;

  const list = root.querySelector('#persona-list');
  for (const pp of data.plugins) {
    for (const persona of pp.personas) {
      list.appendChild(personaCard(persona, pp));
    }
  }
}

function personaCard(persona, pp) {
  const card = document.createElement('div');
  card.className = 'card';
  const cardJson = persona.raw['card.json'] || '{}';
  let cardData = {};
  try { cardData = JSON.parse(cardJson); } catch { /* ignore */ }
  card.innerHTML = `
    <h3>${cardData.name || persona.id} <span class="muted mono">${persona.id}</span> <span class="tag">来自插件 ${pp.pluginId}</span></h3>
    <div class="muted" style="margin-bottom:10px">${cardData.description || ''}</div>
    <div class="grid grid-2">
      <div>
        <div class="muted" style="margin-bottom:4px">性格</div>
        <div style="font-size:13px">${cardData.personality || '-'}</div>
        <div class="muted" style="margin:8px 0 4px">场景</div>
        <div style="font-size:13px">${cardData.scenario || '-'}</div>
      </div>
      <div>
        <div class="muted" style="margin-bottom:4px">开场白 (first_mes)</div>
        <div style="font-size:13px;white-space:pre-wrap">${cardData.first_mes || '-'}</div>
        <div class="muted" style="margin:8px 0 4px">世界书条目 / 语气样例</div>
        <div class="muted">${(persona.lore?.entries?.length ?? persona.lore?.length ?? 0)} 条 lore / ${(persona.fewshot?.examples ?? []).length} 条 few-shot</div>
      </div>
    </div>
    <details style="margin-top:10px">
      <summary class="muted">编辑人格文件（JSON，保存后热生效）</summary>
      <div style="margin-top:8px">
        <select id="pf-${persona.id}" style="margin-bottom:8px">
          <option value="card.json">card.json（人设卡）</option>
          <option value="fewshot.json">fewshot.json（语气样例+尾部强化）</option>
          <option value="lorebook.json">lorebook.json（世界书）</option>
        </select><br>
        <textarea class="mono" id="pe-${persona.id}" style="width:100%;height:260px">${escapeHtml(persona.raw['card.json'] || '')}</textarea>
        <div style="margin-top:8px"><button class="btn primary small" data-save="1">保存</button> <span class="muted">人设内容仅主人可见可改；QQ 侧普通成员无法套取</span></div>
      </div>
    </details>
  `;
  const sel = card.querySelector(`#pf-${persona.id}`);
  const ta = card.querySelector(`#pe-${persona.id}`);
  sel.onchange = () => { ta.value = persona.raw[sel.value] || ''; };
  card.querySelector('[data-save]').onclick = async () => {
    try { JSON.parse(ta.value); } catch (e) { toast('JSON 解析失败：' + e.message, 'err'); return; }
    const r = await post('/api/personas/edit', { personaId: persona.id, file: sel.value, content: ta.value });
    if (r.ok) toast('已保存并热加载', 'ok');
    else toast('保存失败：' + (r.error ?? ''), 'err');
  };
  return card;
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
