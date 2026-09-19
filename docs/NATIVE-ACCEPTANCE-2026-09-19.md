# Local macOS app testing — September 19

## Current continuation: page zoom and real Bun development

Status: **unfinished; 0.1.0 is installed, final patched packaging and acceptance
remain pending**. The user removed the old 0.0.14 application and reconnected
the SSD. The historical sections below describe earlier checks, not the
current installed state.

### Latest installed-machine continuation (19:13 local)

The installed `/Applications/EZiL OS.app` contains runtime commit `53b0b4c`.
Its matching internal DMG is in the September 19 SSD build root's `dist/`:
`EZiL-OS-0.1.0-AppleSilicon-internal.dmg`, SHA-256
`27c30162febfb2bc00b338738a11b2d685e15f04054e0396c6120019e98714b7`.
Deep/strict signature verification passed. Staged and installed bundle
fingerprints matched 7,280 entries, including symlink targets, file hashes
and executable modes. The DMG was ejected before normal installed launch.
Installed packaged mode was verified and desktop readiness measured 5,881 ms.
This is one timing, not the required five-launch acceptance.

Fresh installed-product observations:

- Removed the accidentally created `VirtualBackgrounds` attached association
  through Settings > Detach. A before/after tree hash confirmed the original
  folder was unchanged. No original project files were deleted.
- Attached `/Users/midhun/Projects/EZiL Local Playground` through the actual
  native picker, verifying its destination before Open, then switched to it.
  The host metadata confirms this exact original path.
- Found a real renderer timeout defect: a folder selection taking more than
  ten seconds attached successfully but reported failure and left Settings
  stale. Reopening Settings exposed the successfully attached folder. Commit
  `3a9996b` fixes host-owned dialog deadlines and includes deterministic delayed
  success/cancel/rejection and ordinary-timeout regressions. This fix is **not
  yet in the installed app or DMG**; those must be rebuilt and retested.
- Opened embedded Code from the dock, trusted only the fixture, created
  `bun-demo/server.ts` through Explorer, and verified the saved bytes. Started
  `bun --hot bun-demo/server.ts` through its integrated terminal. The actual
  Chromium Browser rendered its page at `http://localhost:49814/`; the + button
  changed page zoom from 100% to 110%. The server remains running for now.
- EZiL Settings > Xcode opened `apple-app/EZiLFixture.xcodeproj` in native
  Xcode. Native Cmd+B completed with **Build Succeeded**. Native Cmd+U reached
  the macOS **Developer Tools Access** authentication prompt before running
  tests. The user must approve with Touch ID/password on the Mac. This is not
  a LuLu or Accessibility prompt. XCTest/UI run acceptance is still pending.
- LuLu remains enabled. Identified installed-editor Open VSX requests were
  allowed temporarily; an optional Microsoft telemetry request was blocked
  once. Further prompts were not broadly authorized or suppressed.

Evidence: `evidence/installed-picker-verified.png`,
`installed-bun-browser-zoom.png`, `installed-xcode-open.png`,
`xcode-build-state.png`, and `xcode-test-state.png`. Some captures contain LuLu
or authorization overlays and are **not clean final visual acceptance**.
The Xcode build success was also read from its native accessibility status.

The full development harness has passed individual Code/build, native
download, HMR and lifecycle stages across runs, but has **no complete passing
run yet**. Native terminal-focus automation was corrected and still needs a
fresh full run. Five launches, the 30-minute development session, fresh
installed external-editor sharing, and final process-cleanup audit remain
open. Do not treat the existence of the installed application as release
completion. Current free space is approximately 8.5 GiB internally and
151 GiB on the SSD; no additional user files were moved in this continuation.

Builds, runtime staging and evidence now use
`/Volumes/9502040569/EZiL-Local-Build/2026-09-19/`. Both original application
data directories were copied with resource forks, extended attributes and ACLs
to its private `recovery/` directory. Full post-copy `diff -rq` checks passed;
original data was not removed. There is no backup of the user-deleted app.

Browser page zoom now has minus, percentage/reset and plus controls, native
shortcuts and separate View-menu actions from desktop zoom. Actual Chromium
content at 125% changed its document viewport without changing shell bounds
or shell zoom. The compact toolbar responds to internal Browser width.
Chromium's same-origin zoom behavior applies; per-tab zoom isolation is not
claimed.

Pinned-tool checks: Node 24.15.0, npm 11.12.1, Bun 1.3.14,
Electron 44.4.1, code-server 4.137.0 and Playwright Core 1.62.1.

