# Browser verbs v2: one Browser tool for EZiL MCP and Code (RUN-1121 WS3)

Status: **frozen** 2026-11-21 by the WS3 lead (RUN-1121). Staging only. The data half of this contract is
`worker/sidecar/contract.mjs`; where this text and that file disagree, the file wins and this text is the bug.

| Part | Where | Lane |
|---|---|---|
| §1 Sidecar wire v2 | `worker/sidecar/contract.mjs`, `verbs.mjs`, `browser.mjs`, `page-scripts.mjs`, `redact.mjs`; `worker/src/browser-sidecar.ts` | sidecar |
| §2 Origin tiers, URL sanitising | `worker/sidecar/origin-policy.mjs` | sidecar |
| §3 Server auth, Code loopback | `worker/sidecar/server.mjs`; Worker `handleBrowserSidecar` | os-receiver |
| §4 MCP owner-app control | `worker/sidecar/mcp-owner-app.mjs`, `mcp-tab-*.mjs`, `mcp-observation*.mjs`; `app/src/server/browser-observe/*`; ezil-mcp `src/tools/workflow-browser.ts` | os-receiver, mcp-tools |
| §5 Identity | ezil-mcp `workflow-browser.ts` | mcp-tools |
| §6 Env | Worker `Env`/`browserOpenBootEnv`/`wrangler.toml` staging vars; `deploy/aws/os-staging/render-env.py` | os-receiver |
| §7 Code stdio tools | `extensions/ezil-models/src/browser-mcp-{stdio,server}.ts` | ws3-code-stdio |
| §8 Accepted limit | this file | — |
| §9 Acceptance | `ops/acceptance/universe-browser-e2e.mjs` (independent reviewer) | reviewer |

## 1. Sidecar wire v2 (additive)

v1 (the ten routes pinned by EZiL-Works `browser-sidecar.contract.json`) is a strict subset: no v1 request
member, response member or error code changes. `SIDECAR_WIRE` = `V1_ROUTES` + `V2_ROUTES`. `FORBIDDEN_VERBS`
is unchanged and there is no `upload` verb.

| Route | Request | Response | Rules |
|---|---|---|---|
| `POST /fill_form` | `fields` (required) | `ok, url, filled, redacted` | 1–20 `{ref, value}`, `value` ≤ 4000 chars. All refs resolve before any fill: one bad/stale ref fills nothing. Password fields register their value as a secret before filling; `redacted` counts them. |
| `POST /select` | `ref`, `values` (required) | `ok, url, selected` | 1–20 option labels or values; ref must be a combobox/listbox (else `bad_ref`). `selected` = option values now selected. |
| `POST /scroll` | `ref?`, `dy?` | `ok, url, scrollY` | Exactly one. `ref` scrolls it into view; `dy` is an integer, abs ≤ 5000, scrolls the window. |
| `POST /press` | `ref?`, `key` (required) | `ok, url` | `key` ∈ `PRESS_KEYS` exactly (Enter, Tab, Shift+Tab, Escape, Backspace, Delete, Space, Arrow keys, Home, End, PageUp, PageDown); else `bad_request`. |

