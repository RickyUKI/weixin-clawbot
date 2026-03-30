/**
 * openclaw-weixin-js/src/messaging/send.js
 * 下行发送文本消息 — 与官方 MessageItemType/MessageType/MessageState 保持一致
 */

import crypto from "node:crypto";
import { sendMessage as sendMessageApi } from "../api/api.js";
import { logger } from "../util/logger.js";

// 与官方 types.ts 一致
const MessageType  = { NONE: 0, USER: 1, BOT: 2 };
const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };

function generateClientId() {
  return `weixin-clawbot-${crypto.randomUUID()}`;
}

/**
 * 简单 Markdown → 纯文本
 */
export function markdownToPlainText(text) {
  if (!text) return "";
  let r = text;
  r = r.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => code.trim());
  r = r.replace(/`([^`]+)`/g, "$1");
  r = r.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  r = r.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  r = r.replace(/^\|[\s:|-]+\|$/gm, "");
  r = r.replace(/^\|(.+)\|$/gm, (_, inner) =>
    inner.split("|").map(c => c.trim()).join("  "));
  r = r.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  r = r.replace(/\*\*([^*]+)\*\*/g, "$1");
  r = r.replace(/\*([^*]+)\*/g, "$1");
  r = r.replace(/__([^_]+)__/g, "$1");
  r = r.replace(/_([^_]+)_/g, "$1");
  r = r.replace(/^#{1,6}\s+/gm, "");
  r = r.replace(/^[\-\*\+]\s+/gm, "• ");
  r = r.replace(/^\d+\.\s+/gm, "");
  r = r.replace(/^[-*_]{3,}$/gm, "──────");
  return r;
}

/**
 * 发送纯文本消息
 */
export async function sendText({ to, text, opts }) {
  if (!opts?.contextToken) {
    logger.warn(`sendText: contextToken missing for to=${to}`);
  }
  const clientId = generateClientId();
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : undefined,
      context_token: opts?.contextToken ?? undefined,
    },
  };
  await sendMessageApi({ baseUrl: opts.baseUrl, token: opts.token, body, timeoutMs: opts.timeoutMs });
  return { messageId: clientId };
}

/**
 * 发送多个 item（每个 item 独立请求）
 */
export async function sendItems({ to, items, opts }) {
  let lastClientId = generateClientId();
  for (const item of items) {
    lastClientId = generateClientId();
    const body = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: opts?.contextToken ?? undefined,
      },
    };
    await sendMessageApi({ baseUrl: opts.baseUrl, token: opts.token, body, timeoutMs: opts.timeoutMs });
  }
  return { messageId: lastClientId };
}
