# 公网接入重构方案：P2P 直连 + 服务端密文中转兜底

> 日期：2026-06-21
> 状态：设计阶段
> 取代：`2026-06-20-relay-api-proxy-design.md`（其中中转部分被保留为兜底路径）
> 取代：`docs/ops/frps-vps-setup.md`、`docs/ops/relay-custom-image.md` 及全部 frp 相关代码

---

## 1. 背景与目标

### 1.1 当前方案的问题

现有「公网接入」基于 **frp 隧道 + 每用户一台专属 VPS**：

- 每用户一台腾讯云 Lighthouse（¥40/月成本），售价 ¥59/月，毛利薄
- 需要 provision/deprovision 脚本管理 VPS 生命周期（开机、注入 token、防火墙、回收）
- frpc 进程管理 + frps 配置维护复杂
- 所有流量都过 VPS 中转，即使双方能直连也不行

### 1.2 新方案目标

**WebRTC P2P 直连优先 + 服务端密文中转兜底**：

- ❌ 去掉 VPS、frpc、frps、provision 脚本
- ✅ 扫码配对时 ECDH 协商端到端加密密钥
- ✅ WebRTC DataChannel 打洞直连，延迟低、服务端零流量
- ✅ 打洞失败自动回退服务端密文中转（用户无感）
- ✅ 桌面端复用现有 LanServer 全部路由，零改动
- ✅ 彻底删除 frp 旧代码

### 1.3 三层降级策略

```
用户请求
  │
  ▼
① WebRTC P2P 直连（优先）
  │  尝试 ICE 打洞，成功则直连
  │  预期覆盖 60-70% 用户（中国网络环境）
  │
  ▼ 打洞失败 / 超时
② 服务端密文中转（兜底）
  │  通过服务端 WebSocket 转发密文
  │  覆盖剩余 30-40% 用户
  │
  ▼ 两者都不可用
③ 离线（显示状态）
```

用户不需要选择，系统自动尝试 P2P → 失败回退中转 → 全程对上层 API 透明。

---

## 2. 架构总览

### 2.1 P2P 直连路径（优先）

```
┌──────────┐                                    ┌──────────┐
│  手机端   │                                    │  桌面端   │
│          │  ① 扫码配对 (ECDH 密钥协商)          │          │
│          │ ←═════════════════════════════════→ │          │
│          │         (经服务端信令中转)            │          │
│          │                                    │          │
│          │  ② ICE 候选交换 (WebRTC 信令)        │          │
│          │ ←═════════════════════════════════→ │          │
│          │         (经服务端信令中转)            │          │
│          │                                    │          │
│          │  ③ UDP 打洞直连                     │          │
│          │ ══════════════════════════════════> │          │
│          │ <══════════════════════════════════ │          │
│          │    AES-GCM 加密的应用数据             │          │
│          │    (DataChannel, DTLS 已加密但       │          │
│          │     我们再加应用层加密=双层)          │          │
└──────────┘                                    └──────────┘
         │
         │  服务端只在①②阶段参与（信令中转）
         │  ③阶段数据直传，服务端零流量
         ▼
┌────────────────────────┐
│      服务端 (Go/Gin)    │
│                        │
│  · 配对公钥交换中转     │
│  · WebRTC 信令中转     │
│  · STUN (自建 UDP)     │
│  · 密文中转兜底         │
│  · 订阅计费             │
└────────────────────────┘
```

### 2.2 中转兜底路径

```
┌──────────┐              ┌────────────────────────┐              ┌──────────┐
│  手机端   │              │      服务端 (Go/Gin)    │              │  桌面端   │
│          │              │                        │              │          │
│  密文请求 │  HTTPS       │  WebSocket 转发密文     │  WebSocket   │  解密处理 │
│ ────────────────────────→│  ──────────────────────→│              │          │
│ ←────────────────────────│  ←─────────────────────│              │          │
│          │              │  (只看到密文)           │              │          │
└──────────┘              └────────────────────────┘              └──────────┘
```

### 2.3 核心设计原则

1. **配对即绑定**：扫码完成 ECDH 密钥协商 + 设备绑定，后续不再依赖服务端做密钥分发
2. **服务端是信令中继 + 密文中继**：P2P 阶段只做信令中转，中转阶段只做密文转发
3. **端到端加密始终生效**：无论 P2P 还是中转，应用数据都用 ECDH 协商的 AES key 加密
4. **复用现有 LanServer**：桌面端解密后直接调 LanServer 的 handler，零改动

---

## 3. 核心流程

### 3.1 扫码配对（ECDH 密钥协商 + 设备绑定）

