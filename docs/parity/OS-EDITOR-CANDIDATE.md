# OS application server editor parity candidate

Local source candidate on production `9bcc67af5e41c759605d6fb2fe5d67aa863defc5`, ported surgically from OS stage `308447f793384e100efc87ec35739304327a48dc`. This document does not authorize deployment. No production/staging database, server, user or provider mutation was performed by this lane. Local disposable PostgreSQL and in-memory PGlite contain synthetic data only.

The accepted production parent and the serving production revision are distinct: the November 26 SSM receipt `02c3827b` identifies serving `86a6e55dd33275098f62a829e4d9493184cbdd9a`. Stage receipt `a06184b1` identifies `308447f7`. In those receipts editor/bridge/control/onboarding are enabled on stage and absent on production. Native switches are absent on production; the production assignment gate is enabled. Preserve those reviewed defaults until a new candidate and all counterparts are separately qualified.

## Application scope

The candidate adds delegated editor session listing/read/send/cancel, protocol-2 model/create/configure controls, HMAC bridge sync, ordinary owned-computer start, delegated account settings/AI-balance read, explicit Auth0 MCP onboarding, and named computer record creation. Production native sessions/authorization, assignment APIs/clock, provider routing, billing prices and tiers remain in place. The only billing summary change exports the existing waiting-credit calculation.

No new privilege follows from signing in. Every delegated call binds the exact procedure, operation type, serialized input digest, consented scope, allowed client, identity and replay key. Rejected delegation never falls back to cookies. Normal calls require an existing active owner. Bootstrap alone may establish an account after a separately verified recent ID token and consent; it cannot make a browser session, enroll AI membership, merge an unrelated account, or create general grants.

Named creation uses the existing two-live-computer limit and lowest-free-slot allocation; its transaction records the original `(user, client, idempotency key)` result and rejects changed input. Creating a record does not start compute or change a tier. Starting compute follows existing placement, ownership, allowance, kill-switch, capacity, metering and provider gates. AI balance reads only the current owner's existing eligible Cloudflare placement and in-Worker credential, fenced again after the response. Missing/unavailable evidence stays `unavailable`, not a fabricated zero. AWS balance is not established by this path.

## Counterparts and user-owned reach

| User operation | OS procedure | Exact delegated scope |
| --- | --- | --- |
| Read computers | `computer.list`, `computer.get` | `ezil:computers:read` |
| Read sessions, events, operations, models/settings/control receipt | `agentSession.list/get/events/operation/models/settings/control` | `ezil:sessions:read` |
| Send/cancel instruction; create/configure session | `agentSession.send/cancel/create/configure` | `ezil:sessions:write` |
| Start owned computer | `computer.start` | `ezil:computers:start` |
| Create named computer record | `computer.createNamed` | `ezil:computers:create` |
| Read own settings | `account.mcpSettings` | `ezil:settings:read` |
| Confirm first connection | `account.completeMcpConnection` | Internal `ezil:account:bootstrap`, reserved to the consent protocol |

Connect tools also require their ordinary `ezil:account` grant. Reach the supported user-owned operations through a production counterpart that requests and enforces those scopes individually. Do not broaden grants, substitute administrator access, copy a stage client allowlist, or turn the bootstrap scope into a blanket user grant. Browser, native execution, billing writes and arbitrary shell access are separate capabilities.

| Component | Production evidence | Stage/reference evidence | Candidate gate |
| --- | --- | --- | --- |
| OS application | Parent `9bcc67af`; serving `86a6e55d` | `308447f7` | This source port plus reviewed schema and config |
| Code Worker | Source `71fbf169d85a01862c61094470fec8238ea0007b`, version `598ddb57-197d-4c9b-be1b-609a6770ad64` | Source `ad07f2b663bceaead23168fee692bbdebb8a9555`, version `6054d338-350f-48bf-828c-99c34c40f6e6` | Production serving source has no editor bridge; sibling owns production producer |
| Shipped image | v58, digest `sha256:316ed47e2253079c043764c5fcb77eb21681aeffb0fd9531f0dbe6b95346f7a8` | v133, digest `sha256:f95e1c6ab4deac39e9cf98d7484b24127ddef741a71a107022d7563d31a0d214`, source `8a3b1c731219e725a7cd71de28cb03a940964d6c` | Qualify exact shipped workbench and extension, not merely Worker source |
| MCP/Connect | Signed viewer acceptance labels `24419ce1ba1442b783b9eeb1424afc4a608a6820`; predecessor `1abac47faf3d2778e11b30da36918f75db0fcf30`; main-off profile | `c038e59be65a57e03bfa0562400402743d0c042d`, activated version `783a8a88-1133-4b6d-9c7c-041503497a6d` | Production runtime/config reconciliation and editor/onboarding counterpart still required |

