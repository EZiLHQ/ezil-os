#!/usr/bin/env bash
# EBuilder Cloudflare Sandbox — alternate `neko` desktop-mode boot sequence.
#
# Phase 1 (see infra/neko-standalone for the validated standalone reference):
# starts the pinned Neko application server inside THIS sandbox container on
# NEKO_HTTP_PORT (8181 by default — deliberately distinct from Guacamole's
# 8080 so both modes can coexist in the same image without a port collision;
# see `NEKO_PORT` in src/index.ts).
#
# Pinned inputs (baked into the image at build time — must match
# infra/neko-standalone/.env / build.sh exactly):
#   neko:      d74052bb844c43a0cc3c2386d083f7505dc483a2
#   neko-apps: 049931d7638f9db8598f29c369d2fb7cd2c6e4b4
#
# The Neko runtime (the `neko` Go server, its /var/www client bundle, and the
# /etc/neko config) is COPY'd from the pinned ezil-neko-vscode image into this
# Ubuntu 22.04 Sandbox base by the Dockerfile's multi-stage `neko` build
# stage. This script does NOT build or fetch Neko at runtime: Cloudflare
# Sandbox containers have no docker-in-docker, so the pinned neko-apps image
# build happens at IMAGE BUILD time only, matching the already-validated
# infra/neko-standalone build path. NOTE: that pinned image's own Electron
# VS Code build is deliberately NOT copied — see the Dockerfile and the
# "code-server launch" section below; code-server is installed separately.
#
# Runtime layout on the Ubuntu base:
#   Xvfb :99         virtual X display (dummy framebuffer)
#   openbox          lightweight window manager (config /etc/neko/openbox.xml)
#   pulseaudio       audio server (best-effort; media is WebRTC-gated)
#   code-server      the IDE, served over plain HTTP on 0.0.0.0:8443 — NOT
#                    an X client, so it is never part of the Xvfb/WebRTC
#                    pixel stream (replaces the pinned image's Electron VS
#                    Code build; see the Dockerfile and this script's
#                    "code-server launch" section for why)
#   neko serve       the Neko application server on NEKO_HTTP_PORT (8181):
#                    HTTP UI + WebSocket signaling for the native browser's
#                    pixel stream. The Worker fronts this via
#                    proxyToSandbox().
#
# WebRTC media (audio/video/input over datachannels) requires a TURN relay in
# production (Cloudflare Sandbox carries HTTP/WebSocket, NOT raw UDP; see
# checkIceConfig() in src/index.ts). When the Worker is configured with a
# Cloudflare Realtime TURN key it mints short-lived, per-session ephemeral
# credentials and passes them into THIS process as environment variables
# (NEKO_WEBRTC_ICESERVERS_FRONTEND / NEKO_WEBRTC_ICESERVERS_BACKEND, plus
# NEKO_WEBRTC_ICELITE=false and NEKO_WEBRTC_ICETRICKLE=true). neko reads those
# NEKO_WEBRTC_* env vars natively, so this script does NOT need to pass any ICE
# flags — and MUST NOT echo their values (they are short-lived TURN
# credentials). When no TURN key is configured the vars are absent and neko
# falls back to its baked /etc/neko config (STUN-only / relay-less), in which
# case the pixel/desktop stream stays gated exactly as before.
set -uo pipefail

LOG=/tmp/neko.log

# ── Boot-phase observability (always on, cheap, no exec route into prod) ─────
# Production has no shell/exec route into a live container (workspace-diag /
# twen only touch fixed marker files) — `wrangler tail` is the ONLY window
# into what a live boot is doing, so every boot-relevant line here carries a
# millisecond-precision elapsed timestamp and the `[ezil-boot]` prefix is
# shared with the Worker's own `ensureDesktop` logging (src/index.ts) so a
# single `wrangler tail` interleaves both sides of one boot into one
# greppable stream. `phase_start`/`phase_end` additionally bracket the named
# phases a human actually cares about ("where does boot time go / where did
# it die") with both a per-phase and a cumulative-since-boot duration. Never
# logs payloads, secrets, file contents, or env values — only phase names,
# ok/error/skipped outcomes, and integers.
BOOT_T0_MS="$(date +%s%3N)"
elapsed_ms() { echo $(( $(date +%s%3N) - BOOT_T0_MS )); }
log() { echo "[ezil-boot][start-neko] +$(elapsed_ms)ms $*" | tee -a "$LOG" >&2; }

declare -A PHASE_T0_MS=()
# "ready" is a whole-boot phase: seed its start at the script's own t0 (rather
# than requiring a separate phase_start call right before neko binds) so its
# phase_end below reports the TOTAL boot-to-ready duration, identical to
# cumulative_ms — the single number that answers "how long did this boot
# take end to end".
PHASE_T0_MS[ready]="$BOOT_T0_MS"
# phase_start <name> — marks the start of a named boot phase.
phase_start() {
  local name="$1"
  PHASE_T0_MS[$name]="$(date +%s%3N)"
  echo "[ezil-boot] +$(elapsed_ms)ms phase=${name} event=start" | tee -a "$LOG" >&2
}
# phase_end <name> [status] — marks the end of a named boot phase (status
# defaults to "ok"; pass "error"/"skipped" for the other terminal outcomes).
# Emits BOTH the duration of just this phase (phase_ms) and the cumulative
# elapsed time since the script started (cumulative_ms) — the former shows
# where time goes, the latter shows how far into boot a failure happened.
phase_end() {
  local name="$1" status="${2:-ok}" now t0 dur
  now="$(date +%s%3N)"
  t0="${PHASE_T0_MS[$name]:-$now}"
  dur=$((now - t0))
  echo "[ezil-boot] +$(elapsed_ms)ms phase=${name} event=end status=${status} phase_ms=${dur} cumulative_ms=$((now - BOOT_T0_MS))" | tee -a "$LOG" >&2
}

phase_start container_start

NEKO_HTTP_PORT="${NEKO_HTTP_PORT:-8181}"
NEKO_BIN="${NEKO_BIN:-/usr/bin/neko}"
export DISPLAY="${DISPLAY:-:99}"
export USER="${USER:-root}"
export HOME="${HOME:-/root}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-neko}"
NEKO_SCREEN="${NEKO_SCREEN:-1920x1080x24}"
NEKO_STATIC="${NEKO_STATIC:-/var/www}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true
mkdir -p /var/log/neko 2>/dev/null || true

