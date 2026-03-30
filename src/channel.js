/**
 * openclaw-weixin-js/src/channel.js
 * ChannelPlugin 定义（OpenClaw plugin-sdk 兼容）
 *
 * 关键点：
 *  - gateway.startAccount 必须返回一个持续 pending 的 Promise（直到 abortSignal）
 *  - 使用 SDK 的 waitUntilAbort / runPassiveAccountLifecycle
 *  - channelRuntime 来自 ctx.channelRuntime（PluginRuntimeChannel）
 *  - ctx.runtime.log / ctx.runtime.error 是函数，不是对象
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  listAccountIds,
  resolveAccount,
  saveAccountData,
  registerAccountId,
  clearStaleAccountsForUserId,
  normalizeAccountId,
  CHANNEL_ID,
} from "./auth/accounts.js";
import { startLoginWithQr, waitForQrLogin, DEFAULT_BOT_TYPE } from "./auth/login-qr.js";
import {
  getContextToken,
  setContextToken,
  clearContextTokensForAccount,
} from "./messaging/context-tokens.js";
import { sendText } from "./messaging/send.js";
import { sendMediaFile } from "./messaging/send-media.js";
import { startMonitor } from "./monitor/monitor.js";
import { logger } from "./util/logger.js";

// 通过 createRequire 加载 plugin-sdk（CJS），获取 waitUntilAbort
const _require = createRequire(import.meta.url);
let _waitUntilAbort;
try {
  const sdk = _require("/usr/local/lib/.nvm/versions/node/v22.17.0/lib/node_modules/openclaw/dist/plugin-sdk/root-alias.cjs");
  _waitUntilAbort = sdk.waitUntilAbort;
} catch (e) {
  logger.warn(`[channel] failed to load waitUntilAbort from plugin-sdk: ${String(e)}`);
}

/**
 * 等待 abortSignal 触发（polyfill，如果 SDK 不可用）
 */
