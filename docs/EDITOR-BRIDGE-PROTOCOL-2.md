# Editor bridge protocol 2: create, model, catalog (PROPOSAL for the OS controls owner)

Status: **proposal**. The editor side is implemented and observed in a running code-server 4.141.0 workbench (see
"Evidence"). The OS side is not: OS still speaks protocol 1 (`app/src/server/agent-session/sync-route.ts`), and until
OS answers a sync with `protocol: 2` the editor sends exactly protocol 1. Nothing here changes the frozen delegation
API v3.0 (EZiL MCP `CONTRACT.md`): no new enum value reaches a v3.0 response, and `selectedModelId` keeps its meaning
(the model the pane had selected when the send was made).

Owners: editor side, OS bridge lane (`72417ea1`): `worker/copilot-chat/chat-bridge.js`, `extensions/ezil-models/src/chat-bridge-client.ts`.
OS side, controls owner (`bdab4e34`): `agentSession.models/settings/create/configure` (`docs/MCP-SESSION-CONTROLS.md` on
`os-mcp-control-api-20261107`). MCP lead (`02dc3aa8`) is copied on everything touching the delegation API.

## What the pinned editor can and cannot do (read from the shipped code-server 4.141.0 bundles)

| Control | Supported? | How, and the evidence |
| --- | --- | --- |
| New chat session | **Yes** | `IChatService.startNewLocalSession('panel', …)`, opened with `IChatWidgetService.openSession(resource, ACTIVE_GROUP, { preserveFocus, pinned })` as an editor tab, so the person's panel chat is never replaced. |
| Per-session model | **Yes** | Each chat input has its own selection. `switchModelByIdentifier(id, persist=false, userAction=true)` changes that session only and is not stored as the window default. Every request records its `modelId`. |
| Per-session effort | **No** | For a third-party provider (ezil-models): Copilot Chat 0.69's call into an extension model (`languageModel.sendRequest`) passes no configuration; the workbench's `sendChatRequest` injects only the **global per-model** `getModelConfiguration`; `setModelConfiguration` persists provider-group settings for every session. ezil-models declares no `configurationSchema`; its effort is `thinking.effort` in `/etc/ezil/models.json`, fixed per model and really sent (`anthropic.ts` `output_config.effort`, `openai.ts` `reasoning_effort`). |
| Mode / tool approvals | Not offered | Read back only (`mode` on a send report). No operation sets them. |

So effort is a **property of the model variant**: the catalog reports it read-only (`configuredEffort`), `efforts` is always
empty, and any requested effort is refused (`effort_not_per_session`) before the editor is touched. To offer two efforts,
configure two model variants in `models.json`.

## Negotiation
1. The editor always starts with `protocol: 1`.
2. OS answers with `protocol: 2` only if it implements this document.
3. The next sync, and every one after while OS keeps answering `2`, has `protocol: 2`, provided the window's workbench
   also speaks 2 (`hello`).
4. An OS that answers `1` gets protocol-1 bodies, exactly as at `42096dd4`. This is pinned by `chat-bridge-client.test.ts`
   and by the OS chain test (`chain.pg.test.ts`).

## Sync body additions (`protocol: 2` only)
- `sessions[]` gains two fields:
  - `model`: `string | null`. The identifier selected in that session's own input now. Open sessions only; `null` when closed.
  - `requests`: `number | null`. Its request count, when this window has it loaded.
- `catalog`, sent with `sessions`. It has two shapes:
  - `{ status: "available", models: CatalogModel[], observedAt }`;
  - `{ status: "unavailable", reason, observedAt }`, which has **no `models` field**, never an empty list meaning "cannot tell".
- `CatalogModel` is `{ id, label, engine: "ezil-chat", efforts: [], defaultEffort: null, configuredEffort: string | null }`.
  - `id` is the picker identifier (`ezil/<model id>`). Pass it back unchanged in `create.model` and `configure.model`.
  - `configuredEffort` is the effort ezil-models really sends for that model, read from the request body it builds
    (`client.ts` `sentEffort`): Anthropic `output_config.effort`, or OpenAI `reasoning_effort`. It is `null` for the
    EZiL Gateway, whose body carries no effort whatever `thinking.effort` says. So in the shipped image, where every
    model is a Gateway model, it is always `null`.
