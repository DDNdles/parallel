'use client';
/**
 * 登录门：账号卡（已登录/有历史账号）→ 进入控制台。
 *
 * parallel 只用 QQNT 有头模式，**登录不发生在网页上**：内核把 PMHQ + 本机 QQ 客户端拉起，
 * 登录在该 QQ 里完成。所以这里没有扫码、没有输密码——QQ 不在线时那颗按钮就是「打开 QQNT」，
 * 点一下让内核把协议端重拉一遍（把 QQ 窗口开起来）；在线后同一个位置变成「进入控制台」。
 *
 * token 免输入：内核启动自动打开浏览器带 #token=<uiToken>，此处接收后清 URL。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, setToken, getToken } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { BrandInput } from '@/components/BrandInput';
import type { AppState } from '@/components/App';

const AUTO_KEY = 'parallel_auto_login';

interface LoginStatus {
  connected: boolean;
  qq: string;
  nickname: string;
  avatar: string;
  lastLogin?: { qq: string; nickname: string; ts: number } | null;
  /** 预期 bot 账号 + 账号守卫结果（登录号与它不符时内核已停止代发） */
  expectedQq?: string;
  accountBlocked?: { got: string; expected: string };
  /** 当前托管协议端（LLBot / NapCat）与其登录态守护字段（reports/12、reports/13） */
  protocol?: 'llbot' | 'napcat';
  end?: {
    running: boolean; webuiUrl: string; downloaded: boolean; hasToken?: boolean; error?: string;
    mode?: 'pmhq' | 'direct'; qqProfile?: string; expectedQq?: string;
    online?: boolean; uin?: string; deviceId?: string;
    lastDrop?: { desc: string; at: number } | null;
    kickCode?: number; kickDesc?: string; kicksInWindow?: number;
    savedSessions?: string[]; recoveredAt?: number;
  };
}

