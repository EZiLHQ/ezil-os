# Legacy SwiftUI / Virtualization implementation

The active Apple Silicon host is now [macos-electron](../docs/NATIVE-MAC.md).
The files in this directory are retained for migration compatibility and
historical VM diagnostics. They are **not** the active installer or public
release runtime. There is no VM in the Electron DMG.

Existing data under `~/Library/Application Support/EZiL OS` is preserved.
Electron copies each legacy `workspaces/<uuid>/files` directory once into its
own inventory under `~/Library/Application Support/EZiL OS Native`. It keeps
the old guest UUID when valid, assigns new random native workspace UUIDs, and
records the migration. Old `runtime.img`, editor credentials, and WebKit
profiles stay in their original locations. Native removal never removes these
legacy resources. Legacy cleanup is a separate, explicit manual operation;
back up old data first. Do not use the old app's Remove action for migration.

`bash macos/test.sh` validates legacy script syntax and runs the Swift core
compatibility tests on macOS. Non-Mac hosts report that Swift tests are
unavailable; this is not VM or Mac runtime validation.

The former VM build and physical tests require the explicit
`EZIL_LEGACY_VM_MAINTENANCE=1` environment switch. They are retained only for
maintenance and are disconnected from active CI/release packaging.
