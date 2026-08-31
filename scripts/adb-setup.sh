#!/usr/bin/env bash
#
# adb-setup.sh — one-time wireless ADB bootstrap for NeuraCall.
#
# Detects every Android phone connected over USB, switches each to TCP/IP
# listening on :5555, discovers the phone's Wi-Fi IP, connects over the LAN,
# verifies the wireless link, and persists the endpoints to devices.json at the
# repo root so the device-manager can reconnect them later.
#
# Safe to re-run: already-online endpoints are detected and skipped, and
# devices.json is written atomically/idempotently.
#
# Usage:
#   ./scripts/adb-setup.sh [--dry-run]
#
# --dry-run prints the adb commands that WOULD run, without executing them
# (used for offline testing / review).
#
set -euo pipefail

# --- locate the repo root so devices.json lands next to package.json -------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEVICES_FILE="${REPO_ROOT}/devices.json"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

ADB="${ADB:-adb}"

log()  { printf '[adb-setup] %s\n' "$*" >&2; }
die()  { printf '[adb-setup] error: %s\n' "$*" >&2; exit 1; }

# Run each adb invocation through one place so --dry-run can intercept it.
run_adb() {
  if (( DRY_RUN )); then
    printf '[dry-run] adb %s\n' "$*" >&2
    return 0
  fi
  "$ADB" "$@"
}

# The 2-space JSON writer used by the Node device-manager (devicesFile.ts).
format_devices_json() {
  # args: array of "endpoint|serial|label" records, emitted as a devices array.
  local version line
  version=1
  printf '{\n  "version": %s,\n  "devices": [\n' "$version"
  local i=0 n="$#"
  for line in "$@"; do
    local endpoint serial label
    endpoint="${line%%|*}"; rest="${line#*|}"
    serial="${rest%%|*}"; label="${rest#*|}"
    local comma=""
    if (( i+1 < n )); then comma=","; fi
    printf '    {\n      "endpoint": "%s"' "$endpoint"
    [[ -n "$serial" ]] && printf ',\n      "serial": "%s"' "$serial"
    [[ -n "$label" ]]  && printf ',\n      "label": "%s"' "$label"
    printf ',\n      "addedAt": "%s"\n    }%s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$comma"
    i=$((i+1))
  done
  printf '  ]\n}\n'
}

# --- preflight: adb must exist ----------------------------------------------
if ! command -v "$ADB" >/dev/null 2>&1; then
  die "adb not found on PATH (set ADB=/path/to/adb or install platform-tools)."
fi

log "using $(command -v "$ADB")"

# --- 1. enumerate USB-attached devices --------------------------------------
# `adb devices` lines: `<serial> <state>`. Wireless endpoints contain ':';
# USB serials never do, so filter to the non-':' lines that are in 'device'
# or 'offline' state (skip 'unauthorized' with a clear warning).
mapfile -t DEVICE_LINES < <(run_adb devices | sed '1d' | grep -v '^$' || true)

USB_SERIALS=()
for line in "${DEVICE_LINES[@]}"; do
  serial="${line%%[[:space:]]*}"
  state="${line##*[[:space:]]}"
  [[ "$serial" == *":"* ]] && continue          # wireless, not USB
  case "$state" in
    device|offline) USB_SERIALS+=("$serial") ;;
    unauthorized)   log "skipping $serial (unauthorized — accept the RSA prompt on the phone)" ;;
    *)              log "skipping $serial (state: $state)" ;;
  esac
done

if (( ${#USB_SERIALS[@]} == 0 )); then
  log "no USB devices found. Plug a phone in over USB (USB debugging enabled) and re-run."
  log "known wireless endpoints are not reconnected by this script; use ./scripts/adbtool.sh reconnect --all"
  exit 0
fi

log "found ${#USB_SERIALS[@]} USB device(s) over USB."

# --- 2..5. per device: tcpip, discover Wi-Fi IP, connect, verify ------------
ENDPOINTS=()   # "endpoint|serial|label"
for serial in "${USB_SERIALS[@]}"; do
  log "handling $serial ..."

  # model label for human readability
  label=""
  if (( ! DRY_RUN )); then
    label="$("$ADB" -s "$serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r' | head -1 || true)"
  fi

  # step 2: switch to TCP/IP on the default port
  run_adb -s "$serial" tcpip 5555 >/dev/null 2>&1 || log "tcpip on $serial reported a failure (may already be on TCP/IP)"
  sleep 1

  # step 3: the phone's Wi-Fi address — prefer the source address of the
  # default route, fall back to the wlan0 link address.
  ip=""
  if (( ! DRY_RUN )); then
    ip="$("$ADB" -s "$serial" shell 'ip route get 1 2>/dev/null | sed -n "s/.*src \([0-9.]*\).*/\1/p"' 2>/dev/null | tr -d '\r' | head -1 || true)"
    if [[ -z "$ip" ]]; then
      ip="$("$ADB" -s "$serial" shell 'ip addr show wlan0 2>/dev/null | sed -n "s/.*inet \([0-9.]*\)\/.*/\1/p"' 2>/dev/null | tr -d '\r' | head -1 || true)"
    fi
  fi

  if [[ -z "$ip" ]]; then
    log "could not determine Wi-Fi IP for $serial (is the phone on Wi-Fi?). Skipping."
    continue
  fi

  endpoint="${ip}:5555"

  # step 4: connect over the LAN
  connect_out="$(run_adb connect "$endpoint" 2>&1 || true)"

  # step 5: verify the wireless link is live
  verify=""
  if (( ! DRY_RUN )); then
    verify="$("$ADB" devices 2>/dev/null | awk -v e="$endpoint" '$1==e {print $2}' || true)"
  else
    verify="device"
  fi

  if [[ "$verify" == "device" ]]; then
    log "connected $serial -> $endpoint"
    ENDPOINTS+=("${endpoint}|${serial}|${label}")
  else
    log "connect to $endpoint reported: ${connect_out:-no output} (verify state: ${verify:-n/a})"
  fi
done

# --- 6. persist to devices.json ---------------------------------------------
if (( ${#ENDPOINTS[@]} == 0 )); then
  log "no wireless endpoints were established; leaving $DEVICES_FILE unchanged."
  exit 0
fi

if (( DRY_RUN )); then
  log "--- would write $DEVICES_FILE ---"
  format_devices_json "${ENDPOINTS[@]}"
  log "--- end ---"
else
  mkdir -p "$(dirname "$DEVICES_FILE")"
  format_devices_json "${ENDPOINTS[@]}" > "${DEVICES_FILE}.tmp"
  mv "${DEVICES_FILE}.tmp" "$DEVICES_FILE"
  log "wrote ${ENDPOINTS[@]} to $DEVICES_FILE"
fi

log "done. Reconnect later with: ./scripts/adbtool.sh reconnect --all"
