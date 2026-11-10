# EZiL Chat gateway proxy

EZiL Chat calls the Worker's code bridge at
`https://8443-<sandboxId>-code.<zone>/ai/v1`. The container receives
`EZIL_AI_BASE_URL` and `EZIL_AI_PROXY_TOKEN`; it never receives the user's
Supabase access/refresh token or a gateway/provider key. The Worker forwards
requests to `EZIL_AI_GATEWAY_URL` (`https://ai.ezil.work`).

## Routes and transport

Only these routes are forwarded. The upstream template comes from a fixed
table, never the incoming path. Request ids must have the UUID hex shape
`8-4-4-4-12`. Usage forwards only `limit` and `before`; other queries are dropped.

| Code-host route | Gateway route |
| --- | --- |
| `GET /ai/v1/models` | `GET /v1/models` |
| `POST /ai/v1/messages` | `POST /v1/messages` |
| `GET /ai/v1/requests/:id` | `GET /v1/requests/:id` |
| `GET /ai/v1/me/balance` | `GET /v1/me/balance` |
| `GET /ai/v1/me/usage?limit&before` | `GET /v1/me/usage?limit&before` |

All other `/ai` paths/methods return a local 404, including `/responses`,
`/v1/admin/*`, integrations and unvalidated request ids. The `/ai` dispatcher
runs before code bridge cookie authentication and never forwards to code-server.
Browser cookies cannot authorize AI requests.

Upstream headers are exactly the stored user's `Authorization: Bearer <JWT>`
and, when present, the client's `content-type`, `Idempotency-Key`, and
`anthropic-version`. Transport-generated content length may also be present.
Client Authorization, `x-api-key`, cookies, Origin, forwarding headers and
`anthropic-beta` are dropped. Body bytes are unchanged. There are no retries,
redirect following, model substitution or automatically generated idempotency
keys. Clients own retry decisions and must retain the same key and body bytes
when retrying a turn.

The local request cap is **160 KiB**, checked while reading even without
Content-Length. Requests up to that ceiling reach gateway validation, whose
413 status, body and request id pass through unchanged. The gateway's current
Messages raw-body ceiling is 4 MiB; this OS cap is deliberately stricter, so
larger bodies receive the local 413. Gateway input/model limits can still
reject smaller requests. No live gateway configuration is inferred here.

Response status and body pass through, including errors. Allowed response
headers are `x-ezil-request-id`, `x-ezil-hold-micro`, `x-ezil-trace-id`,
`traceparent`, `retry-after`, `content-type`, `cache-control` and
`x-accel-buffering`. SSE is forwarded chunk by chunk with backpressure;
cancelling the response or disconnecting the client aborts the upstream fetch.
Streams must send headers within **30 seconds** and then a chunk at least every
**30 seconds**. A nonstreaming (JSON) request, whose headers the gateway sends
only after the whole generation, gets one **200-second** headers deadline
instead (`AI_PROXY_COMPLETION_TIMEOUT_MS`, paired with the extension). The
gateway owner cites a 180-second upstream deadline that starts at the gateway's
own upstream fetch, and a 20-second drain after a client leaves. If the gateway
reaches that fetch within 20 seconds of this one, its own deadline answers
first. Within 40 seconds, an abort here never pauses a route that the gateway
would not have paused. Later than that, it can. These gateway figures are
cited, not verified here.
Error inspection for logging is bounded and never replaces a gateway body.

## Boot token v2

Each launcher start, including restart, stores a fresh random nonce in the
sandbox Durable Object before launching with:

```
EZIL_AI_PROXY_TOKEN = HMAC-SHA256(primary secret,
  "ezil-ai-proxy:<lowercase sandboxId>:<nonce>:v2")
```

The code-host sandbox id and current persisted nonce determine the expected
token. Comparison is constant-time; an earlier boot's token or another
sandbox's token returns `401 os_proxy_unauthorized`. Concurrent opens share
the launcher's nonce under the existing DO lifecycle lock. Warm previews do
not rotate it. Without a primary secret, the proxy fails closed. Tokens from
v1 are not accepted; already-running containers need a restart to receive v2.

## User credentials and logout

The app pushes a Supabase access token on desktop open (`previewUrl`), Code
open (`codePreviewUrl`), and every `reportActivity` beat for Cloudflare computers.
It refreshes the cookie session first if fewer than five minutes remain and
skips tokens without `app_metadata.ezil_role`. Bearer-only SDK requests do not
push a cookie session. Push failures never fail the desktop operation; no
refresh token leaves the app.

