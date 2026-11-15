// Actual built shell: boot parses Billing intent, launches Settings, then adopts its clean URL.
// All HTTP and Stripe are local doubles. No login, payment or provider operation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { summaryV3, trialSummaryV3 } from './billing-v3-fixtures.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const assets=process.env.EZIL_SHELL_OUT_DIR||path.resolve(here,'../../../../app/public/os');
const bundle=readFileSync(path.join(assets,'bundle.min.js'),'utf8'),icons=readFileSync(path.join(assets,'icons.js'),'utf8');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const end='2027-02-28T03:00:00Z';let groups=0;
// The server's read-only availability answer (billing.trialOffer) and the offer its activation quote carries.
const FP='f'.repeat(64),PUBLIC={available:true,eligible:true,offer:{coupon:null,fingerprint:FP,source:'public'}};
async function boot(entry,summary,trialOffer=PUBLIC){
 const dom=new JSDOM('<!doctype html><div id="ezil-os-root"></div>',{url:'https://os.example'+entry,runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,calls=[],observers=[];const Observer=w.MutationObserver;w.MutationObserver=class extends Observer{constructor(callback){super(callback);observers.push(this);}};w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 w.__EZIL_BOOT__={user:{id:'own-user',email:'test@example.test'},computer:{id:'11111111-1111-4111-8111-111111111111',name:'Own',slot:1},apps:[{id:'desktop'}],desktopState:{configured:false,provider:'cloudflare-guacamole'},features:{billing:true}};
 const reply=value=>({ok:true,status:200,json:async()=>({result:{data:{json:value}}})});
 w.fetch=async(url,options={})=>{
  const method=String(url).split('/api/trpc/')[1]?.split('?')[0];
  const query=new URL(String(url),'https://os.example').searchParams.get('input');
  const input=options.body?JSON.parse(options.body).json:query?JSON.parse(query).json:undefined;
  calls.push({url:String(url),method,input});
  // `trialOffer` may answer per request input (a link's alias), as the server does.
  const answer=typeof trialOffer==='function'?trialOffer(input):trialOffer;
  if(method==='billing.summary')return reply(summary);
  if(method==='billing.history'||method==='computer.list')return reply([]);
  if(method==='billing.trialOffer')return answer.ok===false?{ok:false,status:400,json:async()=>({error:{json:{message:answer.code,data:{code:'BAD_REQUEST'}}}})}:reply(answer);
  if(method==='billing.quoteTrial')return reply({sku:'standard_monthly_v3',todayCents:0,trialEndsAt:end,firstChargeAt:end,amountCents:2000,currency:'usd',interval:'month',
   offer:{coupon:answer.offer?.coupon??null,fingerprint:FP,source:answer.offer?.source??'public'}});
  if(method==='billing.createCheckout')return reply({mode:'embedded',sessionId:'cs_fake',clientSecret:'secret',publishableKey:'pk_test'});
  if(method==='billing.checkoutStatus')return reply({status:'open',paymentStatus:null});
  return {ok:false,status:404,json:async()=>({error:{json:{message:'fake unavailable'}}})};
 };
 w.Stripe=()=>({initEmbeddedCheckout:async()=>({mount:selector=>{const el=w.document.createElement('div');el.dataset.role='fake-checkout';el.textContent='Secure Checkout';w.document.querySelector(selector).append(el);},destroy(){}})});
 w.eval(icons);w.eval(bundle);
 async function until(predicate){for(let i=0;i<60;i++){if(predicate())return;await wait(10);}assert.ok(predicate(),'actual boot reached expected state');}
 await until(()=>w.document.querySelector('[data-role="plan-card"]'));
 return {w,calls,until,close:()=>{w.dispatchEvent(new w.Event('ezil:teardown'));for(const observer of observers)observer.disconnect();w.close();}};
}
for(const base of ['/os?settings=billing','/app/settings?tab=billing'])for(const hint of ['unavailable','identity_required']){
 const b=await boot(base+'&coupon_entry='+hint+'&keep=1',summaryV3('free'));
 try{
  await b.until(()=>b.w.document.querySelector('[data-role="coupon-entry"]')&&!new URLSearchParams(b.w.location.search).has('coupon_entry'));
  const notice=b.w.document.querySelector('[data-role="coupon-entry"]').textContent;
  assert.match(notice,hint==='unavailable'?/invalid, expired or no longer available/:/Sign in to this account with EZiL ID/);
  assert.equal(b.w.location.pathname,'/app/settings');assert.equal(new URLSearchParams(b.w.location.search).get('keep'),'1');
  assert.equal(b.w.document.querySelector('[data-action="trial"]'),null);
  assert.equal(b.calls.filter(c=>c.method==='billing.quoteTrial'||c.method==='billing.createCheckout').length,0);
  groups++;console.log('PASS actual boot coupon hint',base,hint);
 }finally{b.close();}
}
for(const entry of ['primary','plan-card','deep-link','canonical-deep-link','AI-recovery']){
 const link=entry==='deep-link'?'/os?settings=billing&upgrade=standard':entry==='canonical-deep-link'?'/app/settings?tab=billing&upgrade=standard':entry==='AI-recovery'?'/os?settings=billing&section=ai-credits&reason=insufficient_credits':'/os?settings=billing';
 const b=await boot(link,trialSummaryV3('offer'));
 try{
  if(entry==='primary'||entry==='plan-card'){
   const selector=entry==='primary'?'[data-role="plan-actions"] [data-action="trial"]':'[data-role="plan-offer"][data-sku="standard_monthly_v3"] [data-action="trial"]';
   const btn=b.w.document.querySelector(selector);assert.ok(btn);
   assert.equal(b.calls.filter(c=>c.method==='billing.quoteTrial'||c.method==='billing.createCheckout').length,0,'page view only reads');
   btn.click();btn.click();
  }
  await b.until(()=>b.w.document.querySelector('[data-role="fake-checkout"]'));
  assert.equal(b.calls.filter(c=>c.method==='billing.quoteTrial').length,1,entry);
  const creates=b.calls.filter(c=>c.method==='billing.createCheckout');assert.equal(creates.length,1,entry);
  assert.equal(JSON.stringify(creates[0].input),JSON.stringify({sku:'standard_monthly_v3',trial:{trialEndsAt:end,offer:{coupon:null,fingerprint:FP}}}));
  assert.equal(b.w.document.querySelector('[data-action="trial-continue"]'),null);
  assert.equal(b.w.document.querySelectorAll('[data-role="upgrade-sheet"]').length,1);
  groups++;console.log('PASS actual entry one activation',entry);
 }finally{b.close();}
}
// The summary's preview alone never shows a free month: a refused read leaves no trial CTA and sends no quote.
for(const code of ['trial_offer_unavailable','trial_unavailable']){
 const b=await boot('/os?settings=billing',trialSummaryV3('offer'),{ok:false,code});
 try{
  await b.until(()=>b.calls.some(c=>c.method==='billing.trialOffer'));await wait(50);
  assert.equal(b.w.document.querySelector('[data-action="trial"]'),null,code);
  assert.equal(b.calls.filter(c=>c.method==='billing.quoteTrial'||c.method==='billing.createCheckout').length,0);
  groups++;console.log('PASS actual boot refused read shows no free month',code);
 }finally{b.close();}
}
// Stage's verified opaque invite rides the server's HttpOnly cookie: no coupon in the address, none sent. The server's
// sponsor selection is shown, quoted and echoed exactly.
{
 const summary=trialSummaryV3('offer');summary.trialOffer.source='sponsor';
 const b=await boot('/os?settings=billing',summary,{available:true,eligible:true,offer:{coupon:null,fingerprint:FP,source:'sponsor'}});
 try{
  await b.until(()=>b.w.document.querySelector('[data-role="coupon-offer"]')&&b.w.document.querySelector('[data-action="trial"]'));
  assert.equal(b.calls.filter(c=>c.method==='billing.quoteTrial'||c.method==='billing.createCheckout').length,0,'page view only reads');
  b.w.document.querySelector('[data-role="plan-offer"][data-sku="standard_monthly_v3"] [data-action="trial"]').click();
  await b.until(()=>b.w.document.querySelector('[data-role="fake-checkout"]'));
  const quotes=b.calls.filter(c=>c.method==='billing.quoteTrial');assert.equal(quotes.length,1);assert.ok(!quotes[0].input||!('coupon' in quotes[0].input),'no coupon sent');
  const creates=b.calls.filter(c=>c.method==='billing.createCheckout');assert.equal(creates.length,1);
  assert.equal(JSON.stringify(creates[0].input),JSON.stringify({sku:'standard_monthly_v3',trial:{trialEndsAt:end,offer:{coupon:null,fingerprint:FP}}}));
  groups++;console.log('PASS actual boot opaque invite: no coupon, one activation, exact echo');
 }finally{b.close();}
}
// A coupon or invite entry stays read-only until the Billing CTA. Beside `upgrade=standard` (pricing-page intent), on
// either spelling of the Billing address: no quote, no Checkout, no sheet on page view, and no full-price fallback.
// Then only an explicit CTA on a VALID entry quotes and opens Checkout with the exact echo.
const linkOffer=input=>input?.coupon?{available:true,eligible:true,offer:{coupon:input.coupon,fingerprint:FP,source:input.coupon.includes('_')?'sponsor':'promoter'}}
 :{available:true,eligible:true,offer:{coupon:null,fingerprint:FP,source:'public'}};
const inviteSummary=()=>{const s=trialSummaryV3('offer');s.trialOffer.source='sponsor';return s;};
for(const [label,entry,options] of [
 ['valid Product alias','/os?settings=billing&upgrade=standard&coupon=midhun',{valid:'midhun'}],
 ['valid Product alias (settings alias)','/app/settings?tab=billing&upgrade=standard&coupon=midhun',{valid:'midhun'}],
 ['valid legacy alias','/os?settings=billing&upgrade=standard&coupon=acme_partner',{valid:'acme_partner'}],
 ['malformed alias','/os?settings=billing&upgrade=standard&coupon=bad%20alias',{}],
 ['duplicate alias','/os?settings=billing&upgrade=standard&coupon=midhun&coupon=other',{}],
 ['failed-entry hint','/os?settings=billing&upgrade=standard&coupon_entry=unavailable',{}],
 ['failed-entry hint (settings alias)','/app/settings?tab=billing&upgrade=standard&coupon_entry=identity_required',{}],
 ['empty coupon_entry','/os?settings=billing&upgrade=standard&coupon_entry=',{}],
 ['unknown coupon_entry','/os?settings=billing&upgrade=standard&coupon_entry=zzz',{}],
 ['repeated coupon_entry','/os?settings=billing&upgrade=standard&coupon_entry=unavailable&coupon_entry=unavailable',{}],
 ['valueless coupon_entry (settings alias)','/app/settings?tab=billing&upgrade=standard&coupon_entry',{}],
 ['opaque invite, no coupon','/os?settings=billing&upgrade=standard',{invite:true,valid:null}],
 ['refused invite, no coupon','/os?settings=billing&upgrade=standard',{invite:true,refused:true}],
 // The summary shows no offer, or only the public one, but the accepted fresh read selects the server's invite.
 ['fresh invite read, summary offer null','/os?settings=billing&upgrade=standard',{fresh:true,summary:'null',valid:null}],
 ['fresh invite read, summary offer public','/os?settings=billing&upgrade=standard',{fresh:true,summary:'public',valid:null}],
 // The AI credits recovery link (Free: it would open the Standard upgrade) beside a coupon, hint or invite entry.
 ['recovery link + valid alias','/os?settings=billing&section=ai-credits&reason=insufficient_credits&coupon=midhun',{}],
 ['recovery link + malformed alias','/os?settings=billing&section=ai-credits&reason=insufficient_credits&coupon=bad%20alias',{}],
 ['recovery link + unknown coupon_entry','/os?settings=billing&section=ai-credits&reason=insufficient_credits&coupon_entry=zzz',{}],
 ['recovery link + fresh invite read','/os?settings=billing&section=ai-credits&reason=insufficient_credits',{fresh:true,summary:'public'}],
 ['recovery link + valid alias (settings alias)','/app/settings?tab=billing&section=ai-credits&reason=insufficient_credits&coupon=midhun',{}],
]){
 const sponsor={available:true,eligible:true,offer:{coupon:null,fingerprint:FP,source:'sponsor'}};
 const read=options.refused?{ok:false,code:'trial_offer_unavailable'}:options.invite||options.fresh?sponsor:linkOffer;
 const summaryFor=()=>{if(options.invite)return inviteSummary();const s=trialSummaryV3('offer');if(options.summary==='null')delete s.trialOffer;return s;};
 const b=await boot(entry,summaryFor(),read);
 try{
  await b.until(()=>b.calls.some(c=>c.method==='billing.summary'));await wait(150);
  assert.equal(b.calls.filter(c=>c.method==='billing.quoteTrial'||c.method==='billing.createCheckout').length,0,`${label}: page view only reads`);
  assert.equal(b.w.document.querySelectorAll('[data-role="upgrade-sheet"]').length,0,`${label}: no sheet on page view`);
  if('valid' in options){
   const btn=b.w.document.querySelector('[data-role="plan-offer"][data-sku="standard_monthly_v3"] [data-action="trial"]');assert.ok(btn,`${label}: the CTA is there`);
   btn.click();btn.click();
   await b.until(()=>b.w.document.querySelector('[data-role="fake-checkout"]'));
   const quotes=b.calls.filter(c=>c.method==='billing.quoteTrial');assert.equal(quotes.length,1,label);
   assert.equal(quotes[0].input?.coupon??null,options.valid,`${label}: quoted with the entry's own input`);
   const creates=b.calls.filter(c=>c.method==='billing.createCheckout');assert.equal(creates.length,1,label);
   assert.equal(JSON.stringify(creates[0].input),JSON.stringify({sku:'standard_monthly_v3',trial:{trialEndsAt:end,offer:{coupon:options.valid,fingerprint:FP}}}),label);
  }else{
   assert.equal(b.calls.filter(c=>c.method==='billing.quoteTrial'||c.method==='billing.createCheckout').length,0,`${label}: nothing written`);
  }
  groups++;console.log('PASS actual boot coupon/invite entry with upgrade=standard stays read-only',label);
 }finally{b.close();}
}
console.log(`${groups} actual boot/entry groups passed; all HTTP/Stripe doubled`);
