#!/usr/bin/env bash
#
# adbtool.sh — manage NeuraCall's known wireless ADB endpoints (devices.json).
#
# devices.json (repo root) is the list of wireless endpoints the device-manager
# reconnects to. This tool reads, edits, and reconnects that file.
#
# Subcommands:
#   list                Print known endpoints (one per line).
#   add <host[:port]>   Add a wireless endpoint (default port 5555), reconnect it.
#   remove <host[:port]> Remove an endpoint by host (and port) from the file.
#   reconnect [--all]   Re-run `adb connect` for every known endpoint. Plain
#                        `reconnect` only touches endpoints that adb reports as
#                        offline; `--all` connects them all unconditionally.
#
# Uses `node` for robust JSON read/write (Node is a guaranteed dependency of
# this monorepo; the file is 2-space JSON written by adb-setup.sh).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEVICES_FILE="${REPO_ROOT}/devices.json"

ADB="${ADB:-adb}"

log()  { printf '[adbtool] %s\n' "$*" >&2; }
die()  { printf '[adbtool] error: %s\n' "$*" >&2; exit 1; }
usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed -n 's/^# \{0,1\}//p' >&2
  exit "${1:-0}"
}

endpoint_default_port() {
  # Print $1 with :5555 appended unless it already has a port.
  if [[ "$1" == *":"* ]]; then
    printf '%s\n' "$1"
  else
    printf '%s:5555\n' "$1"
  fi
}

# --- JSON helpers (delegated to node for correctness) ------------------------
json_read_endpoints() {
  # Print every endpoint in devices.json, one per line. Missing/invalid file
  # prints nothing (callers treat "no endpoints" like an empty file).
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    if (!fs.existsSync(p)) process.exit(0);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch { process.exit(2); }
    for (const d of (raw.devices || [])) if (d && d.endpoint) console.log(d.endpoint);
  ' "$DEVICES_FILE" 2>/dev/null || true
}

json_add_endpoint() {
  # Add/reconnect one endpoint in devices.json (keeps existing metadata).
  # $1 = endpoint, $2 = serial (optional)
  node -e '
    const fs = require("fs");
    const p = process.argv[1], ep = process.argv[2], serial = process.argv[3] || undefined;
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, ".000Z");
    let file = { version: 1, devices: [] };
    if (fs.existsSync(p)) {
      try { file = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    }
    const idx = (file.devices || []).findIndex(d => d.endpoint === ep);
    if (idx >= 0) {
      if (serial) file.devices[idx].serial = serial;
    } else {
      const entry = { endpoint: ep, addedAt: stamp };
      if (serial) entry.serial = serial;
      file.devices.push(entry);
    }
    fs.writeFileSync(p, JSON.stringify(file, null, 2) + "\n");
  ' "$DEVICES_FILE" "$1" "${2:-}"
}

json_remove_endpoint() {
  # Remove endpoints whose host part equals $1.
  node -e '
    const fs = require("fs");
    const p = process.argv[1], host = process.argv[2];
    if (!fs.existsSync(p)) process.exit(0);
    const file = JSON.parse(fs.readFileSync(p, "utf8"));
    file.devices = (file.devices || []).filter(d => !d || String(d.endpoint).split(":")[0] !== host);
    fs.writeFileSync(p, JSON.stringify(file, null, 2) + "\n");
  ' "$DEVICES_FILE" "$1"
}

# --- adb helpers -------------------------------------------------------------
require_adb() {
  if ! command -v "$ADB" >/dev/null 2>&1; then
    die "adb not found on PATH (set ADB=/path/to/adb or install platform-tools)."
  fi
}

is_endpoint_live() {
  # $1 = endpoint; true when `adb devices` shows it in "device" state.
  # NB: an awk END{exit} would clobber the matched exit code, so track found/ok
  # and derive the exit status in one place.
  "$ADB" devices 2>/dev/null | awk -v e="$1" '
    $1==e { found=1; if ($2=="device") ok=1 }
    END { exit (found && ok) ? 0 : 1 }
  '
}

reconnect_one() {
  # $1 = endpoint; connect and report. Returns 0 on success.
  log "connecting $1 ..."
  local out
  out="$("$ADB" connect "$1" 2>&1)" && log "$(printf '%s' "$out" | head -1)"
}

# --- subcommands -------------------------------------------------------------
cmd_list() {
  local eps=()
  mapfile -t eps < <(json_read_endpoints)
  if (( ${#eps[@]} == 0 )); then
    log "no known endpoints (${DEVICES_FILE}). Run ./scripts/adb-setup.sh first."
    return 0
  fi
  for ep in "${eps[@]}"; do printf '%s\n' "$ep"; done
}

cmd_remove() {
  (( $# >= 1 )) || usage 2
  local host="$1"
  host="${host%%:*}" # ignore any port for matching
  json_remove_endpoint "$host"
  log "removed device(s) at host $host from $DEVICES_FILE."
}

cmd_add() {
  (( $# >= 1 )) || usage 2
  require_adb
  local input="$1" ep
  ep="$(endpoint_default_port "$input")"
  json_add_endpoint "$ep"
  log "added $ep to $DEVICES_FILE."
  reconnect_one "$ep"
}

cmd_reconnect() {
  require_adb
  local all=0
  [[ "${1:-}" == "--all" ]] && all=1
  local eps=()
  mapfile -t eps < <(json_read_endpoints)
  if (( ${#eps[@]} == 0 )); then
    log "no known endpoints to reconnect (${DEVICES_FILE})."
    return 0
  fi
  local ok=0 fail=0 ep
  for ep in "${eps[@]}"; do
    if (( all == 0 )) && is_endpoint_live "$ep"; then
      log "skip $ep (already online)"
      continue
    fi
    if reconnect_one "$ep"; then ok=$((ok+1)); else fail=$((fail+1)); fi
  done
  log "reconnect done: ${ok} connected, ${fail} failed."
  (( fail == 0 ))
}

# --- dispatch -----------------------------------------------------------------
cmd="${1:-}"
shift || true
case "$cmd" in
  list)          cmd_list ;;
  add)           cmd_add "$@" ;;
  remove)        cmd_remove "$@" ;;
  reconnect)     cmd_reconnect "$@" ;;
  -h|--help|"")  usage ;;
  *)             die "unknown command: $cmd" ;;
esac