- Host: **112 passed, 0 failed, 1 skipped**. The skipped check requires the
  actual old installed 0.0.14 source, which the user deleted.
- Native/connector: **32 passed**, real sockets enabled.
- Host syntax, native/connector typechecks, shell load and affected
  Browser/runtime/Code/spinner tests passed. Generated-shell drift passed.
- Real tabbed Browser flow including content zoom passed in the development
  app. See `evidence/tabs-flow-oyYbxo/result.json` on the SSD.
- Through real Code dock/Explorer/editor/terminal controls, created
  `bun-demo/server.ts`, saved it, and started `bun --hot bun-demo/server.ts`.
  Browser loaded `localhost:49814`; Settings registered that port and Preview
  rendered the server page. A Code source edit was saved byte-for-byte and
  Bun's hot restart returned the new text. This is server hot restart, not
  browser HMR without reload.
- Closing/reopening Code retained the source and running server. Terminal
  Ctrl+C stopped Bun; restarting the command served the updated source.
  The terminal resolved the user's Bun **1.3.13**, as designed by the
  host-first tool resolver. The bundle independently pins Bun 1.3.14.
- Screenshots in `bun-interactive-pHu4iW/` were inspected, including
  `code-bun-server-running.png`, `bun-browser-content.png`, and
  `bun-preview.png`. Browser shell/content captures are separate, not a
  composed native-window proof.

The first development quit was blocked by unavailable Accessibility access.
Only the launched disposable test PID and its observed descendants were
terminated for failed-run cleanup; this is not a normal-quit pass. After the
user changed permission, `System Events` reported Accessibility enabled and
successfully read System Settings' native AXWindow. Native acceptance is now
being resumed. No firewall was disabled and no authentication challenge was
bypassed.

Logs: `evidence/final-host-tests.log`, `final-native-connector-tests.log`,
`final-shell-load.log`, `final-shell-regressions.log`, `final-shell-drift.log`.

The first package was superseded before installation after real-machine
discovery exposed an external Microsoft VS Code detection failure. Fixed the
inline codesign requirement syntax and resolved the verified executable name
(`Code` on VS Code 1.137.0; `Electron` on older versions). Unit regressions and
actual signature-verified discovery now pass. No signature protection was
removed or relaxed.

The next isolated packaged launch correctly failed acceptance before
installation: Electron reported `app.isPackaged === false` because the
application executable retained the default `Electron` name. The packager now
renames both the executable and `CFBundleExecutable` to `EZiL OS`, and the
Browser/development harnesses assert the expected runtime mode. This is a
packaging fix, not a production-path exception. Superseded DMGs remain on the
SSD for diagnosis and must not be installed.

Packaged Browser checks passed after the executable fix, including actual
native-window capture. The attached-project flow subsequently passed Code
save/build/server, native address focus, upload/download, source-edit HMR
without a reload, ten Code detach/reopen cycles, and native Ctrl+C. Test
corrections distinguish OS keystrokes from CDP input, compile the native dialog
AppleScript (a reserved variable caused a syntax error), explicitly place the
text cursor, and select the visible Preview retry button by accessible name.

Process-identity auditing found a genuine helper orphan when editor shutdown
reported failure: sequential cleanup stopped at that error. Cleanup now
attempts every component, records a fixed diagnostic, and still rejects unsafe
workspace removal. The exact orphan from the failed test was identity-checked
and terminated. These fixes require fresh packaging and full acceptance;
previous passing stages are not a complete release sign-off.

## Historical checks before the SSD was reconnected

Branch: `codex/macos-native-completion`, based on `e30539e`.
Earlier Code/terminal/HMR/XCTest results remain in
[the September 18 report](NATIVE-ACCEPTANCE-2026-09-18.md); they are not fresh
September 19 passes.

## Latest continuation: tabbed Browser

The user explicitly moved real Browser tabs into this release. This section
supersedes the earlier single-page Browser test counts below; it does **not**
change the unfinished installed-app status.

Implemented up to 20 independent Chromium tabs, new/close/select controls,
keyboard tab actions, separate addresses/drafts/history/loading/error state,
and lazy background-tab restoration. The omnibox accepts safe web addresses,
loopback development URLs and Google text searches. Unsafe schemes,
credentials and path-like input are rejected instead of sent to search; the
encoded result must fit the 4096-character bridge/persistence limit.

