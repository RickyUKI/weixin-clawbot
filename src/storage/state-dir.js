/**
 * openclaw-weixin-js/src/storage/state-dir.js
 * 状态目录解析 — 与官方 openclaw-weixin 保持一致
 */

import path from "node:path";
import os from "node:os";

export function resolveStateDir() {
  return (
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw")
  );
}

export function resolveWeixinStateDir() {
  return path.join(resolveStateDir(), "weixin-clawbot");
}

export function resolveAccountsDir() {
  return path.join(resolveWeixinStateDir(), "accounts");
}

export function resolveAccountIndexPath() {
  return path.join(resolveWeixinStateDir(), "accounts.json");
}

export function resolveSyncBufPath(accountId) {
  return path.join(resolveAccountsDir(), `${accountId}.sync.json`);
}

export function resolveContextTokensPath(accountId) {
  return path.join(resolveAccountsDir(), `${accountId}.context-tokens.json`);
}
