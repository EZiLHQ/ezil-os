#!/usr/bin/env bash
# Deterministic, machine-checkable proof that focus-switching between the two
# mandatory neko apps (VS Code, native browser) actually changes the active X
# window — not just that the focus helper exited 0.
#
# Usage (run inside the neko container, after start-neko.sh has reached the
# window-ready gate): scripts/validate-neko-focus.sh
#
# Captures `xdotool getactivewindow` at each step and asserts:
#   1. VS Code and Chrome windows are both enumerated in `wmctrl -x -l`.
#   2. Focusing VS Code changes the active window id to the VS Code window.
#   3. Focusing the browser changes the active window id to the browser window.
#   4. Focusing VS Code again changes it back.
#
# ID NORMALIZATION (critical): `wmctrl -x -l` prints window ids in hex
# (0x03600003) while `xdotool getactivewindow` prints the same id in DECIMAL
# (56623107). A naive string compare therefore NEVER matches. Every id below is
# normalized to decimal via `norm_id` before comparison, and the normalized
# decimal ids are printed so the evidence is inspectable.
set -uo pipefail
export DISPLAY="${DISPLAY:-:99}"

fail() { echo "FAIL: $*" >&2; exit 1; }

# Normalize a window id (hex "0x0360...", bare hex, or decimal) to canonical
# decimal so wmctrl (hex) and xdotool (decimal) ids compare correctly.
norm_id() {
  local v="${1:-}"
  [ -n "$v" ] || { echo ""; return; }
  if [[ "$v" == 0x* || "$v" == 0X* ]]; then
    printf '%d' "$v" 2>/dev/null || echo ""
  elif [[ "$v" =~ ^[0-9]+$ ]]; then
    echo "$v"
  else
    # bare hex (no 0x prefix)
    printf '%d' "0x$v" 2>/dev/null || echo ""
  fi
}

active_id() { norm_id "$(xdotool getactivewindow 2>/dev/null || echo 0)"; }

# Resolve the (decimal-normalized) window id for an app by WM_CLASS match,
# identical to how neko-switch-app.sh resolves it.
win_id_for() {
  local re="$1"
  local raw
  raw="$(wmctrl -x -l 2>/dev/null | awk -v re="$re" 'tolower($3) ~ tolower(re){print $1; exit}')"
  norm_id "$raw"
}

command -v wmctrl >/dev/null 2>&1 || fail "wmctrl not installed"
command -v xdotool >/dev/null 2>&1 || fail "xdotool not installed"

echo "== enumerated windows (wmctrl -x -l: id / class / title) =="
wmctrl -x -l || fail "wmctrl -x -l failed"

vscode_id="$(win_id_for 'code|Code')"
chrome_id="$(win_id_for 'chrome')"

[ -n "$vscode_id" ] || fail "no enumerated VS Code window found in wmctrl -x -l"
[ -n "$chrome_id" ] || fail "no enumerated browser window found in wmctrl -x -l"

echo "expected vscode window id (decimal): $vscode_id"
echo "expected chrome window id (decimal): $chrome_id"

before="$(active_id)"
echo "active window BEFORE any focus (decimal): $before"

/usr/local/bin/neko-switch-app.sh vscode
sleep 1
after_vscode="$(active_id)"
echo "active window AFTER focusing vscode (decimal): $after_vscode"
[ "$after_vscode" = "$vscode_id" ] || fail "active window after focusing vscode ($after_vscode) does not match enumerated vscode window ($vscode_id)"

/usr/local/bin/neko-switch-app.sh chromium
sleep 1
after_chrome="$(active_id)"
echo "active window AFTER focusing browser (decimal): $after_chrome"
[ "$after_chrome" = "$chrome_id" ] || fail "active window after focusing browser ($after_chrome) does not match enumerated browser window ($chrome_id)"
[ "$after_chrome" != "$after_vscode" ] || fail "active window did not change between vscode and browser focus ($after_chrome == $after_vscode)"

/usr/local/bin/neko-switch-app.sh vscode
sleep 1
back_to_vscode="$(active_id)"
echo "active window AFTER focusing vscode again (decimal): $back_to_vscode"
[ "$back_to_vscode" = "$vscode_id" ] || fail "active window after re-focusing vscode ($back_to_vscode) does not match enumerated vscode window ($vscode_id)"
[ "$back_to_vscode" != "$after_chrome" ] || fail "active window did not change back from browser to vscode ($back_to_vscode == $after_chrome)"

echo "PASS: active-window identity changed correctly in both directions (vscode=$vscode_id, chrome=$chrome_id)"
