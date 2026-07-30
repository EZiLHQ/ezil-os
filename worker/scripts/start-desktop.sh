#!/usr/bin/env bash
# EBuilder Cloudflare Sandbox — browser-desktop boot sequence (Apache Guacamole).
#
# Launched by the Worker via sandbox.startProcess(). Starts, in order:
#   Xvfb :99      virtual X display
#   fluxbox       lightweight window manager
#   x11vnc :5901  VNC server bound to the Xvfb display (loopback backend for guacd)
#   Google Chrome the actual browser shown in the EBuilder canvas
#   guacd :4822   Apache Guacamole native proxy daemon (speaks Guacamole <-> VNC)
#   Tomcat :8080  hosts the genuine Apache Guacamole HTML5 client at /guacamole/
#
# There is NO noVNC and NO websockify anywhere: the browser talks the Guacamole
# protocol over a WebSocket tunnel to the Guacamole web app on 8080, which the
# Worker fronts via proxyToSandbox(). This process blocks on Tomcat so the
# sandbox keeps the whole stack alive.
set -uo pipefail

# ── Mode dispatch (Phase 1: Guacamole default/rollback, Neko opt-in) ─────────
# DESKTOP_MODE is set by the Worker's ensureDesktop() via
# `startProcess("DESKTOP_MODE=<mode> bash /usr/local/bin/start-desktop.sh")`.
# Guacamole's existing path/port below is completely untouched when
# DESKTOP_MODE is unset or 'guacamole' (the default/rollback behavior).
DESKTOP_MODE="${DESKTOP_MODE:-guacamole}"
if [ "$DESKTOP_MODE" = "neko" ]; then
  exec bash /usr/local/bin/start-neko.sh
fi

# ── Environment (defaults mirror the Dockerfile ENV / Debian tomcat9 layout) ──
export DISPLAY="${DISPLAY:-:99}"
export HOME="${HOME:-/root}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-ebuilder}"
export GUACAMOLE_HOME="${GUACAMOLE_HOME:-/etc/guacamole}"
export CATALINA_HOME="${CATALINA_HOME:-/usr/share/tomcat9}"
export CATALINA_BASE="${CATALINA_BASE:-/var/lib/tomcat9}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

LOG=/tmp/desktop.log
log() { echo "[start-desktop] $*" | tee -a "$LOG" >&2; }

GUAC_HTTP_PORT="${GUAC_HTTP_PORT:-8080}"

# Best-effort TCP readiness probe (bash /dev/tcp — no extra tools needed).
wait_tcp() {
  local host="$1" port="$2" tries="$3" ok=1
  for _ in $(seq 1 "$tries"); do
    if (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
      exec 3>&- 3<&- 2>/dev/null || true
      ok=0; break
    fi
    sleep 0.5
  done
  return "$ok"
}

# Idempotency is keyed off the ACTUAL local port state, NOT process presence.
#
# Cloudflare Sandbox containers share the host PID namespace but each gets its
# OWN network namespace. A `pgrep`-based check therefore matches Tomcat
# processes belonging to *sibling* containers and yields cross-container false
# positives: this container would wrongly conclude "already running", skip its
# own boot, and never bind ITS 127.0.0.1:8080 — leaving the Worker's readiness
# probe to fail forever (the ProcessExitedBeforeReadyError we were seeing).
#
# A loopback TCP probe is network-namespace-local, so it reflects THIS
# container's real state. If 8080 already answers here, the whole stack is up and
# we no-op (the Worker verifies readiness with its own in-container HTTP probe,
# so exiting 0 is safe even though this launcher is short-lived).
if wait_tcp 127.0.0.1 "$GUAC_HTTP_PORT" 2; then
  log "guacamole web app already serving on 127.0.0.1:$GUAC_HTTP_PORT — nothing to do"
  exit 0
fi
log "port $GUAC_HTTP_PORT not accepting locally — booting the desktop stack"

SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1280x800x24}"
WIN_SIZE="${SCREEN_GEOMETRY%x*}"            # e.g. 1280x800
WIN_W="${WIN_SIZE%x*}"                      # 1280
WIN_H="${WIN_SIZE#*x}"                      # 800
START_URL="${START_URL:-https://www.wikipedia.org}"

