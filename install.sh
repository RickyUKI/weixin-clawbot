#!/bin/bash
# install.sh — weixin-clawbot 一键安装脚本
# 用法：bash install.sh
# 可选：PLUGIN_DIR=/custom/path bash install.sh

set -e

PLUGIN_DIR="${PLUGIN_DIR:-$HOME/.openclaw/extensions/weixin-clawbot}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================"
echo "  weixin-clawbot 安装向导"
echo "========================================"
echo ""

# 1. 复制插件文件
echo "📦 安装插件到: $PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"
cp -r "$SCRIPT_DIR"/. "$PLUGIN_DIR"/
echo "✅ 插件文件复制完成"
echo ""

# 2. 写入 openclaw config
echo "⚙️  注册插件到 openclaw 配置..."
if command -v openclaw &>/dev/null; then
  # 检查是否已注册
  if openclaw config get plugins.local 2>/dev/null | grep -q "weixin-clawbot"; then
    echo "ℹ️  插件已在配置中，跳过"
  else
    openclaw config set "plugins.local[]" "$PLUGIN_DIR" 2>/dev/null && \
      echo "✅ 已添加到 plugins.local" || \
      echo "⚠️  自动写入失败，请手动在 openclaw.json 中添加："
      echo "     { \"plugins\": { \"local\": [\"$PLUGIN_DIR\"] } }"
  fi
else
  echo "⚠️  openclaw 命令未找到，请手动在 openclaw.json 中添加："
  echo "     { \"plugins\": { \"local\": [\"$PLUGIN_DIR\"] } }"
fi
echo ""

# 3. Patch ALLOWED_CHANNELS
echo "🔧 修补 ALLOWED_CHANNELS 白名单..."
bash "$PLUGIN_DIR/patch-allowlist.sh"
echo ""

# 4. 重启
echo "🔄 重启 Gateway..."
if command -v openclaw &>/dev/null; then
  openclaw gateway restart && echo "✅ Gateway 已重启" || echo "⚠️  请手动运行: openclaw gateway restart"
else
  echo "⚠️  请手动运行: openclaw gateway restart"
fi

echo ""
echo "========================================"
echo "  安装完成！"
echo "  登录微信: openclaw channels login --channel weixin-clawbot"
echo "========================================"
