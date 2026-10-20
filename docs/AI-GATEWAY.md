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
Header timeout is **185 seconds** and body idle timeout is **125 seconds**,
leaving the gateway's own deadlines the first chance to return its answer.
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
