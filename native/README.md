# Native runtime contract v2

The shared `/os` shell retains its app registry, UIWindow chrome and Settings
tabs. Code embeds code-server; Preview embeds a registered local port; Browser
places a host Chromium view inside the existing Browser window. Programs run
with the Mac account's permissions. This runtime is not a containment boundary.

`src/contract.ts` advertises these capabilities:

```json
{
  "contractVersion": 2,
  "executionTarget": "macos-host",
  "isolation": "trusted-native",
  "editor": "embedded-code-server",
  "externalEditor": "optional-microsoft-vscode",
  "browser": "native-chromium",
  "cloudSync": "disabled"
}
```

The storage schema and connector descriptor remain v1. The runtime protocol
version changes independently; old native shell capabilities fail locally and
never fall through to hosted APIs.

## Electron host integration

Expose `window.ezilNative.operation(op)` through a context-isolated preload.
Validate the calling top-level shell frame, workspace and exact operation schema
in main. Never expose the bridge or authenticated headers to Code, Preview or
arbitrary browser content. Authentication and secrets stay in main/preload.

`src/surfaces.ts` defines `SurfaceOperation`, `SurfaceResult`,
`NativeHostAdapter`, validators and `SurfaceLifecycle`. The helper accepts an
in-process `NativeOptions.hostAdapter`. A separately spawned helper cannot
receive JavaScript callbacks: Electron may implement these typed operations
directly in its validated main-process bridge, reusing the validators and
lifecycle rules. The CLI currently has no v2 surface broker. Without an adapter,
the helper returns `unavailable`; the shell shows a retryable failure.

Every surface operation carries `workspaceId` and `surfaceId` (v4 UUIDs),
`generation` (positive integer, incremented on retry), and `sequence` (positive,
strictly increasing within a generation). Results echo all four fields and
`ok:true`, plus a `state` of `starting`, `ready`, `failed`, `unavailable`, or
`closed`. Reject stale messages, including completions from an older generation,
and retain close tombstones until the shell session ends. Serialize process and
view creation/destruction so a late open cannot resurrect a closed surface.

| Operation | Additional input | Result/use |
| --- | --- | --- |
| `code.open`, `code.status` | None | Ready includes `url`; starting is polled for up to 30 seconds |
| `code.close` | None | Dispose the embedded editor surface; report process state separately |
| `preview.list` | Workspace only, no surface identity | `{ok:true,ports:number[]}` from the workspace's registered ports |
| `preview.open` | Registered `port` | Ready includes `url` using that exact port |
| `preview.status`, `preview.close` | None | Recheck readiness/grant, or dispose |
| `browser.attach` | None | Attach a Chromium view, initially hidden; return ready only when usable |
| `browser.layout` | `bounds:{x,y,width,height}`, `visible`, `occluded` | Position/clip the view in shell viewport CSS pixels; convert for zoom/DPI |
| `browser.focus` | None | Focus only when the current layout permits visibility |
| `browser.navigate` | Valid HTTPS or loopback HTTP `url` | Navigate the existing native view |
| `browser.back`, `browser.forward`, `browser.reload` | None | Use Chromium navigation history or reload |
| `browser.detach` | None | Destroy/detach and ignore subsequent stale messages |
| `browser.snapshot` | None | Ready includes `snapshot`, a PNG data URL, at most 2 MB |
| `diagnostics.read` | Workspace only | `{ok:true,events:[...]}` from the allowlisted native event ring |

Code/Preview URLs must use `http://127.0.0.1:<port>/...`, port 1024–65535,
without credentials, query strings or fragments. Derive them from trusted
workspace/process records. Supply any frame authentication privately in main;
never put it in a renderer URL. The helper's document CSP allows loopback frames.
Do not implement an arbitrary URL or path proxy. Preserve the code-server
WebSocket path in the host integration. Optional Microsoft VS Code is a separate
host action; the legacy `surface.open/focus` handoff remains for compatibility
and is no longer used by the shell's app launches.

