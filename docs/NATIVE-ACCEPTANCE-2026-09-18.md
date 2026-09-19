# Native macOS implementation — acceptance in progress

For the later installed-app failure, screenshot-driven fixes and current
SSD/Accessibility blockers, see [September 19 testing](NATIVE-ACCEPTANCE-2026-09-19.md).

This is an unfinished implementation, not a release or installation sign-off.
The existing `/Applications/EZiL OS.app` and its user data remain unchanged.
Source is on `codex/macos-native-completion`, based on `e30539e`.

The two original durable Azure sessions were resumed for bounded fixes and
review; no competing implementation sessions were created:

- Browser/integration: `01a0b3f8-29e0-7840-9075-b9ef5bc7d756`.
- Development/runtime: `01a0b3f8-2adc-7032-87e0-f701b4601f2a`.

Both sessions finished; no worker or disposable test Electron/editor process
was left running at the final check.

## Verified in this continuation

- 91 Electron host tests passed with Node 24.15.0, including real socket tests,
  Browser generation/transition races, attached-folder identity checks, process
  cleanup ownership, short code-server sockets and runtime binary checks.
  The expanded suite also loads the installed 0.0.14 workspace-store source
  against synthetic data and verifies v1 migration, original file/profile
  identities, active workspace, guest and migration markers. It does not mutate
  or claim to have upgraded the installed user's metadata.
- 24 native tests and 8 connector tests passed together, including real sockets.
  Connector tests additionally cover delayed activation after explicit trust.
- Native and connector TypeScript checks, host syntax checks, shell loading
  (49/49), native adapter checks, and generated-shell drift checks passed.
- Code regression checks passed (42/42). Native health-monitor checks cover
  success/failure, exceptions, cancellation of late replies, non-overlapping
  probes and hosted isolation. The generated-shell parity test additionally
  covers post-ready Code/Preview failure, explicit Retry and disposal.
- Real Electron dock flows repeatedly opened Browser and Code. The harness
  edited and saved the original attached file, used the integrated terminal to
  build a Vite/TypeScript project, and navigated Browser links and history.
- Interactive diagnostic session 17 registered a running terminal server from
  Settings, opened Preview through the dock, edited and saved
  `src/message.ts` through Code's file tree, and observed real HMR. The Preview
  document ID stayed `dd5f63fc-9ccb-4d7d-82e8-617afbb91a68`; the saved file and
  rendered text both changed to `EZIL_HMR_INTERACTIVE`.

Interactive evidence:

`/Volumes/9502040569/EZiL-Local-Build/2026-09-18/interactive-17/evidence/`

Latest standard product-flow evidence (no TypeScript override or forced reload):

`/Volumes/9502040569/EZiL-Local-Build/2026-09-18/flow-22/evidence/result.json`

All nine product-flow steps passed: launch, Browser/Code dock, terminal build,
development server start, Browser links/history, Settings Preview registration,
real source-save HMR, ten pointer-driven Code close/reopen cycles with the server
remaining alive, and server stop. Desktop readiness was 3.468 seconds; Code
opening, workspace trust and the first saved edit took another 5.169 seconds.
The ten close/reopen cycles took 22.088 seconds. The overall run is still marked
failed because native quit confirmation timed out. These are development bytes,
not an installed-package acceptance result.

Earlier complete harness reports and screenshots are under `flow-9` through
`flow-22` in that SSD build root. Some diagnostic runs failed in their harness
selectors; do not count them as passing end-to-end acceptance.

## Xcode and live failure testing after installation

- Selected developer directory: `/Applications/Xcode.app/Contents/Developer`.
- Xcode 27.0, build 27A266a; macOS SDK 27.0; `checkFirstLaunchStatus` exited 0.
  `xcrun -f metal` resolves inside the selected Xcode toolchain.
- A disposable copy of the checked-in SwiftUI macOS fixture built and passed
  both XCTest cases using host `xcodebuild`. All DerivedData and result bundles
  were written to the SSD, without a developer account or signing identity.
- The same attached project built and passed the same two XCTest cases from
  EZiL's actual Code integrated terminal. Its command exited 0. Both `.xcresult`
  summaries report Passed, arm64, two tests, zero failures or skips.
- The integrated terminal invoked `open` on the built fixture; its exact app
  executable was observed running. The Settings Xcode action was clicked, but
  native Xcode project/window visibility and menu-driven build/test/run were
  not verified. Native screenshots at that point show the screen saver, not a
  passing Xcode UI workflow.
- Controlled exits targeted only the disposable editor/helper. After editor
  failure, all nine observed editor-process identities disappeared and Code
  reopened from the dock. After helper failure, all seven observed supervised
  identities disappeared, the recovery screen appeared, and its Retry button
  restored the workspace. The subsequently idle app closed normally. This is
  not acceptance of native quit confirmation with an active editor.
- A later real run verified the new post-ready Code failure panel appeared in
  1.934 seconds and its Try again button recovered the editor without closing
  the Code window. Native Preview's no-port guidance and retry were visible.