`POST /sandbox/:id/ai-credential` carries JSON `{ "accessToken": "..." }`.
`DELETE /sandbox/:id/ai-credential` carries an empty body and removes the JWT.
Both use `x-ezil-signature: t=<milliseconds>,v1=<hex HMAC-SHA256>` over:

```
<t>.<POST or DELETE>./sandbox/<id>/ai-credential.<sha256(raw body)>
```

The five-minute signature window, exact method, sandbox id and body digest
are checked before storage access. Unsigned/unconfigured writes fail closed.
Push checks JWT shape, authenticated role, UUID subject ownership against
`guac-<first 16 alphanumeric subject characters>-<computer scope>`, and expiry
(with a 30-second remaining-life margin). The gateway performs authoritative
JWT signature/member verification on each request. Transactional storage keeps
the later-expiring token. A gateway 401 drops that token only if a newer push
has not replaced it. Teardown/idle stop delete the credential and nonce.

## Plan model list (Free includes Gemini 3.8 Flash only)

A push may also carry `"includedModels"`: the models the owner's plan includes,
from the same effective plan the computer start gate uses
(`app/src/server/billing/v3/ai-models.ts`; Free is `["gemini-3.8-flash"]`,
Standard and Premium are `null`, every model). It is signed in the same body.
The app resolves that owner policy even when compute metering is off; disabling
metering never grants model access. Unknown plan SKUs are treated as an unread plan.
When the app cannot read the plan it leaves the field out: that push refreshes
the token only, never the plan. A value
other than `null` or 1–16 distinct Gateway aliases refuses the whole push
(`400 included_models_malformed`). The list is stored apart from the token and
ordered by its own signature time, so a later push always wins whichever token
is kept. It stays through logout, a dropped token and stop, and the next push
with a readable plan replaces it. It counts as known for
`AI_MODEL_ACCESS_MAX_AGE_MS` (30 minutes) from its own signed time. A present
user's Code pushes one with every activity beat, each minute.

An unknown plan is never "every model". That covers no list pushed, a stale
list, or a malformed record. `POST /ai/v1/messages` and `/ai/v1/responses` then
get a local `503 os_plan_unavailable` (source `ezil-os-proxy`): a temporary
failure, never a billing refusal, and nothing is sent, held or charged. Reads
(`/models` without the header, balance, limits, usage) pass as before.

Rollout order follows from that: the app, then the desktop image, then this
Worker.

- **App first.** An older Worker reads only `accessToken` and ignores
  `includedModels`. A Worker deployed before the app refuses all inference
  until the app ships. The app's plan refresh (below) is safe either way
  round: an older Worker refuses its token-less body with a 400, which the
  sweep logs and carries on past.
- **Image before this Worker.** An older image's Code defaults to Qwen, pins
  Copilot's title and summary requests to Qwen, and does not know these
  refusals. Under this Worker, a Free account on that image gets a generic
  `403 os_model_not_included` for each such turn and for every title and
  summary, with nothing charged, no billing and no retry. Its turns recover
  when the user picks Flash. Its titles and summaries recover only when the
  computer restarts on the new image, because the older provider sends them to
  Qwen whichever model is chosen. The new image under an older Worker is safe:
  with no header there are no locks, and Flash is the default either way.
- **Old images persist.** A Worker deploy restarts no computer, so a computer
  still running the old image when this Worker ships keeps it until it
  restarts.
- **First minute.** After this Worker ships, every computer's next open,
  activity beat or plan refresh brings a list within a minute. Until then its
  model requests get the 503.

Roll back in reverse, this Worker first.

Activity beats need a present user, and an idle stop also waits for the
container's own work to end, so an agent kept busy after its user leaves can
outlive a beat's list. The app's per-minute billing sweep (`refreshAiPlans` in
`app/src/server/lib/ai-credential.ts`) therefore pushes the plan on its own,
as a signed body `{ "includedModels": … }` with no `accessToken`, from the same
effective plan and signed at the time that plan was read. Its computers are the
live ones opened in the last three hours (`last_opened_at`, on either provider),
in id order. Each minute's pass takes up to 500, starting further along each
time (`aiPlanRefreshSlice`). When passes finish, any 15 in a row reach every
computer, up to 7,468 of them; above that a rotation takes ceil((N + 32) / 500)
minutes. A pass the deadline cuts short still reaches at least 32. Each rotation
starts 32 rows further on, so rows it missed come first in a later pass, though
covering N rows at 32 a minute takes about N / 32 minutes. A running filter is
not possible: no table says a Cloudflare computer still runs, and its compute
session closes 15 minutes after the last beat. The Worker stores only the list, ordered as above, and never
creates, extends or reads the token: the work still ends with the pushed token
(`401 os_session_missing` once it expires). Nothing renews a stale list. A plan
the app cannot read sends nothing, never `null`, so the stored list ages out to
the 503. A token-less body without `includedModels` is refused (`400
included_models_missing`), and so is one that names a token, even `null`. The
refresh records no activity, presence, lease or meter. One 20-second deadline
covers the listing, plan reads and pushes; each push has 5 seconds.

