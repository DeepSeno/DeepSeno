#!/usr/bin/env bash
# bundle-ffmpeg.sh — Downloads platform-specific FFmpeg/FFprobe static builds
# into resources/ffmpeg/{platform}-{arch}/ for Electron packaging.
#
# Usage:
#   ./scripts/bundle-ffmpeg.sh              # Download for current platform only
#   ./scripts/bundle-ffmpeg.sh --all        # Download for all platforms
#   ./scripts/bundle-ffmpeg.sh --platform darwin-arm64
#   ./scripts/bundle-ffmpeg.sh --platform darwin-x64
#   ./scripts/bundle-ffmpeg.sh --platform win32-x64
#
# The script is idempotent: it skips downloads if binaries already exist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$PROJECT_ROOT/resources/ffmpeg"

# FFmpeg version to download
FFMPEG_VERSION="7.1"

# Download URLs
# macOS: evermeet.cx provides universal static builds
MACOS_FFMPEG_URL="https://evermeet.cx/ffmpeg/ffmpeg-${FFMPEG_VERSION}.zip"
MACOS_FFPROBE_URL="https://evermeet.cx/ffmpeg/ffprobe-${FFMPEG_VERSION}.zip"

# Windows: gyan.dev provides static builds
WIN_FFMPEG_URL="https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
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

# Check if binaries already exist for a platform
check_existing() {
  local platform="$1"
  local dir="$RESOURCES_DIR/$platform"

  if [[ "$platform" == win32-* ]]; then
    [[ -f "$dir/ffmpeg.exe" && -f "$dir/ffprobe.exe" ]]
  else
    [[ -f "$dir/ffmpeg" && -f "$dir/ffprobe" ]]
  fi
}

# Download FFmpeg for macOS (arm64 or x64)
# evermeet.cx builds are universal (fat) binaries that work on both arm64 and x64
download_macos() {
  local platform="$1"
  local dest_dir="$RESOURCES_DIR/$platform"
  local tmp_dir

  if check_existing "$platform"; then
    log_info "FFmpeg already exists for $platform, skipping."
    return 0
  fi

  log_info "Downloading FFmpeg for $platform..."
  mkdir -p "$dest_dir"
  tmp_dir="$(mktemp -d)"

  # Download ffmpeg
  log_info "  Downloading ffmpeg..."
  curl -L --fail --progress-bar -o "$tmp_dir/ffmpeg.zip" "$MACOS_FFMPEG_URL"
  unzip -o -q "$tmp_dir/ffmpeg.zip" -d "$tmp_dir"
  cp "$tmp_dir/ffmpeg" "$dest_dir/ffmpeg"
  chmod +x "$dest_dir/ffmpeg"

  # Download ffprobe
  log_info "  Downloading ffprobe..."
  curl -L --fail --progress-bar -o "$tmp_dir/ffprobe.zip" "$MACOS_FFPROBE_URL"
  unzip -o -q "$tmp_dir/ffprobe.zip" -d "$tmp_dir"
  cp "$tmp_dir/ffprobe" "$dest_dir/ffprobe"
  chmod +x "$dest_dir/ffprobe"

  # Cleanup
  rm -rf "$tmp_dir"

  log_info "FFmpeg for $platform installed to $dest_dir"
}

# Download FFmpeg for Windows x64
download_windows() {
  local platform="win32-x64"
  local dest_dir="$RESOURCES_DIR/$platform"
  local tmp_dir

  if check_existing "$platform"; then
    log_info "FFmpeg already exists for $platform, skipping."
    return 0
  fi

  log_info "Downloading FFmpeg for $platform..."
  mkdir -p "$dest_dir"
  tmp_dir="$(mktemp -d)"

  # Download the essentials build (smaller, has ffmpeg + ffprobe)
  log_info "  Downloading ffmpeg essentials build..."
  curl -L --fail --progress-bar -o "$tmp_dir/ffmpeg-win.zip" "$WIN_FFMPEG_URL"

  # Extract — the archive has a top-level directory like ffmpeg-7.1-essentials_build/
  unzip -o -q "$tmp_dir/ffmpeg-win.zip" -d "$tmp_dir"

  # Find the bin directory inside the extracted folder
  local bin_dir
  bin_dir="$(find "$tmp_dir" -type d -name bin | head -1)"

  if [[ -z "$bin_dir" ]]; then
    log_error "Could not find bin directory in FFmpeg Windows archive"
    rm -rf "$tmp_dir"
    exit 1
  fi

  cp "$bin_dir/ffmpeg.exe" "$dest_dir/ffmpeg.exe"
  cp "$bin_dir/ffprobe.exe" "$dest_dir/ffprobe.exe"

  # Cleanup
  rm -rf "$tmp_dir"

  log_info "FFmpeg for $platform installed to $dest_dir"
}

# Download for a specific platform
download_for_platform() {
  local platform="$1"

  case "$platform" in
    darwin-arm64|darwin-x64)
      download_macos "$platform"
      ;;
    win32-x64)
      download_windows
      ;;
    *)
      log_error "Unsupported platform: $platform"
      exit 1
      ;;
  esac
}

# Main
main() {
  local mode="current"
  local target_platform=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all)
        mode="all"
        shift
        ;;
      --platform)
        mode="specific"
        target_platform="$2"
        shift 2
        ;;
      -h|--help)
        echo "Usage: $0 [--all | --platform <darwin-arm64|darwin-x64|win32-x64>]"
        echo ""
        echo "Downloads FFmpeg static binaries for Electron packaging."
        echo ""
        echo "Options:"
        echo "  --all               Download for all platforms"
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

  log_info "FFmpeg bundle script v${FFMPEG_VERSION}"
  log_info "Resources directory: $RESOURCES_DIR"
  mkdir -p "$RESOURCES_DIR"

  case "$mode" in
    all)
      log_info "Downloading FFmpeg for all platforms..."
      download_for_platform "darwin-arm64"
      download_for_platform "darwin-x64"
      download_for_platform "win32-x64"
      ;;
    specific)
      download_for_platform "$target_platform"
      ;;
    current)
      local current
      current="$(detect_platform)"
      log_info "Detected platform: $current"
      download_for_platform "$current"
      ;;
  esac

  log_info "Done! FFmpeg binaries are ready for packaging."
  echo ""
  log_info "Directory contents:"
  find "$RESOURCES_DIR" -type f | sort | while read -r f; do
    local size
    size="$(du -h "$f" | cut -f1)"
    echo "  $size  $f"
  done
}

main "$@"
