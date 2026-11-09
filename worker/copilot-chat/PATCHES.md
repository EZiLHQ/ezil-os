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
table. Only the documented strings, network call sites, visibility filters, the chat history index (Part 3), the chat view layout (one menu placement, DOM placement, CSS) and the workbench static path (`static-id`) change: no command id, setting key, contribution point,
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

### Compact chat layout — `workbench.js` (`chat-header`, `attach-execute`, `picker-flip`, `picker-order`, `picker-touch`, `title-tap`) and `workbench.css` (`chat-layout`)

Upstream, the bottom of the chat view stacked: the "Chat history" title row (over an empty chat,
where the Sessions list fills the top), a getting-started tip, the composer (input over a row with
Add Context, Agent, model, Configure Tools and Send), a Local + permissions + context-usage row, and,
from the previous build of this script, a notice line (`chat-notice`, two lines on a ~400 px panel).
Measured in the image (mock gateway, chat panel 818 / 400 CSS px): 191 / 225 px of an empty chat and
130 / 146 px under a conversation. With every control in the header and a one-row composer (2026-11-04
to 2026-11-08) it was 56 px in every state, with a 30 px header (54 px when it wraps below ~600 px). Since
2026-11-08 the composer keeps upstream's two rows (input, then the mode/model and Send row) so the model
picker sits at the input, as the founder asked.

Where each control is now (same nodes, same listeners, same accessible names):

- **Header (the chat title row, always on top):** Go Back, the chat title / "Chat history" (opens the
  session picker), Local, the permission level (label kept: the row wraps instead of hiding it),
  context usage, an info button for the notice, the Sessions-sidebar toggle. Tab order follows that
  order. On a touch screen a tap opens the header's pickers and they stay open (`title-tap`).
- **Composer:** input on top; under it mode (Agent), model, Configure Tools, then Add Context and Send
  (Stop while answering); attachment chips keep their own row above. Pickers open downward when the
  list does not fit above the button (`picker-flip`); upstream forced every chat picker upward, which
  from the header left one row of the model list in a chat with turns (image e2e, 2026-11-05). When the
  row is too narrow for every picker's label (a phone: Explorer and Chat side by side leave Chat
  ~160 px), the mode picker becomes its icon first and the model name ellipsizes (`picker-order`);
  upstream compacted right to left, so the model picker lost its name first and only a sparkle icon was
  left (image e2e, 390 and 412 px, 2026-11-05, measured in the header). On a touch screen a tap opens
  the model picker once (`picker-touch`): before, a tap on it did nothing on Android and opened and at
  once closed it on iPhone, so a phone could not change the model (image e2e, Chromium touch taps with
  Android and iPhone user agents, 2026-11-08). Until 2026-11-08 mode, model and Configure Tools sat in
  the header, across the panel from the input; the founder asked for them at the composer. Auto-grow is
  upstream's: up to 250 px of editor (`vmn`), then the editor scrolls.
- **Notice:** the info button's accessible name and tooltip are "AI responses may be inaccurate. Review
  changes before applying them."; Enter/Space/click opens EZiL AI status (`ezil-models.showStatus`),
  which lists the same sentence (and, if that command is missing, a notification shows it). The AI
  status dashboard (`ai-dashboard`) and `terms` strings still carry it too.
- **Tip:** hidden in the chat view. `chat.tips.enabled` would be the setting, but it is
  application-scoped (`scope:1`): set in Machine settings it had no effect (measured), and enforcing
  it in user settings would rewrite a user-owned file. Attachments, the working set, todo list,
  confirmations and other notices above the input are unchanged.

