#!/usr/bin/env bash
# Isolated X11 clipboard acceptance; never touches a running user's display.
set -euo pipefail
for executable in Xvfb xclip xdpyinfo timeout; do
    command -v "$executable" >/dev/null || { echo "FAIL clipboard: missing $executable" >&2; exit 1; }
done
scratch="$(mktemp -d)"
display_pid=''
cleanup() {
    if [ -n "$display_pid" ]; then
        kill "$display_pid" 2>/dev/null || true
        wait "$display_pid" 2>/dev/null || true
    fi
    rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
Xvfb -displayfd 3 -screen 0 640x480x24 -nolisten tcp 3>"$scratch/display" >"$scratch/xvfb.log" 2>&1 &
display_pid=$!
for ((attempt=0; attempt<100; attempt++)); do
    [ ! -s "$scratch/display" ] || break
    kill -0 "$display_pid" 2>/dev/null || { echo 'FAIL clipboard: X server exited' >&2; exit 1; }
    sleep 0.1
done
display_number="$(cat "$scratch/display")"
[[ "$display_number" =~ ^[0-9]+$ ]] || { echo 'FAIL clipboard: X server deadline' >&2; exit 1; }
export DISPLAY=":$display_number"
export LC_ALL=C.UTF-8
timeout 5 xdpyinfo >/dev/null
for text in 'clipboard: punctuation !? @ # /' $'UTF-8: café 日本語\nsecond line' 'replacement' ''; do
    # These are the same arguments used by the pinned Neko desktop manager.
    printf '%s' "$text" | timeout 5 xclip -selection clipboard -in -target UTF8_STRING
    actual="$(timeout 5 xclip -selection clipboard -out -target UTF8_STRING)"
    [ "$actual" = "$text" ] || { echo 'FAIL clipboard: text mismatch' >&2; exit 1; }
done
echo 'PASS clipboard: plain text, UTF-8, multiline, replacement and empty content'
