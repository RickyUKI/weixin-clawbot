/**
 * openclaw-weixin-js/src/runtime.js
 * 保存 OpenClaw PluginRuntime 引用供内部模块使用
 */

let _runtime = null;

export function setWeixinRuntime(runtime) {
  _runtime = runtime;
}

export function getWeixinRuntime() {
  if (!_runtime) throw new Error("weixin-js runtime not initialized");
  return _runtime;
}

export function waitForWeixinRuntime(timeoutMs = 30_000) {
  if (_runtime) return Promise.resolve(_runtime);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (_runtime) return resolve(_runtime);
      if (Date.now() > deadline) return reject(new Error("weixin-js: runtime timeout"));
      setTimeout(check, 100);
    };
    check();
  });
}
