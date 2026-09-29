# EZiL Models (`ezil.ezil-models`)

A VS Code `LanguageModelChatProvider` (vendor `ezil`) that makes the open-source **Copilot Chat UI** bundled in
code-server 4.139.1 / VS Code 1.139 run entirely on EZiL-configured models — **no GitHub account**. It reads one
JSON config file where you "just put the key" and talks directly to:

| `providers.<name>.type` | Endpoint | Auth header |
|---|---|---|
| `anthropic` | `https://api.anthropic.com/v1/messages` | `x-api-key` |
| `anthropic-foundry` | `https://<resource>.services.ai.azure.com/anthropic/v1/messages` (Claude on Microsoft Foundry; `model` = deployment name) | `x-api-key` + `anthropic-version: 2023-06-01` |
| `openai` | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer` |
| `azure-openai` | `https://<resource>.openai.azure.com/openai/v1/chat/completions`, or a Foundry `baseUrl` `https://<resource>.services.ai.azure.com/openai/v1` | `api-key` |
| `openai-compatible` | `<baseUrl>/chat/completions` (vLLM, Ollama, LiteLLM, a local mock...) | `Authorization: Bearer` when a key is set |

Everything Copilot Chat sends is supported: the **System** role (proposed `languageModelSystem`, value 3), tool
definitions and **tool calling** (39 tools in Agent mode), tool results, **images** (base64 → Anthropic `image`
blocks / OpenAI `image_url` data URLs), PDFs (Anthropic `document`), **thinking** (adaptive/effort, replayed with
signatures; emitted as `LanguageModelThinkingPart` when the proposal is available, dropped otherwise) and
**Anthropic prompt caching** (Copilot's own `cache_control` markers are honoured and automatic breakpoints are
added on the system prompt, the last user turn and the tool list — never more than 4, TTL `5m` or `1h`).
Streaming responses, cancellation, per-request usage logging and readable errors (401/403/404/429 with
`retry-after`, overloaded, unreachable host) are built in. Zero runtime dependencies: `fetch` + a small SSE parser.

## Config file

Default path `/etc/ezil/models.json`; override with the setting `ezilModels.configPath` or the environment
variable `EZIL_MODELS_CONFIG` (wins). The file is watched — edits are picked up without a reload and the model
list in the chat UI refreshes. JSON Schema: [`schema/models.schema.json`](schema/models.schema.json); a full example
covering every provider type: [`examples/models.example.json`](examples/models.example.json).

```jsonc
{
  "providers": {
    "anthropic":      { "type": "anthropic",         "apiKey": "{env:ANTHROPIC_API_KEY}" },
    "foundry-claude": { "type": "anthropic-foundry", "resource": "my-foundry-resource", "apiKey": "{file:/run/secrets/foundry-api-key}" },
    "foundry-openai": { "type": "azure-openai",      "baseUrl": "https://my-foundry-resource.services.ai.azure.com/openai/v1", "apiKey": "{env:AZURE_API_KEY}" },
    "openai":         { "type": "openai",            "apiKey": "{env:OPENAI_API_KEY}" },
    "local-mock":     { "type": "openai-compatible", "baseUrl": "http://127.0.0.1:18792/v1", "apiKey": "test-key" }
  },
  "models": [
    { "id": "opus-5.5", "name": "Claude Opus 5.5", "provider": "anthropic", "model": "claude-opus-5-5",
      "maxInputTokens": 200000, "maxOutputTokens": 128000,
      "thinking": { "type": "adaptive", "effort": "medium" }, "cache": { "ttl": "5m" },
      "default": true, "roles": ["default", "plan"] },
    { "id": "haiku-4.5", "name": "Claude Haiku 4.5", "provider": "anthropic", "model": "claude-haiku-4-5",
      "roles": ["utility", "utilitySmall"] },
    { "id": "foundry-sonnet-5", "name": "Claude Sonnet 5 (Foundry)", "provider": "foundry-claude", "model": "claude-sonnet-5",
      "thinking": { "type": "adaptive", "effort": "high" }, "cache": { "ttl": "1h" } },
    { "id": "gpt-5.5-foundry", "name": "GPT-5.5 (Foundry)", "provider": "foundry-openai", "model": "gpt-5.5",
      "maxInputTokens": 272000, "thinking": { "type": "adaptive", "effort": "medium" } },
    { "id": "mock", "provider": "local-mock", "model": "mock-model", "maxInputTokens": 32000, "maxOutputTokens": 4096 }
  ]
}
```