# ── CPU saturation diagnostics (opt-in, OFF by default, zero cost when off) ───
# The perf-tuning research that originally motivated this diagnostic tool
# targeted standard-1 (0.5 vCPU / 4 GiB) sharing half a physical core between
# Xvfb, two Electron/GUI apps (Chrome and Electron VS Code), this script's own
# vp8enc software encode, and the user's dev-server compile (software
# rendering only — no GPU in Cloudflare Containers, both ran --disable-gpu) —
# a STRONG CIRCUMSTANTIAL suspect for "EZiL OS is slow" that was NEVER
# MEASURED. Both facts have since changed (instance_type is now standard-3 —
# 2 vCPU — and Electron VS Code is replaced by code-server, a non-renderer;
# see the encoder-tuning section below for the numbers this changed), but the
# tool itself stays exactly as useful for verifying that headroom actually
# materializes as claimed. Rather than guess, sample real CPU/load
# figures from /proc during an actual session into a sidecar file, following
# the exact phase-file pattern start-devserver.sh already uses
# (write_phase()/PHASE_FILE) — one JSON line per sample, gated behind
# EZIL_NEKO_CPU_DIAG_ENABLED so a normal boot spawns NO extra process and
# writes NO extra file unless an operator explicitly opts in for a diagnostic
# run. Reads only /proc/stat, /proc/loadavg, /proc/meminfo (no `top` fork per
# sample, no new package dependency) so the sampler itself cannot become part
# of the CPU problem it is measuring.
NEKO_CPU_DIAG_FILE="${NEKO_CPU_DIAG_FILE:-/tmp/neko-cpu-diag.jsonl}"
NEKO_CPU_DIAG_INTERVAL="${NEKO_CPU_DIAG_INTERVAL:-5}"
CPU_DIAG_PID=""
if [ "${EZIL_NEKO_CPU_DIAG_ENABLED:-0}" = "1" ]; then
  log "CPU diagnostics ENABLED (opt-in) — sampling every ${NEKO_CPU_DIAG_INTERVAL}s into $NEKO_CPU_DIAG_FILE"
  rm -f "$NEKO_CPU_DIAG_FILE" 2>/dev/null || true
  (
    prev_total=0
    prev_idle=0
    while true; do
      if [ -r /proc/stat ]; then
        # First line of /proc/stat: cpu user nice system idle iowait irq softirq steal guest guest_nice
        read -r _ cpu_user cpu_nice cpu_system cpu_idle cpu_iowait cpu_irq cpu_softirq cpu_steal _ _ < /proc/stat
        idle_all=$((cpu_idle + cpu_iowait))
        non_idle=$((cpu_user + cpu_nice + cpu_system + cpu_irq + cpu_softirq + cpu_steal))
        total=$((idle_all + non_idle))
        cpu_pct=0
        if [ "$prev_total" -gt 0 ]; then
          totald=$((total - prev_total))
          idled=$((idle_all - prev_idle))
          if [ "$totald" -gt 0 ]; then
            cpu_pct=$(( (100 * (totald - idled)) / totald ))
          fi
        fi
        prev_total="$total"
        prev_idle="$idle_all"
        load1="$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)"
        mem_used_pct="$(awk '/MemTotal:/{t=$2} /MemAvailable:/{a=$2} END{if (t>0) printf "%d", (t-a)*100/t; else print 0}' /proc/meminfo 2>/dev/null || echo 0)"
        ts="$(date +%s 2>/dev/null || echo 0)"
        printf '{"ts":%s,"cpu_pct":%s,"load1":%s,"mem_used_pct":%s}\n' "$ts" "$cpu_pct" "$load1" "$mem_used_pct" >>"$NEKO_CPU_DIAG_FILE" 2>/dev/null || true
      fi
      sleep "$NEKO_CPU_DIAG_INTERVAL"
    done
  ) &
  CPU_DIAG_PID=$!
fi

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

# Idempotency, same rationale as start-desktop.sh: probe the loopback port
# rather than pgrep, since sandbox containers share the host PID namespace.
if wait_tcp 127.0.0.1 "$NEKO_HTTP_PORT" 2; then
  log "neko already serving on 127.0.0.1:$NEKO_HTTP_PORT — nothing to do"
  phase_end container_start skipped
  exit 0
fi

if [ ! -x "$NEKO_BIN" ]; then
  log "ERROR: neko binary not found at $NEKO_BIN — image was not built with the neko stage (see Dockerfile). Fail closed rather than silently falling back to Guacamole."
  phase_end container_start error
  exit 1
fi

# ── Mandatory app preflight (native browser + code-server, contract requirement) ──
# The authoritative EZiL OS contract requires BOTH a native browser and
# code-server (which replaced Electron VS Code) on the neko desktop — neither
# is optional, and there is no app/desktop
# fallback. Both executables MUST be validated to exist BEFORE any background
# app or `neko serve` is started, so a missing binary fails Neko startup
# cleanly instead of silently degrading to a "best-effort skip" (the prior,
# rejected behavior) or falling back to Guacamole. Only checked executable
# names are reported — never environment values.
# Candidate browser executable names, in priority order. Defaults to the
# production set; NEKO_BROWSER_CANDIDATES (space-separated) may override it
# strictly for deterministic testing on hosts where the production binary name
# differs. It never changes the contract: a native browser MUST still resolve.
if [ -n "${NEKO_BROWSER_CANDIDATES:-}" ]; then
  read -r -a CHROME_CANDIDATES <<< "${NEKO_BROWSER_CANDIDATES}"
else
  CHROME_CANDIDATES=(google-chrome-stable google-chrome chromium chromium-browser)
fi
CHROME_BIN=""
for candidate in "${CHROME_CANDIDATES[@]}"; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CHROME_BIN="$(command -v "$candidate")"
    break
  fi
done
if [ -z "$CHROME_BIN" ]; then
  log "ERROR: no mandatory native browser binary found (checked: ${CHROME_CANDIDATES[*]}). The EZiL OS contract requires a native browser on every neko desktop — there is no app/desktop fallback. Failing Neko startup before readiness."
  phase_end container_start error
  exit 1
fi

# code-server (replaces Electron VS Code — see the Dockerfile and this
# script's "code-server launch" section below for why the two must never
# coexist). It is a plain HTTP server, not an X client, so there is no
# Electron-binary/wrapper resolution to do here — just confirm the binary the
# Dockerfile installed is actually present before anything is launched.
CODE_SERVER_BIN=""
if command -v code-server >/dev/null 2>&1; then
  CODE_SERVER_BIN="$(command -v code-server)"
fi
if [ -z "$CODE_SERVER_BIN" ]; then
  log "ERROR: mandatory code-server binary not found (checked: code-server). The EZiL OS contract requires code-server on every neko desktop — there is no app/desktop fallback. Failing Neko startup before readiness."
  phase_end container_start error
  exit 1
fi

log "mandatory app preflight passed: browser=$(basename "$CHROME_BIN") codeserver=$(basename "$CODE_SERVER_BIN")"
phase_end container_start ok