Host/preload notifications retain workspace, surface and generation checks.
User-popup requests cannot create privileged native windows or navigate the
original tab. A recent visible-source input can request a sandboxed shell tab;
actual OS-input popup acceptance remains outstanding. Cmd/Ctrl+T/W and
Ctrl+Tab/Shift+Tab from the **shell address field** passed real UI interaction;
this does not sign off keyboard events originating inside native web content.

The existing Azure Browser session produced the implementation and focused
tests. Its connection repeatedly interrupted; after preserving its files and
running its tests locally, the coordinator stopped that worker. The existing
portability worker completed the standalone verifier and was resumed for a
read-only Browser review. That review identified two issues, both corrected:

- A validated submitted address now survives Browser close/reopen while its
  load is still pending. Unsubmitted drafts are not persisted.
- Closed surface identities are reused only after detach settles, with
  monotonically increasing generations. Exact host tombstones remain for
  stale-message rejection; unexpected identity growth is bounded. Both shell
  and host tests exercised 300 generations, and old-generation notifications
  cannot act on the new identity lease.

Packaging now runs a read-only portable-bundle verifier before signing. Its
eight focused tests cover editor/runtime presence, executable bits, helper
dependency-closure evidence/hashes, connector/shell assets and nonportable
symlinks. This is a static build guard, **not a packaged execution, signature,
DMG or installed application pass**.

### Final local automated checks

Node remains **24.8.0**, not the pinned 24.15.0, because pinned tools are on
the disconnected SSD. These are diagnostic, not pinned-tool release results.

- Host: **108 passed, zero failed/skipped**, real sockets enabled.
- Native/connector: **32 passed**, real sockets enabled.
- Native/connector typechecks and host JavaScript syntax passed.
- Shell load **49/49**, Code regression **42/42**, spinner **21/21**.
- Tab/omnibox, surface-slot, Browser state/composition, native runtime,
  persistence, health, generated-window parity and style checks passed.
- Generated-shell drift and non-generated whitespace checks passed.

Latest logs: `host-tabs-tests.log`, `native-connector-tabs-tests.log`,
`tabs-shell-load.log`, `tabs-code-tests.log`, `tabs-spinner-tests.log`,
`tabs-native-parity.log`, `tabs-shell-drift.log` in the evidence directory.
The entire generic hosted/mobile shell runner was not rerun; the native and
affected shell suites above were executed explicitly.

### Actual Electron product-flow acceptance

Reproducible harness: `macos-electron/test/browser-tabs-flow.cjs`
(`npm run test:browser-tabs` in `macos-electron`, with the absolute
`EZIL_TABS_EVIDENCE` environment variable set). It creates disposable data;
setup is separate from real dock, address, tab, mouse and keyboard actions.
No injected iframe or direct host operation substitutes for those actions.

Final evidence:
`.native-evidence/2026-09-19/tabs-flow-TNNlbH/result.json`

**12 product-flow checks passed**, including:

- Actual dock opening, bare loopback address, Chromium page typing, and no
  Node/EZiL bridge in web content.
- Independent tab content, address drafts and history; background/active/last
  tab closing; shell keyboard controls.
- During a 12-second response stall, tab switching, dragging, minimizing and
  Settings opening/restoration completed in **363 ms**. Only the selected
  native surface was attached; Settings hid all native Browser content.
- Actual quit/relaunch restored three tabs and the selected index. Background
  destinations received no request until selected.
- Browser close/reopen retained tabs. Closing before a submitted slow URL
  committed retained that destination and reopened it successfully.
- Real resize to **530 px**: toolbar and tab-row client/scroll widths matched
  **530/530**, inside a **1280×800** outer Mac window.
- Ten Browser-window close/reopen cycles left zero native page targets after
  each close. This is not a substitute for Code/server process-cleanup tests.
- Normal isolated-app quit completed with exit code 0.

The fixture server was coordinator-started; these are **not Code-terminal or
source-edit HMR passes**. Screenshots are separate shell/native-page captures,
not composed native-window proof. Inspected evidence includes
`tabs-shell-1280.png`, `tabs-restored-shell.png`, `tabs-narrow-shell.png` and
`tab-one-native.png` from the successful runs.

### Public websites and explicit non-passes

Google's homepage rendered in the integrated tabbed Chromium Browser, and
switching back from a second public-site tab restored its address/content.
`google-tab-integrated.png` was captured and inspected.

