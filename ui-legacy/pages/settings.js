import { get, post, toast } from '../api.js';

// 设置：QQ 接入、风控
export async function renderSettings(root) {
  const c = await get('/api/config');
  const r = c.risk;
  root.innerHTML = `
    <h2 class="page-title">设置</h2>
    <div class="card">
      <h3>外观</h3>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="muted">主题：</span>
        <select id="theme-select">
          <option value="dark">深色</option>
          <option value="light">浅色</option>
        </select>
        <span class="muted">即时生效，保存在本浏览器。与顶栏主题按钮等效。</span>
      </div>
    </div>
    <div class="card">
      <h3>QQ 接入（OneBot 11 · SnowLuma 协议端）</h3>
      <div class="warnbox">接入方式：SnowLuma hook 本机 QQNT 客户端（需安装 PC 版 QQ 并登录），桥接为标准 OneBot 11 反向 WS 接入内核。无签名 token、不捆绑 NapCat。</div>
      <div class="kv">
        <span class="k">反向 WS 端点</span><span class="mono">ws://${c.onebot.host}:${c.onebot.port}${c.onebot.reverseWsPath}</span>
        <span class="k">接入配置</span><span class="mono muted">托管模式下自动写入 SnowLuma 的 wsClients，无需手配</span>
        <span class="k">access token</span><span>${c.onebot.hasToken ? '已生成（secrets.json，UI 不明文显示）' : '未生成'}</span>
        <span class="k">降险要点</span><span class="muted">专用小号、独立 IP、第一周风控敏感期掉线属正常、不双开、限速已内置。详见 docs/部署与降险.md</span>
      </div>
    </div>
    <div class="card">
      <h3>SnowLuma 协议端</h3>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer">
          <input type="checkbox" id="snowluma-managed" ${c.onebot.snowluma?.managed ? 'checked' : ''}>
          <span>内嵌托管（推荐）— 内核自动下载并拉起 SnowLuma，反向 WS 自动对接</span>
        </label>
      </div>
      <div id="snowluma-info" class="mono muted" style="margin-bottom:8px"></div>
      <div class="muted" style="margin-bottom:10px">使用前提：本机已安装 PC 版 QQ（QQNT）并保持可登录。QQ 登录在 QQ 客户端窗口完成；SnowLuma 控制台：<span class="mono" id="snowluma-webui"></span></div>
      <div style="display:flex;gap:10px">
        <button class="btn" id="snowluma-restart">重启协议端</button>
        <button class="btn" id="snowluma-open-webui">打开 SnowLuma 控制台</button>
      </div>
    </div>
    <div class="card">
      <h3>风控克制</h3>
      <div class="grid grid-3">
        ${num('replyRatePerMin', '每会话回复上限（条/分钟）', r.replyRatePerMin)}
        ${num('jitterMinMs', '随机抖动下限（毫秒）', r.jitterMinMs)}
        ${num('jitterMaxMs', '随机抖动上限（毫秒）', r.jitterMaxMs)}
      </div>
      <div style="margin-top:10px">
        <span class="muted">群聊唤醒：</span>
        <select id="wake-mode">
          <option value="at_or_reply" ${r.groupWake === 'at_or_reply' ? 'selected' : ''}>仅 @机器人 / 回复机器人（默认）</option>
          <option value="at_reply_or_wakeword" ${r.groupWake === 'at_reply_or_wakeword' ? 'selected' : ''}>@/回复/唤醒词</option>
        </select>
        <span class="muted" style="margin-left:12px">唤醒词（逗号分隔）：</span>
        <input type="text" id="wake-words" value="${r.wakeWords.join(',')}" style="width:260px">
      </div>
      <div style="margin-top:10px">
        <span class="muted">主动推送（每日推送类，默认关闭）：</span>
        <span id="proactive-list" class="mono"></span>
        <div class="muted" style="margin-top:4px">主动消息有风控风险，开启入口在主人手里；UI 与文档均已标注。</div>
      </div>
      <div style="margin-top:10px"><button class="btn primary" id="save-risk">保存</button></div>
    </div>
    <div class="card">
      <h3>好感度</h3>
      <div class="grid grid-3">
        ${num('dailyDeltaCap', '单用户单日变动上限（±）', c.persona.affection.dailyDeltaCap)}
        ${num('minIntervalMs', '更新冷却（毫秒）', c.persona.affection.minIntervalMs)}
        ${num('memoryFactsTopK', '每次注入记忆条数 Top-K', c.persona.memoryFactsTopK)}
      </div>
      <div class="muted" style="margin-top:8px">段位: ${c.persona.affection.stages.map((s) => `${s.min}+ ${s.label}`).join(' · ')}（阈值可在 data/config.json 调整）</div>
      <div style="margin-top:10px"><button class="btn primary" id="save-persona">保存</button></div>
    </div>
  `;

  get('/api/plugins').then((plugins) => {
    const rows = plugins.filter((p) => p.tools.length && p.permissions.includes('schedule') || p.defaultGroupState);
    const proactive = Object.entries(c.risk.proactive ?? {});
    const list = root.querySelector('#proactive-list');
    list.innerHTML = proactive.length
      ? proactive.map(([id, on]) => `<span class="tag ${on ? 'warn' : ''}">${id}: ${on ? '已开启(风控风险)' : '关'}</span>`).join(' ')
      : '（全部关闭）';
  });

  const themeSel = root.querySelector('#theme-select');
  themeSel.value = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  themeSel.onchange = () => {
    document.documentElement.dataset.theme = themeSel.value;
    localStorage.setItem('parallel_theme', themeSel.value);
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = themeSel.value === 'light' ? '深色' : '浅色';
  };

  // SnowLuma 托管状态展示 + 托管开关（勾选即生效：开→立即拉起；关→立即停止）
  const managedChk = root.querySelector('#snowluma-managed');
  const infoEl = root.querySelector('#snowluma-info');
  const webuiEl = root.querySelector('#snowluma-webui');
  const refreshInfo = async () => {
    try {
      const st = await get('/api/login/status');
      const m = st.snowluma;
      if (!m) return;
      webuiEl.textContent = m.webuiUrl;
      if (m.managed) {
        infoEl.innerHTML = m.running
          ? `<span style="color:var(--ok)">运行中</span> pid=${m.pid} · ${m.home}`
          : `未运行 · ${m.home}${m.downloaded === false ? '（首次启动自动下载发行包）' : ''}`;
      } else {
        infoEl.textContent = '托管已关闭（可手动运行 SnowLuma，反向 WS 指向上述端点）';
      }
    } catch { infoEl.textContent = ''; }
  };
  refreshInfo();
  managedChk.onchange = async () => {
    try {
      await post(`/api/login/snowluma/${managedChk.checked ? 'start' : 'stop'}`);
      toast(managedChk.checked ? 'SnowLuma 托管已开启，正在启动…' : 'SnowLuma 托管已关闭', 'ok');
      refreshInfo();
    } catch (e) { toast(e.message, 'err'); managedChk.checked = !managedChk.checked; }
  };
  root.querySelector('#snowluma-restart').onclick = async () => {
    try {
      await post('/api/login/snowluma/restart');
      toast('SnowLuma 重启中', 'ok');
      refreshInfo();
    } catch (e) { toast(e.message, 'err'); }
  };
  root.querySelector('#snowluma-open-webui').onclick = () => {
    window.open(webuiEl.textContent || 'http://127.0.0.1:5099', '_blank');
  };

  root.querySelector('#save-risk').onclick = async () => {
    try {
      await post('/api/config', {
        risk: {
          ...r,
          replyRatePerMin: numVal(root, 'replyRatePerMin'),
          jitterMinMs: numVal(root, 'jitterMinMs'),
          jitterMaxMs: numVal(root, 'jitterMaxMs'),
          groupWake: root.querySelector('#wake-mode').value,
          wakeWords: root.querySelector('#wake-words').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
        },
      });
      toast('已保存', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  root.querySelector('#save-persona').onclick = async () => {
    try {
      await post('/api/config', {
        persona: { affection: { dailyDeltaCap: numVal(root, 'dailyDeltaCap'), minIntervalMs: numVal(root, 'minIntervalMs') }, memoryFactsTopK: numVal(root, 'memoryFactsTopK') },
      });
      toast('已保存', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

function num(k, label, val) {
  return `<div><div class="muted" style="margin-bottom:4px">${label}</div>
    <input type="number" class="cfg-num" data-k="${k}" value="${val}" style="width:100%"></div>`;
}
function numVal(root, k) {
  return Number(root.querySelector(`.cfg-num[data-k="${k}"]`).value);
}
