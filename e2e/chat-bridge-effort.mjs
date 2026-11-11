// Real Code UI + extension; no fake adapter or native state injection.
import {safeDiagnostic,diagnosticBuffer} from './chat-bridge-effort-diagnostics.mjs';
import {captureEvidence} from './chat-bridge-effort-evidence.mjs';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
const required=n=>{if(!process.env[n])throw Error(n+' required');return process.env[n];};
const local=v=>{const u=new URL(v);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw Error('loopback HTTP required');return u.origin;};
const code=local(required('EZIL_CODE_URL')),api=local(required('EZIL_EFFORT_FIXTURE_URL')),outputRoot=required('EZIL_E2E_OUT');
mkdirSync(outputRoot,{recursive:true});
const out=mkdtempSync(join(outputRoot,'evidence-'));
console.log('Native evidence directory: '+out);
const controller=required('EZIL_EFFORT_CONTROLLER_TOKEN');
const diagnosticSecrets=[controller,process.env.EZIL_AI_PROXY_TOKEN,process.env.EZIL_EDITOR_BRIDGE_TOKEN].filter(Boolean);
const diagnostics=diagnosticBuffer(diagnosticSecrets);
const controlHeaders={authorization:`Bearer ${controller}`};
const {chromium}=createRequire(required('PLAYWRIGHT_REQUIRE_DIR')+'/fixture.js')('playwright');
const chromiumArgs=JSON.parse(process.env.EZIL_CHROMIUM_ARGS_JSON??'[]');
if (!Array.isArray(chromiumArgs)||chromiumArgs.some(x=>typeof x!=='string')) throw Error('EZIL_CHROMIUM_ARGS_JSON must be a string array');
if (chromiumArgs.some(x=>x==='--no-sandbox'||x==='--disable-setuid-sandbox') && process.env.EZIL_CHROMIUM_NO_SANDBOX_ALLOWED!=='yes')
 throw Error('Sandbox disabling requires explicit disposable-environment acknowledgment');