New error code: `origin_read_only` (the page's tier does not allow the verb). Every other failure keeps its v1 code.
Errors keep `ERROR_SHAPE` and the fixed `detail`.

**Refs are page-bound in v2.** Ref meta records the page and origin it was minted on. `resolveRef` answers
`stale_ref` when the active page is not that page, or its origin changed since the snapshot. This closes a ref
minted on one tab matching a leftover `data-ezil-ref` on another.

## 2. Origin tiers and URL sanitising (`origin-policy.mjs`)

- Tier origins come **only** from `EZIL_BROWSER_OWNER_APP_ORIGINS` and `EZIL_BROWSER_IDP_ORIGINS`
  (staging: `https://universe-staging.ezil.work` and `https://id.ezil.work`). Each is a comma list of bare https
  origins. A malformed entry empties that tier (fail closed) and logs once at boot. An origin in both lists is
  `idp_transit`. `EZIL_BROWSER_TEST_ALLOWED_ORIGINS` is never a tier source (it also widens Code chats).
- `tierOf(url)` returns `owner_app | idp_transit | other`. `other` is exact v1 behaviour plus the v2 verbs.
- **`idp_transit` is transit only.** Allowed: `GET /health`, `POST /navigate`, `POST /wait_for` with `time`
  only. Every other route, including `wait_for{text}`, `console` and `network`, answers `origin_read_only`:
  no refs, no typing, no text, no screenshots, no frames. The agent passes through the IdP by redirect and never
  acts on it; sign-in there is the user's.
- The tier is evaluated on the page the verb acts on, immediately before acting. A verb that navigates (click,
  `type{submit}`, `press Enter`) may land on any tier; its returned `url` is sanitised.
- **`sanitizeUrl(url)`**: an `idp_transit` URL becomes origin + path. Any URL whose query or fragment has a
  parameter in `SENSITIVE_URL_PARAMS` (`code, state, id_token, access_token, refresh_token, token,
  session_transfer_token, nonce, ticket, code_verifier`) loses its whole query and fragment. Applied at the
  source: network and console entries when recorded, every `url` member of every response, and URLs inside
  console `text` and `location`.
- `console` and `network` return only entries recorded from the **active page** (entries carry an internal page
  tag; the public entry shape is unchanged). Other tabs and contexts are never reported.
- Password handling is v1: values never leave (`redactDeep` over every response), screenshots mask
  `input[type=password]`, and the masked PNG bytes are identical whatever the password value.

## 3. Sidecar server

- **Bearer on every verb route.** Every `SIDECAR_WIRE` route requires `Authorization: Bearer
  $EZIL_WORKER_BROWSER_MCP_TOKEN` (the existing 43-char token format and constant-time compare). Missing, wrong
  or unset → HTTP 401, `{ok:false, error:'bad_request', detail:'Request failed.'}`. The Worker's
  `handleBrowserSidecar` sends the bearer when it forwards.
- **Code loopback.** `POST /internal/code/browser/<verb>` for each verb in `CODE_BROWSER_VERBS` (the 13 v2
  verbs except `health`), with the existing Code-route guards: `Authorization: Bearer
  $EZIL_CODE_BROWSER_MCP_TOKEN`, no `Origin` header, loopback peer. Bodies are the `SIDECAR_WIRE` entry for
  `POST /<verb>`. A page in `owner_app` or `idp_transit` answers `origin_read_only` here (Code chats do not drive
  the user's signed-in apps). `/internal/code/browser/open-url` is unchanged. **Policy, not confinement** (§8).
- The legacy `/internal/mcp-browser-observe` read without `action` stays unauthenticated (the AWS host edge
  forwards it with no token).

## 4. MCP owner-app control (sidecar ↔ OS ↔ EZiL MCP)

The path is unchanged: MCP `browser_read_page` / `browser_action` → OS `POST
/api/mcp/browser-sessions/<id>/observe` (signed delegation; procs `browserSession.readPage` /
`browserSession.control`; scopes `ezil:browser:page:read` / `ezil:browser:control`; transcripts
`EZIL-BROWSER-PAGE/1` / `EZIL-BROWSER-CONTROL/1`) → Worker → sidecar `/internal/mcp-browser-observe` with
`action`. OS `browser-observe/contract.ts` and MCP `workflow-browser.ts` declare the same shapes.

- **Sidecar:** owner-app pages go to a new `mcp-owner-app.mjs`, in Chromium's **default context** (the user's
  profile and cookies). It has no CSP injection and no request interception, allows form descendants and labels
  like "Save", and **never mints a ref for a password input**. `idp_transit` pages answer `observed:
  'interactive_sign_in_required'` with no elements and no frame. Example.* and fixture pages keep the existing
  `mcp-tab-actions.mjs` path, unchanged.
- **`action`** is one of `navigate{url}`, `click{ref}`, `type{ref,text}`, `fill_form{fields:[{ref,text}] 1–20}`,
  `select{ref, values[1–20]}`, `scroll{ref}` or `scroll{dy}`, `press{key ∈ PRESS_KEYS, ref?}`. Refs are the
  OS-minted 22-char handles from the last read.
- **`text`** (type and fill_form): the schema allows 1–4000 chars, ≤ 16 KiB UTF-8, `\n` and `\t` allowed, other
  control characters refused. Off owner-app pages the OS keeps the v1 bound (1–80 chars, no line break).
- **`navigate`** may target an owner-app origin or an already-allowed origin, never an IdP origin directly.
- **`observed`** gains `owner_app_page`. Non-navigate actions are allowed when the last read was `approved_page`,
  `profile_builder` or `owner_app_page`.
- **`elements`**: kinds gain `textarea`, `select`, `checkbox`; a `select` carries `options` (≤ 20, each ≤ 80
  chars). At most 64 elements on owner-app pages, 16 elsewhere. Labels ≤ 80 chars.
- **`ownerAppAccountEmail: string | null`** (OS response, owner-app pages only): the value of the readonly
  "E-mail address" field on `/builder/profile-builder` (Blade `#builderEmail`, Universe
  `builder_form.blade.php:109-110`; the React equivalent is recorded in Universe
  `docs/agents/universe-browser-map.md`). `null` anywhere else.
- **Frames:** `includeFrame` returns the masked JPEG (≤ 80,000 base64 chars) on `approved_page`, `profile_builder`
  and `owner_app_page`, both as an MCP `image` content block (model-visible) and as `_meta.viewerFrame`. Never on
  `interactive_sign_in_required` or any IdP page. The MCP response cap rises from 96 KiB to 160 KiB.
- **Failures** gain `origin_read_only` (HTTP 403). The other failure codes are unchanged.
- All URLs in OS and MCP output (`pageUrl`, element hrefs) pass through `sanitizeUrl`.
- AWS computers: legacy observe only in this slice. v2 control needs the host edge to carry a bearer (out of scope).

Also in this slice: ezil-mcp `open_computer` accepts destination `"browser"` (same link as `"desktop"`, worded
"Browser or Code link"). EZiL-OS `mcp/src/tools.ts` adds `browser_status`, `open_browser` and `restart_browser`
as aliases sharing the `desktop_status`, `open_desktop` and `restart_desktop` handlers; the old names stay.

## 5. Identity

MCP `universeIdentity` is `'unverified' | 'same_ezil_id'`. It is `same_ezil_id` only when the grant's
`props.provider === 'ezil_id'` (issuer `https://id.ezil.work/`) **and** `ownerAppAccountEmail`, trimmed and
lower-cased, equals `props.email`, trimmed and lower-cased. The MCP never echoes the email. The OS never decides
identity (its delegation identity is issuer + subject and never matches by email). **Accepted strength:** issuer
plus email, not the Auth0 `sub`, because Universe does not expose its `provider_id`.

## 6. Env

- Worker: `EZIL_BROWSER_OWNER_APP_ORIGINS` and `EZIL_BROWSER_IDP_ORIGINS` in `Env`, forwarded to the sidecar by
  `browserOpenBootEnv`, set in `worker/wrangler.toml` `[env.staging.vars]` only.
- App (AWS os-staging): the same two keys through `render-env.py` (staging only). It **rejects** any IdP origin
  in `EZIL_BROWSER_TEST_ALLOWED_ORIGINS` or in the owner list, and any overlap between the test list and the
  owner list. Universe and the IdP are never added to `EZIL_BROWSER_TEST_ALLOWED_ORIGINS`.

## 7. Code stdio tools

`tools/list` on the Code stdio server returns exactly: `browser_open_url` (unchanged) and `browser_navigate`,
`browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_select`, `browser_scroll`,
`browser_press`, `browser_get_text`, `browser_screenshot`, `browser_console`, `browser_network`,
`browser_wait_for`. Each calls `POST 127.0.0.1:9223/internal/code/browser/<verb>` with the Code bearer and
returns the sidecar body (screenshots as an MCP `image` block). Gated on `EZIL_CODE_BROWSER_MCP=on`, as today.

## 8. Accepted limit of this slice

Chromium, the sidecar and code-server run as the same user (root). CDP on `127.0.0.1:9222` is unauthenticated and
total, the Browser profile is on disk, and `EZIL_CODE_BROWSER_MCP_TOKEN` is visible to the Code terminal
(`start-neko.sh:165,1023,2229`; `editor-state.sh:70-74`). **Any process inside the computer, including a Code
chat's shell, can read a signed-in Browser session.** The 9223 bearer stops casual use of the sidecar and nothing
more. Code chats are **not** confined to preview origins; §3's owner-app refusal is agent policy. Running Chromium
as a separate UID with CDP behind a socket only the sidecar can read is out of scope (`start-neko.sh` and
`worker/Dockerfile` belong to another workstream in this run).

## 9. Acceptance

- **A1** `cd worker/sidecar && bun test` passes; served routes equal `SIDECAR_WIRE`; `FORBIDDEN_VERBS` absent;
  the pinned v1 JSON is a subset (`EZIL_BROWSER_SIDECAR_CONTRACT` set so the suite runs, not skips).
- **A2** Policy tests: owner-app forms permitted; `type`, `click`, `screenshot` on an IdP page answer
  `origin_read_only`; no `code=` or `state=` in any output; password values absent; masked PNGs byte-identical.
- **A3** `node ops/acceptance/universe-browser-e2e.mjs --mcp <url> --computer <id>` prints one JSON line and exits
  0 with `{"signedIn":true,"sameIdentity":true,"saved":true,"readBack":true,"restored":true,"publishCalls":0,"leaks":0}`,
  or exits 78 with `{"signedIn":false,"reason":"SIGN_IN_REQUIRED"}`; anything else exits 1. `sameIdentity` =
  `whoami.provider === "ezil_id"` and equal emails. The run sets the tagline to `e2e-<nonce>`, saves
  (`manual_save=1`, current `profile_revision`; a 409 means reload and re-read), reloads, reads it back, then
  restores the original text and verifies the restore. `publishCalls` counts `/builder/work-profile-complete`
  network entries; `leaks` counts `code=` or `state=` in any tool output. It never calls publish.
- **A4** `tools/list` on the Code stdio server equals §7 exactly.

Out of scope: Auth0 Native-to-Web SSO, the `upload` verb, AWS v2 control, Chromium UID isolation, a server-side
publish block (the skill asks the user to confirm, naming the action, before publish, bid, job post, resume upload
or phone verification).
