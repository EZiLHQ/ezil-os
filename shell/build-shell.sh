#!/usr/bin/env bash
# Wave 0 — build the browser shell bundle.
#
# Bundles `shell/ezil` (EZiL-authored) plus `shell/src` (Puter-derived, see
# ../ATTRIBUTIONS.md and ./PUTER-PROVENANCE.md) into three self-contained
# artifacts under `app/public/os/`, which Next.js serves statically:
#
#   bundle.min.js    esbuild, IIFE, entry = shell/ezil/boot.js
#   bundle.min.css   cat (deterministic order) + clean-css
#   icons.js         generated data-URI map of shell/src/icons/*
#
# Deliberately NOT Puter's webpack setup: its extension loader and HTML
# templating pull in the cloud backend we are stripping. esbuild + cat only.
#
# Deterministic + committed: the produced artifacts are checked in so the app
# needs no shell build step, and so --check has something to diff. Tool
# versions are pinned below for that reason — an unpinned minifier makes the
# drift guard fire on someone else's machine rather than on real drift.
#
# Run from anywhere; paths are resolved relative to this script.
#
# Modes:
#   (no args)   Build and write app/public/os/{bundle.min.js,bundle.min.css,icons.js}.
#   --check     CI drift-guard: rebuild into a temp dir and fail (exit 1) if the
#               committed app/public/os/ differs from source. Does NOT modify
#               the committed artifacts.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
entry="$here/ezil/boot.js"
out="$repo/app/public/os"

ESBUILD_VERSION="0.28.1"
CLEANCSS_VERSION="5.6.3"

# Sort deterministically regardless of the caller's locale.
export LC_ALL=C

banner="/*! EZiL-OS shell — AGPL-3.0-only. Contains code derived from Puter
 * (https://github.com/HeyPuter/puter), AGPL-3.0-only, MODIFIED by EZiL.
 * Not endorsed by or affiliated with Puter Technologies Inc.
 * See ATTRIBUTIONS.md and shell/PUTER-PROVENANCE.md. */"

# List css inputs in cascade order: Puter-derived first, EZiL overrides last,
# then anything under shell/ezil. Emits nothing if a tree has no .css yet.
#
# The first four are ordered EXPLICITLY, not alphabetically, because the
# cascade depends on it and a `sort` gets it wrong. Upstream Puter loads them
# in this order (see its src/gui/src/static-assets.js `css_paths`):
#
#   normalize.css   reset, must be first
#   jquery-ui.css   vendor widget theme
#   style.css       Puter's chrome, which deliberately OVERRIDES jQuery UI's
#                   .ui-resizable-* handles -- so it must come after it
#   dashboard.css   dashboard-mode chrome, layered on top of style.css
#
# A plain `find | sort` puts lib/jquery-ui last (l > c), which lets the vendor
# theme win over the window chrome and leaves resize handles mispositioned.
# Anything not named here is appended afterwards in sorted order, so adding a
# sheet does not silently drop it.
css_inputs() {
  local ordered=(
    "$here/src/css/normalize.css"
    "$here/src/lib/jquery-ui-1.13.2/jquery-ui.min.css"
    "$here/src/css/style.css"
    "$here/src/css/dashboard.css"
  )
  local f
  for f in "${ordered[@]}"; do
    [[ -f "$f" ]] && printf '%s\n' "$f"
  done
  # Remaining Puter-derived sheets, if any, then the EZiL overrides.
  find "$here/src" -name '*.css' -not -name 'ezil-*.css' -type f 2>/dev/null | sort \
    | grep -vxF -f <(printf '%s\n' "${ordered[@]}") || true
  find "$here/src" -name 'ezil-*.css' -type f 2>/dev/null | sort
  find "$here/ezil" -name '*.css' -type f 2>/dev/null | sort
}

mime_for() {
  case "${1##*.}" in
    svg) echo 'image/svg+xml' ;;
    png) echo 'image/png' ;;
    gif) echo 'image/gif' ;;
    webp) echo 'image/webp' ;;
    jpg|jpeg) echo 'image/jpeg' ;;
    *) return 1 ;;
  esac
}

