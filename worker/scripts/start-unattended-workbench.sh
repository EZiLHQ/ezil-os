#!/usr/bin/env bash
# start-unattended-workbench.sh — the private, supervised Code workbench that
# keeps EZiL Chat reachable through the editor bridge when no person has a
# Code tab open (docs/UNATTENDED-CODE.md).
#
# The editor bridge's executor lives in a browser window: the patched
# ChatViewPane registers `_ezil.chatBridge.v1` and the EZiL extension's sync
# client runs once per connected workbench (extensions/ezil-models/src/
# chat-bridge-client.ts). With no window there is nothing to hand queued
# instructions to. This script keeps ONE such window open, privately, inside
# the computer: the image's own Chrome, headless, on a throwaway profile of
# its own, pointed at the computer's code-server on its fixed local address.
#
# ── Fail closed ─────────────────────────────────────────────────────────────
# Nothing starts unless every one of these holds, re-checked on every launch
# and every CONSENT_RECHECK_S while running:
#   1. boot authorization: EZIL_EDITOR_BRIDGE_TOKEN is this boot's 64-hex
#      editor-bridge token. The Worker derives it from the boot nonce only for
#      a computer it explicitly admits (worker/src/editor-bridge.ts), and a
#      restart rotates it. Its VALUE is never read, logged or passed on: the
#      extension host inside code-server already has it; the browser does not.
#   2. the sync route: EZIL_AI_BASE_URL (the extension derives the code host's
#      sync URL from it); without it the extension never syncs, so a window
#      would be pointless.
#   3. owner consent, persisted in the owner's own editor settings
#      (<user-data-dir>/User/settings.json, restored per owner by
#      editor-state.sh): BOTH `ezil.chatBridge.enabled` (the bridge itself)
#      AND `ezil.chatBridge.unattended` (this private workbench) must be
#      exactly `true`. Both default to false. JSONC is accepted, as the editor
#      accepts it.
#   4. an operator kill switch: EZIL_UNATTENDED_WORKBENCH=off disables it.
# Consent withdrawn while running stops ONLY this window; code-server, the
# terminal and any window the person has open are never touched.
#
# ── Private ─────────────────────────────────────────────────────────────────
#   - a separate Chrome process with a scrubbed environment: no tokens, no
#     DISPLAY (it never joins the Neko desktop or its stream), its own HOME;
#   - its own fresh --user-data-dir, recreated on every launch; never the live
#     browser's profile (start-neko.sh's CHROME_PROFILE_DIR) and never a host
#     profile;
#   - no --remote-debugging-port and no listening port of any kind: nothing
#     outside this process can inspect or drive it, the browser sidecar
#     included;
#   - the one URL it ever loads is the app-owned loopback code-server
#     (http://127.0.0.1:<CODE_SERVER_PORT>/?folder=<workspace>); it sends no
#     prompt of its own. Whatever runs in that window is exactly what OS hands
#     out through the bridge, under OS's lease.
#
# ── Lifecycle ───────────────────────────────────────────────────────────────
# Supervised here (bounded restarts with backoff), tracked by start-neko.sh in
# SESSION_PID so a desktop restart or teardown ends it, and it stops itself on
# the Neko shutdown flag. It reports no presence and holds no keepalive: the
# idle stop and the platform sleep timer run exactly as without it.
#
# Usage:
#   start-unattended-workbench.sh check   print the decision, exit 0 only when authorized
#   start-unattended-workbench.sh run     supervise the window in the foreground (default)
# Decisions (stdout, one word): authorized disabled no_boot_authorization
#   no_sync_route not_opted_in no_browser no_node already_running
set -uo pipefail

