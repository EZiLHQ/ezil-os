#!/usr/bin/env bash
# patch-folder-bridge.sh — build-time patch that lets the EZiL shell's Code
# window learn which folder THIS editor document opened (per-tab folder
# continuity, shell/ezil/apps/code-folder.js), and makes an in-editor Open
# Folder REPLACE the iframe's history entry instead of pushing one.
#
#   patch-folder-bridge.sh [<vscode-root>]            default /usr/lib/code-server/lib/vscode
#   patch-folder-bridge.sh --verify [<vscode-root>]   only run the post-patch gates
#
# Same discipline as ../copilot-chat/patch-copilot-chat.sh, and deliberately a
# separate script (and Dockerfile step) so neither edits the other's anchors:
# every anchor is an EXACT match whose occurrence count must hold BEFORE the
# patch and a gate must hold AFTER it, so a code-server bump that moves one
# fails the Docker build visibly. Counts were measured on the pinned 4.141.0
# deb (sha256 f384beb4…77ba, pristine) AND on the shipped
# ezil-os-worker-staging-sandbox:ad001d55 (copilot patch applied): each anchor
# occurs exactly once in both, so the two scripts may run in either order.
#
# What the editor tells the shell, and to whom:
#   - only when framed (window.parent !== window), only to an origin in the
#     build-time allowlist EZIL_SHELL_ORIGINS_JSON (default: the EZiL OS shell
#     origins), never with a '*' target;
#   - `ezil.code.ready` (no data) once at load, so the shell can say hello;
#   - `ezil.code.folder` {v:1, nonce, mint, kind, path?} only in answer to a
#     shell hello whose source is window.parent, whose origin is allowed and
#     whose nonce is 22 base64url characters. `mint` is this document's own
#     `ezil_mint` URL parameter (the shell's per-mint id; null when absent,
#     e.g. after an in-editor Open Folder, which drops every other parameter).
#     `kind` is folder (vscode-remote on this host), foreign, workspace or empty.
# It is a HINT: the shell only uses it to ask the next mint, and the server
# walks it on the computer before anything opens. No new inline script, so the
# workbench CSP is unchanged; every error is swallowed and the provider is
# returned unchanged.
#
# Pinned input: code-server 4.141.0. File patched (inside <root>):
#   out/vs/code/browser/workbench/workbench.js   (MIT, Copyright (c) Microsoft
#   Corporation; LICENSE untouched; a one-line modification notice appended)
set -euo pipefail

VERIFY_ONLY=0
if [ "${1:-}" = "--verify" ]; then VERIFY_ONLY=1; shift; fi
ROOT="${1:-/usr/lib/code-server/lib/vscode}"
WB="$ROOT/out/vs/code/browser/workbench/workbench.js"
# The EZiL OS shell origins allowed to receive a report. Defense in depth: the
# shell also checks origin + source + nonce + its own per-mint id.
SHELL_ORIGINS_JSON="${EZIL_SHELL_ORIGINS_JSON:-[\"https://os.ezil.work\",\"https://os-staging.ezil.work\"]}"
NOTICE='/* Modified at build time by EZiL (worker/code-folder-bridge/patch-folder-bridge.sh): the folder this document opened is reported to the EZiL shell; same-frame opens replace history. Original work: Copyright (c) Microsoft Corporation, MIT License. */'

[ -s "$WB" ] || { echo "patch-folder-bridge: missing $WB" >&2; exit 1; }
command -v node >/dev/null || { echo "patch-folder-bridge: node is required" >&2; exit 1; }
# Only https origins of plain host names: the value is embedded in the workbench as a JSON literal.
node -e 'const a=JSON.parse(process.argv[1]);if(!Array.isArray(a)||!a.length||!a.every(o=>typeof o==="string"&&/^https:\/\/[a-z0-9.-]+$/.test(o)))throw new Error("bad EZIL_SHELL_ORIGINS_JSON")' "$SHELL_ORIGINS_JSON" \
  || { echo "patch-folder-bridge: EZIL_SHELL_ORIGINS_JSON must be a non-empty JSON array of https origins" >&2; exit 1; }
SHELL_ORIGINS_JS="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])))' "$SHELL_ORIGINS_JSON")"

