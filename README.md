<p align="center">
  <img src="src/renderer/assets/logo-dark.png" width="80" height="80" alt="DeepSeno Logo">
</p>

<h1 align="center">DeepSeno</h1>

<p align="center">
  <strong>Open-source, local-first AI Second Brain</strong><br>
  Automatically capture, understand, and remember your voice and information.<br>
  All AI processing runs on your device. Your data stays yours.
</p>

<p align="center">
  <a href="#features">Features</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#contributing">Contributing</a> &bull;
  <a href="README_CN.md">中文文档</a>
</p>

<p align="center">
  <a href="https://github.com/deepseno/deepseno/releases"><img src="https://img.shields.io/github/v/release/deepseno/deepseno?style=flat-square" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/deepseno/deepseno/stargazers"><img src="https://img.shields.io/github/stars/deepseno/deepseno?style=flat-square" alt="Stars"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/AI-100%25%20Local-green?style=flat-square" alt="Local AI">
</p>

---

## Why DeepSeno?

Your second brain shouldn't live on someone else's server.

Traditional note-taking tools require you to manually capture, organize, and retrieve information. Cloud AI services process your most private conversations on remote servers. DeepSeno takes a different approach:

- **You speak, it understands** — Automatic speech recognition, speaker identification, and intelligent text optimization
- **You ask, it recalls** — RAG-powered conversational query over your entire knowledge base
- **You work, it extracts** — Auto-detects TODOs, meetings, decisions, contacts from conversations
- **Everything stays local** — All AI models run on-device via ONNX. Zero cloud dependency. Zero data leakage.

## Features

### Core AI Pipeline
- **Speech-to-Text** — SenseVoice ASR via sherpa-onnx, supports Chinese/English/Japanese/Korean
- **Speaker Identification** — Automatic speaker diarization (pyannote) + voiceprint recognition (3dspeaker)
- **Voice Activity Detection** — Silero VAD for precise speech segmentation
- **Real-time Transcription** — Live streaming transcription with millisecond-level cold start
- **System Audio Capture** — Capture and transcribe any audio playing on your system
- **Text Optimization** — LLM-powered text cleanup, summarization, and information extraction
- **Emotion Analysis** — Detect emotional tone from voice

### Knowledge & Memory
- **RAG Query Engine** — Ask questions in natural language, get answers grounded in your data
- **Vector Search** — Semantic search powered by sqlite-vec + bge-m3 embeddings
- **Full-text Search** — FTS5-powered instant text search across all transcripts
- **Agent Memory** — 3-layer memory system with automatic fact extraction and conflict detection
- **Knowledge Base** — Structured knowledge management with auto-categorization
- **Relationship Graph** — Automatically discover and visualize people connections

### Productivity
- **Smart Extraction** — Auto-extract TODOs, meeting notes, decisions, contacts, numbers
- **Reports** — Generate weekly/monthly summaries from your conversations
- **Document Export** — Export to PDF, DOCX, PPTX, or Obsidian-compatible Markdown
- **Task Scheduler** — Cron-based automated processing tasks

### Connectivity
- **Multi-channel** — Integrate with Feishu (Lark), Telegram, WeChat Work
- **Plugin System** — Extend capabilities via MCP (Model Context Protocol) plugins
- **Plugin Marketplace** — Discover and install community plugins
- **LAN Server** — Access your second brain from other devices on local network

