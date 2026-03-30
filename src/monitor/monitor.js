/**
 * openclaw-weixin-js/src/monitor/monitor.js
 * 长轮询循环 — getUpdates → 构建 MsgContext → dispatchReplyWithBufferedBlockDispatcher
 */

import { getUpdates } from "../api/api.js";
import { loadSyncBuf, saveSyncBuf } from "../storage/sync-buf.js";
import { extractTextBody, MessageItemType } from "../messaging/inbound.js";
import { setContextToken, restoreContextTokens } from "../messaging/context-tokens.js";
import { sendText } from "../messaging/send.js";
import { sendMediaFile } from "../messaging/send-media.js";
import { markdownToPlainText } from "../messaging/send.js";
import { logger } from "../util/logger.js";

const DEFAULT_LONG_POLL_MS = 35_000;
const MAX_FAILURES = 3;
const BACKOFF_MS = 30_000;
const RETRY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = 1001;

function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
  });
}

/**
 * @param {object} opts
 * @param {string}          opts.baseUrl
 * @param {string}          opts.cdnBaseUrl
 * @param {string}          opts.token
 * @param {string}          opts.accountId
 * @param {object}          opts.cfg          - OpenClawConfig
 * @param {object}          opts.channelRuntime - ctx.channelRuntime (PluginRuntimeChannel)
 * @param {AbortSignal}     [opts.abortSignal]
 * @param {function}        [opts.log]
 * @param {function}        [opts.errLog]
 */
export async function startMonitor(opts) {
  const { baseUrl, cdnBaseUrl, token, accountId, cfg, channelRuntime, abortSignal } = opts;
  const log = opts.log ?? ((m) => logger.info(m));
  const errLog = opts.errLog ?? ((m) => logger.error(m));

  restoreContextTokens(accountId);
  log(`[weixin-js] monitor started account=${accountId}`);

  let getUpdatesBuf = loadSyncBuf(accountId);
  let nextTimeoutMs = DEFAULT_LONG_POLL_MS;
  let failures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl, token, get_updates_buf: getUpdatesBuf, timeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms > 0) nextTimeoutMs = resp.longpolling_timeout_ms;

      const isErr = (resp.ret != null && resp.ret !== 0) || (resp.errcode != null && resp.errcode !== 0);
      if (isErr) {
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          errLog(`[weixin-js] session expired, pause 10m`);
          failures = 0;
          await sleep(10 * 60_000, abortSignal);
          continue;
        }
        failures++;
        errLog(`[weixin-js] getUpdates error ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} (${failures}/${MAX_FAILURES})`);
        if (failures >= MAX_FAILURES) { failures = 0; await sleep(BACKOFF_MS, abortSignal); }
        else await sleep(RETRY_MS, abortSignal);
        continue;
      }

      failures = 0;

      if (resp.get_updates_buf) {
        saveSyncBuf(accountId, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      for (const msg of (resp.msgs ?? [])) {
        log(`[weixin-js] inbound from=${msg.from_user_id}`);
        // 非阻塞处理，避免串行等待 AI 回复时后续消息被 dispatchReplyWithBufferedBlockDispatcher 跳过
        processMessage(msg, { accountId, cfg, channelRuntime, baseUrl, cdnBaseUrl, token, log, errLog })
          .catch((e) => errLog(`[weixin-js] processMessage error: ${String(e)}`));
      }
    } catch (err) {
      if (abortSignal?.aborted) { log("[weixin-js] monitor stopped (aborted)"); return; }
      failures++;
      errLog(`[weixin-js] poll error (${failures}/${MAX_FAILURES}): ${String(err)}`);
      if (failures >= MAX_FAILURES) { failures = 0; await sleep(BACKOFF_MS, abortSignal); }
      else await sleep(RETRY_MS, abortSignal);
    }
  }
  log("[weixin-js] monitor ended");
}

/**
 * 处理单条消息 — 构建 MsgContext，调用 dispatchReplyWithBufferedBlockDispatcher
 */
async function processMessage(full, { accountId, cfg, channelRuntime, baseUrl, cdnBaseUrl, token, log, errLog }) {
  if (!channelRuntime) {
    errLog("[weixin-js] channelRuntime not available, skipping dispatch");
    return;
  }

  const fromUserId = full.from_user_id ?? "";
  const textBody = extractTextBody(full.item_list);
  const contextToken = full.context_token;

  // 保存 contextToken 供下行发消息使用
  if (contextToken && fromUserId) {
    setContextToken(accountId, fromUserId, contextToken);
  }

  // 构建路由
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: "weixin-clawbot",
    accountId,
    peer: { kind: "direct", id: fromUserId },
  });

  // 构建 MsgContext（使用 SDK 的大写字段规范）
  const ctx = {
    Body: textBody,
    CommandBody: textBody,
    From: fromUserId,
    To: fromUserId,
    AccountId: accountId,
    SessionKey: route.sessionKey,
    ChatType: "direct",
    Provider: "weixin-clawbot",
    Surface: "weixin-clawbot",
    OriginatingChannel: "weixin-clawbot",
    OriginatingTo: fromUserId,
    ExplicitDeliverRoute: true,
  };

  // 记录 session meta
  try {
    const storePath = channelRuntime.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });
    await channelRuntime.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx,
      updateLastRoute: {
        sessionKey: route.mainSessionKey ?? route.sessionKey,
        channel: "weixin-clawbot",
        to: fromUserId,
        accountId,
      },
      onRecordError: (e) => errLog(`recordInboundSession: ${String(e)}`),
    });
  } catch (e) {
    errLog(`[weixin-js] recordInboundSession failed: ${String(e)}`);
  }

  // 准备 send opts（关闭时用）
  const sendOpts = { baseUrl, token, contextToken, cdnBaseUrl };

  // 先发「正在输入...」提示，让用户知道消息已收到
  await sendText({ to: fromUserId, text: "⏳ 正在思考...", opts: sendOpts })
    .catch((e) => errLog(`[weixin-js] typing indicator error: ${String(e)}`));

  // dispatch AI 回复
  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const text = markdownToPlainText(payload.text ?? "");
        const mediaUrl = payload.mediaUrl ?? (payload.mediaUrls?.[0]);

        try {
          if (mediaUrl) {
            await sendMediaFile({ filePath: mediaUrl, to: fromUserId, text, opts: sendOpts });
          } else if (text) {
            await sendText({ to: fromUserId, text, opts: sendOpts });
          }
        } catch (err) {
          errLog(`[weixin-js] deliver error: ${String(err)}`);
          await sendText({
            to: fromUserId,
            text: `⚠️ 发送失败：${err.message}`,
            opts: sendOpts,
          }).catch(() => {});
        }
      },
      onError: (err) => errLog(`[weixin-js] reply error: ${String(err)}`),
    },
  }).catch((e) => errLog(`[weixin-js] dispatch error: ${String(e)}`));
}
