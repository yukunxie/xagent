#!/usr/bin/env bash
# 启动 opencode-bridge 并打开 agent.html
# 用法: ./agent.sh [项目目录] [WebSocket 端口]

set -e
DIR="${1:-$(pwd)}"
PORT="${2:-9001}"

cd "$(dirname "$0")/opencode-bridge"

if [ ! -d node_modules ]; then
  echo "[bridge] 安装依赖..."
  npm install
fi

echo "[bridge] 启动 opencode-bridge，工作目录: $DIR，端口: $PORT"
node --experimental-strip-types src/index.ts --dir "$DIR" --port "$PORT"
