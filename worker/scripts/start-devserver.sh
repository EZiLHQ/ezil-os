#!/usr/bin/env bash
# start-devserver.sh — launch the user's dev server (Next.js / Vite / generic
# Node project) inside the EZiL OS `neko` sandbox, on the Option D app-preview
# port (`APP_PREVIEW_PORT` in `src/desktop-mode.ts`, default 3002 — NOT 3000,
# which the `@cloudflare/sandbox` SDK reserves for its own control-plane Bun
# server; see the Dockerfile's `EXPOSE 3002` doc comment).
#
# This closes the gap `src/preview-bridge.ts`'s module doc has documented since
# Option D landed: the token-gated `/preview`, `/preview-ws`, and
# `/preview-status` routes have always proxied/probed 127.0.0.1:$PORT, but
# nothing in this container image ever started a process listening there.
#
# Ported from the validated Azure reference implementation
# (`Sandboxes/infra/sandbox-desktop/start-devserver.sh`, a SIBLING repo — see
# that file's doc comment for the original design): package-manager detection
# via lockfile, async dependency install + dev-server launch, phase-file
# reporting, PID-file idempotency. Manifest support (`.ezil/runtime.toml`,
# `ezil_manifest.py` in the reference) is DELIBERATELY NOT ported here —
# nothing in this Cloudflare/Neko pipeline writes that file yet, and it was
# not part of the requested adaptation scope; see the worker's report for the
# explicit callout.
#
# Invoked by start-neko.sh immediately after workspace hydration resolves
# (before the mandatory-app window-ready gate and before `neko serve` binds
# its port). This script itself is NON-BLOCKING: dependency install and the
# dev-server process are launched in a detached background subshell, and this
# script returns (`starting`/`already-running`, exit 0) almost immediately —
# so it can never serialize behind, or gate, VS Code/Chrome readiness or neko
# binding its HTTP port. A slow or crashing dev server therefore never
# prevents the desktop itself from becoming ready; its real state is reported
# via the phase file below (surfaced by the Worker's `/preview-status` probe
# in `probeAppPreviewStatus`, `src/index.ts`) instead of by blocking boot.
set -uo pipefail

# Workspace root: prefer an explicit argv[1] (start-neko.sh passes the
# resolved `$WORKSPACE_ROOT`, which may differ from `$EZIL_WORKSPACE_ROOT`
# when a sealed startup delivery relocated it — see that script's hydration
# block), then the env var, then the neko default.
WORKSPACE="${1:-${EZIL_WORKSPACE_ROOT:-/home/neko/project}}"
PORT="${EZIL_DEV_SERVER_PORT:-3002}"
HOST="${EZIL_DEV_SERVER_HOST:-0.0.0.0}"
PID_FILE="${EZIL_DEVSERVER_PID_FILE:-/tmp/devserver.pid}"
MODE_FILE="${EZIL_DEVSERVER_MODE_FILE:-/tmp/devserver.mode}"
LOG_FILE="${EZIL_DEVSERVER_LOG_FILE:-/tmp/devserver.log}"
PHASE_FILE="${EZIL_DEVSERVER_PHASE_FILE:-/tmp/devserver.phase}"
# Read by the Worker's `/preview-status` probe (`probeAppPreviewStatus`) to
# resolve the `has_package_json` check against the REAL workspace root
# instead of the legacy `SANDBOX_WORKSPACE_MOUNT_PATH` bucket-mount default
# (`/workspace`), which is almost never where neko-mode projects actually
# live (`/home/neko/project`, or wherever the sealed-delivery bootstrap
# resolved). Written unconditionally, before any other decision below, so the
# probe has an answer even while dependency install/placeholder mode is still
# in progress.
WORKSPACE_ROOT_FILE="${EZIL_DEVSERVER_WORKSPACE_ROOT_FILE:-/tmp/devserver.workspace-root}"
TIMEOUT_SEC="${EZIL_DEVSERVER_TIMEOUT_SEC:-180}"
READY_WAITER_PID_FILE="${EZIL_DEVSERVER_READY_WAITER_PID_FILE:-/tmp/devserver-ready-waiter.pid}"
# Consecutive-recovery-attempt counter, read by the Worker's `/preview-status`
# probe (`probeAppPreviewStatus` -> `effectiveDevserverPhase` /
# `shouldTriggerDevserverRestart` in `src/preview-bridge.ts`) to bound its
# restart backoff and to escalate the REPORTED phase from `crashed` to
# `crash_looping` once a dev server has failed to recover this many times in
# a row — see that file's doc comments for the full self-heal design. Reset
# to 0 the moment the dev server binds its port again (`start_ready_waiter`'s
# success path below); incremented here ONLY when this invocation is itself a
# recovery attempt (prior phase was `crashed`/`timeout`), never on the very
# first boot-time launch.
RESTART_COUNT_FILE="${EZIL_DEVSERVER_RESTART_COUNT_FILE:-/tmp/devserver.restart-count}"

log() { echo "[devserver] $*" >&2; }