# Build all three artifacts into $1. Single code path, shared by build and
# --check, so the drift guard can never diverge from what a build produces.
emit() {
  local dir="$1"
  mkdir -p "$dir"

  echo "[build-shell] js:   $entry -> $dir/bundle.min.js"
  bunx "esbuild@$ESBUILD_VERSION" "$entry" \
    --bundle \
    --format=iife \
    --global-name=EzilShell \
    --target=es2022 \
    --minify \
    --legal-comments=none \
    --banner:js="$banner" \
    --log-level=warning \
    --outfile="$dir/bundle.min.js"

  local sheets tmpcss
  # `mapfile` needs bash 4; macOS ships bash 3.2 and this script must run there
  # (measured on PR #14: `mapfile: command not found`, exit 127). A read loop is
  # equivalent for paths without newlines, which is every path in this tree.
  sheets=()
  while IFS= read -r line; do sheets+=("$line"); done < <(css_inputs)
  tmpcss="$(mktemp)"
  printf '%s\n' "$banner" >"$tmpcss"
  if ((${#sheets[@]})); then
    echo "[build-shell] css:  ${#sheets[@]} sheet(s) -> $dir/bundle.min.css"
    for s in "${sheets[@]}"; do
      printf '\n/* %s */\n' "${s#"$repo"/}" >>"$tmpcss"
      cat "$s" >>"$tmpcss"
    done
  else
    echo "[build-shell] css:  no sheets yet -> $dir/bundle.min.css (banner only)"
  fi
  bunx "clean-css-cli@$CLEANCSS_VERSION" -O2 --format keep-breaks \
    -o "$dir/bundle.min.css" "$tmpcss"
  rm -f "$tmpcss"

  # icons.js: filename -> data URI. Generated, never hand-edited. Puter loads
  # its icons as a JS module of data URIs; we keep the shape, not the file.
  # Emitted as a *classic* script setting a global, not an ES module, because
  # bundle.min.js is an IIFE and cannot `import` — load icons.js first.
  local icons=() n
  icons=()
  while IFS= read -r line; do icons+=("$line"); done < <(find "$here/src/icons" -type f -not -name '.gitkeep' 2>/dev/null | sort)
  echo "[build-shell] icon: ${#icons[@]} file(s) -> $dir/icons.js"
  {
    printf '%s\n' "$banner"
    printf '// GENERATED by shell/build-shell.sh — do not edit.\n'
    printf 'globalThis.EzilIcons = (function () {\n'
    printf '  var icons = {};\n'
    for f in ${icons[@]+"${icons[@]}"}; do
      n="$(basename "$f")"
      mime_for "$n" >/dev/null || { echo "[build-shell] skip icon (unknown type): $n" >&2; continue; }
      # `base64 < file`, never `base64 file`: BSD base64 (macOS) takes its input
      # file only via -i and silently reads an empty stdin when given a positional
      # argument — measured on PR #14, where every icon encoded to nothing.
      printf '  icons[%s] = "data:%s;base64,%s";\n' \
        "\"$n\"" "$(mime_for "$n")" "$(base64 < "$f" | tr -d '\n')"
    done
    printf '  return icons;\n})();\n'
  } >"$dir/icons.js"
}

mode="${1:-build}"

case "$mode" in
  build) ;;
  --check) ;;
  *) echo "[build-shell] unknown mode: $mode (expected no args or --check)" >&2; exit 2 ;;
esac

if [[ "$mode" == "--check" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "[build-shell] drift-check: rebuilding -> (temp)"
  emit "$tmp"
  if [[ ! -d "$out" ]]; then
    echo "[build-shell] FAIL: committed bundle dir missing at $out" >&2
    exit 1
  fi
  if diff -r "$out" "$tmp" >/dev/null; then
    echo "[build-shell] OK: committed bundle matches source"
    exit 0
  fi
  diff -r "$out" "$tmp" >&2 || true
  echo "[build-shell] FAIL: committed bundle is stale — run shell/build-shell.sh and commit app/public/os/" >&2
  exit 1
fi

emit "$out"
echo "[build-shell] done ($(cat "$out"/bundle.min.js "$out"/bundle.min.css "$out"/icons.js | wc -c) bytes total)"
