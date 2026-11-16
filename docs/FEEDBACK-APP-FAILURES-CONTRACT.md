# Feedback app-failure context — wire contract v1

Status: consumer side (shell + app feedback API) owned by the feedback lane;
producer (EZiL chat extension + workbench transport) owned by the worker chat
lane. Both sides test against the shared golden fixtures in
`app/src/server/feedback/app-failures.fixtures.json` (`valid` / `rejected`
records, and `envelopes` for the exact hello, ready and failure messages). A
change to any enum or bound below changes those fixtures first.

## Why a separate channel

`diagnostics.recentEvents` keeps only class/site/code plus one
`reason`/`correlationId` pair, so it cannot carry both request ids or a retry
chain. The desktop-only telemetry bridge (`shell/ezil/telemetry.js`,
`MOBILE_BRIDGE_CONTRACT`) deliberately drops detail, correlation and computer;
it is NOT loosened. App failures travel on their own narrow message and are
stored additively as `diagnostics.appFailures` in the existing feedback JSONB.
The detailed feedback channel needs no new table or migration. The separate incident alert outbox in §6 uses the unapplied additive migration 0024.

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
   It may also post `{ type: 'ezil.code.diag.ready', v: 1, nonce }` once per
   hello, with no other keys, to say the collector is present even before any
   failure; it counts toward the rate cap and stores nothing.
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
| `category` | yes | `interrupted` \| `network` \| `timeout` \| `auth` \| `credits` \| `entitlement` \| `rate_limit` \| `provider` \| `cancellation` \| `app_startup` |
| `code` | yes | closed allowlist, §3 |
| `stage` | yes | `startup` \| `admission` \| `request` \| `headers` \| `stream` |
| `outcome` | yes | `failed` \| `retrying` \| `recovered` \| `cancelled` |
| `streamReason` | no | `eof` \| `malformed_event` \| `missing_terminal` (only with `stage: 'stream'`) |
| `cancellationSource` | with `cancellation` only | `caller` \| `user_stop` \| `unknown`; required when `category` is `cancellation`, forbidden otherwise |
| `clientRequestId` | no | lowercase UUID: the Gateway SDK idempotency key (its own `crypto.randomUUID`), stable across automatic retries |
| `gatewayRequestId` | no | lowercase UUID: the Gateway server's request id for THIS attempt (response header or structured error) |
| `vscodeRequestId` | no | lowercase UUID: the Copilot/workbench chat ClientRequestId, only when read from the actual Copilot request context; omitted until that hook exists |
| `retryOfClientRequestId` | no | lowercase UUID: only for a manual retry whose original id is known |
| `attempt` | no | integer 1–64 |
| `retryable` | no | boolean |
| `durationMs` | no | integer 0–3 600 000 |
| `modelKey` | no | `^[a-z0-9][a-z0-9._:/-]{0,63}$`, at most one `/`, never a URL. After an optional region prefix (`us.`, `eu.`, `apac.`, `global.`, `au.`, `jp.`), either `ns/model` / `ns.model` with `ns` in `MODEL_KEY_NAMESPACES`, or a bare key whose leading word is in `MODEL_KEY_FAMILIES` (both in `app/src/server/feedback/types.ts`, mirrored in the shell). Every model segment (split on `/` `.` `:`) must not start with a credential prefix (`sk_`/`sk-`, `sb_`, `pk_`, `rk_`, `ghp_`, `gho_`, `ghs_`, `ghu_`, `github_pat_`, `xox?-`), contain a credential word (`secret`, `token`, `passw`, `bearer`, `api key`, `private`, `credential`, `session`, `cookie`) or a 20+ character alphanumeric run; the model name carries a digit or `-`. Valid: `claude-sonnet-5-5`, `gemini-3.8-flash`, `qwen.qwen3-coder-next`, `us.moonshotai.kimi-k3`, `ezil-code`, `ezil-fast`, `anthropic/claude-sonnet-4-5-20250929` |
| `httpStatus` | no | integer 100–599 |

Rules:
- A code outside §3 is sent as `unexpected_error` with its ids, never as text.
- The producer validates `modelKey` with the shared fixtures' rule before
  emitting and OMITS it when unsafe; the consumer drops a whole record whose
  `modelKey` is invalid, so an unsafe optional key must never cost the ids.
- The three request ids are independent values. None is derived from,
  parsed from UI text, or assumed equal to another; a user-supplied
  screenshot reference stays in the user's description, not in these ids.
- Cancellation is neutral: `category: 'cancellation'`, `code:
  'request_cancelled'`, `outcome: 'cancelled'`, with `cancellationSource`.
  An outer CancellationToken proves only that the CALLER cancelled
  (`caller`); `user_stop` requires a real Stop-intent marker; otherwise
  `unknown`. An internal attempt-controller cleanup `abort()` is never
  reported. `outcome: 'cancelled'` is used only with `cancellation`.
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
| `cancellation` | `request_cancelled` |
| `app_startup` | `app_start_failed`, `app_start_timeout`, `chat_unavailable` |
| any | `unexpected_error` |

A code is valid only in its own category (or `unexpected_error` in any).

## 4. Shell store

- Detailed records remain in memory only, never `localStorage`, and are never passed to `telemetry.capture()`. The separately authorized terminal metadata projection is specified in §6.
- One ring per (computer, app session): newest 50, entries older than 30
  minutes dropped, duplicate `eventId` ignored, at most 20 accepted messages
  per frame per minute. Sign-out clears every ring.
