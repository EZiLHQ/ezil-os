#!/usr/bin/env bash
# patch-copilot-chat.sh — build-time patches that turn the open-source Copilot
# Chat bundled with code-server into "EZiL Chat": NO GitHub service is called
# from the chat stack in anonymous mode, and the user-visible GitHub/Copilot
# branding on the EZiL boot + Agent-prompt path is replaced. Strings and status
# visibility change; command ids, setting keys, registrations and licenses stay intact.
#
#   patch-copilot-chat.sh [<vscode-root>]     default /usr/lib/code-server/lib/vscode
#   patch-copilot-chat.sh --verify [<root>]   only run the post-patch gates
#
# Every patch is an EXACT-MATCH anchor with an occurrence count that must hold
# BEFORE the patch and a grep gate that must hold AFTER it, so a code-server
# bump that moves a string fails the Docker build visibly instead of shipping
# an image that quietly phones GitHub again or shows "GitHub Copilot" in the
# UI. The anchor/why/gate of each patch is documented in PATCHES.md next to
# this file; keep the two in sync. The bundled extension and the VS Code
# workbench are MIT (Copyright (c) Microsoft Corporation) — their LICENSE
# files are left untouched and each patched file gets a one-line
# modification notice, nothing that implies Microsoft/GitHub endorsement.
#
# Pinned input: code-server 4.141.0 / GitHub.copilot-chat 0.69.0.
# Files patched (all inside <root>):
#   extensions/copilot/dist/extension.js               copilot-chat extension host bundle
#   out/nls.messages.js, out/nls.messages.json         workbench English strings (index-addressed array)
#   out/vs/code/browser/workbench/workbench.js         accounts menu + session picker + AI status + chat history + chat header + tool selection
#   out/vs/code/browser/workbench/workbench.css        compact chat layout (header controls, one-row composer)
#   extensions/copilot/package{,.nls}.json            display strings
set -euo pipefail

VERIFY_ONLY=0
if [ "${1:-}" = "--verify" ]; then VERIFY_ONLY=1; shift; fi
ROOT="${1:-/usr/lib/code-server/lib/vscode}"
EXT="$ROOT/extensions/copilot/dist/extension.js"
NLS_JS="$ROOT/out/nls.messages.js"
NLS_JSON="$ROOT/out/nls.messages.json"
WB="$ROOT/out/vs/code/browser/workbench/workbench.js"
NOTICE='/* Modified at build time by EZiL (worker/copilot-chat/patch-copilot-chat.sh, see PATCHES.md): GitHub service calls disabled, strings rebranded "EZiL Chat". Original work: Copyright (c) Microsoft Corporation, MIT License (LICENSE.txt). */'

for f in "$EXT" "$NLS_JS" "$NLS_JSON" "$WB"; do
  [ -s "$f" ] || { echo "patch-copilot-chat: missing $f" >&2; exit 1; }
done
command -v node >/dev/null || { echo "patch-copilot-chat: node is required" >&2; exit 1; }

