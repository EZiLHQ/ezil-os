# Native runtime control v1 (shared contract)

Status: v1 source contract r2, 2026-11-16, awaiting Root source review. Source-only. Nothing here is deployed,
enabled or applied. Nothing here claims a running native Claude process, a qualified host channel or a Core
control ABI. The machine-readable twin is `app/src/server/native-session/runtime-contract.ts`; if the two differ,
the code is wrong and this document wins until Root decides otherwise.

r2 applies `work/runtime-contract-review-r1.md` (sha256 `6c3c0c37…e730748`) over r1 (`8de5b875…`): a reusable
per-runtime control lease replaces per-request consent; replay precedes availability; request reads use the
original stored namespace; the Core prompt digest is passed through as produced; one 131072-byte bound for every
native hop; a distinct native AI authority binding. It also applies `work/runtime-contract-review-r2.md` (sha256
`30e54d25…858a2f64`): producer prompt lineage fences, the single-representation MCP result envelope, the actual
`0031` identification/authority/revocation split, and observation-only reads without an active AI grant. And
`work/runtime-contract-review-r3.md` (sha256 `6a3048cf…184644c4ae`): the Root-approved typed initial-task variant
of `get_native_operation`, and send/answer capped at the original AI consent horizon. And
`work/runtime-contract-review-r4.md` (sha256 `a85bc2f1…4ec85e`): a Core cancel may report
`tombstone_before_dispatch` (cancel only, `cancelled`/`completed`, never a native stop); an initial task may carry
its persisted runtime UUID while `starting`/`unknown`/`failed`, and needs one for `accepted`/`completed`; the event
bound is on the whole serialized event; reply objects are matched by exact key set; cancel tombstones re-validate
lease, deadlines, owner and placement inside their transaction, under ascending request locks; a cancel whose
target is the session's own initial task is always a dispatched target.

Counterparts: MCP (six tools, this wire), OS (this lane: REST receivers, consent, `0032`), host (`native-runtime`
typed RPC), Core (`gatewayNative*` next ABI). Inputs: Root seam decisions, the coordinator's "runtime-control
counterpart ABI snapshot" on the task page, and MCP `docs/NATIVE-MCP-PROTOCOL-v1.md` (sha256 `c6f70d8d…feebd6b8138`
as read here) for the v1 wire this extends.

The four v1 tools (`create_native_session`, `renew_native_session`, `get_native_authorization`,
`get_native_session`), their scopes, routes, DTOs and the cbde broker are unchanged. A broker `delivered` state means
only that the host acknowledged grant delivery: not runtime readiness, not work completion. Readiness and
completion are observable only through the reads below.

## 1. Gates and inventory

- MCP: `NATIVE_RUNTIME_TOOLS` exactly `"enabled"` adds exactly six tools, only while `NATIVE_SESSION_TOOLS` is also
  exactly `"enabled"`. Otherwise none of the six. The runtime gate never opens the v1 four.
- OS: `EZIL_NATIVE_RUNTIME_CONTROL=1` opens the new receivers and consent surfaces, only while the existing
  native-session gate `EZIL_NATIVE_SESSIONS=1` (`nativeSessionsEnabled` in `native-session/http.ts`) is open. The
  canonical origin is the existing `EZIL_NATIVE_SESSIONS_ORIGIN`. Closed: every new route answers `404 not_found`
  before any verification, database or network step. The receivers also need the existing pinned delegation
  configuration (`delegationConfig`); missing → `503`, never a cookie fallback.

| Tool | Authority | Scope |
| --- | --- | --- |
| `read_native_session` | read | `ezil:native-runtime:read` |
| `get_native_prompt` | read | `ezil:native-runtime:read` |
| `get_native_operation` | read | `ezil:native-runtime:read` |
| `send_native_instruction` | control | `ezil:native-runtime:control` |
| `answer_native_prompt` | control | `ezil:native-runtime:control` |
| `cancel_native_operation` | control | `ezil:native-runtime:control` |

## 2. Scopes and consent

| Scope | Consent wording |
| --- | --- |
| `ezil:native-runtime:read` | See the live state, progress, pending prompts and request receipts of native Claude sessions you started on your EZiL computers |
| `ezil:native-runtime:control` | Ask to send instructions to, answer prompts of, or cancel work in native Claude sessions on your EZiL computers. You approve control of each session in EZiL in your browser first |

- Delegation scopes only (existing delegation client allow-list); advertised, requested and granted only while both
  MCP gates are open; not in `requiredScopes`; a runtime scope forces the explicit EZiL consent page; first use asks
  for exactly the tool's scope via the existing `insufficient_scope` relink.
- Never inherited or implied: `ezil:native-sessions:*` grant neither runtime scope, a runtime scope grants no v1
  scope, control does not imply read. Existing grants gain nothing.
- OAuth scope is necessary, never sufficient: control also needs an approved control lease (§7). Neither the scope
  nor the lease extends the native AI authorization, its budget, model or compute lease.

## 3. Public tool inputs (closed)

Strict objects; unknown key, missing required key or wrong type is refused before signing or any network call.
Ids are lowercase UUIDs `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`; uppercase is refused.

