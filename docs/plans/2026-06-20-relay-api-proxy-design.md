# 公网中转重构方案：API 代理 + ECDH 端到端加密

> 日期：2026-06-20
> 状态：**已被取代** → 见 `2026-06-21-relay-p2p-design.md`
> 本文档的"服务端密文中转"部分已被整合进新方案作为 P2P 打洞失败时的兜底路径。
> 替代：`docs/ops/frps-vps-setup.md`、`docs/ops/relay-custom-image.md` 及全部 frp 相关代码

---

## 1. 背景与目标

### 1.1 当前方案的问题

现有「公网接入」基于 **frp 隧道 + 每用户一台专属 VPS**：

- 每用户一台腾讯云 Lighthouse（¥40/月成本），售价 ¥59/月，毛利薄
- 需要 provision/deprovision 脚本管理 VPS 生命周期（开机、注入 token、防火墙、回收）
- frpc 进程管理 + frps 配置维护复杂
- 证书 TOFU 绑定、frp_token 加密存储等机制重
- 整条链路涉及 6 个文件 + 2 个脚本 + 3 篇运维文档

### 1.2 新方案目标

**用服务端 API 中转替换 frp 隧道**，做到：

- ❌ 去掉 VPS、frpc、frps、provision 脚本
- ✅ 桌面端主动 WebSocket 连服务端（出站，不需要公网 IP）
- ✅ 手机端调服务端 HTTPS API
- ✅ 扫码完成 ECDH 密钥协商，服务端**只转发密文**
- ✅ 大文件流式中转，服务端不落盘
- ✅ 彻底删除旧代码

---

## 2. 架构总览

```
┌──────────┐              ┌────────────────────────┐              ┌──────────┐
│  手机端   │              │      服务端 (Go/Gin)    │              │  桌面端   │
│          │              │                        │              │          │
│  扫码配对 │              │  /api/v1/relay/pair    │   展示二维码  │          │
│ ────────────────────────→│  (公钥交换中转)         │←─────────────│ ECDH P-256│
│          │              │                        │              │          │
│ 算共享密钥│              │  WebSocket /relay/ws   │  算共享密钥  │          │
│          │              │←───────────────────────│              │          │
│          │              │  (长连接，license 认证)  │              │          │
│          │              │                        │              │          │
│ 密文请求  │              │  POST /api/v1/relay/   │              │          │
│ ────────────────────────→│  proxy                 │              │          │
│          │              │  ──WebSocket 转发密文──→│  解密处理    │          │
│          │              │←──WebSocket 回密文──────│              │          │
│ ←────────────────────────│  返回密文              │              │          │
│          │              │                        │              │          │
│ 大文件    │              │ (流式分块转发，不落盘)   │              │          │
│ ════════════════════════→│ ════WebSocket══════════→│              │          │
│ ←═══════════════════════│ ←══════════════════════│              │          │
└──────────┘              └────────────────────────┘              └──────────┘
```

### 核心设计原则

1. **服务端是密文中继站**：只做身份认证 + 连接路由 + 流式转发，看不到任何明文内容
2. **桌面端是真实服务方**：所有业务逻辑在桌面端本地执行，和现有 LanServer 完全复用
3. **扫码 = 密钥协商**：ECDH P-256，服务端只转公钥，拿不到共享密钥
4. **复用现有 LanServer**：桌面端解密后直接调 LanServer 的 handler，零改动

---

## 3. 核心流程

### 3.1 扫码配对（ECDH 密钥协商）

