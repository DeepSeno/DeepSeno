# DeepSeno Development Setup Guide

## Prerequisites

### macOS (Mac Mini M4)

```bash
# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js + pnpm
brew install node
npm install -g pnpm

# FFmpeg
brew install ffmpeg

# Python 3.10+
brew install python@3.11
```

### Windows

- **Node.js**: https://nodejs.org/ (LTS version)
- **pnpm**: `npm install -g pnpm`
- **FFmpeg**: Download from https://www.gyan.dev/ffmpeg/builds/ and add to system PATH
- **Python 3.10+**: https://www.python.org/downloads/

## Install llama.cpp

### macOS

```bash
# Option A: Download dmg from https://llama.cpp.com/download/mac
# Option B: Homebrew
brew install llama.cpp

# Start llama.cpp service
llama.cpp serve
```

### Windows

Download installer from https://llama.cpp.com/download/windows and run it.

## Pull AI Models

```bash
# LLM model (text optimization, info extraction, RAG Q&A)
llama.cpp pull qwen2.5:14b    # ~9GB

# Embedding model (vector search)
llama.cpp pull bge-m3          # ~1.2GB
```

M4 32GB can run both models comfortably.

## Project Setup

```bash
cd /path/to/deepseno

# Install Node dependencies
pnpm install

# Create Python virtual environment + install AI packages
cd python
python3 -m venv venv                  # macOS
# python -m venv venv                 # Windows
source venv/bin/activate              # macOS
# venv\Scripts\activate               # Windows
pip install -r requirements.txt       # whisper + pyannote + silero-vad
deactivate
cd ..
```

## HuggingFace Token (required for pyannote)

pyannote speaker diarization model requires HuggingFace authorization:

1. Register at https://huggingface.co
2. Create a token at https://huggingface.co/settings/tokens
3. Accept license agreements:
   - https://huggingface.co/pyannote/segmentation-3.0
   - https://huggingface.co/pyannote/speaker-diarization-3.1
4. Enter the token in the app's Settings page or Setup Wizard

## Run

```bash
# Ensure llama.cpp is running in background
llama.cpp serve &

# Start development server
pnpm dev
```

## Build

```bash
pnpm build          # Build all targets (main/preload/renderer)
pnpm build:mac      # macOS installer (DMG, ARM64+x64)
pnpm build:win      # Windows installer (NSIS)
```

## End-to-End Test

1. Launch the app with `pnpm dev`
2. Complete the Setup Wizard (select directories, detect environment, download models)
3. Go to "Recordings" page, drag in a WAV file
4. Watch the pipeline progress: FORMAT → VAD → ASR → DIARIZE → OPTIMIZE → EXTRACT → INDEX
5. Check results in "Transcripts" page
6. Test RAG query in "Intelligence" page

## Platform Differences

The codebase handles macOS/Windows differences automatically:

| Item | macOS | Windows |
|------|-------|---------|
| Python binary | `python3` | `python` |
| venv pip path | `venv/bin/pip` | `venv/Scripts/pip.exe` |
| Build target | `pnpm build:mac` (DMG) | `pnpm build:win` (NSIS) |

No code changes needed when switching platforms.

## Tests

```bash
npx vitest run       # Run all tests (71 tests, 11 files)
```
