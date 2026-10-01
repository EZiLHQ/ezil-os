# EZiL AI in EZiL OS (`ai.ezil.work`)

How the chat in a computer's VS Code reaches the EZiL AI gateway, who holds
which credential, what the user sees about credits, and what has to be proven
before the integration is called done. The gateway's side is specified in
ezil-ai-gateway `docs/OS-INTEGRATION-CONTRACT.md`; section numbers below refer
to it.

## Flow

```
EZiL OS tab ──(cookie session)──> Next server ──signed push──> Worker DO (per computer)
                                                                   │ stores the user's access token
Chat extension in the container                                    │
  ezil-models, provider "ezil-gateway"                             ▼
  https://8443-<id>-code.<zone>/ai/v1/... ──proxy token──> Worker /ai/v1 proxy ──Bearer <user JWT>──> ai.ezil.work/v1/...
```

1. **Account.** On first sign-in to `/os`, the server adopts the user into
   EZiL Works (`POST /account`, role `builder`) when the session has no
   `app_metadata.ezil_role`, then refreshes the session so the token carries
   the claim (contract §12.1). Works sets the role with its own service role;
   the OS never holds one.
2. **Token push.** On desktop start (`cloudflareGuacamole.previewUrl`) and on
   every activity beat (`reportActivity`), the Next server sends the user's
   current Supabase **access** token to
   `POST /sandbox/<id>/ai-credential` (`app/src/server/lib/ai-credential.ts`).
   The push is signed with `x-ezil-signature: t=<ms>,v1=<hex>` over
   `${t}.POST./sandbox/<id>/ai-credential.<sha256(body)>`, so a signature
   cannot carry another token or reach another computer. The server refreshes
   the cookie session first when fewer than 5 minutes are left. Tokens without
   an `ezil_role` claim are not pushed. **The refresh token never leaves the
   server.**
3. **Storage.** The Worker checks that the token's `sub` owns the computer
   (`guac-<first 16 alphanumerics of sub>-…`), that `role` is
   `authenticated` and that it has not expired, then stores it in that
   computer's Durable Object. The later-expiring token wins. It is deleted
   when the computer is torn down, and dropped after the gateway answers 401.
4. **Proxy.** The container calls `/ai/v1/*` on its own code bridge host with
   `Authorization: Bearer $EZIL_AI_PROXY_TOKEN`. The Worker injects that token
   and `EZIL_AI_BASE_URL` into the neko boot env; it is
   `HMAC(primary secret, "ezil-ai-proxy:<id>:v1")`, valid for that computer
   only. The proxy (`worker/src/ai-proxy.ts`) forwards **only**:

   | Container calls | Gateway route |
   | --- | --- |
   | `GET /ai/v1/models` | `GET /v1/models` |
   | `POST /ai/v1/responses` | `POST /v1/responses` (JSON or SSE) |
   | `GET /ai/v1/me/balance` | `GET /v1/me/balance` |
   | `GET /ai/v1/me/usage?limit&before` | `GET /v1/me/usage` |

   Everything else under `/ai` is a local 404; `/v1/admin/*` and
   `/v1/integrations/*` are unreachable because the upstream path comes from
   that table, never from the request. Upstream headers are exactly
   `Authorization: Bearer <user JWT>`, `Content-Type` and the client's
   `Idempotency-Key`; the body bytes are forwarded unchanged (the idempotency
   fingerprint is their SHA-256, §6). One upstream attempt per call: the proxy
   never retries and never mints an Idempotency-Key. Status, body,
   `x-ezil-request-id`, `x-ezil-hold-micro`, `retry-after`, `content-type`,
   `cache-control` and `x-accel-buffering` pass through; SSE is streamed
   chunk by chunk. Deadlines are 185 s for headers and 125 s idle, 5 s past
   the gateway's own 180 s / 120 s so its `upstream_timeout` answer arrives
   first.
5. **Proxy-originated errors** carry `"source":"ezil-os-proxy"`:
   `os_proxy_unauthorized` (401, wrong or missing proxy token),
   `os_session_missing` (401, no token pushed yet: keep EZiL OS open, it
   arrives with the next beat), `os_ai_unavailable` (502/503/504: proxy not
   configured, gateway unreachable, headers deadline), `body_too_large` (413,
   over 1 MiB locally), `not_found` (404).

### Who holds what

| Secret | Where | Never in |
| --- | --- | --- |
| Supabase access token (≤ 1 h) | OS cookie, Next server memory, the computer's DO storage | container env, files, processes, logs |
| Supabase refresh token | OS cookie, Next server | Worker, container |
| Proxy token (per computer) | container env (`EZIL_AI_PROXY_TOKEN`), derivable by the Worker | logs; useless without a live pushed token |
| Provider keys (Azure, Anthropic, OpenAI) | the gateway only | OS image, OS env, Worker |
| Supabase service role | Works and the operator CLI `tools/invite.ts` | OS app, Worker, container |

