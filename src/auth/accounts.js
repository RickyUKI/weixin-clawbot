/**
 * openclaw-weixin-js/src/auth/accounts.js
 * 账号持久化 + 索引管理
 */

import fs from "node:fs";
import path from "node:path";
import {
  resolveWeixinStateDir,
  resolveAccountsDir,
  resolveAccountIndexPath,
} from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const CHANNEL_ID = "weixin-clawbot";

// ---------------------------------------------------------------------------
// 账号 ID 规范化
// ---------------------------------------------------------------------------

/**
 * 将原始 ilink botId（如 "abc123@im.bot"）转为文件系统安全的 key。
 * 和官方插件一样用 normalizeAccountId 逻辑：@ → - , . → -
 */
export function normalizeAccountId(raw) {
  return raw.trim().replace(/@/g, "-").replace(/\./g, "-");
}

// ---------------------------------------------------------------------------
// 账号索引
// ---------------------------------------------------------------------------

export function listIndexedAccountIds() {
  const p = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(p)) return [];
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

export function registerAccountId(accountId) {
  const dir = resolveWeixinStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const existing = listIndexedAccountIds();
  if (existing.includes(accountId)) return;
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify([...existing, accountId], null, 2), "utf-8");
}

export function unregisterAccountId(accountId) {
  const existing = listIndexedAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// 账号文件 CRUD
// ---------------------------------------------------------------------------

function resolveAccountPath(accountId) {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

export function loadAccountData(accountId) {
  const p = resolveAccountPath(accountId);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { /* ignore */ }
  return null;
}

export function saveAccountData(accountId, update) {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });
  const existing = loadAccountData(accountId) ?? {};
  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId = update.userId !== undefined
    ? (update.userId.trim() || undefined)
    : (existing.userId?.trim() || undefined);
  const data = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };
  const p = resolveAccountPath(accountId);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
  try { fs.chmodSync(p, 0o600); } catch { /* best-effort */ }
}

export function clearAccountData(accountId) {
  const dir = resolveAccountsDir();
  for (const suffix of [".json", ".sync.json", ".context-tokens.json"]) {
    try { fs.unlinkSync(path.join(dir, `${accountId}${suffix}`)); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 解析账号（合并 config + 凭证文件）
// ---------------------------------------------------------------------------

export function listAccountIds(_cfg) {
  return listIndexedAccountIds();
}

export function resolveAccount(cfg, accountId) {
  if (!accountId?.trim()) throw new Error("weixin-js: accountId required");
  const id = normalizeAccountId(accountId);
  const section = cfg?.channels?.[CHANNEL_ID] ?? {};
  const accountCfg = section.accounts?.[id] ?? section ?? {};
  const data = loadAccountData(id);
  const token = data?.token?.trim() || undefined;
  const stateBaseUrl = data?.baseUrl?.trim() || "";
  return {
    accountId: id,
    baseUrl: stateBaseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: accountCfg.cdnBaseUrl?.trim() || CDN_BASE_URL,
    token,
    enabled: accountCfg.enabled !== false,
    configured: Boolean(token),
    name: accountCfg.name?.trim() || undefined,
    userId: data?.userId?.trim() || undefined,
  };
}

// ---------------------------------------------------------------------------
// 触发 channel reload（写 openclaw.json channel key）
// ---------------------------------------------------------------------------

export async function triggerChannelReload() {
  // 不需要主动写配置，登录后用户手动 restart 即可
  // 这里只记录日志，不抛出错误
  logger.info("triggerChannelReload: login complete — restart gateway to activate monitor");
}

// ---------------------------------------------------------------------------
// 清理同一 userId 的旧账号（防止 contextToken 歧义）
// ---------------------------------------------------------------------------

export function clearStaleAccountsForUserId(currentAccountId, userId, onClear) {
  if (!userId) return;
  for (const id of listIndexedAccountIds()) {
    if (id === currentAccountId) continue;
    const data = loadAccountData(id);
    if (data?.userId?.trim() === userId) {
      logger.info(`clearStaleAccountsForUserId: removing stale account=${id}`);
      onClear?.(id);
      clearAccountData(id);
      unregisterAccountId(id);
    }
  }
}
