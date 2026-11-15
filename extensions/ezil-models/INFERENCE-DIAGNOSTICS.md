# Local inference diagnostics v1

`src/inference-diagnostics.ts` defines `ezil.inference.v1` and
`ezil.inference.aggregate.v1`. These are independent of the consent-only
app-failure contract. The provider observer now publishes a sanitized terminal
record through `_ezil.aiRequestTrace`. The pinned workbench validates the closed
contract and dispatches `ezil-ai-request-trace` with JSON detail. An older unknown
command, rejection or throwing observer cannot affect inference. No consent is
inferred from an app-failure record. Collector integration is separately owned.

Every provider response invocation produces a terminal record, including
successful, failed, locally refused and cancelled requests. The optional
`ProviderHost.inferenceDiagnostic` observer cannot change a response by throwing.
The extension keeps only its last 128 records in memory. The internal command
`_ezil-models.inferenceDiagnostics` returns a detached snapshot. Reload
loses the trace. No prompt, file path/content, tool name/argument, signature,
error string or credential enters these records. Tool and session identifiers
are HMAC pseudonyms under an ephemeral provider-instance secret.

| Field | Meaning |
| --- | --- |
| `requestId`, `turnId` | Random local identifiers for one provider invocation (an inference turn, not the whole Agent task). Multiple transport attempts share this turn. |
| `conversationId` | HMAC of Copilot's `_conversationId`, or null when unavailable. Never infer a shared session from matching prompts. |
| `clientRequestId`, `gatewayRequestId` | Final transport attempt identifiers, syntax checked; null before dispatch/when absent. |
| `adapterVersion`, `modelAlias` | Adapter revision and effective wire model, including utility routing. |
| `offered`, `requested` | Counts by read/search/write/other. Gateway offered counts use the actual serialized tool set; requested counts are model-emitted calls. Unrecognized tools, including terminal execution, are other. |
| `toolCalls`, `toolResults` | At most 128 each, linked by HMAC call identifier, category and result state. `observationsTruncated` marks dropped details; counts remain complete. |
| `results` | Only results after the latest assistant turn, matched by call ID. Duplicate/orphan results are unmatched. Explicit true `isError` is error, explicit false is reported success, absent flag is unknown. Never inspect result strings to infer success. |
| `writeRequested` | This response requested a recognized write tool. |
| `toolReportedSuccess` | This request carries an explicitly successful result for a recognized earlier write call. It is independent of this response's write requests. |
| `verifiedFileChange` | Always null in the adapter. Acknowledgements are not proof of a filesystem mutation. The future file observer must provide separate evidence with its own contract. |
| `usage`, `usageSource` | Provider-reported counters, or null/unknown. Missing cache counters remain missing, never inferred as zero. These are provider reports, not local token measurements. |
| `estimatedInputTokens` | Local estimate before compaction. Never compared as if equal to measured serialized bytes. |
| `wireBytes`, `totalWireBytes`, `attempts` | Final serialized body size, sum of bodies actually dispatched (including retries), and attempt count. No HTTP/TLS overhead estimate. Null/zero when not built/sent. |
| `compaction` | Trigger, number of compaction passes, and latest folded/shortened counts; null if none. |
| `finishReason`, `durationMs`, `cancelled`, `outcome` | Closed finish reason, entire provider invocation duration, caller cancellation and terminal outcome. |
| `thought_signature_replayed` | Whether the final serialized Messages body replayed valid thinking envelopes; never the signature itself. |
| `readHeavyWithoutVerifiedEdit` | Diagnostic suspicion when the response requests reads/searches but no recognized writes. It does not establish edit intent, failure, or an actual unchanged filesystem. |

`aggregateInference` summarizes a supplied record window: request counts,
requests with write requests or explicit write acknowledgements, cancellations,
and read-only suspicions. Its filesystem count remains null. A collector polling
overlapping snapshots must deduplicate `requestId` before aggregating, and use
call pseudonyms to join requests/results. Missing session IDs and extension
reloads limit cross-request/session attribution. Do not add usage totals from
unknown samples or sum cumulative result history as if each was a new edit.

