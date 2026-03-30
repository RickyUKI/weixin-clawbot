/**
 * openclaw-weixin-js/src/api/api.js
 * 微信 iLink HTTP API 封装
 *
 * 路径与官方 @tencent-weixin/openclaw-weixin 保持一致：
 *   getupdates / sendmessage / getuploadurl / getconfig / sendtyping
 * 请求头：Authorization: Bearer <token>  +  AuthorizationType: ilink_bot_token
 */

import crypto from "node:crypto";
import { logger } from "../util/logger.js";

const DEFAULT_LONG_POLL_MS = 35_000;
const DEFAULT_API_MS = 15_000;
const CHANNEL_VERSION = "1.0.0";

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token, bodyStr) {
  const headers = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token?.trim()) {
    headers["Authorization"] = `Bearer ${token.trim()}`;
  }
  return headers;
}

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

async function apiFetch({ baseUrl, endpoint, bodyObj, token, timeoutMs, label }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();
  const bodyStr = JSON.stringify({ ...bodyObj, base_info: buildBaseInfo() });
  const headers = buildHeaders(token, bodyStr);

  logger.debug(`POST ${url}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    logger.debug(`${label} status=${res.status} body=${text.slice(0, 200)}`);
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * 长轮询拉消息
 */
export async function getUpdates({ baseUrl, token, get_updates_buf, timeoutMs }) {
  const timeout = timeoutMs ?? DEFAULT_LONG_POLL_MS;
  try {
    return await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      bodyObj: { get_updates_buf: get_updates_buf ?? "" },
      token,
      timeoutMs: timeout + 5_000,
      label: "getUpdates",
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      logger.debug(`getUpdates: client timeout after ${timeout}ms, retrying`);
      return { ret: 0, msgs: [], get_updates_buf };
    }
    throw err;
  }
}

/**
 * 下行发送消息
 */
export async function sendMessage({ baseUrl, token, body, timeoutMs }) {
  return apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    bodyObj: body,
    token,
    timeoutMs: timeoutMs ?? DEFAULT_API_MS,
    label: "sendMessage",
  });
}

/**
 * 获取 CDN 上传 URL
 */
export async function getUploadUrl({ baseUrl, token, filekey, media_type, to_user_id,
                                     rawsize, rawfilemd5, filesize, aeskey }) {
  return apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    bodyObj: { filekey, media_type, to_user_id, rawsize, rawfilemd5, filesize, aeskey },
    token,
    timeoutMs: DEFAULT_API_MS,
    label: "getUploadUrl",
  });
}

/**
 * 获取 bot config（含 typing_ticket）
 */
export async function getConfig({ baseUrl, token, ilinkUserId, contextToken }) {
  return apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getconfig",
    bodyObj: { ilink_user_id: ilinkUserId, context_token: contextToken },
    token,
    timeoutMs: 10_000,
    label: "getConfig",
  });
}

/**
 * 发送 typing 状态
 */
export async function sendTyping({ baseUrl, token, body }) {
  return apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    bodyObj: body,
    token,
    timeoutMs: 10_000,
    label: "sendTyping",
  }).catch((e) => logger.warn(`sendTyping: ${String(e)}`));
}
