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
# One run at a time: the Worker starts a run right after restoring a fresh
# container, and the desktop boot starts one too. A second run waits, re-scans,
# and skips every project the first one already restored.
exec 8>"$STATE_DIR/.run.lock" 2>/dev/null && { flock 8 2>/dev/null || true; }

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
      printf '%s\t%s\n' "$root" "$dir"
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

# A workspace member (package.json, no lockfile of its own): print the locked root under
# <scan root> whose own install builds the member's node_modules, or nothing. Between the
# markers is system-snapshot-script.ts WORKSPACE_PREDICATE_PY byte for byte (a worker test
# pins it), so the member trees the system layer leaves out are exactly the ones this
# script rebuilds, by installing that root.
workspace_root_of() {
  python3 - "$1" "$2" <<'EZIL_WORKSPACE_PY' 2>/dev/null
import os, sys, json, fnmatch
# --- WORKSPACE_PREDICATE_PY ---
def lockfile_manager(directory, exists):
    # ezil-restore-deps.sh lockfile_pm's precedence: the manager that installs this dir.
    if exists(os.path.join(directory, 'bun.lock')) or exists(os.path.join(directory, 'bun.lockb')): return 'bun'
    if exists(os.path.join(directory, 'pnpm-lock.yaml')): return 'pnpm'
    if exists(os.path.join(directory, 'yarn.lock')): return 'yarn'
    if exists(os.path.join(directory, 'package-lock.json')): return 'npm'
    return None

def yaml_without_comment(line):
    if line.lstrip().startswith('#'): return ''
    at = line.find(' #')
    return line if at < 0 else line[:at]

def pnpm_workspace_packages(text):
    # The 'packages' list of pnpm-workspace.yaml, read without a YAML library: a block list
    # of plain or quoted scalars, or a one-line flow list. Any other shape (anchors, tags,
    # nested values, multi-line flow) returns None: claim no member rather than guess.
    def scalar(raw):
        raw = raw.strip()
        if raw[:1] in ('"', "'"):
            end = raw.find(raw[0], 1)
            return raw[1:end] if end > 1 and not raw[end + 1:].strip() else None
        return raw if raw and raw[0] not in '&*!|>[]{}@%,?:-' else None
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not line.startswith('packages:'): continue
        rest = yaml_without_comment(line[len('packages:'):]).strip()
        if rest:
            if not (rest.startswith('[') and rest.endswith(']')): return None
            items = [scalar(x) for x in rest[1:-1].split(',') if x.strip()]
            return items if items and None not in items else None
        items = []
        for follow in lines[i + 1:]:
            body = yaml_without_comment(follow)
            if not body.strip(): continue
            if not follow[:1].isspace(): break
            stripped = body.strip()
            item = scalar(stripped[2:]) if stripped.startswith('- ') else None
            if item is None: return None
            items.append(item)
        return items or None
    return None

def workspace_patterns(root, manager, read):
    if manager == 'pnpm':
        text = read(os.path.join(root, 'pnpm-workspace.yaml'))
        return None if text is None else pnpm_workspace_packages(text)
    text = read(os.path.join(root, 'package.json'))
    try: manifest = json.loads(text) if text is not None else None
    except ValueError: return None
    workspaces = manifest.get('workspaces') if isinstance(manifest, dict) else None
    if isinstance(workspaces, dict) and manager in ('yarn', 'bun'): workspaces = workspaces.get('packages')
    return workspaces if isinstance(workspaces, list) else None

WORKSPACE_GLOB_UNSUPPORTED = set('{}[]()?+')

def glob_segments_match(parts, segments):
    if not parts: return not segments
    if parts[0] == '**':
        if len(parts) == 1: return len(segments) >= 1
        return any(glob_segments_match(parts[1:], segments[i:]) for i in range(len(segments) + 1))
    return bool(segments) and fnmatch.fnmatchcase(segments[0], parts[0]) and glob_segments_match(parts[1:], segments[1:])

def workspace_member(patterns, rel):
    # rel: the member dir relative to the root. Subset of the package managers' globs:
    # literal segments, '*' within one segment, '**' across segments (a trailing '**' needs
    # one), './' and '/' trims, and '!' exclusions (any match excludes). Any other syntax,
    # an absolute or parent path, matches nothing; an exclusion this reader cannot evaluate
    # claims no member at all.
    if not rel or not isinstance(patterns, list): return False
    segments = rel.split('/')
    included = False
    for raw in patterns:
        if not isinstance(raw, str): return False
        negate = raw.startswith('!')
        pattern = raw[1:] if negate else raw
        while pattern.startswith('./'): pattern = pattern[2:]
        pattern = pattern.rstrip('/')
        parts = pattern.split('/')
        if (not pattern or any(c in WORKSPACE_GLOB_UNSUPPORTED for c in pattern)
                or any(part in ('', '.', '..') for part in parts)):
            if negate: return False
            continue
        if glob_segments_match(parts, segments):
            if negate: return False
            included = True
    return included

def workspace_root_within(home, project, exists, read):
    # The root whose install builds this member's trees (project: the member's segments
    # below home): the nearest ancestor (home itself included) with package.json and a
    # supported lockfile, and only when that root's package manager declares the member.
    for depth in range(len(project) - 1, -1, -1):
        root = os.path.join(home, *project[:depth])
        manager = lockfile_manager(root, exists)
        if manager is None or not exists(os.path.join(root, 'package.json')): continue
        return root if workspace_member(workspace_patterns(root, manager, read), '/'.join(project[depth:])) else None
    return None
# --- end WORKSPACE_PREDICATE_PY ---
def read_text(path, limit=1024 * 1024):
    try:
        with open(path, 'rb') as f: data = f.read(limit + 1)
    except OSError: return None
    return None if len(data) > limit else data.decode('utf-8', 'replace')
directory, scan = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
rel = os.path.relpath(directory, scan)
if rel != '.' and not rel.startswith('..'):
    root = workspace_root_within(scan, rel.split('/'), os.path.isfile, read_text)
    if root: print(root)
EZIL_WORKSPACE_PY
}

