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
  **`{file:/path}`**; references are resolved when the file loads. Resolved secrets are redacted from every log line.
- `models[].id` is what VS Code sees (unique, case-insensitive); `models[].model` is the provider model id or the
  Azure deployment name. `family` defaults to `claude` / `gpt`.
- `maxInputTokens` (default 200000) is the budget VS Code enforces before sending — set 1000000 only for models
  and keys with 1M context enabled. `maxOutputTokens` defaults to 64000 (Claude) / 32768.
- `thinking`: `{ "type": "adaptive", "effort": "low|medium|high|xhigh|max", "display": "summarized" }` for
  Claude 4.6+ (Opus 5/5.5, Sonnet 5, Fable 5.1 — sent as `thinking` + `output_config.effort`);
  `{ "type": "enabled", "budgetTokens": 8192 }` for Haiku 4.5 and older. For OpenAI/Azure the effort maps to
  `reasoning_effort` (`xhigh`/`max` → `high`). Omit for no thinking parameter.
- `cache`: Anthropic prompt caching, on by default for Anthropic providers; `ttl` `5m` (default) or `1h`.
- `forcedToolChoice` defaults to `false` for Opus 5.5 / Fable 5.x (they return 400 on `tool_choice: any`) and
  `true` otherwise; when false a "required" tool call from Copilot is sent as `auto`.
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
bun test               # 37 tests: converters on real Copilot Chat captures, SSE, config, provider round trips
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
exists. The `isDefault` / `isUserSelectable` fields of the proposed `chatProvider` API are set on the model
information and are ignored where that proposal is absent.
