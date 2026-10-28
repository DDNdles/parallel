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

# LaTeX 排版链（2026-10-28）：work 交付常要 PDF。以前任务得现下 tectonic 和中文字体
# （有一次为此空转一百多轮），这里直接内置：xelatex + ctex/xeCJK 管中文，
# latex-extra 补齐 titlesec/parskip/enumitem 这类常用宏包，pictures 带 tikz 画图，
# science 补 siunitx/mhchem 这类理工科宏包，Noto CJK 作中文字体，latexmk 负责多遍编译。
# poppler-utils 给 pdftotext/pdftoppm：生成后自己抽查一遍（也能给 work 读现成 PDF）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-xetex texlive-lang-chinese texlive-latex-recommended texlive-latex-extra \
      texlive-pictures texlive-science texlive-fonts-recommended latexmk fontconfig fonts-noto-cjk \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && xelatex --version | head -2 \
    && kpsewhich ctex.sty xeCJK.sty fontspec.sty titlesec.sty parskip.sty tikz.sty siunitx.sty

# Node.js：一次性 JS 与 bash 里调 node 用（官方二进制包按架构取，装进 /usr/local）
ARG NODE_VERSION=24.22.1
RUN set -eu; \
      arch=$(case "$(uname -m)" in x86_64) echo x64;; aarch64) echo arm64;; *) uname -m;; esac); \
      curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.gz" \
        | tar -xz -C /usr/local --strip-components=1; \
      node --version && npm --version

# 常见前端构建工具预装全局（2026-10-25）：work 任务反复要用，装一次省得每个任务 npm install；
# 没预装到的包走 npm 共享缓存卷（下载读本地缓存），install 也是秒级
RUN npm install -g --no-fund --no-audit vite typescript esbuild && npm cache clean --force 2>/dev/null || true

WORKDIR /ws
COPY bridge.py /bridge.py
COPY client.py /client.py

# 桥只监听容器内 loopback（控制通道走 docker exec，不映射端口）
EXPOSE 8899
CMD ["python", "/bridge.py"]
