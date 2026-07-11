#!/usr/bin/env bash
# XLab Token — hot-reload dev server (Linux / macOS)
set -euo pipefail

cd "$(dirname "$0")"

echo ""
echo " === XLab Token ==="
echo " Dev server + hot reload (tsx watch)"
echo " Platform: $(uname -s) $(uname -m)"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install Node.js 20+ then retry."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm not found. Install Node.js 20+ then retry."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "[ERROR] Node.js 20+ required (found $(node -v))."
  exit 1
fi

echo "[1/2] Installing dependencies..."
if [ ! -d node_modules ]; then
  npm install
else
  echo "      node_modules OK"
fi

if [ ! -d node_modules/tsx ]; then
  echo "      Installing tsx..."
  npm install
fi

PORT="${XLAB_TOKEN_PORT:-3737}"
HOST="${XLAB_TOKEN_HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}"

echo "[2/2] Starting hot-reload server on ${URL}"
echo "      Watching: src/"
echo "      Edit code -> server auto-restarts"
echo "      Press Ctrl+C to stop."
echo ""

# Open browser after a short delay (macOS: open, Linux: xdg-open)
(
  sleep 2
  if command -v open >/dev/null 2>&1; then
    open "${URL}" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${URL}" 2>/dev/null || true
  fi
) &

export XLAB_TOKEN_OPEN=0
npm run serve:watch
