#!/usr/bin/env bash
# Real-workbench check of the EZiL Chat bridge, offline and isolated. It runs an existing desktop image on an
# --internal Docker network (no egress) and overlays exactly the bridge's runtime files:
#   - workbench.js produced by worker/copilot-chat/patch-copilot-chat.sh (with [chat-bridge]) from the
#     pristine code-server 4.141.0 deb, and
#   - the ezil-models extension built from extensions/ezil-models (sync client).
# Inside the container it runs the offline messages mock and the stand-in OS (chat-bridge-os-standin.mjs),
# then drives the browser with chat-bridge-workbench.mjs. Nothing is published, built, pushed or deployed.
# Usage: PLAYWRIGHT_REQUIRE_DIR=/path/to/node_modules e2e/chat-bridge-workbench.sh <image> <patched workbench.js> <extension dir>
# EZIL_E2E_SUITE=controls runs the protocol-2 suite instead (chat-bridge-controls-standin.mjs + chat-bridge-controls.mjs).
set -euo pipefail
IMAGE="$1"; WORKBENCH="$2"; EXT="$3"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(mkdir -p "${EZIL_E2E_OUT:-./chat-bridge-e2e-out}" && cd "${EZIL_E2E_OUT:-./chat-bridge-e2e-out}" && pwd)"
NAME="chat-bridge-e2e-$$"; NETWORK="chat-bridge-e2e-net-$$"; PORT="${EZIL_E2E_PORT:-18444}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/chat-bridge-e2e.XXXXXX")"
AI_TOKEN="$(openssl rand -hex 32)"; BRIDGE_TOKEN="$(openssl rand -hex 32)"
FORWARD_PID=""
STANDIN=chat-bridge-os-standin.mjs; DRIVER=chat-bridge-workbench.mjs; MODELS=copilot-ezil-models.json
if [[ "${EZIL_E2E_SUITE:-}" == controls ]]; then STANDIN=chat-bridge-controls-standin.mjs; DRIVER=chat-bridge-controls.mjs; MODELS=copilot-ezil-models-controls.json; fi
cleanup() {
  [[ -n "$FORWARD_PID" ]] && kill "$FORWARD_PID" 2>/dev/null || true
  docker exec "$NAME" bash -c 'cat /tmp/standin.log /tmp/mock.log 2>/dev/null | tail -40' >"$OUT/servers.log" 2>&1 || true
  docker exec "$NAME" bash -c 'for f in /tmp/code-server-data/logs/*/exthost*/exthost.log /tmp/code-server-data/logs/*/exthost*/output_logging_*/*EZiL*.log /tmp/code-server-data/logs/*/exthost*/GitHub.copilot-chat/*.log; do echo "== $f"; grep -v -i -E "token|bearer" "$f" | tail -60; done' >"$OUT/exthost.log" 2>&1 || true
  [[ -n "${EZIL_E2E_KEEP:-}" ]] && { echo "kept container $NAME"; return; }
  docker logs "$NAME" >"$OUT/container.log" 2>&1 || true
  docker rm --force "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
VS=/usr/lib/code-server/lib/vscode
ST="$WORK/stage"
mkdir -p "$ST/etc/ezil" "$ST/home/neko/project" "$ST$VS/out/vs/code/browser/workbench" "$ST$VS/extensions/ezil.ezil-models/dist" "$ST/tmp/e2e"
cp "$here/$MODELS" "$ST/etc/ezil/models.e2e.json"
echo 'hello from the chat bridge e2e workspace' >"$ST/home/neko/project/README.md"
cp "$WORKBENCH" "$ST$VS/out/vs/code/browser/workbench/workbench.js"
cp "$EXT/package.json" "$ST$VS/extensions/ezil.ezil-models/package.json"
cp "$EXT/dist/extension.js" "$ST$VS/extensions/ezil.ezil-models/dist/extension.js"
cp "$here/copilot-ezil-messages-mock.mjs" "$here/$STANDIN" "$ST/tmp/e2e/"

docker network create --internal "$NETWORK" >/dev/null
docker create --name "$NAME" --network "$NETWORK" --cpus=2 --memory=6g \
  --env DESKTOP_MODE=neko --env NEKO_SCREEN=1280x720x24 \
  --env NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko --env NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
  --env NEKO_SESSION_IMPLICIT_HOSTING=true --env NEKO_WEBRTC_UDPMUX=52100 --env NEKO_WEBRTC_TCPMUX=52100 \
  --env NEKO_WEBRTC_NAT1TO1=127.0.0.1 --env NEKO_WEBRTC_ICELITE=true \
  --env EZIL_WORKSPACE_ROOT=/home/neko/project --env EZIL_MODELS_CONFIG=/etc/ezil/models.e2e.json \
  --env EZIL_AI_BASE_URL="http://127.0.0.1:4142/ai/v1" --env EZIL_AI_PROXY_TOKEN="$AI_TOKEN" --env EZIL_E2E_TEST_TOKEN="$AI_TOKEN" \
  --env EZIL_EDITOR_BRIDGE_TOKEN="$BRIDGE_TOKEN" --env EZIL_STANDIN_NEWCHAT="${EZIL_STANDIN_NEWCHAT:-}" --env EZIL_STANDIN_LEASE_MS="${EZIL_STANDIN_LEASE_MS:-30000}" --env EZIL_STANDIN_ALLOW="${EZIL_STANDIN_ALLOW:-}" \
  --entrypoint /bin/bash "$IMAGE" -c "node /tmp/e2e/copilot-ezil-messages-mock.mjs 4143 /home/neko/project /tmp/mock >/tmp/mock.log 2>&1 & node /tmp/e2e/$STANDIN 4142 4143 $BRIDGE_TOKEN $AI_TOKEN >/tmp/standin.log 2>&1 & DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh" >/dev/null
for top in "$ST"/*; do docker cp "$top/." "$NAME:/$(basename "$top")"; done
docker start "$NAME" >/dev/null
ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$NAME")"
node -e 'const net=require("net");const [port,host]=process.argv.slice(1);net.createServer(c=>{const u=net.connect(8443,host);c.pipe(u).pipe(c);u.on("error",()=>c.destroy());c.on("error",()=>u.destroy())}).listen(+port,"127.0.0.1")' "$PORT" "$ip" &
FORWARD_PID=$!
for i in $(seq 1 150); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/healthz" || { echo "FAIL: code-server never answered" >&2; exit 1; }
# editor-state.sh writes the settings files at start; health can answer first under load.
for i in $(seq 1 60); do docker exec "$NAME" test -f /tmp/code-server-data/Machine/settings.json && break; sleep 1; done
# The bridge is off by default: turn it on for this machine (the setting both the workbench and the extension read)
# before any window opens, and prove the overlaid files are the ones served.
docker exec "$NAME" node -e '
// The settings files are JSONC written by editor-state.sh: insert the key as text, never re-serialize them.
const fs=require("fs");
for (const f of ["/tmp/code-server-data/Machine/settings.json","/tmp/code-server-data/User/settings.json"]) {
  const text=fs.readFileSync(f,"utf8"); const at=text.indexOf("{");
  if (at<0) throw new Error("unexpected settings file "+f);
  if (!text.includes("\"ezil.chatBridge.enabled\"")) fs.writeFileSync(f,text.slice(0,at+1)+"\n  \"ezil.chatBridge.enabled\": true,"+text.slice(at+1));
}'
docker exec "$NAME" grep -q '"chat.allowAnonymousAccess": true' /tmp/code-server-data/Machine/settings.json
docker exec "$NAME" sha256sum "$VS/out/vs/code/browser/workbench/workbench.js" | tee "$OUT/served-workbench.sha256"
docker exec "$NAME" grep -c "_ezil.chatBridge.v1" "$VS/out/vs/code/browser/workbench/workbench.js" >/dev/null || echo "NOTE: workbench without the bridge patch"
status=0
EZIL_CODE_URL="http://127.0.0.1:$PORT" EZIL_E2E_CONTAINER="$NAME" EZIL_E2E_OUT="$OUT" node "$here/$DRIVER" || status=$?
exit $status
