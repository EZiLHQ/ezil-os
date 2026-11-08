# Feedback app-failure context — wire contract v1

Status: consumer side (shell + app feedback API) owned by the feedback lane;
producer (EZiL chat extension + workbench transport) owned by the worker chat
lane. Both sides test against the shared golden fixtures in
`app/src/server/feedback/app-failures.fixtures.json`. A change to any enum or
bound below changes those fixtures first.

## Why a separate channel

`diagnostics.recentEvents` keeps only class/site/code plus one
`reason`/`correlationId` pair, so it cannot carry both request ids or a retry
chain. The desktop-only telemetry bridge (`shell/ezil/telemetry.js`,
`MOBILE_BRIDGE_CONTRACT`) deliberately drops detail, correlation and computer;
it is NOT loosened. App failures travel on their own narrow message and are
stored additively as `diagnostics.appFailures` in the existing feedback JSONB.
No new table, no migration.

## 1. Transport (Code window iframe → shell)

Pattern: `shell/ezil/apps/code-folder.js` (exact frame, pinned origin, nonce).

1. The shell registers each Code window iframe at launch with the origin it
   minted, the window's computer id (`ctx.computer.id`, never the message's),
   and an opaque app session id. It unregisters on dispose and on navigation
   to a new mint.
2. On every iframe `load` the shell posts
   `{ type: 'ezil.code.diag.hello', v: 1, nonce }` to that origin. `nonce` is
   a fresh random token per document load.
3. The producer posts
   `{ type: 'ezil.code.failure', v: 1, nonce, failure }` to `window.parent`.
4. The shell accepts a message only when ALL hold:
   - `event.source === registeredIframe.contentWindow` (rejects nested,
     sibling and stale frames);
   - `event.origin === registeredOrigin` and is not `"null"` (opaque);
   - `nonce` equals the current load's nonce;
   - the envelope has exactly the keys above, `v === 1`, and its serialized
     size is ≤ 2048 bytes;
   - `failure` validates against §2 exactly (no extra keys).
5. The parent never sends the nonce, mint id, URL or any session token
   anywhere else; none of them enter a report.
6. Producer-claimed context (app, computer, session, time) is never
   authority. The shell attaches `app`, computer and session from the
   registration and `receivedAt` from its own clock.

## 2. `failure` record (producer → shell)

| Field | Required | Shape |
| --- | --- | --- |
| `eventId` | yes | lowercase UUID; dedup key |
| `source` | yes | `ezil_chat` \| `code_app` |
| `operation` | yes | `chat_request` \| `app_start` |
| `category` | yes | `interrupted` \| `network` \| `timeout` \| `auth` \| `credits` \| `entitlement` \| `rate_limit` \| `provider` \| `user_cancel` \| `app_startup` |
| `code` | yes | closed allowlist, §3 |
| `stage` | yes | `startup` \| `admission` \| `request` \| `headers` \| `stream` |
| `outcome` | yes | `failed` \| `retrying` \| `recovered` \| `cancelled` |
| `streamReason` | no | `eof` \| `malformed_event` \| `missing_terminal` (only with `stage: 'stream'`) |
| `clientRequestId` | no | lowercase UUID: the SDK idempotency id, stable across automatic retries |
| `gatewayRequestId` | no | lowercase UUID: the Gateway id of THIS attempt |
| `vscodeRequestId` | no | lowercase UUID: the VS Code chat request id, only if it is a different value; never inferred |
| `retryOfClientRequestId` | no | lowercase UUID: only for a manual retry whose original id is known |
| `attempt` | no | integer 1–64 |
| `retryable` | no | boolean |
| `durationMs` | no | integer 0–3 600 000 |
| `modelKey` | no | `^[a-z0-9][a-z0-9._:/-]{0,63}$` catalog model key |
| `httpStatus` | no | integer 100–599 |

Rules:
- A code outside §3 is sent as `unexpected_error` with its ids, never as text.
- `user_cancel` only for the outer request signal the user aborted; an
  internal attempt-controller cleanup abort is not reported.
- Never: prompts, replies, tool calls/results, code, usage or hold amounts,
  file paths, URLs, headers, credentials, console text, stacks, error messages.

## 3. Closed code allowlist

| category | codes |
| --- | --- |
| `interrupted` | `stream_interrupted` |
| `network` | `network_offline`, `network_failed` |
| `timeout` | `request_timeout`, `first_token_timeout` |
| `auth` | `auth_expired`, `auth_invalid`, `session_expired` |
| `credits` | `credits_exhausted` |
| `entitlement` | `membership_required`, `model_not_entitled` |
| `rate_limit` | `rate_limited` |
| `provider` | `provider_error`, `provider_overloaded`, `provider_refused`, `model_unavailable` |
| `user_cancel` | `user_cancelled` |
| `app_startup` | `app_start_failed`, `app_start_timeout`, `chat_unavailable` |
| any | `unexpected_error` |

A code is valid only in its own category (or `unexpected_error` in any).

## 4. Shell store

- In memory only, never `localStorage`, never `telemetry.capture()`.
- One ring per (computer, app session): newest 50, entries older than 30
  minutes dropped, duplicate `eventId` ignored, at most 20 accepted messages
  per frame per minute. Sign-out clears every ring.
- A report selects ONLY its frozen context: the dialog snapshots
  `currentComputer()` when it opens (Settings / global entry) or the
  requesting frame's registration (app "Report problem" entry, which prefills
  but never sends).
- Export = newest 10 for that context, each `failure` plus `app` (`code`) and
  `ageMs` (shell clock), total ≤ 8 KiB. Only with diagnostics consent; frozen
  into the previewed body like every other diagnostic.
- If no Code frame of that context answered a hello, the preview says app
  failure context is unavailable instead of an empty list. This is NOT a
  privileged device log.

## 5. Server

- `diagnostics.appFailures`: optional strict array, ≤ 10 entries, each the §2
  record plus `app: 'code'` and `ageMs` (integer 0–1 800 000).
- `sanitizeDiagnostics` re-validates every entry and drops (never repairs) any
  that fails; request ids equal to the reporter's user/computer id are dropped.
- The boot payload advertises `ui.feedbackAppFailures: true`. The shell sends
  `appFailures` only when that flag is present; on a 400 from an older server
  the existing downgrade (`without_event_diagnostics`) also strips it.
- The admin report view renders every field escaped and lets a developer copy
  the request ids. Ids correlate logs; they are not authorization to look up
  another user's data.
