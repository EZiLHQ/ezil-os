# Build-time patches to the bundled Copilot Chat ("EZiL Chat")

`patch-copilot-chat.sh` is applied by `worker/Dockerfile` to the code-server
**4.141.0** amd64 .deb (Code 1.141.0, GitHub.copilot-chat 0.69.0 built in at
`lib/vscode/extensions/copilot`). Every patch below is an exact-match anchor
in a shipped minified file, with the occurrence count the script requires
BEFORE patching and the grep gate it checks AFTER (`--verify` re-runs the
gates alone). If a code-server bump moves a string, the Docker build fails
with the offending anchor printed; re-derive it from the new bundle (grep the
source tree at the matching `microsoft/vscode` tag — the anchors are the
compiled form of the files named below) and update both the script and this
table. Only the documented strings, network call sites, visibility filters and the chat history index (Part 3) change: no command id, setting key, contribution point,
`product.json` field or LICENSE file is changed. The original work stays
MIT, Copyright (c) Microsoft Corporation; each patched `.js` gets a one-line
"Modified at build time by EZiL" notice (see `ATTRIBUTIONS.md`).

Why these and not settings: `telemetry.telemetryLevel: off` (Machine seed) and
`--disable-telemetry` already silence the 1DS/GitHub telemetry senders and
the experiment service (no `copilot-telemetry.githubusercontent.com`,
`*.events.data.microsoft.com`, `default.exp-tas.com` or
`dc.services.visualstudio.com` traffic was observed on revision 2); the
calls below have **no** setting. Measured before/after in
`/workspace/ezil-plan/rev3-network-audit.md`.

## Part 1 — no GitHub service calls (extension host bundle)

File: `extensions/copilot/dist/extension.js`

| id | source | anchor (exact) | replacement | count | why | gate |
|---|---|---|---|---|---|---|
| `token` | `platform/authentication/vscode-node/copilotTokenManager.ts` `_auth()` anonymous branch | `this._logService.info("Allowing anonymous access with devDeviceId");let a=await this.authFromDevDeviceId(yGe.env.devDeviceId);` | `this._logService.info("EZiL Chat: anonymous mode, GitHub token minting (copilot_internal/v2/nltoken) disabled at build time");let a={kind:"failure",reason:"GitHubLoginFailed"};` | 1 | With `chat.allowAnonymousAccess` the extension mints a Copilot token for the device id at `GET api.github.com/copilot_internal/v2/nltoken` (and retried it 9x in 8 s when the call failed). The token is only used for Copilot-hosted models/utility calls, which EZiL never uses (`chat.byokUtilityModelDefault: mainAgent`). Returning the same failure the unreachable server produces keeps every consumer on its existing no-token branch (BYOK path measured healthy). `yGe` is the minified `vscode` import — part of the anchor on purpose. | anchor 0, replacement 1, `await this.authFromDevDeviceId(` 0 |
| `known-models` | `extension/byok/vscode-node/byokContribution.ts` `_fetchKnownModelList` | `this._logService.info("BYOK: fetching known models list");let r=await(await n.fetch("https://main.vscode-cdn.net/extensions/copilotChat.json",{method:"GET",callSite:"byok-known-models"})).json();` | `this._logService.info("EZiL Chat: BYOK known-models CDN fetch disabled at build time, using an empty list");let r={version:1,modelInfo:{}};` | 1 | Runs once when the BYOK providers register: downloads the model catalogue for Copilot's *own* BYOK vendors (Anthropic/Gemini/xAI/OpenAI pickers). EZiL models come from the `ezil` provider, so the empty list — exactly what the code falls back to when the fetch fails — is equivalent. | anchor 0, replacement 1, the CDN URL 0 |

