# Native runtime v1

This helper runs trusted code on the Mac account. It is **not containment**.
`src/contract.ts` defines the shared contract and rejects unknown operation
fields. Runtime values are `contractVersion=1`, `executionTarget=macos-host`,
`isolation=trusted-native`, `editor=external-vscode`, `browser=native-chromium`,
and `cloudSync=false`. Hosted payloads retain their existing values and shapes.

## Electron startup and authentication

1. Generate a fresh 32-byte random base64url or hex `EZIL_NATIVE_ADMIN_CAPABILITY`. Supply it
   and an absolute `EZIL_NATIVE_DATA_ROOT` only in the helper's inherited
   environment. Spawn `bun run native/src/main.ts` from the repository/package
   root. Do not pass secrets in arguments. The helper emits exactly one ready
   line: `EZIL_NATIVE_READY {"contractVersion":1,"port":<number>,"capabilities":{...}}`.
   The capabilities are exactly `NATIVE_RUNTIME` from `src/contract.ts`. The
   admin environment entry is consumed at startup and never printed. Optional
   `EZIL_NATIVE_BROKER_FILE` is reserved for Electron's model broker: the helper
   does not read the descriptor or include it in any renderer response.
2. Construct `origin = http://127.0.0.1:<port>`. Every API/document fetch needs
   exact `Host: 127.0.0.1:<port>`, `Origin: <origin>`, and `Authorization: Bearer
   <capability>`. The helper never enables CORS, cookies, URL tokens, or WebSocket
   transport. An authenticated top-level `GET /os` may omit Origin only with
   `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`; it still requires
   the exact Host. A conflicting Origin is always rejected. Unsupported
   upgrades are rejected. Static
   `/os/{bundle.min.js,bundle.min.css,icons.js}` assets are public, carry no
   identity, require exact Host, and accept absent Origin (normal subresource
   requests) or the exact helper Origin. Assets are served directly from the
   committed `app/public/os` tree; package that tree alongside native/local code.
3. Electron supplies `EZIL_NATIVE_WORKSPACE_ID` (v4 UUID) and
   `EZIL_NATIVE_WORKSPACE_ROOT` (canonical absolute existing directory). Both
   must be present together. This **attached mode** boots that exact workspace
   at `/os` without another helper selection or a duplicate workspace record.
   Existing helper selections cannot override it. Only the inherited ID can
   be accessed. Profiles are created under
   `<dataRoot>/native-v1/attached/<uuid>/profile/{code,browser}`; the project
   stays Electron-owned, and helper creation/removal is refused in this mode.
   Without either inherited workspace value, standalone mode remains available:
   with the admin capability, POST `/api/native/operations` with
   `{"op":"workspace.list"}`. Let Electron's existing guest onboarding create
   and select a workspace using `workspace.create` (`name`) and
   `workspace.select` (`workspaceId`). No second onboarding flow is built here.
4. POST `/api/native/capabilities` with `{"workspaceId":"<uuid>","role":"shell"}`.
   Response: `{ok:true,token,expiresAt}`. A shell capability lasts five minutes;
   a `connector` capability lasts fifteen. Renew from Electron before expiry.
   Renderer code must never receive the admin token or capability token.
5. Load `/os` with authenticated headers, injected only for this exact helper
   document URL by Electron's main process. Its boot payload contains identity,
   native capabilities, and no paths or secrets. Expose only
   `window.ezilNative.operation(op): Promise<{ok:boolean,state?:'opened'|'unavailable',error?:string}>`
   from a context-isolated preload. Revalidate the calling frame and operation
   schema in main. The shell sends only
   `{op:'surface.open'|'surface.focus',workspaceId,surface:'code'|'browser'}`.
   Electron may perform this typed operation directly, or forward through
   `/api/native/operations` with the **shell** capability and service the
   handoff queue described below. Do not forward to that queue unless polling
   and acknowledgements are implemented. Do not expose generic fetch, IPC,
   headers, commands, or URLs.
   Reload `/os` with a new scoped capability when switching workspaces.

The shell uses that bridge for Browser, Code, and Preview (Preview opens the
native browser with registered ports). Repeated opens focus the native surface.
Unavailable VS Code leaves the shell usable. Native Settings is local and never
calls hosted computer tRPC. No telemetry endpoint is published.

## Surface handoff broker

When using the helper's optional handoff adapter, Electron's main process polls
authenticated `GET /api/native/handoffs`, about
every 100–250 ms while the app is active. It receives
`{ok:true,handoffs:[{id,workspaceId,surface,action,files,profile,previewPorts}]}`.
`surface` is `code|browser`; `action` is `open|focus`. Each request is delivered
once and expires after eight seconds. Keep polling independent of renderer
operation promises, or the handoff will deadlock. There are at most 16 pending
requests. Electron replies to `POST /api/native/handoffs` with
`{id,state:'opened'|'unavailable'}` using its admin capability. Acknowledgement
replay or an expired request is rejected. If Electron disconnects, the original
operation resolves `unavailable`; it cannot block the shell indefinitely.

