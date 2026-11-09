/** Code -> EZiL OS billing requests (Free includes Gemini 3.8 Flash only; app billing/v3/ai-models.ts). The renderer's
 * `_ezil.billingIntent` (patch-copilot-chat.sh `billing-intent`) dispatches a cancelable `ezil-billing-intent`
 * event. After a nonce handshake with the shell's pinned origin, this bridge hands that shell a closed record:
 * `{ reason: credits_exhausted | model_locked, requestId?, model? }`. It then cancels the event, so ezil-models knows the
 * OS took it. A sibling of the diagnostic bridge (code-diag-bridge.ts) with its own closure, marker and message types.
 * Never queued: a request made before the handshake stays with the extension's own notice. Origins come only from
 * codeShellOriginsFor at the existing workbench injection sites. No storage, logging or global names. */
export const BILLING_BRIDGE_MARKER = 'data-ezil-billing-bridge';

export function codeBillingBridgeScript(origins: readonly string[]): string {
  // Plain JavaScript embedded in the document.
  return `(()=>{try{
const origins=${JSON.stringify(origins)};
if(window.parent===window||!origins.length)return;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,ALIAS=/^[a-z0-9][a-z0-9._-]{0,63}$/,KEYS=["reason","requestId","model"];
let nonce,origin;const posts=[];
const post=(envelope,target)=>{try{
const now=Date.now();while(posts.length&&posts[0]<=now-60000)posts.shift();
if(posts.length>=10)return false;posts.push(now);
window.parent.postMessage(envelope,target);return true;
}catch{return false}};
window.addEventListener("message",ev=>{try{
const d=ev.data;
if(ev.source!==window.parent||!origins.includes(ev.origin)||!d||typeof d!=="object"||Array.isArray(d))return;
if(Object.keys(d).length!==3||!Object.keys(d).every(k=>["type","v","nonce"].includes(k)))return;
if(d.type!=="ezil.code.billing.hello"||d.v!==1||typeof d.nonce!=="string"||!/^[A-Za-z0-9_-]{22}$/.test(d.nonce))return;
if(!post({type:"ezil.code.billing.ready",v:1,nonce:d.nonce},ev.origin))return;
nonce=d.nonce;origin=ev.origin;
}catch{}});
window.addEventListener("ezil-billing-intent",ev=>{try{
if(!nonce||typeof ev.detail!=="string"||ev.detail.length>512)return;
const r=JSON.parse(ev.detail);
if(!r||typeof r!=="object"||Array.isArray(r)||!Object.keys(r).every(k=>KEYS.includes(k)))return;
if(r.reason!=="credits_exhausted"&&r.reason!=="model_locked")return;
if(r.requestId!==undefined&&!(typeof r.requestId==="string"&&UUID.test(r.requestId)))return;
if(r.model!==undefined&&!(typeof r.model==="string"&&ALIAS.test(r.model)))return;
const intent={reason:r.reason};if(r.requestId!==undefined)intent.requestId=r.requestId;if(r.model!==undefined)intent.model=r.model;
if(post({type:"ezil.code.billing.intent",v:1,nonce,intent},origin))ev.preventDefault();
}catch{}});
}catch{}})();`;
}

/** Same insertion point and CSP nonce rule as the folder and diagnostic bridges, with independent idempotence. */
export function injectCodeBillingBridge(html: string, origins: readonly string[]): string {
  if (!origins.length || html.includes(BILLING_BRIDGE_MARKER)) return html;
  const nonce = /<script\s+nonce="([^"]*)"/i.exec(html)?.[1];
  if (!nonce || !/^[A-Za-z0-9+/=_-]{8,128}$/.test(nonce)) return html;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return html;
  const script = codeBillingBridgeScript(origins);
  if (/<\/|<!--/.test(script)) return html;
  const start = head.index + head[0].length;
  const end = html.indexOf('</head>', start);
  const charset = /<meta\s+charset\s*=\s*["']?[A-Za-z0-9_-]+["']?\s*\/?>/i.exec(html.slice(start, end < 0 ? undefined : end));
  const at = charset ? start + charset.index + charset[0].length : start;
  return `${html.slice(0, at)}\n<script nonce="${nonce}" ${BILLING_BRIDGE_MARKER}="1">${script}</script>${html.slice(at)}`;
}