# ── Workspace hydration (sealed startup delivery → /home/neko/project) ────────
# The canonical project workspace root. code-server (formerly Electron VS
# Code) opens EXACTLY this directory, and — when a sealed startup delivery is
# present — it is hydrated from the
# durable branch BEFORE readiness so the desktop never shows an empty/partial
# tree. Overridable via EZIL_WORKSPACE_ROOT (kept in lockstep with the bootstrap
# bundle, which defaults to the same path).
WORKSPACE_ROOT="${EZIL_WORKSPACE_ROOT:-/home/neko/project}"
export EZIL_WORKSPACE_ROOT="$WORKSPACE_ROOT"
mkdir -p "$WORKSPACE_ROOT" 2>/dev/null || true

# The sealed workspace-startup delivery arrives ONLY via the container startup
# ENVIRONMENT (EZIL_WORKSPACE_STARTUP_DELIVERY), forwarded by the Worker — never
# on a command line. When present we MUST hydrate before readiness and fail the
# whole container closed if hydration fails (a tampered/expired delivery or an
# unreachable durable branch must not surface as a ready-but-empty desktop). The
# sealed value is NEVER echoed/logged here — the bundle logs only safe fields.
WORKSPACE_BOOTSTRAP_BIN="${WORKSPACE_BOOTSTRAP_BIN:-/usr/local/lib/ezil/workspace-bootstrap.mjs}"
phase_start workspace_hydration
if [ -n "${EZIL_WORKSPACE_STARTUP_DELIVERY:-}" ]; then
  if [ ! -f "$WORKSPACE_BOOTSTRAP_BIN" ]; then
    log "ERROR: sealed workspace-startup delivery present but bootstrap bundle missing ($WORKSPACE_BOOTSTRAP_BIN) — failing closed"
    phase_end workspace_hydration error
    exit 1
  fi
  if ! command -v bun >/dev/null 2>&1; then
    log "ERROR: sealed workspace-startup delivery present but 'bun' runtime unavailable — failing closed"
    phase_end workspace_hydration error
    exit 1
  fi
  log "hydrating workspace at $WORKSPACE_ROOT from sealed startup delivery (before readiness)"
  # Capture the resolved code-server target root from the bundle's final stdout line;
  # its stderr (safe stage/outcome logs) is teed into the neko log.
  if _bootstrap_root="$(bun "$WORKSPACE_BOOTSTRAP_BIN" 2> >(tee -a "$LOG" >&2))"; then
    _bootstrap_root="$(printf '%s' "$_bootstrap_root" | tail -n1 | tr -d '[:space:]')"
    if [ -n "$_bootstrap_root" ]; then
      WORKSPACE_ROOT="$_bootstrap_root"
      # Refresh the exported env var too — it was set from the PRE-hydration
      # default above and, without this, would silently go stale relative to
      # the local $WORKSPACE_ROOT for any later consumer that reads the env
      # var instead of this script's variable (e.g. start-devserver.sh, if
      # invoked without an explicit argv override).
      export EZIL_WORKSPACE_ROOT="$WORKSPACE_ROOT"
    fi
    log "workspace hydration succeeded — code-server target root=$WORKSPACE_ROOT"
    phase_end workspace_hydration ok
  else
    log "ERROR: workspace hydration failed (sealed delivery present) — failing closed"
    phase_end workspace_hydration error
    exit 1
  fi
else
  log "no sealed workspace-startup delivery present — skipping hydration (legacy/pre-ready path), code-server root=$WORKSPACE_ROOT"
  phase_end workspace_hydration skipped
fi

# ── Split mount: keep node_modules/.next off the R2 FUSE mount ───────────────
# $WORKSPACE_ROOT is source-of-truth for PROJECT SOURCE and, when the S3/R2
# workspace bucket is mounted (see ensureWorkspaceMount/EZIL_WORKSPACE_ROOT in
# src/index.ts), that root is an s3fs-fuse mount — fine for the ~812KB/17-file
# source tree it actually stores (node_modules is already excluded from what
# gets persisted there), but pathological for small-file build-output
# workloads: comparable s3fs-fuse cases showed `ls -R` taking >10 minutes cold
# and an incremental build exceeding 5 hours before failing outright. The
# very first `npm install`/dev-server build into that mount would hang the
# same way, so node_modules and .next MUST live on local ephemeral disk
# instead, symlinked in from under the (possibly R2-backed) workspace root.
#
# Placed HERE — after $WORKSPACE_ROOT is fully finalized (hydration above, if
# any, has already resolved/relocated it) and BEFORE both start-devserver.sh's
# dependency install below and code-server opening the workspace further down —
# so neither ever sees node_modules/.next resolve onto the FUSE mount.
# Idempotent (containers re-mount their R2 bucket and re-run this script
# across restarts: re-pointing an already-correct symlink is a no-op) and
# strictly non-fatal — a missing/not-yet-materialized workspace root, or any
# individual mkdir/rm/ln failure, only logs a warning and lets boot continue.
EZIL_LOCAL_STATE_DIR="${EZIL_LOCAL_STATE_DIR:-/var/ezil-local}"
if mkdir -p "$EZIL_LOCAL_STATE_DIR/node_modules" "$EZIL_LOCAL_STATE_DIR/next-cache" 2>/dev/null; then
  if [ -d "$WORKSPACE_ROOT" ]; then
    for _pair in "node_modules:$EZIL_LOCAL_STATE_DIR/node_modules" ".next:$EZIL_LOCAL_STATE_DIR/next-cache"; do
      _name="${_pair%%:*}"
      _target="${_pair#*:}"
      _link="$WORKSPACE_ROOT/$_name"
      if [ -L "$_link" ]; then
        # Already a symlink. Re-run of an idempotent boot: leave it alone if
        # it already points at the right local-disk target; otherwise (e.g. a
        # stale link from a prior local-state layout) drop it and relink below.
        _current="$(readlink "$_link" 2>/dev/null || true)"
        [ "$_current" = "$_target" ] && continue
        rm -f "$_link" 2>/dev/null || true
      elif [ -e "$_link" ]; then
        # A real directory/file on the (possibly R2-backed) workspace root —
        # e.g. left over from a boot that predates this split, or a stray
        # template seed. Must be cleared so the symlink can take its place;
        # per the problem's own source-only guarantee this is expected to be
        # small/empty in practice, never a populated node_modules tree.
        rm -rf "$_link" 2>/dev/null || true
      fi
      ln -s "$_target" "$_link" 2>/dev/null \
        || log "warning: failed to symlink $_link -> $_target (continuing boot)"
    done
    log "local build-output split ready: $WORKSPACE_ROOT/{node_modules,.next} -> $EZIL_LOCAL_STATE_DIR/{node_modules,next-cache}"
  else
    log "warning: workspace root '$WORKSPACE_ROOT' does not exist — skipping node_modules/.next local-disk symlink setup (non-fatal)"
  fi
