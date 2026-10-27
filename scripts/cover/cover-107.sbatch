#!/bin/bash
#SBATCH --job-name=cover
#SBATCH --partition=Students
#SBATCH --gres=gpu:1
#SBATCH -c 4
#SBATCH --mem=16G
#SBATCH -t 03:58:00
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.err
set -u

# 手动兜底入口：平时由 parallel 的 cover supervisor 经平台 API 自动提交（scripts/cover/ustc-watch.mjs），
# 不需要这个文件。平台作业最长 4 小时，Students 队列可能要排很久。
#
# 首次部署见 docker/cover/README.md；之后所有依赖/模型都留在 $HOME/cover 下，不需要每次重装。
# API Key 不进仓库：把服务端 key 写到 $HOME/cover/.api-key（chmod 600），或提交前 export COVER_API_KEY。

ROOT="${COVER_ROOT:-$HOME/cover}"
if [ -z "${COVER_API_KEY:-}" ] && [ -f "$ROOT/.api-key" ]; then
  export COVER_API_KEY="$(cat "$ROOT/.api-key")"
fi

echo "== COVER JOB ${SLURM_JOB_ID:-?} START $(date -Is)"
nvidia-smi -L | head -3
export COVER_ROOT="$ROOT"
export COVER_PORT="${COVER_PORT:-8047}"
export PATH="$ROOT/bin:$PATH"
exec "$ROOT/svc-venv/bin/python" "$ROOT/server.py"