```
桌面端                          服务端                         手机端
  │                              │                              │
  │ 1. 生成 ECDH P-256 密钥对     │                              │
  │    desktopPriv / desktopPub  │                              │
  │                              │                              │
  │ 2. 展示二维码                 │                              │
  │    deepseno://pair?          │                              │
  │      key=<licenseKey>        │                              │
  │      mid=<machineId>         │                              │
  │      pub=<base64(desktopPub)>│                              │
  │      nonce=<base64(16B)>     │                              │
  │                              │                              │
  │                              │                    3. 扫码    │
  │                              │←──────────────────────────────│
  │                              │                    4. 生成自己的 ECDH 密钥对
  │                              │                    phonePriv / phonePub
  │                              │                    sharedSecret = ECDH(phonePriv, desktopPub)
  │                              │                    aesKey = HKDF(sharedSecret, salt=nonce)
  │                              │                              │
  │                              │  5. POST /relay/pair          │
  │                              │←──────────────────────────────│
  │                              │  {phonePub, nonce, machineId} │
  │                              │                              │
  │  6. WebSocket 推送           │                              │
  │←─────────────────────────────│  {type:"pair", phonePub, nonce}│
  │                              │                              │
  │  7. 验证 nonce 一致          │                              │
  │     sharedSecret = ECDH(desktopPriv, phonePub)              │
  │     aesKey = HKDF(sharedSecret, salt=nonce)                 │
  │     存储 aesKey              │                              │
  │                              │                              │
  │  8. WebSocket 回复           │                              │
  │──────────────────────────────→│  {type:"pair-ok"}           │
  │                              │                              │
  │                              │  9. 200 {paired:true}        │
  │                              │──────────────────────────────→│
  │                              │                              │
  │                              │                    10. 存储 aesKey
  │                              │                        配对完成 ✓
```

**密钥派生**：
```
sharedSecret = ECDH(myPrivKey, peerPubKey)   // P-256, 双方算出相同值
aesKey = HKDF-SHA256(
  ikm  = sharedSecret,
  salt = nonce,                               // 二维码里的 16 字节随机
  info = "deepseno-relay-v1",
  L    = 32                                   // 256-bit AES key
)
```

**密钥存储**：
- 桌面端：存在受保护数据目录（和现有 `lan-key.pem` 同级），`0600` 权限
- 手机端：存在 Keychain (iOS) / Keystore (Android)
- 密钥不随请求传输——配对时协商一次，后续复用

### 3.2 请求转发（手机端 → 桌面端）

以「RAG 问答」为例：

```
手机端                         服务端                         桌面端
  │                             │                              │
  │ 构建明文请求:                │                              │
  │ {method:"POST",             │                              │
  │  path:"/api/query-stream",  │                              │
  │  headers:{...},             │                              │
  │  body:'{"question":"..."}'} │                              │
  │                             │                              │
  │ AES-256-GCM 加密            │                              │
  │ → 密文 Frame                │                              │
  │                             │                              │
  │ POST /relay/proxy           │                              │
  │ X-License-Key: <key>        │                              │
  │ X-Machine-Id: <mid>         │                              │
  │ Body: <密文 Frame>          │                              │
  │──────────────────────────────→│                             │
  │                             │                              │
  │                             │ 验证 license                 │
  │                             │ 找 machineId 的 WS 连接       │
  │                             │                              │
  │                             │ WS: {type:"proxy",           │
  │                             │      id:"<uuid>",            │
  │                             │      data:"<base64密文>"}    │
  │                             │──────────────────────────────→│
  │                             │                              │
  │                             │                    解密 → {method,path,...}
  │                             │                    调 LanServer handler
  │                             │                    (onQueryStream)
  │                             │                    加密响应
  │                             │                              │
  │                             │ WS: {type:"resp",            │
  │                             │      id:"<uuid>",            │
  │                             │      data:"<base64密文>"}    │
  │                             │←──────────────────────────────│
  │                             │                              │
  │ 200 OK                      │                              │
  │ Body: <密文 Frame>          │                              │
  │←──────────────────────────────│                             │
  │                             │                              │
  │ 解密 → 响应内容             │                              │
```

### 3.3 大文件流式传输

以「录音上传 500MB」为例。手机端将文件分成 1MB 的块，每块独立 AES-GCM 加密，通过 HTTP chunked 流式发送。服务端逐块通过 WebSocket 转发，不缓冲完整文件。

