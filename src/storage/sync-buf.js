/**
 * openclaw-weixin-js/src/storage/sync-buf.js
 * getUpdates buf 的持久化（断线续连）
 */

import fs from "node:fs";
import { resolveSyncBufPath } from "./state-dir.js";
import { logger } from "../util/logger.js";

export function loadSyncBuf(accountId) {
  const p = resolveSyncBufPath(accountId);
  try {
    if (!fs.existsSync(p)) return "";
    const d = JSON.parse(fs.readFileSync(p, "utf-8"));
    return typeof d.buf === "string" ? d.buf : "";
  } catch { return ""; }
}

export function saveSyncBuf(accountId, buf) {
  const p = resolveSyncBufPath(accountId);
  try {
    fs.writeFileSync(p, JSON.stringify({ buf, savedAt: new Date().toISOString() }), "utf-8");
  } catch (err) { logger.warn(`saveSyncBuf: ${String(err)}`); }
}
