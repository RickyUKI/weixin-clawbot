/**
 * openclaw-weixin-js/src/messaging/context-tokens.js
 * 为每个 (accountId, userId) 对保存 contextToken（下行发消息用）
 */

import fs from "node:fs";
import path from "node:path";
import { resolveAccountsDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

/** 内存缓存：accountId → Map<userId, contextToken> */
const cache = new Map();

function resolveCtxPath(accountId) {
  return path.join(resolveAccountsDir(), `${accountId}.context-tokens.json`);
}

export function restoreContextTokens(accountId) {
  try {
    const p = resolveCtxPath(accountId);
    if (!fs.existsSync(p)) return;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    const map = new Map(Object.entries(data));
    cache.set(accountId, map);
    logger.debug(`restoreContextTokens: accountId=${accountId} entries=${map.size}`);
  } catch (err) {
    logger.warn(`restoreContextTokens: ${String(err)}`);
  }
}

export function setContextToken(accountId, userId, contextToken) {
  if (!userId || !contextToken) return;
  let map = cache.get(accountId);
  if (!map) { map = new Map(); cache.set(accountId, map); }
  map.set(userId, contextToken);
  try {
    fs.mkdirSync(resolveAccountsDir(), { recursive: true });
    fs.writeFileSync(resolveCtxPath(accountId), JSON.stringify(Object.fromEntries(map), null, 2), "utf-8");
  } catch { /* best-effort */ }
}

export function getContextToken(accountId, userId) {
  return cache.get(accountId)?.get(userId) ?? undefined;
}

export function clearContextTokensForAccount(accountId) {
  cache.delete(accountId);
  try { fs.unlinkSync(resolveCtxPath(accountId)); } catch { /* ignore */ }
}

/** 在多账号场景中，找到哪些 accountId 有该 userId 的 contextToken */
export function findAccountIdsWithToken(accountIds, userId) {
  return accountIds.filter((id) => Boolean(cache.get(id)?.get(userId)));
}
