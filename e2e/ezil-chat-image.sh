#!/usr/bin/env bash
# Boot the desktop image the way local mode does, prove the EZiL Chat contract
# on it, then boot it again as a RETURNING user and prove it still holds.
#
#   e2e/ezil-chat-image.sh [image=ezil-desktop:ezil-chat]
#
# Needs: docker, node, a Playwright install (PLAYWRIGHT_REQUIRE_DIR — a
# node_modules containing `playwright` with chromium downloaded; set
# PLAYWRIGHT_BROWSERS_PATH too if you put the browser somewhere custom).
# Output: EZIL_CHAT_E2E_OUT (default ./ezil-e2e-out) with fresh/ and
# returning/ subdirectories of screenshots, video, checks.json, and
# container-checks.txt with the in-image facts.
#
# Pass 1 — FRESH user. Empty workspace. In-container facts first (no browser):
#   * `ls lib/vscode/extensions` has no copilot; ezil-chat is there
#   * `code-server --list-extensions` (built-ins are NOT listed there — it
#     walks the user --extensions-dir; printed for the record, not asserted)
#   * `opencode --version` is the pinned version
#   * Machine/settings.json was written by start-neko.sh
# Then the mock provider (e2e/ezil-chat-mock-provider.mjs) is started INSIDE
# the container with the image's node, a project-level opencode.json in the
# workspace points OpenCode at it (the free `opencode` Zen provider is
# disabled so the default model is the mock), and e2e/ezil-chat.mjs drives a
# browser through a full prompt.
#
# Pass 2 — RETURNING user. The same workspace now carries `.ezil/settings.json`
# with `chat.disableAIFeatures: false` and `.ezil/extensions.txt` naming
# `GitHub.copilot-chat` (what start-neko.sh's editor-state capture would have
# saved for someone who used Copilot before), AND a pre-populated
# --user-data-dir (/tmp/code-server-data) whose User/settings.json also says
# `chat.disableAIFeatures: false` — the user setting that would mask the
# extension's configurationDefaults. The panel must still be there and
# Copilot must still be absent (Machine settings outrank User settings; the
# extension is a built-in, so no manifest restore can touch it). Prompt skipped.
set -euo pipefail

IMAGE="${1:-${EZIL_CHAT_E2E_IMAGE:-ezil-desktop:ezil-chat}}"
OUT="$(mkdir -p "${EZIL_CHAT_E2E_OUT:-./ezil-e2e-out}" && cd "${EZIL_CHAT_E2E_OUT:-./ezil-e2e-out}" && pwd)"
HOST_PORT="${EZIL_CHAT_E2E_PORT:-8443}"
MOCK_PORT=4141
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="ezil-chat-e2e-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ezil-chat-e2e.XXXXXX")"
fail=0

