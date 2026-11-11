/**
 * code-folder-bridge.ts — the Code folder bridge, injected by this Worker into code-server's WORKBENCH document
 * (both computers: the Cloudflare code host, `preview-bridge.ts` `handlePreviewProxy`, and an AWS computer's code
 * port, `aws-origin.ts` `handleAwsBrowserHost`). Pure: no I/O, so it runs under plain `bun test`.
 *
 * Why here and not in the image: both providers' editor documents pass through this Worker, so one Worker release
 * reaches every computer, with no container image or AMI change (the reviewed image patch, code-folder-bridge/
 * patch-folder-bridge.sh on the folder lane, was never merged, so nothing reported a folder until now).
 *
 * What the editor tells the shell (shell/ezil/apps/code-folder.js), and to whom:
 *   - only when framed, only to the OS shell that frames this realm's editors (`codeShellOriginsFor`: staging's
 *     preview zone has the staging shell; production's has none, so no bridge at all), never with a `*` target;
 *   - `ezil.code.ready` {v:1} once at load, so the shell says hello;
 *   - `ezil.code.folder` {v:1, nonce, mint, kind, path?, base?} only in answer to a hello whose source is
 *     window.parent, whose origin is allowed and whose nonce is 22 base64url characters. `kind` is `folder` (a path
 *     on this computer: code-server's `folder=` that starts with `/`), `workspace`, `foreign` (another scheme) or
 *     `empty`; `mint` is this document's own `ezil_mint`, else null; `base` is its `location.pathname`. Read from
 *     the document's OWN address: every remote folder or workspace change in the web workbench is a new document
 *     load (`workspaceProvider.open`), so the address is the whole truth for this document;
 *   - `ezil.code.open` {v:1, id, kind, path?} when the editor is about to switch folder IN THIS FRAME (Open Folder,
 *     Open Recent, Close Folder, a workspace). The editor's own switch would PUSH a frame entry; a frame entry's
 *     top-level part is shared with the entry before it, so the shell could not give it its own address (measured,
 *     Chromium: Back then shows the new address over the old folder). So the bridge cancels that push (Navigation
 *     API) and asks the shell; the shell adds its OWN entry for the new folder and answers `ezil.code.go` {v:1, id};
 *     only then does the editor replace its document, inside that new entry. Back/Forward then restore the address
 *     and the editor's folder together, natively, and every switch is a navigation of the live document, so
 *     code-server's own beforeunload (its unsaved-work veto) still runs. No answer in GO_FALLBACK_MS (an older
 *     shell, a closed binding): the editor replaces anyway, as before, minus the push;
 *   - `ezil.code.leaving` {v:1} at the document's beforeunload: a navigation of the editor is under way (the
 *     browser restoring it for a Back/Forward, or anything else), so the shell starts none of its own.
 * A report is a HINT. The shell writes it into its address bar and its tab record, and the next mint's server walk
 * decides what opens (`./code-folder.ts`, `./code-folder-resolve.ts`): a link can never make Code open a folder that
 * walk refused.
 *
 * The script is a constant except for the origins (validated https origins, JSON-encoded) and it carries the page's
 * own CSP nonce, so code-server's Content-Security-Policy is unchanged. Every error inside it is swallowed: a broken
 * bridge leaves the editor exactly as code-server built it.
 *
 * The same insertion carries one constant style rule, `LEGACY_NOTICE_HIDE_CSS`: an older editor image draws the AI
 * notice as a permanent line under the chat input, and the rule hides that generated line only. A plain `<style>`, as
 * the workbench's own startup-fallback style is: code-server's CSP allows inline styles (`style-src 'self'
 * 'unsafe-inline'`, the served header of both editor images, measured 2026-11-05), so the CSP stays as it is.
 */

/**
 * The EZiL OS shell that frames each realm's editors, keyed by the realm's preview zone: the Worker's existing
 * `SANDBOX_PREVIEW_ZONE_ROOT`, which only ever names production's `ezil.org` (unset) or staging's own `ezil.work`
 * (`resolvePreviewZoneRoot` in `./index.ts`). Compiled in, not configured: the bridge adds no setting of its own.
 * Production has no entry, so its editors get no bridge at all.
 */
const SHELL_ORIGINS_BY_PREVIEW_ZONE: Readonly<Record<string, string>> = { 'ezil.work': 'https://os-staging.ezil.work' };
/**
 * A navigation destination, not permission to message a parent. Reuse the staging
 * parent mapping and the existing production realm default without enabling a
 * production embedded bridge. Unknown realms clear the boot value.
 */
