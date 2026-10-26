# EZiL Models

`ezil.ezil-models` registers VS Code's `LanguageModelChatProvider` with vendor
`ezil` for the bundled Copilot Chat UI. The image configuration is
`worker/ezil-models/models.json`, installed at `/etc/ezil/models.json`.
`EZIL_MODELS_CONFIG` overrides `ezilModels.configPath`.

The image ships one `ezil-gateway` provider and two models:

| Model | Request mode | Output cap | Roles |
| --- | --- | --- | --- |
| Qwen3 Coder Next (`qwen.qwen3-coder-next`) | Anthropic SSE | 8192 | default, plan, utility, utilitySmall |
| Kimi K3 (no streaming) (`us.moonshotai.kimi-k3`) | Anthropic JSON | 4096 | selectable chat model |

`EZIL_AI_BASE_URL` already ends in `/ai/v1`; the provider appends `/messages`.
`EZIL_AI_PROXY_TOKEN` supplies Bearer auth. Only these environment references
appear in the image configuration. The extension's configuration defaults pin
Copilot's title/summary/progress utility slots to Qwen independently of the
selected chat model. Explicit utility initiator metadata also selects Qwen.
Deployments must preserve the utility settings if overriding VS Code defaults.

The legacy direct adapters remain available for compatibility and their offline
regression tests; no direct providers are configured in the image or example.
No fallback from the gateway to a direct provider is performed.

## Gateway contract

The request builder allows only model, messages, system, max_tokens, stream,
temperature, top_p, tools and tool_choice. It drops cache markers, prior thinking,
and all other modelOptions, including Responses API fields. System content is
text. Unsupported binary content becomes a short omission note. Empty messages
use `(empty)`. User boundaries and tool pairing are repaired, missing results
are explicitly failed, and orphan outputs become ordinary text. Tools require
unique valid names and object schemas; at most 64 are sent. Dropped names are
logged once per call. Required tool selection becomes auto with a notice.

Kimi is always nonstreaming, even if configured otherwise. JSON text, thinking
(if the proposed API exists), and tools are delivered in their original order.
Qwen streams text and assembles tool JSON; missing `message_stop`, error events
and malformed streams fail as interrupted. Final usage comes from
`message_delta`, not the provisional counts in `message_start`. Truncation
surfaces `Response truncated (request …)` without automatic continuation.

Output caps clamp to 16–16384. `temperature` and `topP` in model configuration
(or `temperature`/`top_p` in modelOptions) clamp to [0,1]. `stream` configures
Qwen's response mode. Both models advertise `imageInput: false`.

Token counting measures serialized UTF-8 bytes. Advertised input defaults to
`131072 - 1056 - 1536 - 24000 = 104480`; `toolReserve` configures the final
subtraction because Copilot does not count tool schemas. The exact full request
is also bounded by `body bytes + 1056 <= 131072` before dispatch.

Calls share a FIFO admission queue per base URL and Bearer auth context, the same
identity used by the model catalog cache. `GATEWAY_MAX_IN_FLIGHT = 2` is coupled
to the Gateway's default `per_user_concurrency = 2`. A slot covers fetch and the
entire SSE/JSON response; completion, failure and cancellation release it. An
aborted queued call leaves immediately without fetching.

One UUID and one serialized body are used per call. A `concurrency_limit` 429
releases the slot, waits, then joins the queue again. Retry-After (seconds or HTTP
date) is clamped to 1–15 seconds; missing or invalid hints use 2, 4, 8, 15, 15…
seconds. Admission retries have a 60-second wait budget, including time spent
re-queueing; the final delay is shortened to the remaining budget. Only exhausted
admission retries show “Wait for the current response to finish”. Separate
extension hosts/windows have separate queues, so server refusals remain possible.

Pre-header transport failures and `rate_limited` keep their shared single-resend
allowance (rate-limit Retry-After capped at 60 seconds, default 60). Taking an
admission retry also consumes that allowance. All resends keep identical bytes
and key: refused concurrency admission creates no Gateway request or credit hold.
No 401, 5xx, replay, credit-budget refusal, or stream failure is retried.

Each call writes one redacted JSON telemetry line: request ID, model, stream,
hold, HTTP status, latency, four usage buckets, stop reason and error code.
Prompts, bodies and tokens are never logged for the gateway, even when legacy
request logging is enabled. Cancellation aborts fetch, stops reporting parts,
and logs `cancelled; may still be charged (request …)`.

The model picker optionally reconciles disabled entries using `/models`, cached
for five minutes per base URL and auth context. The EZiL AI status item,
`Show AI Status` and `EZiL Models: Show AI Credits` read `/me/balance`,
`/me/limits`, `/me/usage?limit=5` and the global `/models` pause catalog using
the same boot bearer. All four reads bypass HTTP caches, refuse redirects and
share refresh cancellation, with a five-second deadline per read. They show
window credits and reset time,
effective account limits capped by platform ceilings, per-model limits,
entitlement, scoped pauses and recent usage. Model/client pause targets are
not returned by the member endpoint, so those pauses are shown as potentially
applicable. Global pauses use the transport's shared reconciliation/operations
classification. Failed, missing or malformed reads replace the affected values
with unknown/unavailable states while retaining other valid data. Sign-in and
expired-session failures show guidance without raw error codes. Zero and held
credits and exhausted windows/budgets come from server values, with exact
microcredit formatting and local reset times. Status refreshes at startup,
after requests, on config changes and once a minute; the popover and tooltip
share the same snapshot. Cancelled, superseded and stale-auth responses cannot
publish. These are source changes; the bundled VSIX and image must be rebuilt
and verified separately before the new status is live.

Source of truth: EZiL AI Gateway `src/providers/bedrock-converse-request.ts`,
`src/providers/bedrock-converse-response.ts`, `src/protocols/anthropic/validate.ts`
and `src/app.ts`. `anthropic-version` is allowed by the gateway but not required
by its Messages handler; it is omitted. The older OS integration document's
Responses instructions apply to different models and are not used here.

## Offline development

With development dependencies installed:

```sh
cd extensions/ezil-models
bun test
bun run typecheck
../../worker/ezil-models/build-vsix.sh
../../worker/ezil-models/build-vsix.sh --check
```

The VSIX build requires Bun and Python 3's standard library; it never installs
packages or accesses a registry. File ordering, timestamps and permissions are
fixed, so `--check` compares exact artifact bytes. The package has no runtime
dependencies. Tests use injected fetches and mock HTTP handlers without sockets.
The optional legacy live smoke requires `EZIL_LIVE_TESTS=1`; it is skipped by
default, without reading any credential file.

Six generated request fixtures live in `tests/fixtures/gateway-bodies/`.
`tests/mutation-check.py` breaks and restores the Kimi stream guard, tool cap
and cache-option allowlist in turn and requires each focused test to fail.

The package license is AGPL-3.0-only. See `ATTRIBUTIONS.md` and the MIT notice
preserved in `src/anthropic.ts` for Microsoft Copilot converter attribution.