### Privacy & Openness
- **100% Local AI** — SenseVoice, Silero VAD, pyannote, 3dspeaker all run in-process via ONNX
- **Local LLM** — Uses llama.cpp with Qwen2.5 (text) and bge-m3 (embeddings)
- **No Cloud Required** — Works completely offline after initial model download (~263MB ONNX models)
- **Open Source** — Apache 2.0 licensed, fully auditable, fork-friendly
- **Cross-platform** — macOS (Apple Silicon + Intel) and Windows

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 8
- [llama.cpp](https://llama.cpp.ai/) (for LLM capabilities)
- [FFmpeg](https://ffmpeg.org/) (bundled in release builds)

### Install & Run

```bash
# Clone the repository
git clone https://github.com/deepseno/deepseno.git
cd deepseno

# Install dependencies
pnpm install

# Rebuild native addons for Electron
npx electron-rebuild -f -w sherpa-onnx-node
npx electron-rebuild -f -w sherpa-onnx-node

# Pull required llama.cpp models
llama.cpp pull qwen2.5:14b
llama.cpp pull bge-m3

# Start in development mode
pnpm dev
```

### Download Release

Pre-built binaries are available on the [Releases](https://github.com/deepseno/deepseno/releases) page:
- **macOS**: `.dmg` (Apple Silicon + Intel universal)
- **Windows**: `.exe` installer (x64)

Windows users should install or repair the latest **Microsoft Visual C++ Redistributable 2015-2022 x64** before using local AI models:
https://aka.ms/vc14/vc_redist.x64.exe

If the local model service fails to start with `llama-server` exit code `0xC0000005` / `STATUS_ACCESS_VIOLATION`, install the runtime above, reboot Windows, then test again.

On first launch, DeepSeno will guide you through environment setup and model downloads.

## Architecture

```
Electron Main Process (Node.js)
├── SherpaEngine ─── In-process ONNX AI Models (~263MB)
│   ├── SenseVoice ASR (speech-to-text)
│   ├── Silero VAD (voice activity detection)
│   ├── pyannote (speaker diarization)
│   └── 3dspeaker (voiceprint embedding)
│
├── Processor ─── 10-step Audio Pipeline
│   ├── AudioPreprocessor (FFmpeg + VAD)
│   ├── Transcriber (SenseVoice)
│   ├── Diarizer (speaker separation)
│   ├── TextOptimizer (llama.cpp LLM)
│   └── MarkdownGenerator (output)
│
├── Agent System
│   ├── MemoryManager (3-layer memory)
│   ├── InsightEngine (proactive insights)
│   └── EventBus (system-wide events)
│
├── QueryEngine ─── RAG Pipeline
│   ├── VectorStore (sqlite-vec + bge-m3)
│   └── LLM Answer Generation (llama.cpp)
│
├── DeepSenoDB ─── SQLite (WAL + FTS5)
├── Channels ─── Feishu / Telegram / WeChat
├── PluginManager ─── MCP Protocol
├── Scheduler ─── Cron Tasks
└── LAN Server ─── Local Network Access

Electron Renderer (React + TypeScript)
├── Dashboard / Recordings / Transcripts
├── Assistant / Knowledge / People
├── Channels / Plugins / Scheduler
├── Reports / Settings
└── i18n (English / Chinese)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 33 + React 18 + TypeScript |
| Styling | Tailwind CSS v4 + lucide-react |
| Build | electron-vite + pnpm |
| Database | Node.js 24 native SQLite (WAL, FTS5) + sqlite-vec |
| ASR | SenseVoice via sherpa-onnx-node |
| VAD | Silero VAD via sherpa-onnx-node |
| Diarization | pyannote + 3dspeaker via sherpa-onnx-node |
| LLM | llama.cpp (Qwen2.5-14B + bge-m3) |
| Audio | fluent-ffmpeg + chokidar |
| Plugins | Model Context Protocol (MCP) |
| Documents | pdfkit + docx + pptxgenjs |

## Development

```bash
# Run tests
pnpm test

# Build for current platform
pnpm build

# Build for macOS
pnpm build:mac

# Build for Windows
pnpm build:win
```

### Project Structure

```
src/
├── main/                  # Electron main process
│   ├── agent/             # Agent system + memory
│   ├── audio/             # Audio pipeline (ASR, VAD, diarization)
│   ├── channels/          # Feishu, Telegram, WeChat
│   ├── db/                # SQLite database + schema
│   ├── document/          # PDF, DOCX, PPTX generation
│   ├── ipc/               # IPC handlers
│   ├── llm/               # llama.cpp client + text optimizer
│   ├── plugin/            # MCP plugin system
│   ├── rag/               # Vector store + query engine
│   └── scheduler/         # Task scheduling
├── renderer/              # React frontend
│   ├── pages/             # 18 page components
│   ├── components/        # Shared UI components
│   ├── hooks/             # Custom React hooks
│   └── i18n/              # EN/ZH translations
└── electron/              # Electron entry points
```

## Contributing

We welcome contributions! Whether it's bug reports, feature requests, documentation improvements, or code contributions.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and development process.

### Areas Where Help Is Appreciated

- Additional language support for ASR
- New channel integrations
- MCP plugin development
- UI/UX improvements
- Documentation and translations
- Testing and bug reports

## Roadmap

- [ ] Linux support
- [ ] Mobile companion app
- [ ] More ASR model options (Whisper, Paraformer)
- [ ] Video transcription support
- [ ] Team collaboration features
- [ ] Plugin SDK and developer documentation

## License & Trademark

The **source code** is licensed under the [Apache License 2.0](LICENSE) — use it freely for personal and commercial purposes.

The names **"DeepSeno"** and **"铸声"**, and the DeepSeno logos, are **trademarks of Zhongguang Intelligent Media (Beijing) Technology Co., Ltd.** and are **not** covered by the Apache license. You may state that your project is "based on DeepSeno", but if you distribute a modified version you must use a **different name and logo**. See [NOTICE](NOTICE) for details.

## Acknowledgments

DeepSeno is built on the shoulders of these amazing open-source projects:

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — On-device speech recognition
- [llama.cpp](https://llama.cpp.ai/) — Local LLM runtime
- [Electron](https://www.electronjs.org/) — Cross-platform desktop framework
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — Vector search for SQLite
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) — Multilingual ASR model
- [pyannote](https://github.com/pyannote/pyannote-audio) — Speaker diarization

---

<p align="center">
  <a href="https://deepseno.com">Website</a> &bull;
  <a href="https://github.com/deepseno/deepseno/discussions">Discussions</a> &bull;
  <a href="https://github.com/deepseno/deepseno/issues">Issues</a>
</p>