Use only verified, fixed official VS Code launch logic and Electron's native
Chromium window implementation. The helper intentionally never accepts an
executable path, command, flags, or URL from browser clients. Derive fixed
`profile/code` and `profile/browser` subdirectories for the two apps. Registered
preview URLs can only be derived in trusted main as `http://127.0.0.1:<port>/`;
ports are explicit declarations, not proof that a web service is alive. Enforce
navigation/IPC policy for those preview pages in Electron. Never attach the
shell/admin bridge or headers to arbitrary preview content.

Before launching Code, mint a `connector` capability and atomically write this
0600 descriptor in the Electron app's private broker directory, outside every
project:

```json
{
  "contractVersion": 1,
  "origin": "http://127.0.0.1:49152",
  "workspaceId": "<random-workspace-uuid>",
  "token": "<workspace-scoped-connector-capability>",
  "expiresAt": 0,
  "dataRoot": "<Electron app-owned data root>",
  "workspacePath": "<canonical-absolute-workspace-root>"
}
```

Use the actual future expiry returned by the capability endpoint. Give official
VS Code that descriptor path as `EZIL_BROKER_FILE` in its inherited environment.
Use a distinct app-owned VS Code profile/user data directory so an unrelated
existing VS Code instance cannot swallow the new environment. Install/load the
connector from `extensions/ezil-vscode`; this helper does not install it itself.
Renew the descriptor atomically before expiry; the connector re-reads it on
every heartbeat/command. Keep provider secrets out of the descriptor.

The extension also accepts Electron's separate model-only descriptor through
`EZIL_AI_BROKER_FILE`:
`{contractVersion:1,url,capability,operations:['models','chat'],formats:[...]}`.
It offers **List Broker Models**, using only authenticated `GET /v1/models`
without Origin, as that broker requires. It does not send readiness/preview
operations to a model broker, and does not register a chat provider. To enable
readiness and previews, Electron must mint/renew the workspace connector
descriptor above. Neither descriptor contains an upstream provider secret.

Connector `editor.readiness` accepts `active|unknown`; only admin can report
`closed`. Forty-five seconds without an observed heartbeat yields `unknown`
and clears previews when next read. Active records become unknown on helper
restart. Code launch attempts mark unknown **before** handing off. Electron
must report closed only after it proves the associated editor process/window
exited, or after a launch was definitively unavailable and no instance exists.
Extension readiness and handoff-open acknowledgement are separate facts.
Authenticated admin `GET /api/native/previews` exposes only the attached/current
workspace UUID, editor state and validated registered port integers. Electron
uses the lowest port to open a direct loopback preview; no arbitrary URL proxy
or provider destination is derived from this endpoint.

## Storage and removal

Only `<dataRoot>/native-v1` is managed. In attached mode, helper removal always
fails, even after an admin reports the editor closed. Electron alone owns the
project's lifecycle. In standalone mode, schema-v1 ownership records have random
guest/workspace UUIDs. No path-derived identity or device fingerprint is used.
Removal requires admin, owned records, no active/unknown editor, no pending
handoff, and a tree without symlinks, hardlinked files, or special files. It
removes only that workspace's app-owned tree. Legacy VM files and sibling data
are always preserved; there is no implicit migration or destructive cleanup.

One helper acquires `native-v1/helper.lock`. Normal shutdown releases it. After
an unclean exit, verify the old helper has exited before manually removing a
stale lock. Roots with symlink components are refused: on Mac, supply the
canonical absolute data-root path. Local filesystem checks are not a defense
against concurrent hostile code running as the same Mac user; that code already
has trusted host access. Electron must close its browser/profile writers before
requesting workspace removal as well.

## Remaining integration gates

- External-browser pairing is a **tested primitive only** (`Authority`), with a
  random one-use 60-second code, hash-only server storage, and a five-minute
  workspace capability on redemption. No unauthenticated pairing route/UI ships.
- The VS Code 1.109+ extension registers the stable EZiL BYOK model provider.
  It supports text streaming and cancellation over the authenticated local broker,
  while provider secrets remain in Electron's Keychain-backed vault. Images and
  tool calls are not advertised in this first compatible provider release.
- Local Code/Preview cold start is fixed in the shared shell. The surface origin
  validator is implemented/tested in `local/src/contract/frame-origin.ts`, and
  the shell and local server now send and enforce surface-specific confirmation
  requests only in local VM mode.
- TCP loopback and Chromium launch were blocked by this worker sandbox. Run
  `EZIL_NATIVE_SOCKET_TESTS=1 bun test native/tests` and browser tests on an
  unrestricted development host, then exercise the Electron/official VS Code
  process lifecycle on Mac. No native process launch is claimed verified here.

## Validation commands

```sh
bun test native/tests extensions/ezil-vscode/tests local/src/contract local/src/boot app/src/server/shell/boot-payload.test.ts
bun run --cwd native typecheck
bun run --cwd extensions/ezil-vscode typecheck
bun run --cwd extensions/ezil-vscode build
node shell/ezil/native-test.mjs
node shell/ezil/local-surfaces-test.mjs
node shell/ezil/apps/code-test.mjs
node shell/ezil/apps/preview-focus-test.mjs
./shell/build-shell.sh --check
```

The shell build uses exact esbuild 0.28.1 and clean-css-cli 5.6.3. This sandbox
used those cached versions through a temporary `bunx` wrapper because package
installation could not write its usual cache; no source build settings changed.
