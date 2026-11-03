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

Kimi on the Messages protocol (the shipped configuration) is always
nonstreaming: EZiL AI cannot settle its streams exactly. A configured
`stream: true` is ignored and reported as a config warning (the model is still
served; Manage shows it as "Setting ignored"). A Kimi model configured on
`openai-responses` follows its own `stream` setting. JSON text, thinking
(if the proposed API exists), and tools are delivered in their original order.
Qwen streams text and assembles tool JSON; missing `message_stop`, error events
and malformed streams fail as interrupted. Final usage comes from
`message_delta`, not the provisional counts in `message_start`. Truncation
surfaces `Response truncated (request …)` without automatic continuation.

Output caps clamp to 16–16384. `temperature` and `topP` in model configuration
(or `temperature`/`top_p` in modelOptions) clamp to [0,1]. `stream` configures
Qwen's response mode. Both models advertise `imageInput: false`.

Token counting measures serialized UTF-8 bytes; a message counts as its
serialized wire message. Copilot 0.69 uses this count for its own tool
definitions against the advertised input, one count per schema key and string
value (it never counts numbers, booleans or punctuation), for its tool budget and
for its text tool-result cap. Its prompt renderer counts message text with its
own o200k_base tokenizer instead (measured on the image). A string counts as the
exact bytes of its JSON literal, quotes and escapes included (`"你好"` is 8):
never fewer than a schema string adds to a Messages body. For `openai-responses`
models a string counts with non-ASCII escaped as `\uXXXX` plus the 23-byte
text-block margin, because the Gateway's Responses bound escapes tool text and
adds 128 bytes per tool and 32 per item. Advertised input defaults to
`131072 - 1056 - 1536 - 8000 = 120480`; `toolReserve` (default 8000) is only a
margin for counting differences.

The exact request is bounded before dispatch: `body bytes + 1056 <= 131072`, at
most 1024 messages and 1024 blocks in one message (Responses: the escaped bound
above, 512 items, 256 KiB). A request over a bound is refused on the computer
with `local_input_too_large`, `local_too_many_messages` or
`local_too_many_blocks`: nothing is sent or charged, the conversation history
is kept, and the message gives the sizes (body bytes including tool-definition
bytes, and the limit). Measured on the image with 38 tools, Copilot's renderer
budget was 57,056 o200k tokens, and typical chat content is about 4-9 bytes per
o200k token, so a long chat reaches `local_input_too_large` long before Copilot
would summarize. Summarization was reachable only with unusually dense content
(about 1-1.4 bytes per token). Any other failure before sending is
`local_build_error` (the exception's class name only).

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
A nonstreaming (JSON) request has no headers until its reply is complete, so a
transport failure more than 30 seconds after it was sent is never resent (EZiL AI
may already be running it; a same-key resend could only be refused as a replay).
It fails with `connection_lost`, which says the request may still be charged.
An earlier JSON failure is resent within what is left of the request's
165-second deadline (below). If a resend is answered `idempotency_replay`, the
first send had reached EZiL AI: the message says its reply was lost on the way
and may still be charged, instead of "already processed".
No 401, 5xx, replay, credit-budget refusal, or stream failure is retried.

Errors name where they arose. Chat shows every failure under the provider's
`EZiL Models:` label; a local refusal (nothing sent) has no second label.
`EZiL OS:` marks the computer's AI proxy, recognised by `source:
"ezil-os-proxy"` or an `os_` code (the proxy never relays either from the
Gateway). `EZiL AI:` marks a Gateway refusal relayed by the proxy, or a deadline
or interruption on the way; Gateway 413s show the input bound when sent. Streams must send a first byte within
30 seconds and then a chunk at least every 30 seconds, per attempt. A
nonstreaming (JSON) request instead has one 165-second completion deadline,
counted from when it was first sent, because the Gateway sends JSON headers
only after the whole generation. A transport resend of that request shares the
deadline, including any wait for an admission slot, and nothing is sent after
it. Only an attempt after a 429 refusal, which EZiL AI answers before anything
runs, starts a new deadline. The OS proxy uses the same 165 seconds for JSON
request bodies. The Gateway owner cites a 180-second upstream deadline, started
at the Gateway's upstream fetch, and a 20-second drain after a client leaves;
neither is verifiable in this repo. On those figures, abandoning a call pauses a
model route no earlier than the Gateway's own deadline would only when the call
reaches the Gateway's upstream fetch within 5 seconds of its first send.
Admission time or a resend can abandon a reply the Gateway would still have
answered, and pause its route after the drain. A reply
abandoned at that deadline fails with `completion_timeout`
(`os_completion_timeout` from the proxy) and may still be charged if the model
finished. Neither deadline adds a retry.

Each call writes one redacted JSON telemetry line: request ID, model, stream,
hold, HTTP status, latency, four usage buckets, stop reason, error code and
error origin (`local`, `os_proxy`, `gateway`, `transport` or `response`). Local
refusals add their sizes only: body and limit bytes, messages, largest message
blocks, tools and tool bytes.
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
