# Native Mac completion contract

Implementation base: `e30539e`, branch `codex/macos-native-completion`.
Execution is local; Azure inference uses `codex-azure` with no model override.
Coordinator reasoning is medium; at most two workers run at low reasoning.

## Product decisions

The shared desktop embeds Chromium, Code and Preview. Existing folders are
attached in place. Finder, optional Microsoft VS Code and Xcode open the same
project in normal Mac windows. Native macOS app build/test/run is required;
remote access, iOS Simulator and an extension store are deferred. The September
19 follow-up explicitly brings Browser tabs into this release.
One workspace runs at a time, without the hosted two-workspace limit.
Code window close keeps its editor/server session; workspace exit stops only
EZiL-supervised processes after a user-facing unsaved/running-work check.

## Frozen integration interfaces

### Browser (worker A)

Keep existing `Browser` constructor and operation API. Add options
`onState(viewId, state)` and `onShortcut(viewId, action)` alongside `offline`.
`state(viewId)` returns `{revision,url,title,loading,error,canGoBack,canGoForward}`.
Revision is a positive monotonic integer; error is null or an allowlisted code;
URL is empty or valid HTTPS/loopback HTTP (no userinfo); title is bounded text.
Navigation acknowledges promptly; asynchronous completion emits state and
cannot block layout/hide/destroy. Never resurrect destroyed views.

Coordinator wraps state as `{workspaceId,surfaceId,generation,...state}` and
sends `ezil:browser-state:v2` only to the active registered shell. Preload exposes
`subscribeBrowserState(listener)` returning an unsubscribe function. It validates
and strips payloads. `browser.status` returns a normal surface result plus
`browserState`. A `browser.attach` response also includes its current state.
Shortcuts emit `ezil:browser-shortcut:v2` with workspace/surface/generation and
`action` (`address`, `reload`, `back`, `forward`); preload exposes a matching
`subscribeBrowserShortcut(listener)`.

Worker A owns Browser, shell native runtime/Browser code, explicit native
composition notifications in window/overlay code, and focused tests. It does
not own main/preload/policy, boot, Settings, storage, editor, or packaging.

### Projects and tools (worker B)

Keep existing store methods, adding `attach(label, source)`, `relink(id, source)`
and `get(id, {allowMissing:true})` for attached metadata recovery/removal.
`list()` returns safe `{id,name,createdAt,kind,available}` records; `get()` is
host-only and supplies `files`, `dir`, `editorData`, `extensions`, `browser`.
Kinds are `managed` and `attached`. Existing v1 records migrate to managed;
metadata becomes v2. Attached files are canonical original folders and are
never removed. Preserve ordinary project symlinks without following them when
removing app-owned entries. Do not relax packaging's restrictive input checks.

Add `developmentEnvironment(resources)` for the embedded editor and optional
VS Code: host home/tool paths, bundled Bun/Node fallback, separate profile flags,
and no inherited provider/bootstrap secrets. Keep `cleanEnvironment()` minimal
for helpers/brokers. No shell startup-file modifications.

Add `xcode.cjs` exports `discoverXcode()` and
`openInXcode(projectRoot, {dialog, shell})`. Discovery returns host-private
`{available,version,developerDir,swift,metal}`. Opening resolves workspace/project
or Swift package within the root; multiple candidates use the native picker.
Return `{opened:true}` or `{opened:false,reason:'unavailable'|'no_project'|'canceled'}`.
Do not install Xcode or change global developer selection in the worker.

Worker B owns workspace/files/editor/vscode/development-environment/Xcode
modules and focused tests. It does not own main/preload/policy, helper, shell,
shared TypeScript contracts, generated assets, or packaging.

### Coordinator

Own shared schemas/main/preload/helper integration, boot/Settings, generated
assets, packaging and physical acceptance. Runtime v2 additions:
`workspace.attach` (native picker), `workspace.relink`, `workspace.reveal`,
`workspace.openVSCode`, `workspace.openXcode`, `toolchain.status`,
`preview.register`, `preview.unregister`, `browser.status`.
Project actions take workspaceId, never renderer-supplied paths/executables.
Preview registration takes a validated loopback port; workspace heartbeat and
connection failures remain authoritative. Existing `workspace.import` aliases
attachment for compatibility. Errors exposed to renderers are fixed codes.

## Acceptance

