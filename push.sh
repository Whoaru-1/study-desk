#!/bin/bash
# 推送 main 到 GitHub。
# 本机 DNS 偶尔解析不了 github.com / ssh.github.com（NXDOMAIN），
# 此时自动改用 GitHub 已知 IP 直连，无需手动改 ssh 配置。

cd "$(dirname "$0")" || exit 1

echo "→ 尝试常规推送…"
if git push origin main; then
  echo "✓ 已推送"
  exit 0
fi

echo
echo "常规推送失败（多为 DNS 解析问题），改用 IP 直连…"
for ip in 20.205.243.160 20.27.177.113 140.82.112.4; do
  printf '  %s:443 … ' "$ip"
  if git -c core.sshCommand="ssh -o HostName=$ip -o Port=443 -o User=git \
      -o IdentityFile=$HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
      push origin main > /tmp/gh-push.log 2>&1; then
    echo "✓ 已推送"
    exit 0
  fi
  echo "失败"
done

echo
echo "✗ 所有地址都失败。最后一条错误："
tail -3 /tmp/gh-push.log
echo
echo "排查：1) 能否上网  2) ssh key 是否有效  3) 是否需要代理"
exit 1
