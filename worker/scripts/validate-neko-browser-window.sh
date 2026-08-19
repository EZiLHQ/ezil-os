#!/usr/bin/env bash
# EZiL OS neko desktop — browser-window ground-truth validator.
#
# WHY THIS FILE EXISTS
# --------------------
# `worker/assets/ebuilder-openbox.xml` has asked for `<decor>no</decor>` on the
# browser window for the whole life of this repo, and the ONLY thing guarding it
# was `validate-neko-desktop.sh`'s `grep -q` for three literal substrings in that
# XML. A grep proves the string is in the file. It proves nothing about whether
# openbox ever matched the rule, and nothing at all about whether the window on
# screen has a titlebar. For that entire period nobody could tell the difference
# between "openbox is undecorating the browser" and "openbox never matched the
# rule". (Phase 0a established, by hand, that it DOES match — but that was luck,
# not coverage.)
#
# Likewise `neko-teardown-orphans.test.ts` / `neko-boot-devserver-isolation.test.ts`
# stub `wmctrl` with a canned `... chrome.Google-chrome ...` line — the test
# SUPPLIES the WM_CLASS the gate is looking for. Legitimate for what those suites
# cover, but it means the class string itself had never been compared to reality.
#
# Every assertion below therefore inspects the RUNNING SYSTEM: X properties on the
# live window, the geometry openbox actually gave the frame, the argv of the X
# server that is actually running, and real HTTP calls / real synthetic input
# against the live desktop. None of them can be satisfied by editing a config
# file. See docs/NEKO-GROUND-TRUTH.md for the hand-verified reference values.
#
# WHERE IT RUNS
#   Inside a live container, after start-neko.sh has passed its window-ready gate.
#
# IT IS DISRUPTIVE, BY NECESSITY
#   A resize round-trip really resizes the display, and the XTEST checks really
#   open and close a browser tab. Both restore what they touched before exiting.
#   Do not point this at a desktop a user is sitting in front of.
#
# OUTPUT CONTRACT (parsed by worker/src/neko-browser-window.container.test.ts)
#   One machine row per assertion on stdout:
#       ASSERT<TAB><status><TAB><class><TAB><id><TAB><detail>
#   status : PASS | FAIL | SKIP
#   class  : now              — behaviour that is already correct on main; a FAIL
#                               here is a REGRESSION.
#            awaiting:<agent> — behaviour a named agent has not landed yet; a FAIL
#                               here is EXPECTED until they do. Not a licence to
#                               ignore it: it must go green and then STAY green.
#   Human-readable narration goes to stderr.
#
# EXIT CODES
#   0  every assertion passed
#   1  at least one `now` assertion failed  -> a real regression
#   2  only `awaiting:*` assertions failed  -> the pending fixes have not landed
#   3  the validator could not run an assertion at all (SKIP present). A SKIP is
#      NEVER a pass; the caller must treat it as "unproven".
set -uo pipefail
export DISPLAY="${DISPLAY:-:99}"

FAIL_NOW=0
FAIL_AWAITING=0
SKIPPED=0

# Emit one machine row + a readable line on stderr.
emit() { # status class id detail
  printf 'ASSERT\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4"
  printf '%-4s [%-12s] %-38s %s\n' "$1" "$2" "$3" "$4" >&2
  case "$1:$2" in
    FAIL:now)         FAIL_NOW=$((FAIL_NOW + 1)) ;;
    FAIL:awaiting:*)  FAIL_AWAITING=$((FAIL_AWAITING + 1)) ;;
    SKIP:*)           SKIPPED=$((SKIPPED + 1)) ;;
  esac
}
pass() { emit PASS "$1" "$2" "$3"; }
bad()  { emit FAIL "$1" "$2" "$3"; }
skip() { emit SKIP "$1" "$2" "$3"; }

# assert_eq <class> <id> <expected> <actual> [note]
assert_eq() {
  local class="$1" id="$2" want="$3" got="$4" note="${5:-}"
  if [ "$want" = "$got" ]; then
    pass "$class" "$id" "observed '$got'${note:+ ($note)}"
  else
    bad "$class" "$id" "expected '$want', observed '$got'${note:+ ($note)}"
  fi
}

