#!/usr/bin/env bash
# Boot the desktop image the way local mode does and prove that the bundled
# open-source Copilot Chat runs on EZiL-configured models with NO GitHub
# sign-in — then boot it again as a RETURNING user and prove it still holds.
#
#   e2e/copilot-ezil-image.sh [image=ezil-desktop:rev3]
#
# Needs: docker, node, a Playwright install (PLAYWRIGHT_REQUIRE_DIR — a
# node_modules containing `playwright` with chromium downloaded; set
# PLAYWRIGHT_BROWSERS_PATH too if you put the browser somewhere custom).
# Output: EZIL_COPILOT_E2E_OUT (default ./ezil-e2e-out) with fresh/ and
# returning/ subdirectories of screenshots, video, checks.json, plus the
# in-image facts, the mock's capture and the Copilot Chat / EZiL Models logs.
#
# Pass 1 — FRESH user. Empty workspace. In-container facts first (no browser):
#   * `lib/vscode/extensions` has copilot (KEPT since revision 2), ezil-models
#     and ezil-chat; product.json still has defaultChatAgent
#   * /etc/ezil/models.json is the shipped template (env references only)
#   * Machine/settings.json and User/chatLanguageModels.json were written by
#     start-neko.sh; the container env carries EZIL_MODELS_CONFIG
# Then the mock model (e2e/copilot-ezil-mock-provider.mjs) is started INSIDE
# the container with the image's node; the built-in ezil-models extension was
# pointed at it at `docker create` time through EZIL_MODELS_CONFIG (a
# test-only config, e2e/copilot-ezil-models.json, copied to
# /etc/ezil/models.e2e.json — the env override the extension documents), and
# e2e/copilot-ezil.mjs drives a fresh browser through an Agent-mode task.
#
# Pass 2 — RETURNING user. The same workspace now carries `.ezil/settings.json`
# with `chat.disableAIFeatures: true`, `chat.allowAnonymousAccess: false` and a
# hidden secondary sidebar (what a revision-1-era user, or anyone who poked at
# settings, could have persisted), `.ezil/extensions.txt` naming
# `GitHub.copilot-chat`, a pre-populated --user-data-dir whose
# User/settings.json says the same, AND a User/chatLanguageModels.json that
# already holds a foreign BYOK group. The Machine layer must still win (chat
# on, anonymous on, sidebar visible), the group file must be MERGED (both
# vendors present), and the same Agent-mode task must succeed.
set -euo pipefail

#
# Revision 3 — NO GitHub calls, "EZiL Chat" branding. Both passes run behind a
# network sink: a sidecar DNS server (e2e/copilot-ezil-netsink.py `dns`, given
# to the image container as --dns) answers 127.0.0.1 for EVERY name and logs
# the query, and inside the container the same script (`http`) listens on
# :80/:443 and logs Host/path/SNI of whatever lands there. After boot plus the
# full Agent-mode prompt the run FAILS if any name or SNI matched a GitHub,
# githubusercontent, githubcopilot, Microsoft-telemetry, exp-tas,
# applicationinsights or vscode-cdn host — while the EZiL mock must still have
# received the request. Browser-side requests are logged and aborted by the
# Playwright script the same way. The browser half also asserts that no
# visible "Copilot"/"GitHub" text is in the workbench after boot and after the
# prompt, that the EZiL notice is in the chat welcome, that the status-bar
# item, Accounts menu and session-target picker carry no Copilot branding and
# that the system prompt identifies as EZiL Chat.

IMAGE="${1:-${EZIL_COPILOT_E2E_IMAGE:-ezil-desktop:rev3}}"
OUT="$(mkdir -p "${EZIL_COPILOT_E2E_OUT:-./ezil-e2e-out}" && cd "${EZIL_COPILOT_E2E_OUT:-./ezil-e2e-out}" && pwd)"
HOST_PORT="${EZIL_COPILOT_E2E_PORT:-8443}"
MOCK_PORT=4142
CAPTURE_DIR=/tmp/copilot-ezil-mock
SINK_DIR=/tmp/copilot-ezil-netsink
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="copilot-ezil-e2e-$$"
DNS_NAME="copilot-ezil-e2e-dns-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/copilot-ezil-e2e.XXXXXX")"
fail=0
# Hosts the chat stack must never try to reach (DNS name, or Host/SNI seen by the sink):
BLOCKED_HOST_RE='(^|\.)(github\.com|githubusercontent\.com|githubcopilot\.com|exp-tas\.com|events\.data\.microsoft\.com|visualstudio\.com|applicationinsights\.azure\.com|vscode-cdn\.net)$'

