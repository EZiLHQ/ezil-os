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
  emit_telemetry "$name" "$status" "$dur"
}

# ── Structured boot telemetry (fixed path, drained by the Worker) ───────────
# Production has no exec/shell route into a live container (see this file
# header comment above), and the wrangler tail human-readable [ezil-boot]
# lines above are not queryable anywhere durable. This gives the Worker a fixed,
# machine-parseable file to drain (`drainContainerBootTelemetry`, index.ts)
# after EVERY boot attempt, ok or not, so the fleet-wide "which boot phase
# fails most" question can be answered without grepping live logs.
#
# One JSON line per PHASE_END call (never a raw message, never a path, never
# an env value) — the closed set of phase names already logged above plus an
# ok/error/skipped status and an integer duration. Same "never interpolate a
# free-form string" discipline this whole script already applies everywhere
# else. `|| true` on the append: a full disk must never fail a boot.
TELEMETRY_NDJSON="${EZIL_TELEMETRY_NDJSON_PATH:-/var/log/ezil-telemetry.ndjson}"
# emit_telemetry <phase_name> <status> <duration_ms>
# The whole-boot "ready" phase becomes eventClass=boot_summary (the
# denominator every telemetry query divides by — see the design doc, section
# 6, Q2/Q4); every other phase becomes eventClass=boot_phase. `code` mirrors
# `status` here: this script has no richer per-phase error taxonomy than
# ok/error/skipped, and an outcome string is itself a safe, closed-set code.
emit_telemetry() {
  local phase_name="$1" status="${2:-ok}" duration_ms="${3:-0}" event_class="boot_phase"
  [ "$phase_name" = "ready" ] && event_class="boot_summary"
  printf '{"eventClass":"%s","source":"container","site":"%s","code":"%s","outcome":"%s","durationMs":%s}\n' \
    "$event_class" "$phase_name" "$status" "$status" "$duration_ms" >>"$TELEMETRY_NDJSON" 2>/dev/null || true
}

phase_start container_start

NEKO_HTTP_PORT="${NEKO_HTTP_PORT:-8181}"
# code-server's port. 8443 is not free to change unilaterally — the Worker's
# CODE_PREVIEW_PORT and the `8443-<id>-code.<host>` bridge hostname both hard-
# code it (src/index.ts). Named here so the launch flag, the readiness gate and
# the stale-listener preflight all read the same value.
CODE_SERVER_PORT="${CODE_SERVER_PORT:-8443}"
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

# ── Process bookkeeping + teardown ───────────────────────────────────────────
# Declared HERE, near the top, and not next to the app supervisor further down,
# because `terminate_stack` is wired to EXIT and to every terminating signal
# just below: it can therefore fire from ANY point in the boot — including the
# early fail-closed `exit 1`s in preflight and the window-ready gate — and must
# never touch an unset variable under `set -u`.
#
# 🔴 THE BUG THIS SECTION EXISTS TO PREVENT (measured in a real container,
#    2026-08-02, not theorised). Teardown used to be exactly this:
#
#        for p in "${APP_PID[@]}"; do kill "$p" 2>/dev/null || true; done
#        kill "$NEKO_PID" 2>/dev/null || true
#
#    APP_PID holds the pids of supervise_app's SUBSHELLS, not of the
#    applications. code-server and Chrome are CHILDREN of those subshells, so
#    killing the supervisor reparented them to init and left them running. What
#    a container looked like one second after that teardown:
#
#        137  1  .../code-server --bind-addr 0.0.0.0:8443   <- PPID 1, alive
#        164  1  /usr/bin/google-chrome-stable ...          <- PPID 1, alive
#        8443 NOT BINDABLE: [Errno 98] Address already in use
#
#    The next boot in that same container was then unrecoverable, and it failed
#    in the most misleading way available: the orphaned code-server ANSWERED the
#    fail-closed readiness probe on 8443 and the orphaned Chrome SUPPLIED the
#    WM_CLASS the window gate looks for, so the gate passed in 58ms and the boot
#    logged `phase=ready event=end status=ok`. The real, new code-server then
#    failed to bind six times ("address already in use"), exhausted its restart
#    budget, and took the whole desktop down 14 seconds after declaring itself
#    ready — leaving yet more orphans behind for the boot after that.
#
#    Two things are needed to make that impossible and both are load-bearing:
#      1. each application runs in its OWN process group (`setsid` in
#         supervise_app), so teardown can signal the application AND its whole
#         descendant tree — code-server forks a second node process which is
#         the one actually holding the listening socket, and Chrome forks a
#         dozen — with one `kill -- -PGID`;
#      2. the pgid is recorded in a FILE, not a shell variable, because the
#         supervisor is a subshell and cannot assign back into this shell, and
#         because the file then survives the process that wrote it and becomes
#         this container's cross-boot ownership record (see reclaim_stale_app).
#
#    Note what is NOT used: the process group of this script. Non-interactive
#    bash has job control off, so every `&` child stays in the SCRIPT's own
#    process group (all of pids 81/105/137/164 above shared pgid 15, the
#    script) — `kill -- -$$` would kill the teardown as it ran. And never a
#    bare-name `pkill`: a name match in a container the user also runs
#    processes in is not ownership.
declare -A APP_PID=()   # app name -> supervise_app subshell (a bash loop) pid
NEKO_PID=""             # `neko serve`
MONITOR_PID=""          # monitor_apps health-refresh loop
SESSION_PID=()          # plain `&` children of this script: Xvfb, openbox, pulseaudio

# Where each supervisor publishes the process-group id of the application it is
# currently running, one file per app. Deliberately NOT cleared on boot: a file
# left behind by a previous boot of this same container is exactly the evidence
# reclaim_stale_app needs to prove it owns a straggler.
NEKO_APP_PGID_DIR="${NEKO_APP_PGID_DIR:-/tmp/neko-app-pgid}"
mkdir -p "$NEKO_APP_PGID_DIR" 2>/dev/null || true

# Set by terminate_stack before it signals anything, so a supervisor whose app
# dies during the teardown breaks out of its restart loop instead of racing the
# teardown by starting a replacement. Cleared on boot.
NEKO_SHUTDOWN_FLAG="${NEKO_SHUTDOWN_FLAG:-/tmp/neko-shutdown}"
# Deliberately NOT cleared here. A flag left behind by a previous boot keeps
# that boot's supervisors — if any survived — from restarting anything while
# this boot reclaims them; it is cleared in the stale-boot reclaim block, once
# the reclaim is done and immediately before this boot starts its own apps.

# Seconds a graceful SIGTERM is given before teardown escalates to SIGKILL.
# code-server may be mid-write to the user's workspace, so it gets a real
# chance to close cleanly; the escalation exists so a wedged process can still
# never outlive the teardown.
NEKO_TEARDOWN_GRACE="${NEKO_TEARDOWN_GRACE:-8}"

# _kill_pid <signal> <pid> — signal one process. No-op on an empty/dead pid.
_kill_pid() {
  local sig="$1" pid="${2:-}"
  [ -n "$pid" ] || return 0
  kill -"$sig" "$pid" 2>/dev/null || true
}

# _kill_pgid <signal> <pgid> — signal a whole process group (leader included,
# and still effective once the leader itself is gone). Empty pgid is a no-op.
_kill_pgid() {
  local sig="$1" pgid="${2:-}"
  [ -n "$pgid" ] || return 0
  kill -"$sig" -- "-$pgid" 2>/dev/null || true
}

# _proc_state <pid> — echo the single-letter state from /proc/<pid>/stat, or
# nothing at all if the process does not exist. /proc/<pid>/stat is
# "pid (comm) state ppid pgrp …" and <comm> may itself contain spaces and
# parentheses, so every parse here splits on the LAST ") ".
_proc_state() {
  local line rest
  read -r line <"/proc/${1}/stat" 2>/dev/null || return 1
  rest="${line##*) }"
  printf '%s' "${rest%% *}"
}

# _pid_alive <pid> — true while that pid is a LIVE process. Zombies do not
# count, for the same reason they do not count in _pgid_alive below: a
# reparented supervisor whose init never reaps it stays visible to `kill -0`
# forever, which made the stale-boot reclaim spend its whole grace period
# waiting for a process that had already exited (measured: 8s per app).
_pid_alive() {
  local st
  [ -n "${1:-}" ] || return 1
  st="$(_proc_state "$1")" || return 1
  [ -n "$st" ] && [ "$st" != "Z" ]
}

# _reclaim_pid <pid> <cmdline_substring> <label> — TERM, bounded grace, KILL a
# single process left over from a previous boot of this container. Returns 1
# WITHOUT signalling anything if ownership cannot be proved: the pid must be a
# live (non-zombie) process whose /proc cmdline contains <cmdline_substring>.
# Callers always source the pid from a record written by this script or by the
# process itself (an X lock file) — never from a search of the process table.
_reclaim_pid() {
  local pid="$1" expect="$2" label="$3" cmd=""
  [ -n "$pid" ] || return 1
  _pid_alive "$pid" || return 1
  if [ -r "/proc/${pid}/cmdline" ]; then
    cmd="$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null)"
  fi
  case "$cmd" in
    *"$expect"*) : ;;
    *) return 1 ;;
  esac
  log "stale-boot RECLAIM: $label from a previous boot is still alive (pid=$pid) — stopping it before this boot starts its own"
  _kill_pid TERM "$pid"
  local waited=0 deadline=$((NEKO_TEARDOWN_GRACE * 10))
  while [ "$waited" -lt "$deadline" ] && _pid_alive "$pid"; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if _pid_alive "$pid"; then
    log "stale-boot RECLAIM: $label (pid=$pid) ignored SIGTERM for ${NEKO_TEARDOWN_GRACE}s — escalating to SIGKILL"
    _kill_pid KILL "$pid"
  fi
  return 0
}