| Tool | Input (exact) |
| --- | --- |
| `read_native_session` | `{sessionId, cursor?, limit?}` |
| `get_native_prompt` | `{sessionId, promptId}` |
| `get_native_operation` | `{sessionId, requestId}` |
| `send_native_instruction` | `{requestId, sessionId, instruction}` |
| `answer_native_prompt` | `{requestId, sessionId, promptId, revision, promptInputDigest, decision, message?}` |
| `cancel_native_operation` | `{requestId, sessionId, targetRequestId}` |

- No caller principal, authorization id, `controlAuthorizationId`, AI authorization id, runtime id, host epoch,
  placement, command, URL, model, root, cwd, profile, route or procedure field exists. Every actor and authority
  value is server-derived; opaque ids are lookup keys, never authority.
- `requestId`: the caller's stable client request UUID, distinct from any Core `operationId`, native message id or
  prompt id. Unique per OS owner across all clients, sessions and runtime epochs. Identical input → the original
  receipt; any other input → conflict forever. After an unknown result, reconcile with
  `get_native_operation(sessionId, requestId)`; never mint a new `requestId` for the same intent.
- `cursor`: `null`/absent, or the exact `nextCursor` of a previous read:
  `^<runtimeId uuid>\.(0|[1-9][0-9]{0,18})$` (`<runtimeId>.<last seq returned>`). A position, not authority.
- `limit`: integer 1–100, default 50 (MCP fills it; the wire always carries it).
- `instruction`: the v1 instruction rules exactly (well-formed Unicode, not empty or `\s`-only, no U+0000, byte-exact,
  at most **16384** UTF-8 bytes). Never in a URL, result, error or log.
- `revision`: integer 1–2147483647, as shown by `get_native_prompt`.
- `promptInputDigest`: `^[0-9a-f]{64}$`, exactly the Core producer digest shown by `get_native_prompt` (§5). Bare
  lowercase hex, no prefix. Neither MCP nor the OS rehashes, normalizes or prefixes it.
- `decision`: `"allow"` | `"deny"`. Only SDK permission prompts; questions and plans are unsupported. `allow` means
  the original complete SDK input; there is no edited input. `message`: only with `deny`, optional, well-formed, no
  U+0000, 1–2048 UTF-8 bytes.
- `targetRequestId`: the stable client `requestId` of the request to cancel (never a Core operation id); may be
  unseen (§8); must differ from `requestId`.

Four digests, never interchanged:

| Name | Form | Over |
| --- | --- | --- |
| `instructionDigest` | `sha256:` + hex | exact UTF-8 instruction bytes |
| `requestDigest` | `sha256:` + hex | OS canonical request semantics (§6) |
| `promptInputDigest` | bare 64 hex | Core producer `fingerprint(input ?? null)`: recursive sorted-key `JSON.stringify` |
| delegation `inp` | base64url | full `EZIL-NATIVE-REST/1` transcript (§4) |

## 4. Wire: closed route map

| Tool | Method | Exact pathname | `proc` | `scope` |
| --- | --- | --- | --- | --- |
| `read_native_session` | `POST` | `/api/mcp/native-sessions/<sessionId>/runtime/read` | `nativeRuntime.read` | `ezil:native-runtime:read` |
| `get_native_prompt` | `GET` | `/api/mcp/native-sessions/<sessionId>/runtime/prompts/<promptId>` | `nativeRuntime.promptGet` | `ezil:native-runtime:read` |
| `get_native_operation` | `GET` | `/api/mcp/native-sessions/<sessionId>/runtime/requests/<requestId>` | `nativeRuntime.requestGet` | `ezil:native-runtime:read` |
| `send_native_instruction` | `POST` | `/api/mcp/native-sessions/<sessionId>/runtime/send` | `nativeRuntime.send` | `ezil:native-runtime:control` |
| `answer_native_prompt` | `POST` | `/api/mcp/native-sessions/<sessionId>/runtime/answer` | `nativeRuntime.answer` | `ezil:native-runtime:control` |
| `cancel_native_operation` | `POST` | `/api/mcp/native-sessions/<sessionId>/runtime/cancel` | `nativeRuntime.cancel` | `ezil:native-runtime:control` |

- New child routes of the v1 `/api/mcp/native-sessions/<sessionId>` resource; v1 routes untouched. One route, one
  method, one `proc`, one scope: the receiver policy is a source constant.
- No query string, fragment, percent-encoding, trailing slash or alternate case. No unsigned selector: cursor and
  limit live in the signed POST body; GET selectors in the signed pathname.
- Headers/timeout/attempts as v1: `Authorization: EZiL-Delegation <jwt>`, `Accept`, POST
  `Content-Type: application/json`; `redirect: "manual"`; 10 s; one attempt, no retry.

### POST bodies (exact key order, one `JSON.stringify`, at most 65536 UTF-8 bytes)

```json
{"kind":"read","sessionId":"…","cursor":null,"limit":50}
{"kind":"send","requestId":"…","sessionId":"…","instructionRevision":1,"instructionDigest":"sha256:…","instruction":"…"}
{"kind":"answer","requestId":"…","sessionId":"…","promptId":"…","revision":1,"promptInputDigest":"…64hex…","decision":"deny","message":null}
{"kind":"cancel","requestId":"…","sessionId":"…","targetRequestId":"…"}
```

