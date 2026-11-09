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
own o200k_base tokenizer instead. A string counts as the text block it would be
sent as, its JSON literal plus 23 bytes. That is deliberate. Copilot starts
background compaction (a summary request to the active model) when message plus
tool tokens reach 0.78–0.82 of the advertised input (0.9 without a summarizer).
A heavy tool count starts it while its summary still fits the byte bound.

This was measured with a mock on the image, with its 38 agent tools (53,066
bytes on the wire), Qwen, and 10 turns of about 8.5 KB each, where the 39-tool
test fixture counts 88,254 against 53,535. This count gave about 87,400 tool
tokens and compacted every one to three turns; all 10 turns completed. Counting
bare literals (about 57,100) delayed compaction until the summary request was
itself over the byte bound, and every such chat was refused from its seventh
turn on.

With Kimi, whose summaries are JSON, summaries that took 45–90 seconds
completed under the 200-second deadline. The base build abandoned them at 30
seconds and ended with "Conversation too large or invalid". A chat can still
outgrow the bound before a slow summary lands, when turns come faster than the
summary. In the mock this happened with code-like content.

Copilot never counts schema numbers or booleans, so tool sets dominated by
them are under-counted. A large tool set (64 tools count 139,882, over the
advertised input) leaves Copilot's history budget at its floor. That case is
unmeasured. For `openai-responses` models a string also
counts with non-ASCII escaped as `\uXXXX`, because the Gateway's Responses bound
escapes tool text and adds 128 bytes per tool and 32 per item. Advertised input defaults to
`131072 - 1056 - 1536 - 8000 = 120480`; `toolReserve` (default 8000) is only a
margin for counting differences.

The exact request is bounded before dispatch: `body bytes + 1056 <= 131072`, at
most 1024 messages and 1024 blocks in one message (Responses: the escaped bound
above, 512 items, 256 KiB). Copilot's own compaction often does not run before a
chat reaches that bound: in Ask mode, with few tools, with a large tool output,
or with Kimi's slow summaries (above).

### Automatic compaction (`src/compact.ts`)

A request over a bound is compacted on the computer and sent, in the same chat.
Only the copy that is sent changes. Copilot's saved conversation is not touched, so
switching to a model with a larger limit sends more of it again. The compaction is
deterministic and makes no model call.

What is kept verbatim:
- every system message;
- the current user message;
- the latest assistant step with its tool results.

What is shortened or folded, in order, until the request fits 80% of the limit:
1. Older tool outputs are shortened to head and tail, then older replies.
2. The oldest messages are folded into one marked note. The note keeps every
   earlier user message (the `<userRequest>` text first) and a one-line record of
   each reply and tool call.
3. Only after that is the latest tool output cut below 32 KB.

A cut never separates a tool call from its result. Every shortening is marked in
the text the model reads. The title bar of the chat view shows "Conversation
compacted to fit the model" (`ezil-models.compactionInfo`) while the turn runs
and for 10 seconds after, with a progress bar on the view. Nothing is added to
the chat, because a note there would be saved and sent back on every later turn.

If only the current request is too large, it is refused with
`local_input_too_large`, `local_too_many_messages` or `local_too_many_blocks`.
Nothing is sent or charged, the conversation is kept, and the message gives the
sizes (body bytes, tool-definition bytes and the limit) and says what to do:
shorten the last message or its attachments, or pick a model with a larger
limit. Any other failure before sending is `local_build_error` (the exception's
class name only).

A 413 size refusal (`input_too_large` from EZiL AI, or `body_too_large` from EZiL
OS) arrives before any model has run. The request is then compacted once more,
under the limit the refusal reports, and sent again with a new Idempotency-Key.
That happens once at most, and only when compaction changed the body. A second
refusal is final. Timeouts, interrupted streams and other refusals are never
re-sent.

A failed request reaches Copilot as its message alone, without a stack.
Copilot prints an error's stack under "Reason:", which showed extension frames to
users.

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
200-second deadline (below). If a resend is answered `idempotency_replay`, the
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
nonstreaming (JSON) request instead has one 200-second completion deadline,
counted from when it was first sent, because the Gateway sends JSON headers
only after the whole generation. A transport resend of that request shares the
deadline, including any wait for an admission slot, and nothing is sent after
it. Only an attempt after a 429 refusal, which EZiL AI answers before anything
runs, starts a new deadline. The OS proxy uses the same 200 seconds for JSON
request bodies. The Gateway owner cites a 180-second upstream deadline, started
at the Gateway's upstream fetch, and a 20-second drain after a client leaves;
neither is verifiable in this repo. The Gateway owner chose 200 seconds. On those
figures, if a call reaches the Gateway's upstream fetch within 20 seconds of its
first send (admission and any resend included), the Gateway's own deadline
answers first with its request id. Within 40 seconds, abandoning it never pauses
a model route that the Gateway would not have paused itself. Later than that, a reply the
Gateway would still have answered can be abandoned, and its route paused after
the drain. A reply
abandoned at that deadline fails with `completion_timeout`
(`os_completion_timeout` from the proxy) and may still be charged if the model
finished. Neither deadline adds a retry.

Each call writes one redacted JSON telemetry line: request ID, model, stream,
hold, HTTP status, latency, four usage buckets, stop reason, error code and
error origin (`local`, `os_proxy`, `gateway`, `transport` or `response`). Local
refusals add their sizes only: body and limit bytes, messages, largest message
blocks, tools and tool bytes.
The line also includes the current client request UUID, send count (`attempts`),
and whether text or a tool call preceded a failure (`partial`). A size-compaction
retry adds the previous client request UUID. Response failures add `reason`:
`stream_error_event` for an SSE error event, `stream_truncated` for missing terminal
completion, `stream_malformed` for invalid JSON/event shapes or unsupported blocks,
`connection_reset` for a failed body read, or `invalid_response` for an invalid
complete JSON reply or response envelope. An SSE error may also add `upstream_type`,
selected from a closed error-type allowlist; event data and messages are discarded.
The existing `stream_interrupted`/`invalid_response` codes and interruption text
are unchanged. Typed deadlines keep their existing codes instead of becoming
connection resets.