Diagnostics never force writes, stop read-heavy work, or cause model retries.

# Gemini replay boundary

The adapter's exact Gemini alias/schema/sampling sets are tested against Gateway
commit `9deecb9869d7742664c71138ec9412f49ff8b93e`. Carbon now uses Gemini schema
projection and suppresses cache markers. Sampling is omitted for Flash, Argon
and Carbon according to that Gateway's actual policy; Pro Preview retains it.

Only an empty thinking payload with a valid `ezil-gemini-v1:` envelope can bind
the next text/tool call in the same assistant turn. Calls dropped by sanitization
lose their signature. Dangling signatures and signatures on empty trailing text
are omitted, so they cannot shift to a later call or synthesized continuation.
Claude retains its existing thinking-first behavior and never receives Gemini
signatures.

The VS Code provider accepts replay only from a completed response retained in
its own bounded memory, with matching model, resolved connection, full prior
history/system, ordered calls/arguments and complete visible reply. Text chunk
boundaries and split assistant messages may differ. Model/provider switches and
cancellation invalidate the state. Native ThinkingPart must carry the returned
random completed-turn provenance token even when `_conversationId` is present.
The pinned Copilot 0.69 wrapper forwards `conversationId` into model options;
this alone is not proof that arbitrary callers provide unique chat ownership.
Identical histories, call IDs and a shared fake conversation ID cannot substitute
for the token. Without ThinkingPart and the owned token, replay fails closed and
Gateway may use its documented dummy signature. The full fallback remains
unsupported for that API combination.

Replay state is separate from diagnostics: at most 64 completed responses, at
most 256 KiB each, in memory only. Reload, eviction, larger replies, changed
history (including a workbench summary), and replies extending a trailing
assistant prefill do not restore signatures. These conservative omissions may
still incur Gateway's documented quality cost; they never attach a signature to
another call. Pure request builders validate envelope syntax; the provider
boundary supplies model/connection/session provenance.

# Offline qualification

Run `EZIL_LIVE_TESTS=0 bun test extensions/ezil-models/tests`. The sibling Gateway
parity/real-filesystem suite uses `../gateway-ledger` by default, or
`EZIL_GATEWAY_CONTRACT_ROOT`; it skips if the sibling is absent and asserts the
exact commit if present. It executes the actual OS proxy handler and Gateway
request/JSON/SSE translation functions with injected responses, no network.
Its owned `mkdtemp` project has 180 imported files, >160 KiB history, Carbon's
983040 allowance, a versioned transport cap, read calls/results and translated
replace-string calls. It verifies exact content/hash, unchanged other files,
signature/result identity, compaction, explicit write error, and repeated reads.
The mock proves the adapter can edit. Live Agent-mode model-choice acceptance
remains pending.

# Operational bridge coverage and remaining acceptance

`src/trace-validator.js` is the closed, own-data-only validator; the workbench
patch embeds that exact function and tests source equality. Extra fields, private
fields, accessors, invalid nested types/enums/UUIDs, out-of-range counters and
records over 4096 serialized UTF-8 bytes are rejected. Correlation IDs that are
not UUIDs become null; custom aliases outside known model families become unknown.
The publisher preserves all category/result counts and trims only call/result
pseudonyms, setting `observationsTruncated`, until the complete
`{type:"ezil.code.aiTrace",v:1,nonce,trace}` envelope fits 4096 bytes with a
22-character nonce. The bounded local ring retains its complete original record.
Missing usage/session data remain unknown; absent per-session read counts cannot
be inferred as zero. `verifiedFileChange` remains null. Read-heavy diagnostics
never stall inference or cause writes/retries.

Offline tests execute the real pinned command registration with a synthetic
terminal record and preserve correlation. Root still must integrate and test
Worker event listener → nonce-bound parent message → shell → authenticated API.
The sibling collector initially had an older closed key set missing conversationId,
toolCalls, toolResults, observationsTruncated and totalWireBytes; it must match this
Carbon contract before end-to-end acceptance. Live Carbon Agent tool choice,
real file attribution, and live browser acceptance remain pending.
