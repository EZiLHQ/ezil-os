#!/usr/bin/env bash
# patch-copilot-chat.sh — build-time patches that turn the open-source Copilot
# Chat bundled with code-server into "EZiL Chat": NO GitHub service is called
# from the chat stack in anonymous mode, and the user-visible GitHub/Copilot
# branding on the EZiL boot + Agent-prompt path is replaced. Strings and status
# visibility change; upstream command ids, setting keys and licenses stay intact.
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
#   out/vs/code/browser/workbench/workbench.js         accounts menu + session picker + AI status + chat history + chat header
#   out/vs/code/browser/workbench/workbench.css        compact chat layout (header controls, tip hidden)
#   extensions/copilot/package{,.nls}.json            display strings
#   out/server-main.js                                 workbench static path carries a content id (static-id)
set -euo pipefail

VERIFY_ONLY=0
if [ "${1:-}" = "--verify" ]; then VERIFY_ONLY=1; shift; fi
ROOT="${1:-/usr/lib/code-server/lib/vscode}"
EXT="$ROOT/extensions/copilot/dist/extension.js"
NLS_JS="$ROOT/out/nls.messages.js"
NLS_JSON="$ROOT/out/nls.messages.json"
WB="$ROOT/out/vs/code/browser/workbench/workbench.js"
SERVER="$ROOT/out/server-main.js"
NOTICE='/* Modified at build time by EZiL (worker/copilot-chat/patch-copilot-chat.sh, see PATCHES.md): GitHub service calls disabled, strings rebranded "EZiL Chat". Original work: Copyright (c) Microsoft Corporation, MIT License (LICENSE.txt). */'

for f in "$EXT" "$NLS_JS" "$NLS_JSON" "$WB" "$SERVER"; do
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

