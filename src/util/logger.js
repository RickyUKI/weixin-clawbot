/**
 * openclaw-weixin-js/src/util/logger.js
 * 简单日志封装 — 可通过 WEIXIN_DEBUG=1 开启 debug 输出
 */

const DEBUG = Boolean(process.env.WEIXIN_DEBUG);

function ts() {
  return new Date().toISOString();
}

function makeLogger(prefix) {
  return {
    info: (msg) => console.info(`[${ts()}] [weixin-js] [${prefix}] ${msg}`),
    warn: (msg) => console.warn(`[${ts()}] [weixin-js] [WARN] [${prefix}] ${msg}`),
    error: (msg) => console.error(`[${ts()}] [weixin-js] [ERR]  [${prefix}] ${msg}`),
    debug: (msg) => { if (DEBUG) console.debug(`[${ts()}] [weixin-js] [DBG]  [${prefix}] ${msg}`); },
    withAccount(accountId) { return makeLogger(`${prefix}:${accountId}`); },
  };
}

export const logger = makeLogger("main");
