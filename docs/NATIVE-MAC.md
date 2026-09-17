# Native Mac host (internal)

The active Apple Silicon implementation is `macos-electron/`: Electron owns
the shared EZiL desktop and a Chromium browser window, and hands editor work
to an independently installed, verified Microsoft Visual Studio Code. The
SwiftUI/Virtualization implementation in `macos/` is legacy migration code.
No VM, Docker, code-server, or redistributed VS Code ships in this installer.

This is **trusted native execution**. Project commands and VS Code extensions
have the Mac user's permissions. Workspace directories, IPC checks and browser
sandboxing do not provide filesystem containment against code running as that
user. Cloud sync is disabled. The desktop and browser require neither a
provider nor VS Code; internet sites themselves still require connectivity.

## Status and validation gates

This checkout lacks Worker A's `native/` helper and `extensions/ezil-vscode`.
Packaging fails when these inputs or the exact shell assets are absent. Startup
uses the reviewed Worker A environment names and `/os` route, pending an integrated
run. Connector readiness/preview and VS Code model-provider integration are
explicitly unavailable; no connector descriptor is minted or passed to VS Code.
No successful Mac build, Keychain test, VS Code GUI test, physical run, signed
release, or notarization is claimed by this change.

Electron 40.0.0, Bun 1.3.14, Node 24.15.0 and npm 11.12.1 are the selected exact
tool versions. This environment cannot resolve npm or bind loopback sockets;
unit tests use the real broker handler with an in-process HTTP transport.
Electron/Chromium tests need the installed Electron binary and a GUI/Xvfb.
These pins need normal security updates before production distribution.
There is no committed npm transitive lock yet because registry access was
unavailable (`EAI_AGAIN registry.npmjs.org` on the review retry). Workflows use
`npm ci`; they and packaging remain blocked until a real registry-generated
`macos-electron/package-lock.json` is committed. No integrity values were invented.

## Development and internal packaging

Run dependency-free checks on Node 24.15.0:

```sh
npm --prefix macos-electron run check
npm --prefix macos-electron test
bash macos/test.sh
```

On an Apple Silicon Mac, after the helper has landed:

```sh
cd macos-electron
npm install --global npm@11.12.1 --no-audit --no-fund
npm ci --no-audit --no-fund
npm run test:electron
npm run package:internal
```

The package script requires Darwin arm64. It copies the installed pinned
Electron application, exact `app/public/os` assets, `native/` source and committed
`extensions/ezil-vscode` into `Resources/extensions/ezil-vscode`, installs
any helper production dependencies with Bun's frozen lock and scripts disabled,
and obtains the exact Darwin arm64 Bun npm package. It records versions,
checksums, resolved package locks, project/Puter/Electron/Chromium/Bun licenses,
signs ad-hoc, verifies the bundle, creates and verifies the DMG, then emits its
SHA-256. Electron supplies Node for main; no separate Node runtime ships.

Outputs are `macos-electron/dist/EZiL-OS-<version>-AppleSilicon-internal.dmg`,
its `.sha256`, and `INVENTORY.json`. Set `EZIL_BUILD_VERSION` and `EZIL_DIST`
to select a version and output directory. `EZIL_PACKAGE_HELPER` and
`EZIL_PACKAGE_SHELL` override staging inputs; they are copied, never rebuilt
or replaced with fixtures. The inventory identifies their exact bytes.
Input manifests record copied shell/helper/extension paths and SHA-256 hashes
separately from the final resource inventory. Missing extension entrypoints,
copy mismatches, links or missing host lock stop packaging.
The packaging license download needs HTTPS access to the versioned Bun repo.
Ad-hoc distribution is internal only; Gatekeeper acceptance is not claimed.

For development, `npm start` accepts these inherited, non-provider settings:
`EZIL_BUN_PATH`, `EZIL_HELPER_PATH`, `EZIL_SHELL_ASSETS`, `EZIL_SHELL_PATH`
(default `/os`), and `EZIL_NATIVE_APP_DATA`. All runtime paths are absolute.
Use a canonical data path without symlink ancestors. Missing helper/assets
produce a native startup error and a fixed diagnostic code rather than a
different runtime fallback.

## Worker A integration contract — assumptions to confirm

Electron spawns **only** the configured bundled Bun executable with literal
arguments `run <absolute-native-root>/src/main.ts`, using the native package as
cwd and a minimal inherited environment. It adds:

| Environment name | Meaning |
|---|---|
| `EZIL_NATIVE_DATA_ROOT` | App-owned `helper/` directory, outside projects |
| `EZIL_NATIVE_WORKSPACE_ID` | Active native workspace UUID |
| `EZIL_NATIVE_WORKSPACE_ROOT` | Active workspace's managed `files/` directory |
| `EZIL_NATIVE_SHELL_ASSETS` | Exact packaged `app/public/os` directory |
| `EZIL_NATIVE_ADMIN_CAPABILITY` | Random 256-bit bootstrap/admin capability |
| `EZIL_NATIVE_HOST` | `127.0.0.1` |
| `EZIL_NATIVE_PORT` | `0` (ephemeral port) |

