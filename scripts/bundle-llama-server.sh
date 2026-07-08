#!/usr/bin/env bash
# bundle-llama-server.sh — Downloads platform-specific llama-server prebuilt
# binaries from ggml-org/llama.cpp releases into resources/llama-server/.
#
# Usage:
#   ./scripts/bundle-llama-server.sh              # Current platform only
#   ./scripts/bundle-llama-server.sh --all        # All platforms
#   ./scripts/bundle-llama-server.sh --platform darwin-arm64
#   ./scripts/bundle-llama-server.sh --platform win32-x64
#
# Idempotent: skips download if binaries already exist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$PROJECT_ROOT/resources/llama-server"

# llama.cpp release tag to download
LLAMA_CPP_TAG="b9693"
RELEASE_BASE="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_TAG}"

# ---- Colors ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_step()  { echo -e "${CYAN}[STEP]${NC} $*"; }

# ---- Platform detection ----
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
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

# ---- macOS download ----
download_macos() {
  local platform="$1"  # darwin-arm64 or darwin-x64
  local dest_dir="$RESOURCES_DIR/$platform"
  local asset="llama-${LLAMA_CPP_TAG}-bin-macos-${platform#darwin-}.tar.gz"
  local url="${RELEASE_BASE}/${asset}"

  if [[ -f "$dest_dir/llama-server" ]]; then
    log_info "llama-server already exists for $platform, skipping."
    return 0
  fi

  log_step "Downloading llama-server for $platform..."
  mkdir -p "$dest_dir"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap "rm -rf $tmp_dir" RETURN

  log_info "  Fetching $asset..."
  curl -L --fail --progress-bar -o "$tmp_dir/llama.tar.gz" "$url"

  log_info "  Extracting..."
  tar -xzf "$tmp_dir/llama.tar.gz" -C "$tmp_dir"

  # The archive contains a flat directory: llama-{tag}/llama-server + .dylib files
  local extract_dir
  extract_dir="$(find "$tmp_dir" -maxdepth 1 -type d -name "llama-*" | head -1)"
  if [[ -z "$extract_dir" ]]; then
    # Fallback: maybe files are in a build/bin/ subdirectory
    extract_dir="$(find "$tmp_dir" -type d -name bin | head -1)"
    if [[ -z "$extract_dir" ]]; then
      log_error "Could not find llama-server in $asset. Archive contents:"
      find "$tmp_dir" -maxdepth 3 -type f | head -20
      exit 1
    fi
  fi

  # Copy llama-server
  cp "$extract_dir/llama-server" "$dest_dir/llama-server"
  chmod +x "$dest_dir/llama-server"

  # Copy all .dylib files (Metal backend, BLAS, etc.)
  find "$extract_dir" -maxdepth 1 -name '*.dylib' -exec cp {} "$dest_dir/" \;

  log_info "llama-server for $platform installed to $dest_dir"
}

# ---- Windows download ----
download_windows() {
  local platform="win32-x64"
  local dest_dir="$RESOURCES_DIR/$platform"

  # Keep backend packages isolated so each llama-server loads matching DLLs.
  download_windows_asset "$dest_dir/cuda-13.3" \
    "llama-${LLAMA_CPP_TAG}-bin-win-cuda-13.3-x64.zip" \
    "CUDA 13.3"
  download_windows_asset "$dest_dir/cuda-12.4" \
    "llama-${LLAMA_CPP_TAG}-bin-win-cuda-12.4-x64.zip" \
    "CUDA 12.4"
  download_windows_asset "$dest_dir/vulkan" \
    "llama-${LLAMA_CPP_TAG}-bin-win-vulkan-x64.zip" \
    "Vulkan"
  download_windows_asset "$dest_dir/cpu" \
    "llama-${LLAMA_CPP_TAG}-bin-win-cpu-x64.zip" \
    "CPU"
}

download_windows_asset() {
  local dest_dir="$1"
  local asset="$2"
  local backend_label="$3"
  local url="${RELEASE_BASE}/${asset}"

  if [[ -f "$dest_dir/llama-server.exe" ]]; then
    log_info "Windows $backend_label llama-server already exists, skipping."
    return 0
  fi

  log_step "Downloading Windows $backend_label backend ($asset)..."
  mkdir -p "$dest_dir"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap "rm -rf $tmp_dir" RETURN

  log_info "  Fetching $asset..."
  curl -L --fail --progress-bar -o "$tmp_dir/llama.zip" "$url"

  log_info "  Extracting..."
  unzip -o -q "$tmp_dir/llama.zip" -d "$tmp_dir"

  # Find llama-server.exe and copy the whole flat backend payload. The release
  # archives are backend-specific; mixing DLLs across them can make Windows load
  # the wrong runtime at process start.
  local exe_path
  exe_path="$(find "$tmp_dir" -name 'llama-server.exe' -not -path '*/__MACOSX/*' | head -1)"
  if [[ -z "$exe_path" ]]; then
    log_error "Could not find llama-server.exe in $asset"
    exit 1
  fi

  local exe_dir
  exe_dir="$(dirname "$exe_path")"

  find "$exe_dir" -maxdepth 1 -type f -exec cp {} "$dest_dir/" \;

  log_info "Windows $backend_label backend installed to $dest_dir"
}

# ---- Platform dispatcher ----
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

# ---- Main ----
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
        echo "Usage: $0 [--all | --platform <platform>]"
        echo ""
        echo "Platforms: darwin-arm64  darwin-x64  win32-x64"
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

  log_info "llama-server bundle script (llama.cpp ${LLAMA_CPP_TAG})"
  log_info "Resources directory: $RESOURCES_DIR"
  mkdir -p "$RESOURCES_DIR"

  case "$mode" in
    all)
      log_info "Downloading for all platforms..."
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

  echo ""
  log_info "Done! llama-server binaries ready for packaging."
  echo ""
  log_info "Directory contents:"
  find "$RESOURCES_DIR" -type f -not -path '*/lib/*' | sort | while read -r f; do
    local size
    size="$(du -h "$f" | cut -f1)"
    echo "  $size  $f"
  done
}

main "$@"