# _pgid_alive <pgid> [pgid...] — true while ANY of the named process groups
# still has a LIVE member. Zombies do not count.
#
# 🔴 Why not `kill -0 -- -PGID`, which is the obvious implementation: that
#    succeeds for a group whose only remaining members are zombies. Measured
#    consequence — every teardown burned its entire grace period waiting for
#    reaped-but-unwaited Chrome processes to "exit", then logged a false
#    "ignored SIGTERM for 8s" and SIGKILLed processes that had already died.
#    A zombie holds no port, no X connection and no memory, only a pid slot its
#    parent has not collected yet, so for teardown purposes it is gone.
#
#    `read </proc/...` is a builtin: no fork per process, so this stays cheap
#    enough to poll at 10 Hz.
_pgid_alive() {
  local want=" $* " d line rest state pgrp
  [ -n "${1:-}" ] || return 1
  for d in /proc/[0-9]*; do
    line=""
    read -r line <"$d/stat" 2>/dev/null || continue
    rest="${line##*) }"
    state="${rest%% *}"
    [ "$state" = "Z" ] && continue
    pgrp="${rest#* }"
    pgrp="${pgrp#* }"
    pgrp="${pgrp%% *}"
    case "$want" in
      *" $pgrp "*) return 0 ;;
    esac
  done
  return 1
}

# _pgid_member_matching <pgid> <cmdline_substring> — echo the pid of a LIVE
# member of that process group whose /proc cmdline contains the substring, and
# return 0; return 1 if there is none.
#
# Corroborates ownership of a recorded process group when its LEADER is gone.
# Measured: a partially-killed previous boot left code-server's second node
# process — the one actually holding :8443 — alive in the group while the
# wrapper that led the group was dead, so a leader-only cmdline check could not
# attribute the group and the reclaim declined to touch it. The selector is
# still the pgid this script recorded; the cmdline is only a guard against that
# pid number having been recycled.
_pgid_member_matching() {
  local pgid="${1:-}" expect="$2" d line rest state pgrp cmd
  [ -n "$pgid" ] || return 1
  for d in /proc/[0-9]*; do
    line=""
    read -r line <"$d/stat" 2>/dev/null || continue
    rest="${line##*) }"
    state="${rest%% *}"
    [ "$state" = "Z" ] && continue
    pgrp="${rest#* }"
    pgrp="${pgrp#* }"
    pgrp="${pgrp%% *}"
    [ "$pgrp" = "$pgid" ] || continue
    cmd=""
    [ -r "$d/cmdline" ] && cmd="$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null)"
    case "$cmd" in
      *"$expect"*) printf '%s' "${d#/proc/}"; return 0 ;;
    esac
  done
  return 1
}