配对同时完成两件事：ECDH 密钥协商（端到端加密） + WebRTC 信令通道建立。

```
桌面端                          服务端                         手机端
  │                              │                              │
  │ 1. 生成 ECDH P-256 密钥对     │                              │
  │    desktopPriv / desktopPub  │                              │
  │                              │                              │
  │ 2. 连接服务端 WebSocket       │                              │
  │    (proof-of-possession 签名) │                              │
  │──────────────────────────────→│                             │
  │    注册: desktopPub + online  │                              │
  │                              │                              │
  │ 3. 展示二维码                 │                              │
  │    deepseno://pair?          │                              │
  │      key=<licenseKey>        │                              │
  │      mid=<machineId>         │                              │
  │      pub=<base64(desktopPub)>│                              │
  │      nonce=<base64(16B)>     │                              │
  │                              │                              │
  │                              │                    4. 扫码    │
  │                              │←──────────────────────────────│
  │                              │                    5. 生成 ECDH 密钥对
  │                              │                    phonePriv / phonePub
  │                              │                    sharedSecret = ECDH(phonePriv, desktopPub)
  │                              │                    aesKey = HKDF(sharedSecret, salt=nonce)
  │                              │                              │
  │                              │  6. POST /relay/pair          │
  │                              │←──────────────────────────────│
  │                              │  {phonePub, nonce, machineId} │
  │                              │                              │
  │  7. WebSocket 推送           │                              │
  │←─────────────────────────────│  {type:"pair", phonePub,      │
  │                              │   nonce, phoneWsId}          │
  │                              │                              │
  │  8. 验证 nonce 一致          │                              │
  │     sharedSecret = ECDH(desktopPriv, phonePub)              │
  │     aesKey = HKDF(sharedSecret, salt=nonce)                 │
  │     存储 aesKey              │                              │
  │                              │                              │
  │  9. WebSocket 回复           │                              │
  │──────────────────────────────→│  {type:"pair-ok"}           │
  │                              │                              │
  │                              │  10. 200 {paired:true}       │
  │                              │──────────────────────────────→│
  │                              │                              │
  │                              │                    11. 存储 aesKey
  │                              │                        配对完成 ✓
  │                              │                              │
  │                              │              12. 双方开始 WebRTC 信令交换 (见 3.2)
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

### 3.2 WebRTC 连接建立（ICE 打洞）

配对完成后，双方立即开始 WebRTC 信令交换，尝试 P2P 直连。

```
手机端                         服务端 (信令中转)                桌面端
  │                             │                              │
  │ 创建 RTCPeerConnection      │                              │
  │ iceServers: [               │                              │
  │   {urls:"stun:stun.l.google.com:19302"},                   │
  │   {urls:"stun:<自建STUN>:3478"},                            │
  │ ]                           │                              │
  │ createDataChannel("relay")  │                              │
  │ createOffer()               │                              │
  │                             │                              │
  │ 1. POST /relay/signal       │                              │
  │    {to: desktopWsId,        │                              │
  │     type:"offer",           │                              │
  │     sdp: "<offer SDP>"}     │                              │
  │──────────────────────────────→│                             │
  │                             │ WS: {type:"signal",          │
  │                             │      from: phoneWsId,        │
  │                             │      signalType:"offer",     │
  │                             │      sdp:"<offer>"}          │
  │                             │──────────────────────────────→│
  │                             │                              │
  │                             │                    setRemoteDescription(offer)
  │                             │                    createAnswer()
  │                             │                              │
  │                             │ 2. WS: {type:"signal",       │ ← desktop
  │                             │      signalType:"answer",    │
  │                             │      sdp:"<answer>"}         │
  │                             │←──────────────────────────────│
  │                             │                              │
  │ 200 {relayed:true}          │                              │
  │←──────────────────────────────│                             │
  │ setRemoteDescription(answer)│                              │
  │                             │                              │
  │ 3. 双方 ICE agent 并行收集候选地址:                         │
  │    - host 候选 (内网 IP)    │              - host 候选      │
  │    - srflx 候选 (STUN 反射) │              - srflx 候选     │
  │    (可能还有 relay 候选)    │                              │
  │                             │                              │
  │ 4. ICE 候选通过信令交换:    │                              │
  │ POST /relay/signal          │                              │
  │   {type:"ice-candidate",    │                              │
  │    candidate:{ip,port,...}} │                              │
  │──────────────────────────────→│──────────────────────────────→│
  │                             │                              │
  │                             │ ←──────────────────────────────│
  │                             │   (桌面端也交换自己的候选)    │
  │                             │                              │
  │ 5. ICE agent 自动尝试连接  │                              │  ICE agent 自动尝试连接
  │    往桌面端候选地址发 STUN  │                              │    往手机端候选地址发 STUN
  │    binding 请求             │                              │    binding 请求
  │                             │                              │
  │ 6. 某对候选地址打洞成功 ✅  │                              │
  │    ICE 连接建立             │                              │
  │    DTLS 握手完成            │                              │
  │    DataChannel "open"       │                              │
  │                             │                              │
  │ ←═══════════ P2P 通道就绪 ═══════════════════════════════→ │
  │    后续应用数据走 DataChannel                              │
  │    (再用 aesKey 加一层 AES-GCM)                           │