norm_id() {
  local v="${1:-}"
  [ -n "$v" ] || { echo ""; return; }
  if [[ "$v" == 0x* || "$v" == 0X* ]]; then printf '%d' "$v" 2>/dev/null || echo ""
  elif [[ "$v" =~ ^[0-9]+$ ]]; then echo "$v"
  else printf '%d' "0x$v" 2>/dev/null || echo ""; fi
}

for t in wmctrl xdotool xprop xwininfo xdpyinfo; do
  command -v "$t" >/dev/null 2>&1 || { echo "FATAL: $t missing" >&2; exit 3; }
done

echo "== EZiL OS browser-window validation ==" >&2

# ─────────────────────────────────────────────────────────────────────────────
# 1. The browser window, identified from the running WM's own client list.
# ─────────────────────────────────────────────────────────────────────────────
WIN_HEX="$(wmctrl -x -l 2>/dev/null | awk 'tolower($3) ~ /chrome/ {print $1; exit}')"
WIN_DEC="$(norm_id "$WIN_HEX")"
if [ -z "$WIN_DEC" ]; then
  bad now browser.window.present "no window with a chrome-ish WM_CLASS in wmctrl -x -l"
  echo "cannot continue without a browser window" >&2
  exit 1
fi
pass now browser.window.present "wmctrl client list has hex=$WIN_HEX dec=$WIN_DEC"

# The LITERAL WM_CLASS, recorded so it is never again an open question.
# xprop prints:  WM_CLASS(STRING) = "google-chrome (/tmp/...)", "Google-chrome"
WM_CLASS_RAW="$(xprop -id "$WIN_DEC" WM_CLASS 2>/dev/null)"
WM_INSTANCE="$(printf '%s' "$WM_CLASS_RAW" | sed -n 's/.*= "\([^"]*\)", "\([^"]*\)".*/\1/p')"
WM_CLASS="$(printf '%s' "$WM_CLASS_RAW" | sed -n 's/.*= "\([^"]*\)", "\([^"]*\)".*/\2/p')"
emit PASS now browser.wmclass.literal "instance='${WM_INSTANCE}' class='${WM_CLASS}'"

# ─────────────────────────────────────────────────────────────────────────────
# 2. The WM_CLASS the openbox rule targets vs. the WM_CLASS the window has.
#
#    This is THE check whose absence made the decoration question unanswerable.
#    The config path is taken from the argv of the openbox process that is
#    ACTUALLY RUNNING — not a hardcoded path — so this cannot be satisfied by
#    editing a file that nothing loads. The comparison is then live-window vs.
#    live-config: a `<decor>no</decor>` rule that targets a class no window has
#    is now a hard failure instead of a silent no-op.
# ─────────────────────────────────────────────────────────────────────────────
OB_ARGS="$(ps -eo args 2>/dev/null | grep -m1 '^openbox' || true)"
OB_CFG="$(printf '%s' "$OB_ARGS" | sed -n 's/.*--config-file[ =]\([^ ]*\).*/\1/p')"
if [ -z "$OB_ARGS" ]; then
  bad now openbox.running "no openbox process found in ps"
elif [ -z "$OB_CFG" ] || [ ! -f "$OB_CFG" ]; then
  bad now openbox.running "openbox is running but its --config-file could not be resolved (argv: $OB_ARGS)"
