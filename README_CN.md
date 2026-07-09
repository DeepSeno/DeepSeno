<p align="center">
  <img src="src/renderer/assets/logo-dark.png" width="80" height="80" alt="DeepSeno Logo">
</p>

<h1 align="center">DeepSeno（铸声）</h1>

<p align="center">
  <strong>开源的本地 AI 第二大脑</strong><br>
  自动捕获、理解、记忆你的语音和信息。<br>
  所有 AI 处理在设备端完成，数据永远属于你。
</p>

<p align="center">
  <a href="#核心特性">核心特性</a> &bull;
  <a href="#快速开始">快速开始</a> &bull;
  <a href="#系统架构">系统架构</a> &bull;
  <a href="#参与贡献">参与贡献</a> &bull;
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/deepseno/deepseno/releases"><img src="https://img.shields.io/github/v/release/deepseno/deepseno?style=flat-square" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/deepseno/deepseno/stargazers"><img src="https://img.shields.io/github/stars/deepseno/deepseno?style=flat-square" alt="Stars"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/AI-100%25%20本地运行-green?style=flat-square" alt="Local AI">
</p>

---

## 为什么需要 DeepSeno？

你的第二大脑，不应该跑在别人的服务器上。

传统笔记工具需要你手动记录、整理和检索信息。云端 AI 服务在远程服务器上处理你最私密的对话。DeepSeno 提供了一种不同的方式：

| 传统第二大脑 | DeepSeno |
|---|---|
| 你手动记录 | 它自动捕获（语音、消息、文档） |
| 你手动整理 | 它自动理解、提取、归类 |
| 你手动检索 | 你直接问它，它理解上下文回答你 |
| 你手动关联 | 它自动发现人物关系、生成洞察 |
| 数据在云端 | **一切都在你的设备上** |

## 核心特性

### AI 语音管线
- **语音转文字** — SenseVoice ASR，支持中/英/日/韩多语言
- **说话人识别** — pyannote 说话人分离 + 3dspeaker 声纹识别，自动区分"谁在说话"
- **语音活动检测** — Silero VAD 精确定位语音片段
- **实时流式转写** — 毫秒级冷启动的实时转录
- **系统音频捕获** — 捕获并转写系统中播放的任何音频（会议、播客、视频）
- **文本优化** — LLM 智能文本清洗、摘要、信息提取
- **情绪分析** — 从语音中检测情绪倾向

### 知识与记忆
- **RAG 问答引擎** — 用自然语言提问，得到基于你个人数据的回答
- **向量语义搜索** — sqlite-vec + bge-m3 嵌入驱动的语义检索
- **全文搜索** — FTS5 驱动的毫秒级全文检索
- **Agent 记忆系统** — 三层记忆架构，自动事实提取与冲突检测
- **知识库管理** — 结构化知识管理与自动分类
- **人物关系图谱** — 自动发现并可视化人物关系网络

### 效率工具
- **智能提取** — 自动提取待办事项、会议纪要、决策、联系人、关键数字
- **周报/月报** — 从对话中自动生成周期性总结报告
- **文档导出** — 导出为 PDF、DOCX、PPTX 或 Obsidian 兼容的 Markdown
- **定时任务** — Cron 驱动的自动化处理任务

### 连接与扩展
- **多通道接入** — 集成飞书、Telegram、企业微信
- **插件系统** — 通过 MCP（Model Context Protocol）协议扩展能力
- **插件市场** — 发现和安装社区插件
- **局域网服务** — 从局域网内的其他设备访问你的第二大脑

### 隐私与开放
- **100% 本地 AI** — SenseVoice、Silero VAD、pyannote、3dspeaker 全部通过 ONNX 在进程内运行
- **本地大模型** — 使用 llama.cpp 运行 Qwen2.5（文本处理）和 bge-m3（向量嵌入）
- **无需云端** — 初次模型下载（约 263MB ONNX 模型）后完全离线工作
- **开源** — Apache 2.0 许可证，完全可审计，自由 fork
- **跨平台** — 支持 macOS（Apple Silicon + Intel）和 Windows

## 快速开始

### 下载安装

