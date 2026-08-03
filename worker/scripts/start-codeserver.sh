#!/usr/bin/env bash
# start-codeserver.sh — idempotent lazy launcher for code-server.
#
# Ported from the working Sandboxes/infra/sandbox-desktop/start-codeserver.sh
# reference, with the port changed from 8080 to 8443 (8080 is already taken
# by the Guacamole desktop mode's Tomcat in this same image — see the
# Dockerfile) and the workspace root made configurable via $1/$WORKSPACE_ROOT
# so it opens the same project directory start-neko.sh resolves.
#
# Idempotent: if a code-server process is already running and the port is
# listening, does nothing and exits 0. Safe to call repeatedly (e.g. from a
# supervising loop, or on-demand from a future daemon endpoint) without
# spawning duplicate processes.
#
# code-server replaces Electron VS Code in this image: Electron VS Code was
# a SECOND Chromium-family renderer compositing into the shared Xvfb display,
# captured by the same software video encoder as the native browser, plus its
# own extension host — the two must never coexist (see start-neko.sh and the
# Dockerfile). code-server is a plain HTTP server; it renders nothing into
# Xvfb and is never part of the neko/WebRTC desktop stream.
#
# 🔴 --bind-addr is 0.0.0.0, NOT 127.0.0.1. An earlier version of this file
# bound loopback-only on the premise that "the only inbound path is the
# containerFetch proxy, so loopback is enough". That premise is wrong about
# how the platform actually reaches a container: Cloudflare's proxy connects
# to the container's ROUTABLE address (observed: 10.0.0.1:8443), never to its
# loopback. Bound to 127.0.0.1, code-server listens happily and every proxied
# request dies with `The container is not listening in the TCP address
# 10.0.0.1:8443` — the process is up, the port is open, and nothing can reach
# it. `start-neko.sh` already had this right for neko:
#     NEKO_SERVER_BIND="0.0.0.0:${NEKO_HTTP_PORT}"   # so proxyToSandbox() can reach it
#
# Why --auth none stays safe: the container's network is not publicly
# routable. The ONLY way in is the Worker's `*-code.ezil.org` bridge host,
# which is HMAC/cookie-gated before it ever calls containerFetch. Binding
# 0.0.0.0 widens reachability inside an already-sealed network boundary, not
# outside it. Do not "harden" this back to loopback — it does not add a
# boundary, it only breaks the one client that exists.
#
# Output contract (unchanged from the reference):
#   stdout:  one of `already-running`, `started`, `failed`
#   exit 0:  code-server is running (or started)
#   exit 1:  launch attempted but the port never came up within timeout
set -euo pipefail

PID_FILE=/tmp/code-server.pid
LOG_FILE=/tmp/code-server.log
PORT=8443
TIMEOUT_SEC=30
WORKSPACE_ROOT="${1:-${WORKSPACE_ROOT:-/home/neko/project}}"
USER_DATA_DIR="${CODE_SERVER_USER_DATA_DIR:-/tmp/code-server-data}"
EXTENSIONS_DIR="${CODE_SERVER_EXTENSIONS_DIR:-/tmp/code-server-extensions}"

port_up() {
    # `nc` may not be present — use bash's /dev/tcp builtin.
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

pid_alive() {
    [ -f "$PID_FILE" ] || return 1
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Fast path: already up.
if pid_alive && port_up; then
    echo already-running
    exit 0
fi

# Stale pid file with nothing listening — clean up and relaunch.
rm -f "$PID_FILE"

# ── Workspace Trust off — see the long block in start-neko.sh for the measured
# evidence. Short version: with a folder open, an untrusted workspace boots into
# Restricted Mode and the integrated terminal refuses to start behind a "Do you
# trust the authors of the files in this folder? / Creating a terminal process
# requires executing code" modal. The grant lives in --user-data-dir, which is
# under /tmp and recreated every container start, so the prompt returns every
# session. A SETTING, not `--disable-workspace-trust`: an unknown setting is
# ignored, an unknown CLI option makes code-server exit non-zero.
# Keep this in sync with start-neko.sh, which is the launcher that actually runs
# on the mandatory boot path; this one is the idempotent on-demand fallback.
if [ ! -s "$USER_DATA_DIR/User/settings.json" ]; then
    mkdir -p "$USER_DATA_DIR/User"
    cat >"$USER_DATA_DIR/User/settings.json" <<'CODESERVER_SETTINGS_JSON'
{
  "security.workspace.trust.enabled": false
}
CODESERVER_SETTINGS_JSON
fi

# Keep auth none because the bridge is already HMAC/cookie-gated in front of
# this process. 0.0.0.0 is required, NOT loopback — see the 🔴 block above; an
# earlier version of this very comment said the opposite while the flag below
# already said 0.0.0.0, which is exactly how the loopback bind got restored
# once. Do not "restore" it again.
#
# code-server's own `authenticateOrigin` (WS router only) additionally compares
# the browser's Origin against the forwarded host, so the bridge must send the
# REAL bridge hostname as `x-forwarded-host` — see `resolveForwardedHost` in
# worker/src/preview-bridge.ts and PLATFORM-NOTES §20. `--auth none` does not
# disable that check.
nohup code-server \
    --bind-addr 0.0.0.0:${PORT} \
    --auth none \
    --disable-telemetry \
    --user-data-dir="$USER_DATA_DIR" \
    --extensions-dir="$EXTENSIONS_DIR" \
    "$WORKSPACE_ROOT" \
    >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

# Wait for the port to open. code-server's extension host takes a few
# seconds on a warm container so 30s is generous but not unbounded.
for _ in $(seq 1 $((TIMEOUT_SEC * 4))); do
    if port_up; then
        echo started
        exit 0
    fi
    sleep 0.25
done

echo failed
exit 1