Evidence comes from `work/assignment-rehearsal-1126/parity-expanded-os-universe/OS.md`, `WORKER.md`, `worker-evidence/provider-serving.json`, `live-production-worker/release-receipt.json`, the sibling `mcp-stage-delivery-c038e59b/receipts/activate-20261126T143947Z/RECEIPT.json` and `production-mcp-main-off-repin/signed-viewer-link-readback.json`. The old `cb30f0f0…` image digest was a hash of JSON null and is not an OCI image identifier. Later local `de047483`/`17a89d60` Worker/image candidates are not evidence of hosted stage behavior.

## Supported producer handshake

The protocol is capability negotiated, not established by an editor version string. The owner enables `ezil.chatBridge.enabled`; unattended work requires its own consent. The boot-scoped editor token is distinct from the AI proxy token and binds sandbox plus boot nonce. The extension negotiates `_ezil.chatBridge.v1` with the shipped workbench. The Worker forwards only the fixed bridge sync route after boot-token verification, signing timestamp, sandbox and body hash. OS checks HMAC, 60-second skew, body bounds, one live owned computer, increasing sequence, owner epoch and lease. Stale owners and reports cannot take or replay work.

Protocol 2 needs both OS and producer support. With controls off, v2 input is handled and answered as protocol 1. Create/configure require a fresh producer catalog and account-specific Gateway availability; static model configuration does not establish availability. Source qualification uses the hosted stage Worker reference and fake chat/Gateway services; it does not prove the deployed workbench. The sibling Worker candidate, image admission policy and actual production handshake must be qualified together before activation. No stage-only computer allowlist is copied here.

## Production environment, safe defaults and IAM

The shared renderer is `deploy/aws/os-staging/render-env.py production`. Despite its directory name, it already owns production rendering from Secrets Manager `ezil-os/production/app` into `/etc/ezil-os-production`. New names are accepted only in its production branch; existing native, assignment and Browser validators are preserved. `app/.env.example` leaves all new switches blank/off.

`editor-production-defaults.json` is the explicit safe-off overlay. `editor-production-candidate.nonsecret.json` is the exact non-secret activation overlay for a DISTINCT qualified candidate. It is an incomplete overlay, not a deployable secret or a command to enable the current release. It sets:

```text
EZIL_DELEGATED_EDITOR_SESSIONS=enabled
EZIL_EDITOR_BRIDGE=enabled
EZIL_EDITOR_BRIDGE_CONTROLS=enabled
EZIL_DELEGATED_ONBOARDING=enabled
EZIL_OS_PUBLIC_ORIGIN=https://os.ezil.work
EZIL_DELEGATION_ISSUER=https://connect.ezil.work
EZIL_DELEGATION_AUDIENCE=https://os.ezil.work
EZIL_DELEGATED_COMPUTER_READS=enabled
CLOUDFLARE_GUACAMOLE_WORKER_URL=https://api-desktop.ezil.org
EZIL_EDITOR_WORKER_ORIGIN=https://api-desktop.ezil.org
EZIL_EDITOR_WORKER_PROTOCOL=2
EZIL_PREVIEW_TOKEN_V2=1
```

The protocol pin is an operator assertion about a qualified producer; it is not runtime proof. Preserve the existing legitimate production `EZIL_DELEGATION_PUBLIC_JWKS`, `EZIL_DELEGATION_CLIENT_IDS`, Worker HMAC and normal auth/service configuration. They are deliberately absent from the overlay. Validate signer/key/client equality without printing secret values. Do not copy stage values. Bootstrap additionally needs `EZIL_MCP_IDENTITY_BOOTSTRAP_AUTH0_CLIENT_ID` equal to production Connect's actual upstream `EZIL_ID_CLIENT_ID`, verified from legitimate custody. This is not OS browser `AUTH0_CLIENT_ID`. Without it bootstrap stays off even if account settings/named creation is enabled. Confirm the production Auth0 callback `/callback/ezil-id`, issuer `https://id.ezil.work/`, audience, nonce and consent age.

Current read-only AWS metadata/IAM evidence is in `editor-production-iam-read.json`. Existing `ezil-admin` SSO identity in account `452630323510` performed only Get/Describe/List/Simulate calls. No secret values were read; no role was assumed for provider actions.

