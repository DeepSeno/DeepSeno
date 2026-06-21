# 消息渠道接入指南

DeepSeno 支持通过 4 种即时通讯平台接收语音/文字消息，并通过本地 AI 管线自动处理。本文档说明各渠道的配置方法。

## 架构概览

```
用户发送消息
    │
    ▼
┌──────────────────────────────────────────────┐
│  消息接入层                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ 飞书     │ │ Telegram │ │ 企业微信 │ │ 钉钉     │ │
│  │WebSocket │ │长轮询    │ │Webhook   │ │Webhook   │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│       └──────┬─────┴──────┬─────┴──────┬─────┘       │
│              ▼                                        │
│       MessageRouter (统一路由)                        │
│              │                                        │
│              ▼                                        │
│       AgentExecutor (AI Agent + MCP 工具)             │
└──────────────────────────────────────────────────────┘
    │
    ▼
本地 AI 管线（转写 / 优化 / 提取 / RAG）
```

**连接方式差异：**

| 渠道 | 连接方式 | 是否需要公网 | 消息加密 |
|------|---------|-------------|---------|
| 飞书 | WebSocket（SDK 内置） | 否 | SDK 处理 |
| Telegram | 长轮询（主动拉取） | 否 | 否（HTTPS） |
| 企业微信 | Webhook（被动接收） | 是 | AES-256-CBC |
| 钉钉 | Webhook（被动接收） | 是 | 否（HTTPS + 签名） |

> **注意：** 企业微信和钉钉使用 Webhook 模式，需要将 DeepSeno 内置 LAN Server（默认端口 `18526`）暴露到公网。可使用内网穿透工具（如 ngrok、frp）或部署在有公网 IP 的服务器上。

---

## 1. 飞书机器人

### 1.1 创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，点击「创建企业自建应用」
2. 填写应用名称（如 "DeepSeno 语音助手"）和描述
3. 进入应用管理页面，记录以下信息：
   - **App ID** — 应用凭证页面
   - **App Secret** — 应用凭证页面

### 1.2 配置权限

进入「权限管理」，添加以下权限并申请审批：

| 权限 | 权限标识 | 用途 |
|------|---------|------|
| 获取与发送单聊/群聊消息 | `im:message` | 收发消息 |
| 获取群组信息 | `im:chat:readonly` | 读取群聊上下文 |
| 以应用身份发消息 | `im:message:send_as_bot` | 主动推送通知 |
| 获取用户信息 | `contact:user.base:readonly` | 识别发送者 |

### 1.3 启用机器人能力

1. 进入「添加应用能力」→ 勾选「机器人」
2. 在「事件订阅」中：
   - **选择 WebSocket 模式**（无需公网 IP）
   - 添加事件：`im.message.receive_v1`（接收消息）

### 1.4 发布应用

1. 进入「版本管理与发布」→ 创建版本 → 提交审核
2. 管理员在飞书管理后台审批通过
3. 应用上线后，在群聊中 @机器人 或私聊机器人即可触发

### 1.5 在 DeepSeno 中配置

打开 DeepSeno 设置页面 → 集成 → 飞书：

| 配置项 | 说明 |
|-------|------|
| App ID | 飞书应用凭证 |
| App Secret | 飞书应用密钥（本地加密存储） |
| 管理员 Open ID | （可选）仅允许该用户与机器人交互，留空则所有人可用 |
| 处理完成通知 | 开启后，音频转写完成会推送卡片通知 |
| 每日摘要 | 开启后，每天推送当日语音摘要 |

点击「测试连接」验证配置，然后开启「启用」开关。

### 1.6 支持的消息类型

- **文字消息** → 通过 AI Agent 处理（查询、备忘、待办等）
- **语音消息** → 下载 → ffmpeg 转 WAV → 实时转写 → AI 处理
- **快捷指令** → `完成1`（标记待办完成）、`删除3`（删除条目）

### 1.7 回复格式

飞书支持富文本卡片，DeepSeno 会发送结构化卡片消息，包含：
- 转写结果卡片（文件名、时长、说话人数、待办数）
- 查询回答卡片（问题 + 答案 + 来源引用）
- 每日/周报摘要卡片
- 待办/备忘列表卡片

---

## 2. Telegram 机器人

### 2.1 创建 Bot

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示填写：
   - Bot 名称（如 "DeepSeno Voice Assistant"）
   - Bot 用户名（必须以 `bot` 结尾，如 `deepseno_voice_bot`）
3. 创建成功后，BotFather 会返回 **Bot Token**，格式如 `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`

