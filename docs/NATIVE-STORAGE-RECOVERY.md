# Local storage recovery — 2026-09-18

The installed `/Applications/EZiL OS.app` and its data have not been replaced.
No projects, simulator devices, Time Machine snapshots, or personal documents
were deleted during this cleanup.

Three inactive, reinstallable simulator runtimes (iOS 18.0, 18.2 and 18.4) were
archived to the attached SSD, verified byte-for-byte with SHA-256, then removed
from CoreSimulator using Apple's `simctl runtime delete` with exact IDs.
The manager now lists zero runtimes. macOS still retains MobileAsset source
images; they are not manually deleted or counted as immediately reclaimed.

Recovery images and SHA-256 manifest:

`/Volumes/9502040569/EZiL-Local-Build/2026-09-18/recovery/simulators/`

To restore one, verify its SHA-256 against `manifest.json`, then use:

```sh
/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl runtime add '/absolute/path/to/the/recovery-image.dmg'
```

Alternatively install the required runtime through full Xcode's Components
settings. Runtime installation is separate from existing simulator device data.
Do not use `--move`: keep the recovery copy until restoration is verified.

Node/npm tooling, the code-server cache, disposable projects, UI evidence, and
future packaging staging are on the same SSD under `EZiL-Local-Build/2026-09-18`.
The repository's ignored `.native-tools` symlink points there. Keep this volume
connected while building; these relocations did not change global tool defaults.

Internal free space was about 22 GiB after this pass (initially 7.1 GiB).
The owner is cleaning concurrently, so this is a snapshot, not a guaranteed
attribution of all reclaimed bytes. The 40–50 GiB free-space target is not yet met.

## Additional verified cleanup

Twenty old VS Code extension versions were both marked obsolete in VS Code's
`.obsolete` file and absent from its active `extensions.json` inventory. Their
816,472,233 bytes of regular-file content were copied to the SSD; every file's
SHA-256 and each symlink target were compared before inventoried removal of the
inactive internal copy. External VS Code was not running. Active extensions,
profiles and project files were not removed.

Recovery root and per-file manifest:

`/Volumes/9502040569/EZiL-Local-Build/2026-09-18/recovery/obsolete-vscode-extensions/manifest.json`

For recovery, quit external VS Code, verify the desired archived directory
against this manifest and copy that named directory back into
`/Users/midhun/.vscode/extensions/` only if its destination is absent. To actually
use an old version, install that version through VS Code; the original obsolete
marker was deliberately preserved, so VS Code may remove a restored inactive
copy again. The SSD archive remains available regardless.

After this pass the internal Data volume had about 21 GiB free and the SSD had
174 GiB free. macOS retains about 25 GiB of simulator MobileAsset images and one
purgeable local Time Machine snapshot. Neither was manually removed. The
remaining space cannot be attributed to removable junk; deleting the snapshot
would remove a local restore point and requires a separate user choice.

## Moves after Xcode installation

The user authorized moves, not disposal. Three Downloads items were copied
with macOS resource forks, extended attributes and ACLs preserved, checked
against SHA-256/mode inventories, and rechecked at the source before completing
their cross-volume moves. Links at the original Downloads paths point to the
SSD copies. The Downloads directory and new-download location are unchanged.

- `ChatGPT.dmg`: 635,551,986 bytes.
- `Notion-7.32.0-arm64.dmg`: 122,612,020 bytes.
- `Screen Recording 2026-08-05 200843.mp4`: 420,250,024 bytes.

Total relocated regular-file content: 1,178,414,030 bytes. Internal free space
increased from about 6.4 to 7.4 GiB during this pass; the SSD has about 173 GiB
free. This does not meet the 40–50 GiB internal target, but Xcode DerivedData,
test result bundles, tooling and packaging staging remain on the SSD.
Later development/testing activity left 6.1 GiB free internally at the final
check; do not treat the immediately-post-move value as permanently available.

Recovery copies and manifest:

`/Volumes/9502040569/EZiL-Local-Build/2026-09-18/recovery/downloads-relocated/manifest.json`

Keep the SSD connected to use these links. To restore an item internally,
first verify its archived hash against the manifest, verify that the original
path is still exactly the link to that archive, remove only that link, and use
`ditto --rsrc --extattr --acl` to copy the archived item back to its absent
original path. Verify the restored hash; retain the SSD copy until satisfied.

`_REVIEW-AND-DELETE` and `20-Images` could not be fully read/verified because of
macOS permissions, so neither folder was moved or deleted. No restricted
system assets, Time Machine snapshots, active project folders or the installed
EZiL application/data were deleted in this continuation.
