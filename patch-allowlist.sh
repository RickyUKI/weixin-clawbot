#!/bin/bash
# patch-allowlist.sh
# 将 weixin-clawbot 加入 OpenClaw 内网版的 ALLOWED_CHANNELS 白名单
# 每次升级 OpenClaw 后重新运行此脚本，然后重启 Gateway

set -e

# 自动探测 openclaw dist 目录（兼容 nvm 和全局安装）
OPENCLAW_DIST=$(node -e "
  const paths = [
    '/usr/local/lib/.nvm/versions/node/v22.17.0/lib/node_modules',
    '/usr/local/lib/node_modules',
    process.env.NODE_PATH
  ].filter(Boolean);
  try {
    const p = require.resolve('openclaw/package.json', { paths });
    console.log(require('path').join(require('path').dirname(p), 'dist'));
  } catch(e) {
    // fallback: 直接从 which openclaw 找
    const { execSync } = require('child_process');
    try {
      const bin = execSync('which openclaw', { encoding: 'utf8' }).trim();
      const real = execSync('readlink -f ' + bin, { encoding: 'utf8' }).trim();
      const dir = require('path').dirname(require('path').dirname(real));
      console.log(require('path').join(dir, 'dist'));
    } catch(e2) {
      console.log('');
    }
  }
" 2>/dev/null)

if [ -z "$OPENCLAW_DIST" ] || [ ! -d "$OPENCLAW_DIST" ]; then
  echo "❌ Could not locate openclaw dist directory."
  echo "   Please manually set OPENCLAW_DIST and re-run:"
  echo "   OPENCLAW_DIST=/path/to/openclaw/dist bash patch-allowlist.sh"
  exit 1
fi

echo "📂 openclaw dist: $OPENCLAW_DIST"

CHANNEL_ID="weixin-clawbot"
PATCHED=0

for FILE in "$OPENCLAW_DIST"/gateway-cli-*.js; do
  [ -f "$FILE" ] || continue

  # 已经包含 weixin-clawbot，跳过
  if grep -q "\"$CHANNEL_ID\"" "$FILE"; then
    echo "ℹ️  Already patched: $(basename $FILE)"
    PATCHED=$((PATCHED + 1))
    continue
  fi

  # 匹配各种可能的 ALLOWED_CHANNELS Set 内容，在末尾 ]) 前插入
  # 使用 perl 做更鲁棒的替换（支持列表末尾有无 openclaw-weixin）
  if grep -q "ALLOWED_CHANNELS = new Set(" "$FILE"; then
    perl -i -pe 's/(ALLOWED_CHANNELS = new Set\(\[.*?)"(\])/$1, "weixin-clawbot"$2/ if /ALLOWED_CHANNELS = new Set/' "$FILE"
    if grep -q "\"$CHANNEL_ID\"" "$FILE"; then
      echo "✅ Patched: $(basename $FILE)"
      PATCHED=$((PATCHED + 1))
    else
      echo "⚠️  Pattern found but patch may have failed: $(basename $FILE)"
      echo "   Please patch manually: add \"weixin-clawbot\" to ALLOWED_CHANNELS in $FILE"
    fi
  fi
done

if [ "$PATCHED" -eq 0 ]; then
  echo "❌ No gateway-cli files found or ALLOWED_CHANNELS pattern not matched."
  echo "   Check: ls $OPENCLAW_DIST/gateway-cli-*.js"
  exit 1
fi

echo ""
echo "✅ Done. Restart Gateway to apply:"
echo "   openclaw gateway restart"