Anything in the container can spend the user's credits through the proxy
while EZiL OS is open, exactly as the user can. It cannot reach operator
routes, another user's computer, or the token itself.

### Kill switches and configuration

- Worker `SANDBOX_AI_PROXY=off`: both routes answer 404 and new containers get
  no `EZIL_AI_*` env. `EZIL_AI_GATEWAY_URL` (default `https://ai.ezil.work`,
  https only).
- No primary HMAC secret (local dev): the proxy refuses (503) and pushes are
  refused, unlike the other local-dev control routes.
- App: pushes need `CLOUDFLARE_GUACAMOLE_WORKER_URL` and
  `CLOUDFLARE_GUACAMOLE_HMAC_SECRET`; a Worker 404 (`ai_proxy_disabled`) is
  quiet.

## What the user sees about credits

Shown in the chat (contract §7), first match wins, from `GET /v1/models` (M)
and `GET /v1/me/balance` (B) for the selected alias:

| State | Text | When |
| --- | --- | --- |
| Paused (reconciliation) | "AI is paused while usage is being reconciled. Your credits are safe." | `M.killswitch` and `M.pause == "reconciliation"` |
| Paused (operations) | "AI is temporarily unavailable. Your credits are safe." | `M.killswitch`, any other pause |
| Model off | "This model is not available right now." | alias `enabled == false` |
| Used | "You have used your included AI credits." | nothing available or held, a live grant exists |
| Expired | "Your AI credits have expired." | grants exist, none live |
| Not included | "AI credits are not included for this account." | no grants |
| Held | "Your credits are held by requests in progress or being settled." | nothing available, something held |
| OK | "AI credits: N remaining" | `N = floor(B.available_micro / 1e6)` |

Errors on a request map by `error.code` (§8), never by message:
`insufficient_credits` → the states above (with `no_live_grant` when the
gateway sends it, and "not enough credits for this request" when credit exists
but the hold is larger), `killswitch` / `global_cap_reached` → paused,
`rate_limited` / `concurrency_limit` → wait (`Retry-After`),
`input_too_large` / `body_too_large` → "prompt too large: start a new chat",
`401` → re-authenticate (one retry with the same key and bytes after the next
push), `idempotency_replay` → "already processed", stream `error` event or EOF
without a terminal event → "the response was interrupted (request <id>)".

## Acceptance proofs (Phase B)

Run against the real gateway after Phase A (gateway PRs merged and deployed,
QA builder with a member row and a small grant, killswitch off only for the
controlled run, `docs/CONTROLLED-VERIFICATION.md` in the gateway repo):

1. A fresh OS invitee signs in, gets `ezil_role=builder` and an
   `ezil_works.accounts` row, and the refreshed token carries the claim.
2. EZiL Chat completes through `ai.ezil.work` with that builder's JWT, in Ask
   mode, and in Agent mode with a tool call if the alias allows the request
   size (the `ezil-models` adapter documents the measured agent-turn size
   against `ezil-code`'s 16,384 allowance).
3. `env` in the container and `docker inspect` of the image show no
   `ANTHROPIC_*`, `AZURE_*` or `OPENAI_*` key names, and no JWT appears in the
   container's env, files or processes (`grep -r eyJ` over `/proc/*/environ`,
   `/etc`, `/home`, `/tmp`).
4. The gateway ledger and `GET /v1/me/usage` show the request ids the proxy
   logged (`event: ai_proxy`, `request_id`).
5. The OS shows each credit state: no grant, held, exhausted, killswitch,
   rate limited.
6. A replay does not double-charge: kill the connection mid-request, retry with
   the same key and bytes, get 409 `idempotency_replay`, show "already
   processed", and the ledger has one charge.

## Not done here (follow-ups)

- **Egress interception instead of a proxy token.** `@cloudflare/containers`
  0.3.7 supports `static outboundByHost`, which would let the Sandbox DO answer
  `http://ai.ezil.internal` itself so the container holds no credential at
  all. Not adopted: the handler runs in the `ContainerProxy` entrypoint, not in
  the DO; `@cloudflare/sandbox` 0.12.1 reassigns `outboundHandlers` at runtime
  for R2 mounts and ships its own `ContainerProxy` that only dispatches its
  mount hosts; and proving interception plus SSE streaming needs a real
  Cloudflare deploy. The proxy routes are written so the transport can be
  swapped without changing the extension's contract.
- `GET /v1/requests/:id` (status after a replay) is not proxied yet.
- Unverified until a live run: that containers can reach their own
  `*-code.<zone>` host from inside, that Workers invocation logs do not retain
  the proxy token in `Authorization`, and the waitUntil limit after a client
  disconnect (contract §14.4).
