#!/usr/bin/env bash
# fix-tv-ssh.sh — diagnose/repair "SSH timed out / no route to host" for RetroArch Remote
# (same idea as macos-prime-remote-control/scripts/fix-tv-connection.sh, but port 22)
#
# Usage:
#   scripts/fix-tv-ssh.sh [--ip ADDR] [--restart-wifi] [--sudo] [--yes]
#
set -uo pipefail

SETTINGS="${HOME}/Library/Application Support/com.aicoder.retroarch-control/settings.json"
TARGET_IP=""
RESTART_WIFI=0
USE_SUDO=0
ASSUME_YES=0
PORT=22

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip) TARGET_IP="${2:-}"; shift 2 ;;
    --port) PORT="${2:-22}"; shift 2 ;;
    --restart-wifi) RESTART_WIFI=1; shift ;;
    --sudo) USE_SUDO=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TARGET_IP" && -f "$SETTINGS" ]]; then
  TARGET_IP="$(python3 -c "import json;print(json.load(open('''$SETTINGS''')).get('host',''))" 2>/dev/null || true)"
  PORT="$(python3 -c "import json;print(json.load(open('''$SETTINGS''')).get('port',22))" 2>/dev/null || echo 22)"
fi
TARGET_IP="${TARGET_IP:-192.168.0.79}"

ping_ok() { ping -c 1 -t 2 "$1" >/dev/null 2>&1; }
ssh_ok() { nc -z -G 3 "$1" "$2" >/dev/null 2>&1; }

echo "== Target $TARGET_IP port $PORT =="
if ping_ok "$TARGET_IP"; then echo "✓ ping ok"; else echo "✗ no ping"; fi
if ssh_ok "$TARGET_IP" "$PORT"; then echo "✓ SSH port open"; else echo "✗ SSH closed/unreachable"; fi
arp -n "$TARGET_IP" 2>/dev/null || arp "$TARGET_IP" 2>/dev/null || true

echo ""
echo "== mDNS lgwebostv.local =="
FOUND="$(dscacheutil -q host -a name lgwebostv.local 2>/dev/null | awk -F': ' '/^ip_address:/{print $2; exit}')"
if [[ -z "$FOUND" ]]; then
  FOUND="$(ping -c 1 -t 1 lgwebostv.local 2>/dev/null | sed -n 's/.*(\([0-9.]*\)).*/\1/p' | head -1)"
fi
if [[ -n "$FOUND" ]]; then
  echo "discovered: $FOUND"
  if [[ "$FOUND" != "$TARGET_IP" ]]; then
    echo "! IP differs from settings ($TARGET_IP)"
    if [[ $ASSUME_YES -eq 1 || $USE_SUDO -eq 1 ]]; then
      :
    fi
  fi
  TARGET_IP="$FOUND"
else
  echo "not found via mDNS"
fi

echo ""
echo "== Flush ARP / host route =="
if [[ $USE_SUDO -eq 1 ]]; then
  sudo /usr/sbin/arp -d "$TARGET_IP" 2>/dev/null || true
  sudo /sbin/route -n delete -host "$TARGET_IP" 2>/dev/null || true
  sudo /sbin/route -n delete "$TARGET_IP" 2>/dev/null || true
  echo "flushed (sudo)"
else
  /usr/sbin/arp -d "$TARGET_IP" 2>/dev/null || echo "(arp -d needs sudo — re-run with --sudo)"
  /sbin/route -n delete -host "$TARGET_IP" 2>/dev/null || true
fi

for _ in 1 2 3; do ping -c 1 -t 1 "$TARGET_IP" >/dev/null 2>&1 || true; done

if [[ $RESTART_WIFI -eq 1 ]]; then
  IFACE="$(networksetup -listallhardwareports 2>/dev/null | awk '/Wi-Fi|AirPort/{getline; print $2; exit}')"
  IFACE="${IFACE:-en0}"
  echo "== Restart Wi-Fi $IFACE =="
  networksetup -setairportpower "$IFACE" off
  sleep 3
  networksetup -setairportpower "$IFACE" on
  sleep 8
fi

echo ""
echo "== Re-test =="
if ssh_ok "$TARGET_IP" "$PORT"; then
  echo "✓ SSH reachable at $TARGET_IP:$PORT"
  exit 0
fi
echo "✗ Still unreachable"
echo "On the TV: power on, same Wi-Fi as this Mac, enable Developer Mode/SSH,"
echo "check Settings → Network for the IP, then update the app Host field."
exit 1