```
手机端                         服务端                         桌面端

 POST /relay/proxy (chunked)
 X-License-Key / X-Machine-Id
│                             │                              │
│ Frame 0 (请求头密文)         │ WS: {type:"proxy-start",     │
│ ~200 bytes                  │      id:"<uuid>"}            │
│──────────────────────────────→│──────────────────────────────→│
│                             │                              │
│ Frame 1 (body 块 0, 1MB)    │ WS: {type:"proxy-frame",     │
│──────────────────────────────→│      id, seq:0, data}       │
│                             │──────────────────────────────→│
│ Frame 2 (body 块 1, 1MB)    │ WS: {type:"proxy-frame",     │
│──────────────────────────────→│      id, seq:1, data}       │
│                             │──────────────────────────────→│
│ ...                         │ ...                          │ → 逐块解密
│                             │                              │   写入临时文件
│ Frame N (最后一块)           │ WS: {type:"proxy-frame",     │
│──────────────────────────────→│      id, seq:N, data}       │
│                             │──────────────────────────────→│
│ (end of body)               │ WS: {type:"proxy-end",       │
│                             │      id}                     │
│                             │──────────────────────────────→│ → 全部接收完
│                             │                              │   解密请求头
│                             │                              │   调 upload handler
│                             │                              │   加密响应
│                             │ WS: {type:"resp-start",      │
│                             │      id, status:200}         │
│                             │←──────────────────────────────│
│                             │                              │
│ WS: {type:"resp-frame",     │                              │
│      id, seq:0, data}       │ 200 (chunked)                │
│←──────────────────────────────│ Frame 0                     │
│ ...                         │ ...                          │
│ WS: {type:"resp-end", id}   │                              │
│←──────────────────────────────│ (end)                       │
```

**关键点**：
- 服务端内存占用恒定（每块 1MB，转发完即释放）
- 桌面端逐块解密写入临时文件，不需要全部收完再处理
- 响应也分块加密流式返回（如音视频播放的 Range 请求）

### 3.4 实时事件推送（桌面端 → 手机端）

现有 LanServer 的 WebSocket 事件（管道进度、录音状态变更）需要通过中转推送到手机端。

桌面端检测到手机端在线时（通过服务端的 WebSocket 连接），将事件加密后推送：

```
桌面端 → 服务端 (WebSocket):
  {type:"push", enc:"<base64密文事件>"}

服务端 → 手机端:
  方案 A: 如果手机端也维持 WebSocket 长连接，直接推
  方案 B: 手机端轮询 GET /relay/poll
```

**推荐方案 A**：手机端也连一个 WebSocket 到服务端（轻量，只收推送），保持长连接。这样实时性和现有 frp 方案一致。

```
手机端                         服务端                         桌面端
  │                             │                              │
  │ WSS /relay/client-ws        │                              │
  │ X-License-Key               │                              │
  │──────────────────────────────→│                             │
  │ (长连接，等推送)            │                              │
  │                             │                              │
  │                             │      事件发生                │
  │                             │←──────────────────────────────│
  │                             │ WS: {type:"push",           │
  │                             │      enc:"<密文>"}          │
  │                             │                              │
  │ WS: {type:"push",           │                              │
  │      enc:"<密文>"}          │                              │
  │←──────────────────────────────│                             │
  │                             │                              │
  │ 解密 → {type:"pipeline",    │                              │
  │         progress: 0.65}     │                              │
```

---

## 4. 协议设计

### 4.1 加密分帧格式

所有请求/响应的明文被分成多个块，每块独立 AES-256-GCM 加密：

```
┌──────────────────────────────────────────────────┐
│ Frame (二进制)                                    │
├──────────┬──────────┬─────────────┬─────────────┤
│ length   │ nonce    │ ciphertext  │ tag         │
│ 4 bytes  │ 12 bytes │ N bytes     │ 16 bytes    │
│ (uint32) │ (随机)   │ (明文块加密) │ (GCM 认证)  │
└──────────┴──────────┴─────────────┴─────────────┘
```

- `length` = len(nonce) + len(ciphertext) + len(tag) = 12 + N + 16
- 每块明文大小：默认 **1MB**（平衡内存和开销）
- 每块的 nonce 随机生成，不重复即可（GCM 的安全要求）

**第一个 Frame（请求头）**解密后的明文 JSON：
```json
{
  "method": "POST",
  "path": "/api/upload",
  "headers": { "X-Filename": "meeting.wav" }
}
```

**后续 Frame（body 块）**解密后是 body 的原始字节。

**无 body 的请求**（如 GET）：只有请求头 Frame，无 body Frame。

### 4.2 WebSocket 连接协议（桌面端 → 服务端）

**连接**：
```
GET /api/v1/relay/ws
Headers:
  X-License-Key: <licenseKey>
  X-Machine-Id: <machineId>
  X-Cert-Timestamp: <unixSeconds>
  X-Cert-Signature: <RSA-SHA256 签名>
  X-Cert-Fingerprint: <证书指纹>
```

认证复用现有 proof-of-possession 机制（TOFU 绑定），桌面端用 CertManager 的自签证书签名。

