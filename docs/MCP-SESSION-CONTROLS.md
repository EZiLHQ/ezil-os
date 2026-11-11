# EZiL MCP session controls: the OS side

The OS procedures behind the EZiL MCP's gated controls (`SESSION_TOOLS` + `SESSION_CONTROLS`), as
specified in the MCP's `proposals/session-controls.md` and checked against its validator
(`src/tools/controls.ts`). Nothing here is deployed.

| Scope | Procedure | Type | Where |
| --- | --- | --- | --- |
| `ezil:computers:start` | `computer.start` `{ computerId, idempotencyKey }` | mutation | `server/api/routers/computer.ts`, `server/computer-start/` |
| `ezil:sessions:read` | `agentSession.models` `{ computerId }` | query | `server/agent-session/control-store.ts` |
| `ezil:sessions:read` | `agentSession.settings` `{ sessionId }` | query | same |
| `ezil:sessions:read` | `agentSession.control` `{ kind, idempotencyKey }` | query | same |
| `ezil:sessions:write` | `agentSession.create` `{ computerId, model?, effort?, idempotencyKey }` | mutation | same |
| `ezil:sessions:write` | `agentSession.configure` `{ sessionId, model?, effort?, idempotencyKey }` | mutation | same |

`agentSession.control` is not in the proposal's table but the MCP calls it before every create and
configure to reconcile a retry (`{ found: false }` or `{ found: true, row }`, the stored control row of this
person's client under that key). The allowlist (`DELEGATED_PROCEDURES`) is fail-closed: one scope per
procedure, one method per type, and `delegation-auth.test.ts` pins the whole list.

## Rows and idempotency

`ezil_control_operations` (`app/drizzle/hardening/0024_control_operations.sql`, extended by `0025_editor_controls.sql`) holds one row per request,
unique per **(person, OAuth client, procedure, key)**, kept 7 days. Same key and input: the original row,
whatever has changed since (a retry is read before the target is). Same key, other input: CONFLICT.
Another person's computer, session or row is NOT_FOUND. The shipped `agentSession.send` is keyed per person
(no client); the controls follow the MCP's contract instead, so a different client under the same key is a
separate request.

Each call logs one `ezil_control` line: `jti`, `client_id`, `sub`, `user_id`, `procedure`, `idempotency_key`,
`outcome`. It never holds a model, instruction text, a URL, a token or an email.

## What the OS does now (editor bridge protocol 2, `docs/EDITOR-BRIDGE-PROTOCOL-2.md`)

Protocol 2 is answered only while `EZIL_EDITOR_BRIDGE_CONTROLS=enabled`, which the release owner sets AFTER
migration 0025 is applied. Until then every statement is exactly protocol 1 and the five procedures below
report the editor as unable (`editor_controls_unsupported`). A window that already upgraded keeps syncing when
the flag is turned off: its protocol-2 body is handled and answered as protocol 1.

- **`models`**: the editor's own offer, only while its lease is live, it syncs protocol 2 and its catalog is
  at most 45 s old (OS's clock, never the editor's `observedAt`), and only the rows the **Gateway marked
  available for this account** (a row's `availability: "available"`, reported by the editor with the
  computer's own AI token). Otherwise `unavailable`, no models, and the reason names the gap. A configured
  row is listed whatever the account, so it is not entitlement proof; the admin registry and any static list
  are never a fallback. Available lists carry `accountScoped: true`, `efforts: []`, `defaultEffort: null`
  and the model's fixed `configuredEffort`.
  - **Source:** the editor's own `availability: "available"` on a catalog row (bridge `f2fd6f3f`..`600fd9e0` plus the
    clock fix below). Never marked: a static configured model, another vendor's row, a legacy catalog row, a
    denied/disabled/missing row, a failed read, or evidence too old (a failed re-read never falls back to the older
    one). With no marked row OS answers `unavailable` with the gap ("...configured for every account, and does not
    report which of them the EZiL Gateway allows this account to use..."), and a model-bearing create/configure is
    `rejected`.
  - **Two separate freshness policies, not one bound:**
    - *Editor evidence policy (local, 15 s):* the computer's own AI token read the Gateway's `/v1/models`, and that
      exact alias is enabled and `available` for this account with no killswitch or pause, and the read BEGAN no more
      than 15 s before the editor emits the catalog. The clock is read at every cache-or-read decision and again at
      emission (`accountAvailableIds`); evidence that aged out while other providers were read is read again, and any
      still older at emission is dropped (fail closed).
    - *OS receipt window (45 s):* OS treats a received catalog as fresh for 45 s from ITS receipt, stamped with its own
      clock (the editor's `observedAt` is never used); the MCP accepts OS's reading for 60 s.
    - The time between the editor's emission and OS's receipt (transport, queueing, a database lock) is **not**
      counted by either. There is therefore no hard 60 s bound on the Gateway read's age, and none is claimed unless
      transit is separately enforced.
  - **What `accountScoped: true` means:** an authenticated report from the current computer's editor that the
    Gateway's answer for that computer's own AI token marked this row available. It is NOT an independent
    attestation by the Gateway or by OS: OS cannot ask the Gateway for the delegated caller's `/v1/models` (a
    delegated call carries no user token). The real Gateway authorization at request time remains the authority
    for execution: the editor runs in the person's own computer, so a forged catalog can only offer that person a
    model the Gateway then refuses; it grants nothing. This is the documented trust design for this feature.
  - **Limit:** a computer whose editor is closed or on protocol 1 has no list at all.
- **`settings`**: `{ sessionId, computerId, status, bridge, settings }`, with `settings` null unless a
  connected editor reported that open session's own input model within 45 s:
  `{ model, effort: <that model's configuredEffort, or null>, effortSupported: false, observedAt: <OS's
  reading time>, source: "runtime" }`. A finished send's recorded model is never shown.
- **`create`**: queued (`accepted`, with `expiresAt`) for the current owner's editor, handed out by its next
  protocol-2 sync, and answered by its `applied` report. The caller waits up to 4 s, then reads `accepted`.
  `effective` is `{ model, effort, observedAt, source: "runtime" }` from the editor's readback and the
  model's fixed effort in its catalog, never the request. The new `sessionId` is the OS row created when the
  report arrives, marked `created_by_os` only if the resource was unknown to OS and the editor reports zero
  requests; otherwise the row is `uncertain` / `created_session_not_tracked` and the chat is never OS's.
  An applied create's `reason` is `ephemeral_until_first_send`: the editor does not save an empty chat, so
  after a window reload it is gone until a send completes.
- **`configure`**: a model only (never queued past 5 s). Handed out only while the session is idle and has
  no send queued or with the editor; the caller waits for the answer in the same request. `busy`,
  `disconnected`, a rejected model, an unanswered handout and everything else are final; nothing but an
  `applied` report says the model changed, and `effective` is that report's readback.
- **Effort** is refused before anything is stored: tRPC `BAD_REQUEST` with message `effort_not_per_session`
  (create and configure, with or without a model). The editor has no per-session effort; effort is a
  property of the model variant and is read-only in the catalog.
- **`reveal`** is set on a send or configure to a session only from the database (`created_by_os`), only on
  protocol-2 bodies. The person's own chats are never revealed.
- **Ownership.** `syncEditor` locks the computer row `FOR SHARE` and re-reads its owner and `deleted_at`
  INSIDE the transaction, before the lease, the handout and every report: a transfer that commits while a
  sync waits is refused (`unknown_computer`, nothing touched). A transfer also rejects/uncertains the
  previous person's control rows (`computer_reassigned`). The same holds for protocol 1.

### Status table for the MCP (frozen enums only; no new value)

| Editor / OS event | create | configure |
| --- | --- | --- |
| no live lease at the call | `disconnected` / `no_connected_editor` | same |
| editor syncs protocol 1 | `rejected` / `editor_controls_unsupported` | same |
| model not attested / not in the attested list | `rejected` / `catalog_unavailable`, `model_not_offered` | same |
| queued, not yet taken | `accepted` (+ `expiresAt`) | (never visible: waits) |
| queued past its deadline | `expired` / `deadline_passed` | `busy` / `session_running` if the session got work, else `failed` / `deadline_passed` |
| `applied` | `applied` (+ `effective`, reason `ephemeral_until_first_send` or `model_not_applied`) | `applied` (+ `effective`, reason null or `model_not_applied`) |
| `not_delivered` stale_owner / no_owner / disconnected | requeued under a new attempt until it expires | `disconnected` |
| `not_delivered` busy | n/a | `busy` / `session_running` |
| `not_delivered` not_open | n/a | `rejected` / `session_not_open` |
| `rejected` (model_not_offered, unknown_session, ...) | `rejected` / reason | `rejected` / reason |
| `expired` / deadline_passed | `expired` | `failed` / `deadline_passed` |
| `failed` / not_opened | `failed` / `not_opened` | `failed` / reason |
| `uncertain`, an owner change, no report in time | `uncertain` / reason (`owner_changed`, `no_report`) | `uncertain` / reason (`no_report_in_time`, `owner_changed`) |
| a configure neither answered nor expired (only if read mid-wait) | n/a | `uncertain` / `in_progress` |

Reads derive the status at read time (a delivered row whose lease lapsed or whose epoch changed reads
`uncertain` before any sync runs; a queued row past its deadline reads `expired`/`failed`).

`computer.start` is unchanged: owner-scoped, idempotent row `starting` before anything runs; routing without
pinning, then the same allowance gate an open applies. A refusal is `refused_allowance` (`billing_<reason>`)
with no pin, boot or meter. Only then: pin, ensure, meter. No plan, size or billing change, no
`last_opened_at`, no reverse-move trigger, no URL. A throw during the boot leaves the row `starting` and a
retry shows it. A delegated call has no cookie session, so no AI credential is pushed.

## Not proven here

Nothing has run against OS staging, a real Worker, a real AWS fleet or a Postgres carrying production's schema
metadata. The editor side is exercised against `worker/copilot-chat/chat-bridge.js` with its fake 4.141.0
services (`chain.pg.test.ts`, `availability.pg.test.ts`), and the bridge owner reports its real-workbench runs against a
stand-in OS (those are not OS coverage). The Gateway is a token-bound stand-in (an HTTP server; no model is called); the
extension's real config parser and Gateway read run against it, and nothing injects `availability` into a sync body.
`control.pg.test.ts` does script sync bodies that carry `availability`: that tests OS's own attestation of a body, not the editor.

## Tests

`app/src/server/agent-session/control.pg.test.ts` and `chain.pg.test.ts` (real Postgres, real delegated and editor routes, the real editor client and workbench bridge over a fake chat service; run the Postgres
suites with `--no-file-parallelism`: `delegation.pg.test.ts` renames a shared table and races the others),
`app/src/server/api/delegation-auth.test.ts` (the allowlist), `migrations.pg.test.ts` (0024 through both
migration runners), `sdk/src/surface.test.ts` (drift guard).