# count <file> <literal>  → number of exact (non-overlapping) occurrences
count() { node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");const n=process.argv[2];let c=0,i=0;for(;;){i=s.indexOf(n,i);if(i<0)break;c++;i+=n.length;}console.log(c)' "$1" "$2"; }

# patch <id> <file> <expected-count> <anchor> <replacement>
# Fails unless the anchor occurs exactly <expected-count> times; replaces all.
patch() {
  local id="$1" file="$2" want="$3" anchor="$4" repl="$5" have
  have="$(count "$file" "$anchor")"
  if [ "$have" != "$want" ]; then
    echo "patch-copilot-chat: [$id] anchor occurs $have times in $(basename "$file"), expected $want — the pinned code-server changed, re-derive the anchor (PATCHES.md)" >&2
    echo "  anchor: $anchor" >&2
    exit 1
  fi
  node -e 'const fs=require("fs");const [f,a,r]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").split(a).join(r))' "$file" "$anchor" "$repl"
  echo "patch-copilot-chat: [$id] $have occurrence(s) patched in $(basename "$file")"
}

# gate <id> <file> <expected-count> <literal>
gate() {
  local have; have="$(count "$2" "$4")"
  if [ "$have" != "$3" ]; then echo "patch-copilot-chat: GATE FAILED [$1] $(basename "$2"): '$4' occurs $have times, expected $3" >&2; exit 1; fi
  echo "patch-copilot-chat: gate ok [$1] $(basename "$2") x$have"
}

# Pin before changing anything, including in --verify mode.
node -e 'const fs=require("fs");const root=process.argv[1];const j=JSON.parse(fs.readFileSync(root+"/extensions/copilot/package.json","utf8"));if(j.publisher!=="GitHub"||j.name!=="copilot-chat"||j.version!=="0.69.0"||!j.contributes?.languageModelChatProviders)throw new Error("expected bundled GitHub.copilot-chat 0.69.0 with languageModelChatProviders");if(!JSON.parse(fs.readFileSync(root+"/product.json","utf8")).defaultChatAgent)throw new Error("defaultChatAgent missing");' "$ROOT"

# ── anchors / replacements (single source of truth for patch + gate) ────────
# Part 1 — no GitHub calls (extension.js)
A_TOKEN='this._logService.info("Allowing anonymous access with devDeviceId");let a=await this.authFromDevDeviceId(yGe.env.devDeviceId);'
R_TOKEN='this._logService.info("EZiL Chat: anonymous mode, GitHub token minting (copilot_internal/v2/nltoken) disabled at build time");let a={kind:"failure",reason:"GitHubLoginFailed"};'
A_KNOWN='this._logService.info("BYOK: fetching known models list");let r=await(await n.fetch("https://main.vscode-cdn.net/extensions/copilotChat.json",{method:"GET",callSite:"byok-known-models"})).json();'
R_KNOWN='this._logService.info("EZiL Chat: BYOK known-models CDN fetch disabled at build time, using an empty list");let r={version:1,modelInfo:{}};'
A_EMB_CACHE='async fetchRemoteCache(){if(this._remoteCacheEntries)return this._remoteCacheEntries;let e=await this.getRemoteCacheURL();try{'
R_EMB_CACHE='async fetchRemoteCache(){if(this._remoteCacheEntries)return this._remoteCacheEntries;return;let e=await this.getRemoteCacheURL();try{'
A_EMB_LATEST='async fetchRemoteCacheLatest(){let e=await this.getRemoteCacheLatestUpdateURL();try{'
R_EMB_LATEST='async fetchRemoteCacheLatest(){return;let e=await this.getRemoteCacheLatestUpdateURL();try{'
A_EMB_EXT='async fetchRemoteExtensionCache(n){let o=`${await this.getBaseExtensionCDNURL()}/${n}.json`;try{'
R_EMB_EXT='async fetchRemoteExtensionCache(n){return{};let o=`${await this.getBaseExtensionCDNURL()}/${n}.json`;try{'
# Part 2 — compact chat layout (workbench.css + two workbench.js anchors, PATCHES.md "Compact chat
# layout"). The chat view's bottom held a tip, the composer with the Agent/model row, a Local +
# permissions row and a two-line notice. The `chat-header` anchor moves the mode/model toolbar and
# the Local/permissions/context-usage toolbar (the same nodes, listeners kept) into the chat title
# row, puts that row at the top of the view in every state and adds an info button that carries the
# notice; `attach-execute` puts Add Context beside Send; the appended CSS (scoped to the class the
# header sets, so nothing changes if it did not run) makes the composer one row and hides the tip
# (`chat.tips.enabled` is application-scoped and has no effect in Machine settings, measured).
# The welcome disclaimer stays hidden upstream (rule below, gated, left as it is): it is not where
# the notice lives.
CSS="$ROOT/out/vs/code/browser/workbench/workbench.css"
[ -s "$CSS" ] || { echo "patch-copilot-chat: missing $CSS" >&2; exit 1; }
A_CSS='.chat-welcome-view .chat-welcome-view-message,.chat-welcome-view .chat-welcome-view-disclaimer,.chat-welcome-view .chat-welcome-view-tips{display:none}'
# The previous build's notice under the input; must not come back.
OLD_CSS_NOTICE='.interactive-input-part::after{content:"AI responses may be inaccurate.'
R_CSS_LAYOUT="$(printf '%s' \
  '.chat-viewpane.ezil-compact-chat>.chat-view-title-container .chat-view-title-inner{flex-wrap:wrap;column-gap:2px;row-gap:2px;min-height:30px}' \
  '.chat-viewpane.ezil-compact-chat>.chat-view-title-container .chat-view-title-navigation-toolbar{flex:1 1 96px;min-width:64px}' \
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header{display:contents;cursor:default}' \
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header>.chat-input-toolbars{display:contents}' \
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header>.chat-input-toolbars>.chat-input-toolbar{flex:0 1 auto;min-width:0;overflow:hidden}' \
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header>.chat-secondary-toolbar{flex:0 1 auto;min-width:0;padding:0}' \
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header>.ezil-chat-help{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin:0;padding:0;border:0;border-radius:var(--vscode-cornerRadius-small,4px);background:none;color:var(--vscode-icon-foreground);font-size:var(--vscode-codiconFontSize-compact,16px);cursor:pointer}' \
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header>.ezil-chat-help:hover{background-color:var(--vscode-toolbar-hoverBackground)}' \
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header>.ezil-chat-help:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}' \
  '.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-container{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:4px;align-items:end}' \
  '.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-container>*{grid-column:1/-1}' \
  '.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-container>.chat-editor-container{grid-column:1}' \
  '.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-container>.chat-input-toolbars{grid-column:2;margin:0 4px 11px 0;min-width:0!important}' \
  '.chat-viewpane .chat-getting-started-tip-container{display:none!important}')"
# workbench.js `chat-header`: ChatViewPane.createControls gains a call to a new method that moves the
# input part's own toolbar nodes into the title row (see PATCHES.md for every name it relies on).
A_CHAT_HEADER='createControls(e){let t=this.createSessionsControl(e),i=this.welcomeController=this._register(this.instantiationService.createInstance(P3e,e,this,"panel")),n=this.createChatControl(e);this.registerControlsListeners(t,n,i),this.updateSessionsControlVisibility()}'
R_CHAT_HEADER='createControls(e){let t=this.createSessionsControl(e),i=this.welcomeController=this._register(this.instantiationService.createInstance(P3e,e,this,"panel")),n=this.createChatControl(e);this.registerControlsListeners(t,n,i),this.updateSessionsControlVisibility();try{this._ezilChatHeader(e)}catch(f){this.logService.error("EZiL: chat header layout not applied",f)}}_ezilChatHeader(e){let t=this.titleControl?.titleContainer,i=t?.querySelector(".chat-view-title-inner"),n=this._widget?.inputPart,r=e.ownerDocument,s=e.parentElement,o=n?.inputContainerElement?.querySelector(".chat-input-toolbars"),k=n?.inputContainerElement?.querySelector(".chat-editor-container"),a=n?.inputToolbarElement,c=n?.secondaryToolbarContainer;if(!t||!i||!s||!o||!k||!a||!c)return;let l=r.createElement("div");l.className="interactive-session ezil-chat-header";for(let f of["click","-monaco-gesturetap"])l.addEventListener(f,g=>g.stopPropagation());let u=r.createElement("div");u.className="chat-input-toolbars";let p="AI responses may be inaccurate. Review changes before applying them.",h=r.createElement("button");h.type="button";h.className="ezil-chat-help codicon codicon-info";h.title=p;h.setAttribute("aria-label","EZiL Chat notice: "+p+" Opens EZiL AI status.");let w=()=>{Promise.resolve(this.commandService.executeCommand("ezil-models.showStatus")).catch(()=>this.notificationService.info(p))};h.addEventListener("click",w);h.addEventListener("keydown",g=>{(g.key==="Enter"||g.key===" ")&&(g.preventDefault(),g.stopPropagation(),w())});i.insertBefore(l,i.querySelector(".chat-view-title-actions-toolbar"));u.append(a);l.append(u,c,h);s.insertBefore(t,e);s.classList.add("ezil-compact-chat");let d=r.defaultView,v=0;if(d?.ResizeObserver){let m=new d.ResizeObserver(()=>{let x=k.querySelector(".monaco-editor");if(!x)return;let y=d.getComputedStyle(k),z=Math.max(0,Math.round(v+x.offsetWidth-(k.clientWidth-parseFloat(y.paddingLeft)-parseFloat(y.paddingRight))));z!==v&&(v=z,n.setInputEditorTrailingSpace(z))});m.observe(k),m.observe(o),this._register({dispose:()=>m.disconnect()})}}'
# Names the header method relies on (checked, never patched): each exact definition occurs once.
P_HEADER_TITLE='createChatTitleControl(e){this.titleControl='
P_HEADER_TITLE_ROOT='this.titleContainer=t.root,'
P_HEADER_INPUT_PART='get inputPart(){return this.inputPartDisposable.value}'
P_HEADER_INPUT_TOOLBAR='get inputToolbarElement(){return this.inputActionsToolbar.getElement()}'
P_HEADER_INPUT_CONTAINER='get inputContainerElement(){return this.inputContainer}'
P_HEADER_SECONDARY='this.secondaryToolbarContainer=r.secondaryToolbar;'
P_HEADER_TRAILING='setInputEditorTrailingSpace(e){let t=Math.max(0,e);'
P_HEADER_LAYOUT='Ze(".chat-input-container@inputContainer",[Ze(".chat-attachments-container@attachmentsContainer",[Ze(".chat-attached-context@attachedContextContainer")]),Ze(".chat-editor-container@editorContainer"),Ze(".chat-input-toolbars@inputToolbars")])'
P_HEADER_COMMANDS='this.chatEntitlementService=M;this.commandService=N;'
P_HEADER_NOTIFY='this.logService=v;this.notificationService=b;'
# workbench.js `attach-execute`: the chat view's Add Context entry (location "panel") moves from the
# ChatInput menu (now in the header) to ChatExecute, the toolbar Send lives in; that toolbar already
# renders this action (quick chat registers it there).
A_ATTACH='{when:T.and(J.inQuickChat.negate(),J.location.isEqualTo("panel"),T.or(J.lockedToCodingAgent.negate(),J.agentSupportsAttachments)),id:O.ChatInput,group:"navigation",order:-1}'
R_ATTACH='{when:T.and(J.inQuickChat.negate(),J.location.isEqualTo("panel"),T.or(J.lockedToCodingAgent.negate(),J.agentSupportsAttachments)),id:O.ChatExecute,group:"navigation",order:-1}'
# workbench.js `picker-flip`: every chat input picker (mode, model, model options, Local, permissions)
# takes its list options from SW, which forces anchorPosition 1: always above the button, the list
# capped to the space above it. From the header that leaves one row in a chat with turns. The upstream
# preferredAnchorPosition 1 (the chat input pills use it) opens above when the list fits and flips below
# when it does not. SW still overrides a caller's anchorPosition (the agent-host mode/permissions popup
# passes 1), so it alone picks the side; a picker in a dialog sets anchorPosition 0 after it, which wins.
A_PICKER_FLIP='function SW(s){return{...Vio(s),anchorPosition:1}}'
R_PICKER_FLIP='function SW(s){return{...Vio(s),anchorPosition:void 0,preferredAnchorPosition:1}}'
# Names the flip relies on (checked, never patched): the widget reads both options; the dialog override.
P_PICKER_OPTIONS='this._anchorPosition=a?.anchorPosition,this._preferredAnchorPosition=a?.preferredAnchorPosition,'
P_PICKER_DIALOG='G=r.closest(".monaco-dialog-box")?{...SW(K),anchorPosition:0}:SW(K)'
# workbench.js `picker-order`: when the header's pickers do not fit (a phone: Explorer and Chat side by side leave
# Chat about 160 px), the responsive layout (SEt) compacts them to icons right to left, so the model picker, right of
# the mode picker, lost its name first: only a sparkle icon was left (image e2e, 390 and 412 px). The model picker is
# the one item upstream lets shrink (canShrink: its name ellipsizes, model-picker-item flex-shrink:1), so it now
# compacts last: the mode picker becomes its icon first, then the model name shortens with an ellipsis, and only if
# even that does not fit is the model picker compacted. Same items, same compaction, same accessible names; nothing
# changes when everything fits (a desktop chat).
A_PICKER_ORDER='let t=this._getVisibleItemBounds().sort((i,n)=>n.bounds.left-i.bounds.left).map(({item:i})=>i);for(let i of t)i.setMinimal?.(!1),i.setCompact(!1);'
R_PICKER_ORDER='let t=this._getVisibleItemBounds().sort((i,n)=>(i.item.canShrink?1:0)-(n.item.canShrink?1:0)||n.bounds.left-i.bounds.left).map(({item:i})=>i);for(let i of t)i.setMinimal?.(!1),i.setCompact(!1);'
# Names the order relies on (checked, never patched): only the model picker is canShrink; the fit check lets a
# canShrink item be narrower than its preferred width.
P_PICKER_SHRINK='canShrink:r.id===u2.ID,'
P_PICKER_MODEL_ID='static{this.ID="workbench.action.chat.openModelPicker"}'
P_PICKER_FIT='if(!i.some(({item:r})=>r.canShrink)&&n.width>e+o4e)return!1;for(let{item:r,bounds:a}of i){let c=n.itemWidths.get(r);if(!r.canShrink&&c!==void 0&&a.width<c-o4e)return!1}return!0}'
# Part 2 — identity in the system prompt (extension.js)
A_IDENT='When asked for your name, you must respond with "GitHub Copilot".'
R_IDENT='You are EZiL Chat, an AI coding assistant. When asked for your name, you must respond with "EZiL Chat".'
A_IDENT2='you must state that you are using GitHub Copilot.'
R_IDENT2='you must state that you are using EZiL Chat.'
# Part 2 — workbench strings (nls.messages.js + nls.messages.json; JSON-encoded, quotes included)
A_TERMS_DOT='"By continuing with {0} Copilot, you agree to {1}'"'"'s [Terms]({2}) and [Privacy Statement]({3})."'
A_TERMS='"By continuing with {0} Copilot, you agree to {1}'"'"'s [Terms]({2}) and [Privacy Statement]({3})"'
R_TERMS='"AI responses may be inaccurate. Review changes before applying them."'
A_STATUS_ARIA='"Copilot status"';           R_STATUS_ARIA='"EZiL Chat status"'
A_STATUS_NAME='"Copilot Status"';           R_STATUS_NAME='"EZiL Chat Status"'
A_STATUS_RESUMED='"Copilot Resumed"';       R_STATUS_RESUMED='"EZiL Chat resumed"'
A_STATUS_DISABLED='"Copilot disabled"';     R_STATUS_DISABLED='"EZiL Chat disabled"'
A_ENABLE_MORE='"Sign in to enable more Copilot AI features."'
R_ENABLE_MORE='"EZiL Chat runs on the models configured for this workspace."'
# Part 2 — session-target picker (workbench.js): the core "Copilot" (agent-host, GitHub sign-in)
# row has no setting; the picker's own visibility filter learns to skip that one type.
A_PICKER='_isVisible(e){return y8t(e,this.configurationService,this.chatSessionsService,this.workspaceContextService.getWorkspace(),this.agentHostEnablementService.managedSandboxEnforced.get(),this.agentHostEnablementService.enabled.get())}'
R_PICKER='_isVisible(e){return e!==cn.AgentHostCopilot&&y8t(e,this.configurationService,this.chatSessionsService,this.workspaceContextService.getWorkspace(),this.agentHostEnablementService.managedSandboxEnforced.get(),this.agentHostEnablementService.enabled.get())}'
# Part 2 — the chat status-bar entry turns into "Sign In" (and a GitHub setup click) when the chat
# entitlement is signed out, which an anonymous BYOK session always is (workbench.js). Drop that branch so
# the entry keeps showing chat status, and never label the setup variant "Sign In".
A_STATUS_SIGNIN='if(this.chatEntitlementService.entitlement===1)return this.getSetupEntryProps();'
R_STATUS_SIGNIN='/* EZiL: no GitHub sign-in prompt in the chat status entry */'
A_STATUS_SETUP_TEXT='getSetupEntryProps(){let e=!this.isSignInTitleBarAffordanceVisible(),'
R_STATUS_SETUP_TEXT='getSetupEntryProps(){let e=!1,'
# Part 2 — extension manifest display names (package.json / package.nls.json, compact JSON)
PKG="$ROOT/extensions/copilot/package.json"
PKG_NLS="$ROOT/extensions/copilot/package.nls.json"
for f in "$PKG" "$PKG_NLS"; do [ -s "$f" ] || { echo "patch-copilot-chat: missing $f" >&2; exit 1; }; done
A_FULLNAME='"fullName":"GitHub Copilot"';                          R_FULLNAME='"fullName":"EZiL Chat"'
A_SUBMENU='"github.copilot.submenu.copilot.label":"Copilot"';       R_SUBMENU='"github.copilot.submenu.copilot.label":"EZiL Chat"'
A_WALKTHROUGH='"github.copilot.walkthrough.title":"GitHub Copilot"'; R_WALKTHROUGH='"github.copilot.walkthrough.title":"EZiL Chat"'
# Part 2 — Accounts menu "Sign in to use GitHub Copilot..." (workbench.js): no setting hides
# it, so its `when` clause becomes the always-false constant.
A_ACCOUNTS='id:"workbench.action.chat.triggerSetupFromAccounts",title:F(10538,"Sign in to use GitHub Copilot..."),menu:{id:O.AccountsContext,group:yyt,when:uqr}'
R_ACCOUNTS='id:"workbench.action.chat.triggerSetupFromAccounts",title:F(10538,"Sign in to use GitHub Copilot..."),menu:{id:O.AccountsContext,group:yyt,when:T.false()}'

# R2-D: the workbench owns the Copilot quota dashboard, including its account header.
# Keep commands registered; suppress the old status item and forward dashboard entry points.
A_AI_DASHBOARD='static{this.QUICK_SETTINGS_COLLAPSED_KEY="chatStatusDashboard.quickSettingsCollapsed"}render(){let e=Rh(this._store),'
R_AI_DASHBOARD='static{this.QUICK_SETTINGS_COLLAPSED_KEY="chatStatusDashboard.quickSettingsCollapsed"}render(){this.element.replaceChildren();this.element.appendChild(_("div",void 0,"EZiL AI"));let ezil=this.element.appendChild(_("button",{type:"button"},"Show credits and recent usage"));this._store.add(q(ezil,"click",()=>this.runCommandAndClose("ezil-models.showStatus")));this.element.appendChild(_("p",void 0,"AI responses may be inaccurate. Review changes before applying them."));return;let e=Rh(this._store),'
A_AI_ENTRY='update(){if(this.chatEntitlementService.sentiment.hidden)this.entry?.dispose(),this.entry=void 0;else{let t=this.getEntryProps();'
R_AI_ENTRY='update(){if(!0)this.entry?.dispose(),this.entry=void 0;else{let t=this.getEntryProps();'
A_AI_PLAN='"Copilot Free"'; R_AI_PLAN='"EZiL AI"'
A_AI_QUOTA='"Chat messages"'; R_AI_QUOTA='"Gateway usage"'
A_AI_LIMIT='"Limited"'; R_AI_LIMIT='"View EZiL AI status"'

# Part 3 — EZiL Chat history (workbench.js). Upstream the ChatSessionStore keeps sessions in
# <user-data>/User/workspaceStorage/<id>/chatSessions, where the id hashes
# vscode-remote://<browser host><folder> (code-server sets remoteAuthority to location.host),
# so it changes with the computer's address. For a single-folder window whose folder has
# .ezil/chat (editor-state.sh creates it in the EZiL workspace), the store uses that folder
# instead; it is decided as the store's first queued task, before any session file is read
# or written. Not-found keeps the upstream location; other errors retry, then log loudly.
A_HISTORY_ROOT='this.storeTask&&S.join(this.storeTask,{id:"join.chatSessionStore",label:d(12652,null)})}))}async handleWorkspaceTransition(e,t){'
R_HISTORY_ROOT='this.storeTask&&S.join(this.storeTask,{id:"join.chatSessionStore",label:d(12652,null)})})),!f.configuration&&f.folders.length===1&&this.storeQueue.queue(()=>this._ezilUseWorkspaceChat(f.folders[0].uri))}async _ezilUseWorkspaceChat(e){let t=Ve(e,".ezil","chat");for(let i=0;;i++)try{let n=await this.fileService.stat(t);n.isDirectory&&(this.storageRoot=t,this.logService.info(`EZiL: chat history in ${t.toString()}`));return}catch(n){if(ba(n)===1)return;if(i>=5){this.logService.error(`EZiL: chat history folder ${t.toString()} unreadable, using ${this.storageRoot.toString()}`,n);return}await new Promise(r=>setTimeout(r,1e3*(i+1)))}}async handleWorkspaceTransition(e,t){'
P_HISTORY_WORKSPACE='let f=this.workspaceContextService.getWorkspace(),v=!f.configuration&&f.folders.length===0,b=this.workspaceContextService.getWorkspace().id;this.storageRoot=v?Ve(this.userDataProfilesService.defaultProfile.globalStorageHome,"emptyWindowChatSessions"):Ve(this.environmentService.workspaceStorageHome,b,"chatSessions"),'
# The ChatSessionStore lists history only from
# its index (storage key chat.ChatSessionStore.index, workspace scope = browser IndexedDB
# per origin and URL path) and never rebuilds a missing index from the session files.
# The first index read in a window reconciles it with the chatSessions directory: files
# missing from the index are added (newest first, within the store's 400-entry cap),
# local entries whose file is gone are dropped. A failed listing changes nothing.
A_HISTORY_INDEX='async getIndex(){return this.storeQueue.queue(async()=>this.internalGetIndex().entries)}'
R_HISTORY_INDEX='async getIndex(){return this.storeQueue.queue(async()=>(this._ezilHistoryReconciled||await this._ezilReconcileHistory(),this.internalGetIndex().entries))}async _ezilReconcileHistory(){let t;try{t=await this.fileService.resolve(this.storageRoot,{resolveMetadata:!0})}catch(f){ba(f)===1&&(this._ezilHistoryReconciled=!0);return}this._ezilHistoryReconciled=!0;try{let i=this.internalGetIndex(),n=new Map,a=0,c=0;for(let f of t.children??[]){let g=!f.isDirectory&&/^(.+)\.jsonl?$/.exec(f.name);g&&n.set(g[1],Math.max(n.get(g[1])??0,f.mtime??0))}for(let[k,v]of Object.entries(i.entries))!v.isExternal&&!n.has(k)&&(delete i.entries[k],c++);let l=Object.values(i.entries).filter(v=>!v.isExternal),u=l.length>=zSn?Math.min(...l.map(v=>v.lastMessageDate)):-1/0;for(let[k]of[...n].filter(([k,g])=>!i.entries[k]&&g>u).sort((p,q)=>q[1]-p[1]).slice(0,zSn))try{let o=this.getStorageLocation(k),s=await this.readSessionFromLocation(o.flat,o.log,k),v=s?.value;if(!v||v.sessionId!==k||!Array.isArray(v.requests))continue;let e=await KSn(v);if(!v.customTitle)try{e.title=sC.getDefaultTitle(v.requests)||e.title}catch{}typeof v.workingDirectory=="string"&&(e.workingDirectory=v.workingDirectory),i.entries[k]=e,a++}catch{}(a||c)&&(await this.trimEntries(),await this.flushIndex(),this.logService.info(`EZiL: chat history index reconciled with ${this.storageRoot.toString()}: +${a} -${c}`))}catch(f){this.logService.error("EZiL: chat history index reconcile failed",f)}}'
# The names the reconcile uses must mean the same thing in this bundle (checked, never patched).
P_HISTORY_KSN='async function KSn(s){if(s instanceof sC){let e=klo(s);return e.stats=await p7t(s),e}let o=s.requests.at(-1)?.timestamp??s.creationDate;'
P_HISTORY_TITLE='get title(){return this._customTitle||sC.getDefaultTitle(this._requests)}'
P_HISTORY_CAP='var zSn=400,HTt="chat.ChatSessionStore.index"'
P_HISTORY_READ='return this.readSessionFromLocation(t.flat,t.log,e)})}async readSessionFromLocation(e,t,i){'
P_HISTORY_LOCATION='getStorageLocation(e){return{flat:ywe(this.storageRoot,e,".json"),log:'
P_HISTORY_NOTFOUND='ba(r)!==1&&this.reportError("sessionDelete","Error deleting chat session",r)'
# The chat title (whose click opens the session picker) rendered only once the current chat had a
# title. Always render it; an empty chat reads "Chat history".
A_HISTORY_ENTRY='shouldRender(){return!!this.model?.title}'
R_HISTORY_ENTRY='shouldRender(){return!0}'
A_HISTORY_LABEL='static{this.DEFAULT_TITLE=d(12379,null)}'
R_HISTORY_LABEL='static{this.DEFAULT_TITLE="Chat history"}'
# An empty chat's title is "" (not nullish), so the default label never showed: both the
# update path and the label created when the toolbar renders (which can come after it).
A_HISTORY_EMPTY_TITLE='this.title??X2.DEFAULT_TITLE'
R_HISTORY_EMPTY_TITLE='this.title||X2.DEFAULT_TITLE'
# The picker lists a snapshot of the agent-sessions model and never refreshes; opened before
# the local provider first resolved (measured: soon after load) it stayed empty. Resolve the
# local provider first. cn.Local is the local provider type; R9e holds agentSessionsService.
A_HISTORY_PICKER='async pickAgentSession(){let o=new A,e=o.add(this.quickInputService.createQuickPick({useSeparators:!0}))'
R_HISTORY_PICKER='async pickAgentSession(){await this.agentSessionsService.model.resolve(cn.Local).catch(()=>{});let o=new A,e=o.add(this.quickInputService.createQuickPick({useSeparators:!0}))'
P_HISTORY_LOCAL='r=[{id:cn.Local,label:n(cn.Local)}]'
P_HISTORY_PICKER_SERVICE='R9e=class{constructor(o,e,t,i,n,r,a){this.anchor=o;this.options=e;this.agentSessionsService=t;'
# The Sessions list (chat.viewSessions.enabled, Machine settings) offers a filter per session type:
# Local plus every chatSessions contribution, including the GitHub-hosted agent types the Machine
# settings and the target-picker patch keep out of EZiL Chat. EZiL runs local sessions only.
A_SESSION_FILTER='r=[{id:cn.Local,label:n(cn.Local)}];for(let l of this.chatSessionsService.getAllChatSessionContributions()){let u=l.sessionListGroup??l.type;r.find(p=>p.id===u)||r.push({id:u,label:n(u)})}'
R_SESSION_FILTER='r=[{id:cn.Local,label:n(cn.Local)}];'

# Part 4 — Agent tool selection (PATCHES.md "Agent tool selection"). Configure Tools stores a map of
# tool/tool-set id -> enabled; an id missing from it counts as enabled. Copilot's edit, search and
# web sets reach the picker only around the first request (measured: 7 rows before it, 9 after), so
# a user who switched every row off before that got those sets and their members back (`tools-absent`).
# A selection the user curated in Configure Tools (any entry off) now keeps ids it has never seen off
# too, so a narrowed choice never gains tools the user did not see; a missing id stays on (upstream)
# only when nothing is off (never configured, all on) or the selection is the pre-version-2
# disabled-only format or one a prompt file or tool include/exclude wrote (`tools-session`), so a
# prompt file naming not-yet-registered sets keeps them. Late tools then show unchecked in the picker.
A_TOOLS_LEGACY='if(o(a)){let c=a.disabledToolSets?.map(u=>[u,!1]),l=a.disabledTools?.map(u=>[u,!1]);return{toolSets:new Map(c),tools:new Map(l)}}'
R_TOOLS_LEGACY='if(o(a)){let c=a.disabledToolSets?.map(u=>[u,!1]),l=a.disabledTools?.map(u=>[u,!1]);return{toolSets:new Map(c),tools:new Map(l),ezilMissingOn:!0}}'
# workbench.js `tools-session`: a session selection written by code (`set(e,!0)`: a prompt file's
# `tools:`, tool include/exclude) is tagged missing-means-on; one Configure Tools writes (`set(b,!1)`)
# is not. Measured: a prompt file with tools ['edit','search'] as the first request lost both otherwise.
A_TOOLS_SESSION='set(e,t){let i=this._mode.get();if(t||this._sessionStates.has(i.id)){this._sessionStates.set(i.id,j_e.fromMap(e));return}'
R_TOOLS_SESSION='set(e,t){let i=this._mode.get();if(t||this._sessionStates.has(i.id)){this._sessionStates.set(i.id,t?{...j_e.fromMap(e),ezilMissingOn:!0}:j_e.fromMap(e));return}'
A_TOOLS_ABSENT='r||(r=this._globalState.read(e));for(let a of this._currentTools.read(e))a.canBeReferencedInPrompt&&t.set(a,r.tools.get(a.id)!==!1);for(let a of this._toolsService.getToolSetsForModel(i,e)){if(a.hiddenInToolsPicker)continue;let c=r.toolSets.get(a.id)!==!1;'
R_TOOLS_ABSENT='r||(r=this._globalState.read(e));let ezilAbsent=!!r.ezilMissingOn||!(r.tools.size||r.toolSets.size)||[...r.tools.values(),...r.toolSets.values()].every(z=>z!==!1);for(let a of this._currentTools.read(e))a.canBeReferencedInPrompt&&t.set(a,(r.tools.get(a.id)??ezilAbsent)!==!1);for(let a of this._toolsService.getToolSetsForModel(i,e)){if(a.hiddenInToolsPicker)continue;let c=(r.toolSets.get(a.id)??ezilAbsent)!==!1;'
# Names the selection relies on (checked, never patched): a set's members follow the set unless
# explicitly on; the request's tool map is entriesMap without the sets; Configure Tools saves the full
# map it showed; the storage format the legacy branch is told apart from.
P_TOOLS_MEMBERS='t.set(a,c);for(let l of a.getTools(e))t.set(l,c||r.tools.get(l.id)===!0)}return jT.fromMap(t)});'
P_TOOLS_REQUEST='this.userSelectedTools=be(e=>{let t={},i=this.entriesMap.read(e);for(let[n,r]of i)dm(n)||(t[n.id]=r);return t});'
P_TOOLS_PICKER='b&&r.input.selectedToolsModel.set(b,!1)'
P_TOOLS_STORAGE='function e(r){return ui(r)&&r.version===2&&Array.isArray(r.toolSetEntries)&&Array.isArray(r.toolEntries)}'
# The only code-written selections pass !0 (prompt-file metadata; tool include/exclude), which `tools-session` relies on.
P_TOOLS_PROMPT='let r=this.toolsService.toToolAndToolSetEnablementMap(t,this.input.selectedLanguageModel.get()?.metadata);this.input.selectedToolsModel.set(r,!0)'
P_TOOLS_FILTER='b.input.selectedToolsModel.set(D.enablementMap,!0)'
# extension.js `tools-forced`: the Agent's tool function (Ret) turns some tools on that the request's
# map does not list (insert_edit_into_file, replace_string_in_file, session_store_sql, tool search,
# tests/tasks, ...). When that map lists tools and every one is off, nothing is turned on: a tool
# missing from it is then sent only if the prompt references it (`enable_other_tool_*`), as upstream.
A_TOOLS_FORCED='let h=r.getEnabledTools(e,n,y=>{if(typeof m[y.name]=="boolean")return m[y.name]});'
R_TOOLS_FORCED='let ezilNone=$a.some(e.tools,()=>!0)&&!$a.some(e.tools,([,y])=>y!==!1),h=r.getEnabledTools(e,n,y=>{if(!ezilNone&&typeof m[y.name]=="boolean")return m[y.name]});'
# Names it relies on (checked, never patched): `$a.some` over the request's tool map, and
# getEnabledTools' order (explicit off, then the override, then prompt references, then explicit on).
P_TOOLS_EDITFILES='$a.some(e.tools,([y,v])=>(typeof y=="string"?y:y.name)==="copilot_editFiles"&&v===!1)'
P_TOOLS_ENABLED='let p=c.get(uH(d.name));if(p===!1)return!1;let m=o?.(d);if(m!==void 0)return m;for(let A of n.toolReferences)if(s.get(A.name)?.tags.includes(`enable_other_tool_${d.name}`))return!0;return p===!0'

if [ "$VERIFY_ONLY" = 0 ]; then
  patch ai-dashboard "$WB" 1 "$A_AI_DASHBOARD" "$R_AI_DASHBOARD"
  patch ai-entry "$WB" 1 "$A_AI_ENTRY" "$R_AI_ENTRY"
  patch token          "$EXT" 1  "$A_TOKEN"  "$R_TOKEN"
  patch known-models   "$EXT" 1  "$A_KNOWN"  "$R_KNOWN"
  patch embeddings-cache  "$EXT" 1 "$A_EMB_CACHE"  "$R_EMB_CACHE"
  patch embeddings-latest "$EXT" 1 "$A_EMB_LATEST" "$R_EMB_LATEST"
  patch embeddings-ext    "$EXT" 1 "$A_EMB_EXT"    "$R_EMB_EXT"
  gate chat-layout "$CSS" 1 "$A_CSS"
  gate chat-layout "$CSS" 0 "$R_CSS_LAYOUT"
  gate chat-layout "$CSS" 0 "$OLD_CSS_NOTICE"
  printf '\n%s\n' "$R_CSS_LAYOUT" >>"$CSS"
  echo "patch-copilot-chat: [chat-layout] appended to $(basename "$CSS")"
  patch identity       "$EXT" 13 "$A_IDENT"  "$R_IDENT"
  patch identity-model "$EXT" 2  "$A_IDENT2" "$R_IDENT2"
  for nls in "$NLS_JS" "$NLS_JSON"; do
    patch ai-plan "$nls" 1 "$A_AI_PLAN" "$R_AI_PLAN"
    patch ai-quota "$nls" 1 "$A_AI_QUOTA" "$R_AI_QUOTA"
    patch ai-limit "$nls" 1 "$A_AI_LIMIT" "$R_AI_LIMIT"
    patch terms-dot        "$nls" 1 "$A_TERMS_DOT"       "$R_TERMS"
    patch terms            "$nls" 4 "$A_TERMS"           "$R_TERMS"
    patch status-aria      "$nls" 1 "$A_STATUS_ARIA"     "$R_STATUS_ARIA"
    patch status-name      "$nls" 1 "$A_STATUS_NAME"     "$R_STATUS_NAME"
    patch status-resumed   "$nls" 1 "$A_STATUS_RESUMED"  "$R_STATUS_RESUMED"
    patch status-disabled  "$nls" 1 "$A_STATUS_DISABLED" "$R_STATUS_DISABLED"
    patch enable-more      "$nls" 1 "$A_ENABLE_MORE"     "$R_ENABLE_MORE"
  done
  patch accounts-menu  "$WB"  1  "$A_ACCOUNTS" "$R_ACCOUNTS"
  patch target-picker  "$WB"  1  "$A_PICKER"   "$R_PICKER"
  for p in "$P_HISTORY_KSN" "$P_HISTORY_TITLE" "$P_HISTORY_CAP" "$P_HISTORY_READ" "$P_HISTORY_LOCATION" "$P_HISTORY_NOTFOUND" "$P_HISTORY_WORKSPACE" "$P_HISTORY_LOCAL" "$P_HISTORY_PICKER_SERVICE"; do
    gate history-names "$WB" 1 "$p"
  done
  patch history-root   "$WB"  1  "$A_HISTORY_ROOT" "$R_HISTORY_ROOT"
  patch history-index  "$WB"  1  "$A_HISTORY_INDEX" "$R_HISTORY_INDEX"
  patch history-entry  "$WB"  1  "$A_HISTORY_ENTRY" "$R_HISTORY_ENTRY"
  patch history-label  "$WB"  1  "$A_HISTORY_LABEL" "$R_HISTORY_LABEL"
  patch history-empty-title "$WB" 2 "$A_HISTORY_EMPTY_TITLE" "$R_HISTORY_EMPTY_TITLE"
  patch history-picker "$WB"  1  "$A_HISTORY_PICKER" "$R_HISTORY_PICKER"
  patch session-filter "$WB" 1  "$A_SESSION_FILTER" "$R_SESSION_FILTER"
  for p in "$P_HEADER_TITLE" "$P_HEADER_TITLE_ROOT" "$P_HEADER_INPUT_PART" "$P_HEADER_INPUT_TOOLBAR" "$P_HEADER_INPUT_CONTAINER" "$P_HEADER_SECONDARY" "$P_HEADER_TRAILING" "$P_HEADER_LAYOUT" "$P_HEADER_COMMANDS" "$P_HEADER_NOTIFY"; do
    gate header-names "$WB" 1 "$p"
  done
  patch chat-header    "$WB"  1  "$A_CHAT_HEADER" "$R_CHAT_HEADER"
  patch attach-execute "$WB"  1  "$A_ATTACH" "$R_ATTACH"
  for p in "$P_PICKER_OPTIONS" "$P_PICKER_DIALOG"; do gate picker-names "$WB" 1 "$p"; done
  patch picker-flip    "$WB"  1  "$A_PICKER_FLIP" "$R_PICKER_FLIP"
  for p in "$P_PICKER_SHRINK" "$P_PICKER_MODEL_ID" "$P_PICKER_FIT"; do gate picker-order-names "$WB" 1 "$p"; done
  patch picker-order   "$WB"  1  "$A_PICKER_ORDER" "$R_PICKER_ORDER"
  patch status-signin  "$WB"  1  "$A_STATUS_SIGNIN" "$R_STATUS_SIGNIN"
  patch status-setup-text "$WB" 1 "$A_STATUS_SETUP_TEXT" "$R_STATUS_SETUP_TEXT"
  patch participant-fullname "$PKG" 6 "$A_FULLNAME" "$R_FULLNAME"
  patch submenu-label  "$PKG_NLS" 1 "$A_SUBMENU"     "$R_SUBMENU"
  patch walkthrough    "$PKG_NLS" 1 "$A_WALKTHROUGH" "$R_WALKTHROUGH"
  for p in "$P_TOOLS_MEMBERS" "$P_TOOLS_REQUEST" "$P_TOOLS_PICKER" "$P_TOOLS_STORAGE" "$P_TOOLS_PROMPT" "$P_TOOLS_FILTER"; do gate tools-names "$WB" 1 "$p"; done
  patch tools-legacy   "$WB"  1  "$A_TOOLS_LEGACY" "$R_TOOLS_LEGACY"
  patch tools-absent   "$WB"  1  "$A_TOOLS_ABSENT" "$R_TOOLS_ABSENT"
  patch tools-session  "$WB"  1  "$A_TOOLS_SESSION" "$R_TOOLS_SESSION"
  for p in "$P_TOOLS_EDITFILES" "$P_TOOLS_ENABLED"; do gate tools-names "$EXT" 1 "$p"; done
  patch tools-forced   "$EXT" 1  "$A_TOOLS_FORCED" "$R_TOOLS_FORCED"
  # modification notices (comments; the .json cannot carry one)
  for f in "$EXT" "$NLS_JS" "$WB"; do
    if ! head -c 400 "$f" | grep -qF 'Modified at build time by EZiL'; then
      node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,process.argv[2]+"\n"+fs.readFileSync(f,"utf8"))' "$f" "$NOTICE"
    fi
  done
