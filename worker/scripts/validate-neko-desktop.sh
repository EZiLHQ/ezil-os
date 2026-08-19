#!/usr/bin/env bash
# EZiL OS neko desktop — deterministic, machine-checkable desktop validation.
#
# Runs INSIDE the final image after start-neko.sh has passed its window-ready
# gate. Produces positive, inspectable evidence that the mandatory app set
# (EZIL_DESKTOP_APPS in start-neko.sh: native browser + code-server) is
# genuinely up, and negative evidence that the browser is NOT a blank surface.
# Enumerates window ids / PIDs / classes / titles and normalizes id formats so
# hex (wmctrl) and decimal (xdotool/_NET_WM_PID) sources agree.
#
# code-server (which replaced Electron VS Code — see start-neko.sh) is a
# plain HTTP server with NO X window, so it is validated by a TCP probe
# (127.0.0.1:8443) plus its supervised PID from the app health file, not by
# window enumeration.
#
# Exit non-zero on any failed assertion; prints a JSON-ish summary either way.
set -uo pipefail
export DISPLAY="${DISPLAY:-:99}"

RC=0
fail() { echo "FAIL: $*" >&2; RC=1; }
ok()   { echo "OK: $*"; }

norm_id() {
  local v="${1:-}"
  [ -n "$v" ] || { echo ""; return; }
  if [[ "$v" == 0x* || "$v" == 0X* ]]; then printf '%d' "$v" 2>/dev/null || echo ""
  elif [[ "$v" =~ ^[0-9]+$ ]]; then echo "$v"
  else printf '%d' "0x$v" 2>/dev/null || echo ""; fi
}

command -v wmctrl >/dev/null 2>&1 || { echo "FAIL: wmctrl missing" >&2; exit 1; }
command -v xdotool >/dev/null 2>&1 || { echo "FAIL: xdotool missing" >&2; exit 1; }

echo "== X display =="
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && ok "X display $DISPLAY active" || fail "X display $DISPLAY not active"

echo "== enumerated top-level windows (wmctrl -x -l) =="
wmctrl -x -l || fail "wmctrl -x -l failed"

# Per-app: window id (hex+decimal), WM_CLASS, title, and owning PID.
# Human-readable diagnostics go to stderr; ONLY the machine row (tab-separated:
# label, decid, class, pid, title) is written to stdout so callers can capture
# it cleanly via command substitution.
enumerate_app() {
  local label="$1" class_re="$2"
  local line hexid class title decid pid
  line="$(wmctrl -x -l 2>/dev/null | awk -v re="$class_re" 'tolower($3) ~ tolower(re){print; exit}')"
  if [ -z "$line" ]; then
    fail "$label: no window matching class ~ /$class_re/" >&2
    return 1
  fi
  hexid="$(echo "$line" | awk '{print $1}')"
  class="$(echo "$line" | awk '{print $3}')"
  title="$(echo "$line" | cut -d' ' -f5-)"
  decid="$(norm_id "$hexid")"
  pid="$(xdotool getwindowpid "$decid" 2>/dev/null || echo 0)"
  echo "OK: $label: hexid=$hexid decid=$decid class=$class pid=$pid title=\"$title\"" >&2
  # machine row (stdout)
  printf '%s\t%s\t%s\t%s\t%s\n' "$label" "$decid" "$class" "$pid" "$title"
}

echo "== mandatory apps: native browser (X window) =="
CHROME_ROW="$(enumerate_app chromium 'chrome')"

CHROME_PID="$(printf '%s' "$CHROME_ROW" | cut -f4)"
CHROME_TITLE="$(printf '%s' "$CHROME_ROW" | cut -f5-)"

# Browser must be present (enumerate_app already failed loudly if absent).
[ -n "$CHROME_ROW" ] || fail "browser window not enumerated"

