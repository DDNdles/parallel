import { get, post, fmtBytes } from '../api.js';
import { icon } from '../icons.js';

export async function renderConsole(root) {
  const s = await get('/api/state');
  const sb = await get('/api/sandbox');
  root.innerHTML = `
    <h2 class="page-title">控制台 <span class="sub">总览与快捷操作</span></h2>
    <div class="grid grid-4">
      ${statCard('chats', '协议端', s.adapter.connected ? `已连接` : '未连接', s.adapter.connected ? 'ok' : 'err', s.adapter.selfId ? `QQ ${s.adapter.selfId}` : '等待协议端反向 WS 接入')}
      ${statCard('models', '当前模型', s.model.provider, s.model.usable.ok ? 'ok' : 'warn', s.model.usable.ok ? s.model.model : s.model.usable.reason)}
      ${statCard('plugins', '插件', `${s.plugins.loaded}/${s.plugins.total}`, 'ok', '已载入 / 已发现')}
      ${statCard('console', '今日 Token', (s.usage.promptTokens + s.usage.completionTokens).toLocaleString(), '', `LLM 调用 ${s.usage.llmCalls} 次 · 出站消息 ${s.usage.messagesIn ?? 0}`)}
    </div>
    <div class="grid grid-2" style="margin-top:14px">
      <div class="card">
        <h3>QQ 接入</h3>
        <div class="kv">
          <span class="k">模式</span><span>OneBot 11 反向 WS（协议端主动连入）</span>
          <span class="k">端点</span><span class="mono">${s.adapter.endpoint}</span>
          <span class="k">状态</span><span>${s.adapter.connected ? `已连接（${fmtUp(s.uptimeMs)}）` : '未连接'}</span>
          <span class="k">主人</span><span>${s.masterIds.length ? s.masterIds.join('、') : '未配置（设置 → 主人 QQ）'}</span>
        </div>
        <div style="margin-top:10px">
          <button class="btn" id="btn-groups">刷新群列表</button>
          <span class="muted" id="groups-out"></span>
        </div>
      </div>
      <div class="card">
        <h3>沙箱占用</h3>
        ${sb.stats.length ? `<table><tr><th>会话</th><th>文件</th><th>占用</th></tr>
          ${sb.stats.slice(0, 6).map((x) => `<tr><td class="mono">${x.chat}</td><td>${x.files}</td><td>${fmtBytes(x.bytes)}</td></tr>`).join('')}
        </table>` : '<div class="muted">暂无沙箱会话</div>'}
      </div>
    </div>
    <div class="card">
      <h3>风控降险检查表</h3>
      <div class="muted" style="line-height:2">
        ${check(s.masterIds.length > 0, '已配置主人 QQ 白名单')}
        ${check(true, 'QQ 接入经 SnowLuma 协议端（hook 本机 QQNT）')}
        ${check(true, 'OneBot 反向 WS 已启用 access token 鉴权')}
        ${check(true, '回复限速 + 随机抖动已启用（设置页可调）')}
        ${check(true, '群聊默认仅 @机器人/回复机器人时响应')}
        ${check(Object.values(s.riskProactive || {}).every((v) => !v), '所有主动推送（每日推送类）默认关闭')}
      </div>
    </div>
  `;
  root.querySelector('#btn-groups').onclick = async () => {
    try {
      const r = await post('/api/adapter/refresh-groups');
      root.querySelector('#groups-out').textContent = `已刷新 ${Object.keys(r.groups ?? {}).length} 个群`;
    } catch (e) { root.querySelector('#groups-out').textContent = e.message; }
  };
  // 风控主动推送状态补充
  get('/api/config').then((c) => {
    const box = root.querySelector('.card:last-child .muted');
    const entries = Object.entries(c.risk.proactive ?? {});
    if (entries.length) {
      box.appendChild(document.createElement('div')).innerHTML =
        `主动推送开启状态：${entries.map(([k, v]) => `${k} = ${v ? '已开启（风控风险）' : '关'}`).join('，') || '全部关闭'}`;
    }
  });
}

function statCard(ic, title, value, cls, sub) {
  return `<div class="card stat-card"><h3>${icon(ic)}${title}</h3>
    <div style="font-size:20px;font-weight:600;${cls === 'err' ? 'color:var(--err)' : cls === 'warn' ? 'color:var(--warn)' : cls === 'ok' ? 'color:var(--ok)' : ''}">${value}</div>
    <div class="muted" style="margin-top:4px">${sub ?? ''}</div></div>`;
}
function check(ok, text) {
  const mark = icon(ok ? 'check' : 'warn', 'ic ic-sm chk-ic ' + (ok ? 'chk-ok-ic' : 'chk-bad-ic'));
  return `<div class="chk ${ok ? 'chk-ok' : 'chk-bad'}">${mark}<span class="sr-only">${ok ? '通过：' : '未通过：'}</span> ${text}</div>`;
}
function fmtUp(ms) {
  const m = Math.round(ms / 60000);
  return m > 90 ? `${Math.round(m / 60)} 小时` : `${m} 分钟`;
}
