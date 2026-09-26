import { get, post, fmtDT, onEvent, toast } from '../api.js';

// 报错中心：集中看错误 + 处置动作
let unsubErr = null; // 防止重复渲染时叠加监听

export async function renderErrors(root) {
  const errors = await get('/api/errors');
  root.innerHTML = `
    <h2 class="page-title">报错中心 <span class="sub">error 级自动私聊主人（同错误 10 分钟节流 1 次）</span></h2>
    <div style="margin-bottom:10px"><button class="btn" id="clear-err">清除全部记录</button></div>
    <div class="card" style="padding:0">
      <table><tr><th>级别</th><th>类别</th><th>来源</th><th>内容</th><th>次数</th><th>最近发生</th><th>处置</th></tr>
      ${errors.map((e) => `<tr>
        <td><span class="tag ${e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : ''}">${e.level}</span></td>
        <td>${e.category}</td>
        <td class="mono muted">${e.pluginId || '-'}</td>
        <td style="max-width:380px">
          <div style="white-space:pre-wrap;word-break:break-word">${escapeHtml(e.message)}</div>
          ${e.stack ? `<details><summary class="muted">堆栈</summary><pre class="mono muted" style="font-size:11px;white-space:pre-wrap">${escapeHtml(e.stack)}</pre></details>` : ''}
          ${e.suggestion ? `<div class="muted" style="margin-top:4px">建议：${escapeHtml(e.suggestion)}</div>` : ''}
        </td>
        <td>${e.count}</td>
        <td class="muted">${fmtDT(e.lastTs)}</td>
        <td>
          ${e.pluginId ? `<button class="btn small" data-reload="${e.pluginId}">重载插件</button>` : ''}
          ${e.category === 'adapter' ? '<button class="btn small" data-wait="1">等待重连</button>' : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">没有错误记录</td></tr>'}
      </table>
    </div>
  `;
  root.querySelector('#clear-err').onclick = async () => { await post('/api/errors/clear'); renderErrors(root); };
  root.querySelectorAll('[data-reload]').forEach((b) => {
    b.onclick = async () => {
      try { await post(`/api/plugins/${b.dataset.reload}/reload`); toast('已重载', 'ok'); renderErrors(root); } catch (e) { toast(e.message, 'err'); }
    };
  });
  unsubErr?.();
  onEvent('error.recorded', () => { if (document.contains(root)) renderErrors(root); }).then((un) => { unsubErr = un; });
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