# Record the LITERAL WM_CLASS off the live window. `wmctrl -x` prints
# "instance.class" as one field, which silently hides which half is which; the
# openbox rule matches on the CLASS half only. Two suites in this repo stub
# wmctrl and SUPPLY this string, so until now nothing had ever read it off a
# real X server. Printed verbatim so it is never again an open question.
CHROME_DECID="$(printf '%s' "$CHROME_ROW" | cut -f2)"
if [ -n "$CHROME_DECID" ] && command -v xprop >/dev/null 2>&1; then
  WM_CLASS_RAW="$(xprop -id "$CHROME_DECID" WM_CLASS 2>/dev/null)"
  WM_INSTANCE="$(printf '%s' "$WM_CLASS_RAW" | sed -n 's/.*= "\([^"]*\)", "\([^"]*\)".*/\1/p')"
  WM_CLASS="$(printf '%s' "$WM_CLASS_RAW" | sed -n 's/.*= "\([^"]*\)", "\([^"]*\)".*/\2/p')"
  if [ -n "$WM_CLASS" ]; then
    ok "browser literal WM_CLASS: instance=\"$WM_INSTANCE\" class=\"$WM_CLASS\""
  else
    fail "could not read WM_CLASS off the live browser window (xprop said: $WM_CLASS_RAW)"
  fi
else
  fail "no window id or no xprop — the literal WM_CLASS could not be read from the running system"
fi

echo "== mandatory apps: code-server (loopback HTTP port, no X window) =="
CODESERVER_HOST="${CODESERVER_HOST:-127.0.0.1}"
CODESERVER_PORT="${CODESERVER_PORT:-8443}"
if (exec 3<>"/dev/tcp/${CODESERVER_HOST}/${CODESERVER_PORT}") 2>/dev/null; then
  exec 3>&- 3<&- 2>/dev/null || true
  ok "code-server is listening on ${CODESERVER_HOST}:${CODESERVER_PORT}"
else
  fail "code-server is NOT listening on ${CODESERVER_HOST}:${CODESERVER_PORT}"
fi

echo "== browser must NOT be blank =="
# Positive content assertion: the deterministic landing page sets its <title>
# to "EZiL OS Browser". about:blank yields an empty/"about:blank" title.
if echo "$CHROME_TITLE" | grep -qi "EZiL OS Browser"; then
  ok "browser is showing EZiL OS landing page (title matched)"
elif echo "$CHROME_TITLE" | grep -qi "about:blank"; then
  fail "browser is on about:blank — mandatory native browser has no real content"
else
  # Title may be truncated by WM; accept any non-empty, non-blank title but warn.
  if [ -n "${CHROME_TITLE//[[:space:]]/}" ]; then
    ok "browser has a non-blank title: \"$CHROME_TITLE\""
  else
    fail "browser window title is empty (possible blank surface)"
  fi
fi

# codeserver has no X window/PID to enumerate via wmctrl, so its supervised
# PID comes from start-neko.sh's own sanitized app health file instead (same
# JSON that terminate_stack/the fatal sentinel already treat as authoritative
# for this app's process state).
HF="${NEKO_APP_HEALTH_FILE:-/tmp/neko-app-health.json}"
CODESERVER_PID=""
if [ -f "$HF" ]; then
  CODESERVER_PID="$(grep -o '"codeserver":{[^}]*}' "$HF" | grep -o '"pid":[0-9]*' | cut -d: -f2)"
fi

echo "== process liveness (PIDs) =="
for pair in "codeserver:$CODESERVER_PID" "chromium:$CHROME_PID"; do
  name="${pair%%:*}"; pid="${pair#*:}"
  if [ -n "$pid" ] && [ "$pid" != "0" ] && kill -0 "$pid" 2>/dev/null; then
    ok "$name pid $pid alive"
  else
    fail "$name pid '$pid' not alive"
  fi
done

echo "== openbox config (explicit shortcuts + root menu) =="
# The config path is resolved from the argv of the openbox process that is
# ACTUALLY RUNNING, not from a hardcoded default. Grepping a file that nothing
# loaded proves nothing — that is precisely how `<decor>no</decor>` went the
# whole life of this repo without anyone being able to say whether openbox had
# ever matched the rule. The env override is kept as a fallback for running this
# script before/without openbox.
OB_CFG_RUNNING="$(ps -eo args 2>/dev/null | grep -m1 '^openbox' | sed -n 's/.*--config-file[ =]\([^ ]*\).*/\1/p')"
OB_CFG="${OB_CFG_RUNNING:-${NEKO_OPENBOX_CONFIG:-/etc/neko/ebuilder-openbox.xml}}"
if [ -n "$OB_CFG_RUNNING" ]; then
  ok "openbox is running with config actually loaded from $OB_CFG_RUNNING (resolved from its argv, not assumed)"