**服务端 → 桌面端消息**：

| type | 用途 | 关键字段 |
|------|------|---------|
| `pair` | 配对请求 | `phonePub`, `nonce` |
| `proxy-start` | 转发请求开始 | `id` (请求UUID) |
| `proxy-frame` | 转发请求密文块 | `id`, `seq`, `data` (base64) |
| `proxy-end` | 请求传输完毕 | `id` |

**桌面端 → 服务端消息**：

| type | 用途 | 关键字段 |
|------|------|---------|
| `pair-ok` | 配对成功 | — |
| `pair-reject` | 配对拒绝 | `reason` |
| `resp-start` | 响应开始 | `id`, `status` (HTTP状态码) |
| `resp-frame` | 响应密文块 | `id`, `seq`, `data` (base64) |
| `resp-end` | 响应完毕 | `id` |
| `push` | 主动推送事件 | `enc` (base64密文) |
| `heartbeat` | 心跳 | — |

### 4.3 HTTP 接口（手机端 → 服务端）

#### `POST /api/v1/relay/proxy` — 统一代理入口

```
Headers:
  X-License-Key: <licenseKey>     // 必填，身份认证
  X-Machine-Id: <machineId>       // 必填，路由到哪台桌面端
Body: application/octet-stream    // 加密 Frame 流
```

响应：
```
200 OK
Body: application/octet-stream    // 加密响应 Frame 流
```

状态码：
- `200` 成功（body 是加密响应流）
- `400` 缺少 headers
- `401` license 无效
- `403` license 未绑定到用户
- `404` 桌面端不在线
- `410` 订阅已过期
- `429` 限流

#### `POST /api/v1/relay/pair` — 配对公钥交换

```
Headers:
  X-License-Key: <licenseKey>
Body (JSON, 明文——公钥本身不是秘密):
{
  "machineId": "<桌面端 machineId>",
  "phonePubKey": "<base64 ECDH P-256 公钥>",
  "nonce": "<base64 16字节>"
}
```

响应：
```json
{ "paired": true }
```

服务端收到后通过桌面端的 WebSocket 连接推送 `{type:"pair", phonePubKey, nonce}`，等桌面端回复 `pair-ok` 后返回 200。

#### `GET /api/v1/relay/client-ws` — 手机端 WebSocket（收推送）

```
Headers:
  X-License-Key: <licenseKey>
  X-Machine-Id: <machineId>
```

连接成功后服务端推送 `{type:"push", enc:"<base64密文>"}` 消息。

---

## 5. 安全模型

### 5.1 威胁模型

| 威胁 | 防御 |
|------|------|
| 服务端被入侵，读取用户数据 | ECDH 端到端加密，服务端只有密文 |
| 中间人攻击（截获扫码） | 二维码含 nonce，ECDH 公钥 + nonce 绑定验证 |
| License key 泄露，他人冒充 | proof-of-possession 证书签名（复用现有 TOFU 机制） |
| 重放攻击 | 每块独立 nonce + GCM 认证；配对 nonce 一次性 |
| 暴力探测 | 限流 10 次/分钟（复用现有限流） |

### 5.2 与旧方案对比

| 维度 | frp 方案 | 新 API 中转方案 |
|------|---------|----------------|
| 端到端加密 | ✅ TLS 盲转发 | ✅ ECDH + AES-GCM |
| 服务端看到明文 | ❌ 否 | ❌ 否（只有密文） |
| 服务端知道请求路径 | ❌ 否（TCP 盲转发） | ❌ 否（path 在密文里） |
| 每用户成本 | ¥40/月 (VPS) | ¥0（复用现有服务器） |
| 桌面端依赖 | frpc 进程 | WebSocket 连接（in-process） |
| 运维复杂度 | 高（provision/防火墙/镜像） | 低（服务端一个端点） |
| 大文件传输 | TCP 隧道直传 | 流式密文分帧中转 |

### 5.3 安全降级点

新方案**没有**安全降级——服务端依然看不到明文。唯一的区别是：
- frp 方案：TLS 在传输层，frps 看到的是 TLS 密文流
- 新方案：AES-GCM 在应用层，服务端看到的是 AES 密文流

两者对服务端都是「盲转发」，安全等价。

---

## 6. 服务端改动（voicebrain-web/api）

### 6.1 新增

