#!/usr/bin/env bash
# ============================================================
#  parallel launcher (macOS / Linux / Git Bash)
#  Usage: ./parallel.sh [--data-dir <dir>] [--port <port>]
# ============================================================
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "[parallel] Node.js not found. Please install Node 24 or newer."
  exit 1
fi
exec node bin/parallel.js "$@"