Before tab integration, OpenAI's homepage rendered successfully
(`openai-public-site.png`). The later integrated-tab visit instead reached a
Cloudflare **Verify you are human** screen (`openai-tab-integrated.png`). This
latest visit is **not a homepage pass**. Google search earlier reached an
unusual-traffic challenge (`google-search-results.png`), so search-result
acceptance also remains open. Neither challenge was bypassed or repeatedly
retried. Both public tabs remained sandboxed, with no Node/EZiL bridge.

No extension store, Google account sync, enterprise monitoring, remote access
or new CUDA/SDK support was added. Those require separate scope and policy
decisions; Chromium embedding alone does not imply full Chrome compatibility.

### Unchanged release blockers

The final device recheck still found **no external physical disk**;
`.native-tools` is a dangling SSD link. Internal free space was **6.6 GiB**.
Accessibility still reported **false**. Xcode is **27.0 (27A266a), SDK 27.0**.
The installed app remains **0.0.14**, without the embedded editor, and was not
replaced. No user files were deleted or moved, and LuLu was not disabled.

Reconnect the SSD and restore usable native Accessibility/capture access to
resume the pinned Code/terminal/HMR/Xcode flow, native popup/shortcut/dialog
checks, physical composition, five-launch/30-minute lifecycle gates, upgrade
checks and the self-contained packaged installation. No release commit,
replacement application, DMG, release checksum or release SBOM is claimed.

## Installed application: reproduced failure

The installed app opens an old workspace-manager page, not the current shared
desktop, and does not contain embedded code-server. Clicking Create workspace
in an isolated instance failed with the native-helper readiness error.

The existing Azure development worker reproduced the underlying failure using
the installed Bun, sanitized environment and disposable directories: the helper
exited code 1 in 135 ms, unable to resolve
`../../local/src/boot/os-document.ts`. The installed Resources omit both that
file and `local/src/boot/assets.ts`, imported by the shipped native server.
The old host calls early process exit a “20 second timeout,” concealing the
packaging defect. This failure does not depend on network access or the SSD.

Current packaging bundles the helper dependency closure into `helper.js`.
The regression now also starts that real bundle from isolated Resources,
requests its authenticated desktop and public shell asset through a real
socket, and verifies clean termination. This passed; it is **not** a full
packaged-application or DMG pass.

## Fixes made after looking at the app

- Native shell typography was falling back to Times. The shell now owns its
  system-font fallback independently of the hosted Next app.
- Browser controls inherited black text against dark backgrounds. They now
  have explicit readable foreground, placeholder and focus colours, and
  accessible navigation-button names.
- Settings project actions squeezed the project name into roughly 30 pixels.
  Names and actions wrap with the actual pane width instead of competing for
  a single line. Stored wallpaper/accent settings were not redesigned.
- Failed first Browser navigation left an empty address field. The failed,
  validated destination now remains visible for retry, without exposing
  internal URLs or replacing newer navigation state with old failures.
- Native Code/Preview/Browser failures now describe the affected local app
  and next action instead of saying the entire computer failed to start.
  This changes copy only; it does not change readiness or automatic retries.
- Helper launch failure, early exit, incompatible protocol, excessive output
  and readiness timeout now have distinct fixed messages. Raw process output
  is neither shown nor logged.

The existing Browser Azure session supplied the focused styling corrections;
the coordinator integrated them, rebuilt generated assets, and reran the UI.
Both reused Azure sessions completed. No new worker session or cloud execution
environment was created.

## Fresh automated validation

The disconnected SSD contains pinned Node 24.15.0/npm 11.12.1 and staged
code-server. Therefore Node-based checks here used available **Node 24.8.0**
and are diagnostic validation, not pinned-tool release validation. Bun was the
installed **1.3.14**; Electron was **44.4.1**, Playwright Core **1.62.1**.

- 96 host tests pass, zero skipped, with `EZIL_NATIVE_SOCKET_TESTS=1`.
  This includes startup-message regressions and isolated bundled-helper
  real-socket startup/serving/termination.
- 32 native and connector tests pass, zero failures, with real sockets enabled.
- Native/connector TypeScript checks and host JavaScript syntax pass.
- Shell load: 49/49; Code regression: 42/42; app spinner: 21/21.
- Native generated-window parity, Browser composition, native health,
  persistence and shell-style checks pass. The style test uses JSDOM and does
  not claim pixel geometry; actual resized-window evidence is below.
- Generated-shell drift and non-generated whitespace checks pass.

Local logs: `host-tests.log`, `native-connector-tests.log`, `native-parity.log`,
`shell-load.log`, `shell-drift.log` in the evidence directory.

