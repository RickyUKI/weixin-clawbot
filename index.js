/**
 * openclaw-weixin-js/index.js
 */

import { weixinJsPlugin } from "./src/channel.js";
import { setWeixinRuntime } from "./src/runtime.js";

const plugin = {
  id: "weixin-clawbot",
  name: "微信机器人 (JS)",
  description: "Personal WeChat channel plugin — QR login, long-poll getUpdates, send text/image/file. Pure JavaScript.",

  configSchema: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
  },

  register(api) {
    // 必须在 register 里调用，让 startAccount 里的 waitForWeixinRuntime 能拿到 channelRuntime
    if (api.runtime) {
      setWeixinRuntime(api.runtime);
    }

    api.registerChannel({ plugin: weixinJsPlugin });
  },
};

export default plugin;
