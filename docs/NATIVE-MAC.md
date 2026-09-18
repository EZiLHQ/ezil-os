# Native Mac host (internal)

`macos-electron/` packages the same generated `/os` shell used by the hosted
desktop. The installed application does not use the retired SwiftUI sidebar as
its desktop. Electron owns the Mac window, the shell owns the wallpaper, dock,
and movable EZiL windows, and native surfaces are composed into those windows.

The first launch asks the user to start a local guest workspace. No EZiL login,
provider credential, or cloud connection is required. The guest identifier is a
random persisted value; it is not derived from hardware identifiers.
Settings can create a second managed workspace or open a native directory
picker and copy a project into it; renderer code never receives the source path.

## Security model

This mode is **trusted native development**, not a containment boundary:

- project commands, the embedded editor, terminal processes, and extensions run
  with the signed-in Mac user's permissions;
- renderer processes used for remote browser content are sandboxed and have no
  Node.js or EZiL preload bridge;
- local IPC accepts exact typed operations from the registered top-level shell
  frame only, with workspace, generation, and monotonic sequence validation;
- management HTTP and WebSocket traffic uses short-lived capabilities in
  headers, exact origin/host checks, and per-workspace authorization;
- Azure and Bedrock credentials are encrypted through macOS Keychain-backed
  Electron safe storage and are not returned to shell code;
- deleting an EZiL workspace removes verified app-owned paths only. It cannot
  undo changes that trusted commands made elsewhere on the Mac.

The runtime advertises this contract:

```text
contractVersion: 2
executionTarget: macos-host
isolation: trusted-native
editor: embedded-code-server
externalEditor: optional-microsoft-vscode
browser: native-chromium
cloudSync: disabled
```

## Desktop, editor, browser, and previews

The packaged Bun helper serves the generated shell assets. The Code icon opens
the bundled Apple Silicon code-server workbench inside a normal EZiL window. Its
user data, extensions, home directory, authentication material, and Unix socket
are private to the selected workspace. The optional Microsoft VS Code menu item
uses a separate EZiL profile and does not modify the user's normal VS Code
profile.

The Browser icon opens a Chromium `WebContentsView` inside the shared shell
window. The shell renders its own back, forward, reload, and address controls.
HTTPS and loopback HTTP/WS are allowed; non-loopback cleartext navigation,
popups, device access, and permission requests are denied. Downloads use a save
dialog rooted initially in the workspace's `Downloads` directory. Each
workspace has a separate persistent Chromium profile.

Preview frames accept only loopback ports explicitly registered for the active
workspace. Redirects and WebSocket/HMR traffic stay on those registered origins.
Editor failure is independent from desktop readiness: the desktop and browser
remain available and Code shows a retryable failure state.

## Persistence and removal

App-owned state is organized under workspace UUIDs. It includes managed project
files, embedded-editor data and extensions, Chromium profile data, and
preferences. Legacy workspace metadata can be migrated without deleting old VM
or WebKit data. Removal validates ownership, rejects symlink/path escapes, waits
for supervised processes, and never removes host-installed VS Code or unrelated
files.

## Diagnostics

Settings exposes allowlisted lifecycle events rather than raw process output.
The application menu can copy or save the same versioned report. Reports omit
project contents, URLs, paths, headers, cookies, provider values, and snapshots;
the serialized report is redacted again before export.

## Local checks

Use the pinned tool versions from `macos-electron/package.json`:

```sh
bun install --cwd native --frozen-lockfile --ignore-scripts
bun run --cwd native typecheck
bun test native/tests
npm --prefix macos-electron run check
npm --prefix macos-electron test
npm --prefix shell test
npm --prefix shell run check
```

On a graphical Mac, also run:

```sh
npm --prefix macos-electron run test:electron
npm --prefix macos-electron run package:internal
```

## Packaging and release gates

Internal packaging is intentionally Apple Silicon only. It pins Electron
44.4.1, Bun 1.3.14, Node 24.15.0, npm 11.12.1, and code-server 4.137.0. The
code-server archive is verified against SHA-256
`118604a8245816535d8e538f478d2ee93514bcb8ac75e210d2345a5dc7806f65`.

Packaging verifies inputs and architecture, rejects escaping links, preserves
upstream notices, signs nested code bottom-up, verifies the final app, creates
and verifies the DMG, and emits:

- `EZiL-OS-<version>-AppleSilicon-internal.dmg`
- the DMG `.sha256`
- `INVENTORY.json`
- `SBOM.json`

`.github/workflows/macos-internal.yml` builds on GitHub's Apple Silicon
`macos-15` image and runs a packaged offline guest smoke test before publishing
the exact artifact bytes. `.github/workflows/macos-e2e.yml` accepts only a
successful manual build for the same protected commit, then installs those exact
bytes on the dedicated, logged-in Apple Silicon runner. It never runs for a pull
request or unprotected ref.

The physical test records the artifact hash and proves shell startup, embedded
editor readiness, native Bun execution, loopback preview/HMR, browser profile
persistence, cleanup, and workspace restart. When the relevant Apple tools are
installed it also compiles and executes a Swift probe and builds a Metal
library. External Microsoft VS Code and live Azure/Bedrock checks are opt-in
because neither is required for offline guest startup.

The current DMG is ad-hoc signed for internal testing. Public enterprise
distribution still requires a reviewed Developer ID signing and Apple
notarization workflow. A Linux test run, or even a successful hosted build, must
not be described as physical-Mac acceptance.

Because browsers can quarantine an ad-hoc-signed download, internal testers may
need to use macOS's explicit **Open** or **Privacy & Security** approval for this
app. Do not disable Gatekeeper globally. Distribute broadly only after the exact
artifact has passed Developer ID signing, notarization, and physical-Mac
acceptance.
