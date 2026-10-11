#!/usr/bin/env bash
# ezil-restore-deps.sh --boot <workspace-root>   (start-neko.sh: workspace subfolders + every home)
# ezil-restore-deps.sh --homes                   (every home: /root and /home/<user>)
# ezil-restore-deps.sh <workspace-root>
#
# node_modules never persists (it lives on local disk, see start-neko.sh's
# /var/ezil-local split, and is far too large to checkpoint). After a
# computer comes back on a fresh container, reinstall every project's
# dependencies from its lockfile so `npm install <pkg>` work survives.
#
# The workspace ROOT project is start-devserver.sh's job (it installs and runs
# it); this covers the projects in subfolders. Home projects are covered too,
# the home itself included: the system layer never stores their
# node_modules/.next (system-snapshot-script.ts PROJECT_REGENERABLE excludes
# exactly what this search reaches: up to 3 levels down, no hidden or dist dir
# on the way). Hidden directories are tool state (~/.opencode, ~/.nvm, .git),
# never projects. EZIL_RESTORE_SKIP (the workspace root) is never entered as a
# home.
#
# Every project is recorded BEFORE any install starts, so `ezil-deps` and the
# npm script-shell can tell a user the truth right after boot:
#   pending -> restoring -> ready | failed     (has a lockfile)
#   missing                                    (declares dependencies, no lockfile:
#                                               nothing to restore from; run npm install)
# Status: $EZIL_DEPS_STATE_DIR/status (default /run/ezil-deps), TSV state, dir, log.
# Runs in the background at low priority; never fails the desktop.
# Log: /tmp/ezil-restore-deps.log
set -u
STATE_DIR="${EZIL_DEPS_STATE_DIR:-/run/ezil-deps}"
STATUS="$STATE_DIR/status"
LOG="${EZIL_DEPS_LOG:-/tmp/ezil-restore-deps.log}"
SKIP="${EZIL_RESTORE_SKIP:-/nonexistent-ezil-restore-skip}"
TAB="$(printf '\t')"
command -v nice >/dev/null 2>&1 && NICE="nice -n 10" || NICE=""

