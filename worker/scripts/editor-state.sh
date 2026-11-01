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
  "task.allowAutomaticTasks": "off",
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
# `task.allowAutomaticTasks` is "off" here as well as in the user settings
# (ezil_editor_enforce_user_policy): a repository opened from a project link
# (<root>/projects/<id>, worker/src/repo-open.ts) is someone else's code, and
# its `runOn: folderOpen` tasks must not run on this person's computer. In
# code-server 4.141 (VS Code 1.141) the setting is application-scoped, which
# the Machine layer cannot set, so the user settings are what decide; this
# copy is kept for an editor that scopes it otherwise.
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
  "github.copilot.chat.virtualTools.threshold": 64,
  "task.allowAutomaticTasks": "off"
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

# A project repository's own tasks never run on open (build1-review-os.md #1):
# force "task.allowAutomaticTasks": "off" into the user's settings on EVERY
# prepare, over a restored value or an earlier "Allow" (which writes "on").
# Edits in place so the user's comments and layout survive: every top-level
# value of the key becomes "off", or the key is added as the last property.
# An empty or unreadable file is left exactly as it is (1.141's own default
# is "off"). In 1.141 the setting is application-scoped (scope 1, outside the
# workspace and folder scopes), so a repository's .vscode/settings.json cannot
# turn it back on. A project repository's root-level configuration is inert
# anyway: repo-open puts the repository one level below the folder Code opens
# (review F3), out of reach of everything code-server reads from a workspace
# folder's root (.vscode, .mcp.json, .github/hooks, .claude/settings*.json).
ezil_editor_enforce_user_policy() {
  local dst="$1/User/settings.json"
  [ -s "$dst" ] || return 0
  node - "$dst" <<'CODESERVER_USER_POLICY_JS' || true
const fs = require("fs");
const dst = process.argv[2];
const KEY = "task.allowAutomaticTasks", VALUE = "off";
// The same JSONC reading as seed_codeserver_chat_models: comments and
// trailing commas dropped, string contents untouched.
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
// Tokens outside comments, with their offsets: strings, punctuation, literals.
function tokens(text) {
  const out = []; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const s = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      if (i >= text.length) return null;
      out.push({ t: "str", s, e: ++i }); continue;
    }
    if (text.startsWith("//", i)) { const n = text.indexOf("\n", i); i = n < 0 ? text.length : n; continue; }
    if (text.startsWith("/*", i)) { const n = text.indexOf("*/", i + 2); if (n < 0) return null; i = n + 2; continue; }
    if ("{}[]:,".includes(c)) { out.push({ t: c, s: i, e: i + 1 }); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const s = i;
    while (i < text.length && !/[\s{}\[\]:,"\/]/.test(text[i])) i++;
    if (i === s) return null;
    out.push({ t: "lit", s, e: i });
  }
  return out;
}
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const original = fs.readFileSync(dst, "utf8");
let parsed;
try { parsed = jsonc(original); } catch { process.exit(0); }
if (!isObject(parsed) || parsed[KEY] === VALUE) process.exit(0);
const toks = tokens(original);
if (!toks || toks[0]?.t !== "{") process.exit(0);
const spans = []; let depth = 0, close = -1;
for (let k = 0; k < toks.length && close < 0; k++) {
  const tk = toks[k];
  if (tk.t === "{" || tk.t === "[") depth++;
  else if (tk.t === "}" || tk.t === "]") { if (--depth === 0) close = k; }
  else if (depth === 1 && tk.t === "str" && toks[k + 1]?.t === ":") {
    let name; try { name = JSON.parse(original.slice(tk.s, tk.e)); } catch { process.exit(0); }
    if (name !== KEY) continue;
    const v = toks[k + 2];
    if (!v) process.exit(0);
    if (v.t === "str" || v.t === "lit") { spans.push([v.s, v.e]); continue; }
    if (v.t !== "{" && v.t !== "[") process.exit(0);
    let d = 0, m = k + 2;
    for (; m < toks.length; m++) {
      if (toks[m].t === "{" || toks[m].t === "[") d++;
      else if ((toks[m].t === "}" || toks[m].t === "]") && --d === 0) break;
    }
    if (m >= toks.length) process.exit(0);
    spans.push([v.s, toks[m].e]);
  }
}
if (close < 0) process.exit(0);
let next;
if (spans.length) {
  next = original;
  for (const [s, e] of spans.reverse()) next = next.slice(0, s) + JSON.stringify(VALUE) + next.slice(e);
} else {
  const prev = toks[close - 1], at0 = toks[close].s;
  const lineStart = original.lastIndexOf("\n", at0 - 1) + 1;
  const ownLine = /^\s*$/.test(original.slice(lineStart, at0));
  const at = ownLine ? lineStart : at0;
  const comma = prev.t === "{" || prev.t === "," ? "" : ",";
  next = original.slice(0, prev.e) + comma + original.slice(prev.e, at)
    + (ownLine ? "" : "\n") + "  " + JSON.stringify(KEY) + ": " + JSON.stringify(VALUE) + "\n" + original.slice(at);
}
let check;
try { check = jsonc(next); } catch { process.exit(0); }
if (!isObject(check) || check[KEY] !== VALUE) process.exit(0);
const temporary = dst + "." + process.pid;
try {
  fs.writeFileSync(temporary, next, { flag: "wx", mode: fs.statSync(dst).mode & 0o777 });
  fs.renameSync(temporary, dst);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}
CODESERVER_USER_POLICY_JS
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

# User Git never stages editor state or conversations. Two rules, both written before
# every launch and at every capture (30 s and each checkpoint), because the running editor
# recreates .ezil/chat itself after `git clean -x`/`-X` or a replaced workspace removed
# it: .ezil/.gitignore (`*`), and `/.ezil/` in the local, never-committed
# .git/info/exclude of a repository at the workspace root, which `git clean` keeps. A
# user's file is never replaced, a link never followed, and .git/info never created.
ezil_editor_ignore_state() {
  local workspace="$1" state_dir="$2" exclude="$1/.git/info/exclude"
  mkdir -p "$state_dir" || return 1
  if [ ! -e "$state_dir/.gitignore" ] && [ ! -L "$state_dir/.gitignore" ]; then
    printf '# EZiL editor state and chat history (managed by EZiL)\n*\n' >"$state_dir/.gitignore" || return 1
  fi
  [ "$state_dir" = "$workspace/.ezil" ] || return 0
  [ -d "$workspace/.git" ] && [ ! -L "$workspace/.git" ] && [ ! -L "$workspace/.git/info" ] || return 0
  [ -f "$exclude" ] && [ ! -L "$exclude" ] || return 0
  grep -qxF '/.ezil/' "$exclude" && return 0
  # Best effort on top of .gitignore. Keep a last line without a newline intact.
  if [ -s "$exclude" ] && [ -n "$(tail -c 1 "$exclude")" ]; then printf '\n' >>"$exclude" 2>/dev/null || return 0; fi
  printf '# EZiL editor state and chat history (managed by EZiL)\n/.ezil/\n' >>"$exclude" 2>/dev/null || true
}

# EZiL Chat history lives in the workspace: <workspace>/.ezil/chat/<session>.jsonl, one
# copy that checkpoints, restore, reverse move and Cloudflare restarts carry like any
# project file. The patched editor (copilot-chat/PATCHES.md, history-root) writes there
# whenever that directory exists; upstream it writes to
# <user-data>/User/workspaceStorage/<id>/chatSessions, with an id that hashes the browser
# host, so it changes with the computer's address. Idempotent; runs before every launch,
# including warm AWS profiles that already carry .ezil-state-ready. History already in a
# profile moves into the workspace, never overwriting a saved session (all such
# directories: in EZiL the editor opens one folder). Odd entries are moved aside, never
# followed or deleted.
ezil_editor_prepare_chat() (
  local user_data="$1" workspace="$2" state_dir chat dir entry name stamp
  state_dir="${EZIL_EDITOR_STATE_DIR:-$workspace/.ezil}"
  chat="$state_dir/chat"
  stamp="$(date +%s)-$BASHPID-$RANDOM"
  ezil_editor_ignore_state "$workspace" "$state_dir" || exit 1
  # `mv -T` everywhere: a destination is a name, never a directory to move into.
  if [ -L "$chat" ] || { [ -e "$chat" ] && [ ! -d "$chat" ]; }; then
    mv -T -- "$chat" "$chat.ezil-quarantine-$stamp" || exit 1
  fi
  mkdir -p "$chat" || exit 1
  for dir in "$user_data"/User/workspaceStorage/*/chatSessions; do
    [ -d "$dir" ] && [ ! -L "$dir" ] || continue
    for entry in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
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
    rmdir -- "$dir" 2>/dev/null || true
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
    ezil_editor_enforce_user_policy "$user_data"
    # History must not block the editor: a failed link leaves today's behaviour.
    ezil_editor_prepare_chat "$user_data" "$workspace" || echo "editor-state: chat history folder not prepared; new conversations stay in the editor profile" >&2
    exit 0
  fi
  for file in settings.json keybindings.json; do
    if [ -e "${EZIL_EDITOR_STATE_DIR:-$workspace/.ezil}/$file" ]; then
      ezil_editor_atomic_copy "${EZIL_EDITOR_STATE_DIR:-$workspace/.ezil}/$file" "$user_data/User/$file" || exit 1
    fi
  done
  seed_codeserver_user_settings "$user_data" || exit 1
  ezil_editor_enforce_user_policy "$user_data"
  ezil_editor_prepare_chat "$user_data" "$workspace" || echo "editor-state: chat history folder not prepared; new conversations stay in the editor profile" >&2
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
  # A workspace replaced (or .ezil removed) under a running editor gets its ignore rules
  # and history folder back. Best effort: a failure here must not fail the checkpoint.
  ezil_editor_ignore_state "$workspace" "$state_dir" 2>/dev/null || true
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
