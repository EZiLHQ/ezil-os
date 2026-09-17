# EZiL OS for Apple Silicon

The Mac app is a native SwiftUI shell around a persistent ARM Linux virtual
machine. It uses Apple's Virtualization framework directly; Docker Desktop,
Bun, GHCR access, and an EZiL account are not runtime prerequisites.

## Product boundary

- Home, Browser, Files, Settings, and window chrome are native macOS UI.
- The browser is a `WKWebView` with a persistent profile unique to the EZiL
  workspace. It does not reuse Safari or Chrome data.
- Code OSS is provided by code-server inside the VM. Its terminal, extensions,
  package managers, and builds are Linux processes using the Mac's CPU and
  memory through hardware virtualization. Its private-network endpoint uses a
  random per-workspace password that the dedicated editor view submits.
- Imports are copied into an app-managed directory shared only with the VM.
  Original Mac folders are never mounted. Export is an explicit copy out.
- Native Xcode/iOS builds and Metal GPU compute are outside the first release.

Application data lives under `~/Library/Application Support/EZiL OS`. The app
can remove a workspace and its WebKit profile. Moving the `.app` to Trash does
not automatically remove Application Support data.

## Testing layers

`./macos/test.sh` runs the pure Swift workspace/runtime unit tests on macOS,
type-checks the complete native app, validates scripts, and enforces the
runtime/package boundary. Pull-request CI additionally builds a DMG containing
a conspicuous non-bootable fixture; that DMG is never uploaded.

The manual **macOS Internal DMG** workflow builds the pinned ARM runtime on a
native ARM Linux runner, embeds it in an ad-hoc-signed app on `macos-14`,
verifies the disk image, and uploads:

`EZiL-OS-<version>-AppleSilicon.dmg`

The **macOS Physical Runtime E2E** workflow uses a trusted, disposable physical
Apple Silicon runner labelled `ezil-vz`. It boots the same runtime twice,
checks ARM execution and code-server health, proves disk persistence, and
verifies cleanup. It is intentionally `workflow_dispatch` only; public pull
request code must never execute on that runner.

## Building

Build the runtime on native ARM64 Linux:

```bash
sudo apt-get install e2fsprogs
./macos/runtime/build-runtime.sh /tmp/ezil-vm-runtime
```

Build an internal DMG on Apple Silicon or an Apple Silicon-capable macOS build
runner:

```bash
./macos/test.sh
./macos/build-dmg.sh \
  --version 0.0.0 \
  --runtime /tmp/ezil-vm-runtime \
  --no-notarize
```

The public release job passes `--require-signing`, imports a Developer ID
certificate into an ephemeral keychain, signs with the virtualization
entitlement and hardened runtime, notarizes, staples, verifies, and only then
attaches the DMG to the draft release. An ordinary Apple ID password is not a
substitute for the required Developer Program certificate and app-specific
notarization password.

The VM recipe pins the Ubuntu OCI index and verifies the pinned code-server
package SHA-256. Runtime releases include the Dockerfile, init script, package
inventory, manifest, and checksums alongside the kernel, initramfs, and disk.
