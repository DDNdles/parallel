"""宿主侧客户端：在容器内经 docker exec 运行，向容器内 loopback 桥发一条执行请求。

stdin: {"code": "...", "timeout": 60, "restart": false}
stdout: 桥返回的 JSON（原样透传）
"""
from __future__ import annotations

import json
import sys
import urllib.request

PORT = 8899


def main() -> None:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except Exception as e:
        print(json.dumps({"status": "error", "outputs": [{"type": "error", "name": "BadRequest", "text": f"非法请求: {e}"}]}))
        return
    path = "/reset" if payload.get("reset") else "/exec"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=int(payload.get("timeout", 60)) + 15) as resp:
            sys.stdout.write(resp.read().decode("utf-8", "replace"))
    except Exception as e:
        print(json.dumps({
            "status": "error",
            "outputs": [{"type": "error", "name": type(e).__name__, "text": f"桥不可达（内核可能已退出，重试会自动重启）：{e}"}],
        }))


if __name__ == "__main__":
    main()