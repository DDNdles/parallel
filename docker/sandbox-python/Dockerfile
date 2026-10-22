# 状态化 Python 沙箱镜像（报告 10 §4）
# 容器内常驻 ipykernel + loopback HTTP 桥；宿主经 docker exec 驱动，因此容器可保持 --network none。
FROM python:3.12-slim

# 常用数据/图像库（对齐 Kimi OK Computer 的 ipython 沙箱预装）
RUN pip install --no-cache-dir \
      ipykernel jupyter_client \
      numpy pandas matplotlib pillow opencv-python-headless \
      scipy scikit-learn beautifulsoup4 lxml requests tabulate
# 办公文档读写（work 交付常遇到 xlsx/docx/pdf；容器断网，只能预装）
RUN pip install --no-cache-dir openpyxl python-docx pypdf

# 中文与基础工具（文本处理/编码）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /ws
COPY bridge.py /bridge.py
COPY client.py /client.py

# 无出站网络：桥只监听容器内 loopback
EXPOSE 8899
CMD ["python", "/bridge.py"]