function waitUntilAbort(signal) {
  if (_waitUntilAbort) return _waitUntilAbort(signal);
  // fallback
  if (!signal) return new Promise(() => {}); // forever
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// ---------------------------------------------------------------------------
// 账号选择
// ---------------------------------------------------------------------------

function resolveOutboundAccountId(cfg, to) {
  const allIds = listAccountIds(cfg);
  if (allIds.length === 0) throw new Error(`weixin-js: no accounts — run login first`);
  if (allIds.length === 1) return allIds[0];
  const matched = allIds.filter((id) => Boolean(getContextToken(id, to)));
  if (matched.length === 1) return matched[0];
  if (matched.length > 1) throw new Error(`weixin-js: ambiguous account for to=${to}`);
  // fallback to first
  return allIds[0];
}

// ---------------------------------------------------------------------------
// ChannelPlugin
// ---------------------------------------------------------------------------

export const weixinJsPlugin = {
  id: CHANNEL_ID,
  // 声明 gatewayMethods，让框架在 web.login.wait 成功后自动调用 startChannel
  // 绕过内网版 ALLOWED_CHANNELS 白名单（该白名单只影响批量 startChannels，不影响单个 startChannel 调用）
  gatewayMethods: ["web.login.start", "web.login.wait"],
  meta: {
    id: CHANNEL_ID,
    label: "微信 Clawbot",
    selectionLabel: "微信 Bot (JS, QR login)",
    docsPath: "/channels/weixin-clawbot",
    blurb: "Personal WeChat channel (pure JS). QR login, long-poll getUpdates.",
    order: 76,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    blockStreaming: true,
    reactions: false,
    threads: false,
    nativeCommands: false,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 200, idleMs: 3000 },
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

  // ---------------------------------------------------------------------------
  // config
  // ---------------------------------------------------------------------------
  config: {
    listAccountIds: (cfg) => listAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },

  // ---------------------------------------------------------------------------
  // outbound
  // ---------------------------------------------------------------------------
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async (ctx) => {
      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      const account = resolveAccount(ctx.cfg, accountId);
      if (!account.configured) throw new Error("weixin-js: account not configured");
      const contextToken = getContextToken(account.accountId, ctx.to);
      const result = await sendText({
        to: ctx.to,
        text: ctx.text,
        opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
      });
      return { channel: CHANNEL_ID, messageId: result.messageId };
    },
    sendMedia: async (ctx) => {
      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      const account = resolveAccount(ctx.cfg, accountId);
      if (!account.configured) throw new Error("weixin-js: account not configured");
      const contextToken = getContextToken(account.accountId, ctx.to);
      const mediaUrl = ctx.mediaUrl;
      if (mediaUrl) {
        const result = await sendMediaFile({
          filePath: mediaUrl,
          to: ctx.to,
          text: ctx.text ?? "",
          opts: { baseUrl: account.baseUrl, token: account.token, contextToken, cdnBaseUrl: account.cdnBaseUrl },
        });
        return { channel: CHANNEL_ID, messageId: result.messageId };
      }
      const result = await sendText({
        to: ctx.to,
        text: ctx.text ?? "",
        opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
      });
      return { channel: CHANNEL_ID, messageId: result.messageId };
    },
  },

  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------
  status: {
    defaultRuntime: { accountId: "", lastError: null, lastInboundAt: null, lastOutboundAt: null },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...runtime,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },

  // ---------------------------------------------------------------------------
  // auth (CLI login)
  // ---------------------------------------------------------------------------
  auth: {
    login: async ({ cfg, accountId, verbose, runtime }) => {
      const account = resolveAccount(cfg, accountId);
      const print = (msg) => console.log(msg);

      print("正在启动微信扫码登录...");
      const startResult = await startLoginWithQr({
        accountId: account.accountId,
        apiBaseUrl: account.baseUrl,
        botType: DEFAULT_BOT_TYPE,
        force: true,
      });

      if (!startResult.qrcodeUrl) {
        print(startResult.message);
        throw new Error(startResult.message);
      }

      try {
        const qrterm = await import("qrcode-terminal");
        await new Promise((resolve) => {
          qrterm.default.generate(startResult.qrcodeUrl, { small: true }, (qr) => {
            print("\n使用微信扫描以下二维码完成连接：\n");
            print(qr);
            print(`如果二维码无法显示，请用浏览器打开：${startResult.qrcodeUrl}`);
            resolve();
          });
        });
      } catch {
        print(`\n使用微信扫描以下链接完成连接：\n${startResult.qrcodeUrl}`);
      }

      print("\n等待扫码结果...\n");
      const waitResult = await waitForQrLogin({
        sessionKey: startResult.sessionKey,
        apiBaseUrl: account.baseUrl,
        timeoutMs: 480_000,
      });

      if (waitResult.connected && waitResult.botToken && waitResult.accountId) {
        const normalizedId = normalizeAccountId(waitResult.accountId);
        saveAccountData(normalizedId, {
          token: waitResult.botToken,
          baseUrl: waitResult.baseUrl,
          userId: waitResult.userId,
        });
        registerAccountId(normalizedId);
        if (waitResult.userId) {
          clearStaleAccountsForUserId(normalizedId, waitResult.userId, clearContextTokensForAccount);
        }
        print("\n✅ 与微信连接成功！重启 Gateway 使其生效：openclaw gateway restart");
      } else {
        throw new Error(waitResult.message);
      }
    },
  },

  // ---------------------------------------------------------------------------
  // gateway — startAccount 直接 return monitor Promise（与官方 openclaw-weixin 一致）
  // ---------------------------------------------------------------------------
  gateway: {
    startAccount: async (ctx) => {
      if (!ctx) return;
      const { account, cfg, runtime, abortSignal } = ctx;
      const log = (msg) => runtime?.log?.(msg);
      const errLog = (msg) => runtime?.error?.(msg);

      log?.(`[weixin-js] startAccount: account=${account.accountId}`);

      if (!account.configured) {
        errLog?.(`[weixin-js] account ${account.accountId} not configured — run login first`);
        ctx.setStatus?.({ accountId: account.accountId, running: false });
        throw new Error("weixin-js not configured: missing token");
      }

      ctx.setStatus?.({ accountId: account.accountId, running: true, lastStartAt: Date.now() });

      // 直接使用框架传入的 ctx.channelRuntime，无需 waitForWeixinRuntime
      const channelRuntime = ctx.channelRuntime;
      if (!channelRuntime) {
        const err = new Error("weixin-clawbot: channelRuntime not provided by framework");
        errLog?.(err.message);
        ctx.setStatus?.({ accountId: account.accountId, running: false });
        throw err;
      }
      log?.(`[weixin-clawbot] channelRuntime acquired`);

      // 直接 return monitor Promise — 它 hold 直到 abortSignal 触发
      return startMonitor({
        baseUrl: account.baseUrl,
        cdnBaseUrl: account.cdnBaseUrl || "",
        token: account.token,
        accountId: account.accountId,
        cfg,
        channelRuntime,
        abortSignal,
        log,
        errLog,
      });
    },

    // Web UI QR 登录支持
    loginWithQrStart: async ({ accountId, force }) => {
      const { DEFAULT_BASE_URL } = await import("./auth/accounts.js");
      const { loadAccountData, normalizeAccountId: normalize } = await import("./auth/accounts.js");
      const saved = accountId ? loadAccountData(normalize(accountId)) : null;
      const result = await startLoginWithQr({
        accountId: accountId ?? undefined,
        apiBaseUrl: saved?.baseUrl || DEFAULT_BASE_URL,
        botType: DEFAULT_BOT_TYPE,
        force,
      });
      return { qrDataUrl: result.qrcodeUrl, message: result.message };
    },

    loginWithQrWait: async (params) => {
      const { DEFAULT_BASE_URL, loadAccountData, saveAccountData: save,
              registerAccountId: reg, clearStaleAccountsForUserId: clearStale,
              normalizeAccountId: normalize } = await import("./auth/accounts.js");
      const { clearContextTokensForAccount: clearCtx } = await import("./messaging/context-tokens.js");

      const sessionKey = params.sessionKey || params.accountId || "";
      const savedBaseUrl = params.accountId
        ? loadAccountData(normalize(params.accountId))?.baseUrl?.trim()
        : "";
      const result = await waitForQrLogin({
        sessionKey,
        apiBaseUrl: savedBaseUrl || DEFAULT_BASE_URL,
        timeoutMs: params.timeoutMs,
      });
      if (result.connected && result.botToken && result.accountId) {
        const id = normalize(result.accountId);
        save(id, { token: result.botToken, baseUrl: result.baseUrl, userId: result.userId });
        reg(id);
        if (result.userId) clearStale(id, result.userId, clearCtx);
      }
      return { connected: result.connected, message: result.message };
    },
  },
};
