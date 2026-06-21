#!/usr/bin/env bash
# bundle-win-tools.sh — Compiles Windows-only helper tools from C# source.
#
# Source:  resources/win-tools/*.cs
# Output:  scripts/*.exe
#
# These tiny utilities are used by electron/main.ts for foreground window
# management and clipboard paste on Windows (getfg.exe, setfg.exe).
#
# Usage:
#   ./scripts/bundle-win-tools.sh        # Compile for current platform
#
# Requirements: Windows with .NET Framework (ships with Windows 10/11).
# On macOS/Linux this script is a no-op.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$PROJECT_ROOT/resources/win-tools"
OUT_DIR="$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Tools to compile: source -> binary
TOOLS=(
  "getfg.cs:getfg.exe"
  "setfg.cs:setfg.exe"
)

# Locate csc.exe on Windows
find_csc() {
  # Try .NET Framework 64-bit first, then 32-bit
  local candidates=(
    "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe"
  )
  for csc in "${candidates[@]}"; do
    if [[ -f "$csc" ]]; then
      echo "$csc"
      return 0
    fi
  done
  # Fall back to PATH
  if command -v csc.exe &>/dev/null; then
    echo "csc.exe"
    return 0
  fi
  return 1
}

compile_tool() {
  local src="$1"
  local out="$2"
  local csc="$3"

  local src_path="$SRC_DIR/$src"
  local out_path="$OUT_DIR/$out"

  if [[ ! -f "$src_path" ]]; then
    log_error "Source not found: $src_path"
    return 1
  fi

  # Skip if binary is newer than source
  if [[ -f "$out_path" ]] && [[ "$out_path" -nt "$src_path" ]]; then
    log_info "$out — up to date, skipping."
    return 0
  fi

  log_info "Compiling $src -> $out ..."
  # MSYS2 path conversion can mangle paths passed to native Windows programs.
  # Use cygpath -w to explicitly convert to Windows-style paths for csc.exe.
  local win_src win_out
  win_src=$(cygpath -w "$src_path" 2>/dev/null || echo "$src_path")
  win_out=$(cygpath -w "$out_path" 2>/dev/null || echo "$out_path")
  "$csc" -nologo -target:exe -out:"$win_out" "$win_src"
  log_info "$out — done ($(du -h "$out_path" | cut -f1))"
}

main() {
  # Only run on Windows
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) ;;
    *)
      log_warn "Not Windows ($(uname -s)) — skipping win-tools compilation."
      log_warn "These are only needed for Windows packaging. On macOS, this is expected."
      exit 0
      ;;
  esac

  log_info "Source dir:  $SRC_DIR"
  log_info "Output dir:  $OUT_DIR"

  log_info "Locating C# compiler (csc.exe)..."
  local csc
  if ! csc="$(find_csc)"; then
    log_error "csc.exe not found. Requires .NET Framework 4.x (ships with Windows 10/11)."
    exit 1
  fi
  log_info "Using: $csc"

  local failed=0
  for entry in "${TOOLS[@]}"; do
    local src="${entry%%:*}"
    local out="${entry##*:}"
    if ! compile_tool "$src" "$out" "$csc"; then
      failed=$((failed + 1))
    fi
  done

  if [[ $failed -gt 0 ]]; then
    log_error "$failed tool(s) failed to compile."
    exit 1
  fi

  log_info "All Windows tools compiled successfully."
}

main "$@"
