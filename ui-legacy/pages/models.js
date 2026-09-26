import { get, post, toast } from '../api.js';

// 模型页：Provider 列表（gemini-3.8-flash 占位标"未接入"）、切换、配置、用量
// 操作后原位重渲染，不做整页刷新
export async function renderModels(root) {
  const data = await get('/api/providers');

  root.innerHTML = `
    <h2 class="page-title">模型 <span class="sub">当前： ${data.active} / ${data.activeModel}</span></h2>
    <div class="card">
      <h3>用量（今日）</h3>
      <div class="kv">
        <span class="k">Prompt Tokens</span><span>${data.usage.promptTokens.toLocaleString()}</span>
        <span class="k">Completion Tokens</span><span>${data.usage.completionTokens.toLocaleString()}</span>
        <span class="k">调用次数</span><span>${data.usage.llmCalls}</span>
        <span class="k">人格绑定</span><span class="mono">${Object.entries(data.binding).map(([k, v]) => `${k} → ${v}`).join('；')}</span>
      </div>
    </div>
    <div id="prov-list"></div>
  `;

  const list = root.querySelector('#prov-list');
  for (const p of data.providers) {
    list.appendChild(providerCard(p, data.active, root));
  }
}

function providerCard(p, activeId, root) {
  const card = document.createElement('div');
  card.className = 'card';
  const usable = p.implemented && p.enabled && p.configured;
  const stateTag = !p.implemented
    ? '<span class="tag warn">未接入（仅接口与配置占位）</span>'
    : usable ? '<span class="tag ok">就绪</span>'
    : p.enabled ? '<span class="tag warn">缺配置</span>' : '<span class="tag">未启用</span>';
  card.innerHTML = `
    <h3>${p.label} <span class="muted mono">${p.id}</span> ${stateTag}
      ${p.id === activeId ? '<span class="tag accent">当前使用</span>' : ''}</h3>
    ${p.id === 'gemini-3.8-flash' ? '<div class="warnbox">gemini-3.8-flash 仅为占位 Provider（enabled=false，未实现请求逻辑），不可调用。</div>' : ''}
    <div class="kv" style="margin-bottom:10px">
      <span class="k">模型名</span><span><input type="text" class="f-model" value="${p.config.model ?? ''}" style="width:240px"></span>
      ${p.implemented ? `
      <span class="k">Base URL</span><span><input type="text" class="f-base" value="${p.config.baseUrl ?? ''}" style="width:340px" ${p.id === 'deepseek' ? 'placeholder="https://api.deepseek.com"' : ''}></span>
      <span class="k">API Key</span><span><input type="password" class="f-key" value="" placeholder="${p.hasKey ? '已配置（脱敏显示）' : '未配置'}" style="width:340px"></span>` : `
      <span class="k">Base URL</span><span class="muted">留空（TODO）</span>
      <span class="k">API Key</span><span class="muted">留空（TODO）</span>`}
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn small ${p.id === activeId ? '' : 'primary'}" data-act="use" ${p.id === activeId ? 'disabled' : ''}>设为当前</button>
      <span class="muted">启用：</span><div class="switch f-enabled ${p.enabled ? 'on' : ''}"></div>
      ${p.implemented ? '<button class="btn small" data-act="save">保存配置</button>' : ''}
      <span class="muted" style="font-size:11px">${p.streaming ? '支持流式+工具调用' : ''}</span>
    </div>
  `;
  card.querySelector('.f-enabled').onclick = (e) => e.target.classList.toggle('on');
  card.querySelector('[data-act="use"]').onclick = async () => {
    await post('/api/providers/active', { providerId: p.id });
    toast('已切换当前模型', 'ok');
    setTimeout(() => renderModels(root), 600);
  };
  const save = card.querySelector('[data-act="save"]');
  if (save) save.onclick = async () => {
    const key = card.querySelector('.f-key').value.trim();
    try {
      await post(`/api/providers/${p.id}`, {
        enabled: card.querySelector('.f-enabled').classList.contains('on'),
        baseUrl: card.querySelector('.f-base').value.trim(),
        model: card.querySelector('.f-model').value.trim(),
        apiKey: key || undefined,
      });
      toast('已保存', 'ok');
      setTimeout(() => renderModels(root), 600);
    } catch (e) { toast(e.message, 'err'); }
  };
  return card;
}