else
  pass now openbox.running "openbox running with config actually loaded from $OB_CFG"

  # Classes targeted by an <application> block that asks for <decor>no</decor>.
  UNDECOR_CLASSES="$(awk '
    /<application/ { inblock=1; cls=""; decor=0
                     if (match($0, /class="[^"]*"/))
                       { cls=substr($0, RSTART+7, RLENGTH-8) } }
    inblock && match($0, /class="[^"]*"/) && cls=="" \
                   { cls=substr($0, RSTART+7, RLENGTH-8) }
    inblock && /<decor>[[:space:]]*no[[:space:]]*<\/decor>/ { decor=1 }
    /<\/application>/ { if (inblock && decor && cls != "") print cls; inblock=0 }
  ' "$OB_CFG" 2>/dev/null)"

  if [ -z "$UNDECOR_CLASSES" ]; then
    bad now openbox.decor_rule.targets "the loaded openbox config declares NO <decor>no</decor> application rule at all"
  elif printf '%s\n' "$UNDECOR_CLASSES" | grep -qxF "$WM_CLASS"; then
    pass now openbox.decor_rule.targets \
      "live WM_CLASS '$WM_CLASS' is targeted by a <decor>no</decor> rule in $OB_CFG (rule set: $(echo $UNDECOR_CLASSES | tr '\n' ' '))"
  else
    bad now openbox.decor_rule.targets \
      "live WM_CLASS '$WM_CLASS' is NOT targeted by any <decor>no</decor> rule — the rule set is [$(echo $UNDECOR_CLASSES | tr '\n' ' ')], so the rule matches nothing and has never done anything"
  fi
fi

# openbox's own record of what it matched. If this disagrees with WM_CLASS then
# openbox is matching against something other than the class we think it is.
OB_APP_CLASS="$(xprop -id "$WIN_DEC" _OB_APP_CLASS 2>/dev/null | sed -n 's/.*= "\(.*\)"/\1/p')"
if [ -z "$OB_APP_CLASS" ]; then
  bad now openbox.matched_class "_OB_APP_CLASS absent — openbox is not managing this window"
else
  assert_eq now openbox.matched_class "$WM_CLASS" "$OB_APP_CLASS" "openbox's own _OB_APP_CLASS record"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. The window is GENUINELY undecorated — three independent runtime signals.
#    (docs/NEKO-GROUND-TRUTH.md §b is the hand-verified reference.)
# ─────────────────────────────────────────────────────────────────────────────
FRAME_EXTENTS="$(xprop -id "$WIN_DEC" _NET_FRAME_EXTENTS 2>/dev/null | sed -n 's/.*= //p' | tr -d ' ')"
if [ -z "$FRAME_EXTENTS" ]; then
  bad now browser.undecorated.frame_extents "_NET_FRAME_EXTENTS absent — the WM published no frame thickness at all"
else
  assert_eq now browser.undecorated.frame_extents "0,0,0,0" "$FRAME_EXTENTS" "left,right,top,bottom frame thickness"
fi

NET_WM_STATE="$(xprop -id "$WIN_DEC" _NET_WM_STATE 2>/dev/null)"
if printf '%s' "$NET_WM_STATE" | grep -q '_OB_WM_STATE_UNDECORATED'; then
  pass now browser.undecorated.ob_state "_OB_WM_STATE_UNDECORATED present in _NET_WM_STATE"
else
  bad now browser.undecorated.ob_state \
    "_OB_WM_STATE_UNDECORATED NOT in _NET_WM_STATE — openbox did not apply <decor>no</decor> (state: $(printf '%s' "$NET_WM_STATE" | sed -n 's/.*= //p'))"
fi

# Frame geometry vs client geometry. A decorating frame is TALLER than its client
# and offsets the client downward by the titlebar height; an undecorated one is
# pixel-identical. This is measured from the X server, not inferred.
geom_of() { # -> "WxH+X+Y"
  xwininfo -id "$1" 2>/dev/null | awk '
    /Absolute upper-left X:/ {x=$4}
    /Absolute upper-left Y:/ {y=$4}
    /^  Width:/  {w=$2}
    /^  Height:/ {h=$2}
    END { if (w != "") printf "%sx%s+%s+%s", w, h, x, y }'
}
PARENT_HEX="$(xwininfo -id "$WIN_DEC" -children 2>/dev/null | awk '/Parent window id:/{print $4; exit}')"
PARENT_DEC="$(norm_id "$PARENT_HEX")"
CLIENT_GEOM="$(geom_of "$WIN_DEC")"
ROOT_DEC="$(norm_id "$(xwininfo -root 2>/dev/null | awk '/Window id:/{print $4; exit}')")"
if [ -z "$PARENT_DEC" ] || [ -z "$CLIENT_GEOM" ]; then
  bad now browser.undecorated.frame_geometry "could not read parent/client geometry (parent='$PARENT_HEX' client='$CLIENT_GEOM')"
elif [ "$PARENT_DEC" = "$ROOT_DEC" ]; then
  # Not reparented at all: there is no frame, so there is trivially no decoration.
  pass now browser.undecorated.frame_geometry "client is a direct child of root (no reparenting frame at all); client=$CLIENT_GEOM"
else
  FRAME_GEOM="$(geom_of "$PARENT_DEC")"
  assert_eq now browser.undecorated.frame_geometry "$CLIENT_GEOM" "$FRAME_GEOM" \
    "openbox frame $PARENT_HEX vs client $WIN_HEX — a titlebar would make the frame taller and push the client down"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Chrome must not be drawing its OWN caption buttons.
#
#    _MOTIF_WM_HINTS = flags, functions, DECORATIONS, input_mode, status.
#    Field 3 (decorations) is the signal, and it was VERIFIED empirically in a
#    live container rather than assumed:
#
#      custom_chrome_frame absent/true  -> 0x2, 0x0, 0x0, ...  decorations = 0
#         Chrome tells the WM "do not decorate me, I draw my own frame", and the
#         screenshot shows minimize/restore/close inside the tab strip.
#      custom_chrome_frame = false      -> 0x2, 0x0, 0x1, ...  decorations = 1
#         Chrome asks the WM for a normal frame and draws NO caption buttons;
#         confirmed against actual pixels — the buttons are gone from the tab row.
#
#    So a NON-ZERO decorations field is a positive, machine-checkable statement
#    that Chrome is not drawing its own caption buttons. It is a property of the
#    running window, published by Chrome itself; no config file can fake it.
#
#    MEASURED CONSEQUENCE FOR W3 — openbox's rule is redundant TODAY and becomes
#    LOAD-BEARING once W3 lands. Verified by pointing a running openbox at a
#    config whose rule targets a class no window has: the browser stayed
#    undecorated anyway, because Chrome's own MWM_DECOR_NONE already suppresses
#    decoration. Repeat that with custom_chrome_frame=false and the window comes
#    back FULLY DECORATED (_NET_FRAME_EXTENTS = 1,1,20,5; frame 802x625+9+0 vs
#    client 800x600+10+20). After W3, the `<decor>no</decor>` rule is the ONLY
#    thing removing the titlebar — which is exactly why openbox.decor_rule.targets
#    above is a hard `now` assertion rather than a nicety.
# ─────────────────────────────────────────────────────────────────────────────
MOTIF_RAW="$(xprop -id "$WIN_DEC" _MOTIF_WM_HINTS 2>/dev/null | sed -n 's/.*= //p')"
MOTIF_DECOR="$(printf '%s' "$MOTIF_RAW" | awk -F', *' '{print $3}' | tr -d ' ')"

# What the LIVE profile that Chrome actually loaded says. Read from the profile
# in the running container's tmpfs (wiped and re-seeded every boot), not from a
# repo file — and used only to cross-check Chrome's behaviour, never as the
# assertion itself.
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-/tmp/chromium-app-data}"
PREFS="$CHROME_PROFILE_DIR/Default/Preferences"
PREF_STATE="absent"
if [ -f "$PREFS" ]; then
  if grep -q '"custom_chrome_frame":[[:space:]]*false' "$PREFS"; then PREF_STATE="false"
  elif grep -q '"custom_chrome_frame":[[:space:]]*true' "$PREFS"; then PREF_STATE="true"; fi