MODE="${1:-run}"
CODE_SERVER_PORT="${CODE_SERVER_PORT:-8443}"
WORKSPACE_ROOT="${EZIL_WORKSPACE_ROOT:-${WORKSPACE_ROOT:-/home/neko/project}}"
USER_DATA_DIR="${CODE_SERVER_USER_DATA_DIR:-/tmp/code-server-data}"
PROFILE_DIR="${EZIL_UNATTENDED_WORKBENCH_DIR:-/tmp/ezil-unattended-workbench}"
LOG_FILE="${EZIL_UNATTENDED_WORKBENCH_LOG:-/tmp/ezil-unattended-workbench.log}"
SHUTDOWN_FLAG="${NEKO_SHUTDOWN_FLAG:-/tmp/neko-shutdown}"
MAX_RESTARTS="${EZIL_UNATTENDED_WORKBENCH_MAX_RESTARTS:-5}"
CONSENT_RECHECK_S="${EZIL_UNATTENDED_WORKBENCH_RECHECK_S:-15}"
EDITOR_WAIT_TRIES="${EZIL_UNATTENDED_WORKBENCH_EDITOR_TRIES:-240}"
WINDOW_SIZE="${EZIL_UNATTENDED_WORKBENCH_WINDOW:-1280,800}"
LOCK_FILE="${PROFILE_DIR}.lock"

log() { echo "[ezil-boot][unattended-workbench] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$LOG_FILE"; }

find_node() {
  local candidate
  for candidate in node /usr/local/bin/node /usr/lib/code-server/lib/node; do
    if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
  done
  return 1
}

find_browser() {
  local candidate
  for candidate in ${EZIL_UNATTENDED_BROWSER_CANDIDATES:-google-chrome-stable google-chrome chromium chromium-browser}; do
    if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
  done
  return 1
}

# Consent: both keys exactly `true` in the owner's settings file. A missing or
# unreadable file, a parse failure, or any other value is "no". Comments and
# trailing commas are tolerated the way the editor tolerates them.
opted_in() {
  local node="$1" file="$USER_DATA_DIR/User/settings.json"
  [ -f "$file" ] || return 1
  "$node" -e '
    const fs = require("node:fs");
    let text;
    try { text = fs.readFileSync(process.argv[1], "utf8"); } catch { process.exit(1); }
    // Strip // and /* */ comments outside strings, then trailing commas.
    let out = "", inString = false, quote = "", i = 0;
    while (i < text.length) {
      const c = text[i], n = text[i + 1];
      if (inString) { out += c; if (c === "\\") { out += n ?? ""; i += 2; continue; } if (c === quote) inString = false; i++; continue; }
      if (c === "\"" || c === "\x27") { inString = true; quote = c; out += c; i++; continue; }
      if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
      if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
      out += c; i++;
    }
    out = out.replace(/,\s*([}\]])/g, "$1");
    let settings;
    try { settings = JSON.parse(out); } catch { process.exit(1); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) process.exit(1);
    process.exit(settings["ezil.chatBridge.enabled"] === true && settings["ezil.chatBridge.unattended"] === true ? 0 : 1);
  ' "$file" 2>/dev/null
}

# Decision only; never starts anything. Sets DECISION, and BROWSER_BIN / NODE_BIN on success.
DECISION=""
decide() {
  case "$(printf '%s' "${EZIL_UNATTENDED_WORKBENCH:-on}" | tr '[:upper:]' '[:lower:]' | tr -d ' ')" in
    off|false|0|disabled|no) DECISION=disabled; return 1 ;;
  esac
  if ! [[ "${EZIL_EDITOR_BRIDGE_TOKEN:-}" =~ ^[0-9a-f]{64}$ ]]; then DECISION=no_boot_authorization; return 1; fi
  if [ -z "${EZIL_AI_BASE_URL:-}" ]; then DECISION=no_sync_route; return 1; fi
  if ! NODE_BIN="$(find_node)"; then DECISION=no_node; return 1; fi
  if ! opted_in "$NODE_BIN"; then DECISION=not_opted_in; return 1; fi
  if ! BROWSER_BIN="$(find_browser)"; then DECISION=no_browser; return 1; fi
  DECISION=authorized
  return 0
}

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$CODE_SERVER_PORT") 2>/dev/null; }

