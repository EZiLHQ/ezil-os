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

# Keep auth none because the daemon is already HMAC-gated behind the
# containerFetch proxy; bind to loopback only — never 0.0.0.0.
nohup code-server \
    --bind-addr 0.0.0.0:${PORT} \
    --auth none \
    --disable-telemetry \
    --user-data-dir=/tmp/code-server-data \
    --extensions-dir=/tmp/code-server-extensions \
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