Browser layout is deduplicated and sampled during moves, resizes, maximize,
minimize, restore and overlay changes. When hidden/occluded, hide the entire
native view so DOM windows and menus remain interactive. The shell can request a
raster snapshot for a DOM cover; no HTML from native content is inserted.
Additional shell overlays can mark themselves `data-native-occluder`, or dispatch
`ezil:native-cover` with `{covered:true|false}` on the Browser UIWindow. A hidden
view must support snapshot capture or return unavailable. Detach on close,
shell teardown, renderer loss and workspace switch.

Settings maps only `computer.list/create/rename/delete/select` onto
`workspace.list/create/rename/remove/select`. For Electron-owned workspaces,
the main process services these through its verified workspace manager. For standalone
helper-owned workspaces, use authenticated admin operations from main; the
renderer must never receive that capability. Shell capabilities intentionally
cannot enumerate, create or remove other workspaces. Renew the scoped capability
and reload `/os` on workspace switch. Do not forward attached-workspace mutations
to the helper: its ownership guard rejects them. The shell's existing delete
confirmation and window-disposal ordering remain in use.

Native diagnostics accept only `event` (one of `NATIVE_EVENTS`), finite `t`, and
optional bounded `durationMs`, capped at 100 events. No free-form messages,
paths, URLs, tokens or identifiers cross this diagnostic interface. The Settings
copy action merges these with the existing redacted shell log. Hosted telemetry
and report behavior remain unchanged.

## Startup, authentication and storage

- Inherit `EZIL_NATIVE_ADMIN_CAPABILITY` (32 random bytes, base64url/hex) and a
  canonical absolute `EZIL_NATIVE_DATA_ROOT`; launch `bun run native/src/main.ts`.
  The admin environment entry is consumed, never printed. The ready line is
  `EZIL_NATIVE_READY {"contractVersion":2,"port":...,"capabilities":{...}}`.
- Optionally inherit both `EZIL_NATIVE_WORKSPACE_ID` (v4 UUID) and
  `EZIL_NATIVE_WORKSPACE_ROOT` (canonical existing directory). Attached mode
  boots exactly that Electron-owned workspace. The helper does not read broker
  or credential files.
- API/document requests require exact loopback Host and Origin and bearer auth.
  Authenticated top-level `/os` navigation alone may omit Origin with navigation
  fetch headers. Static `/os/*` assets need no capability and come from committed
  `app/public/os`. Cookies, URL tokens, CORS and helper WebSockets are disabled.
- Admin `POST /api/native/capabilities` with `{workspaceId,role:'shell'|'connector'}`
  mints scoped capabilities. Shell expiry is five minutes; connector expiry is
  fifteen. Renew privately before expiry. The connector may report
  `editor.readiness` and register/unregister ports; only admin may report closed.
  Readiness expires after 45 seconds without a heartbeat, revoking preview ports.
- Only `<dataRoot>/native-v1` is helper-managed. Attached profiles live under
  `attached/<uuid>/profile/{code,browser}`. Standalone removal requires admin,
  owned records, a closed editor, no open surface/pending handoff, and a safe
  owned tree. Attached projects can never be removed by the helper. Preserve
  legacy VM data. A helper lock prevents concurrent mutation of one data root.

## Validation

```sh
bun test native/tests
bun run --cwd native typecheck
EZIL_SHELL_OUT_DIR=/tmp/ezil-shell-check shell/build-shell.sh
node shell/ezil/native-runtime-test.mjs
EZIL_SHELL_OUT_DIR=/tmp/ezil-shell-check node shell/ezil/native-test.mjs
```

Existing Code, Preview, Settings, desktop-close, registry-trace, telemetry and
local-surface regression suites also accept `EZIL_SHELL_OUT_DIR`. This lets an
isolated shell worker test the current source without editing `app/**` assets.
The integrator must rebuild/package committed shell assets before shipping.
The Electron suite adds native Chromium, code-server gateway, occlusion,
downloads, process lifecycle and packaged-helper checks. The GitHub-hosted Mac
gate and the dedicated physical runner remain authoritative for Darwin runtime,
DMG installation, DPI/window composition and Apple toolchain acceptance.