| id | file / anchor | replacement / gate |
|---|---|---|
| `chat-header` | workbench.js `ChatViewPane.createControls` (`vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts`): `createControls(e){let t=this.createSessionsControl(e),i=this.welcomeController=this._register(this.instantiationService.createInstance(P3e,e,this,"panel")),n=this.createChatControl(e);this.registerControlsListeners(t,n,i),this.updateSessionsControlVisibility()}` | Same, then `try{this._ezilChatHeader(e)}catch(f){this.logService.error(…)}` and a new method `_ezilChatHeader(e)` (exact text: `R_CHAT_HEADER` in the script). It needs the title row, the input part and its secondary toolbar, else returns without changing anything. It creates `div.interactive-session.ezil-chat-header` (the class keeps upstream's `.interactive-session …` picker styles matching; CSS gives it `display:contents`) that stops `click`/gesture-tap from reaching the title row (whose click focuses the input), appends the secondary toolbar (`secondaryToolbarContainer`: Local, permissions, context usage, status) and a `button.ezil-chat-help.codicon-info`, and inserts it before the title's actions toolbar. It inserts the still-empty header first and only then moves the toolbar into it, so a title row whose shape changed (an actions toolbar no longer a direct child) throws before any control has moved: the try/catch logs and the composer keeps upstream's controls, never a half-moved, dead-control chat. The title container then moves before `.voice-agent-controls-wrapper` (top of `.chat-viewpane`, in stacked and side-by-side orientations); the view's layout already subtracts the title's measured height (`ChatViewTitleControl` ResizeObserver), so a wrapped header relayouts the chat. The pane gets `ezil-compact-chat`, which every layout rule requires. The primary toolbar (mode, model, Configure Tools) is not moved: it stays in the composer's `.chat-input-toolbars` row under the input, beside Add Context and Send, and the editor keeps upstream's full-width layout (until 2026-11-08 the primary toolbar moved to the header too and a ResizeObserver corrected `setInputEditorTrailingSpace` for a one-row grid; the founder asked for the model picker at the composer). Only the chat view: editor-hosted, quick and inline chats keep upstream layout. Anchor 0, replacement 1. |
| `header-names` | `createChatTitleControl(e){this.titleControl=`, `this.titleContainer=t.root,`, `get inputPart(){return this.inputPartDisposable.value}`, `this.secondaryToolbarContainer=r.secondaryToolbar;`, `this.chatEntitlementService=M;this.commandService=N;`, `this.logService=v;this.notificationService=b;` | Checked, never patched: each occurs once, so the names `_ezilChatHeader` uses mean what it expects. |
| `attach-execute` | workbench.js Add Context (`workbench.action.chat.attachContext`) menu entry for the chat view: `{when:T.and(J.inQuickChat.negate(),J.location.isEqualTo("panel"),T.or(J.lockedToCodingAgent.negate(),J.agentSupportsAttachments)),id:O.ChatInput,group:"navigation",order:-1}` | Same with `id:O.ChatExecute`: the button renders beside Send (the execute toolbar already renders this action; quick chat registers it there), so it stays in the composer when the ChatInput toolbar moves to the header. Applies to location `panel`, i.e. also the chat editor, where it now sits beside Send; its keybinding (Ctrl+/) is unchanged. Anchor 0, replacement 1. |
| `picker-flip` | workbench.js list options for every chat input picker (mode, model, model options, session target, permissions; `SW`): `function SW(s){return{...Vio(s),anchorPosition:1}}`. The action widget's `computeHeight` takes a set `anchorPosition` as final (always above) and caps the list to the space above the button, less the search box and the cache-break hint: from the header (~97 px down a 900 px window) the model list of a chat with turns was 15 px, under one row. | `function SW(s){return{...Vio(s),anchorPosition:void 0,preferredAnchorPosition:1}}`: upstream's own option (the chat input pills pass it). `SW` still overrides a caller's `anchorPosition` (the agent-host mode/permissions popup, `run`, passes 1), so it alone picks the side, as before; the pickers' base (`A1` → its dropdown's `show`) passes the options through without a side of its own. `computeHeight` lays the list out above when it fits there, below when it fits there instead (`X7`), else on the larger side, up to 60 % of the window; the context view then places it from the widget's `anchorPosition` getter, which falls back to that choice. Composer pickers (chat editor, quick chat) still open above. A picker in a dialog keeps forcing below: the model picker passes `{...SW(K),anchorPosition:0}` there, and a set `anchorPosition` wins. Anchor 0, replacement 1. |
| `picker-names` | `this._anchorPosition=a?.anchorPosition,this._preferredAnchorPosition=a?.preferredAnchorPosition,` (the action widget reads both options), `G=r.closest(".monaco-dialog-box")?{...SW(K),anchorPosition:0}:SW(K)` (the dialog override) | Checked, never patched: each occurs once. |
| `picker-order` | workbench.js responsive chat picker layout (`SEt.layout`, `ChatInputPart.primaryPicker`/`secondaryPicker`): `let t=this._getVisibleItemBounds().sort((i,n)=>n.bounds.left-i.bounds.left).map(({item:i})=>i);for(let i of t)i.setMinimal?.(!1),i.setCompact(!1);`. When the pickers do not fit, it compacts them to icons in that order, right to left, until they fit; in the header the model picker sits right of the mode picker, so it was compacted first. | Same, sorted `(i.item.canShrink?1:0)-(n.item.canShrink?1:0)||n.bounds.left-i.bounds.left`: items that can shrink compact last. Only the model picker is `canShrink` (upstream: its name ellipsizes, `.model-picker-item` `flex-shrink:1`, and the fit check accepts it narrower than its preferred width), so on a narrow row the mode picker becomes its icon first and the model name shortens with an ellipsis; the model picker becomes an icon only if even that does not fit. A row without a `canShrink` item (Local, permissions, context usage) compacts right to left as before; nothing changes when everything fits. Compact pickers keep their accessible names (the model picker's is "Models, <full name>"). Anchor 0, replacement 1. |
| `picker-order-names` | `canShrink:r.id===u2.ID,` (only the model picker shrinks), `static{this.ID="workbench.action.chat.openModelPicker"}` (`u2`), and the fit check's `canShrink` exemption (`if(!i.some(({item:r})=>r.canShrink)&&n.width>e+o4e)return!1;…`) | Checked, never patched: each occurs once. |
| `picker-touch` | workbench.js model picker buttons (`ModelPickerWidget._registerButtonAction`, name and settings buttons): `_registerButtonAction(e,t){this._register($p(e,i=>{i.button===0&&(bt.stop(i,!0),t(!1))})),`. `$p` (`addDisposableGenericMouseDownListener`) listens for `pointerdown` on iOS and `mousedown` elsewhere. On a touch device VS Code's `Gesture` cancels `touchstart`/`touchend` once a registered target got a gesture (the title row is one), so the browser sends no compatibility mouse events and no click: on Android a tap never opened the picker. | Upstream's own fix, microsoft/vscode#339777 (merged 2026-10-05, after 1.141): `this._register(q(e,oe.MOUSE_DOWN,i=>{i.button===0&&(bt.stop(i,!0),t(!1))})),this._register(hs.addTarget(e)),this._register(q(e,jn.Tap,i=>{bt.stop(i,!0),t(!1)})),` — `mousedown` for the mouse, a Gesture Tap for touch and pen. The iOS `pointerdown` listener is gone, so a tap opens it once (`_show` toggles: a second open would close it). Mouse and keyboard unchanged. Anchor 0, replacement 1. |
| `title-tap` | workbench.js chat title row (`ChatViewTitleControl`): `this._register(hs.addTarget(this.titleContainer));for(let i of[jn.Tap,oe.CLICK])this._register(q(this.titleContainer,i,()=>{this.delegate.focusChat()}))`. `chat-header` put the pickers inside this row; a Tap on one reached this handler, which focused the chat input, the picker list lost focus and closed (iPhone: opened on `pointerdown`, closed after `touchend`; Android after `picker-touch`). The header's own `stopPropagation` of `-monaco-gesturetap` cannot prevent it: `Gesture` dispatches a non-bubbling event to each registered target directly. Clicks were already stopped by the header. | Same, with the handler `n=>{(n.initialTarget??n.target)?.closest?.(".ezil-chat-header")||this.delegate.focusChat()}`: a Tap or click that starts inside the EZiL header does not focus the input; anywhere else on the title (Go Back, "Chat history", empty space) it still does. Anchor 0, replacement 1. |
| `touch-names` | `var hs=tx;` (Gesture), `var jn;(n=>(n.Tap="-monaco-gesturetap",` (TouchEventType), the start of `var oe={CLICK:"click",…,MOUSE_DOWN:"mousedown",` (dom.EventType), and upstream's phone chip `this._renderDisposables.add(hs.addTarget(t));for(let i of[oe.CLICK,jn.Tap])this._renderDisposables.add(q(t,i,n=>{bt.stop(n,!0),this._showSheet()}))` (the same `hs`, `jn`, `q`, `bt`, `oe` in this bundle) | Checked, never patched: each occurs once. |
| `chat-layout` | workbench.css: `.chat-welcome-view .chat-welcome-view-message,.chat-welcome-view .chat-welcome-view-disclaimer,.chat-welcome-view .chat-welcome-view-tips{display:none}` left as it is (gated once: the welcome disclaimer stays hidden whenever BYOK models exist, so it is not where the notice lives) | Appended to the end of the file, top level (a rule next to the nested upstream one would be nested too), exact text `R_CSS_LAYOUT`: the header row wraps (`flex-wrap`, title label `flex:1 1 96px`), the moved secondary toolbar shrinks instead of stretching, the info button looks like a toolbar icon with a focus ring; the composer keeps upstream's layout (input over the mode/model, Add Context and Send row; no grid rule), with `min-width:0!important` on that row (the responsive toolbar writes its own minimum onto it). Below a 208 px composer (`@container ezil-composer`; a phone, where Chat is ~162 px and the row 121 px) mode, model and Configure Tools need 144 px (written inline: they never overflow) and Add Context + Send 48, so Add Context and Send wrap to their own line, right-aligned; the pickers keep the first line, the mode picker compacts and the model name ellipsizes (`model-picker-item` minimum 56 px, above what is left beside an expanded mode picker). Measured at 412 and 390 px: model label 60 px, Send inside the composer (before: Send at 438-460 px, outside a composer ending at 394). The tip is hidden. All rules but the tip's require `.chat-viewpane.ezil-compact-chat`. Gates: upstream rule once, layout block once and at brace depth 0, the previous notice rule (`.interactive-input-part::after{content:"AI responses may be inaccurate.`) 0. |

Offline test (patches a copy, runs `--verify`, checks the CSS and the menu entry, executes
`_ezilChatHeader` and `createControls` against a DOM double (the mode/model toolbar stays in the composer), runs the bundle's own `SW`, `X7` and
`computeHeight` for a header, a composer and a dialog picker, runs the bundle's own `SEt.layout` on a
phone-width, desktop-width and too-narrow header row and a row without a shrinkable picker, against the
pristine one too, runs the bundle's own model picker button wiring and title handler against doubles
(Tap, touch/pen/mouse pointerdown, mousedown; a Tap or click in and outside the header), rejects a moved
anchor). The image e2e `phone` pass covers the same by real touch taps (`copilot-ezil-image.sh`):

```sh
COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/chat-layout-patch.test.cjs
```

### Chat stays enabled on a new browser profile — `workbench.js` (`chat-enabled`)

On a browser profile's first load (`builtinChatExtensionEnablementMigration` not yet stored), 1.141's
`ensureChatExtensionInitialDisabledState` disables the built-in chat extension when chat setup has not
completed. EZiL Chat is anonymous with EZiL models, so the setup agent's `z3t` sends a message down the
no-setup path (setup not completed, but BYOK models present), which waits for Copilot's default agent from
the disabled extension: "Chat took too long to get ready. Please ensure that the extension
`GitHub.copilot-chat` is installed and enabled." after 60 s (remote) and no answer. Measured 2026-11-08 with a
healthy mock gateway, a new browser profile and a send about 4-6 s after load: the timeout on the staging
image (9e3dd5f3) and the main-lineage image (2031b2c1) alike, diagnostic `agentReady:false`,
`agentDefaultIsCore:true`, `languageModelReady:true`; Copilot Chat never activated. A send after ~40 s took
the setup path, which re-enabled the extension, and worked; a relaunched profile worked.

| id | file / anchor | replacement / gate |
|---|---|---|
| `chat-enabled` | workbench.js `ensureChatExtensionInitialDisabledState`: `else try{this.logService.debug("Disabling builtin chat extension as chat set up is not completed"),this._disableExtension({id:this._chatExtensionId})}catch(n){this.logService.error("Failed to disable builtin chat extension during enablement migration",n)}` | `else try{this.logService.debug("EZiL: builtin chat extension stays enabled; EZiL Chat needs no setup, so setup is marked completed"),i.value.update({completed:!0})}catch(n){…}` (`i` is the function's own `chatEntitlementService.context`). Setup is marked completed as a successful setup run would mark it: nothing else does once requests reach Copilot's agent instead of the setup agent (`markSetupCompleted` has no caller), and the setup-only entries gated on `Setup.completed.negate()` would otherwise stay. A new profile then stores `completed:true, installed:true, disabled:false` before any message (read back from the browser state, 2026-11-08), the state of a profile that has finished setup. The migration flag is still stored once per profile, and the other branch (setup completed, extension disabled by the user: turn AI features off) is upstream's. With the same image and only this file changed, a new profile's message sent 3.5-3.7 s after load was answered in 4.7-6.4 s. A profile that the old build already disabled recovers as before (Restart / the setup path). Anchor 0, replacement 1. Offline test runs the bundle's own function against doubles (`chat-layout-patch.test.cjs`); image e2e pass `early` sends at once from new desktop and Android profiles. |

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
(Part 3: the in-view Sessions list over an empty chat, under the chat header,
`chat-header` above).

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
notice in the welcome strings, the chat header's info button (`chat-header`) and the
replacement dashboard/status popover. Neither
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

## static-id — a new workbench URL for every distinct set of served files

code-server serves its workbench (`workbench.js`, `workbench.css`,
`nls.messages.js`, the webview `pre/` page, workers) from
`/<quality>-<commit>/static/…` with `Cache-Control: public, max-age=31536000`
and no revalidation (`server-main.js` `_handleStatic`, mode 2 when built). The
patches in this file change those files but not the commit, so a browser that
had loaded an older EZiL image kept running its workbench after the computer
moved to a new image: measured on a carried browser profile, the image-33
workbench showed the pre-`chat-header` layout until the HTTP cache was removed.
Revalidation would not help that browser (its copies are fresh for a year), and
the commit is compiled into the client, server, extension-host and pty bundles
(the client also builds `/vscode-remote-resource` URLs from it), so it stays.

| id | file / anchor | replacement / gate |
|---|---|---|
| `static-id` | `out/server-main.js`: `IE="/static",Vq="/callback"` (the static route constant) | `IE="/static/ezil-<id>",Vq="/callback"`. Anchor 0, `IE="/static/ezil-` 1, and the exact replacement with the id recomputed by `--verify` 1. |
| `static-names` | `server-main.js`: `o.startsWith(IE)&&o.charCodeAt(IE.length)===47?this._handleStatic(t,e,o.substring(IE.length))` (router), `let I=Be.join(l,this._productPath,IE),` (the page's static base), `WORKBENCH_WEB_BASE_URL:I,`, `webviewEndpoint:I+"/out/vs/workbench/contrib/webview/browser/pre"` | Checked, never patched: each occurs once, so the constant still sets the URL of everything the page loads from the static route and the router still strips it. |

`<id>` is `ezil-` plus 20 hex digits of a SHA-256 over every file under
`lib/vscode` (sorted relative path and each file's SHA-256; symlinks by target),
computed after every other patch in this script. Excluded: `extensions/` (the
browser loads built-in extension files through `/vscode-remote-resource`, which
this path does not cover), `product.json` (compiled into the bundles; the
Dockerfile edits it afterwards) and `server-main.js` (it carries the id). The
same files give the same id; any changed served byte gives a new URL, so a new
image's workbench cannot be answered from an older image's cache entries, while
cookies, IndexedDB, local storage and the chat history are left alone. URLs
without the id (`…/static/out/…`) now answer 404. `--verify` recomputes the
id, and the Dockerfile re-runs it after its last layer, so a later edit of a
served file fails the build instead of shipping new bytes under an old URL.

Not covered: `/vscode-remote-resource` answers built-in extension files with the
same one-year header (no patched file is loaded by the browser that way), and a
tab left open across an image change requests the old path and has to be
reloaded.

```sh
COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/static-id-patch.test.cjs
```

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
Every pre-patch count must match. The verification also parses the four
patched JS files (`server-main.js` in place, where `lib/vscode/package.json`
makes it a module), compares the NLS JS/JSON arrays, checks the 0.69.0 manifest
identity and provider contribution, and requires `defaultChatAgent`, the MIT
license and original Microsoft headers. Compare LICENSE.txt with the original
extraction when reviewing an update. The JSON and CSS modifications are
recorded here; the three JS files carry inline modification notices.