```

**ICE 候选类型**：
| 类型 | 来源 | 用途 |
|------|------|------|
| `host` | 本地网卡 IP | 同局域网直连（手机和电脑在同一 WiFi 时） |
| `srflx` | STUN 服务器反射 | 不同网络通过公网 IP 打洞 |
| `relay` | TURN 服务器 | 打洞失败时中继（我们不用 TURN，用服务端中转兜底） |

**打洞超时**：ICE 协商默认 30s 超时。我们设为 **15s**，超时即回退中转。

### 3.3 应用数据传输（P2P 直连模式）

P2P 通道建立后，所有请求通过 DataChannel 发送，应用层再用 ECDH 协商的 aesKey 加一层 AES-GCM 加密（WebRTC 的 DTLS 已加密，但我们要保证即使中转模式也用同样的加密格式，所以统一应用层加密）。

```
手机端                                                 桌面端
  │                                                     │
  │ 构建明文请求:                                        │
  │ {method:"POST", path:"/api/query-stream",           │
  │  headers:{...}, body:'{"question":"..."}'}          │
  │                                                     │
  │ AES-256-GCM 加密 → 密文 Frame(s)                    │
  │                                                     │
  │ DataChannel.send(密文)                              │
  │ ═══════════════════════════════════════════════════→│
  │                                                     │
  │                                       解密 → {method,path,...}
  │                                       调 LanServer handler
  │                                       加密响应
  │                                                     │
  │ DataChannel message event                           │
  │ ←═══════════════════════════════════════════════════│
  │                                                     │
  │ 解密 → 响应内容                                      │
```

### 3.4 应用数据传输（中转模式）

P2P 打洞失败时，同一套加密格式通过服务端 WebSocket 中转：

```
手机端                         服务端                         桌面端
  │                             │                              │
  │ 密文 Frame(s)               │                              │
  │ POST /relay/proxy           │                              │
  │──────────────────────────────→│                             │
  │                             │ WS: {type:"proxy",           │
  │                             │      id:"<uuid>",            │
  │                             │      data:"<base64密文>"}    │
  │                             │──────────────────────────────→│
  │                             │                              │
  │                             │              解密 → 调 LanServer → 加密响应
  │                             │                              │
  │                             │ WS: {type:"resp",            │
  │                             │      id:"<uuid>",            │
  │                             │      data:"<base64密文>"}    │
  │                             │←──────────────────────────────│
  │ 200 密文 Frame(s)           │                              │
  │←──────────────────────────────│                             │
  │                             │                              │
  │ 解密 → 响应                 │                              │
```

**关键：P2P 模式和中转模式用同一套加密分帧格式**，只是传输通道不同（DataChannel vs HTTP+WS）。桌面端解密后的处理逻辑完全一样。

### 3.5 大文件流式传输

以「录音上传 500MB」为例。无论 P2P 还是中转，都用同一套分块加密协议：

```
明文请求头 (Frame 0):
  {method:"POST", path:"/api/upload", headers:{...}}

明文 body 块 (Frame 1..N):
  <1MB 原始文件字节>

每个 Frame 独立 AES-GCM 加密后发送:
  Frame 0: ~200 bytes 密文
  Frame 1: ~1MB 密文
  Frame 2: ~1MB 密文
  ...
  Frame N: 最后一块
