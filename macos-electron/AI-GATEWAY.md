# Native Works credit provider

Native Settings → System → **Connect EZiL Works** selects the `ezil` provider.
macOS dialogs collect the builder email and password; Electron main exchanges
them for a Works session. The renderer receives only allowlisted provider state,
alias names and error codes. The password is never persisted. Access and refresh
tokens remain in main and the existing `safeStorage`-encrypted, owner-only
`private/provider.enc` under the native application's user data directory.
Keychain availability is mandatory. No desktop token, API key, service role,
environment variable or browser session needs to be supplied manually.

Selection replaces the previous provider before the sign-in dialogs. Cancelling
leaves Works selected without a session. **Remove provider** removes its local
session; it does not revoke other Works sessions. Explicitly selecting Azure or
Bedrock retains their existing direct-provider behavior. The Works provider has
no direct-provider fallback.

## Fixed service contract

These destinations are compiled into `src/works-session.cjs`. No renderer,
descriptor, environment setting or redirect can override them. Origin changes
require a reviewed source change and rebuild. The Works origin and camelCase
response shapes were checked against the local Works API source and production
documentation, not against a live authenticated account.

| Destination | Request | Required response |
| --- | --- | --- |
| `https://ezil-works-api.vercel.app/auth/signin` | POST `{email,password}` | `{accessToken,refreshToken,expiresIn,tokenType,accountId}`; bearer token type |
| `https://ezil-works-api.vercel.app/auth/refresh` | POST `{refreshToken}` | Same envelope, including the rotated refresh token |
| `https://ezil-works-api.vercel.app/v1/me` | GET with user bearer | Matching `accountId`, `role:"builder"`, `onboarded:true` |
| `https://ai.ezil.work/v1/models` | GET with user bearer | `{killswitch:boolean,data:[{id,enabled,max_input_tokens,max_output_tokens,...}]}` |
| `https://ai.ezil.work/v1/responses` | POST with user bearer and `Idempotency-Key` | Responses SSE with explicit terminal event |

All requests refuse redirects, cookies and alternative destinations. Auth and
inspection each have a four-second deadline (a refresh plus inspection fits
Settings' ten-second deadline). JSON is bounded to 64 KiB; error bodies to 8 KiB.
Sign-in does not infer authorization from JWT claims. Works `/v1/me` verifies the
builder account, and gateway `/v1/models` verifies the ES256 JWT and current
`ezil_works.ai_members` row. Both checks run again before each inference request.
The gateway rechecks membership, credits and limits when reserving the request.

Refresh starts within 60 seconds of expiry and concurrent callers share one
exchange. The stored old refresh token is removed **before** the exchange;
rotation is persisted before further calls. A lost reply, process crash, invalid
grant or failed write requires sign-in again. This intentionally favors a safe
failure over retrying a potentially consumed refresh token. Provider changes or
sign-out during an exchange cannot restore its old session. A gateway 401 clears
the session and does not retry inference.

## Broker and extension contract

The local capability, exact loopback Host restriction, Origin rejection and
private descriptor remain in place. The descriptor contains no Works token.
The extension sends the existing `{model,messages,maxTokens}` body and a UUIDv4
`Idempotency-Key` generated once for that logical invocation. The broker requires
and forwards that same key. There are no automatic inference retries, including
401, 409, timeout, cancellation or stream failure. A 409 replay/conflict is shown
as already submitted; the desktop does not replay a response or substitute a new
key. Starting a new user request creates a new key and can spend more credits.

The broker converts ordered text-only user/assistant/system messages to
`{model,input,max_output_tokens,stream:true,store:false}`. It rejects extra
fields, tools, images, arbitrary models and out-of-range output requests. The
byte/framing input bound matches the gateway validator. The effective allowance
is the smaller of the compiled cap and the authenticated enabled-model cap:

| Alias | Gateway deployment | Input bound | Output range |
| --- | --- | --- | --- |
| `ezil-fast` | `gpt-6-luna` | 32768 | 16–8192 |
| `ezil-code` | `gpt-6-sol` | 16384 | 16–4096 |

Only enabled aliases are advertised; a killswitch or empty enabled list refuses
requests. The extension advertises each model's output cap, caps an explicit
larger request, and rejects a requested output below 16. Its input estimate
remains conservative and approximate; the broker enforces the actual byte bound.

Responses text deltas become the existing Chat Completions text frames. Success
requires `response.completed` with completed status, matching final output text,
and clean EOF. Failed/incomplete/refusal events, malformed UTF-8/JSON, missing
terminal events, truncated frames, unsupported output and trailing errors cannot
produce successful completion. Stream size is bounded to 8 MiB, individual
frames to 1 MiB, concurrency to two and inference to 60 seconds. Downstream
disconnects cancel inference. Backpressure is honored. HTTP errors use an
allowlisted `X-EZiL-Error` code; midstream failures send an allowlisted error frame
without `[DONE]`. The extension throws those errors after any partial text.
Provider error messages, metadata and payloads are never displayed or logged.

## Integration and remaining gates

1. Build the connector with `bun install --frozen-lockfile --ignore-scripts`,
   `bun run typecheck`, `bun test`, and `bun run build` in
   `extensions/ezil-vscode`. Its committed `dist/extension.js` must ship together
   with these broker changes. Rebuild the shell through the existing native
   packaging pipeline so the Settings change is included.
2. On a Mac with an unlocked Keychain, open native Settings, select **Connect
   EZiL Works**, and sign in with an onboarded builder. **Refresh status** reports
   current checked state. Verified membership does not claim a credit balance
   or that any inference has succeeded. The VS Code provider group retains its
   existing **EZiL BYOK** label; enabled aliases appear in that group.
3. The Works API must have its existing `SUPABASE_PUBLISHABLE_KEY` configured
   for `/auth/signin` and `/auth/refresh` (otherwise it returns 501), and the
   account must exist with builder role. The gateway's `SUPABASE_URL` and
   `SUPABASE_JWT_AUDIENCE` must match that Works project's ES256 sessions. It
   must have the matching, unsuspended current `ezil_works.ai_members` row.
   No service credentials belong in the desktop.
4. Gateway operations must independently complete their verification and enable
   aliases, resume the killswitch and provide sufficient builder credits before
   spending is possible. The gateway is currently paused; no inference, grant,
   membership change, deployment or publishing was performed for this task.

Validation uses synthetic sessions and service replies: Electron `npm test`
and `npm run check`; connector typecheck/test/build; and
`node --test --test-isolation=none shell/ezil/ui/Settings/provider-state.test.mjs`.
The extension integration test exercises the real broker handler and session
client via an in-process HTTP harness. Two existing Unix/socket tests are skipped
where sandbox listeners are denied. Real macOS password dialogs, Keychain and
the packaged Settings/editor flow still require physical-Mac validation. Live
authenticated service compatibility and credit settlement are unverified while
inference remains paused.