- Body `sessionId` equals the path `sessionId`; `cursor` and `message` are always present (`null` when absent). The
  receiver requires `JSON.stringify(JSON.parse(raw)) === raw` with exactly these keys in this order (so duplicate
  keys, reordering, whitespace and alternate escapes are refused) and never reserializes for a digest.

### Delegation binding

Unchanged ES256 `ezil-delegation+jwt` claim set; `inp = base64url(SHA-256(UTF-8(transcript)))`,
`transcript = "EZIL-NATIVE-REST/1" LF METHOD LF PATHNAME LF BODY` (BODY empty for GET; a GET transcript still ends
with the third LF), built from the request actually received and passed as `serializedInput` to
`delegation-core.verifyDelegation` with this document's fixed policy. A rejected delegation never falls back to a
cookie.

## 5. Public response DTOs

Timestamps are `Date.toISOString()` UTC; ids lowercase UUIDs. No private scope, placement, fence, host epoch, policy
digest, Core operation id, controller id, AI or control authorization id, credential, raw instruction or request
body appears. Every OS response DTO is at most **126976** serialized UTF-8 bytes, leaving 4096 bytes so that the
complete MCP result envelope (§5a) stays at most 131072 bytes.

```ts
type RuntimeState = 'starting' | 'ready' | 'busy' | 'needs_input' | 'stopping' | 'stopped' | 'exited' | 'failed' | 'unknown';

interface RuntimeView {
  runtimeId: string;              // public lowercase UUID generated once per runtime by host/Core
  state: RuntimeState;
  startedAt: string | null;
  lastProgressAt: string | null;
  activeRequestId: string | null; // client requestId of the send being worked, when Core reports one
}

type RuntimeEventType = 'runtime.state' | 'turn.started' | 'assistant.text' | 'tool.started' | 'tool.result'
  | 'prompt.opened' | 'prompt.closed' | 'prompt.unsupported' | 'request.recorded' | 'request.settled' | 'turn.completed';

interface RuntimeEvent {          // one original, whole event; never clipped
  seq: string;                    // canonical decimal, strictly increasing within one runtime
  at: string;
  type: RuntimeEventType;
  requestId: string | null;       // correlated client requestId
  promptId: string | null;
  toolUseId: string | null;       // ^[A-Za-z0-9_-]{1,128}$
  toolName: string | null;        // ^[A-Za-z][A-Za-z0-9_]{0,63}$
  outcome: 'success' | 'error' | 'interrupted' | 'refused' | null;  // tool.result, turn.completed, request.settled
  runtimeState: RuntimeState | null;                                 // runtime.state only
  payloadStatus: 'complete' | 'oversize' | 'unsupported';
  text: string | null;            // complete only; at most 65536 UTF-8 bytes; null when oversize/unsupported
}

interface PromptContext {         // producer lineage fences, passed through exactly; never synthesized by OS or MCP
  instructionRequestId: string;   // client requestId of the admitted instruction whose turn raised the prompt
  instructionRevision: number;    // Core monotonic admission revision (a new admitted instruction advances it;
                                  // a duplicate of the same request never does)
  expiresAt: string;              // fixed horizon of the admitted turn/authority
}

interface PromptSummary {
  promptId: string; revision: number; toolName: string; toolUseId: string;
  promptInputDigest: string;      // bare 64 hex producer digest
  inputBytes: number;             // UTF-8 bytes of JSON.stringify(input)
  openedAt: string;
  context: PromptContext;
  answerable: boolean;
}

interface NativeRuntimeRead {     // read_native_session
  statusKind: 'runtime_read';
  sessionId: string;
  availability: 'available' | 'blocked';
  reason: RuntimeReason | null;   // non-null exactly when blocked
  runtime: RuntimeView | null;
  events: RuntimeEvent[];         // whole events after the cursor, oldest first, no gaps, at most `limit`
  nextCursor: string | null;      // "<runtimeId>.<seq of last event returned>"; null when none returned
  hasMore: boolean;               // more events exist after nextCursor (also when the byte bound stopped the page)
  cursorReset: boolean;           // the cursor named another runtime; events restart at this runtime's first event
  pendingPrompts: PromptSummary[];
  pendingPromptsComplete: boolean;// false when more open prompts exist than fit (at most 32 are listed)
}

interface NativePrompt {          // get_native_prompt
  statusKind: 'runtime_prompt';
  sessionId: string; runtimeId: string; promptId: string; revision: number;
  nativeRequestId: string;        // SDK control request id, ^[A-Za-z0-9_-]{1,128}$
  toolUseId: string; toolName: string;
  promptKind: 'permission' | 'question' | 'plan' | 'other';
  state: 'open' | 'decided' | 'closed' | 'expired';
  inputStatus: 'complete' | 'oversize' | 'redacted' | 'unavailable';
  input: object | null;           // the producer's original SDK input OBJECT (not a JSON string); complete only
  promptInputDigest: string;      // bare 64 hex, exactly as produced
  inputBytes: number;             // UTF-8 bytes of JSON.stringify(input), at most 65536 when complete
  context: PromptContext;
  answerable: boolean;            // permission + supported tool + complete input + open + context current and
                                  // unexpired + runtime current + active AI authority; else false
  rootRequestIds: string[];       // client requestIds that touched it (raising send, answers), at most 16
}

type ControlKind = 'send' | 'answer' | 'cancel';
type AuthorizationState = 'required' | 'approved' | 'denied' | 'expired' | 'blocked';

type ControlState =
  | 'authorization_required' | 'authorization_denied' | 'authorization_expired' | 'blocked'
  | 'approved' | 'dispatching' | 'host_refused' | 'dispatch_unknown'
  | 'recorded' | 'delivering' | 'accepted' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  | 'cancelled_before_dispatch';

type ControlEffect =
  | 'none'                        // nothing reached the host
  | 'tombstone_before_dispatch'   // cancelled before any dispatch: permanent OS tombstone, nothing native ran
  | 'recorded'                    // Core durably journaled it; nothing native observed
  | 'written_unacknowledged'      // written to the SDK; no correlated native receipt yet
  | 'native_observed'             // exact correlated SDK receipt observed
  | 'unknown';                    // the outcome of a transport step is not known

interface NativeControlReceipt {  // send/answer/cancel responses and get_native_operation
  statusKind: 'runtime_request';
  requestId: string; kind: ControlKind; sessionId: string;
  requestDigest: string;
  instructionDigest: string | null;                                   // send
  promptId: string | null; revision: number | null; decision: 'allow' | 'deny' | null;   // answer
  targetRequestId: string | null;                                     // cancel
  runtimeId: string | null;       // the runtime bound at admission (null: tombstone-only cancel without a runtime)
  authorization: { state: AuthorizationState; expiresAt: string; authorizationUrl: string | null; reason: RuntimeReason | null };
  state: ControlState;
  effect: ControlEffect;
  reason: RuntimeReason | null;
  settled: boolean;
  createdAt: string; updatedAt: string;
}
```

