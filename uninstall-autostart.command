#!/bin/bash
# 双击运行：取消「学习资料工作台」的登录自启

LABEL="com.studydesk.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT=4173

echo "=========================================="
echo "  学习资料工作台 · 取消开机自启"
echo "=========================================="

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null

if launchctl list | grep -q "$LABEL"; then
  echo "✗ 取消失败，服务仍在运行"
else
  echo "✓ 已取消自启（配置文件保留，可重新安装）"
fi

PID=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | tail -1 | awk '{print $2}')
if [ -n "$PID" ]; then
  echo "· 停止当前实例 PID=$PID"
  kill "$PID" 2>/dev/null
fi

echo
echo "以后需要用时，双击 start.command 手动启动。"
echo
read -r -p "按回车关闭…" _
