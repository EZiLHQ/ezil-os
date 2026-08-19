#!/usr/bin/env bash
# Deterministic, machine-checkable proof of focus-switching behavior on the
# neko desktop, after the code-server swap (Electron VS Code removed — see
# start-neko.sh and the Dockerfile).
#
# Usage (run inside the neko container, after start-neko.sh has reached the
# window-ready gate): scripts/validate-neko-focus.sh
#
# Captures `xdotool getactivewindow` and asserts:
#   1. The native browser window is enumerated in `wmctrl -x -l`.
#   2. Focusing the browser via neko-switch-app.sh actually changes the
#      active window id to the enumerated browser window (not just that the
#      helper exited 0).
#   3. `neko-switch-app.sh vscode` degrades GRACEFULLY: it exits non-zero
#      (no window to find — code-server is a plain HTTP server, not an X
#      client) but does NOT crash the shell, hang, or disturb the already-
#      focused browser window. This is the automated version of the manual
#      check the code-server migration brief asked for ("W-1/W-c simply find
#      no window — confirm that is true rather than assuming it").
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

# The window holding the X INPUT FOCUS, which is a different thing from the
# "active" window (_NET_ACTIVE_WINDOW). XTEST key events are delivered to the
# input-focus window, so a desktop where the active window and the focus window
# disagree looks focused but silently swallows every keystroke. Ground truth §f
# proved XTEST delivery works; this is the standing check that the precondition
# it depends on still holds.
focus_id() { norm_id "$(xdotool getwindowfocus 2>/dev/null || echo 0)"; }

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

chrome_id="$(win_id_for 'chrome')"
[ -n "$chrome_id" ] || fail "no enumerated browser window found in wmctrl -x -l"
echo "expected chrome window id (decimal): $chrome_id"

echo "== focusing the native browser actually changes the active window =="
before="$(active_id)"
echo "active window BEFORE any focus (decimal): $before"

/usr/local/bin/neko-switch-app.sh chromium
sleep 1
after_chrome="$(active_id)"
echo "active window AFTER focusing browser (decimal): $after_chrome"
[ "$after_chrome" = "$chrome_id" ] || fail "active window after focusing browser ($after_chrome) does not match enumerated browser window ($chrome_id)"

# ...and the browser must actually hold the X INPUT FOCUS, not merely be the
# "active" window. These can diverge, and when they do keyboard input is
# delivered to nothing while every other signal still looks healthy.
focus_after_chrome="$(focus_id)"
echo "input-focus window AFTER focusing browser (decimal): $focus_after_chrome"
[ "$focus_after_chrome" = "$chrome_id" ] || fail "browser is the active window ($after_chrome) but the X input focus is on $focus_after_chrome — synthetic keystrokes would not reach the browser"

echo "== neko-switch-app.sh vscode degrades gracefully (no window, no crash) =="
# code-server (which replaced Electron VS Code) is a plain HTTP server with no
# X window, so this MUST fail (no window found) — a SUCCESSFUL exit here would
# mean something unexpectedly still matches the vscode class regex, which
# would itself be a regression worth catching.
/usr/local/bin/neko-switch-app.sh vscode >/tmp/neko-switch-vscode.out 2>&1
vscode_helper_rc=$?
if [ "$vscode_helper_rc" -eq 0 ]; then
  fail "neko-switch-app.sh vscode unexpectedly SUCCEEDED — code-server should have no matching X window (see /tmp/neko-switch-vscode.out)"
fi
grep -qi "no window found for vscode" /tmp/neko-switch-vscode.out \
  || fail "neko-switch-app.sh vscode did not fail with the expected 'no window found' message (got: $(cat /tmp/neko-switch-vscode.out))"
echo "OK: neko-switch-app.sh vscode exited non-zero (rc=$vscode_helper_rc) with the expected 'no window found' message — confirmed no-op, not a crash"

# The graceful no-op must not have disturbed the already-focused browser
# window (the fail-closed case here would be the shell/WM state getting
# corrupted by the failed helper invocation).
after_noop="$(active_id)"
echo "active window AFTER the vscode no-op attempt (decimal): $after_noop"
[ "$after_noop" = "$chrome_id" ] || fail "active window changed unexpectedly after the vscode no-op ($after_noop != $chrome_id) — graceful degradation should leave focus untouched"

echo "PASS: browser focus-switch works, and vscode focus-switch degrades gracefully (no window, no crash, no side effect) (chrome=$chrome_id)"