const browserEnv={...process.env};delete browserEnv.EZIL_EFFORT_CONTROLLER_TOKEN;
const launchOptions={env:browserEnv,args:chromiumArgs,...(process.env.EZIL_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.EZIL_CHROMIUM_EXECUTABLE_PATH}:{})};
const results=[],resources={},expectedModels={},nativeModes={};
const check=(name,ok)=>{results.push({name,ok});if(!ok)throw Error(name);};
const state=async()=>{const r=await fetch(api+'/bridge-state',{headers:controlHeaders});if(!r.ok)throw Error('fixture read');return r.json();};
const enqueue=async spec=>{const r=await fetch(api+'/enqueue',{method:'POST',headers:{...controlHeaders,'content-type':'application/json'},body:JSON.stringify(spec)});if(!r.ok)throw Error('enqueue');return r.json();};
const until=async p=>{const end=Date.now()+150000;while(Date.now()<end){const s=await state();if(p(s))return s;await new Promise(r=>setTimeout(r,750));}throw Error('native condition timeout');};
const op=(s,r)=>s.ops.find(o=>o.role===r);
const done=r=>until(s=>['applied','completed','uncertain','rejected','failed','expired','busy'].includes(op(s,r)?.status));
let browser,context,page;
const launch=async()=>{browser=await chromium.launch(launchOptions);context=await browser.newContext({viewport:{width:1440,height:900}});await context.route('**/*',r=>new URL(r.request().url()).origin===code?r.continue():r.abort());page=await context.newPage();page.on('console',m=>diagnostics.add('console:'+m.type(),m.text()));page.on('pageerror',e=>diagnostics.add('pageerror',e.message));};
const open=async()=>{await page.goto(code+'/?folder='+encodeURIComponent(required('EZIL_EFFORT_WORKSPACE')));await page.locator('.part.auxiliarybar .chat-input-container .monaco-editor').first().waitFor({timeout:120000});};
const command=async title=>{await page.keyboard.press('Control+Shift+P');await page.locator('.quick-input-widget input').fill('>'+title);await page.keyboard.press('Enter');};
const send=async(role,marker,model,effort)=>{
 await enqueue({role:marker,kind:'send',sessionRole:role,text:marker,expectedModel:model,expectedEffort:effort});
 const s=await done(marker),o=op(s,marker),w=s.upstream.filter(x=>x.marker===marker);
 check(marker+' real output',o?.status==='completed'&&o.responseText?.includes('EZIL_NATIVE_OK '+marker));
 check(marker+' exact single wire request',w.length===1&&w[0].body.model===model&&(w[0].body.reasoning?.effort??null)===effort);
 check(marker+' native mode witness',typeof o.mode==='string'&&o.mode.length>0);
 if(nativeModes[role]===undefined)nativeModes[role]=o.mode;
 check(marker+' native mode preserved',o.mode===nativeModes[role]);
 check(marker+' selected effort',(o.selectedEffort??null)===effort);
 const fresh=await until(x=>x.sessionsAt>s.now&&x.sessions.some(t=>t.resource===resources[role]&&t.open));
 const observed=fresh.sessions.find(t=>t.resource===resources[role]);
 check(marker+' fresh native snapshot',observed.model===expectedModels[role]&&observed.effort===effort);
};
try {
 await launch();await open();
 const initial=await until(s=>s.protocols['3']&&s.catalog?.models?.length);
 check('negotiates1 then3',initial.protocols['1']>=1&&initial.refused.length===0);
 const models=Object.fromEntries(['a','b'].map(x=>[x,initial.catalog.models.find(m=>m.label==='Native '+x.toUpperCase())]));
 check('explicit fixture capability',Object.values(models).every(m=>m?.availability==='available'&&JSON.stringify(m.efforts)==='["low","high"]'&&m.defaultEffort===null));
 await page.waitForTimeout(Number(process.env.EZIL_E2E_SETTLE_MS??45000));
 await page.locator('.part.auxiliarybar .chat-input-container .monaco-editor .view-lines').first().click({force:true});
 await page.keyboard.type('EZIL_NATIVE_WARMUP');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('.part.auxiliarybar .interactive-list')?.textContent?.includes('EZIL_NATIVE_OK'),null,{timeout:120000});
 const before=new Set((await state()).sessions.map(x=>x.resource));
 for(const [role,key,effort] of [['A','a','low'],['B','b','high'],['C','a',null]]) {
  await enqueue({role,kind:'create',model:models[key].id,...(effort?{effort}:{})});
  const o=op(await done(role),role);
  check(role+' new empty chat',o.status==='applied'&&o.requestCount===0&&o.model===models[key].id&&(o.effort??null)===effort&&!before.has(o.sessionResource)&&!Object.values(resources).includes(o.sessionResource));
  resources[role]=o.sessionResource;expectedModels[role]=models[key].id;
  await send(role,'EZIL_NATIVE_'+role,'native-'+key,effort);
 }
 await enqueue({role:'configureB',kind:'configure',sessionRole:'B',model:models.a.id,effort:'high'});
 const cfg=op(await done('configureB'),'configureB');
 check('configure model and effort',cfg.status==='applied'&&cfg.model===models.a.id&&cfg.effort==='high');
 expectedModels.B=models.a.id;
 await send('B','EZIL_NATIVE_B_CHANGED','native-a','high');
 // Close/reopen every actual editor through ordinary UI, without restoring configuration.
 for(const [role,effort] of [['A','low'],['B','high'],['C',null]]) {
  await send(role,'EZIL_NATIVE_BEFORE_CLOSE_'+role,'native-a',effort);
  await page.locator('.part.editor .tab.active').first().click();
  await command('View: Close Editor');
  await until(s=>s.sessions.some(x=>x.resource===resources[role]&&!x.open));
  await command('View: Reopen Closed Editor');
  const reopened=await until(s=>s.sessions.some(x=>x.resource===resources[role]&&x.open));
  check(role+' native close/reopen effort',reopened.sessions.find(x=>x.resource===resources[role])?.effort===effort);
  await send(role,'EZIL_NATIVE_REOPEN_'+role,'native-a',effort);
 }
 // New browser process, same Code server profile; old widgets cannot satisfy readback.
 const epoch=(await state()).epoch;await browser.close();browser=null;
 await new Promise(r=>setTimeout(r,Number(process.env.EZIL_STANDIN_LEASE_MS??30000)+1500));
 await launch();await open();await until(s=>s.epoch>epoch&&s.sessionsAt>s.owners.at(-1).at);
 for(const [role,effort] of [['A','low'],['B','high'],['C',null]]) await send(role,'EZIL_NATIVE_RELOAD_'+role,'native-a',effort);
 // Actual overlapping requests, same model/different effort, after persistence checks.
 await Promise.all([['A','low'],['B','high']].map(([role,effort])=>enqueue({role:'EZIL_NATIVE_OVERLAP_'+role,kind:'send',sessionRole:role,text:'EZIL_NATIVE_OVERLAP_'+role,expectedModel:'native-a',expectedEffort:effort,overlapGroup:'same-model-pair'})));
 const paired=await until(s=>['A','B'].every(role=>['completed','failed','uncertain','rejected'].includes(op(s,'EZIL_NATIVE_OVERLAP_'+role)?.status)));
 const pair=paired.upstream.filter(x=>['EZIL_NATIVE_OVERLAP_A','EZIL_NATIVE_OVERLAP_B'].includes(x.marker));
 check('two requests actually overlap at Gateway',pair.length===2&&pair.every(x=>x.overlap===true)&&Math.max(...pair.map(x=>x.at))<=Math.min(...pair.map(x=>x.releasedAt)));
 for(const [role,effort] of [['A','low'],['B','high']]){
  const marker='EZIL_NATIVE_OVERLAP_'+role,o=op(paired,marker),wire=pair.find(x=>x.marker===marker);
  check(role+' overlapping isolation/output/mode',o.status==='completed'&&o.responseText?.includes(marker)&&o.mode===nativeModes[role]&&wire.body.model==='native-a'&&wire.body.reasoning?.effort===effort);
 }
 results.push({name:'pending native tool approval',status:'NOT_EXERCISED',reason:'Requires separate real tool approval fixture; no approval state fabricated.'});
 await page.screenshot({path:join(out,'native-effort.png')});
 } catch(e) {
 results.push({name:'native run',ok:false,error:safeDiagnostic(e.message,diagnosticSecrets)});process.exitCode=1;
 try {
  const visible=page?await page.locator('body').innerText({timeout:5000}):'';
  writeFileSync(join(out,'failure-diagnostics.json'),JSON.stringify({visibleText:safeDiagnostic(visible,diagnosticSecrets,12000),events:diagnostics.entries},null,2));
  if(page){
   // Sanitize visible diagnostic text only after failure; no native settings/state repair.
   await page.evaluate(secrets=>{
    const scrub=value=>{let s=value;for(const secret of secrets)s=s.split(secret).join('[redacted]');return s.replace(/(?:https?|wss?|file):\/\/[^\s<>"']+/gi,'[url]').replace(/Bearer\s+[^\s,"'}]+/gi,'Bearer [redacted]').replace(/((?:access_token|refresh_token|id_token|authorization|api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;}]+/gi,'$1[redacted]');};
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())node.textContent=scrub(node.textContent??'');
   },diagnosticSecrets);
   await page.screenshot({path:join(out,'failure.png'),fullPage:false,timeout:5000,mask:[page.locator('input,textarea,[contenteditable="true"]')]});
  }
 }catch(diagnosticError){results.push({name:'failure diagnostics',ok:false,error:safeDiagnostic(diagnosticError.message,diagnosticSecrets)});}
}
finally {
 try {await browser?.close();}catch(e){results.push({name:'browser cleanup',ok:false,error:String(e.message)});process.exitCode=1;}
 if(!await captureEvidence(out,results,state))process.exitCode=1;
}
