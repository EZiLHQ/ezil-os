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
  "chat.defaultModel": "qwen.qwen3-coder-next",
  "chat.titleBar.signIn.enabled": false,
  "chat.welcomePage.signIn.enabled": false,
  "github.copilot.enable": { "*": false },
  "github.copilot.nextEditSuggestions.enabled": false,
  "github.copilot.chat.backgroundAgent.enabled": false,
  "github.copilot.chat.cloudAgent.enabled": false,
  "chat.viewSessions.enabled": false,
  "github.copilot.chat.localIndex.enabled": false,
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
const entry = { name: "EZiL", vendor: "ezil" };
// The workbench reads this file as JSONC: drop comments and trailing commas,
// leaving string contents untouched.
function jsonc(text) {
  let out = "", i = 0, inString = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inString) { out += c; if (c === "\\") { out += n ?? ""; i += 2; continue; } if (c === '"') inString = false; i++; continue; }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const close = text.indexOf("*/", i + 2); i = close < 0 ? text.length : close + 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, "$1"));
}
function write(text) {
  const temporary = dst + "." + process.pid;
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, dst);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
if (!fs.existsSync(dst)) {
  write(JSON.stringify([entry], null, 2) + "\n");
  process.exit(0);
}
const original = fs.readFileSync(dst, "utf8");
let groups;
try {
  groups = jsonc(original);
  if (!Array.isArray(groups)) throw new Error("expected array");
} catch {
  // Unreadable even as JSONC: keep the original bytes as a backup, then seed.
  fs.writeFileSync(dst + ".invalid-" + Date.now(), original, { flag: "wx", mode: 0o600 });
  write(JSON.stringify([entry], null, 2) + "\n");
  process.exit(0);
}
if (groups.some(group => group?.vendor === "ezil" && group?.name === "EZiL")) process.exit(0); // untouched
// Insert right after the opening bracket (the first "[" outside comments), so
// the user's comments, layout and trailing-comment lines survive untouched.
let open = 0;
while (open < original.length && original[open] !== "[") {
  if (original.startsWith("//", open)) open = original.indexOf("\n", open) < 0 ? original.length : original.indexOf("\n", open);
  else if (original.startsWith("/*", open)) open = original.indexOf("*/", open + 2) < 0 ? original.length : original.indexOf("*/", open + 2) + 2;
  else open++;
}
write(original.slice(0, open + 1) + "\n  " + JSON.stringify(entry) + (groups.length ? "," : "") + original.slice(open + 1));
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

# EZiL Chat history. The editor writes each conversation to
# <user-data>/User/workspaceStorage/<workspace id>/chatSessions/<session>.jsonl
# (code-server 4.141.0 ChatSessionStore). That directory becomes a link to
# <workspace>/.ezil/chat, so the one copy travels with the workspace: checkpoints,
# restore, reverse move and Cloudflare restarts carry it like any project file.
# The id is the web workbench's hash of the folder URI vscode-remote://remote<path>
# (workbench.js QUn/Nr/o0); both bridges drop x-forwarded-port, so the authority is
# always "remote". Print one id per distinct spelling of the folder path.
ezil_editor_chat_workspace_ids() {
  node - "$1" <<'CODESERVER_WORKSPACE_ID_JS'
const path = require("path");
const hash = s => { let h = 149417; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return h; };
// Only paths URI.toString() leaves unencoded; anything else would hash differently.
for (const p of new Set([process.argv[2], path.resolve(process.argv[2])])) {
  if (/^\/[A-Za-z0-9._~\/-]*$/.test(p)) console.log(hash("vscode-remote://remote" + p).toString(16));
}
CODESERVER_WORKSPACE_ID_JS
}

