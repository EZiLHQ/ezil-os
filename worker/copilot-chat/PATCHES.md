# Build-time patches to the bundled Copilot Chat ("EZiL Chat")

`patch-copilot-chat.sh` is applied by `worker/Dockerfile` to the code-server
**4.139.1** tarball (Code 1.139.1, GitHub.copilot-chat 0.67.0 built in at
`lib/vscode/extensions/copilot`). Every patch below is an exact-match anchor
in a shipped minified file, with the occurrence count the script requires
BEFORE patching and the grep gate it checks AFTER (`--verify` re-runs the
gates alone). If a code-server bump moves a string, the Docker build fails
with the offending anchor printed; re-derive it from the new bundle (grep the
source tree at the matching `microsoft/vscode` tag — the anchors are the
compiled form of the files named below) and update both the script and this
table. Strings only: no command id, setting key, contribution point,
`product.json` field or LICENSE file is changed. The original work stays
MIT, Copyright (c) Microsoft Corporation; each patched `.js` gets a one-line
"Modified at build time by EZiL" notice (see `ATTRIBUTIONS.md`).

Why these and not settings: `telemetry.telemetryLevel: off` (User seed) and
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
| `token` | `platform/authentication/vscode-node/copilotTokenManager.ts` `_auth()` anonymous branch | `this._logService.info("Allowing anonymous access with devDeviceId");let a=await this.authFromDevDeviceId(H6e.env.devDeviceId);` | `this._logService.info("EZiL Chat: anonymous mode, GitHub token minting (copilot_internal/v2/nltoken) disabled at build time");let a={kind:"failure",reason:"GitHubLoginFailed"};` | 1 | With `chat.allowAnonymousAccess` the extension mints a Copilot token for the device id at `GET api.github.com/copilot_internal/v2/nltoken` (and retried it 9x in 8 s when the call failed). The token is only used for Copilot-hosted models/utility calls, which EZiL never uses (`chat.byokUtilityModelDefault: mainAgent`). Returning the same failure the unreachable server produces keeps every consumer on its existing no-token branch (BYOK path measured healthy). `H6e` is the minified `vscode` import — part of the anchor on purpose. | anchor 0, replacement 1, `await this.authFromDevDeviceId(` 0 |
| `known-models` | `extension/byok/vscode-node/byokContribution.ts` `_fetchKnownModelList` | `this._logService.info("BYOK: fetching known models list");let r=await(await n.fetch("https://main.vscode-cdn.net/extensions/copilotChat.json",{method:"GET",callSite:"byok-known-models"})).json();` | `this._logService.info("EZiL Chat: BYOK known-models CDN fetch disabled at build time, using an empty list");let r={version:1,modelInfo:{}};` | 1 | Runs once when the BYOK providers register: downloads the model catalogue for Copilot's *own* BYOK vendors (Anthropic/Gemini/xAI/OpenAI pickers). EZiL models come from the `ezil` provider, so the empty list — exactly what the code falls back to when the fetch fails — is equivalent. | anchor 0, replacement 1, the CDN URL 0 |

