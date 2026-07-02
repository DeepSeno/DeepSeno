#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# DeepSeno Release Script
# Build → Upload to COS → Register in Admin API
# ─────────────────────────────────────────────────────
set -euo pipefail

# ── Config ───────────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_DIR}/.env"
  set +a
fi

CDN_BASE="${CDN_BASE_URL:-https://voicebrain-dl.enmooy.com}"
COS_RELEASES_DIR="releases"
PUBLISH_URL="${CDN_BASE%/}/${COS_RELEASES_DIR}"
COSCMD="${COSCMD:-$(command -v coscmd 2>/dev/null \
  || find /Library/Frameworks/Python.framework -name coscmd -type f -perm +111 2>/dev/null | head -1 \
  || echo coscmd)}"
API_BASE="${API_BASE_URL:-https://deepseno.enmooy.com/api/v1}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }
step() { echo -e "\n${CYAN}━━━ $* ━━━${NC}"; }

# ── Parse args ───────────────────────────────────────
PLATFORM="${1:-}"
SKIP_BUILD="${SKIP_BUILD:-false}"

usage() {
  echo "Usage: $0 <platform> [--skip-build]"
  echo ""
  echo "Platforms:"
  echo "  mac       Build & release macOS (arm64 + x64)"
  echo "  win       Build & release Windows (x64)"
  echo "  all       Build & release all platforms"
  echo ""
  echo "Options:"
  echo "  --skip-build   Skip build step, upload existing artifacts in out/"
  echo ""
  echo "Environment:"
  echo "  ADMIN_TOKEN    Admin JWT token (required for API registration)"
  echo "                 Get it from: Admin panel → Login → DevTools → localStorage"
  exit 1
}

[[ -z "$PLATFORM" ]] && usage
[[ "$PLATFORM" != "mac" && "$PLATFORM" != "win" && "$PLATFORM" != "all" ]] && usage
[[ "${2:-}" == "--skip-build" ]] && SKIP_BUILD=true

# ── Read version ─────────────────────────────────────
cd "$PROJECT_DIR"
VERSION=$(node -p "require('./package.json').version")
step "Releasing DeepSeno v${VERSION} for ${PLATFORM}"

# ── Pre-flight checks ────────────────────────────────
step "Pre-flight checks"

command -v "$COSCMD" >/dev/null 2>&1 || err "coscmd not found at $COSCMD"
log "coscmd found"

# ── Notarization credentials (App Store Connect API Key) ─────────
# electron-builder reads these env vars to notarize the .app
# Required for proper macOS distribution — without these, .app is signed but NOT notarized,
# and users get Gatekeeper warning "cannot verify developer" on first launch.
# Set APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER in your environment or .env file.
if [[ "$PLATFORM" == "mac" || "$PLATFORM" == "all" ]]; then
  if [[ -z "${APPLE_API_KEY:-}" ]]; then
    err "APPLE_API_KEY not set. macOS builds require notarization credentials."
  fi
  if [[ -z "${APPLE_API_KEY_ID:-}" ]]; then
    err "APPLE_API_KEY_ID not set. macOS builds require notarization credentials."
  fi
  if [[ -z "${APPLE_API_ISSUER:-}" ]]; then
    err "APPLE_API_ISSUER not set. macOS builds require notarization credentials."
  fi
  log "Notarization API key: ${APPLE_API_KEY_ID} (from env)"
fi

if [[ -z "${ADMIN_TOKEN:-}" ]]; then
  warn "ADMIN_TOKEN not set — will skip API registration"
  warn "Set it to register releases in admin panel automatically"
  HAS_TOKEN=false
else
  HAS_TOKEN=true
  log "ADMIN_TOKEN set"
fi

