# Staging Upgrade and MCP controls plan — 2026-11-11

Preserved from the completed read-only plan. Only the fallback defect was subsequently authorized for implementation.

## Baseline
Fresh remote staging/os-union-20261106: 4c28fff2b2c0e8404f2b3f35c2d38a89a950cb2e (U8).
Root-reported live staging 32d26a255bccc2f3f0e12eb4c427f7bdfad5ec8a is an ancestor; not independently observed.
Preserve payment/feedback and model changes. Last qualified MCP a0ac8c4 has three base tools and six gated
existing-session tools, no create/model tools. Prior public metadata showed account/computer reads only.
AWS SSO expired; no alternate credentials. Sealed protocol-2 desktop is not proven installed.
Actual user's Upgrade hostname/path (“Glomoly”, /os@build/settings references) remains unobserved.
No ready authorized fixture proved the click; source constructions are not deployed environment evidence.

## Upgrade
provider.ts osBillingLink derives its origin from EZIL_AI_BASE_URL after the embedded billing request is not taken.
Cloudflare aiProxyBootEnv constructs that value through aiProxyBaseUrl(hostname, sandboxId, code.port, code.token).
AWS awsDesktopAiConfig constructs https://aws-8443-<sandbox>-aws.<previewZone>/ai/v1. Both are Code proxy URLs,
not OS URLs; neither is claimed as the observed user destination.

Keep embedded flow: lockedModelChosen -> _ezil.billingIntent -> Worker billing bridge -> shell
register_billing_frame -> registry.openBilling -> Settings Billing. Preserve parent/origin/nonce guards.
Staging's existing parent map is ezil.work -> https://os-staging.ezil.work; production bridge stays disabled.
Normal /os?settings=billing alias becomes /app/settings?tab=billing with one-shot upgrade handling.

Fix fallback with a separate trusted realm-derived OS origin and exact extension allowlist. Missing/untrusted
origin means actionable OS Settings instructions without an external link. Preserve plan locks, credit exhaustion,
window limits, chat selection, payment fixes and checkout behavior. No inferred origin from AI endpoint/caller input.
Test wrong Code origin, staging/production, invalid/missing origin, bridge failure, forged parent/nonce, credit
fallback and unchanged window-limit behavior. Own extension helper, Worker provisioning and focused tests/docs.

## MCP controls — unapproved implementation
Reuse computer.start with ezil:computers:start; agentSession.models/settings/control reads and create/configure
writes with session scopes; retain send/cancel/events/operation. Starting is distinct from opening the normal OS
surface; allowance before boot, no preview credentials and no silent grant expansion.
Preserve owner/client/procedure/input/idempotency binding, replay rejection, boot-token isolation, fences after
awaits, bounded input/output, busy/disconnected and uncertain outcomes. No arbitrary execution, caller credentials,
mode changes or tool-approval bypass.

Discover models from the owned computer's authenticated Gateway catalog filtered by OS entitlement. Static config,
admin registry and reported production model count are not availability evidence. Stale/disconnected/denied
catalogs are explicit; Gateway authorization at send is authoritative. No guessed list or silent substitution.
Effort requires a separately reviewed capability contract across Gateway/extension/desktop/OS. Current protocol 2
returns efforts=[] and refuses effort_not_per_session. Discover supported values, bind them per session/request,
read back actual values and preserve old protocol behavior; never mutate global settings to simulate control.
Plugin must not display prices or initiate checkout/upgrade; normal OS UI owns upgrade navigation.

## Order and acceptance
Root assigns isolated worktrees from fresh union, composing qualified desktop forward. Sole custodian 40003c71
supplies current app/Worker/image/VSIX/schema/config after its operation; do not interrupt it. DB approval is separate.
Focused tests: foreign owner, wrong scope/audience/replay, duplicate/conflicting keys, stale model catalog,
disconnect/restart, busy configuration, bounded send/cancel, uncertain delivery. Effort must prove independent
sessions and the actual supported outgoing value.
Only after separate reviewed deployment GO, prove receiver/token/ownership acceptance before gates are enabled.
Fresh authorized login and owned staging computer must demonstrate a new chat, dynamic models, model/effort
readback, bounded input, real output and cancel/status. User records afterward. No live acceptance claimed.