GUACD_PORT="${GUACD_PORT:-4822}"
VNC_PORT="${VNC_PORT:-5901}"
# GUAC_HTTP_PORT and wait_tcp() are defined near the top of this script (they are
# used by the idempotency check above), so they are already in scope here.

# We only get here when 8080 is NOT serving locally, so (re)start whatever is
# missing. Every daemon below is guarded by a network-namespace-local signal
# (an X display probe or a loopback port probe) — never `pgrep`, which would
# false-positive against sibling containers sharing the host PID namespace.

# ── X display ─────────────────────────────────────────────────────────────────
# The graphics chain (Xvfb + fluxbox + Chrome) has no loopback port to probe, so
# key it off the X display itself: if $DISPLAY already answers, the chain is
# assumed up from an earlier boot in THIS container and is left untouched.
START_GRAPHICS=0
if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  log "X display $DISPLAY already active — reusing existing Xvfb/fluxbox/Chrome"
else
  START_GRAPHICS=1
  log "starting Xvfb on $DISPLAY ($SCREEN_GEOMETRY)"
  Xvfb "$DISPLAY" -screen 0 "$SCREEN_GEOMETRY" -ac +extension RANDR -nolisten tcp >>"$LOG" 2>&1 &

  # Wait for the X server to accept connections.
  for _ in $(seq 1 40); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done

  log "starting fluxbox window manager"
  fluxbox >>"$LOG" 2>&1 &
  # Give fluxbox a moment to begin managing the display before Chrome maps its
  # window, so the window-fixer (below) acts on a reparented, decoratable window.
  sleep 1
fi

# ── VNC backend (never exposed to the browser; guacd connects to it) ──────────
# Guarded by its loopback port so a re-run never spawns a second x11vnc that
# would just fail to bind $VNC_PORT.
if wait_tcp 127.0.0.1 "$VNC_PORT" 1; then
  log "x11vnc already listening on 127.0.0.1:$VNC_PORT — reusing"
else
  log "starting x11vnc on 127.0.0.1:$VNC_PORT"
  x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost \
         -rfbport "$VNC_PORT" -noxdamage -ncache 0 >>"$LOG" 2>&1 &
fi

# ── Browser ───────────────────────────────────────────────────────────────────
if [ "$START_GRAPHICS" -eq 1 ]; then
  log "launching Google Chrome → $START_URL"
  # NOTE: do NOT pass --start-maximized. On fluxbox/Xvfb it conflicts with
  # --window-size and collapses the window to ~10x10 px. We pin exact geometry
  # with xdotool below instead.
  google-chrome-stable \
    --no-sandbox \
    --no-first-run \
    --no-default-browser-check \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-software-rasterizer \
    --disable-features=Translate \
    --window-position=0,0 \
    --window-size="${WIN_W},${WIN_H}" \
    --user-data-dir=/tmp/chrome-profile \
    "$START_URL" >>"$LOG" 2>&1 &
  CHROME_PID=$!

  # Pin the Chrome window to the full virtual screen. fluxbox decorations and
  # Chrome's own sizing otherwise leave the window a few px short and offset by
  # the titlebar; xdotool forces an exact ${WIN_W}x${WIN_H} window at 0,0. Runs in
  # the background so it can wait for the window to map without blocking boot.
  (
    applied=0
    for _ in $(seq 1 60); do
      WID="$(xdotool search --onlyvisible --class chrome 2>/dev/null | tail -n1)"
      if [ -n "${WID:-}" ]; then
        xdotool windowsize "$WID" "$WIN_W" "$WIN_H" 2>/dev/null || true
        xdotool windowmove "$WID" 0 0 2>/dev/null || true
        applied=$((applied + 1))
        [ "$applied" -ge 5 ] && break
      fi
      sleep 0.5
    done
    log "window-fixer applied geometry $applied time(s) (WID=${WID:-none}, chrome pid $CHROME_PID)"
  ) &
else
  log "reusing existing Chrome (graphics chain already up)"
fi

# ── guacd (Apache Guacamole native proxy daemon) ──────────────────────────────
# -f keeps guacd in the foreground (no daemon fork / pidfile), so it stays a
# child of this script and its logs land in $LOG. Bound to loopback + IPv4 to
# match guacd-hostname in guacamole.properties. Guarded by its loopback port so a
# re-run reuses a healthy guacd instead of spawning one that can't bind the port.
if wait_tcp 127.0.0.1 "$GUACD_PORT" 1; then
  log "guacd already listening on 127.0.0.1:$GUACD_PORT — reusing"
