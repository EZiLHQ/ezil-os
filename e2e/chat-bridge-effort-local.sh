#!/usr/bin/env bash
# Portable prepared-Code runner. Run ONLY inside a separately isolated no-egress environment.
# No downloads, patches, builds or installs. Does not touch a user's profile.
set -euo pipefail
: "${EZIL_EFFORT_ISOLATED:?Set to yes only in an operator-verified no-egress environment}"
[[ "$EZIL_EFFORT_ISOLATED" == yes ]] || exit 2
: "${EZIL_CODE_SERVER_ROOT:?Exact extracted and patched code-server root required}"
EZIL_CODE_SERVER_ROOT="$(realpath "$EZIL_CODE_SERVER_ROOT")"
EZIL_CODE_SERVER_BIN="$EZIL_CODE_SERVER_ROOT/bin/code-server"
EZIL_PREPARED_VSCODE_ROOT="$EZIL_CODE_SERVER_ROOT/lib/vscode"
if [[ -n "${EZIL_EFFORT_EXTENSION_DIR:-}" ]]; then
  : "${EZIL_EXPECTED_EXTENSION_SHA256:?Reviewed extension JS hash required}"
  : "${EZIL_EXPECTED_PACKAGE_SHA256:?Reviewed extension package hash required}"
  [[ "$(sha256sum "$EZIL_EFFORT_EXTENSION_DIR/dist/extension.js" | cut -d ' ' -f1)" == "$EZIL_EXPECTED_EXTENSION_SHA256" ]] || exit 2
  [[ "$(sha256sum "$EZIL_EFFORT_EXTENSION_DIR/package.json" | cut -d ' ' -f1)" == "$EZIL_EXPECTED_PACKAGE_SHA256" ]] || exit 2
else
  : "${EZIL_EFFORT_VSIX:?Exact composed-source VSIX or prepared extension directory required}"
  : "${EZIL_EXPECTED_VSIX_SHA256:?Reviewed archive hash required}"
  [[ "$(sha256sum "$EZIL_EFFORT_VSIX" | cut -d ' ' -f1)" == "$EZIL_EXPECTED_VSIX_SHA256" ]] || exit 2
fi
: "${EZIL_EXPECTED_WORKBENCH_SHA256:?Reviewed patched workbench hash required}"
[[ "$(sha256sum "$EZIL_PREPARED_VSCODE_ROOT/out/vs/code/browser/workbench/workbench.js" | cut -d ' ' -f1)" == "$EZIL_EXPECTED_WORKBENCH_SHA256" ]] || exit 2
node -e 'if(require(process.argv[1]).version!=="0.69.0")process.exit(2)' "$EZIL_PREPARED_VSCODE_ROOT/extensions/copilot/package.json"
: "${PLAYWRIGHT_REQUIRE_DIR:?Existing qualified Playwright module directory required}"
: "${EZIL_E2E_OUT:?Private output directory required}"
case "$EZIL_E2E_OUT" in /*) ;; *) echo 'Output must be absolute' >&2; exit 2;; esac
CODE_PORT="${EZIL_E2E_PORT:-18444}"
FIXTURE_PORT="${EZIL_EFFORT_FIXTURE_PORT:-18442}"
[[ "$CODE_PORT" =~ ^[0-9]+$ && "$FIXTURE_PORT" =~ ^[0-9]+$ && "$CODE_PORT" != "$FIXTURE_PORT" ]] || exit 2
"$EZIL_CODE_SERVER_BIN" --version | grep -q '^4.141.0 '
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
umask 077
mkdir -p "$EZIL_E2E_OUT"
run="$(mktemp -d "$EZIL_E2E_OUT/profile-XXXXXX")"
mkdir -p "$run/data/User" "$run/extensions" "$run/workspace"
export EZIL_EFFORT_WORKSPACE="$run/workspace"
export EZIL_MODELS_CONFIG="$here/copilot-ezil-models-effort.json"
export EZIL_AI_BASE_URL="http://127.0.0.1:$FIXTURE_PORT/ai/v1"
export EZIL_AI_PROXY_TOKEN="$(openssl rand -hex 32)"
export EZIL_EDITOR_BRIDGE_TOKEN="$(openssl rand -hex 32)"
export EZIL_CODE_URL="http://127.0.0.1:$CODE_PORT"
export EZIL_EFFORT_FIXTURE_URL="http://127.0.0.1:$FIXTURE_PORT"
cp "$here/copilot-ezil-effort-settings.json" "$run/data/User/settings.json"
printf '%s\n' '[{"name":"EZiL","vendor":"ezil"}]' > "$run/data/User/chatLanguageModels.json"
# Extract the existing VSIX, not an extension install operation or marketplace fetch.
if [[ -n "${EZIL_EFFORT_EXTENSION_DIR:-}" ]]; then
  mkdir -p "$run/extensions/ezil.ezil-models/dist"
  cp "$EZIL_EFFORT_EXTENSION_DIR/package.json" "$run/extensions/ezil.ezil-models/package.json"
  cp "$EZIL_EFFORT_EXTENSION_DIR/dist/extension.js" "$run/extensions/ezil.ezil-models/dist/extension.js"
else
python3 - "$EZIL_EFFORT_VSIX" "$run/extensions/ezil.ezil-models" <<'PY'
import sys,zipfile,pathlib
root=pathlib.Path(sys.argv[2]);root.mkdir()
with zipfile.ZipFile(sys.argv[1]) as z:
 for name in ['package.json','dist/extension.js']:
  target=root/name;target.parent.mkdir(exist_ok=True);target.write_bytes(z.read('extension/'+name))
PY
fi
sha256sum "$run/extensions/ezil.ezil-models/package.json" "$run/extensions/ezil.ezil-models/dist/extension.js" > "$EZIL_E2E_OUT/input-hashes.txt"
controller_secret="$(openssl rand -hex 32)"
fixture_pid=''; code_pid=''
cleanup() { [[ -z "$code_pid" ]] || kill "$code_pid" 2>/dev/null || true; [[ -z "$fixture_pid" ]] || kill "$fixture_pid" 2>/dev/null || true; }
trap cleanup EXIT
EZIL_EFFORT_CONTROLLER_TOKEN="$controller_secret" node "$here/chat-bridge-effort-standin.mjs" "$FIXTURE_PORT" 0 "$EZIL_EDITOR_BRIDGE_TOKEN" "$EZIL_AI_PROXY_TOKEN" > "$run/fixture.log" 2>&1 &
fixture_pid=$!
env -u EZIL_EFFORT_CONTROLLER_TOKEN "$EZIL_CODE_SERVER_BIN" --bind-addr "127.0.0.1:$CODE_PORT" --auth none --disable-telemetry --disable-update-check --user-data-dir "$run/data" --extensions-dir "$run/extensions" "$run/workspace" > "$run/code.log" 2>&1 &
code_pid=$!
for i in $(seq 1 90); do
 kill -0 "$code_pid" "$fixture_pid" 2>/dev/null || { echo 'Local process exited' >&2; exit 1; }
 curl -fsS -o /dev/null "$EZIL_CODE_URL/healthz" && break
 sleep 1
done
curl -fsS -o /dev/null "$EZIL_CODE_URL/healthz"
EZIL_EFFORT_CONTROLLER_TOKEN="$controller_secret" node "$here/chat-bridge-effort.mjs"
