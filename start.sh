#!/usr/bin/env bash
# MKOnlinePlayer 启动脚本
# 默认监听 [::]:8099（IPv6 + IPv4 双栈），局域网和公网 IPv6 都能访问。
#
# 用法：
#   ./start.sh                    # 默认 8099
#   PORT=9000 ./start.sh          # 换端口
#   HOST=127.0.0.1 ./start.sh     # 只允许本机访问
#   HOST=0.0.0.0 ./start.sh       # 只监听 IPv4
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

PORT="${PORT:-8099}"
HOST="${HOST:-::}"   # :: = IPv6 + IPv4 双栈
export PORT HOST

# 运行环境检查
if ! command -v node >/dev/null 2>&1; then
    echo "错误：找不到 node，请先安装 Node.js。" >&2
    exit 1
fi

if [ ! -d node_modules/@meting/core ]; then
    echo "错误：缺少依赖 @meting/core。" >&2
    echo "请先在 $(pwd) 执行：npm install" >&2
    exit 1
fi

# 端口占用检查
if command -v ss >/dev/null 2>&1; then
    if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}$"; then
        echo "错误：端口 ${PORT} 已被占用。" >&2
        ss -ltnp 2>/dev/null | grep -E "[:.]${PORT}([^0-9]|$)" >&2 || true
        exit 1
    fi
fi

# 获取局域网 IPv4 和公网 IPv6 地址
lan_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "src") { print $(i+1); exit }}')"
if [ -z "$lan_ip" ]; then
    lan_ip="$(hostname -I 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i ~ /^[0-9]+\./) { print $i; exit }}')"
fi
public_v6="$(ip -6 addr show scope global 2>/dev/null | awk '$1 == "inet6" { sub(/\/.*/, "", $2); print $2; exit }')"

echo "=============================================="
echo " MKOnlinePlayer"
if [ "$HOST" = "::" ]; then
    echo " 监听：[::]:${PORT}  (IPv4 + IPv6 双栈)"
elif [[ "$HOST" == *:* ]]; then
    echo " 监听：[${HOST}]:${PORT}"
else
    echo " 监听：${HOST}:${PORT}"
fi
echo "----------------------------------------------"
if [ "$HOST" = "::" ] || [ "$HOST" = "0.0.0.0" ]; then
    echo " 本机访问：   http://127.0.0.1:${PORT}"
    if [ -n "$lan_ip" ]; then
        echo " 局域网访问： http://${lan_ip}:${PORT}"
    fi
    if [ "$HOST" = "::" ] && [ -n "$public_v6" ]; then
        echo " 公网 IPv6：  http://[${public_v6}]:${PORT}"
    fi
elif [ "$HOST" = "127.0.0.1" ]; then
    echo " 本机访问：   http://127.0.0.1:${PORT}"
elif [ "$HOST" = "::1" ]; then
    echo " 本机访问：   http://[::1]:${PORT}"
elif [[ "$HOST" == *:* ]]; then
    echo " 访问地址：   http://[${HOST}]:${PORT}"
else
    echo " 访问地址：   http://${HOST}:${PORT}"
fi
echo "----------------------------------------------"
echo " Ctrl+C 停止"
if [ "$HOST" = "::" ] && [ -n "$public_v6" ]; then
    echo " 提示：公网打不开时，检查光猫/路由器是否放行"
    echo "       IPv6 入站 TCP ${PORT}（本机防火墙当前未拦截）。"
    echo "       公网可访问意味着任何人都能打开播放器，请注意隐私。"
fi
echo "=============================================="
echo

exec node server.mjs
