/**
 * openclaw-weixin-js/src/messaging/inbound.js
 * 将 iLink 消息格式转成 OpenClaw InboundContext
 */

import path from "node:path";
import { logger } from "../util/logger.js";

// iLink 消息类型常量
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 3,
  VOICE: 34,
  VIDEO: 43,
  FILE: 49,
};

/**
 * 从 item_list 提取纯文本
 */
export function extractTextBody(itemList) {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/**
 * 判断消息 item 是否为媒体类型
 */
export function isMediaItem(item) {
  return [MessageItemType.IMAGE, MessageItemType.VIDEO, MessageItemType.FILE, MessageItemType.VOICE]
    .includes(item?.type);
}

/**
 * 将 iLink 消息转换成 OpenClaw InboundContext（最小兼容字段集）
 *
 * @param {object}  full        - iLink WeixinMessage 对象
 * @param {string}  accountId
 * @param {object}  mediaOpts   - { MediaPath?, MediaUrl?, MediaMime? }
 */
export function buildInboundContext(full, accountId, mediaOpts) {
  const textBody = extractTextBody(full.item_list);
  const fromUserId = full.from_user_id ?? "";

  return {
    // OpenClaw 必填
    Channel: "weixin-clawbot",
    AccountId: accountId,
    From: fromUserId,
    To: fromUserId,          // 对于下行消息，To = 对方 userId
    Body: textBody,
    CommandBody: textBody,
    CommandAuthorized: false,
    SessionKey: null,
    // 媒体
    ...(mediaOpts.MediaPath ? { MediaPath: mediaOpts.MediaPath } : {}),
    ...(mediaOpts.MediaUrl ? { MediaUrl: mediaOpts.MediaUrl } : {}),
    ...(mediaOpts.MediaMime ? { MediaMime: mediaOpts.MediaMime } : {}),
    // 原始数据
    _raw: { full, contextToken: full.context_token },
  };
}

/**
 * 从 ctx._raw 取出 contextToken（下行发消息用）
 */
export function getContextTokenFromCtx(ctx) {
  return ctx?._raw?.contextToken || undefined;
}
