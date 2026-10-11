#!/usr/bin/env bash
# ezil-deps — what ezil-restore-deps.sh is doing to a project's dependencies
# after the computer came back on a fresh container.
#
#   ezil-deps status [<dir>]              lines "<state>\t<dir>"; "scanning" while the boot scan runs
#   ezil-deps wait <dir> [--timeout <s>]  0 ready, 1 failed, 2 timeout, 3 untracked, 4 missing
#   ezil-deps gate <dir>                  npm script-shell: tell the user, wait (bounded), never fail
#   ezil-deps notice                      interactive shells: one summary, silent when all is ready
#   ezil-deps install-hooks               (image build + every boot) wire npm and bash, append-only
#
# States: pending, restoring, ready, failed, missing (declares dependencies but no
# lockfile was saved, so nothing can be restored). Untracked = nothing to restore.
set -u
STATE_DIR="${EZIL_DEPS_STATE_DIR:-/run/ezil-deps}"
STATUS="$STATE_DIR/status"
MARK="$STATE_DIR/boot-restore"
SCANNED="$STATE_DIR/scanned"
LOG="${EZIL_DEPS_LOG:-/tmp/ezil-restore-deps.log}"

scanning() { [ -e "$MARK" ] && [ ! -e "$SCANNED" ]; }
canonical() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"; }
lookup() { [ -f "$STATUS" ] && awk -F'\t' -v d="$1" '$2 == d { print $1; exit }' "$STATUS"; }
# A failed install usually leaves partial node_modules. Only accept an installer's
# marker from a later hand install, never the directory or a marker predating failure.
# STATUS is atomically rewritten: its mtime is at least as new as this failure. Other
# projects can advance it too, so ambiguous repairs conservatively stay failed.
# Never resolve pending/restoring: an install in progress creates node_modules early.
hand_install_completed() {
  local dir="$1" marker
  local -a markers=()
  [ -d "$dir/node_modules" ] && [ -f "$STATUS" ] || return 1
  # Match ezil-restore-deps.sh's lockfile_pm precedence; another installer's stale
  # tree must not certify the package manager selected for this project.
  if [ -f "$dir/bun.lock" ] || [ -f "$dir/bun.lockb" ]; then
    # Bun writes bun.lock (text) or bun.lockb (older binary format) on install.
    # Accept only a rewritten lockfile together with an existing dependency tree.
    markers=(bun.lock bun.lockb)
  elif [ -f "$dir/pnpm-lock.yaml" ]; then
    # pnpm writes the installed modules layout to node_modules/.modules.yaml.
    markers=(node_modules/.modules.yaml)
  elif [ -f "$dir/yarn.lock" ]; then
    # Yarn Classic saves .yarn-integrity; Berry's node-modules linker saves .yarn-state.yml.
    markers=(node_modules/.yarn-integrity node_modules/.yarn-state.yml)
  elif [ -f "$dir/package-lock.json" ]; then
    # npm writes this hidden lockfile for its installed node_modules tree.
    markers=(node_modules/.package-lock.json)
  fi
  for marker in "${markers[@]}"; do
    [ -f "$dir/$marker" ] && [ "$dir/$marker" -nt "$STATUS" ] && return 0
  done
  return 1
}
resolved() {
  case "$1" in
    failed)
      if hand_install_completed "$2"; then
        echo ready
      else echo failed; fi ;;
    missing) [ -d "$2/node_modules" ] && echo ready || echo missing ;;
    *) echo "$1" ;;
  esac
}
state_of() {
  local s; s="$(lookup "$1")"; [ -n "$s" ] || s="$(lookup "$(canonical "$1")")"
  if [ -n "$s" ]; then resolved "$s" "$1"; elif scanning; then echo scanning; else echo untracked; fi
}
pretty() { case "$1" in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }

# Wait until <dir> leaves pending/restoring/scanning. Prints progress to stderr every 10 s.
wait_for() {
  local dir="$1" timeout="$2" quiet="${3:-}" start now s next=10
  start="$(date +%s)"
  while :; do
    s="$(state_of "$dir")"
    case "$s" in pending|restoring|scanning) ;; *) echo "$s"; return ;; esac
    now="$(date +%s)"
    [ $((now - start)) -ge "$timeout" ] && { echo timeout; return; }
    if [ -z "$quiet" ] && [ $((now - start)) -ge "$next" ]; then
      echo "EZiL: still restoring dependencies for $(pretty "$dir") ($((now - start))s)…" >&2
      next=$((next + 10))
    fi
    sleep 1
  done
}

