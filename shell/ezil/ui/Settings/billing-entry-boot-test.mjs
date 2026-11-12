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
async function boot(entry,summary){
 const dom=new JSDOM('<!doctype html><div id="ezil-os-root"></div>',{url:'https://os.example'+entry,runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,calls=[],observers=[];const Observer=w.MutationObserver;w.MutationObserver=class extends Observer{constructor(callback){super(callback);observers.push(this);}};w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 w.__EZIL_BOOT__={user:{id:'own-user',email:'test@example.test'},computer:{id:'11111111-1111-4111-8111-111111111111',name:'Own',slot:1},apps:[{id:'desktop'}],desktopState:{configured:false,provider:'cloudflare-guacamole'},features:{billing:true}};
 const reply=value=>({ok:true,status:200,json:async()=>({result:{data:{json:value}}})});
 w.fetch=async(url,options={})=>{
  const method=String(url).split('/api/trpc/')[1]?.split('?')[0];calls.push({url:String(url),method,input:options.body?JSON.parse(options.body).json:undefined});
  if(method==='billing.summary')return reply(summary);
  if(method==='billing.history'||method==='computer.list')return reply([]);
  if(method==='billing.quoteTrial')return reply({sku:'standard_monthly_v3',todayCents:0,trialEndsAt:end,firstChargeAt:end,amountCents:2000,currency:'usd',interval:'month'});
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
   const btn=b.w.document.querySelector(selector);assert.ok(btn);btn.click();btn.click();
  }
  await b.until(()=>b.w.document.querySelector('[data-role="fake-checkout"]'));
  assert.equal(b.calls.filter(c=>c.method==='billing.quoteTrial').length,1,entry);
  const creates=b.calls.filter(c=>c.method==='billing.createCheckout');assert.equal(creates.length,1,entry);
  assert.equal(JSON.stringify(creates[0].input),JSON.stringify({sku:'standard_monthly_v3',trial:{trialEndsAt:end}}));
  assert.equal(b.w.document.querySelector('[data-action="trial-continue"]'),null);
  assert.equal(b.w.document.querySelectorAll('[data-role="upgrade-sheet"]').length,1);
  groups++;console.log('PASS actual entry one activation',entry);
 }finally{b.close();}
}
console.log(`${groups} actual boot/entry groups passed; all HTTP/Stripe doubled`);