* OS host role `ezil-os-prod-host-InstanceRole-uJIGAhHeIYOr` already has `OsProductionRuntime`: read its production app secret and assume exactly `ezil/prd/ezil-prd-app-caller`.
* App-caller trust names exactly that host role and requires `aws:PrincipalTag/ezil:env=production`; the host tag is installed. Lifecycle start permissions already exist. Read-only simulation allows assumption, own-secret read and lifecycle start, including the caller permissions boundary.
* Connect host role `ezil-mcp-test-editor-20261108-Role-5yJb3l31yJXI` has the installed `EZiLConnectSecretRead` for the separate `ezil/mcp/connect/config` secret. The historical role name does not authorize copying credentials from another service.

**No new IAM entry is indicated for these existing paths.** Adding non-secret fields to the same OS secret needs no new resource grant. IAM simulation does not prove an actual start, all organization/resource policies, DB privileges, production Auth0 callback registration or producer compatibility. Revalidate at integration. Source commercial/service guards remain mandatory, and no widened IAM or MCP policy is proposed. Normal AI enrollment retains the production `ezil_os_ai_enroller` role/function path; bootstrap does not substitute stage membership enrollment.

## Migration reservation and release gate

Coordination owner explicitly approved this allocation before edits:

| Production identifier | Stage source | SHA-256 of unchanged SQL bytes |
| --- | --- | --- |
| `0035_editor_agent_sessions` | `0034_editor_agent_sessions` | `1ae73e8865f488b2736608a88dd0767aebd04dfe49c43db69751db78dc8cc80d` |
| `0036_editor_control_operations` | `0035_editor_control_operations` | `0ab5ff43439b281ea6ff8eaa56efb7b166e0cdcb6e283029c2a216baf7c8da59` |
| `0037_editor_protocol_2` | `0036_editor_protocol_2` | `134e14daa769de62f5ac25298569fd7b5e0a26697cf7e98963c650cd28f08c16` |
| `0039_named_computer_creation` | `0037_named_computer_creation` | See manifest byte pin |

Production `0034_assignment_migration_clock` remains byte-identical. Sibling override retains `0038_operator_access_overrides`, independent of named creation. No journal from stage is imported. The previously omitted parent `0034` and the four new files are registered as manifest **snapshots**. The executable migration list and Drizzle journal remain unchanged. `validate` passing is an inventory result, not proof of installation or a deployable migration plan.

Integration baseline `94b3aa114c50061bf62d11ab32c176d73abdf75c` (after `6a441d2` / merge `b543803e`) independently registers `0034`. Its single registration is identical to this lane's: SHA-256 `20d13abe691864be55aa7ee7732a3f5da723f3586c1741770c5d5c2a743accd1`, kind `snapshot`. The merger must keep that entry exactly once and order the combined reserved sources `0034,0035,0036,0037,0038,0039`; this isolated lane intentionally contains no sibling-owned `0038`. Run manifest validation after composition. Preserve both the editor readiness observer and the override handoff hook in the shared billing sweep route.

Before any release or rollback application, the OS integrator must independently inspect the CURRENT production schema and all applicable ledgers (`ezil_ci`, any self-hosted/stage history, and Drizzle history). Reserve IDs against actual state, verify hashes, server privileges and RLS, then construct the reviewed forward plan using observed before/after catalog digests under the existing production migration engine. This lane intentionally cannot supply those live digests. Never replay the four raw files blindly; CREATE/ADD statements are not intrinsically retryable. Never relabel or update stage receipt rows to make them appear production-owned. Preexisting unreceipted stage objects must stop the plan for reconciliation.

`e2e/production-editor-migrations.test.mjs` executes the exact four files through the real production transaction engine in PGlite. It observes local catalog digests, applies and retries atomically, checks full rollback on a bad final digest, refuses unknown/checksum-drifted journal entries and existing stage objects, and preserves synthetic existing computer rows, actual production native tombstones, actual assignment clock/triggers and staging receipts. These local digests are never exported as production authority. RLS and client revokes are verified with the override capability absent.

Rollback keeps the additive schema and durable receipts. The old app's original computer reader and native/assignment tables remain compatible; new feature operations become unavailable with the old binary/default-off config. Old deployment tooling may refuse new ledger entries: retain the reviewed forward manifest/runner and qualify its read-only plan rather than using an old runner to apply or undo schema. Drain/fence in-flight editor work and preserve uncertain outcomes; do not translate a lost acknowledgment into automatic re-execution. Send/cancel and control retention is seven days; named creation receipts persist. The override lane has its own policy rollback limitation.

## Qualification status

Final source/receipt pins and local check results are recorded in `OS-EDITOR-RECEIPT.md`. Production activation remains held on the current-ledger/forward-plan gate, the sibling production Worker/image handshake and admission gate, and a qualified production MCP/Connect/Auth0 counterpart. No unresolved gate is satisfied by turning an environment flag on. Stage timers were enabled but inactive in the supplied receipt; that is sibling timer work and not proof of recovery here.