export function osBillingOriginFor(previewZoneRoot: string | undefined): string {
  if (previewZoneRoot === undefined) return 'https://os.ezil.work';
  const zone = previewZoneRoot.trim().toLowerCase();
  if (zone === 'ezil.org') return 'https://os.ezil.work';
  return zone === 'ezil.work' ? SHELL_ORIGINS_BY_PREVIEW_ZONE[zone]! : '';
}

/** At most this many origins (staging has one). */
export const CODE_SHELL_ORIGINS_MAX = 4;
/** How long the editor waits for the shell's `ezil.code.go` before it switches folder by itself. */
export const GO_FALLBACK_MS = 1500;
/** Marks an injected document, so a document is never given two bridges. */
export const BRIDGE_MARKER = 'data-ezil-folder-bridge';
/** Marks the injected legacy-notice style. */
export const LEGACY_NOTICE_MARKER = 'data-ezil-legacy-notice';
/**
 * Hides the notice line an older editor image (AWS AMI 1.0.30's, desktop 67c939f0) appends under the chat input. That
 * image's workbench.css draws it with exactly this selector:
 * `.chat-viewpane .interactive-session>.interactive-input-part::after{content:"AI responses may be inaccurate. Review
 * changes before applying them.";display:block;…}`. The current image (2031b2c1) has no such rule: its chat header's
 * info button carries the notice, so there the rule matches nothing that is drawn. Only that generated box: the input,
 * its toolbars, the welcome message and every other notice are untouched.
 */
export const LEGACY_NOTICE_HIDE_CSS = '.chat-viewpane .interactive-session>.interactive-input-part::after{content:none!important;display:none!important}';

const ORIGIN_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** A CSP nonce as code-server writes it (a UUID today); anything else is not copied into an attribute. */
const NONCE_RE = /^[A-Za-z0-9+/=_-]{8,128}$/;

/**
 * A comma-separated origin list → the allowed shell origins. Plain `https://<host>` only (no port, path, userinfo or
 * wildcard), lowercase, at most CODE_SHELL_ORIGINS_MAX. Any malformed entry voids the whole list (no bridge), so a
 * typo never silently narrows or widens who hears the editor.
 */
export function parseShellOrigins(value: string | undefined | null): string[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const list = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (list.length === 0 || list.length > CODE_SHELL_ORIGINS_MAX) return [];
  if (!list.every((o) => ORIGIN_RE.test(o))) return [];
  return [...new Set(list)];
}

/**
 * The shell origins for this Worker's realm, from its `SANDBOX_PREVIEW_ZONE_ROOT` (read the way
 * `resolvePreviewZoneRoot` reads it). Unset (production) or any zone without a shell: none, so no bridge.
 */
export function codeShellOriginsFor(previewZoneRoot: string | undefined): string[] {
  if (typeof previewZoneRoot !== 'string') return [];
  const zone = previewZoneRoot.trim().toLowerCase();
  return Object.hasOwn(SHELL_ORIGINS_BY_PREVIEW_ZONE, zone) ? parseShellOrigins(SHELL_ORIGINS_BY_PREVIEW_ZONE[zone]) : [];
}

