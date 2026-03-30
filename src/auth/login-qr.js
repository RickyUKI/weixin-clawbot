/**
 * openclaw-weixin-js/src/auth/login-qr.js
 * 微信 iLink QR 码登录流程
 */

import { randomUUID } from "node:crypto";
import { logger } from "../util/logger.js";

export const DEFAULT_BOT_TYPE = "3";
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH = 3;

/** sessionKey → ActiveLogin */
const activeLogins = new Map();

function isLoginFresh(login) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpired() {
  for (const [k, v] of activeLogins) {
    if (!isLoginFresh(v)) activeLogins.delete(k);
  }
}

async function fetchQRCode(apiBaseUrl, botType) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base).toString();
  logger.info(`fetchQRCode: GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`fetchQRCode HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function pollQRStatus(apiBaseUrl, qrcode) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base).toString();
  logger.debug(`pollQRStatus: GET ${url}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`pollQRStatus HTTP ${res.status}`);
    return res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") return { status: "wait" };
    throw err;
  }
}

/**
 * 开始 QR 登录，返回 { qrcodeUrl, message, sessionKey }
 */
export async function startLoginWithQr({ accountId, apiBaseUrl, botType, force } = {}) {
  const sessionKey = accountId || randomUUID();
  purgeExpired();
  const existing = activeLogins.get(sessionKey);
  if (!force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return { qrcodeUrl: existing.qrcodeUrl, message: "二维码已就绪，请用微信扫描。", sessionKey };
  }
  try {
    const qr = await fetchQRCode(apiBaseUrl, botType || DEFAULT_BOT_TYPE);
    logger.info(`startLoginWithQr: got qrcode len=${qr.qrcode?.length}`);
    activeLogins.set(sessionKey, {
      sessionKey, id: randomUUID(),
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
    });
    return { qrcodeUrl: qr.qrcode_img_content, message: "请用微信扫描以下二维码完成连接。", sessionKey };
  } catch (err) {
    logger.error(`startLoginWithQr: ${String(err)}`);
    return { message: `启动登录失败: ${String(err)}`, sessionKey };
  }
}

/**
 * 轮询二维码状态，直到成功 / 超时
 * 返回 { connected, botToken, accountId, baseUrl, userId, message }
 */
export async function waitForQrLogin({ sessionKey, apiBaseUrl, timeoutMs } = {}) {
  let login = activeLogins.get(sessionKey);
  if (!login) return { connected: false, message: "没有进行中的登录，请先发起登录。" };
  if (!isLoginFresh(login)) {
    activeLogins.delete(sessionKey);
    return { connected: false, message: "二维码已过期，请重新生成。" };
  }
  const deadline = Date.now() + Math.max(timeoutMs ?? 480_000, 1000);
  let scanned = false;
  let refreshCount = 1;

  while (Date.now() < deadline) {
    try {
      const s = await pollQRStatus(apiBaseUrl, login.qrcode);
      logger.debug(`pollQRStatus: status=${s.status}`);
      login.status = s.status;

      if (s.status === "wait") {
        // 继续轮询
      } else if (s.status === "scaned") {
        if (!scanned) { process.stdout.write("\n👀 已扫码，请在微信中确认...\n"); scanned = true; }
      } else if (s.status === "expired") {
        refreshCount++;
        if (refreshCount > MAX_QR_REFRESH) {
          activeLogins.delete(sessionKey);
          return { connected: false, message: "登录超时：二维码多次过期，请重试。" };
        }
        process.stdout.write(`\n⏳ 二维码已过期，正在刷新...(${refreshCount}/${MAX_QR_REFRESH})\n`);
        try {
          const qr2 = await fetchQRCode(apiBaseUrl, DEFAULT_BOT_TYPE);
          login.qrcode = qr2.qrcode;
          login.qrcodeUrl = qr2.qrcode_img_content;
          login.startedAt = Date.now();
          scanned = false;
          process.stdout.write(`🔄 新二维码已生成: ${qr2.qrcode_img_content}\n`);
          try {
            const qrterm = await import("qrcode-terminal");
            qrterm.default.generate(qr2.qrcode_img_content, { small: true });
          } catch { /* 无 qrcode-terminal 则直接打印 URL */ }
        } catch (re) {
          activeLogins.delete(sessionKey);
          return { connected: false, message: `刷新二维码失败: ${String(re)}` };
        }
      } else if (s.status === "confirmed") {
        if (!s.ilink_bot_id) {
          activeLogins.delete(sessionKey);
          return { connected: false, message: "登录失败：服务器未返回 ilink_bot_id。" };
        }
        login.botToken = s.bot_token;
        activeLogins.delete(sessionKey);
        logger.info(`waitForQrLogin: confirmed botId=${s.ilink_bot_id}`);
        return {
          connected: true,
          botToken: s.bot_token,
          accountId: s.ilink_bot_id,
          baseUrl: s.baseurl,
          userId: s.ilink_user_id,
          message: "✅ 与微信连接成功！",
        };
      }
    } catch (err) {
      logger.error(`waitForQrLogin poll error: ${String(err)}`);
      activeLogins.delete(sessionKey);
      return { connected: false, message: `登录失败: ${String(err)}` };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  activeLogins.delete(sessionKey);
  return { connected: false, message: "登录超时，请重试。" };
}
