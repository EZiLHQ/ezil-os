#!/usr/bin/env bash
# Execute with Linux util-linux flock; no locking shim or cloud credentials.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/editor-state.sh"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export EZIL_HOSTS_FILE="$root/hosts"
printf '127.0.0.1 localhost\n' >"$EZIL_HOSTS_FILE"
workspace="$root/workspace"
user_data="$root/user"
mkdir -p "$workspace/.ezil"
printf '// theme comment\n{"workbench.colorTheme":"Default Dark Modern",}\n' >"$workspace/.ezil/settings.json"
printf '// binding comment\n[{"key":"ctrl+alt+k","command":"workbench.action.files.save"}]\n' >"$workspace/.ezil/keybindings.json"
ezil_editor_prepare "$user_data" "$workspace"
cmp "$workspace/.ezil/settings.json" "$user_data/User/settings.json"
printf '// changed immediately\n{"workbench.colorTheme":"Default Dark+",}\n' >"$user_data/User/settings.json"
# Prove capture waits for the actual process lock and cannot publish early.
(
  exec 8>"$user_data/.ezil-state.lock"
  flock 8
  touch "$root/locked"
  while [ ! -f "$root/unlock" ]; do sleep 0.02; done
) &
locker=$!
while [ ! -f "$root/locked" ]; do sleep 0.02; done
(ezil_editor_capture "$user_data" "$workspace"; touch "$root/captured") &
capture=$!
sleep 0.2
[ ! -f "$root/captured" ]
touch "$root/unlock"
wait "$locker"
wait "$capture"
cmp "$workspace/.ezil/settings.json" "$user_data/User/settings.json"
# A new /tmp user-data directory restores both JSONC files from the checkpoint.
ezil_editor_prepare "$root/replacement" "$workspace"
cmp "$workspace/.ezil/settings.json" "$root/replacement/User/settings.json"
cmp "$workspace/.ezil/keybindings.json" "$root/replacement/User/keybindings.json"
# Actual failed rename keeps the saved bytes intact; no simulated copy function.
printf 'new edit' >"$user_data/User/settings.json"
original="$(cat "$workspace/.ezil/settings.json")"
mv() { return 1; }
if ezil_editor_capture "$user_data" "$workspace"; then exit 1; fi
[ "$(cat "$workspace/.ezil/settings.json")" = "$original" ]
unset -f mv
# Fresh users receive the image-owned settings and a single EZiL vendor group.
ezil_editor_prepare "$root/fresh" "$root/fresh-workspace"
node - "$root/fresh" <<'JS'
const assert = require('node:assert/strict'), fs = require('node:fs');
const root = process.argv[2];
const machine = JSON.parse(fs.readFileSync(root + '/Machine/settings.json', 'utf8'));
assert.equal(machine['chat.allowAnonymousAccess'], true);
assert.equal(machine['chat.disableAIFeatures'], false);
assert.equal(machine['chat.byokUtilityModelDefault'], 'mainAgent');
assert.equal(machine['chat.utilityModel'], 'ezil/qwen.qwen3-coder-next');
assert.equal(machine['chat.utilitySmallModel'], 'ezil/qwen.qwen3-coder-next');
assert.equal(machine['telemetry.telemetryLevel'], 'off');
assert.equal(machine['github.copilot.chat.tools.viewImage.enabled'], false);
assert.equal(machine['github.copilot.chat.virtualTools.threshold'], 64);
assert.deepEqual(machine['terminal.integrated.env.linux'], { EZIL_AI_PROXY_TOKEN: null, EZIL_AI_BASE_URL: null });
assert(!Object.keys(machine).some(key => /auto.?approve/i.test(key)));
assert.deepEqual(JSON.parse(fs.readFileSync(root + '/User/chatLanguageModels.json', 'utf8')), [{ name: 'EZiL', vendor: 'ezil' }]);
JS
# Hostile pre-existing Machine settings are replaced, even on a ready runtime;
# User JSONC and other vendors survive byte-for-byte / value-for-value.
cp "$root/fresh/Machine/settings.json" "$root/expected-machine.json"
printf '// user JSONC\n{"chat.disableAIFeatures":true,"editor.fontSize":17,}\n' >"$root/fresh/User/settings.json"
cp "$root/fresh/User/settings.json" "$root/expected-user.json"
printf '{"chat.disableAIFeatures":true,"chat.allowAnonymousAccess":false}\n' >"$root/fresh/Machine/settings.json"
printf '[{"name":"Other","vendor":"openai","extra":{"keep":true}}, {"name":"custom","vendor":"ezil"}]\n' >"$root/fresh/User/chatLanguageModels.json"
ezil_editor_prepare "$root/fresh" "$root/fresh-workspace"
ezil_editor_prepare "$root/fresh" "$root/fresh-workspace"
cmp "$root/expected-machine.json" "$root/fresh/Machine/settings.json"
cmp "$root/expected-user.json" "$root/fresh/User/settings.json"
node - "$root/fresh/User/chatLanguageModels.json" <<'JS'
const assert = require('node:assert/strict'), fs = require('node:fs');
const groups = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(groups.length, 3);
assert.deepEqual(groups[0], { name: 'Other', vendor: 'openai', extra: { keep: true } });
assert.deepEqual(groups[1], { name: 'custom', vendor: 'ezil' });
assert.deepEqual(groups[2], { name: 'EZiL', vendor: 'ezil' });
JS
# Malformed input is preserved for recovery, and cannot spoof the vendor gate.
printf 'broken "vendor":"ezil"' >"$root/fresh/User/chatLanguageModels.json"
ezil_editor_prepare "$root/fresh" "$root/fresh-workspace"
[ "$(cat "$root/fresh/User/"chatLanguageModels.json.invalid-*)" = 'broken "vendor":"ezil"' ]
cmp "$root/expected-user.json" "$root/fresh/User/settings.json"
# The seed replaces symlinks atomically, without clobbering the target.
rm "$root/fresh/Machine/settings.json"
ln -s "$root/expected-user.json" "$root/fresh/Machine/settings.json"
ezil_editor_prepare "$root/fresh" "$root/fresh-workspace"
[ ! -L "$root/fresh/Machine/settings.json" ]
cmp "$root/expected-user.json" "$root/fresh/User/settings.json"
# Exactly the draft's 13 sinks, once each; developer GitHub hosts stay usable.
[ "$(wc -l <"$EZIL_HOSTS_FILE")" -eq 14 ]
[ "$(sort "$EZIL_HOSTS_FILE" | uniq -d | wc -l)" -eq 0 ]
! grep -Eq '127.0.0.1 (api\.)?github\.com$' "$EZIL_HOSTS_FILE"
grep -qx '127.0.0.1 api.githubcopilot.com' "$EZIL_HOSTS_FILE"
# /proc/version is genuinely read-only even for root; no boot failure.
EZIL_HOSTS_FILE=/proc/version seed_blocked_ai_hosts
printf 'Linux editor restore, checkpoint, locks, failure preservation and chat seeds: passed\n'