cleanup() { docker rm --force "$NAME" "$DNS_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ── network sink: DNS sidecar (same image — it has python3) + in-container listener
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/sink.key" -out "$WORK/sink.crt" -subj /CN=ezil-netsink -days 2 >/dev/null 2>&1
DNS_IP=""
start_dns_sidecar() {
  docker rm --force "$DNS_NAME" >/dev/null 2>&1 || true
  docker create --name "$DNS_NAME" --entrypoint bash "$IMAGE" -c 'mkdir -p /netsink && exec python3 /netsink.py dns /netsink/dns.log' >/dev/null
  docker cp "$here/copilot-ezil-netsink.py" "$DNS_NAME:/netsink.py"
  docker start "$DNS_NAME" >/dev/null
  DNS_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$DNS_NAME")"
  [[ -n "$DNS_IP" ]] || { echo "[e2e] FAIL: DNS sidecar has no address" >&2; return 1; }
  echo "[e2e] DNS sink $DNS_NAME at $DNS_IP (every name -> 127.0.0.1, logged)"
}
reset_sink_logs() { docker exec "$DNS_NAME" bash -c ': >/netsink/dns.log' 2>/dev/null || true; }
# network_checks <prefix>: pull both logs, fail on blocked hosts, list the rest
network_checks() {
  local p="$1" dns http blocked
  docker exec "$DNS_NAME" cat /netsink/dns.log >"$OUT/${p}-dns.log" 2>/dev/null || : >"$OUT/${p}-dns.log"
  inx "cat ${SINK_DIR}/http.log 2>/dev/null" >"$OUT/${p}-sink.log" || : >"$OUT/${p}-sink.log"
  dns="$(node -e 'const fs=require("fs");const s=new Set();for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n"))if(l.trim()){try{s.add(JSON.parse(l).name)}catch{}}console.log([...s].sort().join("\n"))' "$OUT/${p}-dns.log")"
  http="$(node -e 'const fs=require("fs");const s=new Set();for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n"))if(l.trim()){try{const j=JSON.parse(l);s.add((j.host||j.sni||"?")+" "+(j.path||""))}catch{}}console.log([...s].sort().join("\n"))' "$OUT/${p}-sink.log")"
  blocked="$( { printf '%s\n' "$dns"; printf '%s\n' "$http" | awk '{print $1}'; } | sed 's/:[0-9]*$//' | grep -E -i "$BLOCKED_HOST_RE" || true)"
  echo "== ${p}: DNS names resolved by the container:"; printf '%s\n' "$dns" | sed 's/^/   /'
  echo "== ${p}: requests that landed on the in-container sink (host path):"; printf '%s\n' "$http" | sed 's/^/   /'
  if [[ -z "$blocked" ]]; then echo "PASS  ${p}: zero attempts to GitHub / githubusercontent / githubcopilot / Microsoft-telemetry / exp-tas / applicationinsights / vscode-cdn hosts (boot + full Agent-mode prompt)"; else echo "FAIL  ${p}: blocked hosts were attempted:"; printf '%s\n' "$blocked" | sed 's/^/   /'; return 1; fi
  if inx "grep -q 'GitHub Copilot' ${CAPTURE_DIR}/captured.json 2>/dev/null"; then echo "FAIL  ${p}: the model was still told it is GitHub Copilot"; return 1; fi
  echo "PASS  ${p}: captured model requests never mention GitHub Copilot"
}