```

**P2P 模式**：DataChannel 配置 `maxRetransmits` 保证可靠性，逐块发送。DataChannel 自带背压控制（`bufferedAmountLowThreshold`），不会撑爆内存。

**中转模式**：HTTP chunked 上传 → 服务端 WebSocket 逐块转发 → 桌面端逐块接收解密写入临时文件。

### 3.6 实时事件推送（桌面端 → 手机端）

桌面端 LanServer 的 WebSocket 事件（管道进度、录音状态变更）推送给手机端：

**P2P 模式**：桌面端通过 DataChannel 发送加密事件。
**中转模式**：桌面端通过 WebSocket 发给服务端，服务端推给手机端的 WebSocket。

---

## 4. 模式选择与切换

### 4.1 连接状态机

```
                    ┌─────────┐
         配对完成 ──→│ PAIRING │
                    └────┬────┘
                         │ 开始 ICE 协商
                         ▼
                    ┌──────────┐
              ┌─────│NEGOTIATING│
              │     └──────────┘
              │            │
              │     ┌──────┴──────┐
              │     │             │
     ICE 成功 │     ▼             ▼ ICE 超时/失败 (15s)
              │ ┌────────┐  ┌─────────┐
              │ │  P2P   │  │FALLBACK │
              │ │DIRECT  │  │NEGOTIATE│
              │ └───┬────┘  └────┬────┘
              │     │            │ 走服务端中转
              │     │            ▼
              │     │       ┌─────────┐
              │     │       │ RELAY   │
              │     │       │ (中转)  │
              │     │       └────┬────┘
              │     │            │
              │     │    P2P 断开但中转可用
              │     │←───────────│
              │     │            │
              │     ▼            ▼
              │  ┌──────────────────┐
              └─→│   CONNECTED      │←── 应用层统一状态
                 │ (P2P 或 RELAY)   │
                 └──────────────────┘
                          │
                          │ 断线
                          ▼
                 ┌──────────┐
                 │DISCONNECTED│
                 └──────────┘
```

### 4.2 自动降级与恢复

| 场景 | 行为 |
|------|------|
| ICE 协商 15s 超时 | 切中转模式 |
| ICE 协商失败（无可用候选） | 立即切中转 |
| P2P 连接中断 | 自动切中转，同时后台重试 P2P |
| 中转也断开 | 指数退避重连，显示「断线」 |
| P2P 断线后恢复 | 后台每 60s 尝试一次 ICE 重协商，成功则切回 P2P |
| 网络切换（WiFi→4G） | DataChannel 检测断线 → 切中转 → 后台重试 P2P |

### 4.3 上层 API 统一

对手机端应用代码来说，不需要关心当前是 P2P 还是中转。统一接口：

```swift
// 手机端统一 API
class DeepSenoClient {
    // 发请求——自动选择 P2P 或中转
    func request(path: String, method: String, body: Data?) -> AsyncThrowingStream<Data, Error>

