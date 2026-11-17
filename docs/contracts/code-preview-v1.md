# Code preview and element context — contract v1

Status: accepted for implementation, 2026-11-17 (task 41b7021e, agent-first Code workspace).

## Layout (no session transfer)

- The bundled EZiL Chat stays in the Secondary Side Bar (aux bar) for its whole life. Nothing moves the chat widget,
  re-creates it, or opens it in an editor.
- A new profile starts with `workbench.secondarySideBar.defaultVisibility: "maximized"` (editor-state.sh). This makes
  the chat fill the workbench with a centred composer. VS Code applies that default to new profiles only, so a
  returning user's own layout is kept.
- Opening the preview runs `workbench.action.restoreAuxiliaryBar` when the aux bar is maximized, and opens the
  extension-owned WebviewPanel `ezil.preview` in the editor area with `preserveFocus: true`. The Explorer stays native
  on the left. The result is files left, preview centre and chat right, in the same widget.
- The shell never re-`src`s, reparents or remints the code-server iframe for layout.

## Trust model

The inspector runs inside the app's own JavaScript realm, so app code can read its nonce and forge its messages.
Origin, source and nonce checks only rule out other frames and stale documents. The boundary is everything after
those checks:

1. Every hop re-validates and re-caps the record against `code-preview-v1.vectors.json`: inspector, webview script,
   extension host, workbench hook.
2. A selection is accepted only while the user has Select mode on in the preview toolbar. That is an explicit user
   gesture recorded by the webview, never by the frame.
3. The only effect of a valid selection is one visible pending attachment on the existing composer. Nothing is sent
   until the user presses Send.
4. No message from any frame may run a command, start inference, write a file, change a port or reveal a credential.

## Hop 1: inspector (app frame) ↔ preview host (webview content document)

The Worker serves `/preview-inspector.js` with an allow-list of parent origins. On the Cloudflare bridge that is this
sandbox's code origin, `https://<CODE_PREVIEW_PORT>-<id>-code.<zone>`, plus `codeShellOriginsFor(zone)` for the
standalone Preview app. AWS uses the equivalent. Messages are never posted with `'*'`.

Parent → frame (`ev.source === window.parent`, `ev.origin` in the allow-list):

- `{type:"ezil.preview.hello", v:1, nonce}`. `nonce` matches `^[A-Za-z0-9_-]{22}$`. Each hello rebinds the frame to
  that origin and nonce.
- `{type:"ezil.preview.mode", v:1, nonce, mode:"interact"|"select"}`.

Frame → parent (only to the bound origin, with the bound nonce):

- `{type:"ezil.preview.ready", v:1, nonce, doc}`, sent once per hello.
- `{type:"ezil.preview.navigate", v:1, nonce, doc}`, on pushState, replaceState, popstate and hashchange.
- `{type:"ezil.preview.changed", v:1, nonce, doc}`, debounced and at most 4 per second, when DOM mutations or an HMR
  update change `doc.mut`.
- `{type:"ezil.preview.select", v:1, nonce, sel}`, only in select mode, on click, Enter or Space. The default action
  is prevented.
- Diagnostic pages (`no_package_json` / `port_not_listening` / `upstream_error`) answer a hello with
  `{type:"ezil.preview.state", v:1, nonce, state}` and never `ready`. Readiness means a successful server mint plus a
  `ready` from an app document. An iframe `load` event or an open TCP port alone does not count.

`doc = {gen, mut, path, title}`:

- `gen` is a random 22-character token generated once per document load.
- `mut` is an integer in 0..2^31 that increases on every observed mutation batch or HMR update.
- `path` is the in-app path plus query plus hash, sanitized (see below), at most 512 chars.
- `title` is at most 120 chars.

`sel` = `{doc, viewport, el, ancestors}`:

- `viewport = {w, h, dpr}`: integers, plus dpr in 0.5..8.
- `el`:
  - `tag`: lowercase, `^[a-z][a-z0-9-]{0,31}$`.
  - `id?` and `classes`: id ≤64 chars; classes ≤12 entries of ≤64 chars each.
  - `role?`, `name?`: the accessible name, ≤120 chars.
  - `text`: the visible text, whitespace-collapsed, ≤300 chars.
  - `selector`: a CSS path of `tag#id` / `tag.class` / `:nth-of-type(n)` steps, ≤512 chars.
  - `rect = {x, y, w, h}`: integers.
  - `attrs?`: only `href`, `src`, `alt`, `type`, `placeholder`, `aria-label`, `data-testid`, each ≤200 chars, with
    `href` and `src` sanitized.
  - `styles`: allow-listed computed properties only, each value ≤120 chars:
    - colour: `color`, `background-color`
    - text: `font-family`, `font-size`, `font-weight`, `line-height`, `text-align`
    - box: `display`, `position`, `margin`, `padding`, `border`, `border-radius`, `width`, `height`
    - layout: `gap`, `flex-direction`, `justify-content`, `align-items`
  - `source?`: `{eid}` only when the element or an ancestor carries `data-eid` / `data-oid`. `eid` is a string of
    1..200 chars with no control characters. It is never inferred.
- `ancestors`: ≤6 entries of `{tag, id?, classes}`, nearest first.
- The whole `sel` as JSON must be ≤12000 UTF-16 code units. Every hop refuses a larger record before doing any other
  work.

