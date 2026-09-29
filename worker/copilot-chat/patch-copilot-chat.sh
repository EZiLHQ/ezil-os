#!/usr/bin/env bash
# patch-copilot-chat.sh — build-time patches that turn the open-source Copilot
# Chat bundled with code-server into "EZiL Chat": NO GitHub service is called
# from the chat stack in anonymous mode, and the user-visible GitHub/Copilot
# branding on the EZiL boot + Agent-prompt path is replaced. Strings only; no
# command id, setting key, contribution point or license file is touched.
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
# Files patched (all inside <root>):
#   extensions/copilot/dist/extension.js               copilot-chat extension host bundle
#   out/nls.messages.js, out/nls.messages.json         workbench English strings (index-addressed array)
#   out/vs/code/browser/workbench/workbench.js         workbench bundle (one menu `when` clause)
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

# ── anchors / replacements (single source of truth for patch + gate) ────────
# Part 1 — no GitHub calls (extension.js)
A_TOKEN='this._logService.info("Allowing anonymous access with devDeviceId");let a=await this.authFromDevDeviceId(H6e.env.devDeviceId);'
R_TOKEN='this._logService.info("EZiL Chat: anonymous mode, GitHub token minting (copilot_internal/v2/nltoken) disabled at build time");let a={kind:"failure",reason:"GitHubLoginFailed"};'
A_KNOWN='this._logService.info("BYOK: fetching known models list");let r=await(await n.fetch("https://main.vscode-cdn.net/extensions/copilotChat.json",{method:"GET",callSite:"byok-known-models"})).json();'
R_KNOWN='this._logService.info("EZiL Chat: BYOK known-models CDN fetch disabled at build time, using an empty list");let r={version:1,modelInfo:{}};'
A_EMB_CACHE='async fetchRemoteCache(){if(this._remoteCacheEntries)return this._remoteCacheEntries;let e=await this.getRemoteCacheURL();try{'
R_EMB_CACHE='async fetchRemoteCache(){if(this._remoteCacheEntries)return this._remoteCacheEntries;return;let e=await this.getRemoteCacheURL();try{'
A_EMB_LATEST='async fetchRemoteCacheLatest(){let e=await this.getRemoteCacheLatestUpdateURL();try{'
R_EMB_LATEST='async fetchRemoteCacheLatest(){return;let e=await this.getRemoteCacheLatestUpdateURL();try{'
A_EMB_EXT='async fetchRemoteExtensionCache(n){let o=`${await this.getBaseExtensionCDNURL()}/${n}.json`;try{'
R_EMB_EXT='async fetchRemoteExtensionCache(n){return{};let o=`${await this.getBaseExtensionCDNURL()}/${n}.json`;try{'
# Part 2 — the chat welcome hides its disclaimer (our notice) whenever BYOK models exist (workbench.css)
CSS="$ROOT/out/vs/code/browser/workbench/workbench.css"
[ -s "$CSS" ] || { echo "patch-copilot-chat: missing $CSS" >&2; exit 1; }
A_CSS='.chat-welcome-view .chat-welcome-view-message,.chat-welcome-view .chat-welcome-view-disclaimer,.chat-welcome-view .chat-welcome-view-tips{display:none}'
R_CSS='.chat-welcome-view .chat-welcome-view-message,.chat-welcome-view .chat-welcome-view-tips{display:none}'
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
A_PICKER='_isVisible(e){return lqt(e,this.configurationService,this.chatSessionsService,this.workspaceContextService.getWorkspace(),this.agentHostEnablementService.managedSandboxEnforced.get(),this.agentHostEnablementService.enabled.get())}'
R_PICKER='_isVisible(e){return e!==nn.AgentHostCopilot&&lqt(e,this.configurationService,this.chatSessionsService,this.workspaceContextService.getWorkspace(),this.agentHostEnablementService.managedSandboxEnforced.get(),this.agentHostEnablementService.enabled.get())}'
# Part 2 — extension manifest display names (package.json / package.nls.json, compact JSON)
PKG="$ROOT/extensions/copilot/package.json"
PKG_NLS="$ROOT/extensions/copilot/package.nls.json"
for f in "$PKG" "$PKG_NLS"; do [ -s "$f" ] || { echo "patch-copilot-chat: missing $f" >&2; exit 1; }; done
A_FULLNAME='"fullName":"GitHub Copilot"';                          R_FULLNAME='"fullName":"EZiL Chat"'
A_SUBMENU='"github.copilot.submenu.copilot.label":"Copilot"';       R_SUBMENU='"github.copilot.submenu.copilot.label":"EZiL Chat"'
A_WALKTHROUGH='"github.copilot.walkthrough.title":"GitHub Copilot"'; R_WALKTHROUGH='"github.copilot.walkthrough.title":"EZiL Chat"'
# Part 2 — Accounts menu "Sign in to use GitHub Copilot..." (workbench.js): no setting hides
# it, so its `when` clause becomes the always-false constant.
A_ACCOUNTS='id:"workbench.action.chat.triggerSetupFromAccounts",title:O(9501,"Sign in to use GitHub Copilot..."),menu:{id:N.AccountsContext,group:"2_copilot",when:_.and(Z.Setup.hidden.negate(),Z.Setup.disabledInWorkspace.negate(),vJt.notEqualsTo("available"),Z.Setup.completed.negate(),Z.Entitlement.signedOut)}'
R_ACCOUNTS='id:"workbench.action.chat.triggerSetupFromAccounts",title:O(9501,"Sign in to use GitHub Copilot..."),menu:{id:N.AccountsContext,group:"2_copilot",when:_.false()}'