    // 当前连接状态
    var connectionMode: ConnectionMode  // .p2p / .relay / .disconnected
}
```

---

## 5. 协议设计

### 5.1 加密分帧格式（P2P 和中转通用）

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
- 每块明文大小：默认 **1MB**（P2P 模式可调小到 16KB 避免 DataChannel 消息过大）
- 每块的 nonce 随机生成

**P2P 模式分块大小**：DataChannel 消息建议不超过 16KB（`sctp.maxMessageSize` 通常 64KB-256KB，但大消息会分片影响性能）。所以 P2P 模式下 body 按 **16KB** 分块，中转模式按 **1MB** 分块。第一个 Frame（请求头）始终 < 1KB。

### 5.2 WebRTC 信令协议（经服务端中转）

**手机端 → 服务端 → 桌面端**：

| signalType | 用途 | payload |
|------------|------|---------|
| `offer` | WebRTC Offer SDP | `{sdp: string}` |
| `answer` | WebRTC Answer SDP | `{sdp: string}` |
| `ice-candidate` | ICE 候选地址 | `{candidate: RTCIceCandidateInit}` |
| `connected` | DataChannel 已建立 | — |
| `disconnected` | DataChannel 断开 | — |
| `renegotiate` | 请求重新 ICE 协商 | — |

信令消息通过两个 HTTP 接口或 WebSocket 传递：
- 桌面端：通过已建立的 WebSocket 连接（`/relay/ws`）
- 手机端：`POST /relay/signal` 或手机端 WebSocket（`/relay/client-ws`）

### 5.3 桌面端 WebSocket 协议（桌面端 → 服务端）

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

认证复用现有 proof-of-possession 机制（TOFU 绑定）。

**服务端 → 桌面端消息**：

| type | 用途 | 关键字段 |
|------|------|---------|
| `pair` | 配对请求 | `phonePub`, `nonce`, `phoneWsId` |
| `signal` | WebRTC 信令 | `from`, `signalType`, `sdp`/`candidate` |
| `proxy-start` | 中转请求开始 | `id` (请求UUID) |
| `proxy-frame` | 中转请求密文块 | `id`, `seq`, `data` (base64) |
| `proxy-end` | 请求传输完毕 | `id` |

**桌面端 → 服务端消息**：

| type | 用途 | 关键字段 |
|------|------|---------|
| `pair-ok` / `pair-reject` | 配对结果 | — |
| `signal` | WebRTC 信令 | `to`, `signalType`, `sdp`/`candidate` |
| `resp-start` | 中转响应开始 | `id`, `status` |
| `resp-frame` | 中转响应密文块 | `id`, `seq`, `data` |
| `resp-end` | 响应完毕 | `id` |
| `push` | 主动推送事件 | `enc` (base64密文) |
| `heartbeat` | 心跳 | — |

### 5.4 HTTP 接口（手机端 → 服务端）

#### `POST /api/v1/relay/pair` — 配对公钥交换

```
Headers: X-License-Key: <licenseKey>
Body (JSON, 公钥不是秘密):
{
  "machineId": "<桌面端 machineId>",
  "phonePubKey": "<base64 ECDH P-256 公钥>",
  "nonce": "<base64 16字节>"
}
```
响应：`{ "paired": true }`

#### `POST /api/v1/relay/signal` — WebRTC 信令

```
Headers: X-License-Key, X-Machine-Id
Body:
{
  "to": "<desktopWsId>",       // 目标桌面端 WebSocket ID
  "signalType": "offer|answer|ice-candidate|...",
  "sdp": "...",                 // offer/answer 时
  "candidate": {...}            // ice-candidate 时
}
```
响应：`{ "relayed": true }`

#### `POST /api/v1/relay/proxy` — 中转代理（兜底）

```
Headers: X-License-Key, X-Machine-Id
Body: application/octet-stream  // 加密 Frame 流
```
响应：`200` + 加密响应 Frame 流

#### `GET /api/v1/relay/client-ws` — 手机端 WebSocket（信令 + 推送）

```
Headers: X-License-Key, X-Machine-Id
```

双向通信：收信令推送、收事件推送、发信令。

---

## 6. STUN 服务器

### 6.1 方案：自建 STUN（唯一，不依赖任何外部服务）

不使用 Google 公共 STUN 或任何第三方 STUN。在现有 voicebrain-web 服务器上用 Go 实现轻量 STUN（一个 UDP 端口）：

```go
// internal/stun/server.go — 极简 STUN server (RFC 5389 Binding)
// 只实现 Binding 请求/响应，几十行代码
func StartSTUN(addr string) error {
    udpAddr, _ := net.ResolveUDPAddr("udp", addr)
    conn, err := net.ListenUDP("udp", udpAddr)
    // ...
    for {
        // 收到 STUN Binding Request → 回 Binding Response
        // Response 里 XOR-MAPPED-ADDRESS = 客户端公网 IP:Port
    }
}
```

```javascript
// WebRTC 配置 — 只用自建 STUN
const rtcConfig = {
  iceServers: [
    { urls: 'stun:<your-server>:3478' },  // 自建 STUN
  ],
  iceTransportPolicy: 'all',
};
```

### 6.2 防火墙

服务器需放行 UDP 3478（STUN）。TCP 不需要（STUN 走 UDP）。

---

## 7. 安全模型

### 7.1 威胁模型

| 威胁 | 防御 |
|------|------|
| 服务端被入侵，读取用户数据 | ECDH 端到端加密，服务端只有密文 |
| 中间人攻击（截获扫码/信令） | 二维码含 nonce，ECDH 公钥 + nonce 绑定验证 |
| License key 泄露 | proof-of-possession 证书签名（复用现有 TOFU） |
| P2P 链路被窃听 | 应用层 AES-GCM 加密（DTLS 之外再加一层） |
| 重放攻击 | 每块独立 nonce + GCM 认证 |
| 恶意设备配对 | 扫码需物理接触桌面端屏幕，配对需桌面端确认 |

### 7.2 双层加密说明

WebRTC DataChannel 自带 DTLS 加密，为什么还要应用层 AES-GCM？

1. **统一性**：P2P 和中转模式用同一套加密格式，桌面端解密逻辑只有一份
2. **密钥独立**：DTLS 密钥由 WebRTC 内部协商，我们无法控制；应用层 AES key 由 ECDH 协商，我们完全掌控
3. **防御深度**：即使 DTLS 实现有漏洞，应用层加密仍保护数据
4. **中转模式没有 DTLS**：中转走 HTTP+WebSocket，应用层加密是唯一保障

---

## 8. 服务端改动（voicebrain-web/api）

### 8.1 新增

| 文件 | 职责 |
|------|------|
| `internal/handler/relay_proxy.go` | `RelayProxyHandler`：配对、信令中转、中转代理、WebSocket 管理 |
| `internal/service/relay_hub.go` | `RelayHub`：管理 WebSocket 连接路由表，转发信令/请求/响应 |
| `internal/stun/server.go`（Phase 2） | 轻量 STUN UDP 服务 |

### 8.2 `RelayHub` 核心设计

```go
type RelayHub struct {
    mu        sync.RWMutex
    // key = "<userID>:<machineID>" → 桌面端 WebSocket 连接
    desktops map[string]*desktopConn
    // key = "<userID>:<machineID>" → 手机端 WebSocket 连接
    clients  map[string]*clientConn
    // 中转模式：key = requestUUID → 等待响应的 HTTP handler
    pending  map[string]chan *proxyResponse
}

