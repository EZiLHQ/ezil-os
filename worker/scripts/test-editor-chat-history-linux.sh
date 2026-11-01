#!/usr/bin/env bash
# EZiL Chat history: one copy under <workspace>/.ezil/chat, reachable from the
# editor's workspaceStorage/<id>/chatSessions on every launch. Linux coreutils.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/editor-state.sh"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export EZIL_HOSTS_FILE="$root/hosts"
printf '127.0.0.1 localhost\n' >"$EZIL_HOSTS_FILE"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
workspace="$root/workspace"
mkdir -p "$workspace"

# The id is the web workbench's string hash of vscode-remote://remote<path>, in hex.
# Reference values recomputed independently below; a bundle-extracted parity check
# lives in worker/copilot-chat/chat-history-patch.test.cjs.
ids="$(ezil_editor_chat_workspace_ids /workspace)"
expected="$(node -e 'let h=149417;for(const c of "vscode-remote://remote/workspace")h=(h*31+c.charCodeAt(0))|0;console.log(h.toString(16))')"
[ "$ids" = "$expected" ] || fail "id for /workspace: $ids != $expected"
# A trailing slash is a different URI: both spellings are linked; unencodable paths are not.
[ "$(ezil_editor_chat_workspace_ids /workspace/ | wc -l)" -eq 2 ] || fail "trailing slash spelling"
[ -z "$(ezil_editor_chat_workspace_ids '/work space')" ] || fail "unencodable path produced an id"

id="$(ezil_editor_chat_workspace_ids "$workspace" | head -n1)"
[ "$(ezil_editor_chat_workspace_ids "$workspace" | wc -l)" -eq 1 ] || fail "expected one id for $workspace"
sessions() { printf '%s/User/workspaceStorage/%s/chatSessions' "$1" "$id"; }

# 1. Cloudflare: fresh /tmp user data links to the workspace; the editor's write lands once.
cf="$root/cf-user"
ezil_editor_prepare "$cf" "$workspace"
[ -L "$(sessions "$cf")" ] || fail "chatSessions is not a link"
[ "$(readlink "$(sessions "$cf")")" = "$workspace/.ezil/chat" ] || fail "link target"
[ -d "$workspace/.ezil/chat" ] && [ ! -L "$workspace/.ezil/chat" ] || fail "chat is not a real directory"
printf '{"kind":0,"v":{"sessionId":"s1"}}\n' >"$(sessions "$cf")/s1.jsonl"
printf '{"kind":1,"k":["customTitle"],"v":"Fix login"}\n' >>"$(sessions "$cf")/s1.jsonl"
[ -f "$workspace/.ezil/chat/s1.jsonl" ] || fail "session not in workspace"
[ "$(find "$root" -name 's1.jsonl' -type f | wc -l)" -eq 1 ] || fail "session stored more than once"
# Container restart: /tmp is recreated, the workspace persists.
rm -rf "$cf"
ezil_editor_prepare "$cf" "$workspace"
cmp -s "$(sessions "$cf")/s1.jsonl" "$workspace/.ezil/chat/s1.jsonl" || fail "history not visible after restart"
# Deleting through the editor's path removes the only copy.
printf '{"kind":0,"v":{"sessionId":"gone"}}\n' >"$(sessions "$cf")/gone.jsonl"
rm "$(sessions "$cf")/gone.jsonl"
[ ! -e "$workspace/.ezil/chat/gone.jsonl" ] || fail "deleted session survived"
[ -L "$(sessions "$cf")" ] || fail "delete removed the link"

# 2. Relaunch in the same runtime (ready marker present) is a no-op.
before="$(stat -c '%i %Y' "$(sessions "$cf")")"
ezil_editor_prepare "$cf" "$workspace"
[ "$(stat -c '%i %Y' "$(sessions "$cf")")" = "$before" ] || fail "relaunch replaced the link"

# 3. Existing AWS profile: warm marker, real directory with history -> moved once, never clobbered.
aws="$root/aws-user"
mkdir -p "$(sessions "$aws")"
printf '%s\n' "$workspace" >"$aws/.ezil-state-ready"
printf 'old history\n' >"$(sessions "$aws")/s2.jsonl"
printf 'flat\n' >"$(sessions "$aws")/s3.json"
cp "$workspace/.ezil/chat/s1.jsonl" "$(sessions "$aws")/s1.jsonl"          # identical duplicate
mkdir -p "$aws/User/workspaceStorage/other-folder/chatSessions"
printf 'other workspace\n' >"$aws/User/workspaceStorage/other-folder/chatSessions/x.jsonl"
ezil_editor_prepare "$aws" "$workspace"
[ -L "$(sessions "$aws")" ] || fail "warm profile not linked"
[ "$(cat "$workspace/.ezil/chat/s2.jsonl")" = 'old history' ] || fail "jsonl not migrated"
[ "$(cat "$workspace/.ezil/chat/s3.json")" = 'flat' ] || fail "json not migrated"
[ ! -e "$workspace/.ezil/chat-conflicts" ] || fail "identical duplicate reported as conflict"
[ -f "$aws/User/workspaceStorage/other-folder/chatSessions/x.jsonl" ] || fail "another folder's history moved"
# Positive control for the conflict branch: different bytes under a saved name are kept aside.
rm "$(sessions "$aws")"
mkdir -p "$(sessions "$aws")"
printf 'diverged\n' >"$(sessions "$aws")/s2.jsonl"
ezil_editor_prepare "$aws" "$workspace"
[ "$(cat "$workspace/.ezil/chat/s2.jsonl")" = 'old history' ] || fail "saved session overwritten"
[ "$(cat "$workspace/.ezil/chat-conflicts/"*/s2.jsonl)" = 'diverged' ] || fail "conflicting copy lost"

