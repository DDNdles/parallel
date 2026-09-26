"""状态化 Python 沙箱桥（容器内常驻）。

职责：持有一个长期存活的 ipykernel，通过容器内 loopback HTTP 暴露执行接口。
宿主侧用 `docker exec ... python /client.py` 访问它 —— 桥只监听 127.0.0.1，
所以容器可以用 --network none 启动，Python 代码没有任何出网路径。

变量/导入在多次执行之间保留（这正是与「每次 docker run --rm」的核心差别）。
"""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from jupyter_client import KernelManager

HOST = "127.0.0.1"
PORT = int(os.environ.get("BRIDGE_PORT", "8899"))
IDLE_EXIT_SEC = int(os.environ.get("BRIDGE_IDLE_EXIT_SEC", "1800"))  # 空闲自杀（容器随之退出）
MAX_OUTPUT = int(os.environ.get("BRIDGE_MAX_OUTPUT", "200000"))

_lock = threading.Lock()
_km: KernelManager | None = None
_kc = None
_last_use = time.time()
_running = {"execution_count": 0}


def ensure_kernel():
    """惰性启动 ipykernel（cwd=/ws，变量持久）。"""
    global _km, _kc
    if _km is not None and _km.is_alive():
        return _km, _kc
    km = KernelManager(kernel_name="python3")
    km.start_kernel(cwd="/ws", env={**os.environ, "PYTHONUNBUFFERED": "1", "MPLBACKEND": "Agg"})
    kc = km.client()
    kc.start_channels()
    try:
        kc.wait_for_ready(timeout=60)
    except Exception as e:  # 启动失败要让宿主看到原因
        raise RuntimeError(f"kernel 启动失败: {e}") from e
    _km, _kc = km, kc
    return km, kc


def restart_kernel() -> None:
    global _km, _kc
    if _km is not None:
        try:
            _km.shutdown_kernel(now=True)
        except Exception:
            pass
    _km = _kc = None


def run_code(code: str, timeout: int) -> dict:
    """在同一 kernel 内执行；返回 stdout/结果/错误（变量保留在 kernel 命名空间）。"""
    with _lock:
        km, kc = ensure_kernel()
        msg_id = kc.execute(code, store_history=True)
        outputs: list[dict] = []
        status = "ok"
        deadline = time.time() + max(1, timeout)
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                status = "timeout"
                break
            try:
                msg = kc.get_iopub_msg(timeout=min(remaining, 1.0))
            except queue.Empty:
                continue
            except Exception as e:
                status = "error"
                outputs.append({"type": "error", "name": type(e).__name__, "text": str(e)})
                break
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            mtype = msg.get("msg_type")
            content = msg.get("content", {})
            if mtype == "stream":
                outputs.append({"type": "stream", "name": content.get("name", "stdout"), "text": content.get("text", "")})
            elif mtype in ("execute_result", "display_data"):
                data = content.get("data", {})
                item = {"type": mtype, "text": data.get("text/plain", "")}
                if "image/png" in data:
                    item["image"] = data["image/png"]
                outputs.append(item)
            elif mtype == "error":
                status = "error"
                outputs.append({
                    "type": "error",
                    "name": content.get("ename", "Error"),
                    "text": "\n".join(content.get("traceback", []) or [content.get("evalue", "")]),
                })
            elif mtype == "status" and content.get("execution_state") == "idle":
                break
        # 汇总输出长度上限，防撑爆宿主
        total = 0
        trimmed: list[dict] = []
        for o in outputs:
            text = o.get("text", "") or ""
            if total + len(text) > MAX_OUTPUT:
                o = {**o, "text": text[: max(0, MAX_OUTPUT - total)] + "\n…(输出超限截断)"}
            total += len(o.get("text", "") or "")
            trimmed.append(o)
        _running["execution_count"] += 1
        # 内核 PID：新版 jupyter_client 用 provisioner（旧版有 km.kernel）
        kernel_pid = None
        try:
            kernel_pid = getattr(getattr(km, "provisioner", None), "pid", None)
        except Exception:
            pass
        return {
            "status": status,
            "outputs": trimmed,
            "execution_count": _running["execution_count"],
            "kernel_pid": kernel_pid,
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静默
        pass

    def _send(self, obj: dict, code: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global _last_use
        _last_use = time.time()
        if self.path == "/health":
            return self._send({"ok": True, "kernel_alive": bool(_km and _km.is_alive()), "executions": _running["execution_count"]})
        return self._send({"error": "not found"}, 404)

    def do_POST(self):
        global _last_use
        _last_use = time.time()
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            return self._send({"error": f"bad request: {e}"}, 400)

        if self.path == "/exec":
            code = str(payload.get("code", ""))
            timeout = int(payload.get("timeout", 60))
            if payload.get("restart"):
                restart_kernel()
            try:
                return self._send(run_code(code, timeout))
            except Exception as e:
                return self._send({"status": "error", "outputs": [{"type": "error", "name": type(e).__name__, "text": str(e)}]}, 500)
        if self.path == "/reset":
            restart_kernel()
            return self._send({"ok": True, "restarted": True})
        return self._send({"error": "not found"}, 404)


def idle_watchdog(server: ThreadingHTTPServer) -> None:
    """空闲超时自杀：容器随之退出，由宿主在下次使用时重新拉起。"""
    while True:
        time.sleep(30)
        if time.time() - _last_use > IDLE_EXIT_SEC:
            try:
                server.shutdown()
            finally:
                os._exit(0)


def main() -> None:
    # 工作目录必须存在（宿主挂载 /ws）
    os.makedirs("/ws", exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=idle_watchdog, args=(server,), daemon=True).start()
    print(json.dumps({"bridge": "ready", "host": HOST, "port": PORT}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()