# Same argv shape as local/src/container/run-spec.ts buildDockerRunArgv (mode
# neko, passwords, implicit hosting, loopback ICE) minus the WebRTC ports we do
# not need: only code-server's 8443 is published, on loopback. Files are seeded
# with `docker create` + `docker cp` + `docker start`, NOT `--volume`: a bind
# mount names a path on the DAEMON's host, and when this runs in a sandbox or
# CI job whose filesystem is not the daemon's every seeded file silently
# vanishes (see e2e/ezil-chat-image.sh for the measurement). <stage> mirrors
# the container root: <stage>/home/neko/project/..., <stage>/etc/ezil/...
boot() { # boot <stage-dir>
  local stage="$1" top
  docker rm --force "$NAME" >/dev/null 2>&1 || true
  # the in-container HTTP/HTTPS sink: its files ride along in the stage, it is
  # started by the same shell as the desktop so nothing can race ahead of it
  mkdir -p "$stage$SINK_DIR"
  cp "$here/copilot-ezil-netsink.py" "$WORK/sink.key" "$WORK/sink.crt" "$stage$SINK_DIR/"
  docker create --name "$NAME" --cpus=2 --memory=6g --dns "$DNS_IP" \
    --publish "127.0.0.1:${HOST_PORT}:8443/tcp" \
    --env DESKTOP_MODE=neko --env NEKO_SCREEN=1280x720x24 \
    --env NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko --env NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
    --env NEKO_SESSION_IMPLICIT_HOSTING=true \
    --env NEKO_WEBRTC_UDPMUX=52100 --env NEKO_WEBRTC_TCPMUX=52100 --env NEKO_WEBRTC_NAT1TO1=127.0.0.1 --env NEKO_WEBRTC_ICELITE=true \
    --env EZIL_WORKSPACE_ROOT=/home/neko/project \
    --env EZIL_MODELS_CONFIG=/etc/ezil/models.e2e.json \
    --entrypoint /bin/bash "$IMAGE" -c "python3 ${SINK_DIR}/copilot-ezil-netsink.py http ${SINK_DIR}/http.log ${SINK_DIR} >${SINK_DIR}/sink.out 2>&1 & DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh" >/dev/null
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
    echo "== lib/vscode/extensions (copilot KEPT, ezil-models + ezil-chat present)"
    inx 'ls /usr/lib/code-server/lib/vscode/extensions | grep -i -E "copilot|ezil" || true'
    echo "== built-in copilot-chat version"; inx 'node -e "const j=require(\"/usr/lib/code-server/lib/vscode/extensions/copilot/package.json\");console.log(j.publisher+\".\"+j.name+\" \"+j.version)"'
    echo "== product.json defaultChatAgent present?"; inx 'grep -c defaultChatAgent /usr/lib/code-server/lib/vscode/product.json || true'
    echo "== EZIL_MODELS_CONFIG in the code-server process env"; inx 'tr "\0" "\n" </proc/$(pgrep -o -f "code-server.*--bind-addr" )/environ | grep EZIL_MODELS_CONFIG || echo "(not found)"'
    echo "== /etc/ezil/models.json (shipped template) providers/models"; inx 'node -e "const j=require(\"/etc/ezil/models.json\");console.log(JSON.stringify({providers:Object.entries(j.providers).map(([k,v])=>k+\":\"+v.type+\":\"+(v.apiKey||\"\")),models:j.models.map(m=>m.id)}))"'
    echo "== /etc/ezil/models.e2e.json (test override)"; inx 'cat /etc/ezil/models.e2e.json 2>/dev/null | head -5'
    echo "== opencode --version"; inx 'opencode --version'
    echo "== Machine/settings.json"; inx 'cat /tmp/code-server-data/Machine/settings.json'
    echo "== User/settings.json"; inx 'cat /tmp/code-server-data/User/settings.json'
    echo "== User/chatLanguageModels.json"; inx 'cat /tmp/code-server-data/User/chatLanguageModels.json'
  } 2>&1 | tee "$rep"
  inx 'test -f /usr/lib/code-server/lib/vscode/extensions/copilot/package.json' && echo "PASS  copilot-chat built-in present (kept)" || { echo "FAIL  copilot-chat built-in missing"; ok=0; }
  inx 'test -f /usr/lib/code-server/lib/vscode/extensions/ezil-models/package.json' && echo "PASS  ezil-models built-in present" || { echo "FAIL  ezil-models built-in missing"; ok=0; }
  inx 'test -f /usr/lib/code-server/lib/vscode/extensions/ezil-chat/package.json' && echo "PASS  ezil-chat built-in present (dormant)" || { echo "FAIL  ezil-chat built-in missing"; ok=0; }
  inx 'grep -q defaultChatAgent /usr/lib/code-server/lib/vscode/product.json' && echo "PASS  product.json keeps defaultChatAgent" || { echo "FAIL  product.json lost defaultChatAgent"; ok=0; }
  inx 'test -f /etc/ezil/models.json && ! grep -E "sk-[A-Za-z0-9]{8}" /etc/ezil/models.json >/dev/null' && echo "PASS  /etc/ezil/models.json shipped, no literal key" || { echo "FAIL  /etc/ezil/models.json missing or carries a literal key"; ok=0; }
  inx 'grep -q "\"chat.allowAnonymousAccess\": true" /tmp/code-server-data/Machine/settings.json && grep -q "\"chat.disableAIFeatures\": false" /tmp/code-server-data/Machine/settings.json && grep -q "\"ezilChat.revealOnStartup\": false" /tmp/code-server-data/Machine/settings.json' && echo "PASS  Machine settings: anonymous access on, AI features on, ezil-chat dormant" || { echo "FAIL  Machine settings missing keys"; ok=0; }
  inx 'grep -q "\"vendor\": \"ezil\"" /tmp/code-server-data/User/chatLanguageModels.json' && echo "PASS  chatLanguageModels.json names vendor ezil" || { echo "FAIL  chatLanguageModels.json lacks vendor ezil"; ok=0; }
  inx 'grep -q "\"telemetry.telemetryLevel\": \"off\"" /tmp/code-server-data/User/settings.json' && echo "PASS  User settings: telemetry off" || echo "NOTE  User settings do not say telemetry off (pre-populated by the returning-user pass; expected there)"
  [[ "$(inx 'opencode --version' | tr -d '\r')" == "opencode v"* ]] && echo "PASS  opencode still on PATH: $(inx 'opencode --version')" || { echo "FAIL  opencode --version"; ok=0; }
  [[ $ok == 1 ]]
}