| `embeddings-cache` / `embeddings-latest` / `embeddings-ext` | `platform/embeddings/common/embeddingsIndex.ts` `fetchRemoteCache`, `fetchRemoteCacheLatest`, `fetchRemoteExtensionCache` | `async fetchRemoteCache(){if(this._remoteCacheEntries)return this._remoteCacheEntries;let e=await this.getRemoteCacheURL();try{` / `async fetchRemoteCacheLatest(){let e=await this.getRemoteCacheLatestUpdateURL();try{` / ``async fetchRemoteExtensionCache(n){let o=`${await this.getBaseExtensionCDNURL()}/${n}.json`;try{`` | the same with an early `return;` (`return{};` for the extension variant — the value the code returns on a 404) inserted after the cache short-circuit | 1 / 1 / 1 | The tool/settings/command embeddings index fetches `https://embeddings.vscode-cdn.net/<container>/v<n>/<type>/{latest.txt,core.json,<extension>.json}` during Agent-mode requests (seen once Ask/Plan/agent tooling ran without a Copilot token; not on the rev2 boot path). Without the Copilot embeddings API (needs a token) the CDN copy is the only source, so returning "no remote cache" is exactly today's offline behaviour; the local memento cache is still used. | anchors 0, replacements 1 each |

Not patched, by measurement: model metadata (`api.githubcopilot.com/models`) and `[CopilotCLIModels]` fetches first call `getCopilotToken()`, which now fails locally, so they return before any request; the core workbench makes no entitlement call without a GitHub account; the agent-host runtime (`@github/copilot-sdk`) starts but is disabled in the web workbench (`enabled = !isWeb && !chat.disableAIFeatures`) and made no request; the Copilot CLI MCP server and its OTel exporter are local (unix socket / file).

Handled outside the script: code-server's own release check (`GET api.github.com/repos/coder/code-server/releases/latest`) → `--disable-update-check` in both launchers; applicationinsights Statsbeat (`POST westus-0.in.applicationinsights.azure.com/v2.1/track`, SDK-internal, not gated by the telemetry level, and the SDK reads `APPLICATION_INSIGHTS_NO_STATSBEAT` at module load — before the bundle's own `process.env` assignment) → `ENV APPLICATION_INSIGHTS_NO_STATSBEAT=true` in the Dockerfile; belt and braces: `seed_blocked_ai_hosts` maps the Copilot/telemetry-only hosts to 127.0.0.1 in `/etc/hosts` at boot (never `github.com`/`api.github.com` — developer tooling needs them).

## Part 1b — Summarization render budget (extension host bundle)

File: `extensions/copilot/dist/extension.js`, the agent intent's `buildPrompt`
(`extension/intents/node/agentIntent.ts`). Not a string patch: one argument of one render call
changes. Kept next to Part 1 so the `extension.js` sections stay together and Part 2 stays whole.

Facts from the pinned 0.69.0 bundle (pristine `extension.js` sha256 `e32a017f…`):

- `buildPrompt` counts the request's tools (`p = countToolTokens(availableTools)`), takes `h`, the
  model's advertised `maxInputTokens` (ezil-models advertises 120480 for Qwen and Kimi), and renders
  the normal agent prompt with `I = this.endpoint.cloneWithTokenOverride(E)`,
  `E = max(1, floor((h - p) × 0.9))`. With no tools `I` is `this.endpoint`. `E` is unbounded only when
  `y` holds: `apiType === "responses"` and `chat.advanced.useResponsesApiTruncation`.
- When that render throws `BudgetExceededError` and no background summary can be applied, `U`
  re-renders with `triggerSummarize`/`forceSimpleSummary`: it asks the model for a summary of the
  older rounds, then renders the prompt with it. Upstream `U` renders with `this.endpoint`, the full
  advertised budget, although the same request still carries every tool. Its prompt can pass Copilot
  and still exceed what the model accepts with the tools: ezil-models then refuses it locally
  (`gateway-messages.ts`, body + 1056 > 131072 bytes); with 39 agent tools (53.5 KB) that is any `U`
  render over about 76 KB of messages.
- `vn.create(instantiationService, endpoint, …)` uses its endpoint argument as the prompt-tsx
  budget and installs it as `IPromptEndpoint`; the agent prompt caps tool results at
  `IPromptEndpoint.modelMaxPromptTokens × 0.5` (`Oro`). The props' `endpoint` is the summarizer's:
  `getSummary` renders the summary prompt and sends the summary request through `props.endpoint`,
  and in simple mode (`forceSimpleSummary`) sends no tools.

| id | anchor (exact) | replacement | count | gate |
|---|---|---|---|---|
| `summarize-budget` | `return await vn.create(this.instantiationService,this.endpoint,this.prompt,{...we,endpoint:this.endpoint,promptContext:we.promptContext,triggerSummarize:!0,forceSimpleSummary:!0}).render(r,o)` | the same with the renderer's endpoint `this.endpoint` replaced by `I`; the props keep `endpoint:this.endpoint` | 1 | anchor 0, replacement 1 |
| `summarize-names` | checked, never patched: `x=Math.max(1,Math.floor((h-p)*.9)),E=y?Number.MAX_SAFE_INTEGER:x,I=p>0?this.endpoint.cloneWithTokenOverride(E):this.endpoint;` and the head of `U`, `U=async(oe,we=T)=>{let Ie=n.conversation?.getLatestTurn()?.getMetadata(Kh);` | — | 1 each | before and after |
| `summarize-fallback-unpatched` | `B`, checked, never patched: `let he=vn.create(this.instantiationService,this.endpoint,this.prompt,{...we,endpoint:this.endpoint,enableSummarization:!1,enableCacheBreakpoints:!1});` | — | 1 | before (with `summarize-names`) and after; a patched `B` fails `--verify` |
| `summarize-scope` | `I`'s definition, then `B`, then `U`'s head, then `U`'s render, all within 4096 characters, and nothing between `I` and the render that may bind another `I` (`let/const/var I`, `I=>`, `(I,`, `,I)`, `,I=`) | — | — | before and after |

Effect: `U` renders the summary and the rounds kept after it in the same budget as the normal
render, so the request it builds fits with its tools. The summary request is unchanged (full
endpoint, no tools). With no tools `U` is upstream's. `U`'s tool-result cap follows `I`: it equals
the normal render's cap, but it is lower than upstream `U`'s (`floor(I × 0.5)` instead of 60,240;
numbers below). A result over the cap is cut in that one request, which carries the marker
`[Tool response was too long and was truncated.]`; the stored result is intact.

Why `U` throws instead of pruning (read from the bundle, not executed): `U` spreads the normal
render's props `T`. `T.enableCacheBreakpoints` is `_ && !D` (`D = apiType === "messages"`), which is
true for EZiL models. The last cache breakpoint sits on the last tool result, and prompt-tsx's
pruning discards every candidate before a node that holds a breakpoint, so an over-budget `U` raises
`BudgetExceeded`. Only `B` sets `enableCacheBreakpoints: false`, so only `B` prunes.

`y` and `D` are false for EZiL models: an extension model's `apiType` comes only from
`capabilities.apiType` (the `Ok` endpoint constructor), the extension host passes it on only when
the provider declares one, and `extensions/ezil-models` declares none. Re-check this Part if it ever
declares any `apiType`:

- `responses` with `chat.advanced.useResponsesApiTruncation` makes `E` unbounded (`y`).
- `messages` sets `D`. That turns cache breakpoints off for the normal render and `U`, so they
  prune older rounds out of the request silently instead of throwing and summarizing, and this
  Part's analysis no longer holds. The tool-call round element's thinking-in-history choice also
  reads `apiType`.

The offline test fails on any `apiType` in `extensions/ezil-models/src`, whatever its value or form.

When `U` does not fit: a summary larger than its share of `I` (`Summary too large`) or a
post-summary prompt still over `I` records a failed foreground summarization on the turn and falls
to `B`; later renders in that turn go straight to `B` ("skipping repeated foreground summarization
after prior failure"). The summary request has already been sent, and charged, before either
check, as upstream whenever a summary fails. As upstream, the summarizer writes the summary onto
the summarized round object before the render that fails, so a later render that honours round
summaries can still use it (read, not executed). The share can be small: with 64 tools `I` is
27,304 (below) and the system prompt and other fixed parts take part of it, so a long Kimi summary
(`maxOutputTokens` 4096) counted in bytes can exceed its share (read, not executed).

**Release order and the residual band.** `I` is only as large as Copilot's tool count leaves it.
For the shipped catalogue (Qwen and Kimi, Messages protocol, `h` = 120480), ezil-models sends a
request only when its body + 1056 ≤ 131072 bytes and otherwise refuses it locally
(`local_input_too_large`, `buildGatewayBody`). Copilot counts through ezil-models'
`provideTokenCount`, in bytes:

| tools (real bytes) | `p` / `I`, ezil-models as of 7b95bcd9 | `p` / `I`, string count of 2048e710 (VSIX 4f1245a2) | prompt that fits with the tools | residual band with the 2048e710 count |
|---|---|---|---|---|
| 39 (53,535) | 88,254 / 29,003 | 57,539 / 56,646 | ~76,481 | (56,646, ~76,481] |
| 64 (83,921) | — / 1 | 90,142 / 27,304 | ~46,095 | (27,304, ~46,095] |

`I = max(1, floor((120480 − p) × 0.9))`; the fitting prompt is 131072 − 1056 − the real tool bytes,
less the request envelope. `p` for 2048e710 is that commit's measurement over the 39 agent tools
captured from Copilot Chat 0.67 requests (64 = those plus 25 renamed copies); the numbers move with
the tool set.

The release order narrows the band; it does not close it. For a post-summary prompt inside the
band, upstream `U` at 120480 builds it and it fits with the tools. Patched `U` throws
`BudgetExceeded` after the summary request was sent and charged. The turn records
`{source: "foreground", outcome: "budgetExceeded"}` and `B` renders the rest of the turn: the
current turn's rounds unsummarized (earlier turns keep summaries already stored on them), at
120480, tools not subtracted. `B` succeeds only when that
prompt fits the model's bound. Usually it does not, because it is larger than the post-summary
prompt that was already over `I`. ezil-models then refuses it locally: nothing is sent for that
request, and with the ezil-models error change the refusal is a precise local error. Upstream
succeeds there.

The gain: `U`'s tool-result cap falls from 60,240 to `floor(I × 0.5)`, which is 28,323 for 39
tools and 13,652 for 64 with the 2048e710 count (14,501 for 39 with today's count). A single large
last-round result that upstream `U` kept whole, and ezil-models refused with the tools, now fits. It
is cut in that request with the marker, and the stored result is intact.

Release gate: ship this Part only in an image that also installs the ezil-models VSIX 4f1245a2 or
later. `worker/Dockerfile` installs the committed `worker/ezil-models/dist/ezil-models-0.1.0.vsix`,
so source commit 2048e710 alone changes nothing in the image. With today's VSIX, 64 tools give
`I` = 1, so every render is over budget: each turn sends a charged summary that cannot fit, then
goes to `B`. Nothing
in this script enforces the order. The band above remains with the right VSIX, and shipping this
Part means accepting it.

**What `B` does after this change.** `B` is not patched; it is upstream "rendering without
summarization", reached after a failed `U`, after a background summary whose re-render still
exceeds `I`, and for the rest of a turn after a foreground failure. It renders at `this.endpoint`
(the advertised budget, tools not subtracted), and as upstream, prompt-tsx may leave older rounds
out of that one request to fit; the stored conversation (Part 3 files and index) is not touched.
A prompt that cannot fit even that budget fails with upstream's
`Unable to build prompt, modelMaxPromptTokens = 120480 (…)`. A prompt that fits Copilot's budget
but, with the tools, exceeds the model's input bound is refused by ezil-models before anything is
sent; with the ezil-models error change that refusal is a precise local error (nothing was sent or
charged; the history is kept) instead of "Conversation too large or invalid — start a new chat".
Patching `B` to `I` was rejected: `B` would then succeed by leaving out more of the conversation
without telling the user.

Offline test against the pristine bundle (patches a copy, then runs the real `buildPrompt` span from
the patched bundle with Copilot's own endpoint, tokenizer and helper code; the renderer factory,
prompt-tsx's error class and the services are stubbed and record the endpoint each render gets):

```sh
COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/summarize-budget-patch.test.cjs
```

It checks that `U` renders with `I` while the summarizer keeps the full endpoint, that the unpatched
bundle renders `U` at 120480 (negative control), that `B` renders at the full endpoint after a failed
`U` and after a prior failure and raises upstream's error when over, that no tools leave `U`
upstream, that `y` and `D` are false for EZiL models (with a Responses control that makes `E`
unbounded and a Messages control that turns cache breakpoints off), that no ezil-models source
mentions `apiType`, and that the gates reject a restored `U`, a patched `B`, a moved `I` and a
rebound `I`. Not executed: prompt-tsx's budget enforcement and cache-breakpoint pruning rule, and
`vn.create` installing `IPromptEndpoint` (read from the bundle as above).

## Part 2 — "EZiL Chat" branding (strings only)

### System prompt identity — `extensions/copilot/dist/extension.js`

| id | source | anchor | replacement | count | gate |
|---|---|---|---|---|---|
| `identity` | `extension/prompts/node/base/copilotIdentity.tsx` (+ `intentDetector.tsx`, `minimaxPrompts.tsx`, `familyHPrompts.tsx` and other prompt files sharing the sentence) | `When asked for your name, you must respond with "GitHub Copilot".` | `You are EZiL Chat, an AI coding assistant. When asked for your name, you must respond with "EZiL Chat".` | 13 | anchor 0, replacement 13 |
| `identity-model` | `minimaxPrompts.tsx`, `familyHPrompts.tsx` | `you must state that you are using GitHub Copilot.` | `you must state that you are using EZiL Chat.` | 2 | anchor 0, replacement 2 |

### Workbench strings — `out/nls.messages.js` **and** `out/nls.messages.json`

The workbench addresses its English strings by index into this array
(`localize(<index>, …)`); the literal in `workbench.js` is only a fallback.
Both files are patched identically and a gate checks they stay element-for-
element equal. Resolve indices from the pinned `out/nls.keys.json`; they move between releases.

| id | nls key (index) | anchor (JSON-quoted) | replacement | count | why |
|---|---|---|---|---|---|
| `terms-dot` | `vs/workbench/contrib/chat/browser/widget/chatWidget#settings` | `"By continuing with {0} Copilot, you agree to {1}'s [Terms]({2}) and [Privacy Statement]({3})."` | `"AI responses may be inaccurate. Review changes before applying them."` | 1 | The chat-welcome disclaimer, shown whenever `chatEntitlementService.anonymous && !sentiment.completed` — i.e. always, in EZiL's configuration; no setting hides it. No links. |
| `terms` | `chatStatus/chatStatusDashboard#activeDescriptionAnonymous`, `widgetHosts/chatQuick#termsDisclaimer`, `inlineChat/browser/inlineChatWidget#termsDisclaimer`, `welcomeGettingStarted/common/gettingStartedContent#gettingStarted.copilotSetup.terms` | same text without the trailing period | same | 4 | The same sentence in the status hover, quick chat, inline chat and Getting Started. |
| `status-aria` | `chatStatus/chatStatusEntry#chatStatusAria` | `"Copilot status"` | `"EZiL Chat status"` | 1 | Legacy status-bar aria label. R2-D below suppresses this entry without disabling chat. |
| `status-name` | `chatStatusEntry#chatStatus` | `"Copilot Status"` | `"EZiL Chat Status"` | 1 | Status-bar item name (context menu / hide list). |
| `status-resumed` / `status-disabled` | `chatStatusEntry#chatResumedStatus` / `#copilotDisabledStatus` | `"Copilot Resumed"` / `"Copilot disabled"` | `"EZiL Chat resumed"` / `"EZiL Chat disabled"` | 1 / 1 | Other texts the same item can show. |
| `enable-more` | `chatStatusDashboard#enableMoreDescription` | `"Sign in to enable more Copilot AI features."` | `"EZiL Chat runs on the models configured for this workspace."` | 1 | Status hover footer. Its button ("Enable more AI Features") still opens VS Code's GitHub sign-in flow; that flow's own dialogs are the real GitHub sign-in and are left as they are. |

Gates: every anchor 0, every replacement at its count, `By continuing with {0} Copilot` 0, both files parse (`.js` evaluated in a VM, `.json` parsed) and are identical element-wise.

### EZiL notice under the chat input — `out/vs/code/browser/workbench/workbench.css`

| id | source | anchor | replacement | count | why |
|---|---|---|---|---|---|
| `chat-notice` | `vs/workbench/contrib/chat/browser/widget/media/chatViewWelcome.css` `.interactive-session.chat-view-getting-started-disabled { … }` (nested) | `.chat-welcome-view .chat-welcome-view-message,.chat-welcome-view .chat-welcome-view-disclaimer,.chat-welcome-view .chat-welcome-view-tips{display:none}`, left as it is (gated once) | appended to the end of the file, top level: `.chat-viewpane .interactive-session>.interactive-input-part::after{content:"AI responses may be inaccurate. Review changes before applying them.";…}` | 1 | `chatWidget.ts` adds `chat-view-getting-started-disabled` whenever `sentiment.completed \|\| hasByokModels` — always, with the `ezil` group present — and the upstream rule hides the welcome's message, disclaimer and tips; with the Sessions list on (Part 3), an empty chat shows that list instead of the welcome anyway. The notice therefore leaves the welcome: one muted line under the chat view's input, in every chat state (empty, running, finished), counted in the input part's height so the Sessions list and transcript lay out above it. Only the chat view (`.chat-viewpane`), not inline or editor chats. Appended, not placed beside the upstream rule: that rule sits in a nested block, so a neighbour would be nested too and match nothing (measured in the image e2e). Gates: the upstream rule once, the notice rule once, and at brace depth 0. |

### Accounts menu — `out/vs/code/browser/workbench/workbench.js`

| id | source | anchor | replacement | count | why |
|---|---|---|---|---|---|
| `accounts-menu` | `vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` `workbench.action.chat.triggerSetupFromAccounts` menu registration | `id:"workbench.action.chat.triggerSetupFromAccounts",title:F(10538,"Sign in to use GitHub Copilot..."),menu:{id:O.AccountsContext,group:yyt,when:uqr}` | `…when:T.false()}` (same prefix) | 1 | "Sign in to use GitHub Copilot…" in the Accounts menu is shown while signed out and setup is not "completed"; there is no setting. The command stays registered (palette / API); only the menu entry is hidden by an always-false `when` (`T` is `ContextKeyExpr`, `T.false()` its constant). |

### Session-target picker — `out/vs/code/browser/workbench/workbench.js`

| id | source | anchor | replacement | count | why |
|---|---|---|---|---|---|
| `target-picker` | `vs/workbench/contrib/chat/browser/widget/input/sessionTargetPickerActionItem.ts` `_isVisible` | `_isVisible(e){return y8t(e,this.configurationService,this.chatSessionsService,this.workspaceContextService.getWorkspace(),this.agentHostEnablementService.managedSandboxEnforced.get(),this.agentHostEnablementService.enabled.get())}` | same with `return e!==cn.AgentHostCopilot&&y8t(…)` | 1 | The `Local \| Copilot \| Learn about harnesses…` picker lists the core agent-host **Copilot** session type (`agent-host-copilotcli`, GitHub sign-in required) whenever the agent host is enabled, which in this build is `!chat.disableAIFeatures` — no narrower setting exists (`chat.agentHost.byokModels.enabled` / `allowSignedOutWhenUsable` did not hide it). The extension's own "Copilot CLI" / "Cloud" rows are already gated by `github.copilot.chat.backgroundAgent.enabled` / `cloudAgent.enabled` (Machine settings, both false). `cn` is the minified `AgentSessionProviders` enum used two methods further down in the same class. The session type itself stays registered; only the picker row is hidden. |

### Extension manifest — `extensions/copilot/package.json`, `package.nls.json` (compact JSON)

| id | anchor | replacement | count | why |
|---|---|---|---|---|
| `participant-fullname` | `"fullName":"GitHub Copilot"` | `"fullName":"EZiL Chat"` | 6 | Display name of the default chat participants (`github.copilot.default`, `editingSession`, `editingSessionEditor`, `editsAgent`, `notebook`, `notebookEditorAgent`) — rendered as the (normally hidden) response header `h3.username` and in participant hovers. Ids and `name`s untouched. |
| `submenu-label` | `"github.copilot.submenu.copilot.label":"Copilot"` | `…:"EZiL Chat"` | 1 | The "Copilot" submenu in editor / explorer context menus. |
| `walkthrough` | `"github.copilot.walkthrough.title":"GitHub Copilot"` | `…:"EZiL Chat"` | 1 | Getting Started walkthrough title. |

Gates: anchors 0, replacements at count, both files parse, `publisher`/`name` unchanged.

Not changed (and why): command ids such as `workbench.action.chat.*` and
`github.copilot.*` setting keys keep their names (renaming them would break
the extension's own lookups); the GitHub sign-in dialogs behind "Enable more
AI Features" / "Manage Models → GitHub Copilot" are the genuine sign-in flow
and are not disguised; `product.json` (`defaultChatAgent`, `nameShort:
code-server`) is untouched; `github.copilot.*` log lines in the extension's
output channel are diagnostics, not UI. Settings that carry part of the
result (Machine layer, both launchers): `github.copilot.chat.backgroundAgent.enabled`
/ `cloudAgent.enabled: false` (extension's GitHub-only session types),
`chat.viewSessions.enabled: true` with `chat.viewSessions.orientation: "stacked"`
(Part 3: the in-view Sessions list over an empty chat; the notice moved under
the input, `chat-notice` above).

## Part 3 — EZiL Chat history

Facts from the pinned 4.141.0 bundle (`workbench.js`, `server-main.js`):

- Each conversation is a file `<workspaceStorageHome>/<workspace id>/chatSessions/<sessionId>.jsonl`
  (`.json` is the older flat form, still read). In code-server `workspaceStorageHome` is
  `vscode-remote:<user-data-dir>/User/workspaceStorage`, so the files are on the computer.
- The history list comes only from the store's index (storage key `chat.ChatSessionStore.index`,
  workspace scope). The web workbench keeps workspace scope in browser IndexedDB
  (`vscode-web-state-db-<workspace id>-<hash of the URL path>`) unless code-server runs with
  `--enable-remote-storage`. A missing index is the empty index; nothing rebuilds it from the files.
  So a new browser, a new origin, or a new user-data dir shows no history even when every file exists.
- The workspace id is `hash("vscode-remote://" + authority + folder).toString(16)` (`QUn`/`Nr`/`o0`),
  and code-server's embedder sets the authority to `location.host` (`remoteAuthority:location.host`).
  So the id, and with it the upstream session folder and the browser index, changes with the
  address the editor is opened at: another computer address, a Cloudflare ↔ AWS move. Measured in
  the image e2e: `?folder=/home/neko/project` at `127.0.0.1:18493` wrote to `workspaceStorage/31384936`,
  which is `hash("vscode-remote://127.0.0.1:18493/home/neko/project")`.

`scripts/editor-state.sh` creates `<workspace>/.ezil/chat` (self-ignoring `.ezil/.gitignore`) before
every launch and moves history already in a profile's `workspaceStorage/*/chatSessions` into it,
never overwriting. The patches below make the store use that folder and the list follow the files,
so the one copy rides on checkpoints, restore and moves.

Keeping it out of user Git: the running editor recreates `.ezil/chat` on its next write if
`.ezil` is removed (`FileService.writeFile` creates missing parents), for example by
`git clean -x`/`-X` or a workspace replaced under it, and that write would not recreate the
ignore file. So `ezil_editor_ignore_state` runs before every launch and at every capture (every
30 s and before each checkpoint): it restores `.ezil/.gitignore` and, when the workspace root has
a `.git` directory with an `info/exclude` file, adds `/.ezil/` there once. That local file is never
committed and `git clean` leaves it, so a repository at the root ignores a recreated `.ezil` even
before the next capture. It never replaces a user's `.gitignore`, follows a link or creates
`.git/info`. Residual: where the exclude is not written (`.git` is a file or a link, or has no
`info/exclude`), a chat saved in the up to 30 s between the removal and the next capture is
untracked but not ignored. Because `.ezil` is ignored, `git clean -x`/`-X` deletes all chat history
and saved editor settings, as it deletes any ignored file.

Not listed, not deleted: the store's index keeps the 400 most recent conversations (`zSn`), and
`trimEntries` drops older entries without deleting their files; `history-index` does not re-add
files older than the oldest entry of a full index. So past 400 conversations the older files stay
in `.ezil/chat`, unlisted and not deletable from the editor, as upstream leaves them in the profile.
Copies `editor-state.sh` sets aside in `.ezil/chat-conflicts/<stamp>/` (a profile file whose name
already exists with other bytes) are not listed either. Both ride every checkpoint and count
toward its size; they can be removed from a terminal. Deleting trimmed files automatically was
rejected: it would remove conversations the user never deleted.

| id | file / anchor | replacement / gate |
|---|---|---|
| `history-root` | workbench.js, end of the `ChatSessionStore` constructor: `this.storeTask&&S.join(this.storeTask,{id:"join.chatSessionStore",label:d(12652,null)})}))}async handleWorkspaceTransition(e,t){` | For a window with exactly one folder and no workspace file, queue as the store's first task: `stat(<folder>/.ezil/chat)`; a directory becomes `storageRoot`. Every read of `storageRoot` (`getStorageLocation`, reconcile, migration) runs in a later queued task; the only synchronous accessor, `getChatStorageFolder()`, has no caller. Not-found keeps the upstream location (any other folder); another error retries 5 times (1 s … 5 s), then keeps upstream and logs an error. Anchor 0, replacement 1. |
| `history-index` | workbench.js `ChatSessionStore.getIndex`: `async getIndex(){return this.storeQueue.queue(async()=>this.internalGetIndex().entries)}` | On the first read in a window, inside the store queue: list the `chatSessions` directory; drop non-external index entries with neither `.json` nor `.jsonl`; read files missing from the index (newest first, never older than the oldest entry of a full 400-entry index) with the store's own `readSessionFromLocation` and `KSn` metadata, titled like `ChatModel.getDefaultTitle` when there is no custom title; then `trimEntries` and `flushIndex`. A listing error other than not-found changes nothing and is retried on the next read; not-found ends it for the window. Anchor 0, replacement 1. |
| `history-names` | `KSn`, `sC.getDefaultTitle`, `zSn=400`, `readSessionFromLocation`, `getStorageLocation`, `ba(...)!==1` (not-found), the constructor's `f` (workspace) and `Ve` (joinPath), `cn.Local`, the picker's `agentSessionsService` | Checked, never patched: each exact definition occurs once, so the replacement's minified names mean the same thing. |
| `history-entry` | workbench.js `ChatViewTitleControl.shouldRender(){return!!this.model?.title}` | `shouldRender(){return!0}`: the title, whose click opens the session picker (`workbench.action.chat.pickAgentSession`), also shows on an empty chat. Anchor 0, replacement 1. |
| `history-label` | workbench.js `static{this.DEFAULT_TITLE=d(12379,null)}` | `static{this.DEFAULT_TITLE="Chat history"}`, the label of that title on an empty chat. Anchor 0, replacement 1. |
| `history-empty-title` | workbench.js `ChatViewTitleControl`: `this.title??X2.DEFAULT_TITLE` (in `doUpdate` and in the label the toolbar creates, which can be created after `doUpdate` ran) | `this.title||X2.DEFAULT_TITLE`: an empty chat's title is `""`, not nullish, so upstream rendered an empty label. Anchor 0, replacement 2. |
| `session-filter` | workbench.js `registerProviderActions` of the Sessions filter: `r=[{id:cn.Local,label:n(cn.Local)}];for(let l of this.chatSessionsService.getAllChatSessionContributions()){…r.push({id:u,label:n(u)})}` | `r=[{id:cn.Local,label:n(cn.Local)}];`: the filter offers Local only. Upstream it adds every `chatSessions` contribution — the GitHub-hosted agent types (Copilot CLI, cloud, agent host) that the Machine settings and `target-picker` keep out of EZiL Chat — and the menu read "Copilot". Anchor 0, replacement 1. |
| `history-picker` | workbench.js `R9e.pickAgentSession`: `async pickAgentSession(){let o=new A,e=o.add(this.quickInputService.createQuickPick({useSeparators:!0}))` | First `await this.agentSessionsService.model.resolve(cn.Local)` (errors ignored). The picker shows a snapshot of the agent-sessions model and never refreshes; opened before the local provider's first resolve it stayed empty (measured in the image e2e). Anchor 0, replacement 1. |

**Sessions list (Machine settings `chat.viewSessions.enabled: true`, `chat.viewSessions.orientation: "stacked"`).**
Upstream "Go Back" (the arrow in the chat title, `workbench.action.chat.newChat`) starts a new, empty
chat and leaves the one on screen running. With the list off, nothing on screen led back to a chat
that was still answering (reported from os-staging, 2026-11-01). Stacked, an empty chat shows the
list: a running chat reads "Working…" and opens live, mid-answer; finished ones follow, newest first.
Stacked keeps Go Back in the title (side by side hides it) and adds no second sidebar to a narrow
panel. The list reads the same index the title picker does, so it shows the history above in a new
browser too. Its filter lists Local only (`session-filter`). Deleting a chat in the picker runs the store's `deleteSession`, which
deletes both `<id>.json` and `<id>.jsonl` in `.ezil/chat`. Export is the files in `.ezil/chat`.
Moving profile history in takes every profile `chatSessions` folder: conversations from another
folder opened in the same profile join the EZiL workspace's history (EZiL opens one folder).

Copilot Chat 0.69 also keeps conversation text of its own: `github.copilot.chat.localIndex.enabled`
(default `true`, tagged `onExp`) writes sessions and turns to
`User/globalStorage/github.copilot-chat/session-store.db`. The Machine seed turns it off and
`editor-state.sh` removes that derived copy. Not changed: agent-mode summarisation can write
`workspaceStorage/<id>/GitHub.copilot-chat/transcripts/<session>.jsonl`, which deleting a chat does
not remove; the profile keeps it (AWS) or the restart drops it (Cloudflare).

Offline test against the pristine bundle (patches a copy, runs the patched store on real files
in the folder `editor-state.sh` prepares):

```sh
COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/chat-history-patch.test.cjs
```

## R2-D — Gateway status instead of Copilot quota/account surfaces

The bundled `extensions/copilot/package.json` contributes language models and chat
participants, but **does not own this quota popover**. In the pinned workbench,
`vs/workbench/contrib/chat/browser/chatStatus/chatStatusEntry` registers
`workbench.contrib.chatStatusBarEntry` and adds `chat.statusBarEntry` through
`statusbarService.addEntry`. Its tooltip instantiates `Xte`, the compiled
`chatStatusDashboard`. That dashboard calls `renderHeader` with the Copilot plan
and GitHub account icon, and renders the anonymous `Chat messages` / `Limited`
row even when EZiL supplies all models.

New exact anchors and gates (each count is one):

| id | file / anchor | replacement / gate |
|---|---|---|
| `ai-entry` | workbench.js: `update(){if(this.chatEntitlementService.sentiment.hidden)this.entry?.dispose(),this.entry=void 0;else{let t=this.getEntryProps();` | Replace the condition with `!0`; always dispose the old entry. Anchor 0, replacement 1. Chat registration and AI features stay enabled. |
| `ai-dashboard` | workbench.js: `static{this.QUICK_SETTINGS_COLLAPSED_KEY="chatStatusDashboard.quickSettingsCollapsed"}render(){let e=Rh(this._store),` | Before the existing body, clear the element, add the plain `EZiL AI` identity, a button invoking `ezil-models.showStatus`, the AI accuracy notice, and return. Exact replacement is `R_AI_DASHBOARD` in the script. Anchor 0, replacement 1. This bypasses the GitHub header/icon, plan, quota and setup sections for every dashboard entry point, including compact layouts. |
| `ai-plan` | both NLS arrays, index 21958, `vs/workbench/services/chat/common/chatEntitlementService#plan.freeName`: `"Copilot Free"` | `"EZiL AI"`; old literal 0, replacement 1. Genuine GitHub signup error sentences are retained. |
| `ai-quota` | both NLS arrays, index 10616, `chatStatusDashboard#chatsLabel`: `"Chat messages"` | `"Gateway usage"`; old literal 0, replacement 1. |
| `ai-limit` | both NLS arrays, index 10657, `chatStatusDashboard#quotaLimited`: `"Limited"` | `"View EZiL AI status"`; old literal 0, replacement 1. No unlimited or fabricated balance. |

The replacement extension status item is `ezil-models.aiStatus`, named **EZiL AI**.
Hover exposes the balance/usage snapshot and click opens an accessible Quick Pick
popover. Both `ezil-models.showStatus` and the existing `showCredits` command open
it. It reads `/ai/v1/me/balance` and `/ai/v1/me/usage?limit=5` through the already
resolved Gateway provider. Microcredits are divided by 1,000,000; recent charges
subtract `uncollected_micro` and unsettled charges remain pending. Fetch failures
show the Gateway/Worker code or a local transport/response code. Refresh occurs
on activation, config change, completed usage, click and every 60 seconds.

Preserved notices: Copilot `LICENSE.txt` (MIT and Microsoft copyright), the
Microsoft JS copyright headers, existing build modification notices, all other
license/attribution and third-party notice files, and the AI accuracy/review
notice in the welcome screen and replacement dashboard/status popover. Neither
`product.json` nor publisher/extension identity changes. Original GitHub sign-in
legal dialogs remain intact; they are not shown by the EZiL status surface.

Offline script regression test (copies only required bundle files into a temp
directory and never changes the input):

```sh
COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/status-patch.test.cjs
```

It applies the whole script, reruns `--verify`, checks literal replacements,
byte-compares LICENSE/product, executes the dashboard/status branches with
throwing entitlement accessors, and rejects restored quota text or anchor drift.
Without a local pinned bundle it explicitly skips; release validation must supply
`COPILOT_TEST_ROOT`.

## Re-deriving the 4.141.0 anchors

The three moved anchors are `token` (`yGe.env.devDeviceId`), `accounts-menu`
(`F(10538,...)`, `O.AccountsContext`, `group:yyt`, `when:uqr`) and
`target-picker` (`y8t`, excluding `cn.AgentHostCopilot`). Each occurs once.
Find `uqr=T.and(...)` in the workbench to confirm that `T.false()` uses the
same ContextKeyExpr class. Find another `cn.AgentHostCopilot` use before
changing the picker. Search the anonymous-access log message to locate the
token branch. Do not copy minifier names from a different release.

Extract the checksummed .deb with `dpkg-deb -x`, copy the extracted tree,
and run this script followed by `--verify` against `lib/vscode` in that copy.
Every pre-patch count must match. The verification also parses all three
patched JS files, compares the NLS JS/JSON arrays, checks the 0.69.0 manifest
identity and provider contribution, and requires `defaultChatAgent`, the MIT
license and original Microsoft headers. Compare LICENSE.txt with the original
extraction when reviewing an update. The JSON and CSS modifications are
recorded here; the three JS files carry inline modification notices.