write_phase() {
    local phase="$1"
    local ts
    ts="$(date +%s 2>/dev/null || echo 0)"
    echo "${phase} ${ts}" >"$PHASE_FILE"
}

# First whitespace-separated token of $PHASE_FILE (the phase name, no
# timestamp) — mirrors the Worker's `parseDevserverPhase`/
# `parseDevserverPhaseRecord`. Used below purely to detect "this invocation
# is a recovery attempt", not for any other decision in this script.
current_phase() {
    head -n1 "$PHASE_FILE" 2>/dev/null | awk '{print $1}'
}

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

start_ready_waiter() {
    local dev_pid="$1"
    (
        log "readiness watcher waiting for :$PORT (dev pid=$dev_pid, timeout=${TIMEOUT_SEC}s)"
        for _ in $(seq 1 $((TIMEOUT_SEC * 4))); do
            if port_up; then
                log "dev server up on :$PORT"
                write_phase "running"
                # Recovery succeeded (or this was a clean first launch, where
                # the file is already absent/0) — forget prior failures so a
                # LATER, unrelated crash starts its own backoff from scratch
                # instead of inheriting an escalated attempt count.
                echo 0 >"$RESTART_COUNT_FILE" 2>/dev/null || true
                exit 0
            fi
            if [ -n "$dev_pid" ] && ! kill -0 "$dev_pid" 2>/dev/null; then
                log "dev server process exited before binding :$PORT"
                write_phase "crashed"
                tail -n 40 "$LOG_FILE" >&2 || true
                exit 1
            fi
            sleep 0.25
        done
        log "dev server did not bind :$PORT within ${TIMEOUT_SEC}s (continuing boot)"
        write_phase "timeout"
        tail -n 40 "$LOG_FILE" >&2 || true
        exit 1
    ) >>"$LOG_FILE" 2>&1 &
    echo $! >"$READY_WAITER_PID_FILE"
}

pid_alive() {
    [ -f "$PID_FILE" ] || return 1
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

echo "$WORKSPACE" >"$WORKSPACE_ROOT_FILE" 2>/dev/null || true

if pid_alive && port_up; then
    CURRENT_MODE="$(cat "$MODE_FILE" 2>/dev/null || echo unknown)"
    if [ -f "$WORKSPACE/package.json" ] && [ "$CURRENT_MODE" = "placeholder" ]; then
        OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
        log "project package.json is present — replacing placeholder server (pid=$OLD_PID) with app dev server"
        [ -n "$OLD_PID" ] && kill "$OLD_PID" 2>/dev/null || true
        for _ in $(seq 1 20); do
            port_up || break
            sleep 0.1
        done
        rm -f "$PID_FILE" "$MODE_FILE"
    else
        log "already running (pid=$(cat "$PID_FILE" 2>/dev/null), mode=$CURRENT_MODE)"
        echo already-running
        exit 0
    fi
fi
rm -f "$PID_FILE"

# We are about to (re)launch. If the phase we're launching OUT OF is a
# genuine failure (not the placeholder->app transition above, which never
# reaches this point via a crashed/timeout phase), this is an automatic
# recovery attempt — bump the counter the Worker uses for restart backoff
# and the crashed -> crash_looping escalation. A plain first boot (phase file
# absent, or any other phase) does NOT increment it.
PRIOR_PHASE="$(current_phase)"
if [ "$PRIOR_PHASE" = "crashed" ] || [ "$PRIOR_PHASE" = "timeout" ]; then
    RESTART_COUNT="$(cat "$RESTART_COUNT_FILE" 2>/dev/null || echo 0)"
    case "$RESTART_COUNT" in '' | *[!0-9]*) RESTART_COUNT=0 ;; esac
    RESTART_COUNT=$((RESTART_COUNT + 1))
    echo "$RESTART_COUNT" >"$RESTART_COUNT_FILE" 2>/dev/null || true
    log "recovering from prior phase='$PRIOR_PHASE' — automatic restart attempt #$RESTART_COUNT"
fi

mkdir -p "$WORKSPACE" 2>/dev/null || true
if ! cd "$WORKSPACE" 2>/dev/null; then
    log "ERROR: workspace root '$WORKSPACE' does not exist or is not accessible — cannot start dev server"
    write_phase "error_workspace_missing"
    echo failed
    exit 1
fi

# Empty project → serve a diagnostic placeholder page so `/preview-status`'s
# port_up probe (and anything that lands on :$PORT directly) sees a real,
# honest "no project yet" response instead of connection-refused.
if [ ! -f package.json ]; then
    log "no package.json in $WORKSPACE — starting placeholder HTTP server on :$PORT (diagnostic/error mode)"
    write_phase "placeholder"
    mkdir -p /tmp/ezil-devserver-placeholder
    cat >/tmp/ezil-devserver-placeholder/index.html <<'HTML'
