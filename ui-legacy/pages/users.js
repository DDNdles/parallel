import { get, post, fmtDT, toast } from '../api.js';

// 用户管理：列表/好感度/拉黑/主人与管理员名单
export async function renderUsers(root) {
  const data = await get('/api/users');
  root.innerHTML = `
    <h2 class="page-title">用户 <span class="sub">主人 &gt; 群管理员/群主 &gt; 普通用户 三级权限</span></h2>
    <div class="grid grid-2">
      <div class="card">
        <h3>主人名单（config.masterIds）</h3>
        <input type="text" id="masters" value="${data.masterIds.join(',')}" placeholder="QQ 号，逗号分隔" style="width:100%">
        <div class="muted" style="margin:6px 0 10px">主人专属：人设切换、插件安装/重载、全局默认、主动推送开关、报错通知。</div>
        <h3>追加管理员（跨群，config.extraAdminIds）</h3>
        <input type="text" id="admins" value="${data.extraAdminIds.join(',')}" placeholder="QQ 号，逗号分隔" style="width:100%">
        <div class="muted" style="margin:6px 0 10px">群管理员/群主由协议端动态识别，无需在此登记。</div>
        <button class="btn primary" id="save-roles">保存</button>
      </div>
      <div class="card">
        <h3>用户列表（${data.users.length}）</h3>
        <div style="max-height:50vh;overflow-y:auto"><table><tr><th>QQ</th><th>昵称</th><th>好感度</th><th>最近活跃</th><th>状态</th><th></th></tr>
          ${data.users.map((u) => `<tr>
            <td class="mono">${u.userId}${u.isMaster ? ' <span class="tag accent">主人</span>' : u.isAdmin ? ' <span class="tag">管理员</span>' : ''}</td>
            <td>${u.nickname || '-'}</td>
            <td>${u.affection ?? '-'}</td>
            <td class="muted">${fmtDT(u.lastSeen)}</td>
            <td>${u.blocked ? '<span class="tag err">已拉黑</span>' : '<span class="tag ok">正常</span>'}</td>
            <td><button class="btn small ${u.blocked ? '' : 'danger'}" data-block="${u.userId}" data-to="${u.blocked ? '0' : '1'}">${u.blocked ? '解除' : '拉黑'}</button></td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无用户</td></tr>'}
        </table></div>
      </div>
    </div>
  `;
  root.querySelector('#save-roles').onclick = async () => {
    const parse = (s) => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
    try {
      await post('/api/users', { masterIds: parse(root.querySelector('#masters').value), extraAdminIds: parse(root.querySelector('#admins').value) });
      toast('已保存并即时生效', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  root.querySelectorAll('[data-block]').forEach((b) => {
    b.onclick = async () => {
      await post(`/api/users/${b.dataset.block}/block`, { blocked: b.dataset.to === '1' });
      renderUsers(root);
    };
  });
}