# Members tracked with their root: "<root><TAB><member>". The root's install builds
# them, so they share its pending/restoring/ready/failed state and are never installed
# on their own.
members=()
set_members_state() {
  local entry
  for entry in "${members[@]+"${members[@]}"}"; do
    [ "${entry%%"$TAB"*}" = "$2" ] && set_state "$1" "${entry#*"$TAB"}"
  done
  return 0
}

declares_dependencies() {
  node -e 'const p = require(process.argv[1]); process.exit(Object.keys({ ...p.dependencies, ...p.devDependencies }).length ? 0 : 1)' "$1/package.json" 2>/dev/null
}

# Pass 1: record every project before installing anything.
plan=(); found_members=()
while IFS="$TAB" read -r scan dir; do
  [ -e "$dir/node_modules" ] && continue
  pm="$(lockfile_pm "$dir")"
  if [ -n "$pm" ]; then
    set_state pending "$dir"; plan+=("$pm${TAB}$dir")
  elif ws_root="$(workspace_root_of "$dir" "$scan")" && [ -n "$ws_root" ]; then
    found_members+=("$ws_root${TAB}$dir")
  elif declares_dependencies "$dir"; then
    set_state missing "$dir"
    echo "[restore-deps] $dir: no lockfile was saved with this project; dependencies must be installed by hand (npm install)"
  fi
done < <(candidates)
# A member is tracked only while its root's install is planned here; with the root
# already installed (or the workspace root, start-devserver.sh's job) there is nothing
# to wait for.
for entry in "${found_members[@]+"${found_members[@]}"}"; do
  for item in "${plan[@]+"${plan[@]}"}"; do
    if [ "${item#*"$TAB"}" = "${entry%%"$TAB"*}" ]; then
      members+=("$entry"); set_state pending "${entry#*"$TAB"}"; break
    fi
  done
done
touch "$STATE_DIR/scanned" 2>/dev/null || true

# Pass 2: install, one project at a time.
for item in "${plan[@]+"${plan[@]}"}"; do
  pm="${item%%"$TAB"*}"; dir="${item#*"$TAB"}"
  [ -e "$dir/node_modules" ] && { set_state ready "$dir"; set_members_state ready "$dir"; continue; }
  command -v "$pm" >/dev/null 2>&1 || { echo "[restore-deps] $dir: $pm not installed, skipped"; set_state failed "$dir"; set_members_state failed "$dir"; continue; }
  echo "[restore-deps] $dir: installing with $pm"
  set_state restoring "$dir"; set_members_state restoring "$dir"
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
    echo "[restore-deps] $dir: done"; set_state ready "$dir"; set_members_state ready "$dir"
  else
    echo "[restore-deps] $dir: FAILED (exit $?)"; set_state failed "$dir"; set_members_state failed "$dir"
  fi
  # Preserve ownership repair for installs where no identity-switch tool is available.
  if [ -d "$dir/node_modules" ] && [ "$(stat -c %u "$dir")" != "$(id -u)" ]; then
    chown -R "$(stat -c %u:%g "$dir")" "$dir/node_modules" 2>/dev/null || true
    for entry in "${members[@]+"${members[@]}"}"; do
      m="${entry#*"$TAB"}"
      [ "${entry%%"$TAB"*}" = "$dir" ] && [ -d "$m/node_modules" ] && chown -R "$(stat -c %u:%g "$m")" "$m/node_modules" 2>/dev/null
    done
  fi
done
exit 0