else
  log "warning: failed to create $EZIL_LOCAL_STATE_DIR — skipping node_modules/.next local-disk symlink setup (non-fatal)"
fi

# ── Dev server (Option D app preview) ─────────────────────────────────────────
# Launch the user's dev server on the app-preview port (APP_PREVIEW_PORT /
# desktop-mode.ts, default 3002 — never 3000, which the @cloudflare/sandbox
# SDK reserves for its own control plane). This closes the gap
# src/preview-bridge.ts's module doc has flagged since Option D landed: the
# token-gated /preview, /preview-ws, and /preview-status routes have always
# proxied/probed the app-preview port, but nothing in this container image
# ever started a process listening there.
#
# Placed HERE — after $WORKSPACE_ROOT is finalized (hydration, if any, is
# synchronous/fail-closed above, unlike start-desktop.sh's async
# hydrate-with-timeout pattern) but BEFORE Xvfb/openbox/the window-ready gate
# — deliberately. start-devserver.sh is itself non-blocking: it backgrounds
# dependency install and the dev-server process and returns almost
# immediately (`starting`/`already-running`), so invoking it here adds no
# measurable delay and can never serialize behind, or gate, code-server/Chrome
# readiness or `neko serve` binding its own port below. A slow or crashing
# dev server therefore never prevents the desktop from becoming ready — its
# real state is written to /tmp/devserver.phase (crashed/timeout/running/…)
# for the Worker's /preview-status probe to report truthfully instead of
# silently proxying to nothing, which was the whole prior bug.
DEVSERVER_BIN="${DEVSERVER_BIN:-/usr/local/bin/start-devserver.sh}"
phase_start devserver_launch
if [ -x "$DEVSERVER_BIN" ]; then
  log "requesting async dev server launch in $WORKSPACE_ROOT on :${EZIL_DEV_SERVER_PORT:-3002}"
  if "$DEVSERVER_BIN" "$WORKSPACE_ROOT"; then
    phase_end devserver_launch ok
  else
    log "warning: dev server launch request failed (non-fatal, continuing boot — see /tmp/devserver.log)"
    phase_end devserver_launch error
  fi
else
  log "warning: $DEVSERVER_BIN not found — dev server will not be started (app preview will report port_not_listening)"
  phase_end devserver_launch skipped
fi

# ── X display ────────────────────────────────────────────────────────────────
# Neko's desktop manager connects to $DISPLAY at startup and panics if it is
# unavailable, so the X server MUST be up before `neko serve` launches. Keyed
# off the X display itself so a re-run reuses an already-running Xvfb.
phase_start xvfb
if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  log "X display $DISPLAY already active — reusing"
else
  log "starting Xvfb on $DISPLAY ($NEKO_SCREEN)"
  Xvfb "$DISPLAY" -screen 0 "$NEKO_SCREEN" -ac +extension RANDR -nolisten tcp >>"$LOG" 2>&1 &
  for _ in $(seq 1 40); do
    xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  log "ERROR: X display $DISPLAY did not become available — cannot start neko"
  phase_end xvfb error
  exit 1
fi
phase_end xvfb ok

# ── Window manager (openbox) ──────────────────────────────────────────────────
# Prefer the EBuilder-owned Openbox config (explicit app-switch keybindings +
# root menu) over the pinned image's decoration-only config, so window
# management is deterministic and machine-checkable. The chosen config path is
# exported so validators can assert the live desktop is running exactly this
# config (and therefore the shortcuts/menu wiring it defines).
phase_start openbox
OPENBOX_CONFIG=""
for cfg in /etc/neko/ebuilder-openbox.xml /etc/neko/openbox.xml; do
  if [ -f "$cfg" ]; then OPENBOX_CONFIG="$cfg"; break; fi
done
export NEKO_OPENBOX_CONFIG="$OPENBOX_CONFIG"
if [ -x /usr/bin/openbox ] || command -v openbox >/dev/null 2>&1; then
  if [ -n "$OPENBOX_CONFIG" ]; then
    log "starting openbox (config $OPENBOX_CONFIG)"
    openbox --config-file "$OPENBOX_CONFIG" >>"$LOG" 2>&1 &
  else
    log "starting openbox (default config)"
    openbox >>"$LOG" 2>&1 &
  fi
  sleep 1
  phase_end openbox ok
else
  log "openbox not installed — skipping window manager"
  phase_end openbox skipped
fi

# ── Audio (best-effort; media path is WebRTC/TURN-gated) ──────────────────────
if command -v pulseaudio >/dev/null 2>&1; then
  log "starting pulseaudio (best-effort)"
  pulseaudio --log-level=error --disallow-module-loading --disallow-exit --exit-idle-time=-1 >>"$LOG" 2>&1 &
fi

# ── App supervision (code-server + isolated Chromium) ─────────────────────────
# Both apps run on the same $DISPLAY, each supervised independently: a crash in
# one app is caught, logged (sanitized — no window titles, URLs, or args), and
# retried with backoff, and never takes down the other app, `neko serve`, or
# forces a different desktop mode to start. Health state is written to
# $NEKO_APP_HEALTH_FILE for machine-checkable local evidence.
NEKO_APP_HEALTH_FILE="${NEKO_APP_HEALTH_FILE:-/tmp/neko-app-health.json}"
# Contract: a PERMANENT app failure (restart budget exhausted) must terminate
# the desktop as unhealthy, NOT leave Neko apparently ready. When a supervised
# app gives up it appends its name to this fatal sentinel; the main loop below
# detects the sentinel, marks health "failed", and exits the whole script
# non-zero after killing neko — so the container exits non-zero rather than
# serving a half-dead desktop.
NEKO_APP_FATAL_SENTINEL="${NEKO_APP_FATAL_SENTINEL:-/tmp/neko-app-fatal}"
rm -f "$NEKO_APP_FATAL_SENTINEL" 2>/dev/null || true
# Restart budget/backoff. Test harnesses may lower these (e.g. to exhaust
# retries quickly), but the PRODUCTION DEFAULTS below are deliberately generous
# and are NOT weakened.
NEKO_APP_MAX_RESTARTS="${NEKO_APP_MAX_RESTARTS:-5}"
NEKO_APP_RESTART_DELAY="${NEKO_APP_RESTART_DELAY:-2}"
declare -A APP_PID=()
declare -A APP_STATE=()   # starting|running|crashed|stopped|failed
declare -A APP_RESTARTS=()