<!doctype html>
<html><head><title>EZiL Preview — No Project</title>
<meta http-equiv="refresh" content="3">
<style>
*{box-sizing:border-box}
body{background:#1a1017;color:#f0d0d0;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:2rem}
.card{background:#2a1520;border:1px solid #6b2020;border-radius:12px;padding:2rem 2.5rem;max-width:560px;text-align:center}
h1{font-weight:500;font-size:1.5rem;color:#ff6b6b;margin:0 0 .75rem}
p{opacity:0.85;line-height:1.6;margin:0.5rem 0}
code{background:#1a0a10;padding:2px 6px;border-radius:4px;font-size:0.9em}
.status-badge{display:inline-block;background:#6b2020;color:#ffaaaa;padding:4px 12px;border-radius:20px;font-size:0.8rem;margin-top:1rem;letter-spacing:0.5px}
.hint{font-size:0.85rem;opacity:0.6;margin-top:1.25rem}
</style>
</head><body>
<div class="card">
  <h1>No Project Loaded</h1>
  <p>No <code>package.json</code> found in the workspace.</p>
  <p>The dev server cannot start until the agent scaffolds or syncs a project.</p>
  <span class="status-badge">STATUS: NO PROJECT</span>
  <p class="hint">This page auto-refreshes every 3 seconds. It will transition automatically once a project arrives.</p>
</div>
</body></html>
HTML
    nohup python3 -m http.server "$PORT" --directory /tmp/ezil-devserver-placeholder \
        >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    echo placeholder >"$MODE_FILE"
else
    # Package-manager detection via lockfile — bun.lock(b) > pnpm > yarn > npm.
    if [ -f bun.lock ] || [ -f bun.lockb ]; then
        PM=bun
    elif [ -f pnpm-lock.yaml ]; then
        PM=pnpm
    elif [ -f yarn.lock ]; then
        PM=yarn
    else
        PM=npm
    fi
    DEV_CMD="$PM run dev"
    log "using package manager: $PM; dev command: $DEV_CMD"

    # Dependency installation may take minutes on a cold project. The entire
    # install+launch flow runs in ONE detached background process so sandbox
    # boot, VS Code/Chrome readiness, and `neko serve` binding its port never
    # wait on npm/pnpm/yarn/bun. `exec` at the tail replaces the subshell with
    # the actual dev-server process so its PID (captured below via `$!`)
    # stays stable across the install → launch transition — this is what lets
    # the ready-waiter's `kill -0 "$dev_pid"` distinguish "still installing"
    # from "process exited" without racing a PID handoff.
    write_phase "installing_deps"
    nohup bash -c '
        set -euo pipefail
        cd "$1"
        PM="$2"
        PORT_VALUE="$3"
        PHASE_FILE="$4"
        DEV_CMD="$5"
        HOST_VALUE="${6:-0.0.0.0}"
        write_phase() { echo "$1 $(date +%s 2>/dev/null || echo 0)" >"$PHASE_FILE"; }
        if [ ! -x node_modules/.bin/next ] && grep -q "\"next\"" package.json 2>/dev/null && command -v bun >/dev/null 2>&1; then
            echo "[devserver] preparing Next.js dependencies with bun" >&2
            write_phase "installing_deps"
            rm -rf node_modules package-lock.json
            bun install --no-progress
        elif [ ! -d node_modules ]; then
            echo "[devserver] installing dependencies with $PM" >&2
            write_phase "installing_deps"
            case "$PM" in
                bun)  bun install --no-progress ;;
                pnpm) pnpm install --prefer-frozen-lockfile ;;
                yarn) yarn install --frozen-lockfile ;;
                npm)  npm ci --no-audit --no-fund || { rm -rf node_modules package-lock.json && npm install --no-audit --no-fund; } ;;
            esac
        fi
        if [ -f node_modules/next/dist/bin/next ] && [ ! -x node_modules/.bin/next ]; then
            echo "[devserver] repairing missing next binary shim" >&2
            mkdir -p node_modules/.bin
            ln -sf ../next/dist/bin/next node_modules/.bin/next
            chmod +x node_modules/next/dist/bin/next node_modules/.bin/next 2>/dev/null || true
        fi
        if (exec 3<>"/dev/tcp/127.0.0.1/$PORT_VALUE") 2>/dev/null; then
            echo "[devserver] port :$PORT_VALUE is still busy before app start" >&2
            write_phase "error_port_busy"
            exit 1
        fi
        echo "[devserver] starting: $DEV_CMD on :$PORT_VALUE (host=$HOST_VALUE)" >&2
        write_phase "starting"
        exec env PORT="$PORT_VALUE" HOST="$HOST_VALUE" HOSTNAME="$HOST_VALUE" $DEV_CMD
    ' bash "$WORKSPACE" "$PM" "$PORT" "$PHASE_FILE" "$DEV_CMD" "$HOST" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    echo app >"$MODE_FILE"
fi

DEV_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
start_ready_waiter "$DEV_PID"
log "dev server launch requested on :$PORT (pid=$DEV_PID, workspace=$WORKSPACE); readiness continues asynchronously"
echo starting
exit 0