| `embeddings-cache` / `embeddings-latest` / `embeddings-ext` | `platform/embeddings/common/embeddingsIndex.ts` `fetchRemoteCache`, `fetchRemoteCacheLatest`, `fetchRemoteExtensionCache` | `async fetchRemoteCache(){if(this._remoteCacheEntries)return this._remoteCacheEntries;let e=await this.getRemoteCacheURL();try{` / `async fetchRemoteCacheLatest(){let e=await this.getRemoteCacheLatestUpdateURL();try{` / ``async fetchRemoteExtensionCache(n){let o=`${await this.getBaseExtensionCDNURL()}/${n}.json`;try{`` | the same with an early `return;` (`return{};` for the extension variant — the value the code returns on a 404) inserted after the cache short-circuit | 1 / 1 / 1 | The tool/settings/command embeddings index fetches `https://embeddings.vscode-cdn.net/<container>/v<n>/<type>/{latest.txt,core.json,<extension>.json}` during Agent-mode requests (seen once Ask/Plan/agent tooling ran without a Copilot token; not on the rev2 boot path). Without the Copilot embeddings API (needs a token) the CDN copy is the only source, so returning "no remote cache" is exactly today's offline behaviour; the local memento cache is still used. | anchors 0, replacements 1 each |

Not patched, by measurement: model metadata (`api.githubcopilot.com/models`) and `[CopilotCLIModels]` fetches first call `getCopilotToken()`, which now fails locally, so they return before any request; the core workbench makes no entitlement call without a GitHub account; the agent-host runtime (`@github/copilot-sdk`) starts but is disabled in the web workbench (`enabled = !isWeb && !chat.disableAIFeatures`) and made no request; the Copilot CLI MCP server and its OTel exporter are local (unix socket / file).

Handled outside the script: code-server's own release check (`GET api.github.com/repos/coder/code-server/releases/latest`) → `--disable-update-check` in both launchers; applicationinsights Statsbeat (`POST westus-0.in.applicationinsights.azure.com/v2.1/track`, SDK-internal, not gated by the telemetry level, and the SDK reads `APPLICATION_INSIGHTS_NO_STATSBEAT` at module load — before the bundle's own `process.env` assignment) → `ENV APPLICATION_INSIGHTS_NO_STATSBEAT=true` in the Dockerfile; belt and braces: `seed_blocked_ai_hosts` maps the Copilot/telemetry-only hosts to 127.0.0.1 in `/etc/hosts` at boot (never `github.com`/`api.github.com` — developer tooling needs them).

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
element equal. Indices are from `out/nls.keys.json`.

| id | nls key (index) | anchor (JSON-quoted) | replacement | count | why |
|---|---|---|---|---|---|
| `terms-dot` | `vs/workbench/contrib/chat/browser/widget/chatWidget#settings` (10879) | `"By continuing with {0} Copilot, you agree to {1}'s [Terms]({2}) and [Privacy Statement]({3})."` | `"AI responses may be inaccurate. Review changes before applying them."` | 1 | The chat-welcome disclaimer, shown whenever `chatEntitlementService.anonymous && !sentiment.completed` — i.e. always, in EZiL's configuration; no setting hides it. No links. |
| `terms` | `chatStatus/chatStatusDashboard#activeDescriptionAnonymous` (9574), `widgetHosts/chatQuick#termsDisclaimer` (11117), `inlineChat/browser/inlineChatWidget#termsDisclaimer` (14409), `welcomeGettingStarted/common/gettingStartedContent#gettingStarted.copilotSetup.terms` (20061) | same text without the trailing period | same | 4 | The same sentence in the status hover, quick chat, inline chat and Getting Started. |
| `status-aria` | `chatStatus/chatStatusEntry#chatStatusAria` (9639) | `"Copilot status"` | `"EZiL Chat status"` | 1 | Status-bar item aria label ("Copilot status" in the hover). The item itself can only be removed with `chat.disableAIFeatures`, which removes the chat too. |
| `status-name` | `chatStatusEntry#chatStatus` (9638) | `"Copilot Status"` | `"EZiL Chat Status"` | 1 | Status-bar item name (context menu / hide list). |
| `status-resumed` / `status-disabled` | `chatStatusEntry#chatResumedStatus` (9637) / `#copilotDisabledStatus` (9642) | `"Copilot Resumed"` / `"Copilot disabled"` | `"EZiL Chat resumed"` / `"EZiL Chat disabled"` | 1 / 1 | Other texts the same item can show. |
| `enable-more` | `chatStatusDashboard#enableMoreDescription` (9591) | `"Sign in to enable more Copilot AI features."` | `"EZiL Chat runs on the models configured for this workspace."` | 1 | Status hover footer. Its button ("Enable more AI Features") still opens VS Code's GitHub sign-in flow; that flow's own dialogs are the real GitHub sign-in and are left as they are. |

Gates: every anchor 0, every replacement at its count, `By continuing with {0} Copilot` 0, both files parse (`.js` evaluated in a VM, `.json` parsed) and are identical element-wise.

### Welcome disclaimer visibility — `out/vs/code/browser/workbench/workbench.css`

| id | source | anchor | replacement | count | why |
|---|---|---|---|---|---|
| `welcome-disclaimer` | `vs/workbench/contrib/chat/browser/widget/media/chatViewWelcome.css` `.interactive-session.chat-view-getting-started-disabled { … }` | `.chat-welcome-view .chat-welcome-view-message,.chat-welcome-view .chat-welcome-view-disclaimer,.chat-welcome-view .chat-welcome-view-tips{display:none}` | `.chat-welcome-view .chat-welcome-view-message,.chat-welcome-view .chat-welcome-view-tips{display:none}` | 1 | `chatWidget.ts` adds `chat-view-getting-started-disabled` whenever `sentiment.completed \|\| hasByokModels` — always, with the `ezil` group present — and this rule then hides the welcome icon, title, message, **disclaimer** and tips ("make some space" for the in-view sessions list). The disclaimer is where the EZiL notice lives, so it is taken out of the hidden list; icon/title/message/tips stay hidden as upstream intends. Paired with `chat.viewSessions.enabled: false` (Machine settings) so an empty chat shows the welcome at all. |

### Accounts menu — `out/vs/code/browser/workbench/workbench.js`

| id | source | anchor | replacement | count | why |
|---|---|---|---|---|---|
| `accounts-menu` | `vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` `workbench.action.chat.triggerSetupFromAccounts` menu registration | `id:"workbench.action.chat.triggerSetupFromAccounts",title:O(9501,"Sign in to use GitHub Copilot..."),menu:{id:N.AccountsContext,group:"2_copilot",when:_.and(Z.Setup.hidden.negate(),Z.Setup.disabledInWorkspace.negate(),vJt.notEqualsTo("available"),Z.Setup.completed.negate(),Z.Entitlement.signedOut)}` | `…when:_.false()}` (same prefix) | 1 | "Sign in to use GitHub Copilot…" in the Accounts menu is shown while signed out and setup is not "completed"; there is no setting. The command stays registered (palette / API); only the menu entry is hidden by an always-false `when` (`_` is `ContextKeyExpr`, `_.false()` its constant). |

### Session-target picker — `out/vs/code/browser/workbench/workbench.js`

| id | source | anchor | replacement | count | why |
|---|---|---|---|---|---|
| `target-picker` | `vs/workbench/contrib/chat/browser/widget/input/sessionTargetPickerActionItem.ts` `_isVisible` | `_isVisible(e){return lqt(e,this.configurationService,this.chatSessionsService,this.workspaceContextService.getWorkspace(),this.agentHostEnablementService.managedSandboxEnforced.get(),this.agentHostEnablementService.enabled.get())}` | same with `return e!==nn.AgentHostCopilot&&lqt(…)` | 1 | The `Local \| Copilot \| Learn about harnesses…` picker lists the core agent-host **Copilot** session type (`agent-host-copilotcli`, GitHub sign-in required) whenever the agent host is enabled, which in this build is `!chat.disableAIFeatures` — no narrower setting exists (`chat.agentHost.byokModels.enabled` / `allowSignedOutWhenUsable` did not hide it). The extension's own "Copilot CLI" / "Cloud" rows are already gated by `github.copilot.chat.backgroundAgent.enabled` / `cloudAgent.enabled` (Machine settings, both false). `nn` is the minified `AgentSessionProviders` enum used two methods further down in the same class. The session type itself stays registered; only the picker row is hidden. |

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
`chat.viewSessions.enabled: false` (with BYOK models present the chat view
otherwise fills its empty state with the in-view "Sessions" list and the
welcome — where the notice lives — never renders; sessions remain reachable
from the view's toolbar).