write_health() {
  # Sanitized: only name/pid/state/restart-count per app — never command lines,
  # window titles, or URLs (which could contain workspace paths or page state).
  local body="{"
  local first=1
  local name
  for name in "${!APP_STATE[@]}"; do
    [ "$first" -eq 1 ] || body+=","
    first=0
    body+="\"${name}\":{\"state\":\"${APP_STATE[$name]}\",\"pid\":${APP_PID[$name]:-0},\"restarts\":${APP_RESTARTS[$name]:-0}}"
  done
  body+="}"
  printf '%s\n' "$body" >"$NEKO_APP_HEALTH_FILE.tmp" && mv "$NEKO_APP_HEALTH_FILE.tmp" "$NEKO_APP_HEALTH_FILE"
}

# supervise_app <name> <max_restarts> <cmd...>
# Runs <cmd> in a restart loop inside its own background subshell/process
# group. On exit it logs only the app name + exit code (never argv/urls), waits
# with a short backoff, and retries up to <max_restarts> times before settling
# into a terminal "crashed" state — which is reported via health/log output but
# never triggers a Guacamole/other-mode fallback (fail-closed-but-isolated).
supervise_app() {
  local name="$1" max_restarts="$2"
  shift 2
  local attempt=0
  APP_STATE[$name]="starting"
  APP_RESTARTS[$name]=0
  write_health
  (
    while true; do
      "$@" >>"$LOG" 2>&1
      local rc=$?
      log "app=$name exited rc=$rc (attempt $((attempt + 1))/$((max_restarts + 1)))"
      attempt=$((attempt + 1))
      if [ "$attempt" -gt "$max_restarts" ]; then
        log "app=$name PERMANENTLY FAILED after $attempt attempts — restart budget exhausted. Marking desktop unhealthy; neko/container will terminate (contract: no apparently-ready desktop with a dead mandatory app)."
        # Record the permanent failure for machine-checkable evidence, then
        # raise the fatal sentinel the main loop watches.
        APP_STATE[$name]="failed"
        APP_RESTARTS[$name]=$((attempt - 1))
        write_health
        echo "$name" >>"$NEKO_APP_FATAL_SENTINEL"
        break
      fi
      sleep "$NEKO_APP_RESTART_DELAY"
    done
  ) &
  APP_PID[$name]=$!
  APP_STATE[$name]="running"
  write_health
}

# Background monitor: periodically re-checks liveness (by supervisor subshell
# pid, since the supervisor itself only exits once retries are exhausted) and
# refreshes the sanitized health file. Runs for the lifetime of this script.
monitor_apps() {
  while true; do
    local name
    for name in "${!APP_PID[@]}"; do
      # A permanently-failed app (restart budget exhausted) is recorded in the
      # fatal sentinel by its supervisor; keep it pinned to "failed" so the
      # health file never regresses a dead mandatory app back to a benign
      # "stopped".
      if [ -f "$NEKO_APP_FATAL_SENTINEL" ] && grep -qx "$name" "$NEKO_APP_FATAL_SENTINEL" 2>/dev/null; then
        APP_STATE[$name]="failed"
      elif kill -0 "${APP_PID[$name]}" 2>/dev/null; then
        APP_STATE[$name]="running"
      else
        APP_STATE[$name]="stopped"
      fi
    done
    write_health
    sleep 5
  done
}

# ── code-server (mandatory — validated above in preflight; never skipped) ────
# Replaces Electron VS Code. This is the load-bearing reason for the whole
# swap: Electron VS Code was a SECOND Chromium-family renderer compositing
# into this same Xvfb display ($DISPLAY) alongside the native browser below,
# every repaint of BOTH going through the one software vp8enc encoder
# (see the encoder-tuning section further down), plus VS Code's own extension
# host — all sharing whatever CPU this container has. code-server is a plain
# Node.js HTTP server: it renders nothing into Xvfb, puts nothing through the
# video encoder, and is NOT part of the neko/WebRTC desktop stream at all.
#
# 🔴 `--bind-addr 0.0.0.0:8443`, NOT loopback. This bound 127.0.0.1 until a
# live production test found code-server running, listening and completely
# unreachable: `Error proxying request to container: The container is not
# listening in the TCP address 10.0.0.1:8443`. Cloudflare's proxy connects to
# the container's ROUTABLE address, never its loopback — which is exactly why
# neko is launched with `NEKO_SERVER_BIND="0.0.0.0:..."` further down this
# same file, with the comment "so proxyToSandbox() can reach it". Neko worked;
# code-server did not; the only difference was the bind address.
# `--auth none` remains safe because the container network is not publicly
# routable and the sole ingress is the Worker's HMAC/cookie-gated
# `*-code.ezil.org` bridge. Loopback here is not a security boundary — it is
# just an unreachable service.
# Supervised the same way chrome/vscode always were (supervise_app — restart
# budget, health file, fatal-sentinel teardown on exhaustion) so a crashing
# code-server is caught exactly like a crashing browser used to be; readiness
# is confirmed below by the (now data-driven) window/tcp gate rather than
# assumed from the process merely being alive.
# NOTE: `codeserver_launch` only times the (near-instant) request to fork the
# supervised background process — supervise_app itself is non-blocking. How
# long the port actually takes to open is measured separately by the
# `window_ready_gate` phase below (see EZIL_DESKTOP_APPS), which runs
# concurrently with Chrome's window check.
phase_start codeserver_launch
log "supervising code-server ($CODE_SERVER_BIN) on 0.0.0.0:8443 at $WORKSPACE_ROOT (mandatory, isolated user-data-dir)"
supervise_app codeserver "$NEKO_APP_MAX_RESTARTS" "$CODE_SERVER_BIN" \
  --bind-addr 0.0.0.0:8443 \
  --auth none \
  --disable-telemetry \
  --user-data-dir=/tmp/code-server-data \
  --extensions-dir=/tmp/code-server-extensions \
  "$WORKSPACE_ROOT"
phase_end codeserver_launch ok

# ── Native browser (mandatory — validated above in preflight; never skipped) ─
# Reuses whichever Chromium-family binary the image already has installed
# (Google Chrome is installed for the Guacamole desktop stage and shares this
# same final image layer — no second browser package is added). Never attaches
# any host/human browser profile, cookies, or saved logins: --user-data-dir
# points at a fresh, container-local, isolated directory created below, and
# first-run/default-browser prompts are suppressed so the isolated instance
# comes up headless-of-prompts on a neutral page.
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-/tmp/chromium-app-data}"
rm -rf "$CHROME_PROFILE_DIR" 2>/dev/null || true
mkdir -p "$CHROME_PROFILE_DIR" 2>/dev/null || true
# Deterministic, non-blank landing page. The mandatory native browser must come
# up on real EZiL OS content with a known <title> ("EZiL OS Browser"), not
# about:blank — so validators can positively assert the browser window is
# present AND rendering the expected app, and so the window title is a stable
# match target. Falls back to about:blank only if the asset is somehow missing.
CHROME_HOME_FILE="${CHROME_HOME_FILE:-/usr/local/share/ezil/browser-home.html}"
if [ -f "$CHROME_HOME_FILE" ]; then
  CHROME_HOME_URL="file://${CHROME_HOME_FILE}"