# static_id <root> → "ezil-" + 20 hex of a sha256 over every file the workbench static route can serve: all of
# <root> except extensions/ (the browser loads those through /vscode-remote-resource), product.json (compiled into
# the bundles; the Dockerfile edits it later) and out/server-main.js (it carries the id). PATCHES.md "static-id".
static_id() {
  node -e 'const fs=require("fs"),path=require("path"),crypto=require("crypto");const root=process.argv[1],skip=new Set(["extensions","product.json","out/server-main.js"]),rows=[];
(function walk(rel){for(const e of fs.readdirSync(path.join(root,rel),{withFileTypes:true})){const r=rel?rel+"/"+e.name:e.name,p=path.join(root,r);if(skip.has(r))continue;if(e.isDirectory())walk(r);else if(e.isSymbolicLink())rows.push(["L",r,fs.readlinkSync(p)]);else if(e.isFile())rows.push(["F",r,crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")]);}})("");
rows.sort((a,b)=>a[1]<b[1]?-1:a[1]>b[1]?1:0);const h=crypto.createHash("sha256");for(const row of rows)h.update(row.join("\0")+"\n");console.log("ezil-"+h.digest("hex").slice(0,20))' "$1"
}

# Pin before changing anything, including in --verify mode.
node -e 'const fs=require("fs");const root=process.argv[1];const j=JSON.parse(fs.readFileSync(root+"/extensions/copilot/package.json","utf8"));if(j.publisher!=="GitHub"||j.name!=="copilot-chat"||j.version!=="0.69.0"||!j.contributes?.languageModelChatProviders)throw new Error("expected bundled GitHub.copilot-chat 0.69.0 with languageModelChatProviders");if(!JSON.parse(fs.readFileSync(root+"/product.json","utf8")).defaultChatAgent)throw new Error("defaultChatAgent missing");' "$ROOT"

# ── anchors / replacements (single source of truth for patch + gate) ────────
# CommandsRegistry (`qe`) has just been initialized; the following `YLi` declaration makes the
# anchor disappear after insertion. One renderer command, no registration in the extension host.
A_APP_FAILURE='qe.registerCommand("noop",()=>{});var YLi='
APP_FAILURE_VALIDATOR='const matches=(v,re)=>typeof v==="string"&&re.exec(v)?.[0]===v;const uuid=v=>matches(v,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;const codes={interrupted:["stream_interrupted"],network:["network_offline","network_failed"],timeout:["request_timeout","first_token_timeout"],auth:["auth_expired","auth_invalid","session_expired"],credits:["credits_exhausted"],entitlement:["membership_required","model_not_entitled"],rate_limit:["rate_limited"],provider:["provider_error","provider_overloaded","provider_refused","model_unavailable"],cancellation:["request_cancelled"],app_startup:["app_start_failed","app_start_timeout","chat_unavailable"]};const enums={source:["ezil_chat","code_app"],operation:["chat_request","app_start"],stage:["startup","admission","request","headers","stream"],outcome:["failed","retrying","recovered","cancelled"],streamReason:["eof","malformed_event","missing_terminal"],cancellationSource:["caller","user_stop","unknown"]};const keys=new Set(["eventId","source","operation","category","code","stage","outcome","streamReason","cancellationSource","clientRequestId","gatewayRequestId","vscodeRequestId","retryOfClientRequestId","attempt","retryable","durationMs","modelKey","httpStatus"]);const namespaces=new Set(["anthropic","openai","google","gemini","vertex","bedrock","aws-bedrock","amazon","azure","qwen","moonshot","moonshotai","kimi","zai","z-ai","glm","deepseek","mistral","meta","llama","xai","cohere","minimax","groq","cerebras","openrouter","ezil"]);const families=new Set(["claude","gemini","gpt","qwen","kimi","glm","deepseek","mistral","codestral","llama","grok","nova","ezil","minimax","command","sonar"]);const safeModelKey=value=>{if(typeof value!=="string"||!/^[a-z0-9][a-z0-9._:/-]{0,63}$/.test(value)||value!==value.trim())return false;if(value.includes("://")||value.split("/").length>2)return false;const key=value.replace(/^(?:us|eu|apac|global|au|jp)[.]/,"");const match=/^([a-z0-9-]+)[/.](.+)$/.exec(key);let model;if(match&&namespaces.has(match[1]))model=match[2];else if(families.has((/^[a-z]+/.exec(key)||[""])[0]))model=key;else return false;const segments=model.split(/[/.:]/);if(segments.some(segment=>!segment||/^(?:sk|sb|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_]/.test(segment)||/secret|token|passw|bearer|api[-_]?key|private|credential|session|cookie/.test(segment)||/[a-z0-9]{20,}/.test(segment)))return false;return /[0-9-]/.test(segments[0]);};const valid=r=>{if(!r||typeof r!=="object"||Array.isArray(r)||!Reflect.ownKeys(r).every(k=>keys.has(k)))return false;for(const [k,values] of Object.entries(enums))if(r[k]!==undefined&&!values.includes(r[k]))return false;if(!uuid(r.eventId)||r.source===undefined||r.operation===undefined||r.stage===undefined||r.outcome===undefined)return false;if(typeof r.category!=="string"||!Object.prototype.hasOwnProperty.call(codes,r.category)||typeof r.code!=="string")return false;if(r.code!=="unexpected_error"&&!codes[r.category].includes(r.code))return false;if(r.streamReason!==undefined&&r.stage!=="stream")return false;if((r.category==="cancellation")!==(r.cancellationSource!==undefined))return false;if((r.category==="cancellation")!==(r.outcome==="cancelled"))return false;for(const k of ["clientRequestId","gatewayRequestId","vscodeRequestId","retryOfClientRequestId"])if(r[k]!==undefined&&!uuid(r[k]))return false;if(r.attempt!==undefined&&!integer(r.attempt,1,64))return false;if(r.retryable!==undefined&&typeof r.retryable!=="boolean")return false;if(r.durationMs!==undefined&&!integer(r.durationMs,0,3600000))return false;if(r.modelKey!==undefined&&!safeModelKey(r.modelKey))return false;if(r.httpStatus!==undefined&&!integer(r.httpStatus,100,599))return false;return true;};'
R_APP_FAILURE='qe.registerCommand("noop",()=>{});function ezilDispatchAppFailure(record){try{'"$APP_FAILURE_VALIDATOR"'if(!record||typeof record!=="object"||Array.isArray(record))return;const clean=Object.create(null);let dropped=false;for(const key of Reflect.ownKeys(record)){if(!keys.has(key)){dropped=true;continue}const desc=Object.getOwnPropertyDescriptor(record,key);if(!desc||!("value" in desc)){dropped=true;continue}const value=desc.value;const type=["attempt","durationMs","httpStatus"].includes(key)?"number":key==="retryable"?"boolean":"string";if(typeof value!==type||(type==="string"&&value.length>64)||(type==="number"&&!Number.isFinite(value))||(type==="number"&&!Number.isInteger(value))){dropped=true;continue}clean[key]=value}if(dropped||!valid(clean))return;window.dispatchEvent(new CustomEvent("ezil-app-failure",{detail:JSON.stringify(clean)}))}catch{}}qe.registerCommand("_ezil.appFailure",(accessor,record)=>{ezilDispatchAppFailure(record)});var YLi='
# SetupAgent readiness timeout: NLS 10557/10558, once in 4.141.0. No elapsed duration is in scope.
A_APP_START_TIMEOUT='if(M==="timedout"){let N;this.chatEntitlementService.anonymous?N=d(10558,null,RF.chatExtensionId):N=d(10557,null,RF.provider.default.name,RF.chatExtensionId);'
R_APP_START_TIMEOUT='if(M==="timedout"){try{ezilDispatchAppFailure({eventId:crypto.randomUUID(),source:"code_app",operation:"app_start",category:"app_startup",code:"app_start_timeout",stage:"startup",outcome:"failed"})}catch{}let N;this.chatEntitlementService.anonymous?N=d(10558,null,RF.chatExtensionId):N=d(10557,null,RF.provider.default.name,RF.chatExtensionId);'
# Part 1 — no GitHub calls (extension.js)
# Plan locks and billing asks (PATCHES.md "Plan-locked models and billing asks"). The ezil-models extension lists a
# model the account's OS plan does not include (Free: Gemini 3.8 Flash only) as isUserSelectable:false with a lock
# icon and infoText.ezilPlanLocked, so VS Code never defaults to, restores or hands it to an agent. `billing-intent`
# adds, right after the CommandsRegistry class (before the app-failure registration, which stays byte-identical):
# the renderer command `_ezil.billingIntent` the extension calls to ask the EZiL OS window for its billing dialog (true
# only when a listener on the cancelable `ezil-billing-intent` window event took it, i.e. called preventDefault), and
# the two picker helpers. `picker-locked-list` lists those locked rows in the flat/grouped model picker only (`Bhn`),
# and only for a vendor that picker already lists; the tabbed picker and every other model list are unchanged.
# `picker-locked-pin` offers no pin for a locked row (unpinning one pinned earlier stays possible).
# `picker-locked-select` turns choosing a locked row into `_ezil-models.lockedModel` (the extension re-reads the plan,
# then asks for the upgrade) instead of selecting it, and `picker-locked-configure` stops the configure path there too:
# the selected model, the conversation and the input stay as they are, and nothing is sent.
A_BILLING_INTENT='getCommands(){let s=new Map;for(let o of this._commands.keys()){let e=this.getCommand(o);e&&s.set(o,e)}return s}};'
R_BILLING_INTENT='getCommands(){let s=new Map;for(let o of this._commands.keys()){let e=this.getCommand(o);e&&s.set(o,e)}return s}};function ezilDispatchBillingIntent(record){try{if(!record||typeof record!=="object"||Array.isArray(record))return false;const keys=Reflect.ownKeys(record);if(!keys.every(k=>k==="reason"||k==="requestId"||k==="model"||k==="resetsAt"))return false;const clean=Object.create(null);for(const k of keys){const desc=Object.getOwnPropertyDescriptor(record,k);if(!desc||!("value" in desc)||typeof desc.value!=="string")return false;clean[k]=desc.value}if(clean.reason!=="credits_exhausted"&&clean.reason!=="model_locked"&&clean.reason!=="window_limit")return false;if(clean.requestId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clean.requestId))return false;if(clean.model!==undefined&&!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(clean.model))return false;if(clean.resetsAt!==undefined&&(clean.reason!=="window_limit"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/.test(clean.resetsAt)))return false;return!window.dispatchEvent(new CustomEvent("ezil-billing-intent",{detail:JSON.stringify(clean),cancelable:true}))}catch{return false}}function ezilPlanLocked(model){try{const metadata=model&&model.metadata,info=metadata&&metadata.infoText;return!!info&&typeof info==="object"&&typeof info.ezilPlanLocked==="string"&&metadata.isUserSelectable===!1&&!metadata.targetChatSessionType}catch{return false}}function ezilPickerModels(service,models){try{const listed=new Set(models.map(model=>model.identifier)),vendors=new Set(models.map(model=>model.metadata&&model.metadata.vendor)),locked=[];for(const identifier of service.getLanguageModelIds()){if(listed.has(identifier)||service.isModelHidden(identifier))continue;const metadata=service.lookupLanguageModel(identifier);if(metadata&&vendors.has(metadata.vendor)&&ezilPlanLocked({metadata}))locked.push({identifier,metadata})}return locked.length?models.concat(locked):models}catch{return models}}qe.registerCommand("_ezil.billingIntent",(accessor,record)=>ezilDispatchBillingIntent(record));'
A_PICKER_LOCKED_LIST='let D=!1,M=Bhn({models:u,'
R_PICKER_LOCKED_LIST='let D=!1,M=Bhn({models:ezilPickerModels(this._languageModelsService,u),'
A_PICKER_LOCKED_PIN='makePinAction:n=>s.actions.onTogglePin?Lhn(n.identifier,s.pinnedModelIds.includes(n.identifier),s.actions.onTogglePin):void 0'
R_PICKER_LOCKED_PIN='makePinAction:n=>s.actions.onTogglePin&&(!ezilPlanLocked(n)||s.pinnedModelIds.includes(n.identifier))?Lhn(n.identifier,s.pinnedModelIds.includes(n.identifier),s.actions.onTogglePin):void 0'
A_PICKER_LOCKED_CONFIGURE=',l=(ee,ae,he)=>{c(ee),this._actionWidgetService.hide(),this._configuration.show('
R_PICKER_LOCKED_CONFIGURE=',l=(ee,ae,he)=>{if(ezilPlanLocked(ee))return void c(ee);c(ee),this._actionWidgetService.hide(),this._configuration.show('
A_PICKER_LOCKED_SELECT='c=ee=>{a.logModelChange(this._selectedModel,ee,this._delegate.getChatSessionId?.()),this._selectedModel=ee,this._renderLabel(),this._onDidChangeSelection.fire(ee)}'
R_PICKER_LOCKED_SELECT='c=ee=>{if(ezilPlanLocked(ee)){Promise.resolve(this._commandService.executeCommand("_ezil-models.lockedModel",ee.metadata.id)).catch(()=>{});return}a.logModelChange(this._selectedModel,ee,this._delegate.getChatSessionId?.()),this._selectedModel=ee,this._renderLabel(),this._onDidChangeSelection.fire(ee)}'
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
# permissions row and a two-line notice. The `chat-header` anchor moves the Local/permissions/
# context-usage toolbar (the same nodes, listeners kept) into the chat title row, puts that row at
# the top of the view in every state and adds an info button that carries the notice. The mode/model
# toolbar stays in the composer, under the input beside Send: the founder asked for the model picker
# at the composer, not across the panel in the header (2026-11-08). `attach-execute` puts Add
# Context beside Send; the appended CSS (scoped to the class the header sets, so nothing changes if
# it did not run) lays out the header, keeps Send in view on a narrow composer, and hides the tip. On a phone (Explorer
# and Chat side by side: a 121 px composer row) mode, model and Configure Tools need 144 px (the responsive toolbar
# writes that minimum inline: they never overflow) and Add Context + Send 48: they pushed Send out of the composer.
# Below a 208 px composer only, Add Context and Send wrap to their own line, right-aligned; the pickers take the first
# line, the mode picker compacts and the model name ellipsizes (minimum 56 px: above what is left beside an expanded
# mode picker, so that one compacts first). Measured at 412 and 390 px: model label 60 px, Send inside the composer. (`chat.tips.enabled` is application-scoped
# and has no effect in Machine settings, measured).
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
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header>.chat-secondary-toolbar{flex:0 1 auto;min-width:0;padding:0}' \
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header>.ezil-chat-help{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin:0;padding:0;border:0;border-radius:var(--vscode-cornerRadius-small,4px);background:none;color:var(--vscode-icon-foreground);font-size:var(--vscode-codiconFontSize-compact,16px);cursor:pointer}' \
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header>.ezil-chat-help:hover{background-color:var(--vscode-toolbar-hoverBackground)}' \
  '.chat-viewpane.ezil-compact-chat .ezil-chat-header>.ezil-chat-help:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}' \
  '.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-toolbars{min-width:0!important}' \
  '.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-container{container:ezil-composer/inline-size}' \
  '@container ezil-composer (max-width:207px){.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-toolbars{flex-wrap:wrap;row-gap:4px}.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-toolbars>.chat-input-toolbar{flex:1 0 100%;min-width:0!important}.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-toolbars>.chat-input-toolbar .model-picker-item{min-width:56px!important}.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-toolbars>.chat-execute-toolbar{margin-left:auto}}' \
  '.chat-viewpane .chat-getting-started-tip-container{display:none!important}')"
# workbench.js `chat-header`: ChatViewPane.createControls gains a call to a new method that moves the
# input part's secondary toolbar node into the title row (see PATCHES.md for every name it relies on).
A_CHAT_HEADER='createControls(e){let t=this.createSessionsControl(e),i=this.welcomeController=this._register(this.instantiationService.createInstance(P3e,e,this,"panel")),n=this.createChatControl(e);this.registerControlsListeners(t,n,i),this.updateSessionsControlVisibility()}'
R_CHAT_HEADER='createControls(e){let t=this.createSessionsControl(e),i=this.welcomeController=this._register(this.instantiationService.createInstance(P3e,e,this,"panel")),n=this.createChatControl(e);this.registerControlsListeners(t,n,i),this.updateSessionsControlVisibility();try{this._ezilChatHeader(e)}catch(f){this.logService.error("EZiL: chat header layout not applied",f)}}_ezilChatHeader(e){let t=this.titleControl?.titleContainer,i=t?.querySelector(".chat-view-title-inner"),n=this._widget?.inputPart,r=e.ownerDocument,s=e.parentElement,c=n?.secondaryToolbarContainer;if(!t||!i||!s||!c)return;let l=r.createElement("div");l.className="interactive-session ezil-chat-header";for(let f of["click","-monaco-gesturetap"])l.addEventListener(f,g=>g.stopPropagation());let p="AI responses may be inaccurate. Review changes before applying them.",h=r.createElement("button");h.type="button";h.className="ezil-chat-help codicon codicon-info";h.title=p;h.setAttribute("aria-label","EZiL Chat notice: "+p+" Opens EZiL AI status.");let w=()=>{Promise.resolve(this.commandService.executeCommand("ezil-models.showStatus")).catch(()=>this.notificationService.info(p))};h.addEventListener("click",w);h.addEventListener("keydown",g=>{(g.key==="Enter"||g.key===" ")&&(g.preventDefault(),g.stopPropagation(),w())});i.insertBefore(l,i.querySelector(".chat-view-title-actions-toolbar"));l.append(c,h);s.insertBefore(t,e);s.classList.add("ezil-compact-chat")}'
# Names the header method relies on (checked, never patched): each exact definition occurs once.
P_HEADER_TITLE='createChatTitleControl(e){this.titleControl='
P_HEADER_TITLE_ROOT='this.titleContainer=t.root,'
P_HEADER_INPUT_PART='get inputPart(){return this.inputPartDisposable.value}'
P_HEADER_SECONDARY='this.secondaryToolbarContainer=r.secondaryToolbar;'
P_HEADER_COMMANDS='this.chatEntitlementService=M;this.commandService=N;'
P_HEADER_NOTIFY='this.logService=v;this.notificationService=b;'
# workbench.js `chat-enabled`: on a browser profile's first load (`builtinChatExtensionEnablementMigration`
# unset) 1.141 disables the built-in chat extension until chat setup completes. EZiL Chat is anonymous with
# EZiL models (BYOK), so a message sent in the first seconds took the no-setup path (`z3t`: setup not completed
# but BYOK models present), waited for Copilot's agent from a disabled extension and showed "Chat took too long
# to get ready" after 60 s (image e2e, new browser profile, send ~5 s after load; main and staging images alike).
# The extension now stays enabled on that first load and setup is marked completed, as a successful setup run would
# (nothing else marks it: requests now reach Copilot's agent, never the setup agent, and setup-only menu entries
# gated on Setup.completed would stay). The migration flag is still stored, and a completed setup with the
# extension disabled (the user's own choice) still turns AI features off as upstream does.
A_CHAT_ENABLED='else try{this.logService.debug("Disabling builtin chat extension as chat set up is not completed"),this._disableExtension({id:this._chatExtensionId})}catch(n){this.logService.error("Failed to disable builtin chat extension during enablement migration",n)}'
R_CHAT_ENABLED='else try{this.logService.debug("EZiL: builtin chat extension stays enabled; EZiL Chat needs no setup, so setup is marked completed"),i.value.update({completed:!0})}catch(n){this.logService.error("EZiL: chat setup state not updated",n)}'
# workbench.js `attach-execute`: the chat view's Add Context entry (location "panel") moves from the
# ChatInput menu (the composer's mode/model row) to ChatExecute, the toolbar Send lives in, leaving that row
# its room on a narrow chat; that toolbar already renders this action (quick chat registers it there).
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
# workbench.js `picker-order`: when the composer's mode/model pickers do not fit (a phone: Explorer and Chat side by
# side leave Chat about 160 px; measured in the header, where they sat until 2026-11-08), the responsive layout (SEt) compacts them to icons right to left, so the model picker, right of
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
# workbench.js `picker-touch` + `title-tap`: a tap on a phone never changed the model (image e2e, touch taps). On a touch
# device VS Code's Gesture cancels touchstart/touchend once a registered target gets a gesture, so the browser sends no
# mouse events and no click. The model picker's name and settings buttons opened only on mousedown (pointerdown on
# iOS), so on Android a tap did nothing; `picker-touch` is upstream's own fix (microsoft/vscode#339777, after 1.141):
# plain mousedown for the mouse and a Gesture Tap for touch and pen, so a tap opens it once on iOS too (the iOS
# pointerdown listener is gone; _show toggles, so two opens would close it). The chat-header patch puts the Local/permissions pickers
# inside the chat title row, whose Tap/click handler focuses the input: the open list lost focus and closed at once (iOS, and
# Android after picker-touch). The header's stopPropagation cannot help, because Gesture dispatches its non-bubbling
# Tap to each registered target directly; `title-tap` makes the title row ignore Taps and clicks that start inside
# the EZiL header. Taps elsewhere on the title still focus the input.
A_PICKER_TOUCH='_registerButtonAction(e,t){this._register($p(e,i=>{i.button===0&&(bt.stop(i,!0),t(!1))})),'
R_PICKER_TOUCH='_registerButtonAction(e,t){this._register(q(e,oe.MOUSE_DOWN,i=>{i.button===0&&(bt.stop(i,!0),t(!1))})),this._register(hs.addTarget(e)),this._register(q(e,jn.Tap,i=>{bt.stop(i,!0),t(!1)})),'
A_TITLE_TAP='this._register(hs.addTarget(this.titleContainer));for(let i of[jn.Tap,oe.CLICK])this._register(q(this.titleContainer,i,()=>{this.delegate.focusChat()}))'
R_TITLE_TAP='this._register(hs.addTarget(this.titleContainer));for(let i of[jn.Tap,oe.CLICK])this._register(q(this.titleContainer,i,n=>{(n.initialTarget??n.target)?.closest?.(".ezil-chat-header")||this.delegate.focusChat()}))'
# Names both rely on (checked, never patched): Gesture (hs), its Tap event (jn), the listener helper (q), EventHelper
# (bt) and dom.EventType (oe, MOUSE_DOWN), as upstream's phone chip uses them in this bundle.
P_TOUCH_CHIP='this._renderDisposables.add(hs.addTarget(t));for(let i of[oe.CLICK,jn.Tap])this._renderDisposables.add(q(t,i,n=>{bt.stop(n,!0),this._showSheet()}))'
P_TOUCH_GESTURE='var hs=tx;'
P_TOUCH_TAP='var jn;(n=>(n.Tap="-monaco-gesturetap",'
P_TOUCH_DOWN='var oe={CLICK:"click",AUXCLICK:"auxclick",DBLCLICK:"dblclick",MOUSE_UP:"mouseup",MOUSE_DOWN:"mousedown",'
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
# Static asset identity (server-main.js). code-server serves /<quality>-<commit>/static/* with max-age=31536000
# and our patches keep the commit, so a browser that loaded an older image kept its workbench.js/css. The route
# constant IE also builds the page's static base (scripts, CSS, NLS fallback, webview endpoint), so a content id
# in it gives every distinct workbench a new URL. The P_ names must still use IE, or the id moves nothing.
A_STATIC='IE="/static",Vq="/callback"'
P_STATIC_ROUTE='o.startsWith(IE)&&o.charCodeAt(IE.length)===47?this._handleStatic(t,e,o.substring(IE.length))'
P_STATIC_BASE='let I=Be.join(l,this._productPath,IE),'
P_STATIC_PAGE='WORKBENCH_WEB_BASE_URL:I,'
P_STATIC_WEBVIEW='webviewEndpoint:I+"/out/vs/workbench/contrib/webview/browser/pre"'

# Re-running on this patched bundle only verifies it, including the content-derived static id.
# A partial or altered patch still fails the gates; it is never silently repaired.
if [ "$VERIFY_ONLY" = 0 ] && [ "$(count "$WB" "$R_APP_FAILURE")" = 1 ]; then VERIFY_ONLY=1; fi
if [ "$VERIFY_ONLY" = 0 ]; then
  patch ai-dashboard "$WB" 1 "$A_AI_DASHBOARD" "$R_AI_DASHBOARD"
  patch app-failure "$WB" 1 "$A_APP_FAILURE" "$R_APP_FAILURE"
  patch app-start-timeout "$WB" 1 "$A_APP_START_TIMEOUT" "$R_APP_START_TIMEOUT"
  patch billing-intent "$WB" 1 "$A_BILLING_INTENT" "$R_BILLING_INTENT"
  patch picker-locked-list "$WB" 1 "$A_PICKER_LOCKED_LIST" "$R_PICKER_LOCKED_LIST"
  patch picker-locked-pin "$WB" 1 "$A_PICKER_LOCKED_PIN" "$R_PICKER_LOCKED_PIN"
  patch picker-locked-select "$WB" 1 "$A_PICKER_LOCKED_SELECT" "$R_PICKER_LOCKED_SELECT"
  patch picker-locked-configure "$WB" 1 "$A_PICKER_LOCKED_CONFIGURE" "$R_PICKER_LOCKED_CONFIGURE"
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
  for p in "$P_HEADER_TITLE" "$P_HEADER_TITLE_ROOT" "$P_HEADER_INPUT_PART" "$P_HEADER_SECONDARY" "$P_HEADER_COMMANDS" "$P_HEADER_NOTIFY"; do
    gate header-names "$WB" 1 "$p"
  done
  patch chat-header    "$WB"  1  "$A_CHAT_HEADER" "$R_CHAT_HEADER"
  patch attach-execute "$WB"  1  "$A_ATTACH" "$R_ATTACH"
  patch chat-enabled   "$WB"  1  "$A_CHAT_ENABLED" "$R_CHAT_ENABLED"
  for p in "$P_PICKER_OPTIONS" "$P_PICKER_DIALOG"; do gate picker-names "$WB" 1 "$p"; done
  patch picker-flip    "$WB"  1  "$A_PICKER_FLIP" "$R_PICKER_FLIP"
  for p in "$P_PICKER_SHRINK" "$P_PICKER_MODEL_ID" "$P_PICKER_FIT"; do gate picker-order-names "$WB" 1 "$p"; done
  patch picker-order   "$WB"  1  "$A_PICKER_ORDER" "$R_PICKER_ORDER"
  for p in "$P_TOUCH_CHIP" "$P_TOUCH_GESTURE" "$P_TOUCH_TAP" "$P_TOUCH_DOWN"; do gate touch-names "$WB" 1 "$p"; done
  patch picker-touch   "$WB"  1  "$A_PICKER_TOUCH" "$R_PICKER_TOUCH"
  patch title-tap      "$WB"  1  "$A_TITLE_TAP" "$R_TITLE_TAP"
  patch status-signin  "$WB"  1  "$A_STATUS_SIGNIN" "$R_STATUS_SIGNIN"
  patch status-setup-text "$WB" 1 "$A_STATUS_SETUP_TEXT" "$R_STATUS_SETUP_TEXT"
  patch participant-fullname "$PKG" 6 "$A_FULLNAME" "$R_FULLNAME"
  patch submenu-label  "$PKG_NLS" 1 "$A_SUBMENU"     "$R_SUBMENU"
  patch walkthrough    "$PKG_NLS" 1 "$A_WALKTHROUGH" "$R_WALKTHROUGH"
  # modification notices (comments; the .json cannot carry one)
  for f in "$EXT" "$NLS_JS" "$WB" "$SERVER"; do
    if ! head -c 400 "$f" | grep -qF 'Modified at build time by EZiL'; then
      node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,process.argv[2]+"\n"+fs.readFileSync(f,"utf8"))' "$f" "$NOTICE"
    fi
  done
  # Last: the id hashes the files patched above.
  for p in "$P_STATIC_ROUTE" "$P_STATIC_BASE" "$P_STATIC_PAGE" "$P_STATIC_WEBVIEW"; do gate static-names "$SERVER" 1 "$p"; done
  STATIC_ID="$(static_id "$ROOT")"
  patch static-id "$SERVER" 1 "$A_STATIC" "IE=\"/static/$STATIC_ID\",Vq=\"/callback\""
fi

# ── gates: anchors gone, replacements present, files still parse ────────────
gate app-failure "$WB" 0 "$A_APP_FAILURE"; gate app-failure "$WB" 1 "$R_APP_FAILURE"
gate app-start-timeout "$WB" 0 "$A_APP_START_TIMEOUT"; gate app-start-timeout "$WB" 1 "$R_APP_START_TIMEOUT"
gate app-failure-command "$WB" 1 'qe.registerCommand("_ezil.appFailure",'
gate billing-intent "$WB" 1 "$R_BILLING_INTENT"; gate billing-intent-command "$WB" 1 'qe.registerCommand("_ezil.billingIntent",'
gate picker-locked-list "$WB" 0 "$A_PICKER_LOCKED_LIST"; gate picker-locked-list "$WB" 1 "$R_PICKER_LOCKED_LIST"
gate picker-locked-pin "$WB" 0 "$A_PICKER_LOCKED_PIN"; gate picker-locked-pin "$WB" 1 "$R_PICKER_LOCKED_PIN"
gate picker-locked-select "$WB" 0 "$A_PICKER_LOCKED_SELECT"; gate picker-locked-select "$WB" 1 "$R_PICKER_LOCKED_SELECT"
gate picker-locked-configure "$WB" 0 "$A_PICKER_LOCKED_CONFIGURE"; gate picker-locked-configure "$WB" 1 "$R_PICKER_LOCKED_CONFIGURE"
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
gate session-filter   "$WB"  0  "$A_SESSION_FILTER"; gate session-filter   "$WB"  1  "$R_SESSION_FILTER"
for p in "$P_HEADER_TITLE" "$P_HEADER_TITLE_ROOT" "$P_HEADER_INPUT_PART" "$P_HEADER_SECONDARY" "$P_HEADER_COMMANDS" "$P_HEADER_NOTIFY"; do
  gate header-names "$WB" 1 "$p"
done
gate chat-header      "$WB"  0  "$A_CHAT_HEADER";   gate chat-header      "$WB"  1  "$R_CHAT_HEADER"
gate attach-execute   "$WB"  0  "$A_ATTACH";        gate attach-execute   "$WB"  1  "$R_ATTACH"
gate chat-enabled     "$WB"  0  "$A_CHAT_ENABLED";  gate chat-enabled     "$WB"  1  "$R_CHAT_ENABLED"
for p in "$P_PICKER_OPTIONS" "$P_PICKER_DIALOG"; do gate picker-names "$WB" 1 "$p"; done
gate picker-flip      "$WB"  0  "$A_PICKER_FLIP";   gate picker-flip      "$WB"  1  "$R_PICKER_FLIP"
for p in "$P_PICKER_SHRINK" "$P_PICKER_MODEL_ID" "$P_PICKER_FIT"; do gate picker-order-names "$WB" 1 "$p"; done
gate picker-order     "$WB"  0  "$A_PICKER_ORDER";  gate picker-order     "$WB"  1  "$R_PICKER_ORDER"
for p in "$P_TOUCH_CHIP" "$P_TOUCH_GESTURE" "$P_TOUCH_TAP" "$P_TOUCH_DOWN"; do gate touch-names "$WB" 1 "$p"; done
gate picker-touch     "$WB"  0  "$A_PICKER_TOUCH";  gate picker-touch     "$WB"  1  "$R_PICKER_TOUCH"
gate title-tap        "$WB"  0  "$A_TITLE_TAP";     gate title-tap        "$WB"  1  "$R_TITLE_TAP"
gate status-signin    "$WB"  0  "$A_STATUS_SIGNIN"; gate status-signin    "$WB"  1  "$R_STATUS_SIGNIN"
gate status-setup-text "$WB" 0 "$A_STATUS_SETUP_TEXT"; gate status-setup-text "$WB" 1 "$R_STATUS_SETUP_TEXT"
gate participant-fullname "$PKG" 0 "$A_FULLNAME";  gate participant-fullname "$PKG" 6 "$R_FULLNAME"
gate submenu-label    "$PKG_NLS" 0 "$A_SUBMENU";   gate submenu-label    "$PKG_NLS" 1 "$R_SUBMENU"
gate walkthrough      "$PKG_NLS" 0 "$A_WALKTHROUGH"; gate walkthrough    "$PKG_NLS" 1 "$R_WALKTHROUGH"
node -e 'for(const f of process.argv.slice(1)){const j=JSON.parse(require("fs").readFileSync(f,"utf8"));if(f.endsWith("package.json")&&(j.publisher!=="GitHub"||j.name!=="copilot-chat"))throw new Error("package.json identity changed");}console.log("patch-copilot-chat: gate ok [manifest JSON parses, publisher/name untouched]")' "$PKG" "$PKG_NLS"
for f in "$EXT" "$NLS_JS" "$WB" "$SERVER"; do gate notice "$f" 1 'Modified at build time by EZiL'; done
for p in "$P_STATIC_ROUTE" "$P_STATIC_BASE" "$P_STATIC_PAGE" "$P_STATIC_WEBVIEW"; do gate static-names "$SERVER" 1 "$p"; done
# Recomputed: a later edit to any hashed file (here or in a later Dockerfile step) leaves a stale id and fails.
STATIC_ID="$(static_id "$ROOT")"
gate static-id "$SERVER" 0 "$A_STATIC"; gate static-id "$SERVER" 1 'IE="/static/ezil-'
gate static-id "$SERVER" 1 "IE=\"/static/$STATIC_ID\",Vq=\"/callback\""
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
# server-main.js is checked in place: lib/vscode/package.json makes it a module there, as when code-server loads it
for f in "$EXT" "$WB" "$NLS_JS" "$SERVER"; do node --check "$f"; done
echo "patch-copilot-chat: gate ok [patched JavaScript parses]"
# license/copyright notices must be intact
test -s "$ROOT/extensions/copilot/LICENSE.txt"
grep -q "MIT License" "$ROOT/extensions/copilot/LICENSE.txt"
grep -qi "Copyright (c) Microsoft Corporation" "$ROOT/extensions/copilot/LICENSE.txt"
echo "patch-copilot-chat: gate ok [copilot LICENSE.txt intact]"
grep -q "Copyright (C) Microsoft Corporation" "$NLS_JS"
grep -q "Copyright (C) Microsoft Corporation" "$WB"
grep -q "Copyright (C) Microsoft Corporation" "$SERVER"
echo "patch-copilot-chat: gate ok [Microsoft copyright headers intact]"
echo "patch-copilot-chat: all gates passed"