# _app_pgids — echo the pgid of every application this boot currently has
# running, one per line, read from the supervisors' pgid files. Reading the
# files (rather than a snapshot taken at launch) is what makes this correct
# across restarts: after a crash-and-restart the file holds the NEW pgid.
_app_pgids() {
  local f pgid
  for f in "$NEKO_APP_PGID_DIR"/*.pgid; do
    [ -f "$f" ] || continue
    pgid="$(tr -dc '0-9' <"$f" 2>/dev/null)"
    [ -n "$pgid" ] && printf '%s\n' "$pgid"
  done
  return 0
}

TEARDOWN_DONE=0
# terminate_stack <reason> — stop everything this boot started, for real.
# Idempotent (a second call returns immediately), safe against processes that
# are already gone, and silent when there is nothing to tear down so the
# "neko already serving — nothing to do" early exit stays quiet.
terminate_stack() {
  local reason="$1"
  [ "$TEARDOWN_DONE" -eq 0 ] || return 0
  local pgids
  pgids="$(_app_pgids)"
  if [ -z "$pgids" ] && [ -z "$NEKO_PID" ] && [ "${#APP_PID[@]}" -eq 0 ] \
     && [ "${#SESSION_PID[@]}" -eq 0 ]; then
    return 0
  fi
  TEARDOWN_DONE=1
  log "terminating neko stack: $reason"

  # 1. Stop the restart loops FIRST, before anything is signalled, so no
  #    supervisor can replace an app we are about to kill.
  : >"$NEKO_SHUTDOWN_FLAG" 2>/dev/null || true

  # 2. Graceful SIGTERM to each application's process GROUP — the actual fix:
  #    this is what reaches code-server's second node process (the one holding
  #    the listening socket) and Chrome's dozen children. Also neko, the X
  #    session children and the health/diagnostic loops.
  #
  #    The SUPERVISORS are deliberately left running for now. Each is blocked
  #    in `wait` on its own app, so keeping it alive is what lets it REAP that
  #    app rather than leaving a zombie tree parented to init; the shutdown
  #    flag above is what stops it starting a replacement. They are stopped in
  #    step 5, by which point they have almost always exited on their own.
  local name pgid sp
  _kill_pid TERM "$MONITOR_PID"
  _kill_pid TERM "$CPU_DIAG_PID"
  for pgid in $pgids; do _kill_pgid TERM "$pgid"; done
  _kill_pid TERM "$NEKO_PID"
  for sp in ${SESSION_PID[@]+"${SESSION_PID[@]}"}; do _kill_pid TERM "$sp"; done

  # 3. Bounded grace period. Polls rather than sleeping the full budget, so a
  #    clean stack tears down in milliseconds and only a wedged one waits.
  local waited=0 deadline=$((NEKO_TEARDOWN_GRACE * 10)) remaining
  while [ "$waited" -lt "$deadline" ]; do
    remaining=0
    if [ -n "$pgids" ] && _pgid_alive $pgids; then remaining=1; fi
    if [ -n "$NEKO_PID" ] && _pid_alive "$NEKO_PID"; then remaining=1; fi
    if [ "$remaining" -eq 0 ]; then break; fi
    sleep 0.1
    waited=$((waited + 1))
  done

  # 4. Escalate to SIGKILL on whatever ignored SIGTERM. Logged by pgid so an
  #    app that routinely needs killing is visible in `wrangler tail`.
  for pgid in $pgids; do
    if _pgid_alive "$pgid"; then
      log "teardown: process group $pgid ignored SIGTERM for ${NEKO_TEARDOWN_GRACE}s — escalating to SIGKILL"
      _kill_pgid KILL "$pgid"
    fi
  done

  # 5. Now the supervisors and helper loops themselves.
  for name in "${!APP_PID[@]}"; do _kill_pid TERM "${APP_PID[$name]}"; done
  for name in "${!APP_PID[@]}"; do _kill_pid KILL "${APP_PID[$name]}"; done
  _kill_pid KILL "$MONITOR_PID"
  _kill_pid KILL "$CPU_DIAG_PID"
  _kill_pid KILL "$NEKO_PID"
  for sp in ${SESSION_PID[@]+"${SESSION_PID[@]}"}; do _kill_pid KILL "$sp"; done

  # 6. Reap neko so its exit status is collected rather than left zombied.
  if [ -n "$NEKO_PID" ]; then wait "$NEKO_PID" 2>/dev/null || true; fi

  # 7. Drop the ownership records — these processes are provably gone, and a
  #    stale file would make the next boot chase a recycled pid.
  rm -f "$NEKO_APP_PGID_DIR"/*.pgid "$NEKO_APP_PGID_DIR"/*.sup 2>/dev/null || true
  log "teardown complete: apps, neko and the X session are stopped"
}

# Teardown must run on EVERY exit, not just the fatal-app path that used to be
# its only caller. Before this, a SIGTERM from the container runtime (the most
# likely teardown in production) and every fail-closed `exit 1` in this script
# left the whole desktop running headless behind them.
#
# Bash resets trapped signals to their default disposition inside `( … ) &`
# subshells (verified in this image), so the supervisors and monitor loops do
# NOT inherit these handlers and cannot recursively tear the stack down.
# The EXIT handler does not call `exit`, so it never overwrites the exit status
# the script was already exiting with.
trap 'terminate_stack "received SIGTERM"; exit 143' TERM
trap 'terminate_stack "received SIGINT"; exit 130' INT
trap 'terminate_stack "received SIGHUP"; exit 129' HUP
trap 'terminate_stack "script exiting"' EXIT

# wait_tcp <host> <port> <tries> — poll a TCP port, 0.5s between attempts.
#
# NOTE the brace group around the fd-closing `exec` below. An `exec` with NO
# command applies its redirections to the CURRENT SHELL, PERMANENTLY. The
# previous form here was:
#
#     exec 3>&- 3<&- 2>/dev/null || true
#
# so the FIRST successful wait_tcp call in the main shell silently redirected
# this script's own stderr to /dev/null for the rest of the boot. Observed, not
# theorised: after `neko_serve_bind`, "neko is serving on <port>" appeared in
# $LOG (written by log()'s `tee`) but never on stderr — and with it went
# `phase=ready event=end`, the FATAL mandatory-app message, terminate_stack,
# and `neko exited rc=`. `wrangler tail` is the ONLY window into a live boot
# (see this file's header), and it went dark at exactly the moment something
# could start going wrong. The brace group scopes `2>/dev/null` to the group.
#
# Note also that this timeout is POLL-COUNT bounded, not wall-clock bounded:
# <tries> attempts each followed by a fixed sleep. CPU starvation stretches the
# wall time but never reduces the number of attempts, so a busy box makes this
# MORE forgiving, not less. The same is true of wait_for_window below.
wait_tcp() {
  local host="$1" port="$2" tries="$3" ok=1
  for _ in $(seq 1 "$tries"); do
    if (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
      { exec 3>&- 3<&-; } 2>/dev/null || true
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
# any, has already resolved/relocated it) and BEFORE code-server opens the
# workspace further down and before launch_devserver() runs its dependency
# install at the very end of boot — so neither ever sees node_modules/.next
# resolve onto the FUSE mount.
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

# ── Dev server (Option D app preview) — DEFINED here, INVOKED after neko binds ─
# Launches the user's dev server on the app-preview port (APP_PREVIEW_PORT /
# desktop-mode.ts, default 3002 — never 3000, which the @cloudflare/sandbox
# SDK reserves for its own control plane). This closes the gap
# src/preview-bridge.ts's module doc has flagged since Option D landed: the
# token-gated /preview, /preview-ws, and /preview-status routes have always
# proxied/probed the app-preview port, but nothing in this container image
# ever started a process listening there.
#
# 🔴 THE CALL SITE IS DELIBERATELY AT THE VERY END OF BOOT, AFTER `neko serve`
# HAS BOUND ITS PORT. Do not move it back up here.
#
# It used to be invoked right here — after workspace hydration, before
# Xvfb/openbox/code-server/Chrome and before the fail-closed window-ready gate
# — under the claim that "a slow or crashing dev server therefore never
# prevents the desktop from becoming ready". That claim was only ever TRUE BY
# ACCIDENT: at the time it was written, start-devserver.sh had an unparseable
# `bash -c` block (see 036cb21), so the launch failed instantly and consumed
# nothing at all. The moment the script was repaired and the dev server
# genuinely started running — `bun install` on a Next project, on a 2-vCPU
# container, concurrent with the whole rest of boot — the desktop stopped
# coming up in production, and the only thing that had changed between the
# last-good and first-bad container image was this one script becoming
# runnable.
#
# The invariant is not "the launch call returns quickly" (it does) — it is
# "nothing the dev server does can affect whether the desktop boots". Placement
# is the only thing that actually guarantees that, and it is free: the launch
# is asynchronous and NOTHING in the boot path waits on it. Everything upstream
# of `neko serve` — the X display, the window manager, code-server, Chrome, and
# the fail-closed window-ready gate that exits 1 when a mandatory app is not
# ready — now runs on a container where the dev server does not yet exist. A
# dev server that saturates both vCPUs, exhausts memory, fills the disk, hangs
# forever, or crashes on boot cannot reach any of them, because it has not been
# started yet. The app preview is explicitly optional; the desktop is not.
#
# Its real state is written to /tmp/devserver.phase (crashed/timeout/running/…)
# for the Worker's /preview-status probe to report truthfully instead of
# silently proxying to nothing, which was the whole prior bug. The cost of the
# move is the few seconds of dependency-install head start the preview used to
# get during boot; the preview reports `installing_deps` for that much longer
# and nothing else changes.
DEVSERVER_BIN="${DEVSERVER_BIN:-/usr/local/bin/start-devserver.sh}"
launch_devserver() {
  phase_start devserver_launch
  if [ ! -x "$DEVSERVER_BIN" ]; then
    log "warning: $DEVSERVER_BIN not found — dev server will not be started (app preview will report port_not_listening)"
    phase_end devserver_launch skipped
    return 0
  fi
  log "requesting async dev server launch in $WORKSPACE_ROOT on :${EZIL_DEV_SERVER_PORT:-3002}"
  # Run it (and therefore its whole descendant tree — the package-manager
  # install and the dev server itself) at a lower scheduling priority, so that
  # the app preview can never out-prioritise the desktop the user is actually
  # looking at; in particular neko's software vp8 encoder, the one thing on
  # this box with a hard real-time budget. Raising niceness never requires
  # privileges. This is a belt-and-braces measure for POST-boot contention
  # only — the boot-time guarantee comes from WHERE this function is called,
  # not from this. `nice` is coreutils and always present; the branch exists
  # so a stripped image degrades to the un-niced call rather than to no dev
  # server at all.
  #
  # 🔴 Backgrounded and `wait`ed rather than run in the foreground. Bash defers
  #    a trapped signal until the current FOREGROUND command finishes, and the
  #    launcher is the one long thing on this path — this file's own
  #    dev-server-isolation test simulates it as never returning, and the
  #    bounded real version is a cold `bun install`, which is minutes. In the
  #    foreground form, a container SIGTERM arriving in that window was simply
  #    ignored: the teardown handler never ran and the whole desktop was still
  #    running when the runtime escalated to SIGKILL. `wait` IS interruptible by
  #    a trap, so the handler runs immediately. The exit status is preserved.
  local launch_rc=0
  if command -v nice >/dev/null 2>&1; then
    nice -n 10 "$DEVSERVER_BIN" "$WORKSPACE_ROOT" &
  else
    "$DEVSERVER_BIN" "$WORKSPACE_ROOT" &
  fi
  local launch_pid=$!
  # Tracked so teardown stops the launcher too if it is still going.
  SESSION_PID+=("$launch_pid")
  wait "$launch_pid" || launch_rc=$?
  if [ "$launch_rc" -eq 0 ]; then
    phase_end devserver_launch ok
  else
    log "warning: dev server launch request failed rc=$launch_rc (non-fatal — see /tmp/devserver.log)"
    phase_end devserver_launch error
  fi
  return 0
}

# ── X display ────────────────────────────────────────────────────────────────
# Neko's desktop manager connects to $DISPLAY at startup and panics if it is
# unavailable, so the X server MUST be up before `neko serve` launches. Keyed
# off the X display itself so a re-run reuses an already-running Xvfb.
#
# ── Framebuffer vs. screen: two different things that used to be one variable ─
# `NEKO_SCREEN` was passed straight to `Xvfb -screen 0 <WxHxD>`, which sets the
# framebuffer allocation AND the initial root-window size in one go. That
# conflation is what pinned the desktop to one shape for the life of the
# container, and it is the actual defect behind "the streamed desktop is
# letterboxed into a strip on a phone".
#
# Measured behaviour of Xvfb's RANDR (docs/NEKO-GROUND-TRUTH.md §e, taken from a
# real container, NOT theorised):
#   * `POST /api/room/screen {"width":1280,"height":720,"rate":60}` returns 200
#     and REALLY resizes the X root — `xdpyinfo` follows, and the maximized
#     Chrome window re-lays-out with it. Xvfb's RANDR is not a stub.
#   * A size LARGER than the boot-time `-screen` allocation is refused with
#     HTTP 422 `cannot set screen size`.
#   * `GET /api/room/screen/configurations` advertises exactly ONE entry — the
#     boot-time size, with `"rate":0`. It is NOT the set of sizes that can be
#     applied; do not treat it as one. The requestable set is fixed by §3 of
#     docs/BROWSER-FIX-CONTRACT.md and enforced app-side.
#
# So the framebuffer is a CEILING, not a fixed size: every mode that fits inside
# it is reachable at runtime. Splitting the two concepts is therefore the whole
# fix, and it costs one Xvfb argument:
#
#   EZIL_X_FRAMEBUFFER — the ceiling. Must be the bounding box of every mode we
#                        ever want to be selectable. Contract §3's twelve modes
#                        are at most 1920 wide (1920x1080) and at most 1920 tall
#                        (1080x1920), so the bounding box is 1920x1920x24. Note
#                        this is a bounding box, not a mode: nothing ever
#                        displays at 1920x1920.
#   NEKO_SCREEN        — the INITIAL screen size, i.e. what the user first sees.
#                        Unchanged in meaning and still per-session injectable
#                        (contract §4.1: W2 writes it into the container boot
#                        env from the shell's measured window). It is applied by
#                        neko via `--desktop.screen` further down, because Xvfb
#                        cannot be told a screen size distinct from its
#                        framebuffer and this image has no `xrandr`.
#
# The framebuffer is clamped UP to contain NEKO_SCREEN in both axes. Without
# that clamp an operator (or a future W2 bug) setting NEKO_SCREEN larger than
# the framebuffer produces a boot where neko's initial `XRRSetScreenConfig`
# silently fails and the desktop is left at the framebuffer size — a failure
# mode nothing in this script currently detects.
#
# Both values are `WxHxD`. Depth is taken from NEKO_SCREEN, because depth is a
# property of the visual the user actually gets and RANDR cannot change it;
# contract §3 fixes it at 24 regardless.
_screen_spec="$NEKO_SCREEN"
NEKO_SCREEN_W=""; NEKO_SCREEN_H=""; NEKO_SCREEN_D=""
if [[ "$_screen_spec" =~ ^([0-9]+)x([0-9]+)x([0-9]+)$ ]]; then
  NEKO_SCREEN_W="${BASH_REMATCH[1]}"
  NEKO_SCREEN_H="${BASH_REMATCH[2]}"
  NEKO_SCREEN_D="${BASH_REMATCH[3]}"
fi
if [ -z "$NEKO_SCREEN_W" ] || [ "$NEKO_SCREEN_W" -eq 0 ] || [ "$NEKO_SCREEN_H" -eq 0 ]; then
  # Contract §3: "1920x1080 stays the default and the fallback. If a mode
  # request fails for any reason, the desktop must end up at 1920x1080, never
  # at nothing." A malformed NEKO_SCREEN is exactly such a failure.
  log "warning: NEKO_SCREEN='${_screen_spec}' is not a WxHxD spec — falling back to 1920x1080x24"
  NEKO_SCREEN_W=1920; NEKO_SCREEN_H=1080; NEKO_SCREEN_D=24
  NEKO_SCREEN="1920x1080x24"
fi

EZIL_X_FRAMEBUFFER="${EZIL_X_FRAMEBUFFER:-1920x1920x24}"
_fb_w=""; _fb_h=""
if [[ "$EZIL_X_FRAMEBUFFER" =~ ^([0-9]+)x([0-9]+)(x[0-9]+)?$ ]]; then
  _fb_w="${BASH_REMATCH[1]}"
  _fb_h="${BASH_REMATCH[2]}"
fi
if [ -z "$_fb_w" ] || [ "$_fb_w" -eq 0 ] || [ "$_fb_h" -eq 0 ]; then
  log "warning: EZIL_X_FRAMEBUFFER='${EZIL_X_FRAMEBUFFER}' is not a WxH[xD] spec — falling back to 1920x1920"
  _fb_w=1920; _fb_h=1920
fi
# Clamp up so the framebuffer always contains the initial screen in both axes.
if [ "$NEKO_SCREEN_W" -gt "$_fb_w" ] || [ "$NEKO_SCREEN_H" -gt "$_fb_h" ]; then
  log "warning: NEKO_SCREEN ${NEKO_SCREEN_W}x${NEKO_SCREEN_H} does not fit framebuffer ${_fb_w}x${_fb_h} — growing the framebuffer to contain it"
  [ "$NEKO_SCREEN_W" -gt "$_fb_w" ] && _fb_w="$NEKO_SCREEN_W"
  [ "$NEKO_SCREEN_H" -gt "$_fb_h" ] && _fb_h="$NEKO_SCREEN_H"
fi
EZIL_X_FRAMEBUFFER="${_fb_w}x${_fb_h}x${NEKO_SCREEN_D}"
# 🔴 Xvfb's RANDR floors the screen WIDTH to a multiple of 8. Height is not
#    quantised. Measured in a real container by asking for sizes either side of
#    the boundary and reading back what was actually applied:
#      request 900x1600 -> applied 896x1600      request 1080x1918 -> applied 1080x1918
#      request 898x1600 -> applied 896x1600      request  902x902  -> applied  896x902
#      request 904x1600 -> applied 904x1600      request 1082x1920 -> applied 1080x1920
#    Worse, `POST /api/room/screen` echoes back the size that was REQUESTED,
#    not the one that was applied — only `GET /api/room/screen` tells the truth.
#    So a non-multiple-of-8 width fails SILENTLY at every layer above this one.
#    Eleven of contract §3's twelve modes are already 8-aligned; `900x1600` is
#    not, and is unreachable. This warns rather than snapping, because snapping
#    here would hide a contract problem that belongs in §3.
if [ $(( NEKO_SCREEN_W % 8 )) -ne 0 ]; then
  log "warning: NEKO_SCREEN width ${NEKO_SCREEN_W} is not a multiple of 8 — Xvfb's RANDR will floor it to $(( NEKO_SCREEN_W / 8 * 8 )); the desktop will NOT be ${NEKO_SCREEN_W} wide"
fi
# Exported so validators and the neko-serve section below read exactly the
# values Xvfb was actually started with, rather than re-deriving them.
export NEKO_SCREEN EZIL_X_FRAMEBUFFER NEKO_SCREEN_W NEKO_SCREEN_H NEKO_SCREEN_D

phase_start xvfb
if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  log "X display $DISPLAY already active — reusing"
else
  # 🔴 Stale X lock. The display is NOT answering (the probe above just failed),
  #    but an X server that was SIGKILLed — a crashed or OOM-killed boot, a host
  #    restart — never gets to remove /tmp/.X<n>-lock, and Xvfb refuses to start
  #    while that file exists. Every subsequent boot then dies right here, 20s
  #    in, with "X display did not become available": the container is wedged
  #    for good by a leftover file. Measured, not theorised.
  #
  #    Ownership is taken from the lock file itself — X writes the server pid
  #    into it — and then checked, exactly like the app reclaim above: only a
  #    process that is still alive AND whose cmdline is an Xvfb is signalled,
  #    so a recycled pid is never touched. If the pid is already gone the file
  #    is simply deleted.
  _x_display_num="${DISPLAY#:}"
  _x_display_num="${_x_display_num%%.*}"
  _x_lock="/tmp/.X${_x_display_num}-lock"
  if [ -f "$_x_lock" ]; then
    _x_pid="$(tr -dc '0-9' <"$_x_lock" 2>/dev/null)"
    if _reclaim_pid "${_x_pid:-}" "Xvfb" "X server on $DISPLAY"; then
      log "reclaimed a wedged X server holding $DISPLAY"
    else
      log "removing stale X lock $_x_lock left by a previous boot (recorded pid ${_x_pid:-unknown} is gone)"
    fi
    rm -f "$_x_lock" "/tmp/.X11-unix/X${_x_display_num}" 2>/dev/null || true
  fi
  # -screen takes the FRAMEBUFFER, not the screen the user sees. Xvfb comes up
  # at the framebuffer size; `neko serve` immediately applies NEKO_SCREEN via
  # `--desktop.screen` (see the neko-serve section below), and every later
  # `POST /api/room/screen` can reach any size inside this box.
  log "starting Xvfb on $DISPLAY (framebuffer $EZIL_X_FRAMEBUFFER; initial screen $NEKO_SCREEN, applied by neko)"
  Xvfb "$DISPLAY" -screen 0 "$EZIL_X_FRAMEBUFFER" -ac +extension RANDR -nolisten tcp >>"$LOG" 2>&1 &
  # Recorded so teardown stops the X server too. It used to be missed entirely,
  # so a failed boot left $DISPLAY held by an orphaned Xvfb (with an orphaned
  # openbox and browser still drawing into it) for the life of the container.
  SESSION_PID+=("$!")
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
  SESSION_PID+=("$!")
  sleep 1
  phase_end openbox ok
else
  log "openbox not installed — skipping window manager"
  phase_end openbox skipped
fi

# ── Audio capture: disabled at the source (no third-party n.eko sound) ──────
# EZiL OS ships no audible desktop audio: this section used to start
# pulseaudio "best-effort" so neko's WebRTC audio track had a real desktop
# source to capture, and that is exactly what let a stray system sound (or
# the client bundle's own chat notification chime, see below) reach the
# user. This is intentionally the OPPOSITE of that: pulseaudio is not
# started, and NEKO_CAPTURE_AUDIO_DEVICE is pointed at a name that cannot
# resolve to a real source, so the container has no functioning desktop
# audio capture path at all.
#
# 🔴 A plan for this task assumed a `NEKO_CAPTURE_AUDIO_ENABLED=false`
# environment variable would exist and disable audio capture outright. It
# does not exist in this pinned build. Verified directly against the actual
# binary/config baked into this image (never trust a flag name without
# checking it against the real thing — see docs/PLATFORM-NOTES.md's Method
# notes):
#   docker run --rm --entrypoint /bin/sh ezil-neko-vscode:d74052bb-049931d7 \
#     -c "/usr/bin/neko serve --help 2>&1 | grep -i audio"
# lists only capture.audio.codec / capture.audio.device / capture.audio.pipeline
# (env equivalents NEKO_CAPTURE_AUDIO_CODEC / _DEVICE / _PIPELINE) — there is
# no capture.audio.enabled flag, hidden or otherwise (also checked by
# grepping the compiled binary's own strings for every NEKO_CAPTURE_AUDIO*
# and capture.audio.* literal it contains). Unlike video, which is only
# added to a session when NEKO_CAPTURE_VIDEO_IDS names a stream, audio has no
# such id list to empty out.
#
# Also verified directly against a live session on this exact pinned binary
# (a real WebSocket + WebRTC negotiation, not just log-reading) that the
# offer SDP unconditionally contains an `m=audio` section (opus/48000) using
# the SAME `msid:stream` as `m=video` — i.e. one shared MediaStream, exactly
# matching the reason `autoplay` must stay on the app iframe (see
# UIWindow.js). No combination of the three capture.audio.* settings removes
# that `m=audio` line; only patching/recompiling neko itself could, which is
# out of scope here. What setting an unresolvable device DOES guarantee: if
# a peer ever exercises that inert audio track, the per-session GStreamer
# pipeline (`pulsesrc device=... ! ... ! opusenc ...`, built lazily on first
# subscription — confirmed by its absence from this image's own startup log,
# unlike video's two pipelines which ARE syntax-checked at boot) has no
# PulseAudio server to connect to and no real device name even if one were
# running, so it can never carry real desktop sound. This also avoids
# spending any CPU on a live audio encode on this 2-vCPU box, matching the
# free-CPU-lever framing of the video tuning below.
#
# The neko client's own compiled bundle already keeps its <video> element
# muted by default (`muted:!0` in its Vuex store) regardless of this
# setting, so this is defense-in-depth, not the only thing standing between
# a user and real desktop audio.
export NEKO_CAPTURE_AUDIO_DEVICE="${NEKO_CAPTURE_AUDIO_DEVICE:-ezil-audio-capture-disabled}"
log "audio capture: pulseaudio not started, NEKO_CAPTURE_AUDIO_DEVICE unresolvable — no real desktop audio can reach the WebRTC stream"

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
# NOTE: APP_PID itself is declared near the top of this script, alongside
# terminate_stack — see the "Process bookkeeping + teardown" section for why,
# and for why the supervisor pid it holds is NOT what teardown signals.
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

# ── Clean quit vs crash (a user closing the browser must not kill the session) ─
#
# `supervise_app` below used to restart an app on ANY exit and charge EVERY
# exit to the restart budget: `rc` was logged and never looked at. So a user
# who quit the in-stream browser six times got `NEKO_APP_MAX_RESTARTS` (5)
# exhausted, the fatal sentinel raised, and `terminate_stack` — SIGTERM/SIGKILL
# to every app group, neko, the X server, openbox, pulseaudio — followed by
# `exit 1`. The user asked to close a window and lost the whole desktop
# session. (W3 is separately removing that close button; this must not be
# reachable by ordinary use whether or not the button is there.)
#
# ── The rule ────────────────────────────────────────────────────────────────
# An exit is CLEAN — and therefore NOT charged to the restart budget — when
# BOTH hold:
#
#   rc == 0                     the app chose to exit. A crash is a non-zero
#                               status, and a signal death is 128+n, never 0.
#   uptime >= 5s                it had actually been running. "Exited 0
#                               immediately" is not a user quitting: it is
#                               Chrome handing off to an already-running
#                               instance, or a profile it refuses to open,
#                               and letting THAT be free would be an
#                               unbounded hot restart loop.
#
# Everything else — any non-zero status, any signal, and any rc=0 inside the
# first 5 seconds — is charged exactly as before, so a genuine crash-loop
# still exhausts the budget and still fails the desktop closed. The budget is
# NOT infinite and NOT larger than it was.
#
# ── What a clean exit costs ─────────────────────────────────────────────────
# A clean exit is free forever, so an app that exits 0 after >=5s of uptime
# restarts indefinitely rather than ever tripping the sentinel. That is the
# intended trade (a browser the user closed must come back, not take the
# session with it), but "indefinitely" needs a floor under it or a
# pathological app could relaunch every ~7s for the life of the container. So
# CONSECUTIVE clean exits back off LINEARLY (2s, 4s, 6s, … capped at 30s),
# and the streak resets the moment an app manages a genuinely healthy run
# (>=60s) — which is every real user-initiated quit, so a user who closes the
# browser gets it back in the same 2s as always.
#
# These three are internal constants, deliberately NOT `${VAR:-…}`-overridable:
# the browser-fix contract §2 fixes the set of environment variables and this
# needs none of them.
NEKO_APP_CLEAN_EXIT_MIN_UPTIME_MS=5000
NEKO_APP_CLEAN_EXIT_HEALTHY_MS=60000
NEKO_APP_CLEAN_RESTART_MAX_DELAY=30

# _app_exit_is_clean <rc> <uptime_ms> — the rule above, and nothing else.
# Returns 0 (true) for a clean, user-initiated quit.
_app_exit_is_clean() {
  local rc="$1" uptime_ms="$2"
  [ "$rc" = "0" ] || return 1
  [ "$uptime_ms" -ge "$NEKO_APP_CLEAN_EXIT_MIN_UPTIME_MS" ] || return 1
  return 0
}

# supervise_app <name> <max_restarts> <cmd...>
# Runs <cmd> in a restart loop inside a background subshell. On exit it logs
# only the app name + exit code (never argv/urls), waits with a short backoff,
# and retries up to <max_restarts> times before settling into a terminal
# "crashed" state — which is reported via health/log output but never triggers
# a Guacamole/other-mode fallback (fail-closed-but-isolated).
#
# 🔴 The application is started under `setsid`, which is the whole reason
#    teardown can be trusted. `setsid <cmd> &` puts <cmd> — and therefore every
#    process it goes on to fork — into a brand-new process group whose id
#    equals the pid bash reports in `$!` (verified in this image: pid == pgid ==
#    sid). Without it, <cmd> would sit in THIS SCRIPT's process group along
#    with the script itself, so the only handle teardown could ever have on it
#    would be the supervisor pid below — which is a bash loop, not the app, and
#    killing it merely reparents the real app to init. That is the exact defect
#    that used to wedge containers; see the teardown section near the top.
#
#    The pgid is published through a FILE rather than a variable because this
#    is a subshell: an assignment here would be invisible to the shell that
#    runs terminate_stack. See _app_pgids / reclaim_stale_app.
supervise_app() {
  local name="$1" max_restarts="$2"
  shift 2
  local attempt=0
  local pgid_file="${NEKO_APP_PGID_DIR}/${name}.pgid"
  local sup_file="${NEKO_APP_PGID_DIR}/${name}.sup"
  APP_STATE[$name]="starting"
  APP_RESTARTS[$name]=0
  rm -f "$pgid_file" "$sup_file" 2>/dev/null || true
  write_health
  local clean_streak=0
  (
    while true; do
      app_started_ms="$(date +%s%3N)"
      setsid "$@" >>"$LOG" 2>&1 &
      app_pgid=$!
      # Written atomically so terminate_stack can never read a half-written
      # number, and rewritten on every restart so the recorded pgid is always
      # the app that is actually running right now.
      printf '%s\n' "$app_pgid" >"${pgid_file}.tmp" 2>/dev/null \
        && mv "${pgid_file}.tmp" "$pgid_file" 2>/dev/null
      wait "$app_pgid"
      local rc=$?
      # Captured AFTER rc, never before: anything between `wait` and reading
      # `$?` destroys the status this whole classification rests on.
      local uptime_ms=$(( $(date +%s%3N) - app_started_ms ))
      # Teardown in progress: do not start a replacement that would outlive it.
      if [ -f "$NEKO_SHUTDOWN_FLAG" ]; then
        log "app=$name exited rc=$rc during teardown — not restarting"
        break
      fi
      # 🔴 The user-initiated quit. Restarted like any other exit — the desktop
      # still needs its browser — but NOT charged to the restart budget, so no
      # number of them can ever raise the fatal sentinel and take the session
      # down. See `_app_exit_is_clean` above for the rule and its cost.
      if _app_exit_is_clean "$rc" "$uptime_ms"; then
        if [ "$uptime_ms" -ge "$NEKO_APP_CLEAN_EXIT_HEALTHY_MS" ]; then
          clean_streak=1
        else
          clean_streak=$((clean_streak + 1))
        fi
        # Integer maths only. `NEKO_APP_RESTART_DELAY` is a `sleep` argument
        # and may legitimately be fractional ("0.5"), which bash arithmetic
        # cannot multiply — and under `set -u` a failed arithmetic assignment
        # would leave `clean_delay` unset and kill this supervisor outright.
        # A non-integer delay simply gets no backoff.
        local clean_delay="$NEKO_APP_RESTART_DELAY"
        case "$NEKO_APP_RESTART_DELAY" in
          ''|*[!0-9]*) : ;;
          *)
            clean_delay=$((NEKO_APP_RESTART_DELAY * clean_streak))
            [ "$clean_delay" -gt "$NEKO_APP_CLEAN_RESTART_MAX_DELAY" ] \
              && clean_delay="$NEKO_APP_CLEAN_RESTART_MAX_DELAY"
            ;;
        esac
        log "app=$name exited rc=$rc after ${uptime_ms}ms — CLEAN exit (user-initiated quit): restarting in ${clean_delay}s, NOT charged to the restart budget (still $attempt/$max_restarts used, clean_streak=$clean_streak)"
        emit_telemetry "container:neko#app_exit" "ok" "$uptime_ms"
        sleep "$clean_delay"
        continue
      fi
      log "app=$name exited rc=$rc after ${uptime_ms}ms — CRASH (non-zero status, or exited 0 inside the first ${NEKO_APP_CLEAN_EXIT_MIN_UPTIME_MS}ms): charged to the restart budget (attempt $((attempt + 1))/$((max_restarts + 1)))"
      emit_telemetry "container:neko#app_exit" "error" "$uptime_ms"
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
    # Nothing of this app is running any more, so the ownership records must go
    # with it — otherwise the next boot would find files for processes that no
    # longer exist and could chase recycled pids.
    rm -f "$pgid_file" "$sup_file" 2>/dev/null || true
  ) &
  APP_PID[$name]=$!
  # Ownership record for the SUPERVISOR, alongside the app pgid the subshell
  # publishes. Both are needed, and finding that out cost a container:
  # a boot following a SIGKILLed boot correctly reclaimed the stale Chrome —
  # and the stale boot's still-running supervisor, orphaned but very much
  # alive, immediately restarted it, burned through its restart budget and
  # raised the fatal sentinel that the NEW boot was watching, killing a desktop
  # that had already reported ready. Killing a stale app without killing the
  # loop that restarts it is not a reclaim.
  printf '%s\n' "${APP_PID[$name]}" >"${sup_file}.tmp" 2>/dev/null \
    && mv "${sup_file}.tmp" "$sup_file" 2>/dev/null
  APP_STATE[$name]="running"
  write_health
}

# reclaim_stale_app <name> <cmdline_substring>
# Defence for the OTHER way an orphan can appear: not an unclean teardown by
# this script (the section at the top makes those impossible), but a boot that
# never got to run a teardown at all — a SIGKILL, an OOM kill, or a host-side
# container restart that leaves the previous boot's processes alive in the same
# container. Their listening socket and X windows would otherwise satisfy this
# boot's readiness gate while the new processes fail to bind behind it.
#
# 🔴 Ownership is proved before anything is signalled, and it is never proved
#    by name: (1) the pid/pgid must come from a file THIS SCRIPT wrote during a
#    previous boot of this same container, and (2) the process it names must
#    still have a /proc cmdline that matches what this script launches — the
#    caller-supplied substring for the app, `start-neko.sh` for the supervisor.
#    A pid number that has since been recycled by an unrelated process is left
#    strictly alone. No `pkill`, no pattern match over the process table.
#
#    The SUPERVISOR is reclaimed FIRST and the app second, because the reverse
#    order does not work: the supervisor exists precisely to restart the app.

reclaim_stale_app() {
  local name="$1" expect="$2"
  local pgid_file="${NEKO_APP_PGID_DIR}/${name}.pgid"
  local sup_file="${NEKO_APP_PGID_DIR}/${name}.sup"
  local sup="" pgid=""

  # 1. The restart loop, before the thing it restarts.
  [ -f "$sup_file" ] && sup="$(tr -dc '0-9' <"$sup_file" 2>/dev/null)"
  _reclaim_pid "$sup" "start-neko.sh" "supervisor for app=$name" || true
  rm -f "$sup_file" 2>/dev/null || true

  # 2. The application and every process it forked, as one group.
  [ -f "$pgid_file" ] && pgid="$(tr -dc '0-9' <"$pgid_file" 2>/dev/null)"
  rm -f "$pgid_file" 2>/dev/null || true
  if [ -z "$pgid" ] || ! _pgid_alive "$pgid"; then
    return 0
  fi
  local owner=""
  if ! owner="$(_pgid_member_matching "$pgid" "$expect")"; then
    log "stale-boot check: process group $pgid recorded for app=$name holds no live $name process (pid recycled, or only unrelated processes remain) — leaving it alone"
    return 0
  fi
  log "stale-boot RECLAIM: app=$name from a previous boot is still alive (pgid=$pgid, e.g. pid=$owner) — stopping it and every process it forked"
  _kill_pgid TERM "$pgid"
  local waited=0 deadline=$((NEKO_TEARDOWN_GRACE * 10))
  while [ "$waited" -lt "$deadline" ] && _pgid_alive "$pgid"; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if _pgid_alive "$pgid"; then
    log "stale-boot RECLAIM: app=$name (pgid=$pgid) ignored SIGTERM for ${NEKO_TEARDOWN_GRACE}s — escalating to SIGKILL"
    _kill_pgid KILL "$pgid"
  fi
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
      elif _pid_alive "${APP_PID[$name]}"; then
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

# ── Stale-boot reclaim + port preflight (fail FAST, not 60s later) ───────────
# Everything below this point assumes this boot can actually own 8443 and the
# X display. If a previous boot in this same container was SIGKILLed, OOM-ed,
# or otherwise died without running terminate_stack, its code-server and Chrome
# are still here — and a live orphan is not merely in the way, it is actively
# MISLEADING: it answers the readiness probe on 8443 and supplies the WM_CLASS
# the window gate looks for, so the gate passes in milliseconds while the new
# code-server behind it fails to bind and, ~15s later, exhausts its restart
# budget and takes the desktop down after it has already reported ready.
# (Measured, in a container, before this block existed.)
#
# So: reclaim anything this container can PROVE it owns, then verify the port
# really is free and fail immediately with a message that names the port if it
# is not — rather than letting the gate time out 60 seconds later with a
# generic "codeserver did not become ready".
#
# The two variables are set here rather than at their old sites purely so this
# check can run BEFORE anything is launched — in particular before the
# `rm -rf "$CHROME_PROFILE_DIR"` below, which would otherwise delete the
# profile directory out from under a still-running orphaned Chrome.
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-/tmp/chromium-app-data}"
# The mandatory-app set (consumed by the window-ready gate further down — see
# EZIL_DESKTOP_APPS there for the full format). Defined here so this preflight
# and that gate can never disagree about which ports this boot must own.
EZIL_DESKTOP_APPS="${EZIL_DESKTOP_APPS:-browser:window:chrome codeserver:tcp:127.0.0.1:${CODE_SERVER_PORT}}"

phase_start stale_boot_reclaim
# The second argument is the cmdline fragment that corroborates a recorded
# process group really is still this app. It must appear in EVERY member of the
# tree, not just the process this script launched: code-server forks a second
# node process that carries none of the launch flags but is the one holding the
# port, and it can outlive the wrapper.
reclaim_stale_app codeserver "/code-server"
reclaim_stale_app chromium "--user-data-dir=${CHROME_PROFILE_DIR}"

# Now check every TCP port the readiness gate will require. Two probe attempts
# (wait_tcp sleeps 0.5s between them) so a socket in the middle of closing
# after the reclaim above is not mistaken for a live listener.
stale_port_seen=0
for _spec in $EZIL_DESKTOP_APPS; do
  _rest="${_spec#*:}"
  [ "${_rest%%:*}" = "tcp" ] || continue
  _target="${_rest#*:}"
  if wait_tcp "${_target%:*}" "${_target##*:}" 2; then
    log "ERROR: ${_target} is ALREADY IN USE before this boot has started anything. A process from an earlier boot of this container still owns it and could not be attributed to this script (no ownership record, or a different process now holds the port). Refusing to start: the readiness gate would be satisfied by that stale listener while the real ${_spec%%:*} failed to bind behind it."
    stale_port_seen=1
  fi
done
if [ "$stale_port_seen" -ne 0 ]; then
  phase_end stale_boot_reclaim error
  exit 1
fi

# Only NOW is it safe to clear the two cross-boot files. Until this point they
# still belong to the previous boot: the shutdown flag was suppressing any of
# its surviving supervisors, and the fatal sentinel may have been appended to
# by one of them on its way out — a stale "chromium" line in there would
# otherwise be read by THIS boot's fatal-failure watch and tear down a healthy
# desktop for a crash that happened in a previous one.
rm -f "$NEKO_SHUTDOWN_FLAG" 2>/dev/null || true
rm -f "$NEKO_APP_FATAL_SENTINEL" 2>/dev/null || true
phase_end stale_boot_reclaim ok

# ── Workspace Trust must be OFF before code-server ever opens the folder ─────
# 🔴 Measured in production on image v8 (2026-08-03), not reasoned about. With
# a folder open — which is exactly what the `folder=` bridge param now produces
# — code-server inherits VS Code's Workspace Trust and boots into RESTRICTED
# MODE. Observed, in that order:
#   * status bar reads `Restricted Mode`, plus a banner across the top of the
#     window: "Restricted Mode is intended for safe code browsing. Trust this
#     folder to enable all features."
#   * pressing Ctrl+` yields `.xterm: 0` and an empty panel reading "Drag a
#     view here to display.", behind a MODAL: "Do you trust the authors of the
#     files in this folder? / Creating a terminal process requires executing
#     code" with [Manage] [Cancel] [Trust Folder & Continue].
#   * clicking "Trust Folder & Continue" clears Restricted Mode but does NOT
#     open the terminal — VS Code cancels the action that triggered the prompt,
#     so a SECOND Ctrl+` is required. Only then does `.xterm: 1` /
#     `TERMINAL bash` / a real `root@…:/workspace` prompt appear.
# That is the whole of what "the VS Code server is not working" looks like from
# the outside: the editor renders, the file tree is full, files open — and the
# terminal is a dead panel guarded by a security dialog about the user's own
# files.
#
# It cannot self-heal. The trust grant is stored under --user-data-dir, which
# is /tmp/code-server-data — recreated on every container start. So this is not
# a one-time click, it is every session, forever.
#
# Restricted Mode is also not a security boundary *here*. start-devserver.sh
# already `exec`s the workspace's own dev script at boot (see its tail), so the
# project's code is running unconditionally in this container before the editor
# is ever opened. Refusing to spawn a shell because doing so "requires
# executing code" is incoherent with what the container already does, and the
# container is single-tenant and disposable.
#
# 🔴 Written as a SETTING, deliberately NOT the `--disable-workspace-trust` CLI
# flag. An unrecognised setting is ignored by VS Code; an unrecognised CLI
# option makes code-server exit non-zero — and code-server is a MANDATORY
# supervised app here, so that would burn the restart budget, trip the fatal
# sentinel and take the whole desktop down. Do not "simplify" this into a flag
# unless you have proven the installed binary parses it.
CODE_SERVER_USER_DATA_DIR="${CODE_SERVER_USER_DATA_DIR:-/tmp/code-server-data}"
CODE_SERVER_EXTENSIONS_DIR="${CODE_SERVER_EXTENSIONS_DIR:-/tmp/code-server-extensions}"

# Never clobbers an existing file: within a single container life the user may
# have changed settings through the UI, and this runs before every launch.
seed_codeserver_user_settings() {
  _cs_user_dir="$1/User"
  _cs_settings="$_cs_user_dir/settings.json"
  if [ -s "$_cs_settings" ]; then
    return 0
  fi
  mkdir -p "$_cs_user_dir" 2>/dev/null || return 1
  cat >"$_cs_settings" <<'CODESERVER_SETTINGS_JSON'
{
  "security.workspace.trust.enabled": false
}
CODESERVER_SETTINGS_JSON
}

if seed_codeserver_user_settings "$CODE_SERVER_USER_DATA_DIR"; then
  log "code-server user settings seeded at ${CODE_SERVER_USER_DATA_DIR}/User/settings.json (workspace trust disabled — no Restricted Mode, terminal works on the first Ctrl+backtick)"
else
  log "WARNING: could not seed ${CODE_SERVER_USER_DATA_DIR}/User/settings.json — code-server will open in Restricted Mode and its integrated terminal will prompt for workspace trust before it will start"
fi

phase_start codeserver_launch
log "supervising code-server ($CODE_SERVER_BIN) on 0.0.0.0:${CODE_SERVER_PORT} at $WORKSPACE_ROOT (mandatory, isolated user-data-dir)"
supervise_app codeserver "$NEKO_APP_MAX_RESTARTS" "$CODE_SERVER_BIN" \
  --bind-addr "0.0.0.0:${CODE_SERVER_PORT}" \
  --auth none \
  --disable-telemetry \
  --user-data-dir="$CODE_SERVER_USER_DATA_DIR" \
  --extensions-dir="$CODE_SERVER_EXTENSIONS_DIR" \
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
# CHROME_PROFILE_DIR is resolved in the stale-boot reclaim above (it has to be,
# because that block needs it before this `rm -rf` runs — deleting the profile
# of a still-live orphaned Chrome is how you turn a recoverable stale boot into
# a corrupted one).
rm -rf "$CHROME_PROFILE_DIR" 2>/dev/null || true
mkdir -p "$CHROME_PROFILE_DIR" 2>/dev/null || true

# ── The browser must NOT draw its own window frame ───────────────────────────
# 🔴 MEASURED in a real container (docs/NEKO-GROUND-TRUTH.md §a–§d, §g), not
# reasoned about. The bar the user sees inside the stream — with minimize /
# restore / close buttons at the top right — is NOT an openbox titlebar.
# Openbox is already doing exactly what ebuilder-openbox.xml tells it:
#   _NET_FRAME_EXTENTS = 0, 0, 0, 0
#   _NET_WM_STATE contains _OB_WM_STATE_UNDECORATED
#   the openbox frame window is pixel-identical to its client (1920x1080+0+0)
#   and all 55 of its decoration widgets are collapsed to 1x1
# The class it matches on is literally `Google-chrome` and the match is
# confirmed by openbox's own `_OB_APP_CLASS`. There is no WM decoration left
# to remove, so DO NOT "fix" this by widening the openbox selector.
#
# ⚠️ AND THE OPPOSITE WARNING, WHICH THIS CHANGE CREATES. Before this change
# the openbox <decor>no</decor> rule was REDUNDANT: Chrome's own
# MWM_DECOR_NONE hint was already suppressing WM decoration, so pointing
# openbox at a bogus class changed nothing (measured). After this change the
# rule is LOAD-BEARING — Chrome now asks to be decorated, and openbox refusing
# is the only reason there is no titlebar. Measured with the pref set and the
# openbox rule deliberately mis-targeted: the window came back fully decorated,
# `_NET_FRAME_EXTENTS = 1, 1, 20, 5`. So weakening, mistyping or re-scoping
# that rule is now WORSE than doing nothing at all. `verify_browser_frame`
# below checks `_NET_FRAME_EXTENTS` precisely to catch that regression.
#
# What draws the bar is Chrome's own tabstrip-integrated frame. On Linux,
# Chrome's default is to draw that frame itself and to ask the WM not to
# decorate it (`_MOTIF_WM_HINTS = 0x2, 0x0, 0x0, 0x0, 0x0` — flags =
# MWM_HINTS_DECORATIONS, decorations = none). `browser.custom_chrome_frame` is
# where Chrome persists the "Use system title bar and borders" toggle, and it
# is ABSENT from a fresh profile, so nothing has ever told Chrome otherwise.
#
# Seeding it false makes Chrome ask for a SYSTEM frame instead — and openbox's
# existing <decor>no</decor> then declines to draw one. Net result: tab strip
# and omnibox at pixel row 0, no title bar, no caption buttons. Tabs and the
# address bar are kept deliberately (approved product decision), which is why
# this is NOT done with --kiosk or --app=.
#
# 🔴 The pref is seeded on EVERY boot because the profile directory is
# `rm -rf`'d immediately above. There is nowhere persistent for it to live.
#
# VERIFIED that Chrome honours a hand-seeded file rather than discarding it —
# Chrome 151.0.7922.71, same image, same flags, openbox with the same config:
#   without the seed: _MOTIF_WM_HINTS = 0x2, 0x0, 0x0, 0x0, 0x0  (own frame)
#   with the seed:    _MOTIF_WM_HINTS = 0x2, 0x0, 0x1, 0x0, 0x0  (system frame)
# and the key was still `"custom_chrome_frame":false` in Preferences after
# Chrome exited and rewrote the file — this key is not one of the MAC-protected
# prefs, so it is neither rejected at startup nor scrubbed at shutdown.
# `verify_browser_frame` below re-checks that third field on every boot rather
# than trusting that this write took.
#
# EZIL_BROWSER_DECOR is the kill switch (contract §2): `off` (default) = no
# decorations, i.e. seed the pref; `on` = leave Chrome on its default and get
# its own frame back, exactly as before this change.
EZIL_BROWSER_DECOR="${EZIL_BROWSER_DECOR:-off}"

# Written with plain shell redirection — no jq, no python — because this runs
# before anything has proven those exist, and a failure here must degrade to a
# cosmetic regression, never to a failed boot.
seed_chrome_frame_pref() {
  _cf_default_dir="$1/Default"
  mkdir -p "$_cf_default_dir" 2>/dev/null || return 1
  cat >"$_cf_default_dir/Preferences" <<'CHROME_PREFS_JSON'
{"browser":{"custom_chrome_frame":false}}
CHROME_PREFS_JSON
}

if [ "$EZIL_BROWSER_DECOR" = "on" ]; then
  log "EZIL_BROWSER_DECOR=on — leaving Chrome on its Linux default (it will draw its own frame, with its own minimize/maximize/close buttons, inside the stream)"
elif seed_chrome_frame_pref "$CHROME_PROFILE_DIR"; then
  log "browser frame: seeded browser.custom_chrome_frame=false into ${CHROME_PROFILE_DIR}/Default/Preferences (Chrome asks for a system frame; openbox <decor>no</decor> then draws none — no title bar, no caption buttons, tabs and omnibox kept)"
else
  log "WARNING: could not seed ${CHROME_PROFILE_DIR}/Default/Preferences — Chrome will fall back to its own custom frame and the stream will show a second set of window controls"
fi

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
#
# 🔴 `--test-type` is here for ONE visible reason: it suppresses Chrome's
# "You are using an unsupported command-line flag: --no-sandbox. Stability and
# security will suffer." infobar, which otherwise eats a ~40px strip across the
# top of the window in EVERY session (it is in the ground-truth screenshot).
# `--no-sandbox` itself stays: it is required for Chrome to run in this
# container and is not in scope to remove, so the banner is permanent unless
# something suppresses it. (Why the sandbox cannot be used here was NOT
# re-measured by this change — the flag was left exactly as it was found.)
#
# What it costs, stated plainly rather than waved away. `--test-type` does not
# suppress that one string; it turns off the whole bad-flags warning path, so
# if a future edit adds another security-weakening flag to this launch line, no
# one will be warned on screen. It also suppresses assorted startup error
# dialogs (e.g. the "profile in use" dialog). It does NOT weaken the sandbox
# further than --no-sandbox already has, and — MEASURED on this image, not
# assumed — it does not mark the browser as automated to web pages:
# `navigator.webdriver` is still `false` and the User-Agent is unchanged
# (`…Chrome/151.0.0.0 Safari/537.36`, no HeadlessChrome, no automation token).
# `--noerrdialogs` was tried first as the narrower flag and does NOT suppress
# this infobar — verified by screenshot on the running desktop.
phase_start chrome_launch
log "supervising mandatory native browser ($CHROME_BIN) into $DISPLAY (fresh, isolated user-data-dir — no host profile; home=$CHROME_HOME_URL)"
supervise_app chromium "$NEKO_APP_MAX_RESTARTS" "$CHROME_BIN" \
  --no-sandbox \
  --test-type \
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
# baked in) so it always matches this script's app names. The destination is
# overridable purely so a test harness can run this script without writing into
# the host's /usr/local/bin; production never sets it.
NEKO_SWITCH_APP_BIN="${NEKO_SWITCH_APP_BIN:-/usr/local/bin/neko-switch-app.sh}"
cat >"$NEKO_SWITCH_APP_BIN" <<'SWITCH_EOF'
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
chmod +x "$NEKO_SWITCH_APP_BIN"

# ── Browser-frame read-back (contract §5.3) ─────────────────────────────────
# Defined here, CALLED after the window-ready gate below — the window it reads
# does not exist until that gate has seen it.
#
# This repo has already shipped one decoration rule whose only guard was a test
# that grepped an XML file for a substring. A grep of a config file proves the
# config file; it does not prove the window. So this reads the LIVE window's
# properties out of the running X server after the browser is up, logs the
# LITERAL WM_CLASS on every boot so the match target stops being a guess, and
# emits contract §8 telemetry (`container:neko#decor` / `decor-still-present`)
# when the browser is still wearing a frame.
#
# The two ways a frame can come back, both checked:
#   1. Chrome draws its own — `_MOTIF_WM_HINTS` flags carry MWM_HINTS_DECORATIONS
#      (0x2) with a decorations field of 0, i.e. "WM, don't decorate me, I've
#      got this". That is the state ground truth measured, and the state the
#      seeded pref is meant to flip to 0x1.
#   2. Openbox draws one — a non-zero TOP value in `_NET_FRAME_EXTENTS`
#      (left, right, top, bottom). Ground truth measured 0,0,0,0. This is the
#      newly-possible failure: seeding the pref makes the openbox rule
#      load-bearing (see the long note at the seed site), and a broken rule
#      now yields a real WM titlebar — measured as 1, 1, 20, 5.
#
# Check 1 is deliberately the SAME property `validate-neko-browser-window.sh`
# asserts as `browser.chrome_frame.no_caption_buttons` — the decorations field
# of `_MOTIF_WM_HINTS`. Two checks agreeing on one property is the point; do
# not re-derive "is it decorated" some third way here.
#
# This never fails the boot and never blocks it: a browser with an extra bar is
# a cosmetic defect, and refusing to serve a desktop over one would be worse
# than the defect. Every probe degrades to a log line.
emit_decor_violation() {
  printf '{"eventClass":"contract_violation","source":"container","site":"container:neko#decor","code":"decor-still-present","outcome":"error","durationMs":0}\n' \
    >>"$TELEMETRY_NDJSON" 2>/dev/null || true
}

verify_browser_frame() {
  local wm_line="" wid="" class_field="" motif="" vals="" flags="" decorations=""
  local extents="" top_extent="" pref="" own_frame=0 wm_frame=0

  if ! command -v wmctrl >/dev/null 2>&1; then
    log "browser frame check COULD-NOT-DETERMINE: wmctrl not available"
    return 0
  fi
  wm_line="$(wmctrl -x -l 2>/dev/null | awk 'tolower($3) ~ /chrome/ {print; exit}')"
  if [ -z "$wm_line" ]; then
    log "browser frame check COULD-NOT-DETERMINE: no window with a chrome WM_CLASS is listed by wmctrl"
    return 0
  fi
  wid="$(printf '%s' "$wm_line" | awk '{print $1}')"
  # The whole matched line, verbatim. NOT just awk's $3: the WM_CLASS instance
  # Chrome publishes contains a space ("google-chrome (/tmp/chromium-app-data)"),
  # so field 3 alone silently truncates the very string this line exists to
  # record. The authoritative WM_CLASS is read off the window with xprop below.
  log "browser window id=${wid} wmctrl line: ${wm_line}"

  pref="$(grep -o '"custom_chrome_frame":[a-z]*' "${CHROME_PROFILE_DIR}/Default/Preferences" 2>/dev/null | head -n 1)"
  log "browser frame pref now in profile: ${pref:-ABSENT} (EZIL_BROWSER_DECOR=${EZIL_BROWSER_DECOR})"

  if ! command -v xprop >/dev/null 2>&1; then
    log "browser frame check COULD-NOT-DETERMINE: xprop not available — cannot read _MOTIF_WM_HINTS/_NET_FRAME_EXTENTS off window ${wid}"
    return 0
  fi
  if ! motif="$(xprop -id "$wid" _MOTIF_WM_HINTS 2>/dev/null)"; then
    log "browser frame check COULD-NOT-DETERMINE: xprop could not read window ${wid} (no X connection, or the window went away). Not reporting a violation for a property that was never read."
    return 0
  fi
  extents="$(xprop -id "$wid" _NET_FRAME_EXTENTS 2>/dev/null || true)"
  # The literal WM_CLASS, every boot, straight off the window — this is the
  # exact string `ebuilder-openbox.xml`'s class="Google-chrome" rule is matched
  # against, and the one thing nobody should ever again have to guess at.
  class_field="$(xprop -id "$wid" WM_CLASS 2>/dev/null | tr '\n' ' ' || true)"
  log "browser ${class_field:-WM_CLASS unreadable}"
  log "browser frame props: $(printf '%s %s' "$motif" "$extents" | tr '\n' ' ')"

  # _MOTIF_WM_HINTS = flags, functions, decorations, input_mode, status
  case "$motif" in
    *=*)
      vals="${motif#*= }"
      flags="$(printf '%s' "$vals" | cut -d, -f1 | tr -d ' ')"
      decorations="$(printf '%s' "$vals" | cut -d, -f3 | tr -d ' ')"
      ;;
  esac
  if [[ "$flags" =~ ^(0[xX])?[0-9a-fA-F]+$ ]] && [[ "$decorations" =~ ^(0[xX])?[0-9a-fA-F]+$ ]]; then
    if [ "$(( flags & 2 ))" -ne 0 ] && [ "$(( decorations ))" -eq 0 ]; then
      own_frame=1
    fi
  else
    log "browser frame: _MOTIF_WM_HINTS is not set on ${wid} — Chrome is not claiming its own frame; the window manager decides, and ebuilder-openbox.xml says <decor>no</decor>"
  fi

  # _NET_FRAME_EXTENTS = left, right, top, bottom — a titlebar is a non-zero top.
  case "$extents" in
    *=*)
      top_extent="$(printf '%s' "${extents#*= }" | cut -d, -f3 | tr -d ' ')"
      ;;
  esac
  if [[ "$top_extent" =~ ^[0-9]+$ ]] && [ "$top_extent" -gt 0 ]; then
    wm_frame=1
  fi

  if [ "$own_frame" -eq 1 ] || [ "$wm_frame" -eq 1 ]; then
    log "ERROR: the in-stream browser window ${wid} is STILL framed after enforcement (chrome_own_frame=${own_frame} wm_titlebar_top_px=${top_extent:-0}). The user will see a second set of window controls inside the stream."
    emit_decor_violation
  else
    log "browser frame verified undecorated: chrome is using the system frame (_MOTIF_WM_HINTS decorations=${decorations:-unset}) and openbox draws none (_NET_FRAME_EXTENTS top=${top_extent:-0}) — tab strip and omnibox at row 0, no title bar, no caption buttons"
  fi
  return 0
}

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
# EZIL_DESKTOP_APPS itself is defaulted EARLIER, in the stale-boot reclaim block
# just above the code-server launch — the port preflight there has to agree with
# this gate about which ports the boot must own, and one definition is the only
# way to guarantee that. Everything about the format above still applies.
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

# The browser window is only guaranteed to exist once the gate above has seen
# it. Read back what frame it actually ended up with — see verify_browser_frame
# (defined above the gate) for why this is a live X read and not a config grep.
verify_browser_frame || true

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
# ever binding its HTTP listener.
#
# XTEST delivery on this Xvfb base is VERIFIED WORKING — pointer AND keyboard —
# by a real container run: see docs/NEKO-GROUND-TRUTH.md §f, where true XTEST
# (no XSendEvent fallback) synthetically clicked Chrome's new-tab button and
# typed a URL into the omnibox. This comment previously said that was
# UNVERIFIED; it is not any more. What remains WebRTC/TURN-gated is the
# transport that carries a REMOTE user's input to neko, not neko's ability to
# inject it into X once it arrives.
#
# `--desktop.screen "<W>x<H>@60"`: neko applies this with XRRSetScreenConfig at
# startup ("INF setting initial screen size"). It is the mechanism that makes
# NEKO_SCREEN the size the user first sees, now that Xvfb's `-screen` carries
# the FRAMEBUFFER instead (see the X-display section above). Without it neko
# falls through to the baked /etc/neko/neko.yaml `desktop.screen:
# "1920x1080@60"` and every session would start 1920x1080 no matter what
# NEKO_SCREEN said. Config precedence is neko's own Viper order documented in
# the encoder section above — explicit CLI flag beats NEKO_* env beats
# neko.yaml beats the compiled-in default — so the flag form is used here for
# the same reason `--desktop.display` is: it cannot be shadowed.
#
# `@60` is a nominal refresh, not a measured one: the real frame rate is set by
# the capture pipeline (15 fps, see the encoder section above). 60 matches the
# rate the app layer sends in `POST /api/room/screen {"rate":60}` per contract
# §4.2, so the initial screen and every later resize describe themselves the
# same way.
#
# `--session.implicit_hosting=true`: a connecting session takes control of the
# desktop without having to ask for it. neko's own compiled-in default is
# already `true`; the baked /etc/neko/neko.yaml turns it OFF (line 14,
# `implicit_hosting: false`), and THAT is the root cause of "no keyboard on
# mobile" — not a client-side gap:
#   * neko's on-screen-keyboard button renders only when `hosting &&
#     is_touch_device`, so with hosting off it is not in the DOM at all;
#   * the input overlay carries `pointer-events: none`;
#   * the client drops every keystroke on its own `hosting && !locked` guard.
# A phone user therefore cannot type and cannot see why.
#
# The app layer has been rescuing this per session with `enableImplicitHosting`
# (app/src/server/lib/cloudflare-guacamole-provider.ts), which logs in as admin
# and rewrites room settings on every boot — but it is explicitly best-effort
# and degrades to control mode 'manual' on any failure. That function's own
# docstring names THIS flag "the durable fix" and notes it becomes a cheap
# no-op once set, because its read-before-write already reports `true` and it
# returns without writing. So this is not a second mechanism competing with
# that one; it is the mechanism that one was standing in for.
#
# 🔴 This is BEHAVIOURAL, not plumbing: it changes who holds control on
#    connect. Checked against the one thing that counts sessions — the display
#    gate in cloudflare-guacamole-provider.ts, which asks `GET /api/sessions`
#    and counts `state.is_watching`. `is_watching` is about receiving video,
#    not about holding control; implicit hosting moves the host/control field,
#    which that gate never reads. No conflict. Nothing else in this repo reads
#    `/api/sessions`.
phase_start neko_serve_bind
NEKO_DESKTOP_SCREEN_SPEC="${NEKO_SCREEN_W}x${NEKO_SCREEN_H}@60"
log "starting neko on 0.0.0.0:$NEKO_HTTP_PORT (pinned build, static=$NEKO_STATIC, initial screen $NEKO_DESKTOP_SCREEN_SPEC inside framebuffer $EZIL_X_FRAMEBUFFER)"
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
    --desktop.screen "$NEKO_DESKTOP_SCREEN_SPEC" \
    --session.implicit_hosting=true \
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

# ── Dev server (Option D app preview) — the deliberate call site ──────────────
# See launch_devserver()'s definition above for why this is HERE and nowhere
# earlier. Everything the desktop needs has already happened: the readiness
# verdict for this boot is already decided and already logged, and neko has
# either bound its port or definitively failed to. Launched unconditionally on
# both branches — the preview is worth having even on a boot where neko never
# came up, and by this point it cannot influence that outcome either way.
launch_devserver

# ── Fatal-failure watch (contract: dead mandatory app => unhealthy desktop) ───
# Keep the startProcess-managed process alive for the lifetime of the desktop,
# but also watch for a PERMANENT mandatory-app failure. If a supervised app
# exhausts its restart budget it raises $NEKO_APP_FATAL_SENTINEL; on seeing it
# we mark the app failed in the health file, tear down neko + the other
# supervisors/monitor, and exit NON-ZERO so the container is reported unhealthy
# instead of continuing to serve an apparently-ready desktop with a dead app.
#
# terminate_stack is defined near the TOP of this file now, not here. It used to
# live at this call site, which is also why it only ever knew about the handful
# of pids in scope at this point — and why it killed supervisors instead of
# applications. See the "Process bookkeeping + teardown" section.
while true; do
  if [ -f "$NEKO_APP_FATAL_SENTINEL" ]; then
    failed_app="$(head -1 "$NEKO_APP_FATAL_SENTINEL" 2>/dev/null)"
    APP_STATE[$failed_app]="failed"
    write_health
    log "FATAL: mandatory app '$failed_app' permanently failed (restart budget exhausted). Desktop is unhealthy; exiting non-zero per contract (no apparently-ready desktop with a dead app)."
    terminate_stack "mandatory app '$failed_app' permanently failed"
    exit 1
  fi
  if ! _pid_alive "$NEKO_PID"; then
    log "neko process exited on its own — propagating its status"
    break
  fi
  sleep 2
done

wait "$NEKO_PID"
NEKO_RC=$?
log "neko exited rc=$NEKO_RC"
exit "$NEKO_RC"