cleanup() { docker rm --force "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Same argv shape as local/src/container/run-spec.ts buildDockerRunArgv (mode
# neko, passwords, implicit hosting, loopback ICE) minus the WebRTC ports we do
# not need: only code-server's 8443 is published, on loopback.
#
# Files are seeded with `docker create` + `docker cp` + `docker start`, NOT the
# `--volume` bind mount local mode uses for the workspace: a bind mount names a
# path on the DAEMON's host, and when this script runs in a sandbox or CI job
# whose filesystem is not the daemon's (measured here: the mount came up empty
# and a marker written in the container never appeared outside), every seeded
# file silently vanishes and pass 2 tests nothing. `docker cp` goes through the
# daemon and works against any daemon the CLI can reach. <stage> mirrors the
# container root: <stage>/home/neko/project/..., <stage>/tmp/code-server-data/...
boot() { # boot <stage-dir>
  local stage="$1" top
  cleanup
  docker create --name "$NAME" --cpus=2 --memory=6g \
    --publish "127.0.0.1:${HOST_PORT}:8443/tcp" \
    --env DESKTOP_MODE=neko --env NEKO_SCREEN=1280x720x24 \
    --env NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko --env NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
    --env NEKO_SESSION_IMPLICIT_HOSTING=true \
    --env NEKO_WEBRTC_UDPMUX=52100 --env NEKO_WEBRTC_TCPMUX=52100 --env NEKO_WEBRTC_NAT1TO1=127.0.0.1 --env NEKO_WEBRTC_ICELITE=true \
    --env EZIL_WORKSPACE_ROOT=/home/neko/project \
    --entrypoint /bin/bash "$IMAGE" -c 'DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh' >/dev/null
  for top in "$stage"/*; do
    [[ -d "$top" ]] || continue
    docker cp "$top/." "$NAME:/$(basename "$top")"
  done
  docker start "$NAME" >/dev/null
  local i
  for i in $(seq 1 120); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${HOST_PORT}/healthz" 2>/dev/null; then
      echo "[e2e] code-server up after ~${i}s"; return 0
    fi
    sleep 1
  done
  echo "[e2e] FAIL: code-server never answered on :${HOST_PORT}" >&2
  docker logs "$NAME" 2>&1 | tail -40 >&2
  return 1
}

inx() { docker exec "$NAME" bash -lc "$*"; }

container_checks() { # container_checks <report-file>
  local rep="$1"; : >"$rep"
  local ok=1
  {
    echo "== code-server --version"; inx 'code-server --version 2>/dev/null | head -1'
    echo "== lib/vscode/extensions (copilot must be absent, ezil-chat present)"
    inx 'ls /usr/lib/code-server/lib/vscode/extensions | grep -i -E "copilot|ezil" || true'
    echo "== product.json defaultChatAgent present?"; inx 'grep -c defaultChatAgent /usr/lib/code-server/lib/vscode/product.json || true'
    echo "== code-server --list-extensions (user dir; built-ins are not listed here)"
    inx 'code-server --user-data-dir=/tmp/code-server-data --extensions-dir=/tmp/code-server-extensions --list-extensions 2>/dev/null || true'
    echo "== opencode --version"; inx 'opencode --version'
    echo "== /etc/opencode/opencode.json keys"; inx 'node -e "const j=require(\"/etc/opencode/opencode.json\");console.log(JSON.stringify({autoupdate:j.autoupdate,share:j.share,small_model:j.small_model,providers:Object.keys(j.provider||{})}))"'
    echo "== Machine/settings.json"; inx 'cat /tmp/code-server-data/Machine/settings.json'
    echo "== User/settings.json"; inx 'cat /tmp/code-server-data/User/settings.json'
  } 2>&1 | tee "$rep"
  inx 'test ! -e /usr/lib/code-server/lib/vscode/extensions/copilot' && echo "PASS  no copilot built-in dir" || { echo "FAIL  copilot built-in dir present"; ok=0; }
  inx '! ls /usr/lib/code-server/lib/vscode/extensions | grep -qi copilot' && echo "PASS  nothing named copilot among built-ins" || { echo "FAIL  something named copilot among built-ins"; ok=0; }
  inx 'test -f /usr/lib/code-server/lib/vscode/extensions/ezil-chat/package.json' && echo "PASS  ezil-chat built-in present" || { echo "FAIL  ezil-chat built-in missing"; ok=0; }
  inx '! grep -q defaultChatAgent /usr/lib/code-server/lib/vscode/product.json' && echo "PASS  product.json has no defaultChatAgent" || { echo "FAIL  product.json still has defaultChatAgent"; ok=0; }
  inx 'grep -q "\"chat.disableAIFeatures\": true" /tmp/code-server-data/Machine/settings.json' && echo "PASS  Machine settings disable built-in AI chat" || { echo "FAIL  Machine settings missing" ; ok=0; }
  [[ "$(inx 'opencode --version' | tr -d '\r')" == "opencode v"* ]] && echo "PASS  opencode on PATH: $(inx 'opencode --version')" || { echo "FAIL  opencode --version"; ok=0; }
  [[ $ok == 1 ]]
}

run_browser() { # run_browser <outdir> <prompt 0|1>
  EZIL_CODE_URL="http://127.0.0.1:${HOST_PORT}" EZIL_CHAT_E2E_FOLDER=/home/neko/project \
  EZIL_CHAT_E2E_OUT="$1" EZIL_CHAT_E2E_PROMPT="$2" node "$here/ezil-chat.mjs"
}

# ── Pass 1: fresh user ───────────────────────────────────────────────────────
echo "[e2e] pass 1 — fresh user, image $IMAGE"
ST1="$WORK/fresh"; WS1="$ST1/home/neko/project"; mkdir -p "$WS1"
# Project-level OpenCode config: mock provider on loopback (documented custom
# provider shape), default model = the mock, free Zen provider off so no
# credential-less network model can be picked instead.
cat >"$WS1/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "mock/mock-1",
  "providers": { "opencode": { "disabled": true } },
  "provider": {
    "mock": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "EZiL e2e mock",
      "options": { "baseURL": "http://127.0.0.1:${MOCK_PORT}/v1", "apiKey": "mock" },
      "models": { "mock-1": { "name": "mock-1 (e2e)" } }
    }
  }
}
EOF
echo 'hello from the e2e workspace' >"$WS1/README.md"
boot "$ST1"
container_checks "$OUT/fresh-container-checks.txt" || fail=1
docker cp "$here/ezil-chat-mock-provider.mjs" "$NAME:/tmp/ezil-chat-mock-provider.mjs"
docker exec -d "$NAME" bash -c "node /tmp/ezil-chat-mock-provider.mjs ${MOCK_PORT} pong >/tmp/mock-provider.log 2>&1"
sleep 1
inx "curl -fsS http://127.0.0.1:${MOCK_PORT}/v1/models" >/dev/null && echo "PASS  mock provider answers in-container" || { echo "FAIL  mock provider not reachable"; fail=1; }
run_browser "$OUT/fresh" 1 || fail=1
inx 'cat /tmp/mock-provider.log' >"$OUT/fresh-mock-provider.log" 2>/dev/null || true
inx 'grep -i -E "ezil|opencode|copilot|machine settings" /tmp/neko.log | tail -30' >"$OUT/fresh-neko-log-excerpt.txt" 2>/dev/null || true

# ── Pass 2: returning user ───────────────────────────────────────────────────
echo "[e2e] pass 2 — returning user with restored .ezil/ state and a masking User settings.json"
ST2="$WORK/returning"; WS2="$ST2/home/neko/project"; mkdir -p "$WS2/.ezil"
cp "$WS1/opencode.json" "$WS2/opencode.json"
cat >"$WS2/.ezil/settings.json" <<'EOF'
{ "security.workspace.trust.enabled": false, "chat.disableAIFeatures": false, "workbench.secondarySideBar.defaultVisibility": "hidden", "editor.fontSize": 15 }
EOF
printf 'GitHub.copilot-chat\nGitHub.copilot\n' >"$WS2/.ezil/extensions.txt"
UD2="$ST2/tmp/code-server-data"; mkdir -p "$UD2/User"
cp "$WS2/.ezil/settings.json" "$UD2/User/settings.json"
boot "$ST2"
container_checks "$OUT/returning-container-checks.txt" || fail=1
run_browser "$OUT/returning" 0 || fail=1
inx 'grep -i -E "editor state|reinstall|copilot" /tmp/neko.log | tail -20' >"$OUT/returning-neko-log-excerpt.txt" 2>/dev/null || true

rm -rf "$WORK" 2>/dev/null || true
if [[ $fail == 0 ]]; then echo "[e2e] ALL PASSED — artifacts in $OUT"; else echo "[e2e] FAILURES — see $OUT" >&2; fi
exit $fail