- Account scope: `availability` (optional, the one row field OS at `2082eec2` accepts besides the above).
  - The picker offers the configured models plus Gateway catalog rows. A configured row is listed whatever the account,
    so being listed is not entitlement. A model the Gateway marks unavailable for this account is hidden by the
    provider, so it is not listed at all.
  - A row carries `availability: "available"` only on **account evidence**: this computer's own AI token read the
    Gateway's `GET /v1/models` at most 15 s ago (`ACCOUNT_EVIDENCE_MAX_AGE_MS`), and that read says that exact
    upstream alias is `enabled` and `available` (catalog contract `ezil.gateway.models.v1`), with no killswitch or pause.
    This is done by `gateway.ts` `accountAvailableIds`.
  - Never marked:
    - a static, directly configured model (not served by the Gateway);
    - another vendor's row;
    - a legacy catalog row without availability;
    - a denied, disabled, unknown or missing row;
    - a failed or unreachable read;
    - evidence older than 15 s. A failed re-read is no evidence; it never falls back to the older catalog.
  - **Freshness: two separate policies, no hard end-to-end bound.**
    - Editor: a row is marked only if its Gateway read BEGAN at most 15 s before the editor emits the catalog. The clock
      is re-read at each cache-or-read decision and at emission (`accountAvailableIds`); evidence that aged out while
      another provider was slow is read again, and anything older at emission is dropped.
    - OS: a received catalog is fresh for 45 s (`CATALOG_FRESH_MS`) from OS's own receipt time, which becomes
      `observedAt` (the MCP accepts it for 60 s).
    - Transport from emission to receipt is counted by neither, so "15 + 45 = 60 s" is NOT a guarantee. A hard bound
      would need the editor to send the evidence's age (or its read time) and OS to enforce it.
  - There is one read per token per catalog build. The request is never echoed, and no admin registry or static list
    is consulted.
  - OS (`control-store.ts` `attest`) lists only the marked rows, with `accountScoped: true`: an authenticated report from
    the current computer's editor, not an independent attestation by the Gateway or OS. The Gateway's own authorization
    at request time remains the execution authority. With no marked row OS answers `unavailable`.
- `observedAt` is the editor's clock in ms. OS should stamp its own reading time when it serves `models` or `settings`
  (MCP freshness rule, 60 s).

## Deliveries (`protocol: 2` only)
| `kind` | Fields | Editor action |
| --- | --- | --- |
| `create` | `operationId, attemptId, deliverWithinMs, model?, effort?` | New empty session, opened as a tab, `model` selected in it. |
| `configure` | `operationId, attemptId, deliverWithinMs, sessionResource, model?, effort?, reveal?` | One **open, idle** session's model. Never queued at the editor. |
| `send` (existing) | `…, reveal?` | `reveal: true` only for a session OS created: see below. |

`reveal` (a **contract term, trusted by the editor and not enforced by it**):
- 4.141.0 has one chat editor pane per group, so a second created chat hides the first, and a reload forgets which
  chats this bridge made.
- OS sets `reveal: true` on a send or configure to a session **it created**, and **only** those. The editor then shows
  that chat's tab again (no focus) before acting.
- The editor cannot tell an OS-created chat from the person's own after a reload. If OS set `reveal` on the person's
  chat, the editor would open it. Keeping the person's chats closed to the bridge (`not_open` unless they have them
  open) is therefore **OS's obligation**.
- Side effect: showing a tab in the active editor group changes which editor the person sees there (focus stays where it
  was). Because there is one chat pane per group, it also hides the person's own chat if they had that chat open as an
  editor tab in that group rather than in the panel. That chat is then `not_open` until they show it again.

Lifetime: an empty chat (no request yet) is not saved by the editor. After a window reload it is gone, and a send to it
is `rejected` / `unknown_session`. OS should show a created session as ephemeral until its first send completes.

The rules for create and configure:
- `effort` present: `rejected`, `effort_not_per_session`. Nothing is touched.
- `configure` without `model`: `rejected`, `nothing_to_change`.
- The same fence, command ids and deadline as a send apply:
  - the owner epoch is checked before and after every await;
  - an `operationId` handed out again returns the first outcome (`duplicate`) and never creates or changes twice;
  - other input under the same id is `command_conflict`.
- Under protocol 1 the editor answers `create` and `configure` with `rejected` / `unsupported_kind`, without touching the
  workbench.

