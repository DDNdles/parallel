# 状态化 Python 沙箱镜像（报告 10 §4）
# 容器内常驻 ipykernel + loopback HTTP 桥；宿主经 docker exec 驱动，桥只监听 loopback。
# 2026-10-24 起 work 档容器联网（chat 档仍 --network none），镜像预装 Node.js。
FROM python:3.12-slim

# 常用数据/图像库（对齐 Kimi OK Computer 的 ipython 沙箱预装；
# 运行时虽有网可 pip install，预装仍省时间、结果可复现）
RUN pip install --no-cache-dir \
      ipykernel jupyter_client \
      numpy pandas matplotlib pillow opencv-python-headless \
      scipy scikit-learn beautifulsoup4 lxml requests tabulate
# 办公文档读写（work 交付常遇到 xlsx/docx/pdf）
RUN pip install --no-cache-dir openpyxl python-docx pypdf

# 中文与基础工具（文本处理/编码）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Node.js：一次性 JS 与 bash 里调 node 用（官方二进制包按架构取，装进 /usr/local）
ARG NODE_VERSION=24.22.1
RUN set -eu; \
      arch=$(case "$(uname -m)" in x86_64) echo x64;; aarch64) echo arm64;; *) uname -m;; esac); \
      curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.gz" \
        | tar -xz -C /usr/local --strip-components=1; \
      node --version && npm --version

WORKDIR /ws
COPY bridge.py /bridge.py
COPY client.py /client.py

# 桥只监听容器内 loopback（控制通道走 docker exec，不映射端口）
EXPOSE 8899
CMD ["python", "/bridge.py"]