```ts
type InitialTaskState = 'starting' | 'recorded' | 'delivering' | 'accepted' | 'completed' | 'failed' | 'blocked'
  | 'cancelling' | 'cancelled' | 'unknown';

interface NativeInitialTaskReceipt {   // get_native_operation for the session's initial task; not a control receipt
  statusKind: 'runtime_initial_request';
  kind: 'initial_task';
  requestId: string;              // the original 0029 create operationId (= NativeHostDelivery.operationId)
  sessionId: string; computerId: string;
  instructionDigest: string;      // stored on the 0029 create
  runtimeId: string | null;       // only an actual producer-observed runtime; never synthesized
  observation: 'observed' | 'unavailable';
  state: InitialTaskState;        // 'unknown' whenever unobserved
  effect: 'none' | 'recorded' | 'written_unacknowledged' | 'native_observed' | 'unknown';
  reason: RuntimeReason | null;   // non-null when unavailable
  settled: boolean;               // completed | failed | blocked | cancelled
  createdAt: string; updatedAt: string;
}

type NativeOperationResult = NativeControlReceipt | NativeInitialTaskReceipt;   // get_native_operation
```

- `get_native_operation` resolves, in order: the `0032` row for `(owner, requestId)` (a control receipt); else the
  caller's `0029` create whose `operationId = requestId` in the same session (the initial task); else `404`. A
  control `requestId` equal to any of the owner's `0029` operation ids is refused at admission (`409`), so the two
  never alias. The initial variant has no authorization object and no control id or approval of any kind.
- Initial resolution uses the original namespace only: owner, `0031` history binding's original OAuth client (must
  equal the caller's; otherwise `404`), session, initial request id and the create's stored full placement. The
  computer must be a live computer of the caller now (`404` otherwise). An initial create that ended
  `delivery_unknown`/`exchange_unknown` is still observed; no delivered ACK is required to inspect it.
- The host `request_get` (rootRequestId = the initial request id, runtime pair null; the host resolves its persisted
  create mapping — Core UUID, host epoch stored at admission, original client) is asked only while the stored
  placement equals the live placement. Otherwise, or when the host cannot be observed, the receipt is
  `observation: "unavailable"`, `state: "unknown"`, `effect: "unknown"`, `runtimeId: null`, with the reason
  (`placement_changed`, `host_unavailable`, `core_unsupported`, `session_binding_unavailable` for an old cookie
  create without `0031`). That is never `404`, never "no dispatch", never a synthetic runtime. Before the host has
  adopted a Core UUID the producer answers `starting` with `runtimeId` null; `accepted` needs the exact first-user
  echo and persistence.
- Nothing here claims, mints, wakes, resends, replays or writes.

- `authorizationUrl` is non-null exactly while `authorization.state` is `required`, and is exactly
  `osOrigin + "/native/runtime-authorize/" + requestId` (no credentials, query or fragment).
  `authorization.expiresAt` is the lease's consent expiry while `required`, else the lease's control deadline; it
  never outlives the control deadline.
