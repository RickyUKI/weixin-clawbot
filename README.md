# weixin-clawbot

OpenClaw 微信机器人插件 — 纯 JavaScript，无需 TypeScript 编译。

## 功能

- 🔐 微信扫码登录（iLink QR 登录）
- 📨 长轮询接收消息 (`getUpdates`)
- 📤 发送文本、图片、视频、文件
- 🔄 多账号支持（自动按 contextToken 匹配）
- 💾 断线续连（sync buf 持久化）

## 目录结构

```
weixin-clawbot/
├── index.js                    # 插件入口
├── openclaw.plugin.json        # 插件声明
├── package.json
└── src/
    ├── channel.js              # ChannelPlugin 主体
    ├── runtime.js              # PluginRuntime 引用
    ├── api/
    │   └── api.js              # iLink HTTP API (getUpdates, sendMessage, CDN)
    ├── auth/
    │   ├── accounts.js         # 账号持久化 + 索引
    │   └── login-qr.js         # QR 登录流程
    ├── messaging/
    │   ├── context-tokens.js   # contextToken 存储
    │   ├── inbound.js          # iLink 消息 → InboundContext
    │   ├── send.js             # 下行文本发送
    │   └── send-media.js       # 下行媒体发送（AES 加密 + CDN 上传）
    ├── monitor/
    │   └── monitor.js          # 长轮询主循环
    ├── storage/
    │   ├── state-dir.js        # 状态目录
    │   └── sync-buf.js         # getUpdates buf 持久化
    └── util/
        └── logger.js           # 日志工具
```

## 安装

在 `openclaw.json` 中添加本地插件路径：

```json
{
  "plugins": {
    "local": ["~/.openclaw/extensions/weixin-clawbot"]
  }
}
```

或通过 OpenClaw config：

```bash
openclaw config set plugins.local[0] ~/.openclaw/extensions/weixin-clawbot
```

## 登录

```bash
openclaw channels login --channel weixin-clawbot
```

终端会显示二维码（需要 `qrcode-terminal`），或打印扫码链接。

## 使用

登录成功后，微信消息会自动路由到 OpenClaw agent。

### 发送消息

使用 `message` 工具：

```json
{
  "action": "send",
  "channel": "weixin-clawbot",
  "to": "abc123@im.wechat",
  "message": "Hello from OpenClaw!"
}
```

### 发送文件

```json
{
  "action": "send",
  "channel": "weixin-clawbot",
  "to": "abc123@im.wechat",
  "media": "/tmp/report.pdf"
}
```

## 状态目录

凭证和状态文件存储在：

```
~/.openclaw/state/weixin-clawbot/
├── accounts.json               # 账号 ID 索引
└── accounts/
    ├── <accountId>.json        # token + baseUrl
    ├── <accountId>.sync.json   # getUpdates sync buf
    └── <accountId>.context-tokens.json
```

## 环境变量

| 变量               | 默认值                        | 说明          |
|--------------------|-------------------------------|---------------|
| `WEIXIN_DEBUG`     | -                             | 设为 `1` 开启 debug 日志 |
| `OPENCLAW_STATE_DIR` | `~/.openclaw/state`         | 状态目录      |

## 与官方插件的区别

| 特性            | 官方 `@tencent-weixin/openclaw-weixin` | 本插件 `weixin-clawbot` |
|-----------------|----------------------------------------|-----------------------------|
| 语言            | TypeScript                             | 纯 JavaScript               |
| 编译            | 需要构建                               | 无需构建，直接运行           |
| CDN 媒体上传    | ✅ 完整实现                            | ✅ 基础实现（AES-128-CBC）   |
| 多账号          | ✅                                     | ✅                           |
| 调试模式        | ✅                                     | 通过 `WEIXIN_DEBUG=1`       |
| 兼容性          | 需要 host >= 2026.3.0                  | 最大兼容性                   |