# count <file> <literal>  → number of exact (non-overlapping) occurrences
count() { node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");const n=process.argv[2];let c=0,i=0;for(;;){i=s.indexOf(n,i);if(i<0)break;c++;i+=n.length;}console.log(c)' "$1" "$2"; }
# patch <id> <expected count> <anchor> <replacement>
patch() {
  local id="$1" want="$2" anchor="$3" repl="$4" have
  have="$(count "$WB" "$anchor")"
  [ "$have" = "$want" ] || { echo "patch-folder-bridge: [$id] anchor occurs $have times, expected $want" >&2; exit 1; }
  node -e 'const fs=require("fs");const [f,a,r]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").split(a).join(r))' "$WB" "$anchor" "$repl"
}
# gate <id> <literal> <expected count>
gate() {
  local have; have="$(count "$WB" "$2")"
  [ "$have" = "$3" ] || { echo "patch-folder-bridge: GATE FAILED [$1] x$have, expected $3" >&2; exit 1; }
}

# B1 — hand the workspace THIS document opens to the bridge. Every remote folder or workspace change in the web
# workbench is a full document load (BrowserHostService.doOpen -> workspaceProvider.open -> location), so the
# provider's `workspace` at startup is the whole truth for this document; no workbench service is needed.
A_B1='workspaceProvider:KDo.create(e),'
R_B1='workspaceProvider:globalThis.__ezilFolderBridge(KDo.create(e)),'
# B2 — define the bridge before the bootstrap IIFE runs (the IIFE builds the provider through B1).
A_B2='(function(){dt.document.getElementById("vscode-startup-fallback")?.remove();'
R_B2="globalThis.__ezilFolderBridge=(p=>{try{const O=${SHELL_ORIGINS_JS};if(window.parent===window)return p;let M=null;try{const m=new URLSearchParams(location.search).get(\"ezil_mint\");M=m&&/^[A-Za-z0-9_-]{22}\$/.test(m)?m:null}catch{}const w=p&&p.workspace;let r={kind:\"empty\"};if(w&&w.folderUri){const u=w.folderUri;r=u.scheme===\"vscode-remote\"&&u.authority===location.host?{kind:\"folder\",path:String(u.path)}:{kind:\"foreign\"}}else if(w&&w.workspaceUri)r={kind:\"workspace\"};if(r.path&&r.path.length>4096)r={kind:\"foreign\"};window.addEventListener(\"message\",ev=>{try{const d=ev.data;if(ev.source!==window.parent||!O.includes(ev.origin)||!d||typeof d!==\"object\"||d.type!==\"ezil.code.hello\"||d.v!==1||typeof d.nonce!==\"string\"||!/^[A-Za-z0-9_-]{22}\$/.test(d.nonce))return;ev.source.postMessage({type:\"ezil.code.folder\",v:1,nonce:d.nonce,mint:M,...r},ev.origin)}catch{}});for(const o of O){try{window.parent.postMessage({type:\"ezil.code.ready\",v:1},o)}catch{}}}catch{}return p});${A_B2}"
# B3 — Open Folder / Close Folder / Open Workspace in the SAME frame replace the iframe's session-history entry
# instead of pushing one, so a shell Back leaves /app/code (app-history.js: Back/Forward moves between shell
# entries and never re-mints) instead of silently reloading the previous folder inside the frame.
A_B3='if(e?.reuse)return dt.location.href=t,!0;'
R_B3='if(e?.reuse)return dt.location.replace(t),!0;'

if [ "$VERIFY_ONLY" = 0 ]; then
  # Every precondition BEFORE the first write, so a refused run (an already patched file, a moved anchor) leaves
  # the file exactly as it was.
  gate B2-unpatched 'globalThis.__ezilFolderBridge=' 0
  for pair in "B1|$A_B1" "B2|$A_B2" "B3|$A_B3"; do
    have="$(count "$WB" "${pair#*|}")"
    [ "$have" = 1 ] || { echo "patch-folder-bridge: [${pair%%|*}] anchor occurs $have times, expected 1" >&2; exit 1; }
  done
  patch B2 1 "$A_B2" "$R_B2"
  patch B1 1 "$A_B1" "$R_B1"
  patch B3 1 "$A_B3" "$R_B3"
  printf '\n%s\n' "$NOTICE" >> "$WB"
fi

# ── gates: anchors gone, replacements present exactly once, the file still parses ─────────────
gate B1 "$R_B1" 1
gate B1-old "$A_B1" 0
gate B2 'globalThis.__ezilFolderBridge=(p=>' 1
gate B2-iife "$A_B2" 1
gate B2-origins "const O=${SHELL_ORIGINS_JS};" 1
gate B3 "$R_B3" 1
gate B3-old "$A_B3" 0
gate notice 'worker/code-folder-bridge/patch-folder-bridge.sh' 1
gate no-wildcard-target 'postMessage({type:"ezil.code.ready",v:1},"*")' 0
node --check "$WB" || { echo "patch-folder-bridge: GATE FAILED [parse] workbench.js no longer parses" >&2; exit 1; }
echo "patch-folder-bridge: ok (B1 provider, B2 bridge, B3 replace; origins ${SHELL_ORIGINS_JS})"