- Terminal: `authorization_denied`, `authorization_expired`, `blocked`, `host_refused`, `completed`, `failed`,
  `cancelled`, `cancelled_before_dispatch`. `dispatch_unknown` and `unknown` are **held, not settled**: the effect is
  not known, nothing is resent or reissued, and only a positive exact Core receipt for the same
  `(namespace, requestId, requestDigest)` read via `request_get` may advance them. They never mean completion.
- `native_observed` needs exact correlated SDK evidence: send — the native user-message UUID echo (`accepted`), then
  the terminal turn receipt (`completed`); answer — the correlated tool result or refusal for the prompt's
  `toolUseId`; cancel — the target's terminal or fence receipt. A recorded decision, a written answer or a cancel
  tombstone is never "applied" or "stopped".

- Prompt lineage: an answer binds the prompt's exact `promptId`, `revision`, `promptInputDigest`, runtime and stored
  `context`. A newly admitted instruction invalidates every earlier pending answer even when the input text and
  revision look identical (`prompt_context_changed`); a passed `context.expiresAt` refuses it even with the same
  digest and revision (`prompt_expired`). Context revision is admission bookkeeping, not native accepted/completed
  evidence. A producer reply without these fields is not a prompt (unavailable), never filled in.

### 5a. MCP result envelope

Each runtime tool result is exactly one full `structuredContent` (the projected DTO, with an `outputSchema`) plus one
fixed short text summary (at most 512 bytes; no DTO JSON in text, no escaped duplicate). The complete serialized MCP
result, wrapper and text included, is at most 131072 bytes. The four v1 tools keep their existing result behavior.

### Size rules (no clipping, no silent drop)

- A page holds whole events, in order, with no gap after the cursor. The OS stops before the first event that would
  push the whole serialized DTO over 126976 bytes and sets `hasMore`; `nextCursor` never passes an omitted event.
- An event whose whole serialized object would exceed 65536 bytes, or is not representable, must be produced at its
  position with `payloadStatus: "oversize" | "unsupported"` and `text: null`; it is never skipped. A producer event
  over the bound that is not marked so fails the whole page (`blocked/host_invalid_reply`), never clipped.
- Host reply objects are matched by exact key set (order-free); only signed public request bodies pin key order.
- More than 32 open prompts, or prompt summaries that do not fit: `pendingPromptsComplete: false`.
- A prompt input over 65536 bytes is `inputStatus: "oversize"`, `input: null`, never answerable with `allow`.

### Reasons (closed)

`RuntimeReason`: `session_not_found`, `session_not_active`, `session_binding_unavailable`, `client_mismatch`,
`ai_authorization_inactive`, `ai_authorization_revoked`, `computer_not_found`, `computer_not_aws`,
`computer_not_running`, `placement_unavailable`, `placement_changed`, `lease_expired`, `computer_busy`,
`placement_invalid`, `runtime_unavailable`, `runtime_changed`, `host_unavailable`, `host_refused`, `host_timeout`,
`host_no_ack`, `host_invalid_reply`,
`core_unsupported`, `control_deadline_passed`, `control_action_not_allowed`, `prompt_not_found`, `prompt_not_open`,
`prompt_revision_changed`, `prompt_context_changed`, `prompt_expired`, `prompt_input_mismatch`,
`prompt_input_incomplete`, `prompt_unsupported`, `target_session_mismatch`, `target_settled`, `request_limit`,
`authorization_unavailable`.
`authorization_unavailable` is the fixed fallback for any unknown internal reason; raw errors are never returned.

## 6. Status codes, outcomes, request digest

- Every valid request answers **200** with its DTO, including blocked, required, denied and settled failures.
- `409 {"error":{"code":"request_conflict",…}}` is the only definite conflict: this owner's `requestId` already names
  a different request (another kind, session, original client or `requestDigest`). Forever; also after the computer
  is deleted or reassigned.