WINDOW_PGID=""
stop_window() {
  if [ -n "$WINDOW_PGID" ] && kill -0 -- "-$WINDOW_PGID" 2>/dev/null; then
    kill -TERM -- "-$WINDOW_PGID" 2>/dev/null || true
    local i
    for i in $(seq 1 50); do kill -0 -- "-$WINDOW_PGID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$WINDOW_PGID" 2>/dev/null || true
  fi
  WINDOW_PGID=""
}

on_signal() { log "stopping: signalled"; stop_window; exit 0; }

launch_window() {
  rm -rf "$PROFILE_DIR"
  mkdir -p "$PROFILE_DIR" || return 1
  # `env -i`: the window inherits nothing — not the bridge token, not the AI
  # proxy token, not DISPLAY. `setsid`: its own process group, so every Chrome
  # child goes with it on stop.
  setsid env -i PATH="/usr/local/bin:/usr/bin:/bin" HOME="$PROFILE_DIR" TMPDIR="$PROFILE_DIR" \
    "$BROWSER_BIN" \
      --headless=new \
      --no-sandbox \
      --disable-gpu \
      --disable-dev-shm-usage \
      --no-first-run \
      --no-default-browser-check \
      --disable-sync \
      --disable-extensions \
      --disable-background-networking \
      --disable-component-update \
      --disable-default-apps \
      --disable-background-timer-throttling \
      --no-pings \
      --user-data-dir="$PROFILE_DIR" \
      --window-size="$WINDOW_SIZE" \
      "http://127.0.0.1:${CODE_SERVER_PORT}/?folder=${WORKSPACE_ROOT}" \
    >>"$LOG_FILE" 2>&1 &
  WINDOW_PGID=$!
}

run() {
  exec 7>"$LOCK_FILE" || exit 1
  if ! flock -n 7; then echo already_running; exit 0; fi
  decide || true
  echo "$DECISION"
  [ "$DECISION" = authorized ] || exit 1
  trap on_signal TERM INT HUP
  log "starting (browser $(basename "$BROWSER_BIN"), profile $PROFILE_DIR, editor 127.0.0.1:${CODE_SERVER_PORT})"
  local attempt=0 tries
  while true; do
    [ -f "$SHUTDOWN_FLAG" ] && { log "stopping: desktop shutdown"; exit 0; }
    tries=0
    until port_up; do
      tries=$((tries + 1))
      if [ "$tries" -ge "$EDITOR_WAIT_TRIES" ]; then log "stopping: code-server never listened"; exit 1; fi
      [ -f "$SHUTDOWN_FLAG" ] && { log "stopping: desktop shutdown"; exit 0; }
      sleep 0.5
    done
    launch_window || { log "stopping: profile directory not writable"; exit 1; }
    log "window up (attempt $((attempt + 1)))"
    local started_s rc
    started_s="$(date +%s)"
    # Supervise: stop on the shutdown flag, on withdrawn consent, or when the window exits.
    while kill -0 -- "-$WINDOW_PGID" 2>/dev/null; do
      sleep "$CONSENT_RECHECK_S" &
      wait $! 2>/dev/null
      [ -f "$SHUTDOWN_FLAG" ] && { log "stopping: desktop shutdown"; stop_window; exit 0; }
      if ! decide; then log "stopping: no longer authorized ($DECISION)"; stop_window; exit 0; fi
    done
    wait "$WINDOW_PGID" 2>/dev/null; rc=$?
    WINDOW_PGID=""
    [ -f "$SHUTDOWN_FLAG" ] && { log "stopping: desktop shutdown"; exit 0; }
    # A window that ran for a while is restarted without charge; a quick exit burns the budget.
    if [ $(( $(date +%s) - started_s )) -ge 60 ]; then attempt=0; else attempt=$((attempt + 1)); fi
    log "window exited rc=$rc (attempt $attempt/$MAX_RESTARTS)"
    if [ "$attempt" -gt "$MAX_RESTARTS" ]; then log "stopping: restart budget exhausted"; exit 1; fi
    sleep $(( attempt * 2 ))
  done
}

case "$MODE" in
  check) decide; rc=$?; echo "$DECISION"; exit $rc ;;
  run) run ;;
  *) echo "usage: $0 [check|run]" >&2; exit 2 ;;
esac
