#!/usr/bin/env bash
# EZiL Chat history: one copy under <workspace>/.ezil/chat (the patched editor writes
# there); history already in an editor profile moves in. Linux coreutils.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/editor-state.sh"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export EZIL_HOSTS_FILE="$root/hosts"
printf '127.0.0.1 localhost\n' >"$EZIL_HOSTS_FILE"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
workspace="$root/workspace"
chat="$workspace/.ezil/chat"
mkdir -p "$workspace"
# Upstream profile location, one id per browser host the editor was opened at.
profile() { printf '%s/User/workspaceStorage/%s/chatSessions' "$1" "$2"; }

# 1. Cloudflare: fresh /tmp user data; the history folder exists before the editor starts.
cf="$root/cf-user"
ezil_editor_prepare "$cf" "$workspace"
[ -d "$chat" ] && [ ! -L "$chat" ] || fail "chat is not a real directory"
[ ! -e "$cf/User/workspaceStorage" ] || fail "profile chat storage created"
printf '{"kind":0,"v":{"sessionId":"s1"}}\n{"kind":1,"k":["customTitle"],"v":"Fix login"}\n' >"$chat/s1.jsonl"
cp "$chat/s1.jsonl" "$root/s1.expected"
# Container restart: /tmp is recreated, the workspace persists, the file is untouched.
rm -rf "$cf"
ezil_editor_prepare "$cf" "$workspace"
cmp -s "$chat/s1.jsonl" "$root/s1.expected" || fail "history changed across restart"
[ "$(find "$root" -name 's1.jsonl' | wc -l)" -eq 1 ] || fail "session stored more than once"

# 2. Existing AWS profile (warm marker): every profile chatSessions directory moves in,
#    whatever host its id came from; duplicates collapse, saved sessions are never overwritten.
aws="$root/aws-user"
printf '%s\n' "$workspace" >"$aws.marker"; mkdir -p "$aws"; mv "$aws.marker" "$aws/.ezil-state-ready"
mkdir -p "$(profile "$aws" -2ec3769a)" "$(profile "$aws" 31384936)" "$aws/User/workspaceStorage/no-chat"
printf 'old history\n' >"$(profile "$aws" -2ec3769a)/s2.jsonl"
printf 'flat\n' >"$(profile "$aws" 31384936)/s3.json"
cp "$chat/s1.jsonl" "$(profile "$aws" 31384936)/s1.jsonl"                 # identical duplicate
printf 'hidden\n' >"$(profile "$aws" 31384936)/.s4.jsonl"
ezil_editor_prepare "$aws" "$workspace"
[ "$(cat "$chat/s2.jsonl")" = 'old history' ] || fail "jsonl not migrated"
[ "$(cat "$chat/s3.json")" = 'flat' ] || fail "json not migrated"
[ "$(cat "$chat/.s4.jsonl")" = 'hidden' ] || fail "dot file not migrated"
cmp -s "$chat/s1.jsonl" "$root/s1.expected" || fail "saved session changed by duplicate"
[ ! -e "$workspace/.ezil/chat-conflicts" ] || fail "identical duplicate reported as conflict"
[ ! -e "$(profile "$aws" -2ec3769a)" ] && [ ! -e "$(profile "$aws" 31384936)" ] || fail "emptied profile directories kept"
[ -d "$aws/User/workspaceStorage/no-chat" ] || fail "unrelated workspace storage removed"
# Idempotent: nothing left to move, nothing changes.
before="$(cd "$chat" && find . -printf '%p %s %T@\n' | sort)"
ezil_editor_prepare "$aws" "$workspace"
[ "$(cd "$chat" && find . -printf '%p %s %T@\n' | sort)" = "$before" ] || fail "re-run changed history"
# Positive control for the conflict branch: different bytes under a saved name are kept aside.
mkdir -p "$(profile "$aws" 31384936)"
printf 'diverged\n' >"$(profile "$aws" 31384936)/s2.jsonl"
ezil_editor_prepare "$aws" "$workspace"
[ "$(cat "$chat/s2.jsonl")" = 'old history' ] || fail "saved session overwritten"
[ "$(cat "$workspace/.ezil/chat-conflicts/"*/s2.jsonl)" = 'diverged' ] || fail "conflicting copy lost"

# 3. Odd entries are moved aside, never followed.
outside="$root/outside"
mkdir -p "$outside"
printf 'keep\n' >"$outside/keep.jsonl"
mkdir -p "$aws/User/workspaceStorage/planted"
ln -s "$outside" "$aws/User/workspaceStorage/planted/chatSessions"         # profile link: skipped
ezil_editor_prepare "$aws" "$workspace"
[ -f "$outside/keep.jsonl" ] && [ ! -e "$chat/keep.jsonl" ] || fail "followed a planted profile link"
mv "$chat" "$root/chat-saved"
ln -s "$outside" "$chat"                                                    # planted workspace link
ezil_editor_prepare "$cf" "$workspace"
[ -d "$chat" ] && [ ! -L "$chat" ] || fail "workspace chat link followed"
[ "$(readlink "$workspace/.ezil/"chat.ezil-quarantine-*)" = "$outside" ] || fail "planted link not kept aside"
[ -f "$outside/keep.jsonl" ] || fail "planted link target touched"
rmdir "$chat"; mv "$root/chat-saved" "$chat"

# 4. A history-folder failure never blocks the editor; settings restore still gates it.
odd="$root/odd-workspace"; mkdir -p "$odd"; printf 'a file, not a directory' >"$odd/.ezil"
out="$(ezil_editor_prepare "$root/odd-user" "$odd" 2>&1)" || fail "history failure blocked launch"
[[ "$out" == *"chat history folder not prepared"* ]] || fail "history failure not reported"
[ -f "$root/odd-user/.ezil-state-ready" ] || fail "marker missing after history failure"
[ "$(cat "$odd/.ezil")" = 'a file, not a directory' ] || fail "user file replaced"

# 5. A workspace replaced under a running editor gets its history folder back at capture.
mv "$chat" "$root/chat-saved2"
ezil_editor_capture "$cf" "$workspace"
[ -d "$chat" ] || fail "capture did not recreate the chat directory"
rmdir "$chat"; mv "$root/chat-saved2" "$chat"

# 6. User Git never sees .ezil (self-ignoring); a normal file is the positive control.
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

# 7. Copilot's derived session index is off and its old copy is dropped.
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
printf 'Linux chat history folder, profile migration, restart, odd entries, git ignore and Copilot index: passed\n'
