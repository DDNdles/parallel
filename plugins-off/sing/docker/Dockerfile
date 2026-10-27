# =============================================================================
# 唱歌 TTS 服务镜像：ACE-Step 1.5 + FastAPI /generate 包装
#
# 基础镜像按 2026-10 引擎调研的自建方案：CUDA 12.8 runtime + Ubuntu 22.04，
# Python 3.11（与 ACE-Step 官方 Dockerfile 的 uv sync 口径一致）。
# 国内网络：apt/pip 走清华源，HuggingFace 走 hf-mirror.com，权重默认用
# ModelScope 源在首次启动时自动下载（server.py 调 ensure_lm_model +
# initialize_service(prefer_source=...)）。
#
# ACE-Step 源码默认从 GitHub 克隆；GitHub 不通时用镜像仓库覆盖：
#   docker compose build --build-arg ACESTEP_REPO=<你的镜像地址>
# =============================================================================
FROM nvidia/cuda:12.8.1-runtime-ubuntu22.04

ARG ACESTEP_REPO=https://github.com/ace-step/ACE-Step-1.5.git
ARG ACESTEP_REF=main

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    # 国内加速：HuggingFace 镜像 / apt 与 pip 源
    HF_ENDPOINT=https://hf-mirror.com \
    HF_HOME=/app/.cache/huggingface \
    MODELSCOPE_CACHE=/app/.cache/modelscope \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    TOKENIZERS_PARALLELISM=false \
    # 服务本身
    SING_HOST=0.0.0.0 \
    SING_PORT=8046 \
    SING_REF_DIR=/ref \
    SING_REF_DEFAULT=dafatyu \
    SING_VOCAL_LANGUAGE=zh \
    SING_INFERENCE_STEPS=8 \
    # ACE-Step 模型与 Tier 4 (8-12GB) 显存保护（调研结论）
    ACESTEP_ROOT=/app \
    ACESTEP_CHECKPOINTS_DIR=/app/checkpoints \
    ACESTEP_CONFIG_PATH=acestep-v15-turbo \
    ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-0.6B \
    ACESTEP_LM_BACKEND=vllm \
    ACESTEP_DOWNLOAD_SOURCE=modelscope \
    ACESTEP_QUANTIZATION=int8_weight_only \
    ACESTEP_OFFLOAD_TO_CPU=true \
    ACESTEP_OFFLOAD_DIT_TO_CPU=true \
    PATH=/app/.venv/bin:${PATH}

# 1. 系统依赖：Python 3.11（deadsnakes）、ffmpeg、libsndfile、构建工具
RUN sed -i 's@//.*archive.ubuntu.com@//mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list \
    && sed -i 's@//.*security.ubuntu.com@//mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        software-properties-common \
        build-essential \
        git \
        curl \
        wget \
        ca-certificates \
        libsndfile1 \
        libsndfile1-dev \
        ffmpeg \
        libffi-dev \
        libssl-dev \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-dev \
        python3.11-venv \
    && rm -rf /var/lib/apt/lists/*

# 2. uv 包管理器（从 pip 源装，避免 ghcr.io 在国内不可达）
RUN python3.11 -m ensurepip --upgrade \
    && python3.11 -m pip install --no-cache-dir uv

# 3. ACE-Step 源码 + 锁定的依赖（uv.lock 不存在时退回普通 sync）
WORKDIR /app
RUN git clone --depth 1 --branch "${ACESTEP_REF}" "${ACESTEP_REPO}" /app
RUN uv sync --frozen --no-dev --python python3.11 \
    || uv sync --no-dev --python python3.11

# 4. 包装代码（fastapi / uvicorn 已在 ACE-Step 的 pyproject 依赖里，不额外改动锁）
COPY server.py /app/server.py

# 5. 权重与输出目录：compose 把 /app/checkpoints 和 /app/.cache 挂成命名卷，
#    重建镜像不会重复下载权重。
RUN mkdir -p /app/checkpoints /app/output /ref
VOLUME ["/app/checkpoints", "/app/.cache"]

EXPOSE 8046

HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${SING_PORT:-8046}/health" || exit 1

# 单进程：服务内部用锁保证同一时刻只跑一个生成（单 GPU）。
CMD ["python", "/app/server.py"]