Within 20 seconds, stdout must contain one newline-terminated line:

```text
EZIL_NATIVE_READY {"contractVersion":1,"port":12345,"capabilities":{"executionTarget":"macos-host","isolation":"trusted-native","editor":"external-vscode","browser":"native-chromium","cloudSync":false}}
```

Other startup stdout is bounded at 64 KiB and discarded; stderr is drained
without logging. The helper must bind exclusively to loopback, authenticate
shell/assets and every API request with `Authorization: Bearer <admin capability>`,
and serve the shared desktop at `EZIL_SHELL_PATH` (default `/os`). Electron adds
that header and the exact helper `Origin` to requests to the helper origin,
including API requests where Chromium omits Origin. Worker A's navigation-only
`/os` exception may allow omitted Origin; this host supplies it.
It never exposes the capability to renderer code, URLs or project processes.
The helper must strip capabilities from any environment it passes to commands.
Current host networking permits HTTP to the helper origin only; WebSocket-based
helper APIs would need an explicit matching-origin addition and tests.
Helper restarts require reopening the workspace; Electron does not replay
failed commands. Helpers must terminate their own command sessions on shutdown.

The shell uses the sandboxed `window.ezilNative` bridge:

```js
await window.ezilNative.operation({ op: 'surface.open', workspaceId: activeWorkspaceID, surface: 'code' });
await window.ezilNative.operation({ op: 'surface.focus', workspaceId: activeWorkspaceID, surface: 'browser' });
```

Both operations accept exactly `op`, `workspaceId` and `surface`, with only
`code` or `browser`. Results are exactly `{ok:true,state:'opened'}` or
`{ok:false,state:'unavailable'}`. No URL, executable, arguments or diagnostics
cross this bridge. Main checks the registered desktop, exact document URL,
top frame and active workspace. Code opens/focuses the dedicated editor profile;
Browser opens/focuses its saved tabs without a caller-supplied destination.

The existing `request()` API remains for onboarding and Settings. Its `status`
returns capabilities, activeID, workspace summaries, VS Code/provider status,
explicit connector unavailability and redacted diagnostics. Only native Settings
performs creation/import/removal and provider setup. The helper must use the
passed managed workspace rather than creating a competing inventory.

The separate `private/ai-broker.json` descriptor is 0600 JSON:
`{contractVersion:1,url,capability,operations:["models","chat"],formats:[...]}`.
It has no integrated consumer here and is not passed to the helper or VS Code.
A future verified consumer may receive its filename only under `EZIL_AI_BROKER_FILE`.
The proposed protocol uses bearer authentication for `GET /v1/models`
and `POST /v1/chat` with exactly
`{model,messages:[{role,content}],maxTokens}` and `Content-Type: application/json`.
Models returns `{models:[configuredModel]}`. Azure streams raw SSE; Bedrock
streams raw AWS eventstream (`application/vnd.amazon.eventstream`). Worker A
must decode those formats and forward cancellation, never send the descriptor
or bearer capability into the desktop/project/editor, and redact provider data.
No destination override, proxy, general HTTP operation, tool execution, or
SigV4 signing endpoint exists. API/schema names above are explicit assumptions,
not evidence that Worker A already implements them.

## Browser, editor and credentials

The desktop and packaged toolbar use `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`; main validates the registered webContents, exact
document URL, top frame and request schema. Each browser uses a persistent
`session.fromPath()` partition under its inventoried workspace. The packaged
toolbar occupies 108 pixels above a `WebContentsView`. Remote views have no
preload and cannot invoke native IPC. Tabs, back/forward/reload, DevTools and
tab URLs persist. Permissions, devices, popups, non-HTTPS destinations other
than exact loopback HTTP, and automatic downloads are denied. User-approved
downloads open a save dialog and are never executed automatically.

VS Code discovery checks only `/Applications/Visual Studio Code.app` and
`~/Applications/Visual Studio Code.app`. It verifies bundle ID
`com.microsoft.VSCode`, Apple's code-signing anchor, TeamIdentifier `UBF8T346G9`
and Microsoft Corporation's Developer ID identity, then launches
`Contents/MacOS/Electron` directly with fixed arguments, a literal workspace,
and unique app-owned user-data/extensions directories. PATH and arbitrary
editor paths are never consulted. Before launch the bundled connector is copied
and SHA-256 verified in only that workspace's extensions directory; other
extensions/profiles are preserved. Missing or malformed bundled extension blocks
editor startup. `surface.focus` forwards fixed reuse-window arguments to the same
dedicated profile. No provider secrets, admin capability, `EZIL_BROKER_FILE` or
`EZIL_AI_BROKER_FILE` are passed to the editor.

