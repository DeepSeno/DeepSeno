# DeepSeno (铸声) 项目文档

本文档供开发者与 AI 助手参考，描述项目结构、技术约定与已知风险点。

## 协作约定
- 仓库内沟通、注释、提交说明默认使用中文，保持表达专业、简洁、准确。
- 不擅自引入与当前任务无关的改动（依赖、配置、格式化），保持 diff 聚焦。
- 涉及安全、构建、发布的改动需在 PR 描述中明确说明影响范围与验证方式。

## 代码修改后的强制回测
- 每次修改代码后，必须根据改动范围执行回归验证；不能只说明“理论上已修复”或只做静态检查。
- 优先运行与改动直接相关的定向测试，例如 `pnpm exec vitest run <test-files>`；若改动触及共享逻辑、IPC、处理管线、数据模型或跨页面状态，需补充更大范围的相关测试。
- 提交前必须至少运行一次 `pnpm build`，确认主进程、preload 和渲染层都能通过生产构建。
- 涉及 UI、文件导入、Electron 原生能力、模型下载、流式输出、跨页面状态恢复等用户可见链路时，必须启动 `pnpm dev`，使用真实应用回测；需要调试浏览器时使用 `agent-browser` 连接调试端口，文件导入需选用本机真实样例文件验证。
- 修复导入/处理类问题时，必须验证任务进入队列、状态推进、落库结果和最终 UI 状态；不能只验证文件选择或只验证 API 返回。
- 修复异步状态、下载进度、流式输出或队列竞态时，必须验证过程中状态不会回退、不会被重复任务互相覆盖，并验证页面切换后状态仍可恢复。
- 如果某项验证因环境限制无法执行，必须在最终回复和提交说明中明确写出未验证项、阻塞原因、已执行的替代验证，以及残余风险。

## 项目概览
跨平台（macOS + Windows）Electron 桌面应用，定位为本地 AI 语音第二大脑。核心流程：
录音 → ASR → 说话人分离 → 文本优化 → 信息提取 → RAG 问答，全部本地运行，不依赖云端推理。

- 应用名（package name）：`deepseno`
- 包管理器：`pnpm`
- 渲染层：React 19 + Vite 7 + Tailwind CSS 4
- 主进程：Electron 42 + TypeScript
- 构建工具：electron-vite + electron-builder
- 主开发者机器：Apple M5 Max, 128GB, macOS 26.3.1 (Tahoe)

## 已知环境问题：llama.cpp ≥ 0.20 + Apple M5 + macOS 26.x
llama.cpp 0.20+ 的 Metal shader 使用 `MPPTensorOpsMatMul2d` 模板，在 macOS 26.x / M5 GPU 上触发 `static_assert` 失败，导致模型加载崩溃。
- `OLLAMA_LLM_LIBRARY=cpu`、`GGML_METAL_DISABLE=1` 等参数**无效**（Metal 编译在这些参数读取之前发生）
- **解决方案：固定 llama.cpp 到 0.18.2**
- 诊断逻辑见 `src/main/llm/llama.cpp-diagnostics.ts`

## 模型清单

### ONNX 模型（sherpa-onnx-node，in-process，约 263MB）
| 模型 | 大小 | 用途 |
|------|------|------|
| SenseVoice ASR | ~200MB | 多语言语音识别（zh/en/ja/ko/yue） |
| Silero VAD | ~100KB | 语音活动检测，切分静音段 |
| pyannote 说话人分离 | ~4MB | 自动分段 + 识别说话人数量 |
| 3DSpeaker 声纹 | ~80MB | 声纹嵌入提取，聚类判断说话人身份 |

### llama.cpp LLM 模型（Qwen3.5 系列，按硬件自动推荐）
- `qwen3.5:4b`（默认，≥6GB）— 文本清洗 / 批量任务降级
- `qwen3.5:9b`（≥10GB）
- `qwen3.5:27b`（≥22GB）
- `qwen3.5:35b`（≥30GB）
- `qwen3.5:122b`（≥88GB）
- 嵌入模型：`bge-m3`（1024 维向量，用于 RAG 语义检索）

### 外部 AI 服务（可选）
- 支持配置 OpenAI 格式的云端 API（设置页「外部 AI 服务」）
- 通过 `cloud:listModels` IPC 动态拉取服务商模型列表
- 主进程 handler 对失败做兜底（返回空列表）

## 架构要点
```
Electron Main Process
├── SherpaEngine     → SenseVoice + Silero VAD + pyannote + 3DSpeaker
├── llama.cppClient      → Qwen3.5（清洗/摘要/RAG）+ bge-m3（嵌入）
├── OpenAIClient      → 外部 OpenAI 格式云端 API（可选）
├── VoiceBrainDB      → Node.js 24 native SQLite（WAL + FTS5）
├── VectorStore       → sqlite-vec（1024 维嵌入）
├── Processor         → 10 步管道（见下）
├── TaskQueue         → 顺序队列，崩溃恢复，暂停/取消/重试
├── TaskScheduler     → 30s 轮询，8 种预定义动作
├── Agent             → 工具调用 + 知识编译 + 记忆管理
├── Channels          → 飞书/微信/钉钉/电报/邮件
├── LanServer         → Express + WebSocket（局域网/手机端同步）
└── License           → Open Core（Free + Pro）
```

