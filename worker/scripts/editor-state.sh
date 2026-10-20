#!/usr/bin/env bash
# Shared by both launchers and the checkpoint boundary. Copy JSONC verbatim.
ezil_editor_atomic_copy() {
  local src="$1" dst="$2" temporary
  mkdir -p "$(dirname "$dst")" || return 1
  temporary="$(mktemp "${dst}.XXXXXX")" || return 1
  if cp "$src" "$temporary" && mv -f "$temporary" "$dst"; then
    return 0
  fi
  rm -f "$temporary"
  return 1
}

seed_codeserver_user_settings() {
  local dst="$1/User/settings.json" temporary
  # An empty saved file is still a user file, never permission to seed defaults.
  [ ! -e "$dst" ] || return 0
  mkdir -p "$(dirname "$dst")" || return 1
  temporary="$(mktemp "${dst}.XXXXXX")" || return 1
  if cat >"$temporary" <<'CODESERVER_SETTINGS_JSON'
{
  "security.workspace.trust.enabled": false,
  "files.exclude": {
    "**/.ezil": true
  }
}
CODESERVER_SETTINGS_JSON
  then
    mv -f "$temporary" "$dst" && return 0
  fi
  rm -f "$temporary"
  return 1
}

# Machine settings belong to the image and are refreshed on every prepare.
# User settings (including JSONC) continue through the existing restore path.
seed_codeserver_machine_settings() {
  local dst="$1/Machine/settings.json" temporary
  mkdir -p "$(dirname "$dst")" || return 1
  temporary="$(mktemp "${dst}.XXXXXX")" || return 1
  if cat >"$temporary" <<'CODESERVER_MACHINE_SETTINGS_JSON'
{
  "chat.disableAIFeatures": false,
  "chat.allowAnonymousAccess": true,
  "chat.byokUtilityModelDefault": "mainAgent",
  "chat.utilityModel": "ezil/qwen.qwen3-coder-next",
  "chat.utilitySmallModel": "ezil/qwen.qwen3-coder-next",
  "chat.titleBar.signIn.enabled": false,
  "chat.welcomePage.signIn.enabled": false,
  "github.copilot.enable": { "*": false },
  "github.copilot.nextEditSuggestions.enabled": false,
  "github.copilot.chat.backgroundAgent.enabled": false,
  "github.copilot.chat.cloudAgent.enabled": false,
  "chat.viewSessions.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "visible",
  "telemetry.telemetryLevel": "off",
  "terminal.integrated.env.linux": {
    "EZIL_AI_PROXY_TOKEN": null,
    "EZIL_AI_BASE_URL": null
  },
  "github.copilot.chat.tools.viewImage.enabled": false,
  "github.copilot.chat.virtualTools.threshold": 64
}
CODESERVER_MACHINE_SETTINGS_JSON
  then
    mv -f "$temporary" "$dst" && return 0
  fi
  rm -f "$temporary"
  return 1
}

