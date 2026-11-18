#!/usr/bin/env bash
# code-folder-url-image.sh — Code's folder in the address bar against REAL code-server from a desktop image
# (folder-url-sync). Starts the image's own start-codeserver.sh on an internal (no-egress) Docker network, runs
# code-folder-url.mjs (real shell bundle + the Worker's real bridge), cleans up.
# Includes the content-free app-failure event/hello/parent delivery scenario; no model requests.
# TODO(app-failure-extension-host): coordinator runs a new VSIX + patched-workbench image for the host-command hop.
#   PLAYWRIGHT_REQUIRE_DIR=/path/to/node_modules [IMAGE=<desktop image>] e2e/code-folder-url-image.sh <evidence dir>
# Needs a built shell bundle (shell/build-shell.sh) and Playwright's Chromium, or PLAYWRIGHT_CHROMIUM_EXECUTABLE.
set -u
IMAGE="${IMAGE:-ezil-os-worker-staging-sandbox:81a397bf}" # the live Cloudflare image on 2026-11-05
NET=ezil-folderurl-net-$$
NAME=ezil-folderurl-cs-$$
EVIDENCE="${1:?evidence dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cleanup() { docker rm --force "$NAME" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT INT TERM
docker network create --internal "$NET" >/dev/null
docker run -d --name "$NAME" --network "$NET" --cpus=2 --memory=4g --entrypoint bash "$IMAGE" -c '
  mkdir -p /workspace/a/src /workspace/b/web "/workspace/my site"
  printf "hello from a\n" > /workspace/a/README.md
  repo=/workspace/projects/44444444-4444-8444-8444-444444444444/os-code-url-20261110-a
  mkdir -p "$repo/.vscode"
  printf "notes in b\n" > /workspace/b/notes.txt
  printf "# Repository focus fixture\n" > "$repo/README.md"
  # If Code ever loads the checkout as its workspace, this hides the README.
  printf "%s\n" "{\"files.exclude\":{\"README.md\":true}}" > "$repo/.vscode/settings.json"
  git init -qb main "$repo" &&
  git -C "$repo" add README.md .vscode/settings.json &&
  git -C "$repo" -c user.name="Fixture" -c user.email=fixture@example.test commit -qm "Seed repository" || exit 1
  # The existing edit/history case waits for autosave before switching the frame.
  mkdir -p /workspace/.ezil
  printf "%s\n" "{\"security.workspace.trust.enabled\":false,\"files.exclude\":{\"**/.ezil\":true},\"files.autoSave\":\"afterDelay\"}" > /workspace/.ezil/settings.json
  bash /usr/local/bin/start-codeserver.sh /workspace >/tmp/start.out 2>&1
  tail -f /tmp/code-server.log' >/dev/null
IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$NAME")"
for i in $(seq 1 90); do
  curl -fsS -o /dev/null "http://$IP:8443/healthz" 2>/dev/null && { echo "[code-folder-url] code-server up after ~${i}s at $IP"; break; }
  sleep 1
done
docker exec "$NAME" bash -c 'code-server --version | head -1; grep -c "" /tmp/code-server-data/User/settings.json; cat /tmp/code-server-data/User/settings.json' 2>/dev/null | head -30
timeout 900 node "$HERE/code-folder-url.mjs" "$IP" "$EVIDENCE"
rc=$?
echo "[code-folder-url] notes.txt on disk now:"; docker exec "$NAME" cat /workspace/b/notes.txt
echo "[code-folder-url] exit=$rc"
exit $rc
