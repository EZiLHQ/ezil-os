#!/usr/bin/env bash
# Coordinator only. Linux Docker host with local daemon bind mounts and a built shell + branch VSIX.
# IMAGE=ezil-os-desktop:wbebfcc0a PLAYWRIGHT_REQUIRE_DIR=/path/to/node_modules \
#   FAULT_VARIANT=missing_terminal e2e/code-app-failure-image.sh /tmp/code-app-failure-evidence
# Repeat with FAULT_VARIANT=settlement_pending and a different evidence directory.
# SHELL_ASSETS_DIR may name an isolated shell/build-shell.sh output; defaults to app/public/os.
# No Docker pulls, package installs, external gateway, body capture, console capture or chat-log export.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TREE="$(cd "$HERE/.." && pwd)"
IMAGE="${IMAGE:-ezil-os-desktop:wbebfcc0a}"
FAULT_VARIANT="${FAULT_VARIANT:-missing_terminal}"
EVIDENCE="${1:?evidence directory}"
VSIX="${VSIX:-$TREE/worker/ezil-models/dist/ezil-models-0.1.0.vsix}"
PATCH_SCRIPT="$TREE/worker/copilot-chat/patch-copilot-chat.sh"
NET="ezil-appfailure-net-$$"
NAME="ezil-appfailure-code-$$"
case "$FAULT_VARIANT" in missing_terminal|settlement_pending) ;; *) echo 'FAIL unsupported variant'; exit 2;; esac
[[ -s "$VSIX" && -s "$PATCH_SCRIPT" ]] || { echo 'FAIL branch VSIX or patch missing'; exit 1; }
cleanup() {
  docker rm --force "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
trap 'echo "FAIL image scenario (details intentionally not captured)" >&2' ERR
docker image inspect "$IMAGE" >/dev/null 2>&1 # local images only; no pull
docker network create --internal "$NET" >/dev/null
docker run --pull=never -d --name "$NAME" --network "$NET" --cpus=2 --memory=6g \
  --mount "type=bind,src=$VSIX,dst=/fixture/ezil-models.vsix,readonly" \
  --mount "type=bind,src=$PATCH_SCRIPT,dst=/fixture/patch-copilot-chat.sh,readonly" \
  --mount "type=bind,src=$HERE/code-app-failure-mock.mjs,dst=/fixture/mock.mjs,readonly" \
  --env "FAULT_VARIANT=$FAULT_VARIANT" --env EZIL_MODELS_CONFIG=/tmp/app-failure-models.json \
  --env EZIL_AI_BASE_URL=http://127.0.0.1:4142/ai/v1 --env EZIL_AI_PROXY_TOKEN=synthetic-test-only \
  --env APPLICATION_INSIGHTS_NO_STATSBEAT=true --entrypoint bash "$IMAGE" -c '
    set -euo pipefail
    # Same built-in VSIX installation as worker/Dockerfile. Replace only the vendor extension.
    mkdir -p /tmp/app-failure-vsix /workspace
    unzip -q /fixture/ezil-models.vsix "extension/*" -d /tmp/app-failure-vsix
    node -e '\''const p=require("/tmp/app-failure-vsix/extension/package.json");if(p.publisher!=="ezil"||p.name!=="ezil-models"||!p.contributes.languageModelChatProviders.some(p=>p.vendor==="ezil"))process.exit(1)'\''
    rm -rf /usr/lib/code-server/lib/vscode/extensions/ezil.ezil-models
    mv /tmp/app-failure-vsix/extension /usr/lib/code-server/lib/vscode/extensions/ezil.ezil-models
    # Both gates must complete BEFORE the server launches. Older partially patched images fail closed.
    bash /fixture/patch-copilot-chat.sh /usr/lib/code-server/lib/vscode >/dev/null 2>&1
    bash /fixture/patch-copilot-chat.sh --verify /usr/lib/code-server/lib/vscode >/dev/null 2>&1
    touch /tmp/app-failure-patch-passed
    node /fixture/mock.mjs --config >/tmp/app-failure-models.json
    node /fixture/mock.mjs >/dev/null 2>&1 &
    for ((i=0;i<30;i++)); do curl -fsS http://127.0.0.1:4142/healthz >/dev/null 2>&1 && break; sleep 1; done
    curl -fsS http://127.0.0.1:4142/healthz >/dev/null 2>&1
    bash /usr/local/bin/start-codeserver.sh /workspace >/dev/null 2>&1
    # Keep container alive; never tail /tmp/code-server.log or export chat state.
    exec sleep infinity
  ' >/dev/null
IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$NAME")"
ready=0
for ((i=0;i<120;i++)); do
  if curl -fsS -o /dev/null "http://$IP:8443/healthz" 2>/dev/null; then ready=1; break; fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" == true ]] || break
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'FAIL prestart install/patch/verify or code-server readiness (no container logs exported)'; exit 1; }
docker exec "$NAME" test -f /tmp/app-failure-patch-passed
printf 'PASS branch VSIX installed and branch patch applied/verified before code-server\n'
NODE_NO_WARNINGS=1 FAULT_VARIANT="$FAULT_VARIANT" timeout "${SCENARIO_TIMEOUT:-600}" node "$HERE/code-app-failure.mjs" "$IP" "$EVIDENCE"