start_mock() {
  docker cp "$here/copilot-ezil-mock-provider.mjs" "$NAME:/tmp/copilot-ezil-mock-provider.mjs"
  docker exec -d "$NAME" bash -c "node /tmp/copilot-ezil-mock-provider.mjs ${MOCK_PORT} /home/neko/project ${CAPTURE_DIR} >/tmp/copilot-ezil-mock.log 2>&1"
  sleep 1
  inx "curl -fsS http://127.0.0.1:${MOCK_PORT}/v1/models" >/dev/null && echo "PASS  mock model answers in-container" || { echo "FAIL  mock model not reachable"; return 1; }
}

run_browser() { # run_browser <outdir>
  EZIL_CODE_URL="http://127.0.0.1:${HOST_PORT}" EZIL_E2E_FOLDER=/home/neko/project \
  EZIL_E2E_EXEC="docker exec $NAME" EZIL_E2E_CAPTURE_DIR="$CAPTURE_DIR" \
  EZIL_E2E_OUT="$1" node "$here/copilot-ezil.mjs"
}

collect_logs() { # collect_logs <prefix>
  local p="$1"
  inx "cat /tmp/copilot-ezil-mock.log" >"$OUT/${p}-mock.log" 2>/dev/null || true
  inx "mkdir -p ${CAPTURE_DIR}; cd ${CAPTURE_DIR} && tar cf - . " 2>/dev/null | (mkdir -p "$OUT/${p}-captured" && tar xf - -C "$OUT/${p}-captured") || true
  inx 'cat /tmp/code-server-data/logs/*/exthost*/GitHub.copilot-chat/*.log 2>/dev/null' >"$OUT/${p}-copilot-chat.log" 2>/dev/null || true
  inx 'cat /tmp/code-server-data/logs/*/exthost*/output_logging_*/*EZiL*Models*.log 2>/dev/null' >"$OUT/${p}-ezil-models.log" 2>/dev/null || true
  inx 'cat /tmp/code-server-data/logs/*/exthost*/exthost.log 2>/dev/null | grep -i -E "ezil|copilot" | head -60' >"$OUT/${p}-exthost-excerpt.log" 2>/dev/null || true
  inx 'grep -i -E "ezil|copilot|chat model|machine settings|editor state" /tmp/neko.log | tail -40' >"$OUT/${p}-neko-log-excerpt.txt" 2>/dev/null || true
}