- `404 {"error":{"code":"not_found",…}}`: no such request/prompt visible now (also identical replay after deletion or
  reassignment of the computer, and another owner's request — indistinguishable from absent).
- MCP mapping: control POST — 200 receipt, 409 conflict, anything else **unknown** (receipt tied to the original
  ids; no retry, no new key; reconcile with `get_native_operation`). Reads — 200, 404 none, else unavailable.

`requestDigest = "sha256:" + hex(SHA-256(JSON.stringify(array)))`:

```
["ezil.native-runtime.request.v1","send",sessionId,"1",instructionDigest]
["ezil.native-runtime.request.v1","answer",sessionId,promptId,String(revision),promptInputDigest,decision,messageDigest|""]
["ezil.native-runtime.request.v1","cancel",sessionId,targetRequestId]
```

`messageDigest` is `sha256:` hex of the exact UTF-8 message.

## 7. Authority

Every resolved context, read or control, carries an explicit discriminator `authority: "read" | "control"` and the
native AI binding from `0031`, kept **distinct** from any control lease:
`aiAuthorization = {authorizationId, state: "active" | "inactive" | "revoked", expiresAt, policyDigest}`.

Actual `0031` linkage (auth owner; exports not yet frozen, so the OS consumes them only through the
`NativeAiAuthorityPort` adapter in `runtime-authority.ts` and imports nothing guessed):

- The session's original consent operation id is the `0029` create's `operationId` (the same id in both ledgers,
  stable across renewals). An old cookie create with no `0031` row has no binding and is never upgraded.
- `history(ownerUserId, createOperationId)` → the immutable consent binding snapshot (`terms.authzId` generated once
  at approval, original OAuth client, session, computer, deadline, policy). **Identification, not permission.**
- `active(ownerUserId, createOperationId)` → the live approved binding, or null. Null is "not active": no cause is
  inferred from history.
- `revocation(ownerUserId, authzId)` → positive captured stop metadata means `revoked`; null proves nothing else.
- State: `active` when `active()` returns the same `authzId`; `revoked` on positive revocation; otherwise
  `inactive`. No history → `blocked/session_binding_unavailable`; no port → the same.

The OS never substitutes whatever latest grant exists. Reads need only the history binding (no active AI grant);
send and answer need `active`; cancel and exact receipts use the stored immutable namespace as explicit cleanup
authority with no model admission. An approved control lease never carries send/answer/model/renew authority
through an AI revocation.

### Read authority (observation only)

In order, with no write and no effectful host call:

1. Gates; verified delegation with `ezil:native-runtime:read` for this exact route/body.
2. The caller owns the session's v1 create record (`0029`, whatever its delivery outcome) and its computer is a live
   computer of the caller now; otherwise `404`.
3. AI history binding exists (`blocked/session_binding_unavailable` otherwise) and its original OAuth client equals
   the verified `client_id`; another client's session is `404`, indistinguishable from absent. Any AI state may
   observe; a non-`active` state only makes every prompt `answerable: false`.
4. Current placement (no lock held across the network) → read scope with `runtimeId`/`hostEpoch` null (discover),
   no control fields and `deadline = now + 10 s` (observation only: lease and grant expiry are data, never SDK
   start, admission, wake or renew). Host missing → `blocked/host_unavailable`, never a synthesized "no dispatch".
5. One host RPC: `read` (current runtime) or `prompt_get` (host resolves the prompt's original runtime context and
   must refuse a prompt outside this owner/client/session namespace).

`get_native_operation` is different: it reads the OS request row by `(owner, requestId)` first (exact; no latest-N
view), requires the stored session and original client to equal the caller's, and the stored computer to be a live
computer of the caller now (else `404`). It then asks the host `request_get` **only** with the request's stored
original scope (runtime, host epoch, full placement), only when the row was dispatched, and only while that stored
placement is still the live placement; otherwise it returns the stored receipt alone. An old request is never
reinterpreted under today's runtime.

Reads never create leases, consent, outbox rows or control ids; never dispatch, mint, wake, renew, start or
reconcile; never get model permission. After AI expiry a read observes existing runtime metadata only.

### Control authority (reusable per-runtime lease)

A **control lease** (`controlAuthorizationId`, server-generated, distinct from every AI authorization id) binds
`{ownerUserId, originalOAuthClientId, sessionId, computerId, runtimeId, hostEpoch, full placement {generation,
leaseEpoch, instanceId, fenceToken} as canonical decimal strings, profile, policyDigest, aiAuthorizationId,
allowedActions, controlDeadline}`, immutable once created. `controlDeadline = min(prepare + 15 min, placement lease
end)`; consent expiry `min(prepare + 10 min, controlDeadline)`. `allowedActions` is `["send","answer","cancel"]`, or
`["cancel"]` for a tombstone-only lease without a runtime (§8). Approval never extends AI, compute, model or budget:
each send/answer request's own deadline is `min(controlDeadline, aiAuthorization.expiresAt)` (the original AI consent
horizon and budget binding stay with `0031`), while a cleanup cancel may run on the lease alone after AI expiry or
revocation, with no model admission.

Each control request, in order:

1. Gates; verified delegation with `ezil:native-runtime:control`; strict body; `requestDigest`.
2. **Replay first.** One read of `(owner, requestId)` row and tombstone, before any resolver, transport or host
   step. Existing row: different kind/session/client/digest → `409 request_conflict`; identical → its stored
   receipt, shown only while the stored computer is a live computer of the caller (`404` otherwise). A stored row
   is advanced only by step 6, and only from `approved` with an outbox that was provably never claimed. Any
   `dispatching`/`dispatch_unknown`/`recorded`/later row is receipt-only and is never resent. A tombstone for this
   `requestId` → the request is recorded once as `cancelled_before_dispatch`.
3. Current authority for a new request: session/AI binding/client as read steps 2–3; send and answer also need
   `aiAuthorization.state = "active"` (`ai_authorization_inactive`), cancel does not. A fresh host `read` (an
   observation, not an effect) resolves the live runtime: send/answer need `ready|busy|needs_input`
   (`runtime_unavailable`). Answer additionally does a `prompt_get` and requires same runtime, `open`, `permission`,
   complete input, same `revision` and `promptInputDigest`, and an unexpired producer `context` (`prompt_*`
   reasons); `allow` needs `answerable`. The prompt snapshot (input object, digest, revision, native request id,
   tool-use id, runtime, context) is stored on the request row; dispatch re-reads the prompt and refuses any change
   of context (`prompt_context_changed`), revision or digest, or a passed `context.expiresAt` (`prompt_expired`).
   The host checks the current context and deadline again; nothing is silently rebound to a newer instruction.