type desktopConn struct {
    ws        *websocket.Conn
    wsID      string           // 唯一标识，手机端信令寻址用
    userID    uint64
    machineID string
    send      chan []byte       // buffered send queue
}

// P2P 信令转发：手机端 → 桌面端
func (h *RelayHub) RelaySignal(from clientConn, toWsID string, msg SignalMsg) error

// 中转代理：手机端 HTTP → 桌面端 WebSocket → 回来
func (h *RelayHub) Proxy(userID uint64, machineID string, body io.Reader) (io.Reader, int, error)

// 事件推送：桌面端 → 手机端
func (h *RelayHub) ForwardPush(userID uint64, machineID string, enc []byte) error
```

### 8.3 保留/改造/删除

| 组件 | 处理 |
|------|------|
| `RelaySubscription` 模型 | **保留** — 订阅计费不变 |
| `RelayInstance` 模型 | **删除** — 不再有 VPS |
| `relay_cert.go` (TOFU) | **保留** — WebSocket 认证复用 |
| `RelayCheckout` handler | **保留** — 订阅购买不变 |
| `relay_pricing.go` | **保留** — 定价不变 |
| `ScanExpiry` | **保留** — 过期扫描不变 |
| `FindActiveCredential` | **改造** — 只返回「订阅是否有效」，不再返回 VPS 凭证 |
| `BindInstance` / `ListSubscriptions` | **删除** |
| `crypto.go` (frp_token 加密) | **删除** — 不再有 frp token |

### 8.4 路由变更

```go
// 保留
v1.POST("/checkout/relay", relayHandler.RelayCheckout)

// 删除
// v1.GET("/relay/credential", ...)        → 不再需要 frp 凭证
// admin.POST("/relay/instances", ...)     → 不再需要 VPS 管理

// 新增
v1.POST("/relay/pair", credLimiter, relayProxyHandler.Pair)
v1.POST("/relay/signal", credLimiter, relayProxyHandler.Signal)
v1.POST("/relay/proxy", credLimiter, relayProxyHandler.Proxy)
v1.GET("/relay/ws", relayProxyHandler.DesktopWS)           // 桌面端 WebSocket
v1.GET("/relay/client-ws", relayProxyHandler.ClientWS)     // 手机端 WebSocket

// 保留（管理端）
admin.POST("/relay/subscriptions/:id/reset-binding", relayAdminHandler.ResetCertBinding)
```

### 8.5 数据库变更

```sql
-- 删除 relay_instances 表
DROP TABLE IF EXISTS relay_instances;

-- relay_subscriptions 保留（含 bound_cert_* 字段）
```

---

## 9. 桌面端改动（deepseno）

### 9.1 新增

| 文件 | 职责 |
|------|------|
| `src/main/server/relay-tunnel.ts` | `RelayTunnel`：连服务端 WebSocket，管理 P2P/中转双通道 |
| `src/main/server/relay-crypto.ts` | ECDH 密钥协商 + AES-GCM 加解密 + 分帧 |
| `src/main/server/relay-pairing.ts` | 扫码配对：生成二维码、处理配对请求、存储密钥 |
| `src/main/server/relay-webrtc.ts` | WebRTC 封装：PeerConnection、DataChannel、ICE 协商 |

### 9.2 `RelayTunnel` 核心设计

```typescript
export type RelayMode = 'p2p' | 'relay' | 'disconnected';

export class RelayTunnel {
  private ws: WebSocket | null = null;        // 到服务端的信令+中转 WebSocket
  private pc: RTCPeerConnection | null = null; // WebRTC P2P 连接
  private dc: RTCDataChannel | null = null;    // P2P 数据通道
  private crypto: RelayCrypto;
  private lanServer: LanServer;
  private mode: RelayMode = 'disconnected';

  constructor(lanServer: LanServer, licenseKey: string, machineId: string) { ... }

  // 连接服务端 WebSocket（信令 + 中转兜底）
  async connect(): Promise<void> { ... }

  // 开始 P2P 协商
  async startP2P(): Promise<void> { ... }

  // P2P 成功
  private onDataChannelOpen(): void {
    this.mode = 'p2p';
    // 中转通道保持但不主动用，P2P 断开时自动切回
  }