## Fresh real Electron interactions

All app openings used actual dock controls. Browser documents were real
Chromium WebContentsView targets, not replacement iframes. The tiny local
Browser fixture server was coordinator-started; it is **not** Code-terminal
or HMR evidence.

- Bare `localhost:port` normalized to loopback HTTP; Browser text entry,
  links, back/forward history and authoritative committed addresses passed.
- Address clicking retained focus and typed drafts. Native Browser Cmd+L is
  **not signed off**: this CDP keyboard test did not emit Electron's native
  before-input event. A filled input alone was not counted as shortcut proof.
- After observing a real delayed request, dragging Browser, minimizing it and
  opening Settings completed in **488 ms** while the 12-second response was
  still pending. Native content was detached while hidden; restore reattached
  it. Foreground Settings detached Browser content; foreground Browser
  reattached it. Pixel-level native layering remains unverified below.
- A stopped local destination showed navigation failure. Restarting that
  server and clicking Reload displayed its real Recovered page. After the
  address fix, the failed URL remained visible throughout the failure.
- Settings was resized with its real mouse handle to **586 pixels** wide.
  Its row had client/scroll widths **343/343**; the project name had 275 pixels
  and remained readable. Action buttons wrapped without horizontal overflow.
  This ran inside a **1280×800 outer Mac window** (1280×768 content area).
- Browser address foreground was `rgb(245,245,244)` with a visible 2-pixel
  focus outline and system font. Fresh screenshots were inspected.
- Aurora was selected through Settings and survived actual quit/relaunch.
  Two later warm desktop launches were **1.641 s** and **1.658 s**. These are
  not the five cold/warm measurements or 30-minute development-session gate.
- Code was opened through the dock. The editor is unavailable without the SSD
  resources; the explicit Code-is-unavailable panel and retry were verified.
  **No fresh working Code, terminal, Preview/HMR or Xcode workflow is claimed.**
- Browser-only/failed-editor app quit exited code 0; the final quit and local
  server closure took **156 ms**. This does not cover active-editor unsaved
  work or its native confirmation dialog. Disposable hosts and fixture servers
  were closed; the normally launched installed app was left alone.

## Screenshots and limits

Evidence directory:

`/Users/midhun/Projects/EZiL/ezil-os/.native-evidence/2026-09-19/`

Useful inspected screenshots:

- `installed-onboarding.png`: old installed workspace manager.
- `settings-shell.png`: before typography and layout corrections.
- `settings-fixed.png`: corrected shell, readable project name/actions.
- `settings-narrow-fixed.png`: real resized Settings, wrapped actions.
- `browser-toolbar-fixed.png`: corrected Browser chrome and focus.
- `browser-content.png`: separate real Chromium content capture.
- `browser-failure-fixed.png`: failed destination retained in the address bar.
- `code-unavailable-fixed.png`: honest missing-editor failure panel.

Renderer screenshots capture shell chrome but **omit the native Chromium
child surface**. Its black area must not be presented as a composed Browser
screenshot. Native screen capture returned black; exact-window capture failed;
desktopCapturer enumerated the windows but returned empty thumbnails. Screen
recording status said granted, while System Events Accessibility said false.
The physical desktop, native menus/pickers, and Xcode UI still need a usable
unlocked capture/Accessibility session. No security permission was bypassed,
and LuLu was not disabled or broadly reconfigured.

## Blockers and next gate

`/Volumes/9502040569` is absent and no external physical disk was listed.
`.native-tools` points to the disconnected volume. Internal free space was
**7.4 GiB**. No user files were deleted or moved in this continuation: the
authorized SSD destination must be connected before verified relocation or
resource-heavy packaging can proceed.

Xcode is present: **27.0 (27A266a), macOS SDK 27.0**. Its native UI acceptance
is still outstanding, not its installation.

Reconnect the SSD and enable Accessibility for the invoking Codex/ChatGPT
runner; leave the Mac unlocked with the app visible and resolve native capture
availability. Then resume the pinned-tool Code → terminal → Preview/HMR →
Xcode product flow, native dialogs/shortcuts, unsaved work/workspace transitions,
sizes/zoom/fullscreen, lifecycle duration and upgrade checks. Preserve the
existing app/data before any installation.

No integrated release commit, DMG, installed replacement, release artifact
checksum, release SBOM or complete native workflow is claimed. Remote access
remains a later phase of the agreed plan.
