#!/usr/bin/env bash
# bundle-sherpa-models.sh — Downloads small Sherpa-ONNX model files (<10MB)
# into resources/sherpa-models/ for Electron packaging.
#
# Large models (>10MB) are downloaded at runtime from CDN.
#
# Usage:
#   ./scripts/bundle-sherpa-models.sh
#
# Idempotent: skips downloads if files already exist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$PROJECT_ROOT/resources/sherpa-models"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Model definitions: key="url|filename|min_size_bytes"
# Sources: ModelScope for confirmed equivalent files. pyannote reverb-v2 stays on
# hf-mirror until an equivalent ModelScope ONNX file is confirmed.
MODELS=(
  "sensevoice/tokens.txt|https://modelscope.cn/api/v1/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/repo?Revision=master&FilePath=tokens.txt|tokens.txt|1000"
  "vad/silero_vad.onnx|https://modelscope.cn/api/v1/models/pengzhendong/silero-vad/repo?Revision=master&FilePath=v4/silero_vad.onnx|silero_vad.onnx|50000"
  "pyannote/model.int8.onnx|https://hf-mirror.com/csukuangfj/sherpa-onnx-reverb-diarization-v2/resolve/main/model.int8.onnx|model.int8.onnx|1000000"
)

download_file() {
  local key="$1"
  local url="$2"
  local filename="$3"
  local min_size="$4"
  local dest_dir="$RESOURCES_DIR/$(dirname "$key")"
  local dest_file="$dest_dir/$filename"

  # Check if already exists and meets min size
  if [[ -f "$dest_file" ]]; then
    local size
    size=$(stat -f%z "$dest_file" 2>/dev/null || stat -c%s "$dest_file" 2>/dev/null || echo 0)
    if [[ "$size" -ge "$min_size" ]]; then
      log_info "  $key already exists ($size bytes), skipping."
      return 0
    fi
    log_warn "  $key exists but too small ($size < $min_size), re-downloading..."
  fi

  mkdir -p "$dest_dir"

  log_info "  Downloading $filename..."
  if curl -fsSL --retry 3 --retry-delay 2 -o "$dest_file" "$url"; then
    local size
    size=$(stat -f%z "$dest_file" 2>/dev/null || stat -c%s "$dest_file" 2>/dev/null || echo 0)
    if [[ "$size" -lt "$min_size" ]]; then
      log_error "  Downloaded file too small ($size bytes), expected at least $min_size"
      rm -f "$dest_file"
      return 1
    fi
    log_info "  OK: $key ($size bytes)"
  else
    log_error "  Failed to download $url"
    rm -f "$dest_file"
    return 1
  fi
}

main() {
  log_info "Sherpa-ONNX small models bundler"
  log_info "Resources directory: $RESOURCES_DIR"
  echo ""

  local failed=0

  for entry in "${MODELS[@]}"; do
    IFS='|' read -r key url filename min_size <<< "$entry"
    log_info "[$key]"
    if ! download_file "$key" "$url" "$filename" "$min_size"; then
      ((failed++))
    fi
    echo ""
  done

  log_info "========================================="
  if [[ $failed -eq 0 ]]; then
    log_info "All small models ready!"
  else
    log_warn "$failed model(s) failed to download."
  fi
  log_info "========================================="

  # Show contents
  echo ""
  log_info "Contents:"
  find "$RESOURCES_DIR" -type f 2>/dev/null | sort | while read -r f; do
    local size
    size=$(du -h "$f" | cut -f1)
    echo "  $size  $f"
  done
}

main "$@"