  // P2P 断开
  private onDataChannelClose(): void {
    this.mode = 'relay';  // 自动回退中转
    // 后台 60s 后重试 P2P
  }

  // 收到请求（P2P 或中转统一入口）
  private async handleRequest(encryptedFrames: Buffer[]): Promise<Buffer[]> {
    // 1. 解密 → {method, path, headers, body}
    // 2. 调 LanServer handler
    // 3. 加密响应 → 返回
    const { method, path, headers, body } = this.crypto.decryptRequest(encryptedFrames);
    const response = await this.lanServer.handleInternal(method, path, headers, body);
    return this.crypto.encryptResponse(response);
  }

  // 推送事件给手机端
  pushEvent(event: object): void {
    const enc = this.crypto.encryptFrame(JSON.stringify(event));
    if (this.mode === 'p2p' && this.dc?.readyState === 'open') {
      this.dc.send(enc);
    } else {
      this.ws?.send(JSON.stringify({ type: 'push', enc: enc.toString('base64') }));
    }
  }
}
```

### 9.3 LanServer 改动（极小）

LanServer 新增一个 `handleInternal` 方法，让 RelayTunnel 能直接调 Express 路由而不走真实网络：

```typescript
export class LanServer {
  // 新增：供 RelayTunnel 内部调用，不走真实 HTTP
  async handleInternal(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    // 构造 mock 请求/响应，丢给 this.app 处理
    // 不监听真实端口，纯内存调用
  }
}
```

LanServer 的全部路由（upload、query、segments、notes…）**零改动**。

### 9.4 settings.ts 变更

```typescript
// 删除
publicRelayEnabled: boolean;
relayServerAddr: string;
relayServerPort: number;
relayToken: string;
relayRemotePort: number;

// 新增
relayTunnelEnabled: boolean;      // 是否启用公网中转
// 不再需要 serverAddr/port/token — WebSocket URL 固定为 API base + /relay/ws
```

### 9.5 IPC 变更

```typescript
// 删除
relaySetCredential(cred)
relayStartProvisioningPoll()
relayStopProvisioningPoll()

// 保留（语义变化）
relayGetStatus()       // → { enabled, mode: 'p2p'|'relay'|'disconnected' }
relayEnable(enabled)   // → 启用/禁用隧道
relayGetSubscription() // → 查询订阅状态

// 新增
relayGetPairingQR()    // → { url, expiresAt }
relayUnpair()          // → 清除配对密钥
```

### 9.6 main.ts 变更

```typescript
// 删除
import { RelayClient } from './relay-client';
import { RelaySubscription } from './relay-subscription';
import { fetchRelayCredential } from './relay-credential';
// 删除所有 frp 相关 IPC handler

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

## 10. 手机端改动

### 10.1 配对流程

1. 调系统相机扫码
2. 解析 `deepseno://pair?pub=...&key=...&mid=...&nonce=...`
3. 生成 ECDH P-256 密钥对
4. 算共享密钥 + HKDF 派生 AES key
5. `POST /relay/pair` 上传手机公钥
6. 存储 aesKey 到 Keychain/Keystore

### 10.2 连接流程

1. `POST /relay/signal` 发送 WebRTC Offer
2. 收到 Answer → setRemoteDescription
3. 交换 ICE candidates
4. 等待 DataChannel open（15s 超时）
5. 成功 → P2P 模式；失败 → 中转模式

### 10.3 请求流程

1. 构建请求 JSON `{method, path, headers, body}`
2. AES-GCM 分块加密
3. P2P 模式：DataChannel.send
   中转模式：POST /relay/proxy
4. 接收加密响应，分块解密

---

## 11. 删除清单

### 11.1 客户端（deepseno）

| 路径 | 说明 |
|------|------|
| `src/main/server/relay-client.ts` | frpc 进程管理 |
| `src/main/server/relay-credential.ts` | frp 凭证获取 |
| `src/main/server/relay-subscription.ts` | 凭证轮询协调 |
| `src/main/server/__tests__/relay-*.test.ts` | 3 个测试文件 |
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

### 11.2 服务端（voicebrain-web/api）

| 路径 | 说明 |
|------|------|
| `internal/model/relay.go` 中 `RelayInstance` | 删除模型 |
| `internal/service/relay.go` 中 `BindInstance` | 删除 |
| `internal/handler/relay_admin.go` 中 `BindInstance` / `ListSubscriptions` | 删除 |
| `migrations/003_relay.sql` 中 `relay_instances` 表 | 删除 |
| `internal/service/crypto.go` 中 frp_token 加密 | 删除 |

### 11.3 保留