fi

if [ -z "$MOTIF_DECOR" ]; then
  # No _MOTIF_WM_HINTS at all also means Chrome is not suppressing decorations.
  pass now browser.chrome_frame.no_caption_buttons \
    "_MOTIF_WM_HINTS absent — Chrome is not asking the WM to skip decorations"
else
  case "$MOTIF_DECOR" in
    0x0|0)
      bad now browser.chrome_frame.no_caption_buttons \
        "_MOTIF_WM_HINTS decorations field is $MOTIF_DECOR (MWM_DECOR_NONE) — Chrome is drawing its OWN frame, i.e. its own minimize/restore/close inside the tab strip. W3 seeds browser.custom_chrome_frame=false in start-neko.sh and this was PASSING against ezil-integrated:local on 2026-08-19, so a red here is a REGRESSION, not a pending fix. Full hints: $MOTIF_RAW" ;;
    *)
      pass now browser.chrome_frame.no_caption_buttons \
        "_MOTIF_WM_HINTS decorations field is $MOTIF_DECOR (non-zero) — Chrome asked the WM to decorate it, so Chrome is NOT drawing its own caption buttons. Full hints: $MOTIF_RAW" ;;
  esac
fi

# Two-sided consistency: whatever the profile says, the window must agree with it.
# This catches the interesting failure "W3 seeded the pref and Chrome ignored it",
# which neither a file grep nor the property check alone would catch.
case "$PREF_STATE" in
  false)
    if [ -n "$MOTIF_DECOR" ] && { [ "$MOTIF_DECOR" = "0x0" ] || [ "$MOTIF_DECOR" = "0" ]; }; then
      bad now browser.chrome_frame.pref_honoured \
        "the live profile sets custom_chrome_frame=false but the window still reports MWM_DECOR_NONE — Chrome IGNORED the seeded preference"
    else
      pass now browser.chrome_frame.pref_honoured \
        "live profile sets custom_chrome_frame=false and the window agrees (decorations=$MOTIF_DECOR)"
    fi ;;
  true|absent)
    if [ -n "$MOTIF_DECOR" ] && { [ "$MOTIF_DECOR" = "0x0" ] || [ "$MOTIF_DECOR" = "0" ]; }; then
      pass now browser.chrome_frame.pref_honoured \
        "live profile custom_chrome_frame=$PREF_STATE and the window agrees (decorations=$MOTIF_DECOR, Chrome's Linux default is its own frame)"
    else
      bad now browser.chrome_frame.pref_honoured \
        "live profile custom_chrome_frame=$PREF_STATE but the window reports decorations=$MOTIF_DECOR — the two disagree; something other than the profile is driving Chrome's frame choice"
    fi ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# 5. Screen modes: the list, a REAL resize round-trip, and the refusal.