4. One short transaction (owner request lock): re-check replay; find a valid approved lease for exactly this scope
   (same runtime, host epoch, placement, action allowed, deadline in the future), else an existing `required` lease
   for it, else insert a new `required` lease. Insert the immutable request row bound to that lease:
   `approved` if the lease is approved, else `authorization_required`. Nothing effectful has happened.
5. Response. Under an approved lease the request proceeds to step 6 in the same call. Under a `required` lease:
   `authorization_required` with `authorizationUrl`; zero effectful host calls.
6. Dispatch, once: re-verify owner, original client, live computer, full placement, runtime/host epoch, AI binding
   (send/answer) and deadline; CAS the outbox `approved → dispatching`; one private RPC under a hard deadline that
   holds even if the adapter ignores its abort signal; record the outcome once (`recorded`/`accepted`/…,
   `host_refused`, or `dispatch_unknown`). A late adapter result after the deadline is dropped and can never
   overwrite `dispatch_unknown`. No auto-reissue, retry or new key.
7. The host independently rechecks authority with the OS fresh reader (§10) before any effect.

Browser approval (§9) approves the lease and the one pending request it shows, by CAS exactly once, then performs
step 6 for that request. Later requests under the approved lease need no further URL but each still gets its own
durable row, digest, original namespace, CAS and stale checks. Another request that was pending under the same lease
when it was approved proceeds only when its exact original body is replayed (step 2 → step 6).

## 8. Cancel

- Cancel is a control request with its own `requestId`, lease coverage and receipt. `targetRequestId` is a client
  `requestId`.
- Target unseen, or known and not yet dispatched (`authorization_required`/`approved` with an unclaimed outbox): no
  runtime and no active AI grant are needed. Under an approved lease (a `["cancel"]` lease may have `runtimeId` null)
  the OS writes the permanent tombstone `(owner, targetRequestId)` pinned to the session, moves a known target to
  `cancelled_before_dispatch`, and reports the cancel `completed` with `effect: tombstone_before_dispatch`. Nothing
  is sent to the host; this is never "native stopped". A later admission of that `requestId` never reaches the host.
- Target dispatched: the cancel is dispatched (`cancel` RPC with `targetRequestId`) under a runtime lease; Core closes
  admission before interrupting and reports `cancelling` until the target's terminal or fence receipt.
- Target is the session's initial task (its `0029` create `operationId`, same session): always a dispatched target;
  the cancel is sent under a runtime lease, never OS-tombstoned; without an observable runtime it is
  `blocked/runtime_unavailable`, never "completed". Any other `0029` operation id → `target_session_mismatch`.