- A real HTTP server was started from Code, registered through Settings, and
  opened in Preview. Stopping it using Code's Kill Terminal control displayed
  the failure panel in the existing Preview window. Ctrl+C did not stop it in
  this diagnostic run, and later command-palette keyboard input timed out;
  live Preview restart/retry remains unpassed. The desktop was showing the
  screen saver and native assistive access was denied; the keyboard behavior
  must be rechecked on the unlocked desktop, not attributed conclusively.
- The later diagnostic runner timed out and reset its connection. Test-owned
  helper/editor processes were cleaned up and their identities verified gone;
  the remaining disposable Electron host required forced termination after
  SIGTERM did not exit. The explicitly launched fixture app was also stopped.
  This cleanup is not passing evidence for normal quit/relaunch.

Evidence root:

`/Volumes/9502040569/EZiL-Local-Build/2026-09-18/xcode-acceptance/`

Key artifacts: `terminal.xcresult`, `embedded-terminal.xcresult`,
`build-test.log`, `embedded-build-test.log`, `embedded-terminal-xcode.png`,
`helper-recovery.png`, `helper-recovered.png`, `editor-live-failure-panel.png`,
`editor-live-retry.png`, `preview-empty-guidance.png`, `preview-live.png`, and
`preview-live-failure.png`. These are development-byte tests, not packaged-byte
acceptance. The new Browser upload/download, slow-navigation and quit harness
extensions have unit checks but have not completed a new full GUI run.

## Defects addressed during real testing

- Code-server's CLI/session socket exceeded Darwin's 104-byte Unix socket path
  limit when editor profiles lived on the SSD. Both sockets now use an owned,
  short temporary runtime directory.
- The connector originally accepted only managed project paths. Host-private
  descriptors now bind attached originals by ownership kind and directory
  identity, with negative tests for replacement and symlinks.
- The connector must run in the workspace extension host. It now waits for
  explicit workspace trust before reading descriptors or enabling operations.
- Pinned code-server logged a duplicate TypeScript-extension registration
  during trust changes. Source review established this is a logged warning,
  not a thrown exception; it did not establish the warning as the cause of
  missing readiness. The connector's limited, inactive-until-trusted lifecycle
  now completes the fresh workflow without reload or a TypeScript override.
  Experimental reload code and the profile override were not retained.
- The northwest resize handle covered the close button's center. Its corner
  hitbox was reduced to stay outside the visible traffic light. Ten actual
  pointer-driven close/reopen cycles subsequently passed.
- Settings retains the Preview port draft across status updates and submission.
- Code and Preview now continue checking native readiness after first paint.
  Failure exposes an explicit retry without automatically reloading editor
  content. Window disposal and new attempts cancel stale status replies.
- Native Preview without a registered port explains the Code → Settings
  workflow and offers Try again instead of hosted-deployment-only text.

## Remaining release gates

No integrated release commit, DMG, installation, signature report or release
SBOM has been produced. Packaging must wait for acceptance of the integrated
source and must preserve the existing application and metadata before install.

Outstanding checks include:

- First-launch native folder picker and packaged-byte repetition of the passing
  trust → Code → terminal → Settings → Preview → HMR flow.
- Preview stop/restart, connection loss and capability renewal.
- Native quit/relaunch, workspace switching, and unsaved work. Helper/editor
  failure/recovery has separate development evidence above. Native quit-dialog
  automation timed out; failed diagnostic processes
  were cleaned up by their verified ancestry, not counted as graceful quits.
- Verified supervised cleanup during normal native application quit. The ten
  Code-window cycles passed, but they are not proof of application-quit cleanup.
- File upload/download, Finder and external VS Code shared-folder acceptance.
- Retina, 1280×800, fullscreen, zoom and slow-navigation composition checks.
- Five cold/warm measurements and a continuous 30-minute development session.
- Disposable-copy upgrade acceptance from the installed 0.0.14 metadata.
- Xcode native-UI build/test/run and visually verified app launch. Installation
  and command-line/embedded-terminal build/XCTest are now verified above.

System Events currently reports `UI elements enabled: false` and attempting
to inspect Xcode returns `osascript is not allowed assistive access (-25211)`.
Screen capture worked initially, then captured the screen saver. Unlock the Mac
and enable the invoking ChatGPT/Codex runner under Privacy & Security →
Accessibility; handle any normal Automation consent prompt as well. LuLu was
not disabled or broadly reconfigured. Missing permissions are not waived gates.

## Storage

See `NATIVE-STORAGE-RECOVERY.md` for verified SSD recovery copies and cleanup.
Internal free space reached 7.4 GiB immediately after the verified Downloads
relocations and was 6.1 GiB at the final check; the 40–50 GiB target is not met. Build outputs
remain on the SSD, which has approximately 173 GiB free.
System-managed MobileAsset images and the local Time Machine restore point
have deliberately not been manually deleted.