Processor 10 步管道：
转码 → VAD → 转写 → 说话人分离 → LLM 校正 → 文本优化 → 信息提取 → 索引 → Markdown 生成 → 后台记忆。

## 关键路径
- `electron/main.ts` — 主进程入口
- `electron/preload.ts` — contextBridge API（渲染层可调用的 IPC 白名单）
- `src/main/audio/sherpa-engine.ts` — SherpaEngine 单例
- `src/main/audio/sherpa-model-manager.ts` — ONNX 模型下载管理
- `src/main/pipeline/processor.ts` — 10 步管道
- `src/main/pipeline/task-queue.ts` — 任务队列
- `src/main/llm/llama.cpp-client.ts` — llama.cpp REST 客户端
- `src/main/llm/openai-client.ts` — 外部 OpenAI 格式云端客户端
- `src/main/llm/text-optimizer.ts` — 文本优化器
- `src/main/rag/query-engine.ts` — RAG 问答引擎
- `src/main/rag/vector-store.ts` — sqlite-vec 向量存储
- `src/main/db/database.ts` — VoiceBrainDB
- `src/main/ipc/` — 按域拆分的 IPC handler（system / integration 等）
- `src/main/hardware-detector.ts` — 硬件检测 + 模型推荐
- `src/main/scheduler/task-scheduler.ts` — 定时任务调度
- `src/main/agent/` — Agent 系统（工具 / 知识编译 / 记忆 / 洞察）
- `src/main/server/lan-server.ts` — 局域网服务（手机端上传、同步）
- `src/renderer/pages/` — React 页面（22 个）
- `src/renderer/hooks/useApi.ts` — 渲染层 IPC 封装（含 `useApi.mock.ts` 测试桩）

## 数据库 Schema (SQLite)
- `recordings` — id, file_path, file_name, duration_seconds, recorded_at, processed_at, status
- `speakers` — id, name, voice_signature, notes, created_at
- `segments` — id, recording_id, speaker_id, start_time, end_time, raw_text, clean_text
- `segments_fts` — FTS5 虚拟表（全文搜索 raw_text/clean_text）
- `extracted_items` — id, segment_id, type (todo/meeting/decision/contact/number), content, due_date, related_person, status
- `daily_summaries` — id, date, summary_text, timeline_json, key_events_json

## 定时报告与预定义动作
日报/周报/月报由 `TaskScheduler`（`src/main/scheduler/task-scheduler.ts`）每 30s 轮询执行。
- **`scheduled_tasks` 表是单一事实源**，settings 字段仅作 seed 时的默认值
- 预定义动作共 8 个：daily_report、weekly_report、monthly_report、insight_scan、todo_reminder、todo_summary、knowledge_audit、memory_compact
- 月报直接聚合日报，不依赖周报

## 开发约定

### IPC
- 新增能力需三处同步：主进程 `ipcMain.handle` + `electron/preload.ts` 暴露 + `useApi.ts`（及 `useApi.mock.ts`）类型与封装
- IPC 命名采用 `域:动作` 形式（如 `cloud:listModels`、`externalSources:syncNow`）
- handler 内部对外部网络/CLI 调用要有异常兜底

### 数据库与迁移
- 所有建表 / 建索引使用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
- 新增表遵循既有命名风格，外部数据源相关表统一 `external_*` 前缀

### 安全
- 调试端口仅在 `!app.isPackaged` 时开启，禁止在打包版本暴露
- 调用外部 CLI 使用参数数组形式，避免 shell 注入；日志需对敏感字段脱敏
- 凭证优先交由操作系统密钥链管理，不在应用内明文持久化

### 提交与分支
- 提交信息遵循 Conventional Commits（`feat` / `fix` / `chore` / `docs` 等）
- 功能分支合并前先 rebase 到最新 `main`
- 同时改动 `package.json` 的多个分支合并后，需重新生成 `pnpm-lock.yaml` 并执行 native rebuild

## 环境变量
- `DEEPSENO_DATA_DIR` — 覆盖数据目录（默认：`<userData>/deepseno`）
- `DEEPSENO_DB_PATH` — 覆盖数据库路径
- `DEEPSENO_VEC_DB_PATH` — 覆盖向量数据库路径
- `HF_TOKEN` — HuggingFace Token（从 `.env` 文件读取，用于下载 gated 模型）