- `apiKey`, `baseUrl`, `resource`, `apiVersion` and `headers` values may be literals, **`{env:NAME}`** or
  **`{file:/path}`** (absolute path recommended; a relative one resolves against the extension host's cwd; the file's
  content is trimmed); references are resolved when the file loads. Resolved secrets are redacted from every log line.
  While the file is being edited and is momentarily invalid, the previously loaded models stay available and the
  error is shown in **EZiL Models: Manage**.
- `models[].id` is what VS Code sees (unique, case-insensitive); `models[].model` is the provider model id or the
  Azure deployment name. `family` defaults to `claude` / `gpt`.
- `maxInputTokens` (default 200000) is the budget VS Code enforces before sending — set 1000000 only for models
  and keys with 1M context enabled. `maxOutputTokens` defaults to 64000 (Claude) / 32768.
- `thinking`: `{ "type": "adaptive", "effort": "low|medium|high|xhigh|max", "display": "summarized" }` for
  Claude 4.6+ (Opus 5/5.5, Sonnet 5, Fable 5.1 — sent as `thinking` + `output_config.effort`);
  `{ "type": "enabled", "budgetTokens": 8192 }` for Haiku 4.5 and older (400 on 4.7+). `"disabled"` is rejected by
  Opus 5.5 / Fable (thinking cannot be turned off there; lower `effort` instead). `"display": "updates"` (progress
  notes between tool calls, Fable 5.x / Opus 5.5) adds the `thinking-display-updates-2026-08-18` beta header
  automatically. For OpenAI/Azure the effort maps to `reasoning_effort` (`xhigh`/`max` → `high`). Omit for no
  thinking parameter.
- `cache`: Anthropic prompt caching, on by default for Anthropic providers; `ttl` `5m` (default) or `1h`.
- `forcedToolChoice` defaults to `false` for Opus 5.5 / Fable 5.x (they return 400 on `tool_choice: any`) and
  `true` otherwise; when false a "required" tool call from Copilot is sent as `auto`. It is also sent as `auto`
  whenever `thinking` is configured (other than `disabled`): the API only accepts `tool_choice` `auto`/`none`
  together with extended or adaptive thinking. Copilot's own Anthropic provider never sends `tool_choice`.
- `temperature` is passed through only when `thinking` is absent or `disabled`; Opus 4.7+, Sonnet 5, Opus 5/5.5 and
  Fable reject sampling parameters altogether (400), so leave it unset for those models.
- `defaults` holds per-model defaults merged into every entry; `roles` document which Copilot Chat slot a model is
  meant for (used by the settings snippet below).

## Pairing with the Copilot Chat UI

