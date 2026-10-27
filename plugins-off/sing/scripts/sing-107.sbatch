#!/bin/bash
#SBATCH --job-name=sing
#SBATCH --partition=Students
#SBATCH --gres=gpu:1
#SBATCH -c 4
#SBATCH --mem=16G
#SBATCH -t 03:58:00
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.err
set -u
ROOT="$HOME/sing"
cd "$ROOT" || exit 1
echo "== JOB $SLURM_JOB_ID START $(date '+%F %T') NODE $(hostname) =="
nvidia-smi -L | head -3
export SING_HOST=0.0.0.0
export SING_PORT=8046
export SING_REF_DIR="$ROOT/ref"
export SING_REF_DEFAULT=dafatyu
export SING_DEVICE=cuda
export SING_API_KEY="${SING_API_KEY:?先 export SING_API_KEY=<与插件 apiKey 一致的随机串>}"   # 密钥只从环境来，不入库
export SING_VOCAL_LANGUAGE=zh
export SING_INFERENCE_STEPS=8
export ACESTEP_ROOT="$ROOT/ace-step"
export ACESTEP_CHECKPOINTS_DIR="$ROOT/checkpoints"
export ACESTEP_CONFIG_PATH=acestep-v15-turbo
export ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-0.6B
export ACESTEP_DOWNLOAD_SOURCE=modelscope
export ACESTEP_QUANTIZATION=none
export ACESTEP_OFFLOAD_TO_CPU=false
export ACESTEP_OFFLOAD_DIT_TO_CPU=false
export HF_ENDPOINT=https://hf-mirror.com
export MODELSCOPE_CACHE="$ROOT/.cache/modelscope"
export TOKENIZERS_PARALLELISM=false
exec "$ROOT/ace-step/.venv/bin/python" "$ROOT/server.py"