前往 [Releases](https://github.com/deepseno/deepseno/releases) 页面下载预构建安装包：
- **macOS**: `.dmg`（Apple Silicon + Intel 通用）
- **Windows**: `.exe` 安装程序（x64）

Windows 用户使用本地 AI 模型前，建议先安装或修复最新版 **Microsoft Visual C++ Redistributable 2015-2022 x64**：
https://aka.ms/vc14/vc_redist.x64.exe

如果本地模型服务启动失败，并在日志中看到 `llama-server` 退出码 `0xC0000005` / `STATUS_ACCESS_VIOLATION`，请先安装上述运行库，重启 Windows 后再测试。

首次启动时，DeepSeno 会引导你完成环境配置和模型下载。

### 从源码构建

```bash
# 前置条件：Node.js >= 18, pnpm >= 8, llama.cpp, FFmpeg

# 克隆仓库
git clone https://github.com/deepseno/deepseno.git
cd deepseno

# 安装依赖
pnpm install

# 为 Electron 重新构建原生插件
npx electron-rebuild -f -w sherpa-onnx-node
npx electron-rebuild -f -w sherpa-onnx-node

# 拉取 llama.cpp 模型
llama.cpp pull qwen2.5:14b
llama.cpp pull bge-m3

# 启动开发模式
pnpm dev
```

## 系统架构

```
Electron 主进程 (Node.js)
├── SherpaEngine ─── 进程内 ONNX AI 模型 (~263MB)
│   ├── SenseVoice ASR（语音转文字）
│   ├── Silero VAD（语音活动检测）
│   ├── pyannote（说话人分离）
│   └── 3dspeaker（声纹嵌入）
│
├── Processor ─── 10 步音频处理管线
│   ├── AudioPreprocessor（FFmpeg + VAD）
│   ├── Transcriber（SenseVoice 转写）
│   ├── Diarizer（说话人分离）
│   ├── TextOptimizer（llama.cpp LLM 文本优化）
│   └── MarkdownGenerator（输出生成）
│
├── Agent 系统
│   ├── MemoryManager（三层记忆管理）
│   ├── InsightEngine（主动洞察生成）
│   └── EventBus（系统事件总线）
│
├── QueryEngine ─── RAG 管线
│   ├── VectorStore（sqlite-vec + bge-m3）
│   └── LLM 答案生成（llama.cpp）
│
├── DeepSenoDB ─── SQLite（WAL + FTS5）
├── Channels ─── 飞书 / Telegram / 企业微信
├── PluginManager ─── MCP 协议
├── Scheduler ─── 定时任务
└── LAN Server ─── 局域网访问

Electron 渲染进程 (React + TypeScript)
├── 仪表盘 / 录音管理 / 转写记录
├── AI 助手 / 知识库 / 人物库
├── 频道 / 插件 / 定时任务
├── 报告 / 设置
└── 国际化 (中文 / 英文)
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Electron 33 + React 18 + TypeScript |
| 样式 | Tailwind CSS v4 + lucide-react |
| 构建 | electron-vite + pnpm |
| 数据库 | Node.js 24 原生 SQLite (WAL, FTS5) + sqlite-vec |
| 语音识别 | SenseVoice via sherpa-onnx-node |
| 语音检测 | Silero VAD via sherpa-onnx-node |
| 说话人分离 | pyannote + 3dspeaker via sherpa-onnx-node |
| 大语言模型 | llama.cpp (Qwen2.5-14B + bge-m3) |
| 音频处理 | fluent-ffmpeg + chokidar |
| 插件协议 | Model Context Protocol (MCP) |
| 文档生成 | pdfkit + docx + pptxgenjs |

## 硬件推荐

| 配置 | 说明 |
|------|------|
| **推荐** | Mac Mini M4 32GB 或同等配置 |
| **最低** | 8GB RAM + 任意支持 llama.cpp 的设备 |
| **存储** | 约 300MB（ONNX 模型）+ llama.cpp 模型空间 |

## 开发

```bash
# 运行测试
pnpm test

# 构建当前平台
pnpm build

# 构建 macOS
pnpm build:mac

# 构建 Windows
pnpm build:win
```

## 参与贡献

欢迎任何形式的贡献！无论是 Bug 报告、功能建议、文档改进还是代码贡献。

1. Fork 本仓库
2. 创建特性分支（`git checkout -b feature/amazing-feature`）
3. 提交更改（`git commit -m 'Add amazing feature'`）
4. 推送分支（`git push origin feature/amazing-feature`）
5. 发起 Pull Request

### 特别欢迎的贡献方向

- 更多语言的 ASR 支持
- 新的频道集成（钉钉、Slack 等）
- MCP 插件开发
- UI/UX 改进
- 文档和翻译
- 测试和 Bug 报告

## 路线图

- [ ] Linux 支持
- [ ] 移动端伴侣应用
- [ ] 更多 ASR 模型选项（Whisper、Paraformer）
- [ ] 视频转写支持
- [ ] 团队协作功能
- [ ] 插件 SDK 和开发者文档

## 许可证与商标

**源代码**采用 [Apache License 2.0](LICENSE) 授权，可自由用于个人和商业用途。

**“DeepSeno”** 与 **“铸声”** 名称及 DeepSeno 标识（Logo）为 **中广智媒（北京）科技有限公司** 的商标，**不**在 Apache 授权范围内。你可以注明自己的项目“基于 DeepSeno”，但如果分发修改版，必须改用**不同的名称和 Logo**。详见 [NOTICE](NOTICE)。

## 致谢

DeepSeno 基于以下优秀的开源项目构建：

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — 端侧语音识别
- [llama.cpp](https://llama.cpp.ai/) — 本地大模型运行时
- [Electron](https://www.electronjs.org/) — 跨平台桌面框架
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — SQLite 向量搜索
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) — 多语言语音识别模型
- [pyannote](https://github.com/pyannote/pyannote-audio) — 说话人分离

---

<p align="center">
  <a href="https://deepseno.com">官网</a> &bull;
  <a href="https://github.com/deepseno/deepseno/discussions">讨论区</a> &bull;
  <a href="https://github.com/deepseno/deepseno/issues">问题反馈</a>
</p>
