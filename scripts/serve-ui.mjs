/**
 * 临时验收用内核：只为让浏览器能打开桌面端看设置页，不托管协议端、不连真 QQ。
 *   node --experimental-transform-types --no-warnings scripts/serve-ui.mjs [port]
 * 打印带 token 的 URL 后常驻，Ctrl-C 退出（临时数据目录自动清理）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel/kernel.ts';
import { startApiServer } from '../src/kernel/api/server.ts';
import { MockOneBot } from '../test/helpers/mock-onebot.ts';

const port = Number(process.argv[2] ?? 36080);
const dir = mkdtempSync(join(tmpdir(), 'ui-preview-'));

// 句柄要在任何 await 之前注册：端口被占时 startApiServer 抛的是事件级错误，
// 会绕过 try/finally 直接掀掉进程，临时目录就留在 temp 里了（踩过）。
let cleanupDone = false;
const wipe = () => {
  if (cleanupDone) return;
  cleanupDone = true;
  try {
    writeFileSync(join(dir, 'secrets.json'), Buffer.alloc(4096));
    rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
};
process.on('exit', wipe);
process.on('SIGINT', () => { wipe(); process.exit(0); });
process.on('SIGTERM', () => { wipe(); process.exit(0); });

const kernel = new Kernel({ dataDir: dir, noApi: true });
kernel.config.config.ui.port = port;
kernel.config.config.onebot.port = port + 1;
kernel.config.config.masterIds = ['9000'];
kernel.config.config.humanlike.proactive.enable = true;   // 让主动发言那几项在页面上有内容可看
await kernel.boot();
await startApiServer(kernel);

// 登录门要求协议端在线才放人（真实场景就是 QQ 已登录）。这里挂一个模拟协议端，
// 只为让预览页能进得去 —— 它不连真 QQ。
const mock = new MockOneBot(`ws://127.0.0.1:${port + 1}/onebot`, kernel.config.secrets.onebotAccessToken);
await mock.connect();

console.log('\n=== 预览地址 ===');
console.log(`http://127.0.0.1:${port}/#token=${kernel.config.secrets.uiToken}`);
console.log('================\n');

// 退出清理已在文件顶部注册（必须在任何 await 之前）