- A report selects ONLY its frozen context: the dialog snapshots
  `currentComputer()` when it opens (Settings / global entry) or the
  requesting frame's registration (app "Report problem" entry, which prefills
  but never sends). Scope: with an app session (app entry), only that
  window's ring; without one (global entry), every app session of the frozen
  computer, never another computer's.
- Entries outlive their window: closing or reminting a Code window stops new
  messages from it but keeps its unexpired entries reportable.
- Export = newest 10 for that context, each `failure` plus `app` (`code`) and
  `ageMs` (shell clock), total ≤ 8 KiB. Only with diagnostics consent; frozen
  into the previewed body like every other diagnostic.
- If the context has no retained entries and no live Code frame of it has
  answered a hello (`ready` or a valid failure), the preview says app failure
  context is unavailable instead of an empty list. This is NOT a
  privileged device log.

## 5. Server

- `diagnostics.appFailures`: optional array of ≤ 10 entries. The wire schema
  bounds only the count, so one malformed entry never rejects the whole report
  (description, screenshot and report id are kept); each stored entry is the
  §2 record plus `app: 'code'` and `ageMs` (integer 0–1 800 000).
- `sanitizeDiagnostics` validates every entry independently and drops (never
  repairs) any that fails; request ids equal to the reporter's user/computer id are dropped.
- The boot payload advertises `ui.feedbackAppFailures: true`. The shell sends
  `appFailures` only when that flag is present; on a 400 from an older server
  the existing downgrade (`without_event_diagnostics`) also strips it.
- The admin report view renders every field escaped and lets a developer copy
  the request ids, each labelled unambiguously (Workbench request id, SDK
  idempotency key, Gateway request id). The workbench id is optional and not
  guaranteed to be captured; no equivalence between the ids is claimed. Ids
  correlate logs; they are not authorization to look up another user's data.


## 6. Authorized automatic terminal metadata projection (staging)

The user authorizes automatic metadata-only terminal AI incident telemetry,
independent of submitting feedback. Detailed `appFailures` records remain
consent-only. The collector imports no telemetry module and installs no listeners
on import. Code supplies an optional, throwing-safe `onTerminalFailure` observer.
It runs only after source/contentWindow, exact origin, live src, v1, fresh nonce,
exact envelope keys, 2048-byte bound, record validation, 20 messages/minute rate
limit and eventId deduplication have accepted and stored the record.

Only `outcome: failed` and the following closed mapping reach the observer:

| Validated failure code | Telemetry code |
| --- | --- |
| provider_error | ai_provider_error |
| provider_overloaded | ai_provider_overloaded |
| model_unavailable | ai_model_unavailable |
| stream_interrupted | ai_stream_interrupted |
| first_token_timeout | ai_first_token_timeout |
| request_timeout | ai_request_timeout |
| app_start_failed | ai_app_start_failed |
| app_start_timeout | ai_app_start_timeout |
| chat_unavailable | ai_chat_unavailable |

Every projection has exactly `eventClass: api_failure`,
`site: ezil-os:apps/code#aiRequest`, the mapped `code`, and `outcome: error`.
No request/event id from the detailed record, model, user/computer id, amount,
prompt, error string, tool content or other detail is copied. The existing sink
adds its own random event id, schema version, source and timestamp, but suppresses
ambient correlation and computer ids for this site. The authenticated server
continues deriving its existing user hash for distinct-user aggregation.
Cancellation, retrying, recovered, credit/entitlement refusals, provider_refused,
and unmapped codes do not project. Existing telemetry endpoint/sign-in gates,
batching, per-key maximum of three events per page and transport limits apply.
A producer must report a retry as `retrying` and reserve `failed` for terminal
failure; a later recovered record cannot retract a previously terminal report.

The nine mapped terminal codes and `computer_rebase_required` qualify for an
incident at one real user. Warming polls and timing milestones do not gain a
one-user policy. This change does not add a frame_not_answering policy because
that code is also used outside this validated terminal channel.

The cron runs the incident drain after authorization and before staging billing
dependencies, with its own failure isolation. SMTP2GO uses the existing verified
`invites@projects.ezil.work` sender, `contact@ezil.work` recipient and five-second
timeout. Subjects identify staging and link to
`https://os-staging.ezil.work/admin/telemetry`. Provider acceptance is not mailbox
delivery. A crash/rollback after provider acceptance can resend; Message-ID helps
identify duplicates but does not establish provider idempotency. Queue bounds,
mutes, cooldowns, delivery budget and retries remain durable.

A freshly observed empty event table establishes `first_observed_at`; silence
requires six hours since that timestamp (or the latest event when present).
A collection-silent notice is enqueued at most once per 24 hours. Collection
silence is an absence-of-events signal, not proof of an ingestion outage.

Migration `0024_telemetry_alerts.sql` is additive and unapplied. The staging runner
explicitly inventories it. Production protocol v1 has no `draft` kind; its
existing non-applying `snapshot` source pattern records the actual file checksum,
with no entry in `migrations` or the Drizzle journal. Historical `initialCatalog`
and `sourceDigest` remain unchanged. Any edit before application requires updating
the source checksum. Promotion requires reviewed, actually observed before/after
catalog hashes and an explicit release decision. No hosted migration, delivery
or deployment is established by these local changes; production remains HOLD.
