/** Content-free app failures: a separate closure/channel from the folder bridge. Contract §1–§3:
 * docs/FEEDBACK-APP-FAILURES-CONTRACT.md. Origins come only from codeShellOriginsFor at the existing
 * workbench injection sites. No storage, logging or global names; one rate-limited ready per accepted hello. */
export const DIAG_BRIDGE_MARKER = 'data-ezil-diag-bridge';

export function codeDiagBridgeScript(origins: readonly string[]): string {
  // Plain JavaScript embedded in the document; the golden fixtures exercise this exact validator.
  return `(()=>{try{
const origins=${JSON.stringify(origins)};
if(window.parent===window||!origins.length)return;
// APP_FAILURE_VALIDATOR_BEGIN
const matches=(v,re)=>typeof v==="string"&&re.exec(v)?.[0]===v;const uuid=v=>matches(v,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;const codes={interrupted:["stream_interrupted"],network:["network_offline","network_failed"],timeout:["request_timeout","first_token_timeout"],auth:["auth_expired","auth_invalid","session_expired"],credits:["credits_exhausted"],entitlement:["membership_required","model_not_entitled"],rate_limit:["rate_limited"],provider:["provider_error","provider_overloaded","provider_refused","model_unavailable"],cancellation:["request_cancelled"],app_startup:["app_start_failed","app_start_timeout","chat_unavailable"]};const enums={source:["ezil_chat","code_app"],operation:["chat_request","app_start"],stage:["startup","admission","request","headers","stream"],outcome:["failed","retrying","recovered","cancelled"],streamReason:["eof","malformed_event","missing_terminal"],cancellationSource:["caller","user_stop","unknown"]};const keys=new Set(["eventId","source","operation","category","code","stage","outcome","streamReason","cancellationSource","clientRequestId","gatewayRequestId","vscodeRequestId","retryOfClientRequestId","attempt","retryable","durationMs","modelKey","httpStatus"]);const namespaces=new Set(["anthropic","openai","google","gemini","vertex","bedrock","aws-bedrock","amazon","azure","qwen","moonshot","moonshotai","kimi","zai","z-ai","glm","deepseek","mistral","meta","llama","xai","cohere","minimax","groq","cerebras","openrouter","ezil"]);const families=new Set(["claude","gemini","gpt","qwen","kimi","glm","deepseek","mistral","codestral","llama","grok","nova","ezil","minimax","command","sonar"]);const safeModelKey=value=>{if(typeof value!=="string"||!/^[a-z0-9][a-z0-9._:/-]{0,63}$/.test(value)||value!==value.trim())return false;if(value.includes("://")||value.split("/").length>2)return false;const key=value.replace(/^(?:us|eu|apac|global|au|jp)[.]/,"");const match=/^([a-z0-9-]+)[/.](.+)$/.exec(key);let model;if(match&&namespaces.has(match[1]))model=match[2];else if(families.has((/^[a-z]+/.exec(key)||[""])[0]))model=key;else return false;const segments=model.split(/[/.:]/);if(segments.some(segment=>!segment||/^(?:sk|sb|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_]/.test(segment)||/secret|token|passw|bearer|api[-_]?key|private|credential|session|cookie/.test(segment)||/[a-z0-9]{20,}/.test(segment)))return false;return /[0-9-]/.test(segments[0]);};const valid=r=>{if(!r||typeof r!=="object"||Array.isArray(r)||!Reflect.ownKeys(r).every(k=>keys.has(k)))return false;for(const [k,values] of Object.entries(enums))if(r[k]!==undefined&&!values.includes(r[k]))return false;if(!uuid(r.eventId)||r.source===undefined||r.operation===undefined||r.stage===undefined||r.outcome===undefined)return false;if(typeof r.category!=="string"||!Object.prototype.hasOwnProperty.call(codes,r.category)||typeof r.code!=="string")return false;if(r.code!=="unexpected_error"&&!codes[r.category].includes(r.code))return false;if(r.streamReason!==undefined&&r.stage!=="stream")return false;if((r.category==="cancellation")!==(r.cancellationSource!==undefined))return false;if((r.category==="cancellation")!==(r.outcome==="cancelled"))return false;for(const k of ["clientRequestId","gatewayRequestId","vscodeRequestId","retryOfClientRequestId"])if(r[k]!==undefined&&!uuid(r[k]))return false;if(r.attempt!==undefined&&!integer(r.attempt,1,64))return false;if(r.retryable!==undefined&&typeof r.retryable!=="boolean")return false;if(r.durationMs!==undefined&&!integer(r.durationMs,0,3600000))return false;if(r.modelKey!==undefined&&!safeModelKey(r.modelKey))return false;if(r.httpStatus!==undefined&&!integer(r.httpStatus,100,599))return false;return true;};
// APP_FAILURE_VALIDATOR_END
let nonce,origin;const queue=[],posts=[];
const post=(envelope,target)=>{try{
if(new TextEncoder().encode(JSON.stringify(envelope)).byteLength>2048)return;
const now=Date.now();while(posts.length&&posts[0]<=now-60000)posts.shift();
if(posts.length>=20)return;posts.push(now);
window.parent.postMessage(envelope,target);return true;
}catch{}};
const send=failure=>post({type:"ezil.code.failure",v:1,nonce,failure},origin);
window.addEventListener("message",ev=>{try{
const d=ev.data;
if(ev.source!==window.parent||!origins.includes(ev.origin)||!d||typeof d!=="object"||Array.isArray(d))return;
if(Object.keys(d).length!==3||!Object.keys(d).every(k=>["type","v","nonce"].includes(k)))return;
if(d.type!=="ezil.code.diag.hello"||d.v!==1||!matches(d.nonce,/^[A-Za-z0-9_-]{22}$/))return;
if(!post({type:"ezil.code.diag.ready",v:1,nonce:d.nonce},ev.origin))return;
nonce=d.nonce;origin=ev.origin;for(const r of queue.splice(0))send(r);
}catch{}});
window.addEventListener("ezil-app-failure",ev=>{try{
if(typeof ev.detail!=="string")return;
const r=JSON.parse(ev.detail);if(!valid(r))return;
if(nonce){send(r);return}if(queue.length===10)queue.shift();queue.push(r);
}catch{}});
}catch{}})();`;
}

/** Same insertion point and CSP nonce rule as the folder bridge, with independent idempotence. */
export function injectCodeDiagBridge(html: string, origins: readonly string[]): string {
  if (!origins.length || html.includes(DIAG_BRIDGE_MARKER)) return html;
  const nonce = /<script\s+nonce="([^"]*)"/i.exec(html)?.[1];
  if (!nonce || !/^[A-Za-z0-9+/=_-]{8,128}$/.test(nonce)) return html;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return html;
  const script = codeDiagBridgeScript(origins);
  if (/<\/|<!--/.test(script)) return html;
  const start = head.index + head[0].length;
  const end = html.indexOf('</head>', start);
  const charset = /<meta\s+charset\s*=\s*["']?[A-Za-z0-9_-]+["']?\s*\/?>/i.exec(html.slice(start, end < 0 ? undefined : end));
  const at = charset ? start + charset.index + charset[0].length : start;
  return `${html.slice(0, at)}\n<script nonce="${nonce}" ${DIAG_BRIDGE_MARKER}="1">${script}</script>${html.slice(at)}`;
}
