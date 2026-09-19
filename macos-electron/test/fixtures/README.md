# Local product-flow fixtures

The coordinator installs `playwright-core@1.62.1` where the harness's CommonJS
`require` resolves it, prepares the native app/resources, and installs the web
fixture dependencies. The harness never installs anything. Node 24.15.0 is the
repository pin. An unlocked graphical macOS session is required.

Prepare a **disposable copy**, not the checked-in fixture, then install its exact
direct dependency versions (`vite@7.1.7`, `typescript@5.9.3`). Transitive dependency
resolution is not locked by this fixture. Keep a copy of the resolved lockfile
with the coordinator's run evidence if reproducibility across machines matters.

```sh
cp -R macos-electron/test/fixtures/web-project /private/tmp/ezil-flow-project
npm --prefix /private/tmp/ezil-flow-project install --ignore-scripts
```

Run from the repository root; data/evidence directories must be empty or absent.
Use the actual application executable, not `open`, a shell wrapper, or the `.app`
directory. For a packaged run `APP_ROOT` is the `.app` directory. For development
it is the absolute `macos-electron` directory, and `EXECUTABLE` is Electron's
binary. Development resources must already exist at the repository root.

```sh
EZIL_E2E_EXECUTABLE='/absolute/EZiL OS.app/Contents/MacOS/EZiL OS' \
EZIL_E2E_APP_ROOT='/absolute/EZiL OS.app' \
EZIL_E2E_DATA_ROOT=/private/tmp/ezil-flow-data-attached \
EZIL_E2E_PROJECT_ROOT=/private/tmp/ezil-flow-project \
EZIL_E2E_EVIDENCE=/private/tmp/ezil-flow-evidence-attached \
EZIL_E2E_KIND=attached \
.native-tools/node-v24.15.0-darwin-arm64/bin/node macos-electron/test/product-flow.cjs
```

Repeat with `EZIL_E2E_KIND=managed`, a fresh disposable project copy, and fresh
data/evidence directories. Each run seeds both kinds but tests only the selected
kind. Managed fixture dependencies link to the disposable copy's `node_modules`;
application source remains independent. Attached runs intentionally edit the
disposable original. Port selection is dynamic; strict-port failure fails the run.

The harness uses real dock clicks, Code quick-open/Command Palette/terminal,
Browser navigation and Settings registration. Screenshots and `result.json`
record completed stages. A stable fixture document identifier distinguishes HMR
from a reload. It does not dump page contents, terminal contents, or exception
messages. Evidence can include visible UI in screenshots; use only this isolated
fixture session. Readiness and each UI action allow 30 seconds.

The disposable fixture also receives test-only Vite middleware for delayed
navigation and upload/download controls. Upload uses the real page's file
input and Playwright's filechooser selection; native upload-dialog keyboard
navigation is a separate acceptance gate. Download acceptance observes a real
native Save action and exact saved bytes. The added Browser focus/slow-load and
Preview restart flows still require a fresh complete GUI run after integration.

Quit confirmation is native macOS UI: grant the invoking terminal/runner
Accessibility/Automation access to System Events. Cleanup searches only the
launched PID's native windows for `Stop workspace`, up to 45 seconds, and must
observe both the click and process exit. Missing-button exhaustion is a failure.
Quit timeout makes the
run fail; its fallback signals only that Electron process and is **not** proof
that all child processes stopped. Inspect that failed session before retrying.
Code shortcuts/Command Palette labels require English UI. Unsupported automation
of a native WebContentsView target fails the Browser stage; no iframe substitution
is used. Installed host npm must be available on PATH. Host startup files are
not loaded by the isolated HOME; provider environment variables are not inherited.

Native folder pickers, restart preservation, workspace switching, physical focus,
external VS Code, and Xcode opening/build/run are not acceptance claims of this
harness. Run the following separately with full Xcode, without an Apple account:

```sh
xcodebuild -project macos-electron/test/fixtures/mac-project/EZiLFixture.xcodeproj \
  -scheme EZiLFixture -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath /private/tmp/ezil-mac-fixture-build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build test
```

The shared scheme includes a SwiftUI macOS app and a hosted XCTest target with
two behavioral tests. macOS 14+ is the deployment target. No team, provisioning
profile, entitlements, package downloads, or third-party frameworks are needed.
Build/test and actual GUI launch remain separate verification steps.
