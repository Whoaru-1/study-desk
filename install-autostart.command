#!/bin/bash
# 双击运行：把「学习资料工作台」注册为 macOS 登录自启服务
# 成功后：开机自动启动、崩溃自动重启；再次双击会重新加载配置。

LABEL="com.studydesk.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SUPPORT="$HOME/Library/Application Support/StudyDesk"
RUNSH="$SUPPORT/run.sh"
PROJECT="$(cd "$(dirname "$0")" && pwd)"
PORT=4173

echo "=========================================="
echo "  学习资料工作台 · 安装开机自启"
echo "=========================================="
echo

if ! command -v node >/dev/null 2>&1 && [ ! -x /usr/local/bin/node ]; then
  echo "✗ 找不到 Node.js，请先安装：https://nodejs.org"
  read -r -p "按回车关闭…" _; exit 1
fi
NODE_BIN=$(command -v node || echo /usr/local/bin/node)
echo "Node:  $NODE_BIN"
echo "项目:  $PROJECT"
echo

# 1) 启动包装脚本（launchd 对含中文的路径解析不稳，这里用 ASCII 路径中转）
mkdir -p "$SUPPORT"
cat > "$RUNSH" <<SH
#!/bin/bash
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PORT=$PORT
cd "$PROJECT" || exit 1
exec "$NODE_BIN" server.js
SH
chmod +x "$RUNSH"
echo "✓ 启动脚本：$RUNSH"

# 2) LaunchAgent 配置
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$RUNSH</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>StandardOutPath</key><string>$HOME/Library/Logs/studydesk.log</string>
    <key>StandardErrorPath</key><string>$HOME/Library/Logs/studydesk.err.log</string>
</dict>
</plist>
PL
plutil -lint "$PLIST" >/dev/null || { echo "✗ 配置校验失败"; read -r -p "按回车关闭…" _; exit 1; }
echo "✓ 配置文件：$PLIST"

# 3) 释放端口（先停掉手动启动的实例）
PID=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | tail -1 | awk '{print $2}')
if [ -n "$PID" ]; then
  echo "· 停止占用 $PORT 的旧进程 PID=$PID"
  kill "$PID" 2>/dev/null
  sleep 1
fi

# 4) 注册
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  echo "✓ 已注册为登录自启"
elif launchctl load -w "$PLIST" 2>/dev/null; then
  echo "✓ 已注册为登录自启（load 兼容模式）"
else
  echo "✗ 注册失败。请把下面两行的输出发给助手："
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>&1
  read -r -p "按回车关闭…" _; exit 1
fi

# 5) 等它就绪
sleep 2
CODE=$(curl -s -m 4 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
if [ "$CODE" = "200" ]; then
  echo "✓ 服务已就绪：http://127.0.0.1:$PORT"
  open "http://127.0.0.1:$PORT"
else
  echo "⚠ 服务还没响应（HTTP $CODE），看日志："
  echo "   tail -20 ~/Library/Logs/studydesk.err.log"
fi

echo
echo "已生效：重启电脑后会自动在后台运行，无需再管。"
echo "卸载：双击 uninstall-autostart.command"
echo
read -r -p "按回车关闭本窗口（不影响后台服务）…" _