# ── Build ────────────────────────────────────────────
build_platform() {
  local plat="$1"
  step "Building for ${plat}"
  if [[ "$SKIP_BUILD" == "true" ]]; then
    warn "Skipping build (--skip-build)"
    return
  fi
  case "$plat" in
    mac)
      # Build with notarization enabled for official release.
      # Package.json has notarize:false by default (for open-source builds
      # without Apple credentials). The release script overrides it here.
      electron-vite build && pnpm exec electron-rebuild -f -w sherpa-onnx-node && electron-builder --mac --arm64 --x64 --config.notarize=true --config.publish.url="${PUBLISH_URL}"
      ;;
    win)
      electron-vite build && pnpm exec electron-rebuild -f -w sherpa-onnx-node && electron-builder --win --x64 --config.publish.url="${PUBLISH_URL}"
      ;;
  esac
  log "Build complete"
}

# ── Upload to COS ────────────────────────────────────
upload_file() {
  local local_path="$1"
  local cos_key="$2"

  if [[ ! -f "$local_path" ]]; then
    warn "File not found: $local_path — skipping"
    return 1
  fi

  local size human
  size=$(stat -f%z "$local_path" 2>/dev/null || stat --printf="%s" "$local_path" 2>/dev/null)
  human=$(awk -v b="$size" 'BEGIN{
    split("B K M G T",u); i=1;
    while(b>=1024 && i<5){b/=1024; i++}
    printf (i==1?"%d%s":"%.1f%s"), b, u[i]
  }')
  log "Uploading $(basename "$local_path") ($human)"

  "$COSCMD" upload "$local_path" "$cos_key"
  log "Uploaded → ${CDN_BASE%/}/${cos_key}"
}

# ── Register in Admin API ────────────────────────────
register_release() {
  local version="$1"
  local platform="$2"
  local file_url="$3"
  local file_size="$4"
  local checksum="$5"

  if [[ "$HAS_TOKEN" != "true" ]]; then
    warn "Skipping API registration (no ADMIN_TOKEN)"
    return
  fi

  local resp
  resp=$(curl -s -w "\n%{http_code}" -X POST "${API_BASE}/admin/releases" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"version\": \"${version}\",
      \"platform\": \"${platform}\",
      \"file_url\": \"${file_url}\",
      \"file_size\": ${file_size},
      \"checksum\": \"${checksum}\"
    }")

  local http_code
  http_code=$(echo "$resp" | tail -1)
  local body
  body=$(echo "$resp" | sed '$d')

  if [[ "$http_code" == "201" ]]; then
    local release_id
    release_id=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "?")
    log "Registered release #${release_id} (${platform})"

    # Auto-set as latest
    curl -s -X PUT "${API_BASE}/admin/releases/${release_id}/latest" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" > /dev/null
    log "Set as latest for ${platform}"
  else
    warn "API registration failed (HTTP ${http_code}): ${body}"
  fi
}

# ── Process one platform ─────────────────────────────
release_mac() {
  build_platform mac

  local out_dir="${PROJECT_DIR}/out"

  step "Uploading macOS artifacts"

  # Upload DMG files for THIS version only.
  # electron-builder names them: arm64 → DeepSeno-<ver>-arm64.dmg, x64 → DeepSeno-<ver>.dmg
  # Pin to $VERSION: out/ accumulates old DMGs, and a bare glob + `head -1` would
  # pick the wrong (older) file, leaving the current version's DMG un-uploaded.
  for arch in arm64 x64; do
    local dmg
    if [[ "$arch" == "arm64" ]]; then
      dmg="${out_dir}/DeepSeno-${VERSION}-arm64.dmg"
    else
      dmg="${out_dir}/DeepSeno-${VERSION}.dmg"
    fi
    if [[ -f "$dmg" ]]; then
      local fname
      fname=$(basename "$dmg")
      upload_file "$dmg" "${COS_RELEASES_DIR}/${fname}"

      local size checksum platform_key
      size=$(stat -f%z "$dmg" 2>/dev/null || stat --printf="%s" "$dmg" 2>/dev/null)
      checksum=$(shasum -a 256 "$dmg" | awk '{print $1}')
      platform_key="macos_${arch}"

      register_release "$VERSION" "$platform_key" "${CDN_BASE%/}/${COS_RELEASES_DIR}/${fname}" "$size" "$checksum"
    fi
  done

  # Also upload this version's zip files (used by electron-updater for differential updates).
  # Pin to $VERSION so we don't needlessly re-upload every historical zip sitting in out/.
  for zip in "${out_dir}/DeepSeno-${VERSION}"*.zip; do
    [[ -f "$zip" ]] || continue
    upload_file "$zip" "${COS_RELEASES_DIR}/$(basename "$zip")"
  done

  # Upload blockmaps for differential updates. Missing blockmaps may force
  # electron-updater to fall back to full downloads or report noisy failures.
  for blockmap in "${out_dir}/DeepSeno-${VERSION}"*.blockmap; do
    [[ -f "$blockmap" ]] || continue
    upload_file "$blockmap" "${COS_RELEASES_DIR}/$(basename "$blockmap")"
  done

  # Upload latest-mac.yml last so clients never see a manifest before all
  # referenced artifacts are available.
  upload_file "${out_dir}/latest-mac.yml" "${COS_RELEASES_DIR}/latest-mac.yml"

  log "macOS release complete"
}

