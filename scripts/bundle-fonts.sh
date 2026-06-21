#!/usr/bin/env bash
# bundle-fonts.sh — Downloads Noto Sans SC font for PDF generation.
#
# Usage:
#   ./scripts/bundle-fonts.sh
#
# Idempotent: skips download if the font already exists.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FONT_DIR="$ROOT/resources/fonts"
FONT_FILE="$FONT_DIR/NotoSansSC-Regular.otf"

if [ -f "$FONT_FILE" ]; then
  echo "[skip] NotoSansSC-Regular.otf already present"
  exit 0
fi

mkdir -p "$FONT_DIR"

# Download from notofonts/noto-cjk releases
FONT_ZIP_URL="https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/08_NotoSansCJKsc.zip"
TMP_DIR="$(mktemp -d)"

echo "[dl] Downloading NotoSansCJKsc font package..."
curl -fsSL "$FONT_ZIP_URL" -o "$TMP_DIR/noto-sans-sc.zip"

if [ ! -f "$TMP_DIR/noto-sans-sc.zip" ]; then
  echo "[ERROR] Download failed"
  rm -rf "$TMP_DIR"
  exit 1
fi

echo "[extract] Extracting NotoSansCJKsc-Regular.otf..."
unzip -q "$TMP_DIR/noto-sans-sc.zip" "NotoSansCJKsc-Regular.otf" -d "$TMP_DIR"

if [ ! -f "$TMP_DIR/NotoSansCJKsc-Regular.otf" ]; then
  echo "[ERROR] Font not found in archive"
  rm -rf "$TMP_DIR"
  exit 1
fi

mv "$TMP_DIR/NotoSansCJKsc-Regular.otf" "$FONT_FILE"
rm -rf "$TMP_DIR"

SIZE=$(stat -f%z "$FONT_FILE" 2>/dev/null || stat -c%s "$FONT_FILE" 2>/dev/null)
echo "[ok] NotoSansSC-Regular.otf downloaded ($SIZE bytes)"