fi

# ── gates: anchors gone, replacements present, files still parse ────────────
gate ai-dashboard "$WB" 0 "$A_AI_DASHBOARD"; gate ai-dashboard "$WB" 1 "$R_AI_DASHBOARD"
gate ai-entry "$WB" 0 "$A_AI_ENTRY"; gate ai-entry "$WB" 1 "$R_AI_ENTRY"
gate token            "$EXT" 0  "$A_TOKEN";        gate token            "$EXT" 1  "$R_TOKEN"
gate known-models     "$EXT" 0  "$A_KNOWN";        gate known-models     "$EXT" 1  "$R_KNOWN"
gate identity         "$EXT" 0  "$A_IDENT";        gate identity         "$EXT" 13 "$R_IDENT"
gate identity-model   "$EXT" 0  "$A_IDENT2";       gate identity-model   "$EXT" 2  "$R_IDENT2"
gate embeddings-cache  "$EXT" 0 "$A_EMB_CACHE";  gate embeddings-cache  "$EXT" 1 "$R_EMB_CACHE"
gate embeddings-latest "$EXT" 0 "$A_EMB_LATEST"; gate embeddings-latest "$EXT" 1 "$R_EMB_LATEST"
gate embeddings-ext    "$EXT" 0 "$A_EMB_EXT";    gate embeddings-ext    "$EXT" 1 "$R_EMB_EXT"
gate chat-layout "$CSS" 1 "$A_CSS";             gate chat-layout "$CSS" 1 "$R_CSS_LAYOUT"
gate chat-layout "$CSS" 0 "$OLD_CSS_NOTICE"
node -e 'const fs=require("fs");const [f,r]=process.argv.slice(1);const s=fs.readFileSync(f,"utf8");const i=s.lastIndexOf(r);let d=0;for(const c of s.slice(0,i).replace(/\/\*[\s\S]*?\*\//g,"")){if(c==="{")d++;else if(c==="}")d--}if(d!==0)throw new Error("chat-layout rules are nested (depth "+d+")");console.log("patch-copilot-chat: gate ok [chat-layout] top level")' "$CSS" "$R_CSS_LAYOUT"
gate no-devdeviceid-token "$EXT" 0 'await this.authFromDevDeviceId('
gate no-known-models-url  "$EXT" 0 'https://main.vscode-cdn.net/extensions/copilotChat.json'
for nls in "$NLS_JS" "$NLS_JSON"; do
  gate ai-plan "$nls" 0 "$A_AI_PLAN"; gate ai-plan "$nls" 1 "$R_AI_PLAN"
  gate ai-quota "$nls" 0 "$A_AI_QUOTA"; gate ai-quota "$nls" 1 "$R_AI_QUOTA"
  gate ai-limit "$nls" 0 "$A_AI_LIMIT"; gate ai-limit "$nls" 1 "$R_AI_LIMIT"
  gate terms          "$nls" 0 "$A_TERMS";         gate terms           "$nls" 5 "$R_TERMS"
  gate status-aria    "$nls" 0 "$A_STATUS_ARIA";   gate status-aria     "$nls" 1 "$R_STATUS_ARIA"
  gate status-name    "$nls" 0 "$A_STATUS_NAME";   gate status-name     "$nls" 1 "$R_STATUS_NAME"
  gate status-resumed "$nls" 0 "$A_STATUS_RESUMED"; gate status-resumed "$nls" 1 "$R_STATUS_RESUMED"
  gate status-disabled "$nls" 0 "$A_STATUS_DISABLED"; gate status-disabled "$nls" 1 "$R_STATUS_DISABLED"
  gate enable-more    "$nls" 0 "$A_ENABLE_MORE";   gate enable-more     "$nls" 1 "$R_ENABLE_MORE"
  gate no-terms-text  "$nls" 0 'By continuing with {0} Copilot'