release_win() {
  build_platform win

  local out_dir="${PROJECT_DIR}/out"

  step "Uploading Windows artifacts"

  # Find and upload this version's exe (pin to $VERSION — out/ may hold older builds)
  local exe
  exe=$(find "$out_dir" -maxdepth 1 -name "*${VERSION}*.exe" | head -1 || true)
  if [[ -n "$exe" ]]; then
    local fname
    fname=$(basename "$exe")
    upload_file "$exe" "${COS_RELEASES_DIR}/${fname}"

    local size checksum
    size=$(stat -f%z "$exe" 2>/dev/null || stat --printf="%s" "$exe" 2>/dev/null)
    checksum=$(shasum -a 256 "$exe" | awk '{print $1}')

    register_release "$VERSION" "windows" "${CDN_BASE%/}/${COS_RELEASES_DIR}/${fname}" "$size" "$checksum"
  fi

  for blockmap in "${out_dir}/"*${VERSION}*.blockmap; do
    [[ -f "$blockmap" ]] || continue
    upload_file "$blockmap" "${COS_RELEASES_DIR}/$(basename "$blockmap")"
  done

  # Upload latest.yml last so Windows clients only see a fully uploaded release.
  upload_file "${out_dir}/latest.yml" "${COS_RELEASES_DIR}/latest.yml"

  log "Windows release complete"
}

# ── Main ─────────────────────────────────────────────
case "$PLATFORM" in
  mac) release_mac ;;
  win) release_win ;;
  all) release_mac; release_win ;;
esac

# ── Upload Release Notes ────────────────────────────
upload_release_notes() {
  local notes_file="${PROJECT_DIR}/out/release-notes-${VERSION}.json"
  if [[ ! -f "$notes_file" ]]; then
    warn "No release notes found at ${notes_file} — skipping"
    return
  fi
  if [[ "$HAS_TOKEN" != "true" ]]; then
    warn "Skipping release notes upload (no ADMIN_TOKEN)"
    return
  fi

  step "Uploading release notes"
  local resp http_code
  resp=$(curl -s -w "\n%{http_code}" -X POST "${API_BASE}/admin/release-notes" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d @"$notes_file")
  http_code=$(echo "$resp" | tail -1)
  if [[ "$http_code" == "200" ]]; then
    log "Release notes uploaded for v${VERSION}"
  else
    warn "Release notes upload failed (HTTP ${http_code})"
  fi
}

upload_release_notes

step "Release v${VERSION} complete!"
echo ""
echo "  CDN:   ${PUBLISH_URL}/"
echo "  Admin: ${API_BASE%/api/v1}/admin/releases"
echo ""
if [[ "$HAS_TOKEN" != "true" ]]; then
  warn "Remember to manually set the release as 'latest' in admin panel"
fi