#    docs/NEKO-GROUND-TRUTH.md §e. Every leg is confirmed against the X server
#    and the window manager, not against the API's own echo of the request.
# ─────────────────────────────────────────────────────────────────────────────
NEKO_HOST="${NEKO_VALIDATE_HOST:-127.0.0.1}"
NEKO_PORT="${NEKO_HTTP_PORT:-8181}"
NEKO_BASE="http://${NEKO_HOST}:${NEKO_PORT}"
ADMIN_PW="${NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD:-${NEKO_PASSWORD_ADMIN:-}}"

# The framebuffer CEILING, read from the argv of the X server that is actually
# running. Not from the Dockerfile, not from a default in a script — from ps.
XSRV_ARGS="$(ps -eo args 2>/dev/null | grep -m1 -E '^(Xvfb|/usr/bin/Xvfb|Xorg|/usr/lib/xorg/Xorg)' || true)"
FB_W=""; FB_H=""
FB_SPEC="$(printf '%s' "$XSRV_ARGS" | sed -n 's/.*-screen[ ]\+[0-9]\+[ ]\+\([0-9]\+x[0-9]\+x[0-9]\+\).*/\1/p')"
if [ -n "$FB_SPEC" ]; then
  FB_W="${FB_SPEC%%x*}"
  FB_H="$(printf '%s' "$FB_SPEC" | cut -dx -f2)"
fi
if [ -n "$FB_W" ] && [ -n "$FB_H" ]; then
  pass now xserver.framebuffer "running X server framebuffer ceiling is ${FB_W}x${FB_H} (from argv: $XSRV_ARGS)"
else
  bad now xserver.framebuffer "could not read the framebuffer ceiling from the running X server argv: '$XSRV_ARGS'"
fi

