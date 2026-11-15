# Operational AI request traces — staging draft

This lane accepts the actual Carbon `ezil.inference.v1` diagnostic emitted by
`extensions/ezil-models/src/inference-diagnostics.ts` in this tree.
It captures metadata only. No prompt, response text, file path, tool name, tool
arguments/results, thought signature, credentials, exception text, customer raw
capture, or billing calculation is permitted. Unknown keys reject the record at
every boundary. Integers are nonnegative safe integers bounded to PostgreSQL int;
strings, enums, nested keys and bytes are bounded. The one shared validator and
its source-pinned injection literal serve the command, Worker, shell and server.
Unrecognized model aliases normalize to `unknown`; optional opaque correlation
IDs normalize to null unless UUIDs. These are deliberate data minimizations.

## Meaning and coverage

All diagnostic fields are client-reported and unverified. `received_at` is the
collector's database clock, and `user_id` is derived from the authenticated OS
session. No computer association is accepted. `requestId` is the idempotency key
within that user. `turnId` is currently per inference, **not a stable chat ID**;
session coverage is unknown. Neither delivered coverage nor historical capture
is claimed. Bounded queues, outages, absent schema, or missing publishers can drop
records silently. Freshness in the admin view is the newest received row within
the selected filter/page, not provider completion time or system-wide health.

Input/output, cache read/write, reasoning and input-includes-cache preserve the
provider's reported semantics: missing values are unknown, and explicit zero
stays zero. No total or price is derived. Compaction causes are exactly `remote`,
`local_input_too_large`, `local_too_many_messages`, `local_too_many_blocks` from
Carbon's `CompactionInfo`; count/folded/shortened are metadata.

Offered and requested tool categories are counts. `results.reportedSuccess` is
an acknowledgement, not proof of a changed file. `toolReportedSuccess` reports a
matched write acknowledgement from the request history; it does not establish
this inference's semantic success. `verifiedFileChange` must be null.
`readHeavyWithoutVerifiedEdit` means **any read or search with no requested
write**, including one read. The UI labels this “read-heavy”. It must never be
called a stall, semantic failure, or used to force an edit or retry. A provider
`completed` outcome is not proof that the user's task was done.

## Transport and canonical validation

The wired publisher is `ProviderHost.inferenceDiagnostic(record)` →
`prepareInferenceTrace` / `publishInferenceTrace` → `_ezil.aiRequestTrace` →
`CustomEvent('ezil-ai-request-trace', { detail: JSON.stringify(clean) })` →
injected Worker browser bridge → `{ type: 'ezil.code.aiTrace', v: 1, nonce, trace }`
→ shell memory queue → authenticated `POST /api/shell/ai-traces` with
`{ v: 1, traces: [...] }`. Unsupported commands and throwing observers fail soft.

`extensions/ezil-models/src/trace-validator.js` is the canonical closed 30-key
validator. The shared server/shell module re-exports it. Worker injection uses a
literal checked byte-for-byte against that source, so browser bundles require no
filesystem or Node runtime. Runtime-free wire declarations have a compile-time
exact-parity assertion with the producer. `docs/ai-traces-command-snippet.mjs`
contains the actual `R_AI_REQUEST_TRACE` registration from the production patch;
a test asserts exact bytes, plus equality of its flattened canonical validator.
The workbench patch retains every existing registration and verification gate.

`conversationId` is a nullable 64-hex pseudonym; `toolCalls` and `toolResults`
contain only 64-hex pseudonyms, category enums and explicit result states.
`observationsTruncated` marks omitted detail. The producer caps each observation
array at 128; the publisher may trim these arrays further to fit the complete
4096-byte nonce envelope. Full category/result counters and `totalWireBytes`
survive trimming. No prompt, tool arguments/results, source provenance or raw
session identifier is allowed. Central JSONB stores the complete sanitized
record; authoritative billing remains separate.

`bridge-integration.test.ts` constructs actual `InferenceTrace` instances for
unknown usage, measured zero and 128/129 observations, executes the actual
production registration and exact bridge script, and follows the nonce-bound
message through shell POST, the authenticated route, native ingest/query and
admin rendering. Only authentication context and database driver are mocked;
query results come from the actual ingest SQL parameter. Private extra keys are
rejected at each boundary. This is offline qualification, not live acceptance.