| 文件 | 职责 |
|------|------|
| `internal/handler/relay_proxy.go` | `RelayProxyHandler`：`/relay/proxy`、`/relay/pair`、`/relay/client-ws` |
| `internal/service/relay_hub.go` | `RelayHub`：管理 license→WebSocket 连接路由表，转发请求/响应 |
| `internal/handler/relay_checkout.go` | 保留现有 `RelayCheckout`（订阅购买，不变） |

### 6.2 `RelayHub` 核心设计

```go
// RelayHub 管理所有桌面端的 WebSocket 连接，按 license+machine 路由请求。
type RelayHub struct {
    mu    sync.RWMutex
    // key = "<userID>:<machineID>" → 桌面端连接
    conns map[string]*desktopConn
    // key = requestUUID → 等待响应的 HTTP handler
    pending map[string]chan *proxyResponse
    // key = "<userID>:<machineID>" → 手机端推送连接
    pushConns map[string]*pushConn
}

type desktopConn struct {
    ws       *websocket.Conn
    userID   uint64
    machineID string
    send     chan []byte  // buffered send queue
}
```

**核心方法**：
- `RegisterDesktop(userID, machineID, ws)` — 桌面端连上时注册
- `UnregisterDesktop(userID, machineID)` — 断开时移除
- `Proxy(userID, machineID, body io.Reader) (io.Reader, int, error)` — 转发请求，返回响应流
- `ForwardPush(userID, machineID, enc []byte)` — 桌面端推事件给手机端

### 6.3 保留/改造

| 组件 | 处理 |
|------|------|
| `RelaySubscription` 模型 | **保留**——订阅计费不变 |
| `RelayInstance` 模型 | **删除**——不再有 VPS 实例 |
| `relay_cert.go` (TOFU) | **保留**——桌面端 WebSocket 认证复用 |
| `BindInstance` / `ListSubscriptions` / `ResetCertBinding` | **删除** |
| `RelayCheckout` handler | **保留**——订阅购买流程不变 |
| `relay_pricing.go` | **保留**——价格不变 |
| `ScanExpiry` | **保留**——过期扫描不变 |
| `FindActiveCredential` | **改造**——不再返回 VPS 凭证，只返回「订阅是否有效」 |
| `crypto.go` (frp_token 加密) | **删除**——不再有 frp token |

### 6.4 路由变更

```go
// 保留
v1.POST("/checkout/relay", relayHandler.RelayCheckout)

// 删除
// v1.GET("/relay/credential", ...)        → 不再需要 frp 凭证
// admin.POST("/relay/instances", ...)     → 不再需要 VPS 管理
// admin.POST("/relay/subscriptions/:id/reset-binding", ...) → 保留（重置 cert 绑定仍有用）

// 新增
v1.POST("/relay/pair", credLimiter, relayProxyHandler.Pair)         // 配对
v1.POST("/relay/proxy", credLimiter, relayProxyHandler.Proxy)       // 统一代理
v1.GET("/relay/ws", relayProxyHandler.DesktopWS)                    // 桌面端 WebSocket
v1.GET("/relay/client-ws", relayProxyHandler.ClientWS)              // 手机端 WebSocket（推送）
```

### 6.5 数据库变更

```sql
-- 删除 relay_instances 表（不再有 VPS）
DROP TABLE IF EXISTS relay_instances;

-- relay_subscriptions 保留，删除 VPS 相关字段无需改（本来就没有 VPS 字段）
-- 保留：bound_cert_fingerprint / bound_cert_pubkey_der / cert_bound_at（WebSocket 认证用）
```

---

## 7. 桌面端改动（deepseno）

### 7.1 新增

| 文件 | 职责 |
|------|------|
| `src/main/server/relay-tunnel.ts` | `RelayTunnel`：连服务端 WebSocket，接收转发请求，调 LanServer handler 处理，加密返回 |
| `src/main/server/relay-crypto.ts` | ECDH 密钥协商 + AES-GCM 加解密 + 分帧 |
| `src/main/server/relay-pairing.ts` | 扫码配对：生成二维码、处理配对请求、存储密钥 |

### 7.2 `RelayTunnel` 核心设计

