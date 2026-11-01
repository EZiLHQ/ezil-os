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
#   out/vs/code/browser/workbench/workbench.js         accounts menu + session picker + AI status + chat history
#   out/vs/code/browser/workbench/workbench.css        EZiL notice under the chat input
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
# Part 2 — the EZiL notice (workbench.css). The welcome that carried it is hidden whenever BYOK
# models exist (the upstream rule below, nested in `.interactive-session.chat-view-getting-started-disabled{…}`,
# left as it is) and, with the Sessions list on, an empty chat shows the list instead. The notice
# becomes one line under the chat view's input, in every chat state: a top-level rule appended to
# the file (next to the upstream rule it would be nested too, and match nothing).
CSS="$ROOT/out/vs/code/browser/workbench/workbench.css"
[ -s "$CSS" ] || { echo "patch-copilot-chat: missing $CSS" >&2; exit 1; }
A_CSS='.chat-welcome-view .chat-welcome-view-message,.chat-welcome-view .chat-welcome-view-disclaimer,.chat-welcome-view .chat-welcome-view-tips{display:none}'
R_CSS_NOTICE='.chat-viewpane .interactive-session>.interactive-input-part::after{content:"AI responses may be inaccurate. Review changes before applying them.";display:block;padding:2px 4px 0;font-size:11px;line-height:16px;color:var(--vscode-descriptionForeground);text-align:center}'
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

if [ "$VERIFY_ONLY" = 0 ]; then
  patch ai-dashboard "$WB" 1 "$A_AI_DASHBOARD" "$R_AI_DASHBOARD"
  patch ai-entry "$WB" 1 "$A_AI_ENTRY" "$R_AI_ENTRY"
  patch token          "$EXT" 1  "$A_TOKEN"  "$R_TOKEN"
  patch known-models   "$EXT" 1  "$A_KNOWN"  "$R_KNOWN"
  patch embeddings-cache  "$EXT" 1 "$A_EMB_CACHE"  "$R_EMB_CACHE"
  patch embeddings-latest "$EXT" 1 "$A_EMB_LATEST" "$R_EMB_LATEST"
  patch embeddings-ext    "$EXT" 1 "$A_EMB_EXT"    "$R_EMB_EXT"
  gate chat-notice "$CSS" 1 "$A_CSS"
  gate chat-notice "$CSS" 0 "$R_CSS_NOTICE"
  printf '\n%s\n' "$R_CSS_NOTICE" >>"$CSS"
  echo "patch-copilot-chat: [chat-notice] appended to $(basename "$CSS")"
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
  patch status-signin  "$WB"  1  "$A_STATUS_SIGNIN" "$R_STATUS_SIGNIN"
  patch status-setup-text "$WB" 1 "$A_STATUS_SETUP_TEXT" "$R_STATUS_SETUP_TEXT"
  patch participant-fullname "$PKG" 6 "$A_FULLNAME" "$R_FULLNAME"
  patch submenu-label  "$PKG_NLS" 1 "$A_SUBMENU"     "$R_SUBMENU"
  patch walkthrough    "$PKG_NLS" 1 "$A_WALKTHROUGH" "$R_WALKTHROUGH"
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
gate chat-notice "$CSS" 1 "$A_CSS";             gate chat-notice "$CSS" 1 "$R_CSS_NOTICE"
node -e 'const fs=require("fs");const [f,r]=process.argv.slice(1);const s=fs.readFileSync(f,"utf8");const i=s.lastIndexOf(r);let d=0;for(const c of s.slice(0,i).replace(/\/\*[\s\S]*?\*\//g,"")){if(c==="{")d++;else if(c==="}")d--}if(d!==0)throw new Error("chat-notice rule is nested (depth "+d+")");console.log("patch-copilot-chat: gate ok [chat-notice] top level")' "$CSS" "$R_CSS_NOTICE"
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
gate session-filter   "$WB"  0  "$A_SESSION_FILTER"; gate session-filter   "$WB"  1  "$R_SESSION_FILTER"
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
