#!/usr/bin/env bash
# install-deps.sh — Download all platform-specific resources for Electron packaging.
#
# Usage:
#   ./scripts/install-deps.sh              # Download for current platform only
#   ./scripts/install-deps.sh --all        # Download for all platforms
#
# This script is idempotent: it skips downloads if binaries already exist.
# It calls the individual bundle scripts for each resource type.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Detect current platform
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="win32" ;;
    *) log_error "Unsupported OS: $os"; exit 1 ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) log_error "Unsupported architecture: $arch"; exit 1 ;;
  esac

  echo "${os}-${arch}"
}

# Parse arguments
MODE="current"
PLATFORM=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      MODE="all"
      shift
      ;;
    --platform)
      MODE="specific"
      PLATFORM="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--all | --platform <darwin-arm64|darwin-x64|win32-x64>]"
      echo ""
      echo "Download all platform-specific resources for Electron packaging."
      echo ""
      echo "Resources downloaded:"
      echo "  - FFmpeg (ffmpeg + ffprobe)"
      echo "  - Sherpa-ONNX small models (tokens, VAD, speaker segmentation)"
      echo "  - fonts (PDF generation)"
      echo "  - NotoSansSC font (for PDF generation)"
      echo "  - Windows tools (setfg.exe, getfg.exe) — Windows only"
      echo ""
      echo "Options:"
      echo "  --all               Download for all platforms (darwin-arm64, darwin-x64, win32-x64)"
      echo "  --platform <name>   Download for a specific platform"
      echo "  (no args)           Download for current platform only"
      exit 0
      ;;
    *)
      log_error "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# Build arguments for child scripts
CHILD_ARGS=""
case "$MODE" in
  all)
    CHILD_ARGS="--all"
    ;;
  specific)
    CHILD_ARGS="--platform $PLATFORM"
    ;;
  current)
    # Let child scripts auto-detect
    ;;
esac

CURRENT_PLATFORM="$(detect_platform 2>/dev/null || echo 'unknown')"
log_info "DeepSeno dependency installer"
log_info "Current platform: $CURRENT_PLATFORM"
log_info "Mode: $MODE"
echo ""

# Track failures
FAILURES=()

# ── Step 1: FFmpeg ─────────────────────────────────────────────
log_step "[1/5] FFmpeg"
if bash "$SCRIPT_DIR/bundle-ffmpeg.sh" $CHILD_ARGS; then
  log_info "FFmpeg ready."
else
  log_warn "FFmpeg download failed (non-fatal, app can download at runtime)"
  FAILURES+=("ffmpeg")
fi
echo ""

# ── Step 2: Sherpa-ONNX small models ───────────────────────────
log_step "[2/5] Sherpa-ONNX small models"
if bash "$SCRIPT_DIR/bundle-sherpa-models.sh"; then
  log_info "Sherpa models ready."
else
  log_warn "Sherpa models download failed (non-fatal, app can download at runtime)"
  FAILURES+=("sherpa-models")
fi
echo ""

# ── Step 3: Fonts ──────────────────────────────────────────────
log_step "[3/4] NotoSansSC font"
if bash "$SCRIPT_DIR/bundle-fonts.sh"; then
  log_info "Fonts ready."
else
  log_warn "Font download failed (non-fatal)"
  FAILURES+=("fonts")
fi
echo ""

# ── Step 4: Windows tools (only on Windows or --all) ──────────
NEED_WIN_TOOLS=false
case "$MODE" in
  all)
    NEED_WIN_TOOLS=true
    ;;
  specific)
    [[ "$PLATFORM" == win32-* ]] && NEED_WIN_TOOLS=true
    ;;
  current)
    [[ "$CURRENT_PLATFORM" == win32-* ]] && NEED_WIN_TOOLS=true
    ;;
esac

log_step "[4/4] Windows tools"
if $NEED_WIN_TOOLS; then
  if bash "$SCRIPT_DIR/bundle-win-tools.sh"; then
    log_info "Windows tools ready."
  else
    log_warn "Windows tools download failed (non-fatal, requires .NET Framework)"
    FAILURES+=("win-tools")
  fi
else
  log_info "Skipping (not Windows platform)."
fi
echo ""

# ── Summary ────────────────────────────────────────────────────
log_info "========================================="
if [[ ${#FAILURES[@]} -eq 0 ]]; then
  log_info "All dependencies ready!"
else
  log_warn "Completed with ${#FAILURES[@]} failure(s): ${FAILURES[*]}"
  log_warn "The app can still download missing resources at runtime."
fi
log_info "========================================="

# Show what we have
echo ""
log_info "Resources directory contents:"
for dir in ffmpeg sherpa-models fonts llama-server win-tools; do
  RES_DIR="$PROJECT_ROOT/resources/$dir"
  if [[ -d "$RES_DIR" ]]; then
    COUNT=$(find "$RES_DIR" -type f | wc -l | tr -d ' ')
    SIZE=$(du -sh "$RES_DIR" 2>/dev/null | cut -f1)
    echo "  $dir/ — $COUNT files, $SIZE"
  fi
done