# Merge the ephemeral BYOK group list without removing user entries. Preserve
# malformed input as a backup instead of silently discarding its original bytes.
seed_codeserver_chat_models() {
  mkdir -p "$1/User" || return 1
  node - "$1/User/chatLanguageModels.json" <<'CODESERVER_CHAT_MODELS_JS'
const fs = require("fs");
const dst = process.argv[2];
let groups = [];
if (fs.existsSync(dst)) {
  const original = fs.readFileSync(dst, "utf8");
  try {
    groups = JSON.parse(original);
    if (!Array.isArray(groups)) throw new Error("expected array");
  } catch {
    fs.writeFileSync(dst + ".invalid-" + Date.now(), original, { flag: "wx", mode: 0o600 });
    groups = [];
  }
}
if (!groups.some(group => group?.vendor === "ezil" && group?.name === "EZiL")) {
  groups.push({ name: "EZiL", vendor: "ezil" });
}
const temporary = dst + "." + process.pid;
try {
  fs.writeFileSync(temporary, JSON.stringify(groups, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, dst);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}
CODESERVER_CHAT_MODELS_JS
}

# Copilot/telemetry-only sinks; never github.com or api.github.com. A read-only
# hosts file must not fail boot. EZIL_HOSTS_FILE allows isolated Linux tests.
seed_blocked_ai_hosts() {
  local _h _hosts="${EZIL_HOSTS_FILE:-/etc/hosts}"
  [ -w "$_hosts" ] || return 0
  while IFS= read -r _h; do
    [ -n "$_h" ] || continue
    grep -q -F -w -- "$_h" "$_hosts" 2>/dev/null && continue
    printf '127.0.0.1 %s\n' "$_h" >>"$_hosts" 2>/dev/null || return 0
  done <<'EZIL_BLOCKED_AI_HOSTS'
api.githubcopilot.com
api-model-lab.githubcopilot.com
copilot-proxy.githubusercontent.com
copilot-telemetry.githubusercontent.com
origin-tracker.githubusercontent.com
default.exp-tas.com
mobile.events.data.microsoft.com
browser.events.data.microsoft.com
dc.services.visualstudio.com
westus-0.in.applicationinsights.azure.com
westeurope-5.in.applicationinsights.azure.com
main.vscode-cdn.net
embeddings.vscode-cdn.net
EZIL_BLOCKED_AI_HOSTS
}

ezil_editor_prepare() (
  local user_data="$1" workspace="$2" file
  mkdir -p "$user_data" || exit 1
  exec 8>"$user_data/.ezil-state.lock" || exit 1
  flock -w 10 8 || exit 1
  seed_codeserver_machine_settings "$user_data" || exit 1
  seed_codeserver_chat_models "$user_data" || exit 1
  seed_blocked_ai_hosts || true
  # Within the same runtime, relaunches preserve the current editor state.
  if [ -f "$user_data/.ezil-state-ready" ]; then
    [ "$(cat "$user_data/.ezil-state-ready")" = "$workspace" ] || exit 1
    exit 0
  fi
  for file in settings.json keybindings.json; do
    if [ -e "${EZIL_EDITOR_STATE_DIR:-$workspace/.ezil}/$file" ]; then
      ezil_editor_atomic_copy "${EZIL_EDITOR_STATE_DIR:-$workspace/.ezil}/$file" "$user_data/User/$file" || exit 1
    fi
  done
  seed_codeserver_user_settings "$user_data" || exit 1
  # This marker is published only after every restore succeeded. Failed restores
  # cannot launch defaults or let a later capture replace durable user settings.
  printf '%s\n' "$workspace" >"$user_data/.ezil-state-ready" || exit 1
)

# Extension installs remain asynchronous. Keep saved IDs when marketplace restore
# fails, rather than replacing the durable manifest with a partial installed set.
ezil_editor_extension_ids() {
  local extensions="$1" entry
  [ -d "$extensions" ] || return 0
  for entry in "$extensions"/*; do
    [ ! -d "$entry" ] || printf '%s\n' "${entry##*/}"
  done \
    | sed -E 's/-[0-9]+\.[0-9]+\.[0-9]+(-.*)?$//' \
    | grep -E '^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_.-]*$' \
    | sort -u || true
}

ezil_editor_restore_extensions() (
  local user_data="$1" workspace="$2" extensions="$3" binary="$4" id installed
  local manifest="${EZIL_EDITOR_STATE_DIR:-$workspace/.ezil}/extensions.txt"
  [ -s "$manifest" ] || exit 0
  installed="$(ezil_editor_extension_ids "$extensions")"
  while IFS= read -r id; do
    [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || continue
    printf '%s\n' "$installed" | grep -qx "$id" && continue
    timeout 180 "$binary" --user-data-dir="$user_data" --extensions-dir="$extensions" \
      --install-extension "$id" || true
  done < "$manifest"
)

ezil_editor_capture() (
  local user_data="$1" workspace="$2" file ids temporary
  local state_dir="${EZIL_EDITOR_STATE_DIR:-$2/.ezil}"
  # Workspace hydration checkpoints precede editor startup.
  if [ ! -f "$user_data/.ezil-state-ready" ]; then
    [ ! -e "$user_data/User/settings.json" ] && [ ! -e "$user_data/User/keybindings.json" ]
    exit $?
  fi
  exec 8>"$user_data/.ezil-state.lock" || exit 1
  flock -w 10 8 || exit 1
  [ "$(cat "$user_data/.ezil-state-ready")" = "$workspace" ] || exit 1
  for file in settings.json keybindings.json; do
    if [ -f "$user_data/User/$file" ]; then
      if ! cmp -s "$user_data/User/$file" "$state_dir/$file"; then
        ezil_editor_atomic_copy "$user_data/User/$file" "$state_dir/$file" || exit 1
      fi
    fi
  done
  ids="$( { cat "$state_dir/extensions.txt" 2>/dev/null || true; ezil_editor_extension_ids "${CODE_SERVER_EXTENSIONS_DIR:-/tmp/code-server-extensions}"; } \
    | grep -E '^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_.-]*$' | sort -u || true)"
  if [ -n "$ids" ] && [ "$ids" != "$(cat "$state_dir/extensions.txt" 2>/dev/null || true)" ]; then
    mkdir -p "$state_dir" || exit 1
    temporary="$(mktemp "$state_dir/extensions.txt.XXXXXX")" || exit 1
    if ! printf '%s\n' "$ids" >"$temporary" || ! mv -f "$temporary" "$state_dir/extensions.txt"; then
      rm -f "$temporary"
      exit 1
    fi
  fi
)

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    capture) ezil_editor_capture "${CODE_SERVER_USER_DATA_DIR:-/tmp/code-server-data}" "${2:?workspace required}" ;;
    *) exit 2 ;;
  esac
fi
