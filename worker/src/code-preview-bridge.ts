/** Code preview URL requests, Hop 3 of code-preview-v1. The renderer dispatches a cancelable JSON event;
 * only a nonce-bound shell may answer an id this document relayed. No storage, logging or global names. */
import { scriptJson } from './inline-script';

const isHttpsOrigin = (value: string): boolean => {
  try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value; } catch { return false; }
};

export const PREVIEW_BRIDGE_MARKER = 'data-ezil-preview-bridge';

export function codePreviewBridgeScript(origins: readonly string[]): string {
  return String.raw`(()=>{try{
const origins=${scriptJson(origins)};
if(window.parent===window||!origins.length)return;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const token=v=>typeof v==='string'&&v.length===22&&/^[A-Za-z0-9_-]{22}$/.test(v);
const keys=(v,allowed)=>object(v)&&Object.keys(v).every(k=>allowed.includes(k));
function reply(r){
  if(!keys(r,['url','expiresAt','error']))return null;
  if(Object.keys(r).length===1&&typeof r.error==='string'&&/^[a-z_]{1,40}$/.test(r.error)&&!/[\r\n]/.test(r.error))return {error:r.error};
  if(Object.keys(r).length!==2||typeof r.url!=='string'||r.url.length>8192||/[\x00-\x20\x7f\\]/.test(r.url)||!Number.isSafeInteger(r.expiresAt)||r.expiresAt<=0)return null;
  try{const u=new URL(r.url);
    if(u.protocol!=='https:'||u.username||u.password||u.port||! /^(?:3002-[a-z0-9-]{1,80}-app|aws-3002-[a-z0-9-]{1,80}-aws)\.[a-z0-9.-]+$/.test(u.hostname))return null;
    return {url:r.url,expiresAt:r.expiresAt};
  }catch{return null}
}
let nonce,origin;const posts=[],pending=new Map(),seen=new Set();
function forget(id){const p=pending.get(id);if(!p)return;pending.delete(id);clearTimeout(p.timer);return p}
function cancel(id){
  const p=forget(id);if(!p)return;
  // Only a previously relayed id can cancel. Do not let the mint/hello rate budget strand work.
  try{window.parent.postMessage({type:'ezil.code.preview.cancel',v:1,nonce:p.nonce,id},p.origin)}catch{}
}
const cancelAll=()=>{for(const id of pending.keys())cancel(id)};
const post=(envelope,target)=>{try{
  const now=Date.now();while(posts.length&&posts[0]<=now-60000)posts.shift();
  if(posts.length>=10)return false;posts.push(now);window.parent.postMessage(envelope,target);return true;
}catch{return false}};
window.addEventListener('message',ev=>{try{
  const d=ev.data;
  if(ev.source!==window.parent||!origins.includes(ev.origin)||ev.origin==='*'||ev.origin==='null'||!object(d)||d.v!==1||!token(d.nonce))return;
  if(d.type==='ezil.code.preview.hello'&&keys(d,['type','v','nonce'])){
    if(!post({type:'ezil.code.preview.ready',v:1,nonce:d.nonce},ev.origin))return;
    if(nonce!==d.nonce||origin!==ev.origin)cancelAll();nonce=d.nonce;origin=ev.origin;return;
  }
  if(d.type!=='ezil.code.preview.url'||d.nonce!==nonce||ev.origin!==origin||!token(d.id)||!pending.has(d.id)||!keys(d,['type','v','nonce','id','url','expiresAt','error']))return;
  const r={};for(const k of ['url','expiresAt','error'])if(Object.hasOwn(d,k))r[k]=d[k];
  const kept=reply(r);if(!kept)return;
  forget(d.id);
  window.dispatchEvent(new CustomEvent('ezil-preview-mint-reply',{detail:JSON.stringify({v:1,id:d.id,...kept})}));
}catch{}});
window.addEventListener('ezil-preview-mint',ev=>{try{
  if(!nonce||!ev.cancelable||typeof ev.detail!=='string'||ev.detail.length>128)return;
  const d=JSON.parse(ev.detail);
  if(!keys(d,['v','id'])||d.v!==1||!token(d.id)||seen.has(d.id))return;
  pending.set(d.id,{nonce,origin,timer:setTimeout(()=>{
    cancel(d.id);
    window.dispatchEvent(new CustomEvent('ezil-preview-mint-reply',{detail:JSON.stringify({v:1,id:d.id,error:'timeout'})}));
  },240000)});
  if(post({type:'ezil.code.preview.mint',v:1,nonce,id:d.id},origin)){seen.add(d.id);ev.preventDefault()}else forget(d.id);
}catch{}});
window.addEventListener('ezil-preview-mint-cancel',ev=>{try{
  if(typeof ev.detail!=='string'||ev.detail.length>128)return;
  const d=JSON.parse(ev.detail);
  if(!keys(d,['v','id'])||d.v!==1||!token(d.id))return;
  cancel(d.id);
}catch{}});
window.addEventListener('pagehide',cancelAll);
}catch{}})();`;
}

/** Same insertion point and CSP nonce rule as the billing bridge, with independent idempotence. */
export function injectCodePreviewBridge(html: string, origins: readonly string[]): string {
  if (!origins.length || html.includes(PREVIEW_BRIDGE_MARKER)) return html;
  // Each pinned origin must be exactly an https origin (codeShellOriginsFor's fixed values); anything else is refused
  // outright rather than embedded, even though scriptJson would keep it inert.
  if (!origins.every(isHttpsOrigin)) return html;
  const nonce = /<script\s+nonce="([^"]*)"/i.exec(html)?.[1];
  if (!nonce || !/^[A-Za-z0-9+/=_-]{8,128}$/.test(nonce)) return html;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return html;
  const script = codePreviewBridgeScript(origins);
  if (/<\/|<!--/.test(script)) return html;
  const start = head.index + head[0].length;
  const end = html.indexOf('</head>', start);
  const charset = /<meta\s+charset\s*=\s*["']?[A-Za-z0-9_-]+["']?\s*\/?>/i.exec(html.slice(start, end < 0 ? undefined : end));
  const at = charset ? start + charset.index + charset[0].length : start;
  return `${html.slice(0, at)}\n<script nonce="${nonce}" ${PREVIEW_BRIDGE_MARKER}="1">${script}</script>${html.slice(at)}`;
}
