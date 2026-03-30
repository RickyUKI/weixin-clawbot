/**
 * openclaw-weixin-js/src/messaging/send-media.js
 * 媒体上传 + 下行发送（与官方 cdn-upload.ts / upload.ts / send.ts 保持一致）
 *
 * 关键：
 *   - AES-128-ECB 加密（不是 CBC）
 *   - getUploadUrl 使用 rawsize / rawfilemd5 / filesize / aeskey(hex)
 *   - CDN 上传: POST to buildCdnUploadUrl, 返回头 x-encrypted-param 即 downloadParam
 *   - MessageItemType: IMAGE=2, VIDEO=5, FILE=4
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { getUploadUrl } from "../api/api.js";
import { sendItems, MessageItemType } from "./send.js";
import { logger } from "../util/logger.js";

const CDN_DEFAULT_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const UPLOAD_MAX_RETRIES = 3;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);

const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };

// ---------------------------------------------------------------------------
// AES-128-ECB (与官方一致)
// ---------------------------------------------------------------------------

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ---------------------------------------------------------------------------
// CDN URL 构建
// ---------------------------------------------------------------------------

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  const base = cdnBaseUrl || CDN_DEFAULT_BASE;
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

// ---------------------------------------------------------------------------
// 文件类型辅助
// ---------------------------------------------------------------------------

function isImage(filePath) {
  return IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

function isVideo(filePath) {
  return VIDEO_EXTS.has(path.extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// 下载远程图片到临时目录
// ---------------------------------------------------------------------------

async function downloadToTemp(url, tmpDir) {
  const ext = path.extname(new URL(url).pathname) || ".jpg";
  const tmpFile = path.join(tmpDir, `weixin-dl-${crypto.randomUUID()}${ext}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`downloadToTemp HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmpFile, buf);
  logger.debug(`downloadToTemp: ${url} → ${tmpFile} (${buf.length} bytes)`);
  return tmpFile;
}

// ---------------------------------------------------------------------------
// 核心上传流程
// ---------------------------------------------------------------------------

async function uploadToCdn({ plaintext, toUserId, opts, cdnBaseUrl, mediaType, label }) {
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16); // Buffer(16)

  logger.debug(`${label}: rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5}`);

  // 1. 获取上传 URL
  const uploadResp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadParam = uploadResp.upload_param;
  if (!uploadParam) {
    throw new Error(`${label}: getUploadUrl returned no upload_param. resp=${JSON.stringify(uploadResp)}`);
  }

  // 2. 加密并上传到 CDN
  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const cdnUrl = buildCdnUploadUrl({ cdnBaseUrl: cdnBaseUrl || CDN_DEFAULT_BASE, uploadParam, filekey });

  let downloadEncryptedQueryParam;
  let lastErr;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`CDN client error ${res.status}: ${res.headers.get("x-error-message") ?? await res.text()}`);
      }
      if (res.status !== 200) {
        throw new Error(`CDN server error ${res.status}`);
      }
      downloadEncryptedQueryParam = res.headers.get("x-encrypted-param");
      if (!downloadEncryptedQueryParam) {
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      logger.debug(`${label}: CDN upload OK attempt=${attempt}`);
      break;
    } catch (err) {
      lastErr = err;
      if (String(err).includes("client error")) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) logger.error(`${label}: attempt ${attempt} failed, retrying: ${String(err)}`);
    }
  }
  if (!downloadEncryptedQueryParam) throw lastErr ?? new Error(`${label}: CDN upload failed`);

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),   // hex for API
    aeskeyB64: aeskey.toString("base64"),  // base64 for MessageItem
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

// ---------------------------------------------------------------------------
// 公开接口：发送媒体文件
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {string} params.filePath  - 本地绝对路径 或 http(s) URL
 * @param {string} params.to        - 对方 userId
 * @param {string} [params.text]    - 可选文字说明
 * @param {object} params.opts      - { baseUrl, token, contextToken, cdnBaseUrl }
 */
export async function sendMediaFile({ filePath, to, text, opts }) {
  const tmpDir = path.join(os.tmpdir(), "weixin-clawbot", "media");
  let localPath = filePath;
  let cleanup = false;

  try {
    if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
      localPath = await downloadToTemp(filePath, tmpDir);
      cleanup = true;
    }
    if (!fs.existsSync(localPath)) throw new Error(`File not found: ${localPath}`);

    const plaintext = fs.readFileSync(localPath);
    const fileName = path.basename(localPath);
    const cdnBaseUrl = opts.cdnBaseUrl || CDN_DEFAULT_BASE;

    let mediaType, itemType;
    if (isImage(localPath))      { mediaType = UploadMediaType.IMAGE;  itemType = MessageItemType.IMAGE; }
    else if (isVideo(localPath)) { mediaType = UploadMediaType.VIDEO;  itemType = MessageItemType.VIDEO; }
    else                          { mediaType = UploadMediaType.FILE;   itemType = MessageItemType.FILE;  }

    const uploaded = await uploadToCdn({
      plaintext,
      toUserId: to,
      opts,
      cdnBaseUrl,
      mediaType,
      label: `sendMediaFile(${fileName})`,
    });

    const cdnMedia = {
      encrypt_query_param: uploaded.downloadEncryptedQueryParam,
      aes_key: uploaded.aeskeyB64,
      encrypt_type: 1,
    };

    let mediaItem;
    if (itemType === MessageItemType.IMAGE) {
      mediaItem = { type: itemType, image_item: { media: cdnMedia, mid_size: uploaded.fileSizeCiphertext } };
    } else if (itemType === MessageItemType.VIDEO) {
      mediaItem = { type: itemType, video_item: { media: cdnMedia, video_size: uploaded.fileSizeCiphertext } };
    } else {
      mediaItem = { type: itemType, file_item: { media: cdnMedia, file_name: fileName, len: String(uploaded.fileSize) } };
    }

    const items = [];
    if (text) items.push({ type: MessageItemType.TEXT, text_item: { text } });
    items.push(mediaItem);

    return await sendItems({ to, items, opts });
  } finally {
    if (cleanup && localPath) {
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
    }
  }
}