Run tests with pinned tools, including `EZIL_NATIVE_SOCKET_TESTS=1`; canonicalize
the macOS temporary fixture. Verify actual dock/keyboard/Code terminal flows,
real source-edit HMR, Browser focus/occlusion, original-folder edits, app restart,
upgrade preservation, and Xcode macOS build/test/run. Record exact artifact hash.
Smoke shortcuts and injected frames are not product-flow acceptance.

The initial machine had only 7.1 GiB free. Full Xcode 27.0 is now installed;
the fixture passes XCTest from host and embedded terminals with DerivedData
on the SSD. Native Xcode UI acceptance remains outstanding. Continue using
verified SSD relocations, not deletion of unrelated user data, for storage.

## September 19 tabbed Browser interface addendum

The user now requires multiple real Chromium tabs for public websites and
local previews. Extensions, browser-account sync and enterprise activity
collection remain separate future policy decisions, not implicit permissions.
The installed application must contain its editor and runtime and work without
the build SSD. User-selected attached projects can still live on any chosen
volume, with the existing missing-folder behavior.

Worker A owns the tabbed shell Browser (`apps/native.js`, `native-runtime.js`,
`native-persistence.js`, scoped CSS and focused shell tests). Each tab uses an
independent existing browser surface; one active tab is visible. Keep a maximum
of 20 tabs, make restored background tabs lazy, preserve independent navigation,
draft, loading/error and retry state, and dispose every surface on window close.
Support new/close/select tabs and new/close/next/previous tab shortcuts.

Coordinator-owned bridge additions:

- Shortcut actions add `new-tab`, `close-tab`, `next-tab`, `previous-tab`.
- `Browser` option `onNewTab(viewId, {url, background})` sends
  `ezil:browser-new-tab:v2` with the existing workspace/surface/generation
  identity. Preload exposes `subscribeBrowserNewTab(listener)`, returning an
  unsubscribe function. The runtime surface exposes the same subscription,
  rejecting stale identities and invalid URLs. No bridge is exposed in pages.
- Desktop preferences gain `browser: {tabs: string[], activeIndex: number}`.
  At most 20 entries; each is empty (new tab) or an exact canonical HTTPS or
  loopback HTTP URL with no credentials, at most 4096 characters. At least one
  entry is required; activeIndex must identify an entry. The host stays strict.
  Shell safe-preference filtering and persistence restore this field through
  `ctx.browserTabs`; capture uses `el.ezilBrowserTabs()` and changes dispatch
  `ezil:preferences-changed`. No visited title or page content is persisted.

Worker A does not edit host/main/preload/contracts/packaging/generated bundles.
Coordinator handles main/preload, host Browser popup/shortcut routing, desktop
schema, packaging integration, public website tests and generated assets.
Worker B may independently add a portable runtime-bundle verifier and tests;
coordinator wires it into packaging after review.

### Review corrections and reproducible Browser acceptance

Saved URLs include a validated, submitted destination while navigation is
pending, but never an unsubmitted address draft. The committed native URL
replaces that destination when navigation resolves, including redirects.

The shell leases surface identity slots per workspace/kind and only releases
them after the close operation settles. Reuse increments the generation instead
of creating a new UUID for each tab. The host retains exact generation records
for stale-message rejection and bounds unexpected identity floods at 4096
records per workspace host. It never evicts tombstones to accept old messages.

Run `macos-electron/test/browser-tabs-flow.cjs` with `EZIL_TABS_EVIDENCE` set to
an absolute evidence directory. The harness creates disposable workspace data,
opens the real dock, and drives real Chromium targets, tab controls, address
input, resize handles, Settings and quit/relaunch. It does not inject frames or
call product operations directly. Native page and shell screenshots are
separate captures; the fixture server is not a Code/HMR acceptance substitute.

## September 19 installation continuation: Browser content zoom

The user reconnected the SSD and removed installed 0.0.14. Keep existing
workspace data and back it up before migration; package on the SSD. One
explicitly requested GPT-5.6 Sol worker owns Browser/shell zoom. Coordinator
owns main/preload/policy, generated assets, packaging and real UI acceptance.

Frozen additions: `browser.zoom-in`, `browser.zoom-out`, `browser.zoom-reset`
carry only the existing surface identity. Matching Browser shortcut actions
are allowlisted. Browser state adds `zoomFactor` in [0.25, 5], defaulting to 1
for old state fixtures. Chromium page zoom must not resize desktop controls.
Provide accessible minus/percentage-reset/plus controls and Cmd/Ctrl +/-/0.
Keep desktop zoom separate in the native View menu. Validate toolbar geometry
at narrow sizes and page zoom using real Chromium, not just a mocked factor.