With a list stored, `POST /ai/v1/messages` and `/ai/v1/responses` read the
body's `model` exactly as the Gateway reads it (fatal UTF-8, `JSON.parse`, last
repeated key wins). Any other model gets a local
`403 os_model_not_included` (source `ezil-os-proxy`), and a body that names no
model gets `400 os_invalid_request`. In both cases nothing reaches the Gateway,
so nothing is held or charged. Every `GET /ai/v1/models` answer, and the 403,
carries `x-ezil-os-included-models: <aliases, comma-separated>`. The proxy
sets this header itself and never relays it from the Gateway. With an explicit
`null`, requests pass exactly as before. Credit refusals (`402 insufficient_credits`,
`no_live_grant`) always pass through unchanged. The OS chooses Standard upgrade
or Add credits from its own billing summary.

The Gateway's credit window (`429 window_budget_reached`; its
`docs/credit-window.md`) passes through with its `retry-after` and only the
member's own window fields. Those are `budget_micro`, `used_micro` and
`hold_micro` (decimal strings), `resets_at` (a timestamp, or `null` before any
window has started) and `retry_after_seconds`; nothing else of that body crosses,
and no other refusal carries them. It is a plan allowance
checked before the wallet, so buying credits or changing plan does not lift it
today. Code never treats it as a credit refusal. It says when the window resets,
or that a request larger than the whole window will not fit by waiting, and it
asks the OS for `window_limit`: Billing explains it on the AI credits row and
opens no purchase. Lifting a window with a purchase would need a Gateway policy
change, which this does not make.

This enforcement is on the OS proxy path only. The Gateway itself has no notion
of OS plans, so a member who calls it directly with their own token is limited
only by their credits.

Without a usable JWT the proxy returns `401 os_session_missing`. Logout finds
**all** computer rows owned by the authenticated user, including soft-deleted
rows, derives their sandbox ids with the existing provider helper, and sends
parallel signed DELETEs before Supabase signOut. Identity lookup, database
listing and deletions share one **three-second total budget**. Failures and
expired budgets never prevent signout or cookie clearing. DELETE remains
available while AI is disabled. Deleting an AWS computer's derived credential
uses the same signed credential store as its AI proxy.

## Rollout, logs and limits

Production source keeps `SANDBOX_AI_PROXY = "on"` and
`EZIL_AI_GATEWAY_URL = "https://ai.ezil.work"`. The staging environment keeps its
own `https://ai-staging.ezil.work` origin. This source port changes neither setting.
Off returns exactly HTTP 503 with
`{"error":{"code":"os_ai_unavailable","source":"ezil-os-proxy"}}`.
Boot still injects the two environment variables and rotates tokens, so a flag
change can enable a running v2 container. Credential storage/deletion stays
available regardless of the flag.

AWS hosts (`aws-<port>-<sandboxId>-aws.<zone>`) use a separate dispatcher.
Only the Code port can reach the AI proxy; the dispatcher requires enabled AWS
routing and a current signed tunnel record with its AI proxy nonce. The same
owner-plan and credential checks then apply. Production routing stays enabled,
with `ezil.org` as both the AWS origin zone and its allowlist.

Logs contain route labels, status, request id, validated Idempotency-Key,
`error.code`, terminal Messages SSE event (`message_stop` or `error`), outcome
and duration. They never contain bearer/proxy tokens or request/response bodies.

Residual risk: code running as the user inside the container can use the proxy
token while the user's stored session remains live. Editor settings strip the
variables from terminals in a separate lane; that is not an isolation boundary
against same-user code. Logout deletion is best effort: an unavailable Worker
can retain a JWT until expiry; an already-started stream is not cancelled by
logout, and another live session/activity beat can push a token again. This
implementation does not claim full user-process isolation or immediate global
session revocation.

Reference: gateway `docs/OS-INTEGRATION-CONTRACT.md` and `src/app.ts` on
`origin/main`, reviewed locally for this port from OS commit `4df4e278` (#163).
Tests use mocked upstreams only; this document makes no deployment claim.
