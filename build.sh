#!/usr/bin/env bash
# Build RetroArch Control as a macOS .dmg
#
# Usage:
#   ./build.sh              # release .dmg (current architecture)
#   ./build.sh --universal  # universal binary (arm64 + x86_64; needs both rust targets)
#   ./build.sh --debug      # debug build + .dmg (faster, larger)
#   ./build.sh --open       # open Finder to the .dmg when done
#   ./build.sh --clean      # cargo clean first, then build
#
# Output:
#   ./RetroArch-Control-<version>-<arch>.dmg
#   (also left under src-tauri/target/.../bundle/dmg/)
#
# Prerequisites: bun, cargo, rustc, Xcode CLT (macOS only)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

UNIVERSAL=0
DEBUG=0
OPEN=0
CLEAN=0

for arg in "$@"; do
  case "$arg" in
    --universal|-u) UNIVERSAL=1 ;;
    --debug|-d) DEBUG=1 ;;
    --open|-o) OPEN=1 ;;
    --clean|-c) CLEAN=1 ;;
    -h|--help)
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' not found. Install it first." >&2
    exit 1
  }
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: .dmg builds are only supported on macOS." >&2
  exit 1
fi

need bun
need cargo
need rustc

VERSION="$(
  python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])" 2>/dev/null \
    || echo "0.1.0"
)"
PRODUCT="RetroArch Control"
ARCH_NATIVE="$(uname -m)" # arm64 | x86_64

echo "==> RetroArch Control — macOS .dmg build"
echo "    project: $ROOT"
echo "    version: $VERSION"
echo "    arch:    $ARCH_NATIVE$([ "$UNIVERSAL" -eq 1 ] && echo ' (universal)' || true)"
echo "    mode:    $([ "$DEBUG" -eq 1 ] && echo debug || echo release)"

if [[ ! -d node_modules ]]; then
  echo "==> bun install"
  bun install
fi

if [[ "$CLEAN" -eq 1 ]]; then
  echo "==> cargo clean"
  (cd src-tauri && cargo clean)
fi

BUILD_ARGS=(build --bundles dmg --ci)
if [[ "$DEBUG" -eq 1 ]]; then
  BUILD_ARGS+=(--debug)
fi
if [[ "$UNIVERSAL" -eq 1 ]]; then
  # Requires: rustup target add aarch64-apple-darwin x86_64-apple-darwin
  for t in aarch64-apple-darwin x86_64-apple-darwin; do
    if ! rustup target list --installed 2>/dev/null | grep -qx "$t"; then
      echo "==> rustup target add $t"
      rustup target add "$t" || {
        echo "error: install rustup target $t first" >&2
        exit 1
      }
    fi
  done
  BUILD_ARGS+=(--target universal-apple-darwin)
fi

echo "==> bunx tauri ${BUILD_ARGS[*]}"
bunx tauri "${BUILD_ARGS[@]}"

# Locate produced .dmg
if [[ "$DEBUG" -eq 1 ]]; then
  PROFILE="debug"
else
  PROFILE="release"
fi

if [[ "$UNIVERSAL" -eq 1 ]]; then
  BUNDLE_DIR="$ROOT/src-tauri/target/universal-apple-darwin/${PROFILE}/bundle"
  ARCH_TAG="universal"
else
  # Host triple dir may or may not be used; check both
  BUNDLE_DIR="$ROOT/src-tauri/target/${PROFILE}/bundle"
  if [[ ! -d "$BUNDLE_DIR/dmg" ]]; then
    TRIPLE="$(rustc -vV | awk -F': ' '/^host:/{print $2}')"
    BUNDLE_DIR="$ROOT/src-tauri/target/${TRIPLE}/${PROFILE}/bundle"
  fi
  ARCH_TAG="$ARCH_NATIVE"
fi

DMG_SRC=""
if [[ -d "$BUNDLE_DIR/dmg" ]]; then
  # Prefer newest .dmg
  DMG_SRC="$(ls -t "$BUNDLE_DIR/dmg"/*.dmg 2>/dev/null | head -1 || true)"
fi

if [[ -z "$DMG_SRC" || ! -f "$DMG_SRC" ]]; then
  echo "error: no .dmg found under $BUNDLE_DIR/dmg" >&2
  echo "Look under: $ROOT/src-tauri/target/" >&2
  find "$ROOT/src-tauri/target" -name '*.dmg' 2>/dev/null | head -20 || true
  exit 1
fi

# Safe filename: RetroArch-Control-0.1.0-arm64.dmg
SAFE_NAME="RetroArch-Control-${VERSION}-${ARCH_TAG}.dmg"
DMG_DST="$ROOT/$SAFE_NAME"
cp -f "$DMG_SRC" "$DMG_DST"

echo ""
echo "==> Done"
echo "    source: $DMG_SRC"
echo "    dmg:    $DMG_DST"
ls -lh "$DMG_DST"

if [[ "$OPEN" -eq 1 ]]; then
  open -R "$DMG_DST"
fi