else
  log "WARNING: browser landing asset $CHROME_HOME_FILE missing — falling back to about:blank"
  CHROME_HOME_URL="about:blank"
fi
# Additional free-CPU flags: these only trim CHROME'S OWN background service
# chatter (component/extension update checks, default-apps bookkeeping,
# hyperlink-auditing pings, misc background network requests) — the same set
# widely used for containerized/headless Chrome (e.g. Puppeteer's Docker
# guidance). None of them touch rendering, JS, canvas, or WebGL, so a
# previewed app's own behavior is unaffected. code-server (launched above,
# replacing Electron VS Code) has its own separate extensions-marketplace/
# settings networking that this script has no basis to assume is safe to cut,
# and is unaffected by these Chrome-specific flags regardless.
# NOTE: same as `codeserver_launch` above — this only times the near-instant
# supervised-process fork request; actual window-appearance time is measured
# by the concurrent `window_ready_gate` phase below.
phase_start chrome_launch
log "supervising mandatory native browser ($CHROME_BIN) into $DISPLAY (fresh, isolated user-data-dir — no host profile; home=$CHROME_HOME_URL)"
supervise_app chromium "$NEKO_APP_MAX_RESTARTS" "$CHROME_BIN" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --disable-fre \
  --disable-sync \
  --disable-extensions \
  --disable-background-networking \
  --disable-component-update \
  --disable-default-apps \
  --no-pings \
  --user-data-dir="$CHROME_PROFILE_DIR" \
  --window-size=1920,1080 \
  --window-position=0,0 \
  "$CHROME_HOME_URL"
phase_end chrome_launch ok

monitor_apps &
MONITOR_PID=$!

# ── Focus/app switching helper (deterministic, machine-checkable) ────────────
# Installs a tiny wrapper so an operator/automation can deterministically
# activate either app window by class via `wmctrl -x -a`, independent of the
# pinned openbox config's built-in Alt+Tab keybinding. Written at runtime (not
# baked in) so it always matches this script's app names.
cat >/usr/local/bin/neko-switch-app.sh <<'SWITCH_EOF'
#!/usr/bin/env bash
# Usage: neko-switch-app.sh <vscode|chromium>
# Deterministically raises/focuses the named app's window on the shared X
# display. Resolves the window by its WM_CLASS via `wmctrl -x -l` (class is
# stable regardless of the page/document title), then activates it by explicit
# window id (`wmctrl -i -a <id>`) so the match is exact and inspectable.
#
# The `vscode` case now has no window to ever find: code-server (which
# replaced Electron VS Code) is a plain HTTP server, not an X client, so it
# never appears in `wmctrl -x -l`. This is a confirmed, verified no-op, not an
# oversight — `win_id` comes back empty, the branch below prints an ERROR to
# stderr and exits 1, and nothing else observes or propagates that exit code
# (Openbox's <action name="Execute"> keybind below fires the command and does
# not care about its result). The `chromium` case is unaffected and still
# resolves/focuses the native browser window normally.
set -uo pipefail
export DISPLAY="${DISPLAY:-:99}"
case "${1:-}" in
  # WM_CLASS instance/class strings emitted by each app. Matched
  # case-insensitively against the "class.instance" field of `wmctrl -x -l`.
  vscode)   class_re='(^|\.)code(\.|$)|Code' ;;
  chromium) class_re='chrome' ;;
  *) echo "usage: $0 <vscode|chromium>" >&2; exit 2 ;;
esac
command -v wmctrl >/dev/null 2>&1 || { echo "ERROR: wmctrl not installed" >&2; exit 1; }

# Find the window id whose WM_CLASS matches. Column 3 of `wmctrl -x -l` is the
# class; column 1 is the (hex) window id.
win_id="$(wmctrl -x -l 2>/dev/null | awk -v re="$class_re" 'tolower($3) ~ tolower(re) {print $1; exit}')"
if [ -z "$win_id" ]; then
  echo "ERROR: no window found for $1 (class ~ $class_re)" >&2
  exit 1
fi
exec wmctrl -i -a "$win_id"
SWITCH_EOF
chmod +x /usr/local/bin/neko-switch-app.sh

# ── Window-ready gate (mandatory, fail-closed, data-driven) ──────────────────
# Readiness MUST NOT be reported (i.e. `neko serve` must not be started, and
# this script must not exit successfully) unless EVERY app in the mandatory
# set has actually become ready within a bounded startup timeout. A process
# being alive (supervise_app's PID bookkeeping) is not sufficient proof —
# Electron/Chromium can be running yet still be mid-splash with no mapped
# top-level window, and a server process can be forked yet not listening.
#
# The mandatory set is DATA, not hardcoded control flow — EZIL_DESKTOP_APPS is
# a space-separated list of `name:kind:target` entries, so a future app swap
# (like this one) only ever needs to change the DEFAULT VALUE below, never
# this gate's logic. Two kinds are supported:
#   window  target = an X `WM_CLASS` regex, polled via `wmctrl -x -l` — same
#           pattern `neko-switch-app.sh` uses, so "ready" and "focusable" are
#           the same definition of ready.
#   tcp     target = `host:port`, polled the same way `wait_tcp` (above) is
#           used for neko's own HTTP port.
# Default reflects what this image actually ships today: the native browser
# (an X window) and code-server (a loopback HTTP port, NOT an X window — see
# the "code-server launch" section above for why Electron VS Code's X-window
# check was replaced with a port check rather than just deleted).
EZIL_DESKTOP_APPS="${EZIL_DESKTOP_APPS:-browser:window:chrome codeserver:tcp:127.0.0.1:8443}"
NEKO_WINDOW_READY_TIMEOUT="${NEKO_WINDOW_READY_TIMEOUT:-60}"

wait_for_window() {
  local class_re="$1" tries="$2"
  for _ in $(seq 1 "$tries"); do
    if wmctrl -x -l 2>/dev/null | awk -v re="$class_re" 'tolower($3) ~ tolower(re){found=1} END{exit found?0:1}'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# wait_for_app_ready <name:kind:target> <timeout_sec> — dispatches to the
# right probe for `kind`. Splits on the FIRST two colons only, so a `tcp`
# target's own `host:port` colon is preserved intact in $target.
wait_for_app_ready() {
  local spec="$1" timeout_sec="$2"
  local rest="${spec#*:}"
  local kind="${rest%%:*}"
  local target="${rest#*:}"
  case "$kind" in
    window)
      wait_for_window "$target" "$timeout_sec"
      ;;
    tcp)
      local host="${target%:*}" port="${target##*:}"
      # wait_tcp (defined near the top of this script) sleeps 0.5s per try —
      # double the try count to normalize to the same per-second timeout unit
      # wait_for_window uses (1s per try).
      wait_tcp "$host" "$port" "$((timeout_sec * 2))"
      ;;
    *)
      log "ERROR: EZIL_DESKTOP_APPS entry '$spec' has unknown kind '$kind' (expected window|tcp)"
      return 1
      ;;
  esac
}

