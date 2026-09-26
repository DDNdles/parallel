# 浏览器沙箱镜像（报告 10 §5）
# 用途：给 work 子代理一个「有网的浏览器」——与计算沙箱（--network none）分离，正是 Kimi 的双沙箱结构。
# 基线镜像自带 Chromium 与全部系统依赖；本层只补桥接脚本与 playwright npm 包。
ARG PLAYWRIGHT_VERSION=1.63.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy

# 桥脚本放在 /opt/bridge，并在同目录本地安装 playwright ——
# ESM 的模块解析不认 NODE_PATH，必须让 node_modules 位于脚本可上溯的目录。
WORKDIR /opt/bridge
RUN npm init -y >/dev/null 2>&1 && npm install --save-exact playwright@${PLAYWRIGHT_VERSION} --no-fund --no-audit
COPY bridge.mjs /opt/bridge/bridge.mjs
COPY client.mjs /opt/bridge/client.mjs
RUN node -e "import('playwright').then(m=>{if(!m.chromium)process.exit(1);console.log('playwright module ok')})"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV BRIDGE_PORT=8900
EXPOSE 8900
WORKDIR /ws
CMD ["sh", "-c", "cd /ws && node /opt/bridge/bridge.mjs"]