# ── Pass 1: fresh user ───────────────────────────────────────────────────────
echo "[e2e] pass 1 — fresh user, image $IMAGE"
start_dns_sidecar || exit 1
ST1="$WORK/fresh"; WS1="$ST1/home/neko/project"; mkdir -p "$WS1" "$ST1/etc/ezil"
echo 'hello from the e2e workspace' >"$WS1/README.md"
cp "$here/copilot-ezil-models.json" "$ST1/etc/ezil/models.e2e.json"
boot "$ST1"
container_checks "$OUT/fresh-container-checks.txt" || fail=1
inx 'grep -q "127.0.0.1 api.githubcopilot.com" /etc/hosts && grep -q "127.0.0.1 copilot-telemetry.githubusercontent.com" /etc/hosts && ! grep -q -E "127.0.0.1 (api\.)?github\.com" /etc/hosts' && echo "PASS  /etc/hosts maps the Copilot/telemetry hosts to loopback and leaves github.com alone" || { echo "FAIL  /etc/hosts block missing or too broad"; fail=1; }
inx 'tr "\0" "\n" </proc/$(pgrep -o -f "code-server.*--bind-addr")/cmdline | grep -q -- "--disable-update-check"' && echo "PASS  code-server runs with --disable-update-check" || { echo "FAIL  code-server lacks --disable-update-check"; fail=1; }
inx 'tr "\0" "\n" </proc/$(pgrep -o -f "code-server.*--bind-addr")/environ | grep -q "^APPLICATION_INSIGHTS_NO_STATSBEAT=true$"' && echo "PASS  APPLICATION_INSIGHTS_NO_STATSBEAT=true in the code-server process env" || { echo "FAIL  APPLICATION_INSIGHTS_NO_STATSBEAT not set"; fail=1; }
inx '/usr/local/lib/ezil/patch-copilot-chat.sh --verify /usr/lib/code-server/lib/vscode >/dev/null 2>&1' && echo "PASS  patch-copilot-chat.sh --verify: every build-time patch gate holds in the shipped image" || { echo "FAIL  patch-copilot-chat.sh --verify failed in the image"; fail=1; }
start_mock || fail=1
run_browser "$OUT/fresh" || fail=1
collect_logs fresh
network_checks fresh || fail=1
reset_sink_logs

# ── Pass 2: returning user ───────────────────────────────────────────────────
echo "[e2e] pass 2 — returning user with restored .ezil/ state, a masking User settings.json and a pre-existing BYOK group"
ST2="$WORK/returning"; WS2="$ST2/home/neko/project"; mkdir -p "$WS2/.ezil" "$ST2/etc/ezil"
cp "$here/copilot-ezil-models.json" "$ST2/etc/ezil/models.e2e.json"
cat >"$WS2/.ezil/settings.json" <<'EOF'
{ "security.workspace.trust.enabled": false, "chat.disableAIFeatures": true, "chat.allowAnonymousAccess": false, "workbench.secondarySideBar.defaultVisibility": "hidden", "editor.fontSize": 15 }
EOF
printf 'GitHub.copilot-chat\nGitHub.copilot\n' >"$WS2/.ezil/extensions.txt"
UD2="$ST2/tmp/code-server-data"; mkdir -p "$UD2/User"
cp "$WS2/.ezil/settings.json" "$UD2/User/settings.json"
echo '[{"name":"Someone else","vendor":"openai","apiKey":"${input:chat.lm.secret.e2e}"}]' >"$UD2/User/chatLanguageModels.json"
boot "$ST2"
container_checks "$OUT/returning-container-checks.txt" || fail=1
inx 'grep -q "\"vendor\": \"openai\"" /tmp/code-server-data/User/chatLanguageModels.json' && echo "PASS  pre-existing BYOK group survived the merge" || { echo "FAIL  pre-existing BYOK group was clobbered"; fail=1; }
start_mock || fail=1
run_browser "$OUT/returning" || fail=1
collect_logs returning
network_checks returning || fail=1

rm -rf "$WORK" 2>/dev/null || true
if [[ $fail == 0 ]]; then echo "[e2e] ALL PASSED — artifacts in $OUT"; else echo "[e2e] FAILURES — see $OUT" >&2; fi
exit $fail
