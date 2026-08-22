#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# validate-screen-modes.sh — drive EVERY mode in SCREEN_MODES through a real
# container and confirm, four independent ways, that the display really became
# that size.
#
# Run:  bash worker/scripts/validate-screen-modes.sh
#       IMAGE=ezil-integrated:local  (override to test another build)
#
# WHY THIS EXISTS
# ---------------
# `worker/src/index.ts` claims, in the doc comment above `handleScreen`, that
# every mode was "driven through this endpoint against a real container and
# confirmed four ways". That claim was true when it was written and there was
# nothing to keep it true. This script is what keeps it true: it reads the
# table out of `worker/src/screen-modes.ts` at run time, so a mode added to the
# table without being verified shows up here as a row, not as an omission.
#
# THE FOUR WAYS, AND WHY EACH ONE IS NEEDED
# -----------------------------------------
#   1. POST /api/room/screen returns 200. A mode that does not fit inside the
#      Xvfb framebuffer answers 422 — this is the only check that catches a
#      table entry the platform will not accept at all.
#   2. GET /api/room/screen. 🔴 NOT the POST's response body. Measured and
#      recorded in index.ts: POSTing 900x1600 answers 200 and echoes
#      {"width":900,"height":1600} while the display is actually 896x1600,
#      because Xvfb floors the width to a multiple of 8. The POST echoes the
#      REQUEST. Only the GET is an observation.
#   3. xdpyinfo. The X server's own answer, owing nothing to neko — this is
#      what catches neko reporting a size it did not actually apply.
#   4. neko's screenshot endpoint, measured from the image header. This is the
#      one that proves the CAPTURE PIPELINE followed the display, not merely
#      that the X server resized. A mode where 1-3 agree and 4 disagrees would
#      be a screen the user cannot actually see.
#
# The two control modes are shipped, long-known-good entries. They are here so
# that a harness failure (a missing tool, a bad token, an endpoint that moved)
# reports itself as "the controls failed too" rather than as "the new modes are
# broken" — the failure mode this project has hit more than once.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

IMAGE="${IMAGE:-ezil-integrated:local}"
MODES_TS="worker/src/screen-modes.ts"
CONTROL_MODES="1920x1080 1080x1920"
C="ezil-modecheck-$$"