## Reports
| Report | Meaning |
| --- | --- |
| `applied` + `sessionResource`, `model`, `requestCount`, `observedAt`, optional `reason: "model_not_applied"` | Done. `model` is the runtime readback after the change, never the request. `create`: `requestCount` is 0 (a fresh session). A readback different from the request is still `applied`, with the reason; the MCP then shows `matchesRequested: false`. |
| `not_delivered` + `busy` / `not_open` / `stale_owner` / `no_owner` / `disconnected` | Definitely nothing changed. For `configure`, OS answers **busy** (or disconnected) and never queues it. |
| `rejected` + `model_not_offered` / `effort_not_per_session` / `nothing_to_change` / `unknown_session` / `unsupported_session` / `bad_request` / `command_conflict` / `unsupported_kind` | Definitely nothing changed. OS maps these to a definite tRPC **BAD_REQUEST** where the MCP must see a no-write (MCP lead, 2026-11-08). |
| `expired` + `deadline_passed` | Past its deadline at the last check. Nothing changed. |
| `failed` + `not_opened` | The session was started, but it could not be opened and is gone. |
| `uncertain` + `create_outcome_unknown` / `configure_outcome_unknown` / `bridge_call_failed` / `bad_response` | Unknown. Never handed out again. |

## What OS (controls owner) needs to add, smallest first
1. `sync-route.ts`:
   - accept `protocol: 1 | 2`;
   - for 2, accept the session fields and `catalog` above, still `.strict()`;
   - answer `protocol: 2`.
2. Store the latest catalog and per-session `model` per computer, with OS's reading time. Serve:
   - `agentSession.models`: `available` only while the editor lease is live and the catalog is fresh. Otherwise
     `unavailable` with a reason;
   - `agentSession.settings`: `{ model, effort: <configuredEffort of that model>, effortSupported: false, observedAt, source: "runtime" }`.
3. `create`:
   - a queued operation with `expiresAt`, handed out as a `create` delivery;
   - `applied` from the report, with `effective = { model, effort: configuredEffort, observedAt, source: "runtime" }`.
     The new `sessionId` is the `sessionResource` row OS creates on that report.
4. `configure`:
   - handed out only while the session is idle and the lease is live;
   - a bounded synchronous wait (the editor answers in the same round, so one or two sync periods);
   - `not_delivered/busy` becomes `busy`; no report in time becomes `uncertain`.
5. Reject `effort` before anything is queued. It is a definite BAD_REQUEST, with the reason `effort_not_per_session`.
6. Set `reveal: true` on sends and configures to sessions OS created (and only those: the editor trusts it).

## Evidence
- `worker/copilot-chat/chat-bridge.test.cjs` (fakes of the 4.141.0 services) covers:
  - models, create, setModel;
  - duplicate and conflict handling;
  - stale, expired and not-offered refusals;
  - uncertain after start;
  - readback mismatch;
  - two sessions isolated.
- `extensions/ezil-models/tests/chat-bridge-client.test.ts` covers:
  - negotiation;
  - protocol-1 bodies unchanged;
  - catalog shape;
  - create/configure reports;
  - effort refusal.
- `app/src/server/agent-session/chain.pg.test.ts` checks the real OS routes and client against this workbench bridge,
  with protocol 1 unchanged.
- The real workbench: `EZIL_E2E_SUITE=controls e2e/chat-bridge-workbench.sh` (`e2e/chat-bridge-controls.mjs`). Results
  are under "Real-workbench observation" below.

## Real-workbench observation (2026-11-08)

- **Setup:**
  - `EZIL_E2E_SUITE=controls e2e/chat-bridge-workbench.sh` on the existing local image `ezil-os-desktop:union33-f2b576fe`;
  - an `--internal` Docker network, with nothing published and no paid model;
  - overlaid: the patched `workbench.js` (sha256 `0e999287787f3b584df138339e10d61ba27ad989ffc55d4ca0256f7c7f916210`, byte-equal
    to `patch-copilot-chat.sh` at this head on the pristine 4.141.0 bundle), and ezil-models built with Bun 1.3.14 from
    this head (the same code as the committed VSIX; only bundler path comments differ);
  - the suite's own models file, `e2e/copilot-ezil-models-controls.json`, is the image e2e's two Gateway models plus
    two effort probes that are never sent: a direct Anthropic model with effort `high`, and a Gateway model with
    effort `max`;
  - OS is the protocol-2 **stand-in** `e2e/chat-bridge-controls-standin.mjs`, not OS. It mirrors `store.ts` ownership:
    a 30 s lease, takeover only after the lease lapses, a new epoch, and held work `uncertain` (`owner_changed`).
  - Which model ran is judged from the model requests the stand-in forwarded, not from the editor's readback.
