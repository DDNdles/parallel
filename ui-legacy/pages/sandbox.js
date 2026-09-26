import { get, post, fmtBytes, fmtDT, toast } from '../api.js';

// 沙箱管理：各会话占用、清空、TTL/配额
export async function renderSandbox(root) {
  const data = await get('/api/sandbox');
  const c = data.config;
  root.innerHTML = `
    <h2 class="page-title">沙箱管理 <span class="sub">轻量沙箱 —— 临时文件自动清理</span></h2>
    <div class="card">
      <h3>限额与清理（保存后立即生效并持久化）</h3>
      <div class="grid grid-4">
        ${numField('ttlHours', '文件 TTL（小时）', c.ttlHours)}
        ${numField('inboxTtlHours', '收件文件 TTL（小时）', c.inboxTtlHours)}
        ${numField('maxFileBytes', '单文件上限（字节）', c.maxFileBytes)}
        ${numField('maxSessionBytes', '单会话上限（字节）', c.maxSessionBytes)}
        ${numField('execTimeoutPythonMs', 'Python 超时（毫秒）', c.execTimeoutPythonMs)}
        ${numField('execTimeoutJsMs', 'JS 超时（毫秒）', c.execTimeoutJsMs)}
        ${numField('maxRunsPerMin', '每分钟执行次数上限', c.maxRunsPerMin)}
      </div>
      <div style="margin-top:10px"><button class="btn primary" id="save-sb">保存</button>
        <span class="muted" style="margin-left:10px">沙箱网络：关闭（尽力而为，子进程无代理无凭据）；路径穿越由内核强校验拦截</span></div>
    </div>
    <div class="card" style="padding:0">
      <table><tr><th>会话</th><th>文件数</th><th>占用</th><th>最近活动</th><th>目录</th><th></th></tr>
      ${data.stats.map((s) => `<tr>
        <td class="mono">${s.chat}</td>
        <td>${s.files}</td>
        <td>${fmtBytes(s.bytes)}</td>
        <td class="muted">${fmtDT(s.lastActivity)}</td>
        <td class="mono muted">${s.root}</td>
        <td><button class="btn small danger" data-clear="${s.chat}">清空</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无沙箱会话。LLM 使用文件工具或收到聊天文件后出现在这里。</td></tr>'}
      </table>
    </div>
  `;
  root.querySelector('#save-sb').onclick = async () => {
    const body = {};
    root.querySelectorAll('.sb-num').forEach((i) => { body[i.dataset.k] = Number(i.value); });
    try { await post('/api/sandbox/config', body); toast('已保存，立即生效', 'ok'); } catch (e) { toast(e.message, 'err'); }
  };
  root.querySelectorAll('[data-clear]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`清空会话 ${b.dataset.clear} 的沙箱？`)) return;
      await post('/api/sandbox/clear', { chatKey: b.dataset.clear });
      renderSandbox(root);
    };
  });
}

function numField(k, label, val) {
  return `<div><div class="muted" style="margin-bottom:4px">${label}</div>
    <input type="number" class="sb-num" data-k="${k}" value="${val}" style="width:100%"></div>`;
}
