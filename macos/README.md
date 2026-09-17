# EZiL OS for macOS

This directory contains a small native Swift wrapper around the existing local
mode launcher. It does not reimplement Docker orchestration: the app stages the
same runtime as the release tarball and runs
`deploy/launcher/ezil-os.sh --no-browser` from its signed application bundle.

The UI provides:

- a Mac folder picker for the read/write workspace mounted at
  `/home/neko/project`;
- an **Open in Mac VS Code** action for editing that same folder with native
  Visual Studio Code;
- start, stop, logs, and an embedded `127.0.0.1` desktop view;
- a browser fallback and an optional image override for private/local images;
- cleanup through the launcher's existing signal handler when the app quits.

Docker Desktop and Bun are still prerequisites. The application adds them to
the GUI process `PATH` from their common Intel, Apple Silicon, Docker Desktop,
and `~/.bun` locations; it never downloads or installs either dependency.

The distinction is deliberate: the wrapper and embedded WebKit view are native
macOS code, while the EZiL desktop, its VS Code, and its Chrome run inside a
Linux container on Docker Desktop. That container is local to the Mac; it is
not a Cloudflare machine or another remote host. The **Open in Mac VS Code**
button is the native alternative, and both VS Code instances address the same
bind-mounted files.

## Local development build

Run on macOS with Xcode command-line tools installed:

```bash
./macos/test.sh
./macos/build-dmg.sh --version 0.0.0 --no-notarize
```

The result is `macos/dist/EZiL-OS-0.0.0-macOS.dmg`. It is ad-hoc signed and is
only for local testing. The manual **macOS Internal DMG** GitHub Actions
workflow builds the same path on `macos-latest` and uploads the DMG plus its
SHA-256 file for 14 days. It needs no Apple credentials. An internal tester
must Control-click the installed app and choose **Open**, or approve it in
**System Settings → Privacy & Security**, because the build is not notarized.

## Distribution build

`release.yml` imports the Developer ID certificate into an ephemeral keychain
and calls:

```bash
./macos/build-dmg.sh --version <version> --require-signing
```

The required repository secrets are documented in `docs/RELEASE.md`. The
builder signs the app and DMG, submits the DMG with `notarytool`, staples and
validates the ticket, verifies the disk image, and only then attaches it to the
draft GitHub Release. `deploy.yml` waits for that exact asset before publishing
the draft. This path requires a paid Apple Developer membership, a Developer ID
Application certificate, and an app-specific Apple password; a normal Apple ID
password is neither required nor accepted for the internal workflow.

## File synchronization boundary

The workspace is a Docker bind mount, not a separate synchronization engine.
Writes from the Linux desktop and writes from macOS address the same host
files. Selecting an iCloud Drive, Dropbox, or similar folder may add that
provider's cross-device replication, but EZiL OS does not upload workspace
files itself.