## 已知坑
- **macOS 签名**：release 必须通过 `bash scripts/release.sh mac`，否则只签名不公证
- **native addon rebuild**：`pnpm build:mac` / `pnpm build:win` 已内置 `electron-rebuild`。若手动触发：`pnpm exec electron-rebuild -f -w sherpa-onnx-node`（必须用 `pnpm exec`）
- **平台依赖**：不要把 Linux-only 包写入 `package.json`，本项目仅面向 macOS / Windows
- **llama.cpp M5 坑**：llama.cpp ≥0.20 在 Apple M5 + macOS 26.x 上 Metal 编译会崩，需降级到 0.18.2
- **双架构打包期间禁止 pnpm dev**：`release.sh mac` / `pnpm build:mac` 运行期间另开终端执行 `pnpm dev` 会导致架构不匹配崩溃

## macOS 签名与公证

### 公证凭证（App Store Connect API Key）
`scripts/release.sh` 会从环境变量读取 API Key。
若直接跑 `pnpm build:mac`（不经过 release.sh），需手动 export：
```bash
export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_YOUR_KEY_ID.p8"
export APPLE_API_KEY_ID="YOUR_KEY_ID"
export APPLE_API_ISSUER="YOUR_ISSUER_UUID"
```

### 签名身份
- Developer ID Application: `<Your Company Name> (<Your Team ID>)`
- entitlements：`build/entitlements.mac.plist`

### 验证公证
```bash
hdiutil attach out/DeepSeno-<版本>-arm64.dmg -nobrowse
spctl -a -vvv -t exec "/Volumes/DeepSeno <版本>-arm64/DeepSeno.app"
# 期望：accepted / source=Notarized Developer ID
stapler validate "/Volumes/DeepSeno <版本>-arm64/DeepSeno.app"
hdiutil detach "/Volumes/DeepSeno <版本>-arm64"
```

## 常用命令
- `pnpm dev` — 开发模式
- `pnpm test` / `npx vitest run` — 跑测试
- `pnpm build` — 三目标构建
- `pnpm build:mac` — 打包 macOS（arm64 + x64）
- `pnpm build:win` — 打包 Windows（x64）
- `pnpm release:mac` / `release:win` / `release:all` — 签名 + 公证发布

## 资源下载
以下资源不纳入 Git 版本控制，需通过脚本下载/编译：
- `resources/frp/` — frpc 二进制文件（公网中转）：`./scripts/bundle-frp.sh`
- `resources/fonts/` — NotoSansSC 字体（PDF 生成）：`./scripts/bundle-fonts.sh`
- `resources/ffmpeg/` — FFmpeg 二进制文件：`./scripts/bundle-ffmpeg.sh`
- `scripts/getfg.exe` + `scripts/setfg.exe` — Windows 前台窗口工具（仅 Windows）：`./scripts/bundle-win-tools.sh`

首次开发或打包前运行 `./scripts/bundle-frp.sh && ./scripts/bundle-fonts.sh` 即可。
Windows 打包还需运行 `./scripts/bundle-win-tools.sh`（需 .NET Framework，Windows 10/11 自带）。

## iOS 真机日志收集

iOS 真机日志无法通过 `log stream` 或 `idevicesyslog` 直接获取（macOS 26 兼容性问题 + 统一日志系统隔离）。使用以下流程：

### 1. 启用自定义 subsystem 调试
```bash
sudo log config --subsystem com.korteqo.app.ios --mode "level:debug,persist:debug"
```

### 2. 代码中使用 os_log
```swift
import os
let captureLog = OSLog(subsystem: "com.korteqo.app.ios", category: "CaptureQueue")
os_log(.error, log: captureLog, "message: %{public}@", value)
```
注意：`print()` 在真机独立运行时不会进入日志系统，必须用 `os_log` 或 `Logger`。

### 3. 收集设备日志
```bash
# 收集最近 N 秒的日志
sudo log collect --device-name "iPhone名称" --last 30s --output /tmp/ios-logs.logarchive

# 或按 UDID 指定设备
sudo log collect --device-udid <UDID> --last 1m --output /tmp/ios-logs.logarchive
```

### 4. 查看日志
```bash
# 按 subsystem 过滤
log show /tmp/ios-logs.logarchive --predicate 'subsystem == "com.korteqo.app.ios"' --style compact

# 按进程名 + 消息内容过滤
log show /tmp/ios-logs.logarchive --predicate 'process == "Kortzeo" AND composedMessage CONTAINS "关键词"' --style compact
```

### 常见问题
- **模块缓存导致代码不生效**：删除 `~/Library/Developer/Xcode/DerivedData` 和 `~/Library/Caches/com.apple.dt.Xcode` 后 clean build
- **os_log 不出现**：检查 `sudo log config` 是否已启用该 subsystem
- **文件路径带旧容器 UUID**：重装 app 后 iOS 分配新容器，旧录音路径失效

## 用户偏好
- 回复语言：用中文回答用户（代码和注释用英文）
- Industrial geek 设计风格（非彩色/卡通）
- 所有 AI 处理必须完全本地化
- 跨平台：macOS + Windows