dpy_dims() { xdpyinfo 2>/dev/null | awk '/^  dimensions:/{print $2; exit}'; }
win_dims() { wmctrl -x -l -G 2>/dev/null | awk -v id="$WIN_HEX" '$1==id {print $5"x"$6; exit}'; }

if [ -z "$ADMIN_PW" ]; then
  skip now screen.api "no admin password in env (NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD / NEKO_PASSWORD_ADMIN) — the screen API could not be exercised. UNPROVEN, not passing."
elif ! command -v curl >/dev/null 2>&1; then
  skip now screen.api "curl missing — the screen API could not be exercised. UNPROVEN, not passing."
else
  TOKEN="$(curl -s --max-time 10 -X POST "$NEKO_BASE/api/login" \
      -H 'Content-Type: application/json' \
      -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PW}\"}" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  if [ -z "$TOKEN" ]; then
    skip now screen.api "POST $NEKO_BASE/api/login returned no token — the screen API could not be exercised. UNPROVEN, not passing."
  else
    pass now screen.api.login "admin bearer token obtained from $NEKO_BASE/api/login (len=${#TOKEN})"

    # POST a size; echo "<http> <body>".
    set_screen() {
      curl -s --max-time 15 -o /tmp/ezil-screen.out -w '%{http_code}' \
        -X POST "$NEKO_BASE/api/room/screen" \
        -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
        -d "{\"width\":$1,\"height\":$2,\"rate\":60}"
    }

    CFG_JSON="$(curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "$NEKO_BASE/api/room/screen/configurations")"
    CFG_N="$(printf '%s' "$CFG_JSON" | grep -o '"width"' | wc -l | tr -d ' ')"
    if [ "${CFG_N:-0}" -ge 1 ]; then
      pass now screen.configurations "GET /api/room/screen/configurations lists $CFG_N mode(s): $CFG_JSON"
    else
      bad now screen.configurations "GET /api/room/screen/configurations returned no modes: $CFG_JSON"
    fi

    ORIG_DIMS="$(dpy_dims)"

    # (a) Downward resize must REALLY happen — X display and the window both follow.
    RC="$(set_screen 1280 720)"; sleep 2
    if [ "$RC" = "200" ] && [ "$(dpy_dims)" = "1280x720" ] && [ "$(win_dims)" = "1280x720" ]; then
      pass now screen.resize.downward "POST 1280x720 -> HTTP 200, xdpyinfo=$(dpy_dims), chrome window=$(win_dims)"
    else
      bad now screen.resize.downward "POST 1280x720 -> HTTP $RC, xdpyinfo=$(dpy_dims), chrome window=$(win_dims) (body: $(cat /tmp/ezil-screen.out 2>/dev/null))"
    fi

    # (b) A PORTRAIT mode from contract §3.
    #     The expectation is derived from the framebuffer the X server is ACTUALLY
    #     running with, so this assertion flips by itself the moment W1 raises it —
    #     there is no flag to set and no exemption to remember to remove.
    PORTRAIT_W=1080; PORTRAIT_H=1920
    if [ -n "$FB_W" ] && [ -n "$FB_H" ] && [ "$FB_W" -ge "$PORTRAIT_W" ] && [ "$FB_H" -ge "$PORTRAIT_H" ]; then
      RC="$(set_screen $PORTRAIT_W $PORTRAIT_H)"; sleep 2
      if [ "$RC" = "200" ] && [ "$(dpy_dims)" = "${PORTRAIT_W}x${PORTRAIT_H}" ] && [ "$(win_dims)" = "${PORTRAIT_W}x${PORTRAIT_H}" ]; then
        pass now screen.resize.portrait "POST ${PORTRAIT_W}x${PORTRAIT_H} -> HTTP 200, xdpyinfo=$(dpy_dims), chrome window=$(win_dims)"
      else
        bad now screen.resize.portrait "framebuffer is ${FB_W}x${FB_H} so ${PORTRAIT_W}x${PORTRAIT_H} MUST fit, but POST -> HTTP $RC, xdpyinfo=$(dpy_dims), chrome window=$(win_dims) (body: $(cat /tmp/ezil-screen.out 2>/dev/null))"
      fi
    else
      # Framebuffer too small: the CORRECT behaviour for this framebuffer is a
      # refusal, and that is asserted hard. The contract requirement (portrait
      # must be reachable) is what is still outstanding, and it is owned by W1.
      RC="$(set_screen $PORTRAIT_W $PORTRAIT_H)"; sleep 2
      BODY="$(cat /tmp/ezil-screen.out 2>/dev/null)"
      if [ "$RC" = "422" ] && printf '%s' "$BODY" | grep -q 'cannot set screen size'; then
        pass now screen.resize.portrait_refused_consistently \
          "framebuffer is ${FB_W}x${FB_H}, so portrait ${PORTRAIT_W}x${PORTRAIT_H} is correctly refused with HTTP 422 '$BODY'"
      else
        bad now screen.resize.portrait_refused_consistently \
          "framebuffer is ${FB_W}x${FB_H} so portrait ${PORTRAIT_W}x${PORTRAIT_H} must be refused with 422, but got HTTP $RC (body: $BODY)"
      fi
      bad now screen.resize.portrait \
        "contract §3 requires portrait ${PORTRAIT_W}x${PORTRAIT_H} to be settable, but the running framebuffer is only ${FB_W}x${FB_H}. W1 raises EZIL_X_FRAMEBUFFER to 1920x1920x24 in start-neko.sh and this was PASSING against ezil-integrated:local on 2026-08-19, so a red here is a REGRESSION, not a pending fix."
    fi

    # (c) The NEGATIVE case matters as much as the positive one: a mode larger
    #     than the framebuffer must be refused, and must not move the display.
    if [ -n "$FB_W" ] && [ -n "$FB_H" ]; then
      OVER_W=$((FB_W + 640)); OVER_H=$((FB_H + 360))
      BEFORE="$(dpy_dims)"
      RC="$(set_screen $OVER_W $OVER_H)"; sleep 2
      BODY="$(cat /tmp/ezil-screen.out 2>/dev/null)"
      AFTER="$(dpy_dims)"
      if [ "$RC" = "422" ] && printf '%s' "$BODY" | grep -q 'cannot set screen size' && [ "$BEFORE" = "$AFTER" ]; then
        pass now screen.resize.oversize_refused \
          "POST ${OVER_W}x${OVER_H} (> framebuffer ${FB_W}x${FB_H}) -> HTTP 422 '$BODY', display unchanged at $AFTER"
      else
        bad now screen.resize.oversize_refused \
          "POST ${OVER_W}x${OVER_H} (> framebuffer ${FB_W}x${FB_H}) -> HTTP $RC (body: $BODY); display went $BEFORE -> $AFTER (expected 422 and no change)"
      fi
    fi

    # (d) Restore. Contract §3: the desktop must always end up at 1920x1080.
    RC="$(set_screen 1920 1080)"; sleep 2
    if [ "$RC" = "200" ] && [ "$(dpy_dims)" = "1920x1080" ]; then
      pass now screen.restore "restored to 1920x1080 (was $ORIG_DIMS at entry)"
    else
      bad now screen.restore "FAILED to restore to 1920x1080: HTTP $RC, xdpyinfo=$(dpy_dims) — the desktop has been left in a non-default mode"
    fi
    # Give the window manager a moment to re-lay-out before the input checks.
    sleep 1
    WIN_HEX="$(wmctrl -x -l 2>/dev/null | awk 'tolower($3) ~ /chrome/ {print $1; exit}')"
    WIN_DEC="$(norm_id "$WIN_HEX")"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. XTEST input really reaches the browser.