```typescript
export class RelayTunnel {
  private ws: WebSocket | null = null;
  private crypto: RelayCrypto;        // 加解密
  private lanServer: LanServer;       // 复用现有 LanServer
  private status: 'disconnected' | 'connecting' | 'connected' = 'disconnected';

  constructor(lanServer: LanServer, licenseKey: string, machineId: string) { ... }

  // 连接服务端 WebSocket
  async connect(): Promise<void> { ... }

  // 断开
  disconnect(): void { ... }

  // 收到转发请求：解密 → 调 LanServer handler → 加密响应 → 回传
  private async handleProxyRequest(frames: Buffer[]): Promise<void> {
    // 1. 解密第一个 frame → 请求头 {method, path, headers}
    // 2. 解密后续 frames → body
    // 3. 内部构造 HTTP 请求调 LanServer 的 express app
    // 4. 拿到响应 → 分块加密 → 通过 WebSocket 回传
  }

  // 推送事件给手机端
  pushEvent(event: object): void {
    const enc = this.crypto.encryptFrame(JSON.stringify(event));
    this.ws?.send(JSON.stringify({ type: 'push', enc: enc.toString('base64') }));
  }
}
```

**关键：复用 LanServer 而非重新实现**

桌面端收到解密后的 `{method, path, headers, body}`，不需要重新实现路由，而是直接向 LanServer 的 Express app 发一个内部请求：

```typescript
// 方案：直接调 Express 的 app.handle()，不走真实网络
const mockReq = httpMocks.createRequest({ method, path, headers, body });
const mockRes = httpMocks.createResponse();
this.lanServer.app(mockReq, mockRes);
// 拿到 mockRes 的 status / headers / body → 加密返回
```

这样 LanServer 的全部路由（upload、query、segments、notes…）**零改动**。

### 7.3 settings.ts 变更

```typescript
// 删除
publicRelayEnabled: boolean;
relayServerAddr: string;
relayServerPort: number;
relayToken: string;       // frp token
relayRemotePort: number;

// 新增
relayTunnelEnabled: boolean;      // 是否启用公网中转
// 不再需要 serverAddr/port/token——WebSocket URL 固定为 API base + /relay/ws
```

### 7.4 IPC 变更

```typescript
// 删除
relaySetCredential(cred)
relayStartProvisioningPoll()
relayStopProvisioningPoll()

// 保留（语义变化）
relayGetStatus()     // → { enabled, status: 'connected'|'disconnected'|'connecting' }
relayEnable(enabled) // → 启用/禁用 WebSocket 隧道
relayGetSubscription() // → 查询订阅状态（调服务端）

// 新增
relayGetPairingQR()  // → 返回二维码内容 { url, expiresAt }
relayUnpair()        // → 清除配对密钥
```

### 7.5 main.ts 变更

```typescript
// 删除
import { RelayClient } from './relay-client';
import { RelaySubscription } from './relay-subscription';
import { fetchRelayCredential } from './relay-credential';
let relayClient: RelayClient | null = null;
let relaySubscription: RelaySubscription | null = null;
function startRelay() { ... }
// 所有 relay:* IPC handler 重写

// 新增
import { RelayTunnel } from './relay-tunnel';
let relayTunnel: RelayTunnel | null = null;

function startRelayTunnel(): void {
  const s = loadSettings();
  if (!s.relayTunnelEnabled || !s.licenseKey) return;
  if (relayTunnel) relayTunnel.disconnect();
  relayTunnel = new RelayTunnel(lanServer!, s.licenseKey, getMachineId());
  relayTunnel.connect();
}
```

---

## 8. 手机端改动

### 8.1 配对流程

1. 调系统相机扫码
2. 解析 `deepseno://pair?pub=...&key=...&mid=...&nonce=...`
3. 生成 ECDH P-256 密钥对
4. 算共享密钥 + HKDF 派生 AES key
5. `POST /relay/pair` 上传手机公钥
6. 存储 aesKey 到 Keychain/Keystore

### 8.2 请求流程

1. 构建请求 JSON `{method, path, headers, body}`
2. AES-GCM 分块加密
3. `POST /relay/proxy` 发送密文流
4. 接收加密响应流，分块解密
5. 得到原始响应

### 8.3 推送接收

维持一个 WebSocket 连接到 `/relay/client-ws`，收到 `{type:"push", enc}` 后解密处理。

---

## 9. 删除清单

### 9.1 客户端（deepseno）