# Idempotent; runs before every launch, including warm AWS profiles that already
# carry .ezil-state-ready. Existing history (AWS profile volume) moves into the
# workspace once, never overwriting a saved session. Odd entries are moved aside,
# never followed or deleted.
ezil_editor_link_chat() (
  local user_data="$1" workspace="$2" state_dir chat ids id parent link entry name stamp
  state_dir="${EZIL_EDITOR_STATE_DIR:-$workspace/.ezil}"
  chat="$state_dir/chat"
  stamp="$(date +%s)-$BASHPID-$RANDOM"
  mkdir -p "$state_dir" || exit 1
  # Self-ignoring: user Git never stages editor state or conversations.
  if [ ! -e "$state_dir/.gitignore" ] && [ ! -L "$state_dir/.gitignore" ]; then
    printf '# EZiL editor state and chat history (managed by EZiL)\n*\n' >"$state_dir/.gitignore" || exit 1
  fi
  # `mv -T` everywhere: a destination is a name, never a directory to move into.
  if [ -L "$chat" ] || { [ -e "$chat" ] && [ ! -d "$chat" ]; }; then
    mv -T -- "$chat" "$chat.ezil-quarantine-$stamp" || exit 1
  fi
  mkdir -p "$chat" || exit 1
  ids="$(ezil_editor_chat_workspace_ids "$workspace")" || exit 1
  [ -n "$ids" ] || exit 1
  for id in $ids; do
    parent="$user_data/User/workspaceStorage/$id"
    link="$parent/chatSessions"
    [ "$(readlink "$link" 2>/dev/null)" = "$chat" ] && continue
    mkdir -p "$parent" || exit 1
    if [ -d "$link" ] && [ ! -L "$link" ]; then
      for entry in "$link"/* "$link"/.[!.]* "$link"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        name="${entry##*/}"
        if [ ! -e "$chat/$name" ] && [ ! -L "$chat/$name" ]; then
          mv -T -- "$entry" "$chat/$name" || exit 1
        elif [ -f "$entry" ] && [ ! -L "$entry" ] && cmp -s -- "$entry" "$chat/$name"; then
          rm -f -- "$entry" || exit 1
        else
          mkdir -p "$state_dir/chat-conflicts/$stamp" || exit 1
          mv -T -- "$entry" "$state_dir/chat-conflicts/$stamp/$name" || exit 1
        fi
      done
      rmdir -- "$link" || exit 1
    elif [ -e "$link" ] || [ -L "$link" ]; then
      mv -T -- "$link" "$parent/chatSessions.ezil-quarantine-$stamp" || exit 1
    fi
    ln -s -- "$chat" "$parent/.chatSessions.$stamp" || exit 1
    mv -T -- "$parent/.chatSessions.$stamp" "$link" || { rm -f -- "$parent/.chatSessions.$stamp"; exit 1; }
  done
)

# Copilot Chat 0.69's local session index (github.copilot.chat.localIndex.enabled,
# now off in the Machine seed) keeps a second copy of every turn that deleting a
# conversation never removes. Drop that derived copy; the workspace keeps the history.
ezil_editor_drop_copilot_session_index() {
  rm -f -- "$1/User/globalStorage/github.copilot-chat/session-store.db" \
    "$1/User/globalStorage/github.copilot-chat/session-store.db-wal" \
    "$1/User/globalStorage/github.copilot-chat/session-store.db-shm" \
    "$1/User/globalStorage/github.copilot-chat/session-store.db-journal"
}

ezil_editor_prepare() (
  local user_data="$1" workspace="$2" file
  mkdir -p "$user_data" || exit 1
  exec 8>"$user_data/.ezil-state.lock" || exit 1
  flock -w 10 8 || exit 1
  seed_codeserver_machine_settings "$user_data" || exit 1
  seed_codeserver_chat_models "$user_data" || exit 1
  seed_blocked_ai_hosts || true
  ezil_editor_drop_copilot_session_index "$user_data" || true
  # Within the same runtime, relaunches preserve the current editor state.
  if [ -f "$user_data/.ezil-state-ready" ]; then
    [ "$(cat "$user_data/.ezil-state-ready")" = "$workspace" ] || exit 1
    # History must not block the editor: a failed link leaves today's behaviour.
    ezil_editor_link_chat "$user_data" "$workspace" || echo "editor-state: chat history link failed; conversations stay in the editor profile" >&2
    exit 0
  fi
  for file in settings.json keybindings.json; do
    if [ -e "${EZIL_EDITOR_STATE_DIR:-$workspace/.ezil}/$file" ]; then
      ezil_editor_atomic_copy "${EZIL_EDITOR_STATE_DIR:-$workspace/.ezil}/$file" "$user_data/User/$file" || exit 1
    fi
  done
  seed_codeserver_user_settings "$user_data" || exit 1
  ezil_editor_link_chat "$user_data" "$workspace" || echo "editor-state: chat history link failed; conversations stay in the editor profile" >&2
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
  # A workspace replaced under a running editor keeps the history link usable.
  [ -L "$state_dir/chat" ] || mkdir -p "$state_dir/chat" 2>/dev/null || true
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
