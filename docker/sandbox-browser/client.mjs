/**
 * 宿主侧客户端：容器内经 docker exec 运行，向容器内 loopback 桥转发一条动作。
 *
 * stdin: {"action":"goto","args":{"url":"..."}}
 * stdout: 桥返回的 JSON（原样透传）
 */
import http from 'node:http';

const PORT = Number(process.env.BRIDGE_PORT || 8900);

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: `非法请求: ${e.message}` }));
    return;
  }
  const body = JSON.stringify(payload);
  const req = http.request({
    host: '127.0.0.1',
    port: PORT,
    path: '/action',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    timeout: Number(payload.timeout || 60000) + 15000,
  }, (res) => {
    let out = '';
    res.setEncoding('utf-8');
    res.on('data', (c) => { out += c; });
    res.on('end', () => process.stdout.write(out));
  });
  req.on('error', (e) => {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `浏览器桥不可达（容器可能已退出，重试会自动重启）：${e.message}`,
    }));
  });
  req.on('timeout', () => {
    req.destroy();
    process.stdout.write(JSON.stringify({ ok: false, error: '浏览器操作超时' }));
  });
  req.end(body);
});