The existing `ezil.code.diag.hello`/`ready` lifecycle supplies the rotating nonce.
One narrow optional `onDiagnosticNonce` callback in `ui/feedback/app-failures.js`
passes only nonce/null to the independent operational receiver. It introduces no
consent dependency, failure payload, failure row, or error-collector coupling.
Mint, iframe load, disposal and re-registration rotate/invalidate the receiver.
The receiver requires a live connected frame, unchanged iframe src, non-null
contentWindow and message source, exact source and origin, current nonce, v1,
exact envelope keys, and ≤4096 serialized UTF-8 bytes. Worker requires the exact
parent and pinned shell origin before accepting hello. Both cap trace traffic
at 120/minute independently of the failure-event cap. Dedup is bounded; the DB
also guarantees `(user_id, request_id)` uniqueness.

Worker pre-hello queue: 16. Shell queue: 64. Shell batch: 8. Shell flush delay:
2 seconds; one in-flight request; fetch timeout: 5 seconds; no retries, storage,
or AI-request await. Teardown clears unsent queues. POST bounds actual streamed
bytes to 32768 rather than trusting Content-Length. All responses are fixed
202/no-store. It resolves createTRPCContext/getContext first and schedules the
write via Next `after()`. A single atomic PostgreSQL CTE upserts a durable user
minute bucket (120 records/minute), then inserts validated records idempotently.
Repeated IDs can consume quota, but cannot add duplicate rows. There is no claim
of a global account-count bound or lossless ingestion.

## Storage, retention, admin and deployment hold

`0025_ai_request_traces.sql` creates dedicated typed metadata columns plus the
strictly projected diagnostic JSON and a rate bucket. Both tables have RLS with
no customer policies and revoked public/anon/authenticated access. The migration
is a staging draft; inventory includes only a source checksum snapshot, never a
production applying migration. Catalog/baseline hashes were not fabricated or
changed. Staging runner production apply/baseline guards include 0025.

The existing authenticated maintenance handler calls trace retention in its own
try/catch so other jobs still run. Absent table skips cleanly. Retention uses the
server receipt clock, 7 days, at most ten deletes of 1000 rows within a five-second
loop budget plus one bounded stale-bucket purge. A single database statement can
outlast the loop budget; the budget is checked between calls. Remaining backlog
waits for subsequent scheduled maintenance. Read queries exclude expired rows.

`/admin/ai-traces` is dynamic SSR and fails closed under `isTelemetryAdmin` and
`TELEMETRY_ADMIN_EMAILS`. Default scope is the admin's own user; an explicit admin
scope allows all users or an exact UUID filter. Query helpers repeat the gate.
Pages have 50 rows and at most 101 pages. Invalid tenant filters do not broaden
to all users. Displayed detail is revalidated metadata only, escaped by React.

Optional **server-only** `AI_TRACES_GATEWAY_CONSOLE_ORIGIN` must be a pinned HTTPS
origin without path, credentials, query or fragment. A valid client-reported
Gateway UUID links to `/#requests?request_id=<UUID>&range=30d` with noreferrer and
noopener. The reference is unverified: there is no ownership claim, credential
copying, service credential creation or cross-schema SQL. The Gateway console
requires its own authentication. Gateway `request_telemetry` lifecycle and prices
remain authoritative. Leave the environment unset to suppress links.

All production writes remain HOLD. This worker performs no DB, cloud, SMTP,
paid-model, push or deployment operations. Root owns the guarded disposable PG
execution and staging qualification. Tests use synthetic metadata.

## Staging replay acceptance, after qualification only

Root should first qualify migration/RLS, command/host wiring, real workbench
nonce lifecycle and independent Gateway console authentication. Then replay a
bounded synthetic Carbon project (e.g. 12 reads/searches, a cancelled inference,
unknown and zero usage cases, compaction, a requested write and a tool
acknowledgement) with no customer content and a fixed small request budget.
Verify timeline ingestion and re-registration, reported-success separation,
verified-file-change remaining unknown, and read-heavy labels for single reads.
Check a separate filesystem diff only as independent evidence; do not rewrite
tool acknowledgement into verification. No replay was run against a paid model
or staging here, and no historical capture is implied.

Full prompt/response capture remains restricted to the **existing staging R2,
founder-consented, undelegated ezk project-key lane**. CodeJWT is ineligible. This
implementation does not modify that lane or grant it any new eligibility.

## Application build context

The publisher validator is canonical. Run `node app/scripts/sync-ai-trace-contract.mjs` to regenerate the build-local app copy, or `--check` to verify source parity. The committed app module is self-contained because the application Docker allowlist does not include extension sources. The isolated build-context test verifies that it works with no extension files present. No runtime filesystem loading or dynamic evaluation is used.