- A dispatched cancel whose target Core never saw may come back from Core as `cancelled`/`completed` with
  `effect: tombstone_before_dispatch` (Core's own durable tombstone); it is never a native stop.
- The OS tombstone transaction takes the request locks in ascending id order, then the computer lock, and
  re-validates the approved lease, both deadlines, current owner and full placement before writing; stale →
  `blocked` with nothing tombstoned.
- Target settled → `blocked/target_settled`; target of another session or client → `blocked/target_session_mismatch`.

## 9. Consent surfaces (normal cookie, OS only)

- Page `GET /native/runtime-authorize/<requestId>` (strict lowercase UUID). Signed-out users use the existing Auth0
  login with a safe return URL restricted to exactly this path. The page reads, never writes.
- `GET /api/shell/native-runtime/authorizations/<requestId>`: owner-only display DTO — the lease (session, computer,
  runtime, allowed actions, control deadline, consent expiry, state) and the pending action: send instruction text;
  answer prompt with the **full** original SDK input object, producer digest, revision, native request id,
  tool-use id, runtime, producer context (`instructionRequestId`, `instructionRevision`, `expiresAt`) and
  answerable/stale status as stored at prepare (never a preview; an incomplete or expired input cannot be approved
  for `allow`); cancel target. `leaseDigest` (`sha256:` hex) covers lease and action.
  Missing or another user's → `404`.
- `POST /api/shell/native-runtime/authorizations/<requestId>` body exactly
  `{"decision":"approve"|"deny","leaseDigest":"sha256:…"}` (at most 512 bytes): `Origin` equal to the canonical
  origin, `Sec-Fetch-Site` absent or `same-origin`, no `Authorization` header, normal `getUser()` owner. Digest must
  match. CAS lease and request `required → approved|denied` exactly once; otherwise returns the current receipt.
- Approval never creates, renews or extends a native AI authorization (`0031`) and never implies v1 consent.

## 10. Private host channel and Core ABI

OS → Worker → host: `POST /sandbox/<derived>/native-runtime` → host `/__ezil/control/native-runtime/<bodySHA>`
(host lane). Every native hop's request and reply envelope is at most **131072** bytes; the SDK driver frame bound
(1 MiB) is internal to the host and separate.

```ts
interface RuntimeRequestScope {
  authority: 'read' | 'control';
  ownerUserId: string; originalOAuthClientId: string; sessionId: string; computerId: string;
  runtimeId: string | null; hostEpoch: string | null;    // a pair: both null only for read discovery / tombstone-only
  placement: { generation: string; leaseEpoch: string; instanceId: string; fenceToken: string };
  profile: 'ezil-native-claude-v1';                      // OS profile id; the host maps it by an explicit typed adapter
  policyDigest: string | null;                           // Core producer policy digest (bare hex) of the runtime
  aiAuthorization: { authorizationId: string; state: 'active' | 'inactive' | 'revoked';   // 0031 terms.authzId
    expiresAt: string; policyDigest: string | null };
  controlAuthorizationId: string | null;                 // control only
  controlDeadline: string | null;                        // control only
}
interface RuntimeRpcRequest {
  v: 'ezil-native-runtime-rpc/1';
  action: 'read' | 'prompt_get' | 'request_get' | 'send' | 'answer' | 'cancel';
  scope: RuntimeRequestScope;
  rootRequestId: string | null;   // client requestId: request_get/send/answer/cancel
  requestDigest: string | null;   // send/answer/cancel
  deadline: string;               // absolute; reads now + 10 s
  payload: object;                // closed per action, see runtime-contract.ts
}
```

- Read actions carry `authority: "read"` and null control fields; control actions carry `authority: "control"`, the
  lease id and deadline, and a non-null runtime pair. No fake control id is ever sent with a read.
- The host derives no authority from the payload. Before any effect it calls the OS fresh reader
  `recheckNativeRuntimeControl({ownerUserId, requestId, controlAuthorizationId, requestDigest, action})`
  (`runtime-control-reader.ts`): it returns the stored immutable resolved scope, action, root request id, request
  digest and deadline only when the request is `dispatching` under an approved lease, owner and computer are current,
  stored placement equals the live placement and the deadline is in the future; otherwise a typed refusal. No writes.
- Public `runtimeId` is the lowercase UUID the host/Core generated once. A private cgroup or journal SHA may exist
  inside the host and is never public; the current Python 64-hex id must be mapped privately or replaced by the host
  owner. The OS never invents one. Core `policyDigest` is the producer value bound when the runtime was admitted;
  the OS stores it from the host read and compares it, never recomputes it.

Required next Core ABI (**unavailable until the Core owner implements it**; today's `decide`,
`cancel(operationId)`, 1000-character prompt preview and latest-20 status are not qualified controls and are not
adapted):

```
read({principal, requestScope, cursor, limit})              -> runtime + whole events + open prompts
getRequest({principal, requestScope, requestId})            -> exact durable request receipt | null
getPrompt({principal, requestScope, promptId})              -> full SDK prompt (input object, producer digest,
                                                               instructionRequestId, instructionRevision, expiresAt) | null
submit({principal, requestScope, requestId, requestDigest, instruction})
decide({principal, requestScope, requestId, promptId, revision, promptInputDigest, decision, message?})
cancel({principal, requestScope, requestId, targetRequestId})
```

Core receipts map one to one onto `ControlState` (`recorded`, `delivering`, `accepted`, `completed`, `failed`,
`blocked`, `cancelling`, `cancelled`, `unknown`) and `ControlEffect`. Namespace
`(owner, original client, session, runtime, hostEpoch)` is mandatory at Core, with the same fingerprint,
unknown-hold and tombstone rules. Until host and Core expose these, reads answer `blocked/host_unavailable` (or
`core_unsupported`) and approved controls stay `approved` with zero host calls. That is the truthful blocked state,
not completion.

## 11. Bounds

| Item | Bound |
| --- | --- |
| Raw instruction | 16384 UTF-8 bytes |
| Public request body | 65536 UTF-8 bytes |
| Deny message | 2048 UTF-8 bytes |
| Prompt input / event text | 65536 UTF-8 bytes of `JSON.stringify` / text |
| OS response DTO / complete MCP result envelope | 126976 / 131072 bytes |
| MCP text summary | 512 bytes |
| Every private native hop, request and reply | 131072 bytes |
| Events page | `limit` 1–100 whole events, within the response bound |
| Pending prompts listed | 32 (`pendingPromptsComplete`) |
| Consent window / control deadline | min(10 min, deadline) / min(15 min, placement lease end) |
| Consent POST body | 512 bytes |
| Host SDK driver frame (internal) | 1 MiB |

## 12. Storage (`app/drizzle/0032_runtime_control.sql`, reserved, unapplied)

- `ezil_native_runtime_leases`: immutable lease scope keyed by `control_authorization_id`; only `state`
  (`required → approved|denied|expired`) and `decided_at` move, by guarded CAS.
- `ezil_native_runtime_requests`: immutable `(owner_user_id, request_id)` rows (unique per owner across clients,
  sessions and runtime epochs) pinning client, session, computer, kind, canonical semantics and digest, lease,
  runtime/host epoch/placement and the answer's stored prompt snapshot; only authorization/outbox/Core-observed
  state, effect and reason move, by guarded CAS.
- `ezil_native_runtime_tombstones`: permanent `(owner_user_id, target_request_id)` rows.
- Guard triggers refuse identity changes, illegal transitions, DELETE and TRUNCATE. RLS enabled with no policies; no
  grants to `anon`/`authenticated`. No token, credential or proof is stored. `runtime-store.ts` is the single writer.