- **Result: 19/19 checks pass** (run 4, `e2e-controls4`).
  1. Protocol 2 is used only after OS offers it (the first sync is protocol 1).
  2. The catalog is the picker's four configured models, all with `efforts: []`.
     - `configuredEffort` is `high` for the direct Anthropic probe.
     - It is `null` for the Gateway probe configured `max` (the Gateway sends no effort) and for the two plain models.
  3. `create` makes two NEW sessions: resources not listed before, 0 requests, requested model read back.
  4. A create handed out twice (lost report) makes one session and reports the same resource twice.
  5. One chat editor pane per group: the second created chat hides the first, and the first is listed as not open.
  6. A create with an effort is `rejected` / `effort_not_per_session`, and nothing is created.
  7. Cold agent: the first send into a created session is held (`agent_not_ready`), never sent, until the person has used
     chat once.
  8. That send then runs in session A (shown again) on **Kimi**, as seen upstream.
  9. The person's panel chat stays on **Qwen** upstream.
  10. Session B's send runs on Qwen only.
  11. A send handed out twice reaches the model once.
  12. Configure while B runs is `busy`, never queued, and the model is unchanged.
  13. Configure on idle B is `applied`, read back as Kimi.
  14. B's next request goes upstream to Kimi, while a send into the person's chat goes to Qwen.
  15. **Boundary:**
      - with a bridged request streaming, the browser tab closed;
      - the model request's caller left 0.45 s later, after 1059 bytes, and the answer never finished (run 3: 0.36 s);
      - the old window never synced again.
  16. A new window took over only after the lease, at epoch 2. The abandoned request is `uncertain` / `owner_changed`.
  17. The new window lists every session that had a request (both created ones and the person's).
  18. Copilot's saved transcript holds the abandoned instruction without a completed answer.
  19. After the reconnect, a new instruction into created session A (`reveal`) ran on Kimi, reported `running` then
      `completed` by the new owner.
- **Extra observation (same container, a fresh browser profile).** A brand-new browser profile, as if from another device,
  **lists** both created sessions and the person's chat, so the session list is kept with the computer. Where the
  session content is stored was not determined:
  - no `chatSessions` files were found on disk (only Copilot's own transcript log);
  - no session was loaded or sent to from the fresh profile.

  The two-window proposal below depends on this open question.
- **Working folder.** Every bridged send, into created sessions and the person's chat alike, ran in `agent` mode with
  that session's tools on the one opened folder, `/home/neko/project`. Nested folders were not exercised, and no
  folder-resolution code was touched by this change.
- **Earlier runs, kept as evidence:**
  - Run 1 found two defects:
    - a created chat hidden by a later one could not be sent to (`not_open`): fixed by showing it again;
    - after a reload, an empty created chat is gone (`unknown_session`), and the window had forgotten which chats OS
      created: fixed by OS's `reveal`.
  - Run 2 found a test-double artefact. The offline mock answers from the newest marked prompt in the history, so a later
    plain prompt repeats an earlier scenario's text. The check now judges the model upstream.
  - Run 3 passed 19/19 with the two-model catalog.
  - Run 4 added the effort probes, after it turned out that the Gateway never sends `thinking.effort`.

## Account availability: observed end to end (2026-11-08)

- **Real OS** (`e2e/os-protocol2/availability.pg.test.ts`, run on `2082eec2` merged with this branch through `ea183687`;
  167/167 with the agent-session and delegation Postgres suites).
  - The chain:
    - the real ezil-models config parser and Gateway read with the real fetch, against a **token-bound Gateway
      stand-in** (an HTTP server; each AI token gets its own `/v1/models`);
    - the real editor client and workbench bridge (fake 4.141.0 chat services);
    - the real Worker forwarder and OS sync route;
    - OS attestation;
    - the delegated `agentSession.models/create/configure` that the EZiL MCP makes (signed assertions, real tRPC route).
  - Nothing injects availability.
  - **Two people, two computers, two tokens:**
    - Alice's token allows Qwen (Kimi is denied): she gets `[ezil/qwen]`.
    - Bob's token allows Kimi (no Qwen row): he gets `[ezil/kimi-k2]`.
    - The static direct model is never attested.
    - Creates and configures apply only to an attested model; the other account's model, a denied one and the static
      one are `rejected` / `model_not_offered`; each account's chat keeps its own model.
    - Another person's computer is NOT_FOUND.
  - **Stale (older than the window, then failing), unreachable, rows missing, legacy, all denied, killswitch:** in each case
    the editor marks nothing, OS answers `unavailable` without `accountScoped`, and a model choice is refused. Fresh
    evidence restores it.
  - Planted bugs are caught: a stale-cache fallback fails the stale case, and marking static models fails both tests.
- **Real workbench** (code-server 4.141.0 + Copilot Chat, offline, protocol-2 stand-in OS that also serves `/ai/v1/models`
  for this computer's AI token only):
  - Account A allows both models (full suite, 20/20). Qwen, Kimi and the Gateway effort probe (alias Qwen) are
    `available`; the static direct probe is never marked.
  - Account B allows Kimi only (3/3):
    - only Kimi is marked; Qwen and its probe are not even offered by the picker, because the provider hides
      Gateway-denied models;
    - then the Gateway fails: marks continue only within 15 s of the last good read (at most 9.0 s after the
      failure), and the first catalog with no marks comes 14.0 s after it. An earlier run with a 60 s window
      showed 53.4 s and 58.4 s.
  - Every Gateway read used this computer's AI token.
- **Stand-ins, not staging:** the Gateway, the model service and (in the workbench) OS. No paid model call was made.

### Merge steps for the OS owner (`feat/os-mcp-protocol2-integration-20261108`)

1. Merge this branch (`f2fd6f3f` onwards). Your `2082eec2` already has `6e2fa860`. The tested composition merged
   cleanly, with no conflicts.
2. Move `e2e/os-protocol2/availability.pg.test.ts` to `app/src/server/agent-session/`.
3. Retarget two of your `chain.pg.test.ts` cases:
   - "the shipped editor's catalog cannot be attested" now holds only for a client built without `availableIds`,
     which the shipped extension always passes. Rename it, or point it at a token the Gateway denies.
   - The `attest: true` injection is superseded by the real path.
4. In your `docs/MCP-SESSION-CONTROLS.md`, the "Source gap today" paragraph is now outdated.
5. The field was matched to your committed schema (`sync-route.ts` `catalogRow.availability`), not confirmed with you
   directly. Tell us if you meant anything else by it.

## Background execution: the boundary, and the smallest persistent slice (proposal)

**Boundary.** In this build the chat runtime is the person's browser tab. `IChatService`, the session models and the
request loop all live in the workbench renderer. Copilot Chat's agent runs in the remote extension host, but it is driven
from the renderer. Observed in the real workbench (see "Real-workbench observation"):
- A bridged request was streaming. The tab closed, and the model request's caller went away within about half a second.
  The answer was abandoned, not finished in the background.
- The old window never synced again.
- After the 30 s lease, the reopened window became the owner at a new epoch. OS's rule turned the abandoned request into
  `uncertain` (`owner_changed`), never `completed`.
- Copilot's saved transcript keeps the instruction, not a completed answer.

So **nothing runs while no editor window is open**, and the bridge reports exactly that. A queued instruction waits:
- `queued_disconnected` until a window syncs;
- `expired` after its deadline;
- a running one becomes `uncertain`.

**Smallest supported slice that would make it persistent (not implemented here).** Keep one workbench window open
**on the computer itself**, not in the person's browser:
- the desktop image already runs a browser in its own display (neko);
- open `http://127.0.0.1:8443/?folder=<workspace>` there in kiosk mode, as the bridge owner.

That window holds the lease, so instructions run in real EZiL Chat sessions while the person's tab is closed, for as long
as the computer runs. That is the same runtime, models, tools and approvals; no second agent and no shell.

Open questions before building it:
1. **Two windows on one folder.** Chat sessions are saved per workspace, but a live session is owned by one window. The
   person's window must see the bridge window's sessions (at least after completion), and must never act on a session the
   other window is running. This needs a real test of session sharing between two windows.
2. **Tool confirmations.** A request in an unattended window that needs a confirmation would wait with nobody to answer
   it. Report it as `needsInput` (already read). Never auto-approve. The person approves when they open the session.
3. **Cost and lifetime.** A computer keeps running (and spending allowance) only as the person's plan allows. A stopped
   computer runs nothing, and the bridge says `disconnected`.
4. Upstream's own background path (the 4.141.0 "agent host", a separate server-side agent process) needs Copilot's own
   models and sign-in, and refuses direct chat requests for agent-host models. It is not usable with EZiL's provider today.