`classifyChatFailure` in `src/failure.ts` produces version 1 failure metadata with
validated codes, model identifiers, UUIDs, origins, HTTP status, counts and times.
Invalid required metadata becomes null (invalid booleans become false); invalid
optional metadata is omitted. Counts must be safe non-negative integers and are
capped at one billion; valid timestamps are ISO strings. It never copies messages,
causes or payloads. `gatewayChat` exposes an optional `onOutcome` callback, called
once for failure or cancellation and never for success. Callback exceptions are
ignored. The provider does not register it yet; no additional reporting is wired.

Prompts, bodies and tokens are never logged for the gateway, even when legacy
request logging is enabled. Cancellation aborts fetch, stops reporting parts,
and logs `cancelled; may still be charged (request …)`.

The model picker reads `/models`, cached for five minutes per base URL and
auth context.

- **Which models it lists.**
  - The models configured here, hiding any the catalog disables or marks
    `unavailable`.
  - Each other catalog row that the Gateway marks `availability.state:
    "available"` for this caller, sent over the row's first protocol, the
    route its capabilities describe. Its first protocol must be one this
    client speaks, or it gets no capabilities. Availability, capabilities and
    names are read only when `contract` is `ezil.gateway.models.v1`; any
    other response is the legacy shape.
  - **One account per entry.** A catalog-only model's picker id is
    `<provider name>/<alias>`, such as `ezil/some-alias`. Neither part can
    contain `/`, so the id names exactly one configured Gateway provider (one
    account) and never equals a configured model's id. Only the alias is sent
    upstream.
  - **Requests stay on that provider.** A request reads only that provider's
    catalog and uses only its credential. An id that does not name exactly one
    configured Gateway provider is refused before anything is sent. Title,
    summary and progress requests go to Qwen on the same provider, or else to
    the selected model.
  - A model configured on the same provider with the same alias wins; another
    provider's configuration never hides this account's row. A catalog without
    `availability`, as served today, adds nothing.
- **What it assumes.** Nothing a row does not state. A catalog-only row has no
  tool calling or streaming unless `capabilities.tool_calling` or
  `capabilities.streaming` says so, and never takes image input. It keeps its
  own caps and is named by `name`, else its alias. The catalog can only take a
  configured capability away.
  - `streaming: false` sends JSON from the first request, never a stream
    followed by a JSON resend.
  - Tools offered to a model without tool calling are left out, as Copilot
    0.69 does for its own endpoints without tool calls. Earlier tool calls go
    as text.
  - Kimi K3 is always JSON.
- **Unknown is not unavailable.**
  - When a read fails, the configured models stay listed.
  - The catalog-only rows last read for the same base URL and token stay
    listed for up to 30 minutes, but only listed: a catalog-only model is
    sent only after a read that succeeds now, or within the five-minute
    cache. Until then it is refused ("cannot be checked right now. Nothing
    was sent or charged."). Configured models still go, and the request
    decides.
  - Another model is never sent in place of the selected one.
- **When it lists again.**
  - After an availability refusal (`killswitch`, `model_disabled`,
    `model_not_found`, `no_provider_route`, `model_unavailable`) or a
    caller-scoped one (`no_entitlement`, `model_not_allowed`). Each also
    clears the cache.
  - After a request whose catalog read changed the list.
  - When Show AI Status opens.
- **Protocols.** A protocol it does not speak drops out of that row, never out
  of the whole catalog, and a row left with none is not selectable.
- **Plan locks (Free includes Gemini 3.8 Flash only).** When the EZiL OS proxy
  names the plan's models (`x-ezil-os-included-models` on `/models`):
  - Every other model of that provider stays listed but locked: not
    selectable, with a lock icon and an `ezilPlanLocked` note. It is never the
    default and never sent. A locked model asked for anyway is refused here
    (`os_model_not_included`), with nothing sent or charged and no dialog.
  - When Flash itself is unavailable, nothing is the default. The picker shows
    an unavailable model, not an upgrade.
  - Title and summary requests stay on the selected model unless the plan
    includes Qwen.
  - Choosing a locked row in the picker (the workbench's `picker-locked`
    patch runs `_ezil-models.lockedModel`) re-reads the plan. If the plan now
    includes the model, the picker lists it again. Otherwise the EZiL OS
    window opens its upgrade (`_ezil.billingIntent`, reason `model_locked`).
- **Billing dialog.** Only `insufficient_credits` and `no_live_grant` ask the
  EZiL OS window for billing (reason `credits_exhausted`, with the request id),
  at most once a minute. The OS opens the Standard upgrade on Free and Add
  credits on a paid plan. Budgets, entitlement, validation, provider and network
  failures never ask. Without an OS window, the warning and its Add credits link
  remain.

A `null` limit in `/me/limits` is a configured "No limit set", never unknown.
Only the session window's `resets_at` is shown as a reset time. The EZiL AI
status item, `Show AI Status` and `EZiL Models: Show AI Credits` read
`/me/balance`, `/me/limits`, `/me/usage?limit=5` and `/models` using the same
boot bearer. From `/models` they read the global pause and, where a row states
it, that row's availability, in the contract's reason copy. `unknown` is
"Availability unknown — retry", never unavailable. All four reads bypass HTTP caches, refuse redirects and
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