roots=()      # "<home-mode 0|1><TAB><root>"
case "${1:-}" in
  --boot)
    ws="${2:-/workspace}"; SKIP="$ws"; roots+=("0${TAB}$ws")
    for home in /root /home/*; do roots+=("1${TAB}$home"); done
    # start-neko.sh raised this before backgrounding us; clear it however we exit.
    trap 'rm -f "$STATE_DIR/boot-restore"' EXIT ;;
  --homes) for home in /root /home/*; do roots+=("1${TAB}$home"); done ;;
  *) roots+=("0${TAB}${1:-/workspace}") ;;
esac
mkdir -p "$STATE_DIR" 2>/dev/null || true

# Atomic per-project update; readers never see a half-written file.
set_state() {
  local tmp="$STATUS.$$"
  {
    flock 9 2>/dev/null || true
    { [ -f "$STATUS" ] && awk -F'\t' -v d="$2" '$2 != d' "$STATUS"
      printf '%s\t%s\t%s\n' "$1" "$2" "$LOG"; } > "$tmp" && mv -f "$tmp" "$STATUS"
  } 9>"$STATE_DIR/.lock"
}

candidates() {
  local entry home_mode root
  for entry in "${roots[@]}"; do
    home_mode="${entry%%"$TAB"*}"; root="${entry#*"$TAB"}"
    [ -d "$root" ] && [ ! -L "$root" ] || continue
    if [ "$home_mode" = 1 ]; then case "$root/" in "${SKIP%/}/"*) continue ;; esac; fi
    # -mindepth 1, not 2: find applies -prune only at depths it evaluates, so a
    # top-level hidden dir (~/.opencode) must be evaluated to be skipped. The
    # root manifest is found too; only a home installs it.
    find "$root" -mindepth 1 -maxdepth 4 \
        \( -path "$SKIP" -o -name node_modules -o -name dist -o -name '.*' \) -prune \
        -o -name package.json -type f -print 2>/dev/null | sort | while IFS= read -r manifest; do
      dir="$(dirname "$manifest")"
      [ "$dir" = "$root" ] && [ "$home_mode" != 1 ] && continue
      printf '%s\n' "$dir"
    done
  done
}

lockfile_pm() {
  if   [ -f "$1/bun.lock" ] || [ -f "$1/bun.lockb" ]; then echo bun
  elif [ -f "$1/pnpm-lock.yaml" ]; then echo pnpm
  elif [ -f "$1/yarn.lock" ]; then echo yarn
  elif [ -f "$1/package-lock.json" ]; then echo npm
  fi
}

declares_dependencies() {
  node -e 'const p = require(process.argv[1]); process.exit(Object.keys({ ...p.dependencies, ...p.devDependencies }).length ? 0 : 1)' "$1/package.json" 2>/dev/null
}

# Pass 1: record every project before installing anything.
plan=()
while IFS= read -r dir; do
  [ -e "$dir/node_modules" ] && continue
  pm="$(lockfile_pm "$dir")"
  if [ -n "$pm" ]; then
    set_state pending "$dir"; plan+=("$pm${TAB}$dir")
  elif declares_dependencies "$dir"; then
    set_state missing "$dir"
    echo "[restore-deps] $dir: no lockfile was saved with this project; dependencies must be installed by hand (npm install)"
  fi
done < <(candidates)
touch "$STATE_DIR/scanned" 2>/dev/null || true

# Pass 2: install, one project at a time.
for item in "${plan[@]+"${plan[@]}"}"; do
  pm="${item%%"$TAB"*}"; dir="${item#*"$TAB"}"
  [ -e "$dir/node_modules" ] && { set_state ready "$dir"; continue; }
  command -v "$pm" >/dev/null 2>&1 || { echo "[restore-deps] $dir: $pm not installed, skipped"; set_state failed "$dir"; continue; }
  echo "[restore-deps] $dir: installing with $pm"
  set_state restoring "$dir"
  install_as=()
  case "$dir" in /home/*)
    owner_uid="$(stat -c %u "$dir")"
    if [ "$owner_uid" != 0 ]; then
      owner_gid="$(stat -c %g "$dir")"
      owner_home="$(getent passwd "$owner_uid" | cut -d: -f6)"
      # An unregistered owner will fail the identity switch, not install as root.
      home_path="${dir#/home/}"
      owner_home="${owner_home:-/home/${home_path%%/*}}"
      # The Ubuntu base normally supplies setpriv/runuser via util-linux.
      if command -v setpriv >/dev/null 2>&1; then
        install_as=(setpriv --reuid "$owner_uid" --regid "$owner_gid" --init-groups env "HOME=$owner_home")
      elif command -v runuser >/dev/null 2>&1; then
        install_as=(runuser -u "$(stat -c %U "$dir")" -g "$(stat -c %G "$dir")" -- env "HOME=$owner_home")
      elif command -v su >/dev/null 2>&1; then
        install_as=(su -s /bin/sh -g "$(stat -c %G "$dir")" "$(stat -c %U "$dir")" -c 'exec "$@"' -- sh env "HOME=$owner_home")
      else
        echo "[restore-deps] $dir: WARNING: setpriv, runuser and su unavailable; installing as current user"
      fi
    fi
  esac
  # EZIL_DEPS_RESTORING: the npm script-shell must not wait on the install it is part of.
  if ( cd "$dir" && export EZIL_DEPS_RESTORING=1 && case "$pm" in
      bun)  "${install_as[@]}" $NICE bun install --no-progress ;;
      pnpm) "${install_as[@]}" $NICE pnpm install --prefer-frozen-lockfile ;;
      yarn) "${install_as[@]}" $NICE yarn install --frozen-lockfile ;;
      npm)  "${install_as[@]}" $NICE npm ci --no-audit --no-fund || "${install_as[@]}" $NICE npm install --no-audit --no-fund ;;
    esac ); then
    echo "[restore-deps] $dir: done"; set_state ready "$dir"
  else
    echo "[restore-deps] $dir: FAILED (exit $?)"; set_state failed "$dir"
  fi
  # Preserve ownership repair for installs where no identity-switch tool is available.
  if [ -d "$dir/node_modules" ] && [ "$(stat -c %u "$dir")" != "$(id -u)" ]; then
    chown -R "$(stat -c %u:%g "$dir")" "$dir/node_modules" 2>/dev/null || true
  fi
done
exit 0