#
#    docs/NEKO-GROUND-TRUTH.md §f proved this by hand with real synthetic events,
#    retiring the "UNVERIFIED" comment at start-neko.sh:1618 that stood for a long
#    time precisely because nothing checked it. This encodes it as a STANDING
#    check so a future change cannot silently break input again.
#
#    Deliberately network-free and reversible: Ctrl+T opens a tab (proving
#    keyboard events reach Chrome), a synthetic click on the first tab switches
#    back to it (proving POINTER events reach Chrome, not merely that the pointer
#    warped), and the extra tab is then closed. Closing the LAST tab would quit
#    Chrome and spend a supervise_app restart, so the close is guarded on the
#    extra tab actually being the active one.
# ─────────────────────────────────────────────────────────────────────────────
title_now() { xdotool getwindowname "$WIN_DEC" 2>/dev/null; }

xdotool windowactivate "$WIN_DEC" 2>/dev/null
sleep 1

# Input focus (not just "active window") is what XTEST key delivery depends on.
FOCUS_DEC="$(norm_id "$(xdotool getwindowfocus 2>/dev/null || echo 0)")"
assert_eq now xtest.input_focus "$WIN_DEC" "$FOCUS_DEC" "xdotool getwindowfocus vs the browser window"

# Pointer: XTEST motion is accepted by the X server and lands where asked.
xdotool mousemove 640 400 2>/dev/null; sleep 1
PTR="$(xdotool getmouselocation 2>/dev/null | sed -n 's/^x:\([0-9]*\) y:\([0-9]*\).*/\1,\2/p')"
assert_eq now xtest.pointer_warp "640,400" "$PTR" "XTEST pointer motion accepted by the X server"