| 组件 | 原因 |
|------|------|
| `RelaySubscription` 模型 + 订阅计费 | 付费功能不变 |
| `relay_cert.go` (TOFU 证书绑定) | WebSocket 认证复用 |
| `RelayCheckout` handler | 购买流程不变 |
| `relay_pricing.go` | 定价不变 |
| `ScanExpiry` | 过期扫描不变 |
| `CertManager` | 桌面端证书管理不变 |

---

## 12. 实施计划

### Phase 1：服务端实现（不破坏现有功能）
1. 自建 STUN UDP 服务（`internal/stun/server.go`）
2. 新增 `RelayHub` + WebSocket 端点（桌面端 WS + 手机端 WS）
3. 新增 pair / signal / proxy 端点
4. 保留现有 `/relay/credential` 和 admin relay 端点（兼容期）
5. 单元测试
6. **预估：4-6 天**

### Phase 2：桌面端实现（中转模式先行）
1. 新增 `relay-crypto.ts`（ECDH + AES-GCM + 分帧）
2. 新增 `relay-tunnel.ts`（WebSocket 连接 + 中转代理）
3. 新增 `relay-pairing.ts`（扫码配对）
4. LanServer 加 `handleInternal` 方法
5. IPC + UI 改造
6. **此时只有中转模式可用，先跑通链路**
7. **预估：3-4 天**

### Phase 3：桌面端 WebRTC
1. 新增 `relay-webrtc.ts`（PeerConnection + DataChannel + ICE）
2. RelayTunnel 集成 P2P/中转自动切换
3. **预估：2-3 天**

### Phase 4：手机端实现
1. 扫码配对 + ECDH
2. WebRTC + 中转兜底
3. 加密请求/响应
4. WebSocket 推送接收
5. **预估：5-7 天**

### Phase 5：端到端联调
1. 中转模式跑通（Phase 2 成果）
2. P2P 模式跑通（Phase 3+4 成果）
3. 自动降级测试（杀 P2P → 切中转）
4. 大文件上传/播放测试
5. 各种 NAT 环境测试
6. **预估：3-4 天**

### Phase 6：切换 + 清理
1. 桌面端默认走新方案
2. 删除旧 frp 代码（第 11 节清单）
3. 服务端删除旧端点
4. 退订所有 Lighthouse VPS
5. **预估：1-2 天**

**总预估：17-25 天**

---

## 13. 待定问题

| # | 问题 | 倾向 |
|---|------|------|
| 1 | 多手机端配对 | 支持，每台手机独立 ECDH 密钥，桌面端按手机公钥索引 |
| 2 | 密钥过期/轮换 | 暂不做自动轮换；重新扫码即重新协商 |
| 3 | WebSocket 断线重连 | 指数退避，重连后重新注册到 RelayHub |
| 4 | 并发请求限制 | 单桌面端最多 3 个并发 proxy 请求 |
| 5 | 请求超时 | 普通请求 5 分钟；大文件上传 30 分钟 |
| 6 | 服务端 WebSocket 连接数 | 单服务器支撑 ~5000 桌面端长连接 |
| 7 | DataChannel 消息大小 | P2P 模式 body 按 16KB 分块，中转模式按 1MB |
| 8 | 自建 STUN | Phase 1 必须实现，不依赖任何外部服务 |
| 9 | iOS 后台 WebSocket 保活 | 可能需要 APNs 推送兜底（后续迭代） |
| 10 | P2P 重试间隔 | 断开后 60s 重试一次 ICE，最多 3 次，之后停止 |
| 11 | 是否需要桌面端确认配对 | Phase 1 自动确认（扫码即信任）；后续可加确认弹窗 |

---

## 14. 与旧方案对比

| 维度 | frp 方案 | 纯中转方案 | **P2P + 中转方案** |
|------|---------|-----------|-------------------|
| 端到端加密 | ✅ TLS 盲转发 | ✅ ECDH + AES-GCM | ✅ ECDH + AES-GCM |
| 服务端看到明文 | ❌ | ❌ | ❌ |
| 每用户成本 | ¥40/月 (VPS) | ¥0（共享服务器） | ¥0（共享服务器） |
| P2P 直连 | ❌ | ❌ | ✅ 60-70% 用户 |
| 延迟 | 中（过 VPS） | 中（过服务器） | **低（P2P 直连时）** |
| 服务端流量 | 全量 | 全量 | **30-40% 全量**（仅兜底用户） |
| 运维复杂度 | 高 | 中 | 中 |
| 桌面端依赖 | frpc 进程 | WebSocket | WebSocket + WebRTC |
| 打洞成功率（中国） | N/A | N/A | 60-70% |