cmd="${1:-status}"; shift || true
case "$cmd" in
  status)
    scanning && echo scanning
    [ -f "$STATUS" ] || exit 0
    if [ $# -ge 1 ]; then d="$(canonical "$1")"; awk -F'\t' -v a="$1" -v b="$d" '$2 == a || $2 == b { print $1 "\t" $2 }' "$STATUS"
    else awk -F'\t' '{ print $1 "\t" $2 }' "$STATUS"; fi ;;
  wait)
    [ $# -ge 1 ] || { echo "usage: ezil-deps wait <dir> [--timeout <s>]" >&2; exit 64; }
    dir="$1"; timeout=600; [ "${2:-}" = --timeout ] && timeout="${3:-600}"
    case "$(wait_for "$dir" "$timeout" quiet)" in
      ready) exit 0 ;; failed) exit 1 ;; timeout) exit 2 ;; missing) exit 4 ;; *) exit 3 ;;
    esac ;;
  gate)
    dir="${1:-$PWD}"; timeout="${EZIL_DEPS_WAIT_SECONDS:-300}"
    [ "$timeout" = 0 ] && exit 0
    p="$(pretty "$dir")"
    case "$(state_of "$dir")" in
      untracked|ready) exit 0 ;;
      missing) echo "EZiL: dependencies for $p are not installed: no lockfile was saved with this project. Run: npm install" >&2; exit 0 ;;
      failed) echo "EZiL: restoring dependencies for $p FAILED after the restart. Run: npm install   (log: $LOG)" >&2; exit 0 ;;
    esac
    echo "EZiL: restoring dependencies for $p after the computer restarted; waiting up to ${timeout}s (Ctrl-C to stop; log: $LOG)" >&2
    case "$(wait_for "$dir" "$timeout")" in
      ready) echo "EZiL: dependencies for $p are ready." >&2 ;;
      failed) echo "EZiL: restoring dependencies for $p FAILED. Run: npm install   (log: $LOG)" >&2 ;;
      missing) echo "EZiL: dependencies for $p are not installed: no lockfile was saved with this project. Run: npm install" >&2 ;;
      timeout) echo "EZiL: dependencies for $p are still restoring after ${timeout}s; running anyway (log: $LOG)" >&2 ;;
    esac
    exit 0 ;;
  notice)
    lines=""
    scanning && lines="  checking projects…"$'\n'
    if [ -f "$STATUS" ]; then
      while IFS="$(printf '\t')" read -r s d _; do
        s="$(resolved "$s" "$d")"
        case "$s" in
          pending|restoring) lines+="  restoring       $(pretty "$d")"$'\n' ;;
          failed)            lines+="  FAILED          $(pretty "$d")   run: npm install   (log: $LOG)"$'\n' ;;
          missing)           lines+="  not installed   $(pretty "$d")   no lockfile was saved; run: npm install"$'\n' ;;
        esac
      done < "$STATUS"
    fi
    [ -n "$lines" ] || exit 0
    printf 'EZiL: project dependencies after the restart (npm run waits for restoring ones; ezil-deps status):\n%s' "$lines" ;;
  install-hooks)
    # Append-only and idempotent. The system layer restores a user's own /etc/bash.bashrc and
    # global npmrc over the image's (their edits win), which used to drop this wiring silently.
    # Their lines are never rewritten, and a script-shell they chose themselves is kept.
    wrapper=/usr/local/lib/ezil/npm-script-shell
    npmrc="$(npm config get globalconfig 2>/dev/null || true)"
    if [ -n "$npmrc" ] && ! grep -qE '^[[:space:]]*script-shell[[:space:]]*=' "$npmrc" 2>/dev/null; then
      mkdir -p "$(dirname "$npmrc")"
      [ -s "$npmrc" ] && [ -n "$(tail -c1 "$npmrc")" ] && echo >> "$npmrc"
      printf '# EZiL: npm run waits (bounded) while a restored project is still restoring.\nscript-shell=%s\n' "$wrapper" >> "$npmrc"
    fi
    if [ -f /etc/bash.bashrc ] && ! grep -q 'ezil-deps notice' /etc/bash.bashrc; then
      [ -s /etc/bash.bashrc ] && [ -n "$(tail -c1 /etc/bash.bashrc)" ] && echo >> /etc/bash.bashrc
      printf '# EZiL: dependency-restore status after a restart (silent when all is ready).\n[ -x /usr/local/bin/ezil-deps ] && /usr/local/bin/ezil-deps notice 2>/dev/null\n' >> /etc/bash.bashrc
    fi ;;
  *) echo "usage: ezil-deps status|wait|gate|notice|install-hooks" >&2; exit 64 ;;
esac