TITLE0="$(title_now)"
if [ -z "$TITLE0" ]; then
  bad now xtest.keyboard_to_browser "could not read the browser window title, so input could not be proven"
else
  # Keyboard -> Chrome. No --window flag, so xdotool uses XTestFakeKeyEvent.
  xdotool key --clearmodifiers ctrl+t 2>/dev/null; sleep 3
  TITLE_T="$(title_now)"
  if [ "$TITLE_T" != "$TITLE0" ]; then
    pass now xtest.keyboard_to_browser \
      "synthetic Ctrl+T changed the window title '$TITLE0' -> '$TITLE_T' — real key events are reaching Chrome"
  else
    bad now xtest.keyboard_to_browser \
      "synthetic Ctrl+T did not change the window title (still '$TITLE0') — keyboard events are NOT reaching Chrome"
  fi

  # Pointer -> Chrome. Click the FIRST tab; the title must return to TITLE0.
  # This proves delivery to the application, which pointer warping alone does not.
  xdotool mousemove 150 20 2>/dev/null; sleep 1
  xdotool click 1 2>/dev/null; sleep 3
  TITLE_C="$(title_now)"
  if [ "$TITLE_C" = "$TITLE0" ]; then
    pass now xtest.pointer_to_browser \
      "a synthetic click on the first tab restored the title to '$TITLE0' — real button events are reaching Chrome"
  else
    bad now xtest.pointer_to_browser \
      "a synthetic click on the first tab left the title at '$TITLE_C' (expected '$TITLE0') — pointer events are not reaching Chrome's tab strip"
  fi

  # Cleanup: select the second tab and close it, but only if a second tab is
  # really there. Never close the last tab.
  xdotool key --clearmodifiers ctrl+2 2>/dev/null; sleep 2
  if [ "$(title_now)" != "$TITLE0" ]; then
    xdotool key --clearmodifiers ctrl+w 2>/dev/null; sleep 3
  fi
  TITLE_F="$(title_now)"
  assert_eq now xtest.restored "$TITLE0" "$TITLE_F" "the extra tab was closed and the browser is back where it started"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "==================================================" >&2
echo "now-failures=$FAIL_NOW awaiting-failures=$FAIL_AWAITING skipped=$SKIPPED" >&2
if [ "$SKIPPED" -gt 0 ]; then
  echo "BROWSER WINDOW VALIDATION: INCOMPLETE ($SKIPPED assertion(s) could not run — NOT a pass)" >&2
  exit 3
fi
if [ "$FAIL_NOW" -gt 0 ]; then
  echo "BROWSER WINDOW VALIDATION: FAIL (regression in behaviour that is known-good on main)" >&2
  exit 1
fi
if [ "$FAIL_AWAITING" -gt 0 ]; then
  echo "BROWSER WINDOW VALIDATION: PENDING (only awaiting:* assertions are red)" >&2
  exit 2
fi
echo "BROWSER WINDOW VALIDATION: PASS" >&2
exit 0