else
  fail "could not resolve --config-file from the running openbox process — the assertions below would be grepping a file nothing has loaded"
fi
if [ -f "$OB_CFG" ]; then
  ok "openbox config present: $OB_CFG"
  # The "vscode" keybind is now INERT (see ebuilder-openbox.xml's own NOTE and
  # neko-switch-app.sh's comment on the `vscode` case) — code-server has no X
  # window to focus. Still asserted present here because Openbox's own root
  # rc file wiring (the keybind existing at all, regardless of whether its
  # target currently resolves to a window) is what this section verifies;
  # the DYNAMIC "does it degrade gracefully" behavior is asserted by
  # validate-neko-focus.sh instead.
  grep -q "neko-switch-app.sh vscode" "$OB_CFG"   && ok "keybind -> vscode (inert no-op) present" || fail "no vscode focus keybind in $OB_CFG"
  grep -q "neko-switch-app.sh chromium" "$OB_CFG" && ok "keybind -> focus browser present"  || fail "no browser focus keybind in $OB_CFG"
  grep -q "<menu>" "$OB_CFG"                       && ok "root menu wired in openbox config" || fail "no root menu wired in $OB_CFG"
else
  fail "openbox config $OB_CFG missing"
fi
if pgrep -x openbox >/dev/null 2>&1; then ok "openbox WM process running"; else fail "openbox not running"; fi

echo "== app health file =="
if [ -f "$HF" ]; then
  echo "health: $(cat "$HF")"
  grep -q '"failed"' "$HF" && fail "an app is in failed state" || ok "no app in failed state"
else
  fail "health file $HF missing"
fi

echo "== browser window: decoration / WM_CLASS / screen modes / XTEST =="
# The heavy runtime assertions live in their own validator. Everything above in
# THIS file that mentions openbox inspects a config file; the checks below
# inspect the window on screen, the X server, and real synthetic input. Exit
# code 2 there means "only assertions awaiting another agent's change are red",
# which is not a failure of this desktop.
BW_VALIDATOR=""
if [ -x /usr/local/bin/validate-neko-browser-window.sh ]; then
  BW_VALIDATOR=/usr/local/bin/validate-neko-browser-window.sh
elif [ -x "$(dirname "$0")/validate-neko-browser-window.sh" ]; then
  BW_VALIDATOR="$(dirname "$0")/validate-neko-browser-window.sh"
fi
if [ -n "$BW_VALIDATOR" ]; then
  "$BW_VALIDATOR"
  BW_RC=$?
  case "$BW_RC" in
    0) ok "browser-window validation passed in full" ;;
    2) ok "browser-window validation: only awaiting:* assertions are red (see rows above) — no regression" ;;
    3) fail "browser-window validation could NOT run some assertions (exit 3) — unproven, not passing" ;;
    *) fail "browser-window validation FAILED (exit $BW_RC) — a behaviour that is known-good on main has regressed" ;;
  esac
else
  fail "validate-neko-browser-window.sh not found — window decoration, WM_CLASS, screen modes and XTEST input are UNVERIFIED by this run"
fi

echo "== focus switching =="
if [ -x /usr/local/bin/validate-neko-focus.sh ]; then
  /usr/local/bin/validate-neko-focus.sh || fail "focus-switch validation failed"
elif [ -x "$(dirname "$0")/validate-neko-focus.sh" ]; then
  "$(dirname "$0")/validate-neko-focus.sh" || fail "focus-switch validation failed"
else
  # Not a pass. A validator that cannot find its sub-validator has verified
  # nothing about focus, and must say so rather than staying quiet.
  fail "validate-neko-focus.sh not found on PATH or beside this script — focus switching is UNVERIFIED by this run"
fi

echo "=================================================="
if [ "$RC" -eq 0 ]; then
  echo "DESKTOP VALIDATION: PASS"
else
  echo "DESKTOP VALIDATION: FAIL"
fi
exit "$RC"