/** The bridge, as one script body. `origins` must come from `codeShellOriginsFor`. */
export function codeFolderBridgeScript(origins: readonly string[]): string {
  const O = JSON.stringify(origins);
  // Kept to plain ES2020 and one closure; no global names are added.
  return `(()=>{try{const O=${O};if(window.parent===window||!O.length)return;`
    + `const T=/^[A-Za-z0-9_-]{22}$/;`
    + `const tok=()=>{const b=new Uint8Array(16);crypto.getRandomValues(b);return btoa(String.fromCharCode(...b)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")};`
    + `const what=s=>{const q=new URLSearchParams(s);const f=q.get("folder");if(f!==null)return f.startsWith("/")&&f.length<=4096?{kind:"folder",path:f}:{kind:"foreign"};if(q.has("workspace"))return{kind:"workspace"};return{kind:"empty"}};`
    + `const here=what(location.search);const base=String(location.pathname||"");if((here.kind==="folder"||here.kind==="empty")&&base.length<=256)here.base=base;`
    + `let mint=null;try{const m=new URLSearchParams(location.search).get("ezil_mint");mint=m&&T.test(m)?m:null}catch{}`
    + `const tell=(m)=>{for(const o of O){try{window.parent.postMessage(m,o)}catch{}}};`
    + `const pending=new Map();`
    + `addEventListener("message",ev=>{try{const d=ev.data;if(ev.source!==window.parent||!O.includes(ev.origin)||!d||typeof d!=="object"||d.v!==1)return;`
    + `if(d.type==="ezil.code.hello"&&typeof d.nonce==="string"&&T.test(d.nonce)){ev.source.postMessage({type:"ezil.code.folder",v:1,nonce:d.nonce,mint,...here},ev.origin);return}`
    + `if(d.type==="ezil.code.go"&&typeof d.id==="string"&&pending.has(d.id)){const p=pending.get(d.id);pending.delete(d.id);clearTimeout(p.t);location.replace(p.url)}}catch{}});`
    + `const nav=window.navigation;if(nav&&typeof nav.addEventListener==="function"){nav.addEventListener("navigate",e=>{try{`
    + `if(e.navigationType!=="push"||!e.cancelable||e.hashChange||e.downloadRequest)return;`
    + `const u=new URL(e.destination.url);if(u.origin!==location.origin||u.pathname!==location.pathname)return;`
    + `const q=u.searchParams;if(!q.has("folder")&&!q.has("workspace")&&!q.has("ew"))return;`
    + `e.preventDefault();const id=tok();const t=setTimeout(()=>{if(pending.delete(id))location.replace(u.href)},${GO_FALLBACK_MS});`
    + `pending.set(id,{url:u.href,t});tell({type:"ezil.code.open",v:1,id,...what(u.search)})}catch{}})}`
    + `addEventListener("beforeunload",()=>{try{tell({type:"ezil.code.leaving",v:1})}catch{}});`
    + `tell({type:"ezil.code.ready",v:1})}catch{}})();`;
}

/**
 * `html` with the bridge inserted right after the head's `<meta charset>` (else first in `<head>`), carrying the
 * document's own CSP nonce (the first `<script nonce="…">`'s). After the charset declaration, not before it: the
 * script is about 2 KB, and code-server sends `text/html` without a charset, so a declaration pushed past the first
 * 1024 bytes would leave the encoding to each browser's prescan (review N2). It still runs before every workbench
 * script that matters (those are modules at the end of the document). The legacy-notice `<style>` follows it (its
 * `!important` wins over the old image's rule wherever it sits). Unchanged when: no origins (no bridge configured),
 * no nonce to carry (it could not run under code-server's CSP anyway), no `<head>`, or the document already has one.
 */
export function injectCodeFolderBridge(html: string, origins: readonly string[]): string {
  if (origins.length === 0 || html.includes(BRIDGE_MARKER)) return html;
  const nonce = /<script\s+nonce="([^"]*)"/i.exec(html)?.[1];
  if (!nonce || !NONCE_RE.test(nonce)) return html;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return html;
  const script = codeFolderBridgeScript(origins);
  // Defense in depth: the script is a constant plus validated origins, so it can never close its own tag.
  if (/<\/|<!--/.test(script)) return html;
  const headStart = head.index + head[0].length;
  const headEnd = html.indexOf('</head>', headStart);
  const charset = /<meta\s+charset\s*=\s*["']?[A-Za-z0-9_-]+["']?\s*\/?>/i.exec(html.slice(headStart, headEnd < 0 ? undefined : headEnd));
  const at = charset ? headStart + charset.index + charset[0].length : headStart;
  return `${html.slice(0, at)}\n<script nonce="${nonce}" ${BRIDGE_MARKER}="1">${script}</script>`
    + `<style ${LEGACY_NOTICE_MARKER}="1">${LEGACY_NOTICE_HIDE_CSS}</style>${html.slice(at)}`;
}

/**
 * Whether a request for code-server is for its WORKBENCH document: a GET of `/` (the editor's root; webviews,
 * the auth callback and every asset live elsewhere), never a WebSocket upgrade. `path` is code-server's own path
 * (the Cloudflare host's `/preview` prefix already stripped).
 */
export function isWorkbenchDocumentRequest(method: string, path: string, upgrade: string | null): boolean {
  return method.toUpperCase() === 'GET' && path === '/' && (upgrade ?? '').toLowerCase() !== 'websocket';
}

/** Whether a response is an HTML document worth reading for injection (2xx, text/html). */
export function isHtmlDocument(status: number, contentType: string | null): boolean {
  return status >= 200 && status < 300 && /^\s*text\/html\b/i.test(contentType ?? '');
}
