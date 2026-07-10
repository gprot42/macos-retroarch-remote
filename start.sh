#!/usr/bin/env bash
# Start RetroArch Control (Tauri + Bun) in dev mode.
#
# Usage:
#   ./start.sh              # install deps if needed, then tauri dev
#   ./start.sh --build      # production build (.app under src-tauri/target)
#   ./start.sh --install    # bun install only

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

MODE="dev"
for arg in "$@"; do
  case "$arg" in
    --build|-b) MODE="build" ;;
    --install|-i) MODE="install" ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' not found. Install it first." >&2
    exit 1
  }
}

need bun
need cargo
need rustc

if [[ ! -d node_modules ]] || [[ ! -f bun.lock && ! -f bun.lockb ]]; then
  echo "==> bun install"
  bun install
elif [[ "$MODE" == "install" ]]; then
  echo "==> bun install"
  bun install
  exit 0
fi

if [[ "$MODE" == "install" ]]; then
  echo "==> bun install"
  bun install
  exit 0
fi

# Sensible defaults if script path is wrong for this machine
if [[ -z "${WEBOS_CONTROL_SCRIPT:-}" ]]; then
  CANDIDATES=(
    "$HOME/src/RetroArch/webos/control-retroarch.sh"
    "$HOME/src/retroarch/webos/control-retroarch.sh"
    "$(cd "$ROOT/../RetroArch/webos" 2>/dev/null && pwd)/control-retroarch.sh"
  )
  for c in "${CANDIDATES[@]}"; do
    if [[ -x "$c" || -f "$c" ]]; then
      export WEBOS_CONTROL_SCRIPT="$c"
      break
    fi
  done
fi

echo "==> RetroArch Control  ($MODE)"
echo "    project: $ROOT"
if [[ -n "${WEBOS_CONTROL_SCRIPT:-}" ]]; then
  echo "    script:  $WEBOS_CONTROL_SCRIPT"
fi

case "$MODE" in
  build)
    echo "==> bun run tauri build"
    bun run tauri build
    echo ""
    echo "Bundle (if successful):"
    echo "  $ROOT/src-tauri/target/release/bundle/"
    ls -la "$ROOT/src-tauri/target/release/bundle/macos/" 2>/dev/null || true
    ;;
  *)
    echo "==> bun run tauri dev"
    exec bun run tauri dev
    ;;
esac