phase_start window_ready_gate
if ! command -v wmctrl >/dev/null 2>&1; then
  log "ERROR: wmctrl not installed — cannot verify mandatory app windows before reporting readiness. Failing closed."
  phase_end window_ready_gate error
  exit 1
fi

# Every app in EZIL_DESKTOP_APPS is polled CONCURRENTLY (not sequentially) —
# each gets its own full ${NEKO_WINDOW_READY_TIMEOUT}s budget in parallel, so
# the gate takes as long as the SLOWEST app, not their sum. This still fails
# closed: if any entry never becomes ready within its timeout, the gate fails
# and `neko serve` is never started. The `phase_start`/`phase_end` calls
# above/below this block bracket the WHOLE concurrent wait (they do not run
# per-app), so they cannot serialize what was deliberately made parallel — do
# not move them inside the loop below.
read -r -a DESKTOP_APP_SPECS <<<"$EZIL_DESKTOP_APPS"
if [ "${#DESKTOP_APP_SPECS[@]}" -eq 0 ]; then
  log "ERROR: EZIL_DESKTOP_APPS is empty — no mandatory apps configured. Failing closed."
  phase_end window_ready_gate error
  exit 1
fi
log "waiting up to ${NEKO_WINDOW_READY_TIMEOUT}s (concurrently) for mandatory apps to become ready: ${DESKTOP_APP_SPECS[*]%%:*}"

declare -A APP_WAIT_PID=()
for spec in "${DESKTOP_APP_SPECS[@]}"; do
  wait_for_app_ready "$spec" "$NEKO_WINDOW_READY_TIMEOUT" &
  APP_WAIT_PID["$spec"]=$!
done

gate_ok=1
for spec in "${DESKTOP_APP_SPECS[@]}"; do
  app_name="${spec%%:*}"
  if wait "${APP_WAIT_PID[$spec]}"; then
    log "${app_name} ready"
  else
    log "ERROR: ${app_name} did not become ready within ${NEKO_WINDOW_READY_TIMEOUT}s (spec=${spec}). Mandatory app failed to become ready — refusing to report Neko readiness or start neko serve."
    gate_ok=0
  fi
done

if [ "$gate_ok" -ne 1 ]; then
  log "window-ready gate FAILED — refusing to report Neko readiness or start neko serve."
  phase_end window_ready_gate error
  exit 1
fi

log "window-ready gate passed: all mandatory apps present (${DESKTOP_APP_SPECS[*]%%:*})"
phase_end window_ready_gate ok

# ── Software video-encoder tuning (free CPU lever, no cost) ──────────────────
# Config precedence here is neko's own (Viper): explicit CLI flag > NEKO_*
# environment variable > /etc/neko/neko.yaml > compiled-in flag default.
# /etc/neko/neko.yaml (baked from the pinned neko-apps vscode build,
# COPY'd by the Dockerfile) sets ONLY `desktop.screen: "1920x1080@60"` plus
# member/session settings — it does not touch capture/webrtc at all. Nothing
# in this script previously set any capture.video.* flag or env var either.
# So every video-encoder setting was silently falling all the way through to
# neko's compiled-in defaults, which — because no `capture.video.pipeline(s)`
# is configured — resolve to the HARDCODED fallback in
# server/internal/config/capture.go's `Capture.Set()`: software vp8enc at
# 1920x1080 (from desktop.screen), 25 fps, cpu-used=4, threads=4,
# deadline=1 (already the cheapest/realtime libvpx deadline), end-usage=cbr,
# target-bitrate=round(3072*650)≈2.0 Mbps. That default was written assuming
# a normal multi-core host; the numbers below were previously tuned for a
# standard-1 container (0.5 vCPU, no GPU, software-only encode shared with
# Xvfb, TWO Electron/Chromium apps — VS Code plus the native browser — and
# the user's dev-server compile). Two things have since changed, both
# independently increasing the free CPU budget available to this encoder:
#   1. instance_type moved standard-1 -> standard-3 (0.5 -> 2 full vCPU; see
#      wrangler.toml's own comment on that change) — already true before this
#      commit, but this comment (and the tuning below) had gone stale.
#   2. Electron VS Code (a SECOND full Chromium-class renderer + its own
#      extension host, also compositing into this same Xvfb display and
#      being captured by this same encoder) is replaced by code-server in
#      this commit — a plain HTTP server that puts nothing through the
#      encoder at all. Only ONE Chromium-family renderer (the native browser)
#      now shares this display/encoder.
#
#   fps 25 -> 15:        UNCHANGED by this commit — this trade-off is about
#                        visual CONTENT (a coding desktop is dominated by
#                        static text/cursor/scroll, not motion video), not
#                        CPU scarcity, so freed CPU is not a reason to revert
#                        it. Resolution (1920x1080) also stays untouched for
#                        the same reason: text legibility over motion
#                        smoothness.
#   cpu-used 6 -> 4:     vp8enc's speed/quality dial (0-16, higher = faster/
#                        cheaper, lower = slower/sharper) is moved back to
#                        upstream's own default. 6 was chosen specifically to
#                        buy back CPU on a shared half-core with two
#                        Electron-class renderers; with a full 2 vCPU and only
#                        one such renderer left, that headroom is no longer
#                        scarce enough to justify the visible quality cost of
#                        overshooting the default.
#   threads 1 -> 2:      vp8enc's row-based multithreading only pays off with
#                        genuine parallel execution lanes, which standard-1's
#                        0.5 vCPU never had (hence 1). standard-3 grants 2
#                        full cores, so 2 encoder threads can now get real
#                        parallelism without starving anything else on this
#                        display (down from the compiled-in default of 4,
#                        which would still be more encoder threads than this
#                        container has cores once Xvfb/openbox/the browser/
#                        the user's dev server are accounted for).
#   target-bitrate:      left EXACTLY as-is (round(3072*650) ≈ 2.0 Mbps), same
#                        reasoning as before — bitrate is not a meaningful CPU
#                        driver for vp8enc.
#
# NOTE: these three numbers are a REASONED re-tune from the architecture
# change above (documented CPU-cost drivers removed/added), NOT a live
# measurement — this file's own WebRTC/input section above notes that the
# actual pixel/media pipeline is TURN-gated and unverified end-to-end in this
# environment, so encoder CPU% under real load was not (and could not be)
# sampled here. If EZIL_NEKO_CPU_DIAG_ENABLED sampling from a real deployment
# later shows headroom to spare or a regression, retune these three values —
# not fps/resolution, per the trade-off above.
#
# This is neko's own documented default pipeline (server/internal/config/
# capture_pipeline.go's `vp8enc` branch) with these three numbers adjusted for
# this container's real CPU budget — not an invented streaming preset.
# Delivered via `NEKO_CAPTURE_VIDEO_PIPELINES` (env — see precedence note
# above) so it can be overridden per-deployment without editing this script,
# and `NEKO_CAPTURE_VIDEO_IDS` because setting `capture.video.pipelines` does
# not implicitly populate `capture.video.ids` — an empty id list would leave
# no video stream selectable at all.
NEKO_CAPTURE_VIDEO_IDS="${NEKO_CAPTURE_VIDEO_IDS:-main}"
NEKO_CAPTURE_VIDEO_PIPELINES="${NEKO_CAPTURE_VIDEO_PIPELINES:-{\"main\":{\"fps\":\"15\",\"gst_encoder\":\"vp8enc\",\"gst_params\":{\"target-bitrate\":\"round(3072 * 650)\",\"cpu-used\":\"4\",\"end-usage\":\"cbr\",\"threads\":\"2\",\"deadline\":\"1\",\"undershoot\":\"95\",\"buffer-size\":\"(3072 * 4)\",\"buffer-initial-size\":\"(3072 * 2)\",\"buffer-optimal-size\":\"(3072 * 3)\",\"keyframe-max-dist\":\"25\",\"min-quantizer\":\"4\",\"max-quantizer\":\"20\"}}}}"
export NEKO_CAPTURE_VIDEO_IDS NEKO_CAPTURE_VIDEO_PIPELINES
log "video encoder: vp8 software, 1920x1080, 15fps, cpu-used=4, threads=2, ~2.0Mbps (re-tuned for standard-3's 2 vCPU now that code-server replaced the second Electron-class renderer; see start-neko.sh comment for full precedence/justification)"