# 4. Odd entries are moved aside, never followed.
outside="$root/outside"
mkdir -p "$outside"
printf 'keep\n' >"$outside/keep.jsonl"
rm "$(sessions "$cf")"
ln -s "$outside" "$(sessions "$cf")"                                      # wrong link target
ezil_editor_prepare "$cf" "$workspace"
[ "$(readlink "$(sessions "$cf")")" = "$workspace/.ezil/chat" ] || fail "wrong link not replaced"
[ "$(cat "$outside/keep.jsonl")" = 'keep' ] && [ ! -e "$workspace/.ezil/chat/keep.jsonl" ] || fail "followed a foreign link"
[ "$(readlink "$(dirname "$(sessions "$cf")")"/chatSessions.ezil-quarantine-*)" = "$outside" ] || fail "foreign link not kept aside"
rm "$(dirname "$(sessions "$cf")")"/chatSessions.ezil-quarantine-*
rm "$(sessions "$cf")"
printf 'not a dir' >"$(sessions "$cf")"                                    # regular file
ezil_editor_prepare "$cf" "$workspace"
[ -L "$(sessions "$cf")" ] || fail "file not replaced by link"
[ "$(cat "$(dirname "$(sessions "$cf")")"/chatSessions.ezil-quarantine-*)" = 'not a dir' ] || fail "file not kept aside"
mv "$workspace/.ezil/chat" "$root/chat-saved"
ln -s "$outside" "$workspace/.ezil/chat"                                    # planted workspace link
ezil_editor_prepare "$cf" "$workspace"
[ -d "$workspace/.ezil/chat" ] && [ ! -L "$workspace/.ezil/chat" ] || fail "workspace chat link followed"
[ "$(readlink "$workspace/.ezil/"chat.ezil-quarantine-*)" = "$outside" ] || fail "planted link not kept aside"
rm -rf "$workspace/.ezil/chat"; mv "$root/chat-saved" "$workspace/.ezil/chat"

# 5. A link failure never blocks the editor; settings restore still gates it.
broken="$root/broken-user"
out="$( { ln() { return 1; }; ezil_editor_prepare "$broken" "$workspace"; } 2>&1 )" || fail "link failure blocked launch"
[[ "$out" == *"chat history link failed"* ]] || fail "link failure not reported"
[ -f "$broken/.ezil-state-ready" ] || fail "marker missing after link failure"

# 6. A workspace replaced under a running editor gets its chat directory back at capture.
rm -rf "$root/chat-saved2"; mv "$workspace/.ezil/chat" "$root/chat-saved2"
ezil_editor_capture "$cf" "$workspace"
[ -d "$workspace/.ezil/chat" ] || fail "capture did not recreate the chat directory"
rmdir "$workspace/.ezil/chat"; mv "$root/chat-saved2" "$workspace/.ezil/chat"

# 7. User Git never sees .ezil (self-ignoring); a normal file is the positive control.
git -C "$workspace" init -q
printf 'x\n' >"$workspace/app.txt"
status="$(git -C "$workspace" status --porcelain --untracked-files=all)"
[[ "$status" == *"app.txt"* ]] || fail "positive control: untracked file not listed"
[[ "$status" != *".ezil"* ]] || fail ".ezil visible to git: $status"
git -C "$workspace" add -A
! git -C "$workspace" ls-files | grep -q '^\.ezil/' || fail ".ezil staged by git add -A"
printf 'custom\n' >"$workspace/.ezil/.gitignore"
ezil_editor_prepare "$cf" "$workspace"
[ "$(cat "$workspace/.ezil/.gitignore")" = 'custom' ] || fail "existing .gitignore overwritten"

# 8. Copilot's derived session index is off and its old copy is dropped.
node - "$cf/Machine/settings.json" <<'JS'
const assert = require('node:assert/strict');
const machine = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
assert.equal(machine['github.copilot.chat.localIndex.enabled'], false);
assert.equal(machine['chat.viewSessions.enabled'], false);
JS
store="$cf/User/globalStorage/github.copilot-chat"
mkdir -p "$store"
for f in session-store.db session-store.db-wal session-store.db-shm agent-traces.db; do printf 'x' >"$store/$f"; done
ezil_editor_prepare "$cf" "$workspace"
[ ! -e "$store/session-store.db" ] && [ ! -e "$store/session-store.db-wal" ] && [ ! -e "$store/session-store.db-shm" ] || fail "session index copy kept"
[ -f "$store/agent-traces.db" ] || fail "unrelated extension data removed"
printf 'Linux chat history relocation, migration, restart, odd entries, git ignore and Copilot index: passed\n'
