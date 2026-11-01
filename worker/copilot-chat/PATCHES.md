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
