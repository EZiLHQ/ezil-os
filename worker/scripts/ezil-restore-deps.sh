#!/usr/bin/env bash
# ezil-restore-deps.sh <workspace-root>
#
# node_modules never persists (it lives on local disk, see start-neko.sh's
# /var/ezil-local split, and is far too large to checkpoint). After a
# computer comes back on a fresh container, reinstall every project's
# dependencies from its lockfile so `npm install <pkg>` work survives.
#
# The workspace ROOT project is start-devserver.sh's job (it installs and runs
# it); this covers the projects in subfolders. Runs in the background at low
# priority; never fails the desktop. Log: /tmp/ezil-restore-deps.log
set -u
ROOT="${1:-/workspace}"
[ -d "$ROOT" ] || exit 0
command -v nice >/dev/null 2>&1 && NICE="nice -n 10" || NICE=""

find "$ROOT" -mindepth 2 -maxdepth 4 \
    \( -name node_modules -o -name .git -o -name .next -o -name dist -o -name .turbo -o -name '.ezil*' \) -prune \
    -o -name package.json -type f -print 2>/dev/null | sort | while IFS= read -r manifest; do
  dir="$(dirname "$manifest")"
  [ -e "$dir/node_modules" ] && continue
  if   [ -f "$dir/bun.lock" ] || [ -f "$dir/bun.lockb" ]; then pm=bun
  elif [ -f "$dir/pnpm-lock.yaml" ]; then pm=pnpm
  elif [ -f "$dir/yarn.lock" ]; then pm=yarn
  elif [ -f "$dir/package-lock.json" ]; then pm=npm
  else
    # No lockfile: dependencies were never installed here (or were deleted); leave it.
    continue
  fi
  command -v "$pm" >/dev/null 2>&1 || { echo "[restore-deps] $dir: $pm not installed, skipped"; continue; }
  echo "[restore-deps] $dir: installing with $pm"
  ( cd "$dir" && case "$pm" in
      bun)  $NICE bun install --no-progress ;;
      pnpm) $NICE pnpm install --prefer-frozen-lockfile ;;
      yarn) $NICE yarn install --frozen-lockfile ;;
      npm)  $NICE npm ci --no-audit --no-fund || $NICE npm install --no-audit --no-fund ;;
    esac ) && echo "[restore-deps] $dir: done" || echo "[restore-deps] $dir: FAILED (exit $?)"
done
exit 0