done
gate accounts-menu    "$WB"  0  "$A_ACCOUNTS";     gate accounts-menu    "$WB"  1  "$R_ACCOUNTS"
gate target-picker    "$WB"  0  "$A_PICKER";       gate target-picker    "$WB"  1  "$R_PICKER"
for p in "$P_HISTORY_KSN" "$P_HISTORY_TITLE" "$P_HISTORY_CAP" "$P_HISTORY_READ" "$P_HISTORY_LOCATION" "$P_HISTORY_NOTFOUND" "$P_HISTORY_WORKSPACE" "$P_HISTORY_LOCAL" "$P_HISTORY_PICKER_SERVICE"; do
  gate history-names "$WB" 1 "$p"
done
gate history-root     "$WB"  0  "$A_HISTORY_ROOT";  gate history-root     "$WB"  1  "$R_HISTORY_ROOT"
gate history-index    "$WB"  0  "$A_HISTORY_INDEX"; gate history-index    "$WB"  1  "$R_HISTORY_INDEX"
gate history-entry    "$WB"  0  "$A_HISTORY_ENTRY"; gate history-entry    "$WB"  1  "$R_HISTORY_ENTRY"
gate history-label    "$WB"  0  "$A_HISTORY_LABEL"; gate history-label    "$WB"  1  "$R_HISTORY_LABEL"
gate history-empty-title "$WB" 0 "$A_HISTORY_EMPTY_TITLE"; gate history-empty-title "$WB" 2 "$R_HISTORY_EMPTY_TITLE"
gate history-picker   "$WB"  0  "$A_HISTORY_PICKER"; gate history-picker   "$WB"  1  "$R_HISTORY_PICKER"
for p in "$P_TOOLS_MEMBERS" "$P_TOOLS_REQUEST" "$P_TOOLS_PICKER" "$P_TOOLS_STORAGE" "$P_TOOLS_PROMPT" "$P_TOOLS_FILTER"; do gate tools-names "$WB" 1 "$p"; done
for p in "$P_TOOLS_EDITFILES" "$P_TOOLS_ENABLED"; do gate tools-names "$EXT" 1 "$p"; done
gate tools-legacy     "$WB"  0  "$A_TOOLS_LEGACY";  gate tools-legacy     "$WB"  1  "$R_TOOLS_LEGACY"
gate tools-absent     "$WB"  0  "$A_TOOLS_ABSENT";  gate tools-absent     "$WB"  1  "$R_TOOLS_ABSENT"
gate tools-session    "$WB"  0  "$A_TOOLS_SESSION"; gate tools-session    "$WB"  1  "$R_TOOLS_SESSION"
gate tools-forced     "$EXT" 0  "$A_TOOLS_FORCED";  gate tools-forced     "$EXT" 1  "$R_TOOLS_FORCED"
gate session-filter   "$WB"  0  "$A_SESSION_FILTER"; gate session-filter   "$WB"  1  "$R_SESSION_FILTER"
for p in "$P_HEADER_TITLE" "$P_HEADER_TITLE_ROOT" "$P_HEADER_INPUT_PART" "$P_HEADER_INPUT_TOOLBAR" "$P_HEADER_INPUT_CONTAINER" "$P_HEADER_SECONDARY" "$P_HEADER_TRAILING" "$P_HEADER_LAYOUT" "$P_HEADER_COMMANDS" "$P_HEADER_NOTIFY"; do
  gate header-names "$WB" 1 "$p"