if [ "$VERIFY_ONLY" = 0 ]; then
  patch token          "$EXT" 1  "$A_TOKEN"  "$R_TOKEN"
  patch known-models   "$EXT" 1  "$A_KNOWN"  "$R_KNOWN"
  patch embeddings-cache  "$EXT" 1 "$A_EMB_CACHE"  "$R_EMB_CACHE"
  patch embeddings-latest "$EXT" 1 "$A_EMB_LATEST" "$R_EMB_LATEST"
  patch embeddings-ext    "$EXT" 1 "$A_EMB_EXT"    "$R_EMB_EXT"
  patch welcome-disclaimer "$CSS" 1 "$A_CSS" "$R_CSS"
  patch identity       "$EXT" 13 "$A_IDENT"  "$R_IDENT"
  patch identity-model "$EXT" 2  "$A_IDENT2" "$R_IDENT2"
  for nls in "$NLS_JS" "$NLS_JSON"; do
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
gate token            "$EXT" 0  "$A_TOKEN";        gate token            "$EXT" 1  "$R_TOKEN"
gate known-models     "$EXT" 0  "$A_KNOWN";        gate known-models     "$EXT" 1  "$R_KNOWN"
gate identity         "$EXT" 0  "$A_IDENT";        gate identity         "$EXT" 13 "$R_IDENT"
gate identity-model   "$EXT" 0  "$A_IDENT2";       gate identity-model   "$EXT" 2  "$R_IDENT2"
gate embeddings-cache  "$EXT" 0 "$A_EMB_CACHE";  gate embeddings-cache  "$EXT" 1 "$R_EMB_CACHE"
gate embeddings-latest "$EXT" 0 "$A_EMB_LATEST"; gate embeddings-latest "$EXT" 1 "$R_EMB_LATEST"
gate embeddings-ext    "$EXT" 0 "$A_EMB_EXT";    gate embeddings-ext    "$EXT" 1 "$R_EMB_EXT"
gate welcome-disclaimer "$CSS" 0 "$A_CSS";       gate welcome-disclaimer "$CSS" 1 "$R_CSS"
gate no-devdeviceid-token "$EXT" 0 'await this.authFromDevDeviceId('
gate no-known-models-url  "$EXT" 0 'https://main.vscode-cdn.net/extensions/copilotChat.json'
for nls in "$NLS_JS" "$NLS_JSON"; do
  gate terms          "$nls" 0 "$A_TERMS";         gate terms           "$nls" 5 "$R_TERMS"
  gate status-aria    "$nls" 0 "$A_STATUS_ARIA";   gate status-aria     "$nls" 1 "$R_STATUS_ARIA"
  gate status-name    "$nls" 0 "$A_STATUS_NAME";   gate status-name     "$nls" 1 "$R_STATUS_NAME"
  gate status-resumed "$nls" 0 "$A_STATUS_RESUMED"; gate status-disabled "$nls" 0 "$A_STATUS_DISABLED"
  gate enable-more    "$nls" 0 "$A_ENABLE_MORE";   gate enable-more     "$nls" 1 "$R_ENABLE_MORE"
  gate no-terms-text  "$nls" 0 'By continuing with {0} Copilot'
done
gate accounts-menu    "$WB"  0  "$A_ACCOUNTS";     gate accounts-menu    "$WB"  1  "$R_ACCOUNTS"
gate target-picker    "$WB"  0  "$A_PICKER";       gate target-picker    "$WB"  1  "$R_PICKER"
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
node --check "$EXT" && echo "patch-copilot-chat: gate ok [extension.js parses]"
# license/copyright notices must be intact
test -s "$ROOT/extensions/copilot/LICENSE.txt" && grep -q "MIT License" "$ROOT/extensions/copilot/LICENSE.txt" && echo "patch-copilot-chat: gate ok [copilot LICENSE.txt intact]"
grep -q "Copyright (C) Microsoft Corporation" "$NLS_JS" && grep -q "Copyright (C) Microsoft Corporation" "$WB" && echo "patch-copilot-chat: gate ok [Microsoft copyright headers intact]"
echo "patch-copilot-chat: all gates passed"