**Navigation is a revision.** Every `navigate` increments `doc.mut`, and so does every `changed`. Receivers also
compare `doc.path`, so a selection is stale when its `gen`, `mut` or `path` differs from the current document.

**Document status.** On the Cloudflare and AWS app bridges, only an HTML response with status 2xx gets the
ready-capable inspector. Any other HTML status gets the diagnostic responder, which answers a hello with
`ezil.preview.state` and `state: "upstream_error"`.

**Inspector script on fallback auth.** When the page was reached through the `ezil_pv` query fallback, the injected
`<script src>` for the inspector must carry the same `ezil_pv` value. Without it, a browser that drops the preview
cookie loads the page but gets a 401 for the inspector.

**Transport path vs displayed path.** `doc.path` is the in-app path that is displayed and copied. The Cloudflare bridge
serves the app under `/preview/*`. Any host that navigates the frame itself (Back, Forward, Reload) must map the
displayed path to the transport URL with `transportUrl(origin, path)`:
- Cloudflare app host: `origin + "/preview" + path`.
- AWS app host (`aws-3002-<id>-aws.<zone>`): `origin + path`. `aws-origin.ts` serves the app at the root.

The copied/"open in browser" safe URL is also the transport URL (it works with the cookie), minus every credential
parameter.

Sanitization applies at every hop:

- **Excluded values.** No `value` of `input`, `textarea` or `select`, no `[type=password]` field, no
  `contenteditable` text, and no `autocomplete` credential fields. For these, `text` is `""` and `attrs` drops
  `placeholder`.
- **Stripped query parameters.** In `path`, `href` and `src`, these query parameters are removed, matched
  case-insensitively: `ezil_pv`, `ezil_mint`, `token`, `access_token`, `id_token`, `refresh_token`, `code`, `state`,
  `session`, `sid`, `key`, `api_key`, `apikey`, `secret`, `password`, `pass`, `auth`, `authorization`, `signature`,
  `sig`, and any name ending `_token`. `username:password@` userinfo is removed.
- **Fragments.** The same rule applies to the fragment. A fragment of the form `#k=v&…` is parsed as a query, and a
  hash-router fragment `#/route?k=v…` has its query part parsed the same way. Credential parameters are removed. A
  fragment that is left empty (`#` or `#/route?`) is reduced to the route alone or dropped.
- Control characters are removed, and strings are truncated after sanitizing.

## Hop 2: preview host → extension host → workbench hook

The webview script accepts frame messages only when `ev.source === frame.contentWindow`, `ev.origin` equals the
origin of the minted preview URL, the nonce is the latest hello's nonce, and the frame has not been re-navigated by
the host since then. It posts `{type:"select", sel}` to the extension, and only while its own Select toggle is on.

The extension builds the attachment from a re-validated `sel` and calls the renderer command `_ezil.chatAddContext`
(patch `chat-context`) with:

`{v:1, id, name, value, stale:false}`

- `id`: `^ezil-preview:[A-Za-z0-9_-]{22}$`.
- `name`: ≤80 chars, for example `<button> "Sign up" · /pricing`.
- `value`: Markdown, ≤4000 chars, rendered from `sel` by `renderSelectionContext`. It says plainly that the record is
  a DOM snapshot from the live preview, not a source location.

The hook calls `attachmentModel.addContext` on the existing chat view's widget only, as a generic `string`
attachment. It never touches the input text, never submits, and never moves focus. It returns `true` or `false`.

**Stale selection.** When a later `changed` or `navigate` message differs from the selection's `doc.gen` or `doc.mut`,
the extension calls `_ezil.chatAddContext` with the same `id` and `stale:true`. The hook replaces that attachment's
name with a ` (stale)` suffix, and the value gains a leading stale notice. A selection whose `doc.gen` is not the
current document is refused at creation.

## Hop 3: preview URL minting (extension → shell, never the reverse)

The extension calls the renderer command `_ezil.previewMint` with `{v:1, id}`, where `id` is a 22-character token. The
hook dispatches the window event `ezil-preview-mint` with `detail = JSON {v:1, id}`.

The Worker-injected `code-preview-bridge` relays that event to the pinned shell after a nonce handshake:

- `ezil.code.preview.hello` / `ready`, the same as the billing bridge.
- `{type:"ezil.code.preview.mint", v:1, nonce, id}`.

The shell mints through the existing `session.previewUrl(computerId)`, for this Code window's own computer only. It
answers with one of:

- `{type:"ezil.code.preview.url", v:1, nonce, id, url, expiresAt}`
- `{type:"ezil.code.preview.url", v:1, nonce, id, error}`, where `error` matches `^[a-z_]{1,40}$`.

The bridge re-validates the answer and dispatches the window event `ezil-preview-mint-reply` (`detail` JSON). The hook
resolves the pending `_ezil.previewMint` promise with `{url, expiresAt}` or `{error}`, and times out after 240 s.

`url` must be `https:` and its host must match `^3002-[a-z0-9-]{1,80}-app\.` (Cloudflare) or the AWS app pattern.
Anything else is refused at every hop.

The token is never logged, never persisted (webview state and serializer keep only `{open, path, viewport}`), and never
shown. The displayed and copied URL is the app's origin plus the sanitized in-app path.

## Vectors

`code-preview-v1.vectors.json` lists the `sel`, attachment and mint records that every hop must accept or refuse.