done
gate chat-header      "$WB"  0  "$A_CHAT_HEADER";   gate chat-header      "$WB"  1  "$R_CHAT_HEADER"
gate attach-execute   "$WB"  0  "$A_ATTACH";        gate attach-execute   "$WB"  1  "$R_ATTACH"
for p in "$P_PICKER_OPTIONS" "$P_PICKER_DIALOG"; do gate picker-names "$WB" 1 "$p"; done
gate picker-flip      "$WB"  0  "$A_PICKER_FLIP";   gate picker-flip      "$WB"  1  "$R_PICKER_FLIP"
for p in "$P_PICKER_SHRINK" "$P_PICKER_MODEL_ID" "$P_PICKER_FIT"; do gate picker-order-names "$WB" 1 "$p"; done
gate picker-order     "$WB"  0  "$A_PICKER_ORDER";  gate picker-order     "$WB"  1  "$R_PICKER_ORDER"
gate status-signin    "$WB"  0  "$A_STATUS_SIGNIN"; gate status-signin    "$WB"  1  "$R_STATUS_SIGNIN"
gate status-setup-text "$WB" 0 "$A_STATUS_SETUP_TEXT"; gate status-setup-text "$WB" 1 "$R_STATUS_SETUP_TEXT"
gate participant-fullname "$PKG" 0 "$A_FULLNAME";  gate participant-fullname "$PKG" 6 "$R_FULLNAME"
gate submenu-label    "$PKG_NLS" 0 "$A_SUBMENU";   gate submenu-label    "$PKG_NLS" 1 "$R_SUBMENU"
gate walkthrough      "$PKG_NLS" 0 "$A_WALKTHROUGH"; gate walkthrough    "$PKG_NLS" 1 "$R_WALKTHROUGH"
node -e 'for(const f of process.argv.slice(1)){const j=JSON.parse(require("fs").readFileSync(f,"utf8"));if(f.endsWith("package.json")&&(j.publisher!=="GitHub"||j.name!=="copilot-chat"))throw new Error("package.json identity changed");}console.log("patch-copilot-chat: gate ok [manifest JSON parses, publisher/name untouched]")' "$PKG" "$PKG_NLS"
for f in "$EXT" "$NLS_JS" "$WB"; do gate notice "$f" 1 'Modified at build time by EZiL'; done
# the nls array must still be valid and keep its length; extension.js must still parse
node -e '
const fs=require("fs"),vm=require("vm");
const json=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const ctx={globalThis:{}};vm.runInNewContext(fs.readFileSync(process.argv[2],"utf8"),ctx);
const js=ctx.globalThis._VSCODE_NLS_MESSAGES;
if(!Array.isArray(json)||!Array.isArray(js))throw new Error("nls messages are not arrays");
if(json.length!==js.length)throw new Error(`nls.messages.js (${js.length}) and .json (${json.length}) differ in length`);
for(let i=0;i<js.length;i++)if(js[i]!==json[i])throw new Error("nls.messages.js and .json differ at index "+i);
console.log("patch-copilot-chat: gate ok [nls-parse] "+js.length+" messages, .js and .json identical");
' "$NLS_JSON" "$NLS_JS"
for f in "$EXT" "$WB" "$NLS_JS"; do node --check "$f"; done
echo "patch-copilot-chat: gate ok [patched JavaScript parses]"
# license/copyright notices must be intact
test -s "$ROOT/extensions/copilot/LICENSE.txt"
grep -q "MIT License" "$ROOT/extensions/copilot/LICENSE.txt"
grep -qi "Copyright (c) Microsoft Corporation" "$ROOT/extensions/copilot/LICENSE.txt"
echo "patch-copilot-chat: gate ok [copilot LICENSE.txt intact]"
grep -q "Copyright (C) Microsoft Corporation" "$NLS_JS"
grep -q "Copyright (C) Microsoft Corporation" "$WB"
echo "patch-copilot-chat: gate ok [Microsoft copyright headers intact]"
echo "patch-copilot-chat: all gates passed"