| 路径 | 说明 |
|------|------|
| `src/main/server/relay-client.ts` | frpc 进程管理 |
| `src/main/server/relay-credential.ts` | frp 凭证获取 |
| `src/main/server/relay-subscription.ts` | 凭证轮询协调 |
| `src/main/server/__tests__/relay-client.test.ts` | |
| `src/main/server/__tests__/relay-credential.test.ts` | |
| `src/main/server/__tests__/relay-subscription.test.ts` | |
| `scripts/provision-relay-vps.mjs` | VPS 开通脚本 |
| `scripts/deprovision-relay-vps.mjs` | VPS 回收脚本 |
| `scripts/__tests__/provision-report.test.mjs` | |
| `scripts/bundle-frp.sh` | frpc 下载脚本 |
| `resources/frp/` | frpc 二进制 |
| `docs/ops/frps-vps-setup.md` | frps 部署指南 |
| `docs/ops/frps.toml.template` | frps 配置模板 |
| `docs/ops/relay-custom-image.md` | 自定义镜像指南 |
| `docs/plans/2026-05-22-public-network-relay*.md` | 旧设计文档 |
| `package.json` 中 `resources/frp` 打包配置 | |

### 9.2 服务端（voicebrain-web/api）

| 路径 | 说明 |
|------|------|
| `internal/model/relay.go` 中 `RelayInstance` | 删除模型 |
| `internal/service/relay.go` 中 `BindInstance` / `FindActiveCredential`(改造) | 删除/改造 |
| `internal/handler/relay_admin.go` 中 `BindInstance` / `ListSubscriptions` | 删除 |
| `migrations/003_relay.sql` 中 `relay_instances` 表 | 删除 |
| `internal/service/crypto.go` 中 frp_token 加密 | 删除 |
| `scripts/provision-relay-vps.mjs` (如果服务端也有) | 删除 |

### 9.3 保留

| 组件 | 原因 |
|------|------|
| `RelaySubscription` 模型 + 订阅计费 | 付费功能不变 |
| `relay_cert.go` (TOFU 证书绑定) | WebSocket 认证复用 |
| `RelayCheckout` handler | 购买流程不变 |
| `relay_pricing.go` | 定价不变 |
| `ScanExpiry` | 过期扫描不变 |
| `CertManager` | 桌面端证书管理不变 |

---

## 10. 迁移计划

### Phase 1：服务端实现（不破坏现有功能）
1. 新增 `RelayHub` + WebSocket 端点 + proxy 端点
2. 新增 pair 端点
3. 保留现有 `/relay/credential` 和 admin relay 端点（兼容期）
4. 单元测试

### Phase 2：桌面端实现
1. 新增 `relay-tunnel.ts` + `relay-crypto.ts` + `relay-pairing.ts`
2. 新增 IPC handler
3. UI 改造（配对二维码页面）
4. **不删除**旧 frp 代码（兼容期并行）

### Phase 3：手机端实现
1. 扫码配对
2. 加密请求/响应
3. WebSocket 推送接收

### Phase 4：端到端联调
1. 桌面端 + 服务端 + 手机端跑通完整链路
2. 大文件上传/播放测试
3. 性能测试（延迟、吞吐）

### Phase 5：切换 + 清理
1. 桌面端默认走新方案
2. 删除旧 frp 代码（第 9 节清单）
3. 服务端删除旧端点
4. 删除 VPS（退订所有 Lighthouse 实例）

---

## 11. 待定问题

| # | 问题 | 倾向 |
|---|------|------|
| 1 | 多手机端配对：一个桌面端能否同时配多台手机？ | 支持，每台手机独立 ECDH 密钥，桌面端按手机公钥索引 |
| 2 | 密钥过期/轮换 | 暂不做自动轮换；重新扫码即重新协商 |
| 3 | WebSocket 断线重连 | 指数退避重连，重连后重新注册到 RelayHub |
| 4 | 并发请求限制 | 单桌面端最多 3 个并发 proxy 请求（防资源耗尽） |
| 5 | 请求超时 | 单请求 5 分钟（RAG 流式可能较慢）；大文件上传 30 分钟 |
| 6 | 服务端 WebSocket 连接数 | 单服务器支撑 ~5000 桌面端长连接（Go goroutine 轻量） |
| 7 | Base64 开销（33%） | 可优化为 WebSocket 二进制帧，后续性能调优时做 |
| 8 | 手机端 WebSocket 保活 | iOS 后台限制，可能需要 APNs 推送兜底（后续迭代） |