# ── Neko application server (HTTP UI + WebSocket signaling) ────────────────────
# Bind to 0.0.0.0 so proxyToSandbox() can reach it. Config auto-discovered from
# /etc/neko/neko.yaml (run from that dir to match the pinned image behavior).
#
# `--desktop.input.enabled=false`: the pinned image's default input path uses a
# custom `xf86-input-neko` Xorg driver (an Xorg input module ABI-locked to the
# neko image's Debian-13 Xorg). This Ubuntu 22.04 Sandbox base drives the
# desktop with Xvfb, whose Xorg input ABI differs, so the custom driver cannot
# be loaded. Disabling it makes neko fall back to standard X (XTEST) input,
# which works on Xvfb — without it neko panics on `xf86-input-neko.sock` before
# ever binding its HTTP listener. With the custom driver disabled neko falls
# back to standard X input; whether pointer/keyboard events are actually
# delivered over XTEST on this Xvfb base is UNVERIFIED (input travels over the
# same WebRTC datachannel that is TURN-gated, so it cannot be exercised in
# Phase 1). Do not assume working pointer/keyboard until TURN is wired and it is
# tested end-to-end. The Phase-1 gate proven here is only that neko binds its
# HTTP UI + WebSocket signaling on NEKO_HTTP_PORT; the visible pixel stream and
# input remain WebRTC/TURN-gated (out of Phase-1 scope).
phase_start neko_serve_bind
log "starting neko on 0.0.0.0:$NEKO_HTTP_PORT (pinned build, static=$NEKO_STATIC)"
# Report ONLY whether a TURN relay is wired — never the credential values.
if [ -n "${NEKO_WEBRTC_ICESERVERS_FRONTEND:-}" ]; then
  log "ICE: TURN relay configured via NEKO_WEBRTC_ICESERVERS_* (credentials redacted)"
else
  log "ICE: no TURN relay configured — relay-less/STUN-only (media gated)"
fi
cd /etc/neko 2>/dev/null || true
NEKO_SERVER_BIND="0.0.0.0:${NEKO_HTTP_PORT}" \
NEKO_DESKTOP_INPUT_ENABLED="false" \
  "$NEKO_BIN" serve \
    --server.static "$NEKO_STATIC" \
    --desktop.input.enabled=false \
    --desktop.display "$DISPLAY" \
    --capture.video.display "$DISPLAY" >>"$LOG" 2>&1 &
NEKO_PID=$!

if wait_tcp 127.0.0.1 "$NEKO_HTTP_PORT" 120; then
  log "neko is serving on $NEKO_HTTP_PORT"
  phase_end neko_serve_bind ok
  phase_end ready ok
else
  log "WARNING: neko did not open $NEKO_HTTP_PORT within timeout (see $LOG)"
  phase_end neko_serve_bind error
  phase_end ready error
fi

# ── Fatal-failure watch (contract: dead mandatory app => unhealthy desktop) ───
# Keep the startProcess-managed process alive for the lifetime of the desktop,
# but also watch for a PERMANENT mandatory-app failure. If a supervised app
# exhausts its restart budget it raises $NEKO_APP_FATAL_SENTINEL; on seeing it
# we mark the app failed in the health file, tear down neko + the other
# supervisors/monitor, and exit NON-ZERO so the container is reported unhealthy
# instead of continuing to serve an apparently-ready desktop with a dead app.
terminate_stack() {
  local reason="$1"
  log "terminating neko stack: $reason"
  kill "$MONITOR_PID" 2>/dev/null || true
  [ -n "$CPU_DIAG_PID" ] && kill "$CPU_DIAG_PID" 2>/dev/null || true
  local p
  for p in "${APP_PID[@]}"; do kill "$p" 2>/dev/null || true; done
  kill "$NEKO_PID" 2>/dev/null || true
  wait "$NEKO_PID" 2>/dev/null || true
}

while true; do
  if [ -f "$NEKO_APP_FATAL_SENTINEL" ]; then
    failed_app="$(head -1 "$NEKO_APP_FATAL_SENTINEL" 2>/dev/null)"
    APP_STATE[$failed_app]="failed"
    write_health
    log "FATAL: mandatory app '$failed_app' permanently failed (restart budget exhausted). Desktop is unhealthy; exiting non-zero per contract (no apparently-ready desktop with a dead app)."
    terminate_stack "mandatory app '$failed_app' permanently failed"
    exit 1
  fi
  if ! kill -0 "$NEKO_PID" 2>/dev/null; then
    log "neko process exited on its own — propagating its status"
    break
  fi
  sleep 2
done

wait "$NEKO_PID"
NEKO_RC=$?
log "neko exited rc=$NEKO_RC"
exit "$NEKO_RC"