### 2.2 获取 Chat ID

向你的 Bot 发送任意消息，然后访问：

```
https://api.telegram.org/bot<你的Token>/getUpdates
```

在返回的 JSON 中找到 `result[0].message.chat.id`，这就是你的 Chat ID。

### 2.3 在 DeepSeno 中配置

打开 DeepSeno 设置页面 → 集成 → Telegram：

| 配置项 | 说明 |
|-------|------|
| Bot Token | BotFather 返回的 Token（本地加密存储） |
| Chat ID | 默认发送消息的聊天 ID |

点击「测试连接」验证 Token，然后开启「启用」开关。

### 2.4 连接说明

- Telegram 使用**长轮询**方式，DeepSeno 会持续向 Telegram API 拉取新消息
- **无需公网 IP**，只要 DeepSeno 能访问 `api.telegram.org` 即可
- 自动使用系统代理设置（通过 Electron 的 `net.fetch`）
- 如果网络不通，请确保代理配置正确

### 2.5 支持的消息类型

- **文字消息** → AI Agent 处理
- **语音消息** → 下载 Opus 文件 → 转写 → AI 处理

### 2.6 回复格式

Telegram 不支持原生卡片，回复以 Markdown 格式发送：

```markdown
**转写结果**

文件: meeting_20260308.wav
时长: 45分钟
说话人: 3

---

关键待办:
- 准备周五的项目汇报
- 联系供应商确认报价
```

---

## 3. 企业微信

### 3.1 创建应用

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 进入「应用管理」→「自建」→「创建应用」
3. 填写应用信息（名称、Logo、可见范围）
4. 创建后记录以下信息：
   - **企业 ID (Corp ID)** — 在「我的企业」页面底部
   - **应用 ID (Agent ID)** — 应用详情页
   - **应用密钥 (Secret)** — 应用详情页，点击查看

### 3.2 配置回调 URL

1. 在应用详情页 →「接收消息」→ 设置 API 接收
2. 填写：
   - **URL**: `https://<你的公网域名>/webhook/wechat`
   - **Token**: 自定义字符串（32 位字母数字，如 `aB3dEf7hIjKlMnOpQrStUvWxYz123456`）
   - **EncodingAESKey**: 点击「随机生成」，43 位字符

3. 企业微信会向该 URL 发送验证请求（GET），DeepSeno 的 LAN Server 会自动处理

> **重要：** 企业微信使用 Webhook 方式推送消息，必须将 DeepSeno 的 LAN Server 暴露到公网。

### 3.3 公网暴露方案

**方案 A：ngrok（快速测试）**

```bash
# 安装 ngrok
brew install ngrok

# 暴露 DeepSeno LAN Server 端口
ngrok http 18526

# 获取公网地址，如 https://abc123.ngrok.io
# 回调 URL 填写: https://abc123.ngrok.io/webhook/wechat
```

**方案 B：frp（生产环境）**

```ini
# frpc.ini
[wechat-webhook]
type = https
local_port = 18526
custom_domains = deepseno.yourdomain.com
```

### 3.4 在 DeepSeno 中配置

打开 DeepSeno 设置页面 → 集成 → 企业微信：

| 配置项 | 说明 |
|-------|------|
| 企业 ID (Corp ID) | 企业微信管理后台「我的企业」页面 |
| 应用 ID (Agent ID) | 自建应用的 AgentId |
| 应用密钥 (Secret) | 自建应用的 Secret（本地加密存储） |
| Token | 设置 API 接收时填写的 Token |
| EncodingAESKey | 设置 API 接收时生成的 AES 密钥 |

点击「测试连接」验证配置，然后开启「启用」开关。

### 3.5 消息加密

企业微信的消息传输使用 **AES-256-CBC 加密**：

1. 接收消息时：验证 SHA1 签名 → AES 解密 → 去除 PKCS7 填充 → 解析 XML
2. DeepSeno 已内置完整的加解密实现，无需额外配置

### 3.6 支持的消息类型

- **文字消息** → AI Agent 处理
- **语音消息** → 通过 Media ID 下载 → 转写 → AI 处理

### 3.7 回复格式

企业微信支持 TextCard 类型消息：

```
┌──────────────────────┐
│ 转写结果              │
│                      │
│ 文件: meeting.wav    │
│ 时长: 30分钟          │
│ 关键待办: 2项         │
│                      │
│ [查看详情 >]          │
└──────────────────────┘
```

---

## 4. 钉钉机器人

