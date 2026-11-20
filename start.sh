#!/usr/bin/env bash
# MKOnlinePlayer 启动脚本
# 用法：./start.sh               默认 8888
#      PORT=9000 ./start.sh      换端口
#      HOST=127.0.0.1 ./start.sh 换监听地址
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

export PORT="${PORT:-8888}"
export HOST="${HOST:-::}"

exec node server.mjs
