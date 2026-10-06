#!/usr/bin/env bash
# Execute with Linux util-linux flock; no locking shim or cloud credentials.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/editor-state.sh"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
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
printf 'Linux editor restore, checkpoint, lock contention, failure preservation: passed\n'