### 4.1 创建应用

1. 登录 [钉钉开放平台](https://open-dev.dingtalk.com/)
2. 进入「应用开发」→「企业内部开发」→「创建应用」
3. 填写应用信息
4. 记录以下信息：
   - **App Key** — 应用凭证页面
   - **App Secret** — 应用凭证页面

### 4.2 添加机器人能力

1. 在应用管理页面 →「添加能力」→ 选择「机器人」
2. 配置机器人：
   - **消息接收地址**: `https://<你的公网域名>/webhook/dingtalk`
   - **机器人 Code (Robot Code)**: 系统自动生成，记录备用

### 4.3 配置权限

在「权限管理」中添加：

| 权限 | 用途 |
|------|------|
| 企业内机器人发送消息 | 发送回复消息 |
| 个人手机号信息 | （可选）识别用户 |

### 4.4 公网暴露

与企业微信相同，钉钉也使用 Webhook 推送，需要公网可达：

```bash
# 使用 ngrok
ngrok http 18526

# 回调 URL: https://abc123.ngrok.io/webhook/dingtalk
```

### 4.5 在 DeepSeno 中配置

打开 DeepSeno 设置页面 → 集成 → 钉钉：

| 配置项 | 说明 |
|-------|------|
| App Key | 钉钉应用凭证 |
| App Secret | 钉钉应用密钥（本地加密存储） |
| Robot Code | 机器人标识码 |

点击「测试连接」验证配置，然后开启「启用」开关。

### 4.6 Token 管理

钉钉使用 Access Token 认证，DeepSeno 自动处理：

- Token 有效期约 2 小时
- 到期前 5 分钟自动刷新
- 请求失败时自动重试一次（重新获取 Token）

### 4.7 支持的消息类型

- **文字消息** → AI Agent 处理
- **语音消息** → 通过 downloadCode 下载 → 转写 → AI 处理

### 4.8 回复格式

钉钉支持 ActionCard 和 Markdown 消息：

```
┌──────────────────────┐
│ 📋 转写结果            │
├──────────────────────┤
│ **文件**: meeting.wav │
│ **时长**: 30分钟       │
│ **说话人**: 2位        │
│                      │
│ ### 关键待办           │
│ - 准备汇报材料        │
│ - 确认预算            │
└──────────────────────┘
```

---

## 5. 通用说明

### 5.1 密钥安全

所有敏感信息（App Secret、Bot Token 等）在本地使用 **Electron safeStorage** 加密存储，绝不明文保存，也不会上传到任何云端。

### 5.2 LAN Server

DeepSeno 内置一个轻量 HTTP/WebSocket 服务（默认端口 `18526`），用于：

- 企业微信 Webhook 接收：`GET/POST /webhook/wechat`
- 钉钉 Webhook 接收：`POST /webhook/dingtalk`
- 移动端同步 API
- WebSocket 实时推送

> 飞书和 Telegram 不依赖此服务，分别使用 SDK WebSocket 和长轮询。

### 5.3 语音消息处理流程

```
语音消息到达
    │
    ▼
下载音频文件（各平台格式不同）
    │
    ▼
ffmpeg 转换为 16kHz 单声道 WAV
    │
    ▼
SenseVoice 实时转写（本地 ONNX）
    │
    ▼
AI Agent 处理（查询/备忘/待办识别）
    │
    ▼
发送结构化回复到原渠道
```

### 5.4 多渠道同时使用

所有渠道可以同时启用，互不影响。消息通过 `MessageRouter` 统一路由，AI Agent 共享同一套知识库和记忆系统。

### 5.5 测试连接

每个渠道在设置页面都提供「测试连接」按钮，可在启用前验证配置是否正确。测试会调用各平台的认证 API，验证凭证有效性。

### 5.6 常见问题

**Q: 企业微信/钉钉 Webhook 验证失败？**
A: 确认公网地址可达，且端口 18526 正确转发。使用 `curl https://你的地址/webhook/wechat` 测试连通性。

**Q: Telegram 连接超时？**
A: 检查网络是否能访问 `api.telegram.org`。如需代理，在系统设置中配置 HTTP 代理。

**Q: 飞书机器人收不到消息？**
A: 确认应用已发布并审批通过；确认事件订阅选择了 WebSocket 模式并添加了 `im.message.receive_v1` 事件。

**Q: 语音消息转写失败？**
A: 确认 sherpa-onnx 模型已下载完成（设置页面可查看状态）；确认 FFmpeg 已安装且在 PATH 中。
