#!/usr/bin/env bash
# code-trust-spike.sh — does a repository opened AS Code's folder stay inert under workspace trust? (folder-url-sync,
# checkout-root question). One fresh desktop-image container per scenario on an internal (no-egress) Docker network,
# a marker repository whose payloads only write <mark>/<surface>, code-trust-spike.mjs, cleanup. Settings are changed
# only inside the throwaway container; no live computer is touched.
#   F3_MARKERS_DIR=<dir with make_marker_repo.py and check_markers.sh> PLAYWRIGHT_REQUIRE_DIR=/path/to/node_modules \
#     [IMAGE=<desktop image>] e2e/code-trust-spike.sh <evidence dir> [<scenario> ...]
# Scenario: <name>:<layout real|alias|outside>:<person trusts /workspace first 0|1>:<workspace trust enabled 0|1>
#   real    — the checkout at /workspace/projects/<id>/repository (repo-open's layout)
#   alias   — Code opens /ezil-repos/<id>, a symlink to that checkout
#   outside — the checkout itself at /ezil-checkouts/<id>, outside /workspace
# Measured 2026-11-05 on ezil-os-worker-staging-sandbox:81a397bf (code-server 4.141.0), the default scenarios:
#   T0 (trust off) fired the terminal profile and env; trust on + nothing trusted, alias, outside: restricted, no
#   markers; trust on + the person trusted /workspace + the checkout under it: trusted by inheritance, markers fired.
#   Only the terminal surfaces fired even in T0, so "no markers" is a positive-controlled result for those alone.
set -u
IMAGE="${IMAGE:-ezil-os-worker-staging-sandbox:81a397bf}" # the live Cloudflare image on 2026-11-05
F="${F3_MARKERS_DIR:?set F3_MARKERS_DIR to the marker fixture (make_marker_repo.py, check_markers.sh)}"
EVIDENCE="${1:?evidence dir}"; shift
[ "$#" -gt 0 ] || set -- T0-off-real:real:0:0 R-fresh-real:real:0:1 M1-inherit-real:real:1:1 M5-alias-after-ws:alias:1:1 M6-outside-after-ws:outside:1:1
HERE="$(cd "$(dirname "$0")" && pwd)"
ID=0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e
REAL=/workspace/projects/$ID/repository
NET=""; NAME=""
cleanup() { [ -n "$NAME" ] && docker rm --force "$NAME" >/dev/null 2>&1; [ -n "$NET" ] && docker network rm "$NET" >/dev/null 2>&1; NAME=""; NET=""; }
trap cleanup EXIT INT TERM
for SPEC in "$@"; do
  IFS=: read -r SCN LAYOUT TW TRUST <<<"$SPEC"
  case "$LAYOUT" in
    real) DIR=$REAL; OPEN=$REAL ;;
    alias) DIR=$REAL; OPEN=/ezil-repos/$ID ;;
    outside) DIR=/ezil-checkouts/$ID; OPEN=$DIR ;;
    *) echo "[trust-spike] unknown layout in $SPEC"; continue ;;
  esac
  NET=ezil-trust-net-$$-$RANDOM; NAME=ezil-trust-cs-$$-$RANDOM; RUN=r$RANDOM; MARK=/var/tmp/f3-marker-$RUN
  docker network create --internal "$NET" >/dev/null
  docker create --name "$NAME" --network "$NET" --cpus=2 --memory=4g --entrypoint bash "$IMAGE" -c 'sleep infinity' >/dev/null
  docker cp "$F/make_marker_repo.py" "$NAME:/var/tmp/make_marker_repo.py"
  docker cp "$F/check_markers.sh" "$NAME:/var/tmp/check_markers.sh"
  docker start "$NAME" >/dev/null
  docker exec "$NAME" bash -lc "mkdir -p \$(dirname $DIR) /ezil-repos /workspace/mine && echo own > /workspace/mine/README.md && python3 -I /var/tmp/make_marker_repo.py --out $DIR --mark $MARK --run $RUN --checkout-abs $DIR >/var/tmp/make.out 2>&1" \
    || echo "[trust-spike] $SCN: fixture failed"
  [ "$LAYOUT" = alias ] && docker exec "$NAME" ln -sfn "$REAL" "$OPEN"
  docker exec -d "$NAME" bash -lc 'bash /usr/local/bin/start-codeserver.sh /workspace >/tmp/start.out 2>&1'
  IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$NAME")"
  for i in $(seq 1 90); do curl -fsS -o /dev/null "http://$IP:8443/healthz" 2>/dev/null && break; sleep 1; done
  T=False; [ "$TRUST" = 1 ] && T=True
  # -i: without it docker exec drops the heredoc and the settings are silently never written.
  docker exec -i "$NAME" python3 - <<PY
import json
p = '/tmp/code-server-data/User/settings.json'
s = json.load(open(p))
s['security.workspace.trust.enabled'] = $T
s['task.allowAutomaticTasks'] = 'off'
s['chat.mcp.autostart'] = 'never'
json.dump(s, open(p, 'w'), indent=2)
PY
  timeout 420 node "$HERE/code-trust-spike.mjs" "$IP" "$NAME" "$EVIDENCE" "$SCN" "$OPEN" "$MARK" "$RUN" "$TW" || echo "[trust-spike] $SCN exit=$?"
  cleanup
done
echo "[trust-spike] done; log: $EVIDENCE/trust-spike.log"