else
  GUACD_BIN="$(command -v guacd 2>/dev/null || echo /usr/sbin/guacd)"
  log "starting guacd ($GUACD_BIN) on 127.0.0.1:$GUACD_PORT"
  "$GUACD_BIN" -b 127.0.0.1 -l "$GUACD_PORT" -f >>"$LOG" 2>&1 &
  if wait_tcp 127.0.0.1 "$GUACD_PORT" 40; then
    log "guacd is accepting connections on $GUACD_PORT"
  else
    log "WARNING: guacd did not open $GUACD_PORT within timeout (see $LOG)"
  fi
fi

# ── Tomcat + Apache Guacamole HTML5 client (/guacamole/, port 8080) ───────────
TOMCAT_PID=""
start_tomcat() {
  # Point the Guacamole web app at GUACAMOLE_HOME via a system property too, so
  # it is found regardless of how the JVM inherits the environment.
  export CATALINA_OPTS="${CATALINA_OPTS:-} -Dguacamole.home=${GUACAMOLE_HOME} -Djava.awt.headless=true"
  mkdir -p "$CATALINA_BASE/logs" "$CATALINA_BASE/work" "$CATALINA_BASE/temp" 2>/dev/null || true

  # catalina.sh requires JAVA_HOME/JRE_HOME (it does NOT fall back to PATH java).
  if [ -z "${JAVA_HOME:-}" ] && [ -z "${JRE_HOME:-}" ]; then
    local javabin
    javabin="$(command -v java 2>/dev/null || true)"
    if [ -n "$javabin" ]; then
      JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$javabin")")")"
      export JAVA_HOME
    fi
  fi

  # Prefer catalina.sh run — foreground, and crucially WITHOUT the Debian
  # SecurityManager (the `-security` flag / policy would otherwise block the
  # Guacamole webapp from reading /etc/guacamole and connecting to guacd).
  if [ -x "$CATALINA_HOME/bin/catalina.sh" ]; then
    log "starting Tomcat via catalina.sh run (JAVA_HOME=${JAVA_HOME:-unset})"
    "$CATALINA_HOME/bin/catalina.sh" run >>"$LOG" 2>&1 &
    TOMCAT_PID=$!
    return
  fi

  # Fallback: invoke the Catalina Bootstrap class directly.
  local bootstrap juli
  bootstrap="$(ls "$CATALINA_HOME"/bin/bootstrap.jar /usr/share/java/tomcat9/bootstrap.jar /usr/share/java/bootstrap.jar 2>/dev/null | head -n1)"
  juli="$(ls "$CATALINA_HOME"/bin/tomcat-juli.jar /usr/share/java/tomcat9/tomcat-juli.jar /usr/share/java/tomcat-juli.jar 2>/dev/null | head -n1)"
  log "starting Tomcat via Bootstrap (bootstrap=${bootstrap:-none})"
  # shellcheck disable=SC2086
  java $CATALINA_OPTS \
    -Dcatalina.base="$CATALINA_BASE" \
    -Dcatalina.home="$CATALINA_HOME" \
    -Djava.io.tmpdir="$CATALINA_BASE/temp" \
    -classpath "${bootstrap}:${juli}" \
    org.apache.catalina.startup.Bootstrap start >>"$LOG" 2>&1 &
  TOMCAT_PID=$!
}

start_tomcat

if wait_tcp 127.0.0.1 "$GUAC_HTTP_PORT" 240; then
  log "Tomcat is serving on $GUAC_HTTP_PORT — Apache Guacamole client at /guacamole/"
else
  log "WARNING: Tomcat did not open $GUAC_HTTP_PORT within timeout (see $LOG)"
fi

log "boot complete; Apache Guacamole HTML5 client on :$GUAC_HTTP_PORT/guacamole/ (no noVNC)"
# Keep the startProcess-managed process alive for the lifetime of the desktop by
# blocking on Tomcat. If Tomcat somehow failed to launch, fall back to an idle
# wait so the sandbox does not reap the X/VNC/guacd children.
if [ -n "${TOMCAT_PID:-}" ]; then
  wait "$TOMCAT_PID"
else
  log "ERROR: Tomcat PID unknown; holding process open"
  tail -f /dev/null
fi