Connector enablement requires confirming the helper's admin mint/revoke API and
extension descriptor contract together. Electron must mint after helper readiness,
write a workspace-scoped, short-lived descriptor atomically as 0600 outside the
project, refresh before expiry, revoke/remove on helper/workspace shutdown and
fail closed on refresh errors. This lifecycle is unimplemented, so no incompatible
AI descriptor is substituted and readiness/preview stay explicitly unavailable.
No stable VS Code model-provider API integration is implemented or claimed.

Stop sends SIGTERM only to the live launched
child. An untracked exit or a prior app session leaves the editor state unknown
and blocks removal; it never kills saved PIDs or name-matched processes.
Recover unknown instances manually after confirming the app and all its
children are stopped; automatic reconciliation is intentionally unimplemented.

Provider credentials are entered in native macOS dialogs, carried over private
pipes to main, encrypted by Electron `safeStorage` (macOS Keychain), and stored
in an app-owned 0600 file. No provider secret goes to a renderer, argument,
environment, URL, log or VS Code settings. Azure accepts only HTTPS Azure OpenAI
resource endpoints and a configured deployment. Bedrock uses a configured region,
model ID and API-key bearer token. Temporary IAM is explicitly unavailable.
The loopback broker rejects Origin-bearing requests, enforces its Host and
capability, follows no redirects and never retries ambiguous failures. Limits:
256 KiB requests, 8 MiB responses, two concurrent requests, 60 seconds,
100 messages, 8192 requested output tokens. Cancellation aborts upstream work.
Settings reports request/completion/failure counts and bytes, not inferred
token prices or costs. Live provider billing/format compatibility remains untested.

## Data lifecycle and legacy migration

Application Support `EZiL OS Native/` holds the guest UUID, workspace inventory,
helper metadata, Chromium/editor profiles and private broker files. Each native
workspace gets a random UUID. Imports copy files and reject symlinks, hardlinks,
special files and excessive trees (100,000 entries or 20 GiB).

Legacy `EZiL OS/workspaces/<uuid>/files` are copied once, recorded in the same
inventory transaction, and remain migrated even after the native copy is
removed. Old VM disks, WebKit profiles, original imports and old editor passwords
are preserved. Failed/partial copies are retained for recovery, never used as
grounds to delete a source. Native removal first requires a stopped editor,
closed browser and stopped active helper; it inventories and verifies file
identities before deleting only entries under the app-owned workspace. Changed
identities and links cause refusal. Same-user malicious concurrent mutation is
outside this trusted-native boundary. Files not safely removable require manual
inspection. Legacy deletion remains a separate manual operation.

## Hosted and physical CI

`macos-internal.yml` uses `macos-14` (ARM64 for current public repositories, per
[GitHub runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners));
the build also asserts `uname -m` is `arm64`. The documentation fetch was blocked
by DNS here. It runs tests and Electron GUI smoke on hosted Apple Silicon,
builds the real internal DMG, and uploads DMG/checksum/inventory. It never builds
or uploads a VM. `ci.yml` adds Linux/macOS native host and Electron tests.

`macos-e2e.yml` is manual and protected-branch-only. Select the successful hosted
**workflow_dispatch** build run for the exact same commit. A hosted validation
job verifies run type, workflow path, branch, commit and success before the
physical job can run. Configure the `native-physical` environment for protected
branches and maintainer approval. The runner labels are
`[self-hosted, macOS, ARM64, ezil-native]`; the runner must be a disposable,
logged-in GUI Mac with Xcode and standard signed Microsoft VS Code installed.
No PR event or PR artifact is accepted. If this runner is absent, the job queues;
hosted packaging is not a substitute for physical evidence.

The physical script downloads the exact build artifact, verifies SHA-256,
mounts read-only, copies that app to a temporary installation, verifies its
signature and launches its packaged smoke entrypoint. Evidence includes the
artifact hash, inventory, OS/architecture/Xcode/VS Code/Electron/Bun versions,
screenshots, desktop rendering, real WebContentsView isolation, browser storage
and tab persistence, a Bun project build, verified editor launch/stop, workspace
persistence and outside-file removal canaries. Evidence is reuploaded even on
failure. It does not rebuild source, remove quarantine, or claim Gatekeeper
acceptance. The smoke checks persistence across reopened sessions/stores;
full process-restart and helper project-command API coverage still need Worker A
integration. Failure data stays on the disposable runner for inspection.

Public Mac packaging in `release.yml` is explicitly skipped without failing
the workflow; tarball and launcher releases continue. It cannot
attach an ad-hoc installer to a public release. Developer ID signing, hardened
runtime entitlements, notarization, stapling, Gatekeeper verification, and
physical evidence for the signed bytes must be implemented/reviewed before
enabling public distribution. This work does not deploy or publish anything.
