#!/bin/bash
# 双击即可启动本地预览（macOS）
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-4173}"

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js，请先安装：https://nodejs.org"
  read -r -p "按回车关闭…" _
  exit 1
fi

( sleep 1; open "http://127.0.0.1:${PORT}" ) &
PORT="$PORT" node server.js