export default function LoginGate({ onEnter, onToggleTheme }: {
  onEnter: () => void;
  state: AppState | null;
  refreshStatus: () => Promise<void>;
  onToggleTheme: () => void;
}) {
  const [info, setInfo] = useState<LoginStatus | null>(null);
  const [stateMsg, setStateMsg] = useState('');
  const [stateCls, setStateCls] = useState('');
  const [opening, setOpening] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const timers = useRef<ReturnType<typeof setInterval | typeof setTimeout>[]>([]);
  const enteredRef = useRef(false);

  const clearTimers = () => { timers.current.forEach(clearInterval); timers.current.forEach(clearTimeout); timers.current = []; };

  const commitEnter = useCallback(() => {
    if (enteredRef.current) return;
    enteredRef.current = true;
    clearTimers();
    onEnter();
  }, [onEnter]);

  // 接收 #token（内核启动自动打开浏览器）
  useEffect(() => {
    const m = location.hash.match(/^#token=([0-9a-f]+)$/i);
    if (m) { setToken(m[1]); history.replaceState(null, '', location.pathname + location.search); }
  }, []);

  const bindAuto = () => {
    const el = document.getElementById('login-auto-chk') as HTMLInputElement | null;
    if (!el) return;
    el.checked = localStorage.getItem(AUTO_KEY) === '1';
    el.onchange = () => {
      if (el.checked) localStorage.setItem(AUTO_KEY, '1');
      else localStorage.removeItem(AUTO_KEY);
    };
  };

  // 路由：token 有效性 → 登录状态。
  // 可靠性红线：/api/state 或 /api/login/status 一次失败（内核繁忙、网络抖动、休眠唤醒）
  // 不代表未登录——指数退避重试；确认可用后仍持续轮询，把状态漂移拉回来。
  useEffect(() => {
    let alive = true;
    let attempt = 0;

    const route = async (st: LoginStatus) => {
      setInfo(st);
      bindAuto();
      if (st.connected || st.qq) {
        if (st.connected && localStorage.getItem(AUTO_KEY) === '1') {
          setStateMsg('QQ 已登录，1 秒后自动进入…');
          setStateCls('ok');
          timers.current.push(setTimeout(() => {
            if (localStorage.getItem(AUTO_KEY) === '1') commitEnter();
          }, 1000));
        }
      }
    };

    const probe = async () => {
      const waitMs = Math.min(500 * 2 ** attempt, 5000); // 0.5s 起步，封顶 5s
      try {
        await get('/api/state');
        const st: LoginStatus = await get('/api/login/status');
        if (!alive) return;
        attempt = 0;
        await route(st);
      } catch (e) {
        if (!alive) return;
        attempt++;
        // 401 = 本地 token 与内核不一致（旧 token 残留/内核重装）：提示粘贴新令牌；
        // 其他错误（超时/网络抖动/内核繁忙）只重试，绝不据此判定"未登录"。
        const msg = (e as Error)?.message ?? '';
        if (msg.includes('unauthorized') || msg.includes('401')) {
          setStateMsg('浏览器令牌与内核不匹配：把内核启动日志里 #token= 后的值粘贴到下面');
          setStateCls('err');
          return;
        }
        timers.current.push(setTimeout(() => { if (alive) probe(); }, waitMs));
      }
    };
    probe();

    // 守护轮询：每 4s 重探一次（QQ 拉起过程中状态会变，按钮自动从"打开 QQNT"换成"进入控制台"）
    timers.current.push(setInterval(() => { if (!alive) return; attempt = 0; probe(); }, 4000));

    return () => { alive = false; clearTimers(); };
  }, [commitEnter]);

  /** 打开 QQNT：让内核把协议端（PMHQ + 本机 QQ 客户端）重拉一遍——登录就发生在那个 QQ 里 */
  const openQqnt = async () => {
    setOpening(true);
    setStateMsg('正在打开 QQNT…');
    setStateCls('');
    try {
      await post('/api/login/end/restart', {});
    } catch (e) {
      setStateMsg(`打开失败：${(e as Error).message}`);
      setStateCls('err');
    } finally {
      setOpening(false);
    }
  };

  // 应用粘贴的令牌（校验 32 位十六进制）
  const applyToken = () => {
    const v = tokenDraft.trim();
    if (!/^[0-9a-f]{32}$/i.test(v)) {
      setStateMsg('令牌格式不对：应为内核日志 #token= 后的 32 位十六进制');
      setStateCls('err');
      return;
    }
    if (v !== getToken()) setToken(v);
    setStateMsg('令牌已更新，正在重新校验…');
    setStateCls('ok');
    location.reload();
  };

  const avatar = info?.qq ? `/api/login/avatar/${encodeURIComponent(info.qq)}?token=${encodeURIComponent(getToken())}` : '';

  // 掉线/登错号提示：登录门「突然弹出来」时必须说清原因 ——
  // 2026-09 起腾讯会周期性把纯协议会话判失效（LLBot 官方 issue #857）；有头模式下还可能撞上
  // 「本机 QQ 登的是别的号」（内核已停止代发，见 adapter 账号守卫）。原因经 /api/login/status 带上来。
  const blocked = info?.accountBlocked;
  const dropNotice = (() => {
    if (blocked) {
      return `协议端登录的是 ${blocked.got}，与预期 bot 账号 ${blocked.expected} 不一致：已停止代发。请在本机 QQ 里换成 ${blocked.expected} 登录。`;
    }
    const m = info?.end;
    if (!m || m.online) return '';
    const drop = m.lastDrop;
    if (drop && Date.now() - drop.at < 30 * 60_000) return `账号已下线：${drop.desc}`;
    if (m.kickDesc) return `账号已离线：${m.kickDesc}`;
    return '';
  })();
  const online = !!(info?.connected);
  const statusLine = blocked
    ? dropNotice
    : (stateMsg || dropNotice || (online ? 'QQ 已登录，协议端在线' : (info ? 'QQ 未在线' : '正在读取状态…')));

  return (
    <div className="login-overlay">
      <div className="login-box">
        <div className="login-brand">
          <Icon name="brand" size={14} />
          <span className="wm"><b>PARALLEL</b></span> console
        </div>

        <img id="login-avatar" className="login-avatar" alt="QQ 头像" src={avatar} />
        <div className="login-nick">{info?.nickname || (info?.qq ? `QQ ${info.qq}` : '等待 QQ 登录')}</div>
        <div className="login-qq mono">{info?.qq ? `QQ ${info.qq}` : '--'}</div>
        <div id="login-state" className={'login-state ' + (blocked || (dropNotice && !stateMsg) ? 'err' : stateCls)}>{statusLine}</div>

        {/* 主按钮：QQ 不在线时就是"打开 QQNT"，在线后变成"进入控制台" */}
        {online ? (
          <button id="login-enter" className="login-btn" onClick={commitEnter}>进入控制台</button>
        ) : (
          <button id="login-qqnt" className="login-btn" disabled={opening} onClick={openQqnt}>
            {opening ? '正在打开…' : '打开 QQNT'}
          </button>
        )}

        <label className="login-auto"><input type="checkbox" id="login-auto-chk" /><span>自动登录，下次直接进入</span></label>

        {/* 浏览器 token 与内核不一致时的免扫码恢复入口（32 位十六进制；回车或点击「应用」生效） */}
        <div className="login-token-row">
          <BrandInput value={tokenDraft} className="mono" spellCheck={false}
            placeholder="或粘贴内核日志里 #token= 后的值（32 位）"
            onChange={(e) => setTokenDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyToken(); }} />
          <button className="login-ghost" onClick={applyToken}>应用令牌</button>
        </div>

        <div style={{ marginTop: 18 }}>
          <button className="chip icon-chip" onClick={onToggleTheme}>
            <span className="theme-btn-ic">
              <span className="glyph glyph-sun"><Icon name="sun" /></span>
              <span className="glyph glyph-moon"><Icon name="moon" /></span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