command -v docker >/dev/null 2>&1 || { echo "docker is not available — SKIPPING, not passing."; exit 2; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not present — SKIPPING, not passing."; exit 2; }
[ -f "$MODES_TS" ] || { echo "cannot find $MODES_TS — the table guard has lost its target."; exit 2; }

# The table, read from source. Anything that changes the table changes this list.
ALL_MODES=$(sed -n 's/^[[:space:]]*{ width: \([0-9]\+\), height: \([0-9]\+\) },.*/\1x\2/p' "$MODES_TS")
[ -n "$ALL_MODES" ] || { echo "parsed ZERO modes out of $MODES_TS — a green run here would be a false green."; exit 2; }
echo "modes read from $MODES_TS: $(echo "$ALL_MODES" | wc -l)"

cleanup(){ docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "booting $IMAGE ..."
docker run -d --name "$C" --cpus=2 \
  -e DESKTOP_MODE=neko -e EZIL_BROWSER_SIDECAR=off \
  -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=s1admin -e NEKO_PASSWORD_ADMIN=s1admin \
  -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=s1user  -e NEKO_PASSWORD=s1user \
  --entrypoint /bin/bash "$IMAGE" \
  -c 'DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh' >/dev/null || { echo "docker run failed"; exit 2; }

for _ in $(seq 1 180); do
  docker exec "$C" grep -qc 'phase=ready' /tmp/neko.log 2>/dev/null && break
  [ "$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null)" = "true" ] || {
    echo "container exited before ready:"; docker logs --tail 30 "$C"; exit 2; }
  sleep 1
done
docker exec "$C" grep -qc 'phase=ready' /tmp/neko.log 2>/dev/null || { echo "never became ready"; exit 2; }

# Same login the Worker performs (`handleScreen`): any username, the admin password.
TOKEN=$(docker exec "$C" bash -lc \
  'curl -s -X POST -H "Content-Type: application/json" -d "{\"username\":\"ezil-os-screen\",\"password\":\"s1admin\"}" http://127.0.0.1:8181/api/login' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "could not obtain a neko admin token — SKIPPING, not passing."; exit 2; }

read -r -d '' PNGJPG_DIMS <<'PYEOF'
import struct
def dims(p):
    try: d = open(p, "rb").read()
    except Exception: return None
    if d[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", d[16:24]); return f"{w}x{h}"
    if d[:2] == b"\xff\xd8":
        i = 2
        while i < len(d) - 9:
            if d[i] != 0xFF: i += 1; continue
            m = d[i + 1]
            if m in (0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF):
                h, w = struct.unpack(">HH", d[i + 5:i + 9]); return f"{w}x{h}"
            if m in (0xD8, 0xD9) or 0xD0 <= m <= 0xD7: i += 2; continue
            i += 2 + struct.unpack(">H", d[i + 2:i + 4])[0]
    return None
for p in ("/tmp/shot.img", "/tmp/shot2.img"):
    r = dims(p)
    if r: print(r); break
PYEOF

fails=0; control_fails=0
printf '\n%-11s %-8s %-6s %-12s %-12s %-14s %s\n' MODE KIND POST readback xdpyinfo screenshot VERDICT
check_mode () {
  local mode="$1" kind="$2" w="${1%x*}" h="${1#*x}" post api xdpy shot verdict
  post=$(docker exec "$C" bash -lc \
    "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' \
     -d '{\"width\":$w,\"height\":$h,\"rate\":30}' http://127.0.0.1:8181/api/room/screen")
  sleep 2
  api=$(docker exec "$C" bash -lc "curl -s -H 'Authorization: Bearer $TOKEN' http://127.0.0.1:8181/api/room/screen" \
        | sed -n 's/.*"width":\([0-9]*\).*"height":\([0-9]*\).*/\1x\2/p')
  xdpy=$(docker exec "$C" bash -lc 'DISPLAY=:99 xdpyinfo 2>/dev/null | sed -n "s/.*dimensions: *\([0-9]*x[0-9]*\).*/\1/p" | head -1')
  docker exec "$C" bash -lc \
    "curl -s -H 'Authorization: Bearer $TOKEN' 'http://127.0.0.1:8181/api/room/screen/shot.jpg?quality=60' -o /tmp/shot.img; \
     curl -s -H 'Authorization: Bearer $TOKEN' 'http://127.0.0.1:8181/api/room/screen/cast.jpg' -o /tmp/shot2.img 2>/dev/null || true" >/dev/null 2>&1
  shot=$(docker exec "$C" python3 -c "$PNGJPG_DIMS" 2>/dev/null)
  docker exec "$C" bash -lc 'rm -f /tmp/shot.img /tmp/shot2.img' >/dev/null 2>&1

  if [ "$post" = "200" ] && [ "$api" = "$mode" ] && [ "$xdpy" = "$mode" ] && [ "$shot" = "$mode" ]; then
    verdict="CONFIRMED x4"
  else
    verdict="MISMATCH"; fails=$((fails+1))
    [ "$kind" = "control" ] && control_fails=$((control_fails+1))
  fi
  printf '%-11s %-8s %-6s %-12s %-12s %-14s %s\n' "$mode" "$kind" "${post:--}" "${api:--}" "${xdpy:--}" "${shot:--}" "$verdict"
}

for m in $CONTROL_MODES; do check_mode "$m" "control"; done
for m in $ALL_MODES; do
  case " $CONTROL_MODES " in *" $m "*) continue ;; esac
  check_mode "$m" "table"
done

echo
if [ "$control_fails" -gt 0 ]; then
  echo "🔴 $control_fails CONTROL mode(s) failed. The instrument is broken, not the table —"
  echo "   do not read the table rows above as evidence about those modes."
  exit 2
fi
if [ "$fails" -eq 0 ]; then echo "ALL $(echo "$ALL_MODES" | wc -l) TABLE MODES CONFIRMED FOUR WAYS"; exit 0; fi
echo "🔴 $fails mode(s) in the table could not be confirmed."; exit 1