Copilot Chat 0.67 only lists third-party models when anonymous access is on. Machine settings
(`<user-data-dir>/Machine/settings.json`, or the image's default settings):

```jsonc
{
  "chat.allowAnonymousAccess": true,          // unlock the chat UI without a GitHub account
  "chat.byokUtilityModelDefault": "mainAgent",// title/progress-message calls go to the EZiL model too
  "chat.defaultModel": "opus-5.5",            // bare EZiL model id (matched case-insensitively on id, then family)
  "chat.planAgent.defaultModel": "opus-5.5",  // same format
  "chat.utilityModel": "ezil/haiku-4.5",      // vendor/id format
  "chat.utilitySmallModel": "ezil/haiku-4.5",
  "chat.titleBar.signIn.enabled": false
}
```

`chat.defaultModel` is resolved by `modelSelection.ts#resolveConfiguredModel` (VS Code 1.139): the value is compared
with each model's **`id`** (then `family`), case-insensitively — not `ezil/<id>`. The utility-model settings
instead store `vendor/id`. **EZiL Models: Manage → Copy settings snippet** generates this block from the `roles` in
your config. Note that in anonymous mode the picker shows *Auto* and *Manage Models…*; *Auto* resolves to the
tool-capable third-party model (every EZiL model advertises `toolCalling` + `imageInput`), and individual models
are toggled in the *Language Models* editor.

## Commands and settings

- **EZiL Models: Manage** (`ezil-models.manage`, also the gear next to the vendor in *Manage Models*): open the
  config, reload, show token usage, copy the settings snippet, list models.
- **EZiL Models: Reload Config**, **Open Config File** (offers to create a template when missing), **Show Token
  Usage** (per-model request count, input/output/cache-read/cache-write tokens, average latency).
- `ezilModels.logRequests` (default off): print every request body (keys redacted, base64 payloads shortened) to
  the *EZiL Models* output channel — the easiest way to see exactly what Copilot Chat sends (10.5K-char system
  prompt, 39 tools, `<environment_info>`/`<workspace_info>` turns, tool results). Usage lines
  (`input=… output=… cache_read=… cache_write=…`) are always logged.

## Local mock endpoints

`tests/fixtures/mock-anthropic.ts` and `tests/fixtures/mock-openai.ts` are dependency-free in-process servers that
also run standalone: `MOCK_PORT=18791 MOCK_API_KEY=test-key bun tests/fixtures/mock-anthropic.ts` then point a
provider at it (`{ "type": "anthropic", "baseUrl": "http://127.0.0.1:18791", "apiKey": "test-key" }`, or
`{ "type": "openai-compatible", "baseUrl": "http://127.0.0.1:18792/v1", "apiKey": "test-key" }`). They answer
"create hello.txt containing hi" with a `create_file` tool call and "Done." after the tool result, simulate cache
reads on repeated system prompts, and expose error models (`mock-401`, `mock-429`, `mock-refusal`...).

## Development

```sh
bun install --frozen-lockfile
bun run typecheck      # tsc against @types/vscode 1.106.1
bun test               # 47 tests: converters on real Copilot Chat captures, SSE, config, config store, provider round trips
bun run build          # dist/extension.js (bun bundle, cjs, `vscode` external)
bun run package:vsix   # ezil-models-0.1.0.vsix via @vscode/vsce
```

`tests/fixtures/copilot-*.json` are unmodified requests captured from Copilot Chat 0.67 talking to a probe
provider inside code-server 4.139.1 (see `/workspace/copilot-byok-test/REPORT.md`): the Agent-mode tool round
trip (system prompt, 39 tools, `tool_call` → `tool_result`), a drag-and-drop image attachment and a utility-model
progress-message request. The converter tests assert the exact Anthropic and OpenAI bodies built from them.
`tests/live.test.ts` runs a two-turn smoke against a real endpoint and asserts `cache_read_input_tokens > 0` on the
second turn when `/workspace/secrets/foundry.env` (or `EZIL_LIVE_ENV`) exists; it is skipped otherwise.

Token counting (`provideTokenCount`) is a local estimate (chars / 3.4, images 1600) that deliberately over-counts a
little; Anthropic's `count_tokens` endpoint is not called because VS Code invokes the hook for every prompt part.

## Proposed API notes

`enabledApiProposals` lists `languageModelSystem` and `languageModelThinkingPart`. code-server 4.139.1 enables
all proposals for every extension; on builds where they are not enabled the extension still works: the System
role is recognised by its numeric value (3) and thinking parts are only emitted when `vscode.LanguageModelThinkingPart`
exists. Without that class Copilot cannot hand thinking blocks back, so `thinking: { "type": "enabled" }` (Haiku 4.5
and older, where the API insists on the previous thinking block before a `tool_use`) would fail on the second turn of
a tool loop — prefer `adaptive` models there. The `isDefault` / `isUserSelectable` fields of the proposed
`chatProvider` API are set on the model information and are ignored where that proposal is absent.

## What Copilot Chat actually sends to a third-party vendor

Facts from `vscode-copilot-chat` 0.67 that shaped the converter (see `src/anthropic.ts`):

- **Cache markers**: Copilot emits its `cache_control` data parts only for the vendors in
  `CacheBreakpointAwareModelVendors` (`anthropic`, `gemini`, `openrouter`). Vendor `ezil` never receives them, so
  the automatic breakpoints (system prompt, last user turn, tool list) are what makes prompt caching work. Markers are
  still honoured if they ever arrive: one inside a tool result marks the `tool_result` block itself, one ahead of a
  message's first block marks the previous message's last block, and no filler block is ever fabricated, so the
  4-breakpoint budget is always counted correctly.
- **Thinking replay**: response thinking is streamed as `LanguageModelThinkingPart` deltas plus one final part whose
  `metadata` holds `{ signature, _completeThinking }` (Copilot merges them into one `ThinkingDataItem`, keeping the
  last metadata) and is replayed as a `thinking` block with that exact text and signature — unchanged, as the API
  requires. A block without a signature is not replayable and is left out instead of triggering a 400.
- **Tool pairing**: every `tool_use` must be answered by a `tool_result` in the very next message and vice versa.
  Copilot keeps its history paired, but a cancelled turn can leave a call unanswered: the converter then inserts an
  `is_error` result ("No result was recorded for this tool call.") and turns an orphaned result into a text block.
- **Errors and logs**: URLs, upstream error bodies and request dumps are passed through `redact()` with every
  resolved secret before they reach the output channel or the chat UI.

## Vendor id `ezil` — do not co-install `extensions/ezil-vscode`

`extensions/ezil-vscode` (the broker-based BYOK connector) also contributes `languageModelChatProviders` with
`vendor: "ezil"`. VS Code allows one provider per vendor id: whichever extension registers second fails with
"vendor ezil is already registered" and its models never appear. This extension keeps `ezil` because it is the one
shipped in the desktop image; install exactly one of the two.

## How the image installs it

`worker/Dockerfile` (the desktop image local mode and the hosted Worker run) makes this extension the model
provider behind the bundled Copilot Chat panel, revision 2 of the image:

- **Built-in.** `worker/ezil-models/build-vsix.sh` packages this directory into the committed
  `worker/ezil-models/dist/ezil-models-<version>.vsix` (the source is outside the `worker/` build context; run it
  from a clean checkout and commit the VSIX after every source change — `build-vsix.sh --check` fails when it is
  stale). The Dockerfile unpacks it into `/usr/lib/code-server/lib/vscode/extensions/ezil-models`, next to the
  kept `copilot` built-in, and fails the build unless `contributes.languageModelChatProviders` names vendor `ezil`.
- **Config.** `worker/ezil-models/models.json` is copied to `/etc/ezil/models.json` and `EZIL_MODELS_CONFIG` is set
  to that path. It declares providers `anthropic` (`{env:ANTHROPIC_API_KEY}`), `foundry-anthropic` and
  `foundry-openai` (both `{env:AZURE_RESOURCE_NAME}` + `{env:AZURE_API_KEY}`) and `openai`
  (`{env:OPENAI_API_KEY}`), and models `claude-opus-5-5` (default, plan), `claude-sonnet-5`, `claude-fable-5-1`,
  `claude-haiku-4-5` (utility), a Foundry Claude deployment and example Foundry / OpenAI GPT deployments. A build
  gate rejects any literal key. **Set the variables on the container and the models appear**; because the file is
  validated as a whole, a variable that is *not* set makes the extension serve no models and name the variable in
  the *EZiL Models* output channel — point `EZIL_MODELS_CONFIG` at a smaller file (or remove that provider and its
  models) if you only have some of the keys.
- **Settings.** `worker/scripts/start-neko.sh` (and `start-codeserver.sh`) write `<user-data-dir>/Machine/settings.json`
  on every boot with `chat.allowAnonymousAccess: true`, `chat.byokUtilityModelDefault: "mainAgent"`,
  `chat.titleBar.signIn.enabled: false`, `chat.welcomePage.signIn.enabled: false`, `github.copilot.enable: {"*": false}`
  and `workbench.secondarySideBar.defaultVisibility: "visible"`, and seed `<user-data-dir>/User/chatLanguageModels.json`
  with `[{ "name": "EZiL", "vendor": "ezil" }]` (merged into groups a user added). Anonymous access is what makes a
  cold browser activate Copilot Chat and route the very first prompt here; the group is what flips
  `github.copilot.hasByokModels` and hides the sign-in affordances. The model pins from "Pairing with the Copilot
  Chat UI" (`chat.defaultModel` etc.) are not written by the image — *Auto* resolves to the tool-capable EZiL model
  and individual models are toggled in the Language Models editor.
- **Proof.** `e2e/copilot-ezil-image.sh <image>` boots the image, points this extension at an in-container mock
  (`e2e/copilot-ezil-models.json` via `EZIL_MODELS_CONFIG`, `e2e/copilot-ezil-mock-provider.mjs`) and drives a fresh
  browser: Chat view active, no sign-in dialog, an Agent-mode `create_file` round trip that lands in the workspace,
  the EZiL model listed in Manage Models — then again as a returning user whose persisted settings say the opposite.
