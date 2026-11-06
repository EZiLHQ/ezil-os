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

## Image requests: the effective limit at each hop

Image input is default off at every hop (see `extensions/ezil-models/README.md`).
When it is on, a user PNG crosses these limits, and the smallest one decides:

| Hop | Limit | Where |
| --- | --- | --- |
| EZiL Models extension | PNG only, Gateway PNG structure rules, ≤ 1 MiB and 1–8,000 px per image, ≤ 4 images per request; whole body ≤ 160 KiB, else refused locally with nothing sent | `extensions/ezil-models/src/gateway-messages.ts` |
| Code host `/ai/v1` proxy (Cloudflare and `aws-` hosts, one handler) | **160 KiB** request body, read bounded, after the HMAC bearer check; bytes forwarded unchanged | `worker/src/ai-proxy.ts` `AI_PROXY_MAX_BODY_BYTES` |
| EZiL AI Gateway, default-off candidate `8e28cfe4` | 4 MiB raw Messages body; same per-image rules; each image counts 4,784 input tokens; staging-only flag; Sonnet 5.5 and Haiku 5.5 Messages routes only | Gateway `src/protocols/anthropic/validate.ts`, `docs/STAGING-CLAUDE-IMAGE.md` |
| Provider (Anthropic Messages, Bedrock InvokeModel) | Provider limits; not checked in this repository | Gateway owner |

The effective limit is this proxy's 160 KiB whole body. Base64 takes 4 bytes for every 3, so that is about 120 KB of PNG
with an empty chat. With Agent mode's tool definitions (about 54 KB) and history, the room is less. The extension mirrors
the constant (a test fails on drift). An offline test runs requests through this proxy's real handler, including a compacted Agent-mode turn:
`extensions/ezil-models/tests/image-e2e.test.ts`. Across the boundary, the extension either refuses the request or the
proxy forwards it, and the proxy never answers 413. Raising the 160 KiB bound needs its own memory and abuse review.
It must not be raised as a global limit just for images.

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

Without a usable JWT the proxy returns `401 os_session_missing`. Logout finds
**all** computer rows owned by the authenticated user, including soft-deleted
rows, derives their sandbox ids with the existing provider helper, and sends
parallel signed DELETEs before Supabase signOut. Identity lookup, database
listing and deletions share one **three-second total budget**. Failures and
expired budgets never prevent signout or cookie clearing. DELETE remains
available while AI is disabled. Deleting an AWS computer's derived credential
is harmless; no AWS inference proxy is enabled.

## Rollout, logs and limits

`SANDBOX_AI_PROXY = "off"` is the production top-level Wrangler default;
staging sets it to `"on"`. Both set `EZIL_AI_GATEWAY_URL = "https://ai.ezil.work"`.
Off returns exactly HTTP 503 with
`{"error":{"code":"os_ai_unavailable","source":"ezil-os-proxy"}}`.
Boot still injects the two environment variables and rotates tokens, so a flag
change can enable a running v2 container. Credential storage/deletion stays
available regardless of the flag.

AWS browser hosts (`aws-<port>-<sandboxId>-aws.<zone>`) use a separate dispatcher
on main. Their `/ai` paths return **404 `os_ai_unavailable`** before AWS routing
or cookie checks, whether `AWS_ROUTING_ENABLED` is on or off. AWS parity is
outside this implementation.

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
