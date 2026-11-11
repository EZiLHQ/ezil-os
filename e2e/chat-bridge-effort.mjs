// Real Code UI + extension; no fake adapter or native state injection.
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const required=n=>{if(!process.env[n])throw Error(n+' required');return process.env[n];};
const local=v=>{const u=new URL(v);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw Error('loopback HTTP required');return u.origin;};
const code=local(required('EZIL_CODE_URL')),api=local(required('EZIL_EFFORT_FIXTURE_URL')),out=required('EZIL_E2E_OUT');
mkdirSync(out,{recursive:true});
const {chromium}=createRequire(required('PLAYWRIGHT_REQUIRE_DIR')+'/fixture.js')('playwright');
const results=[],resources={},expectedModels={};
const check=(name,ok)=>{results.push({name,ok});if(!ok)throw Error(name);};
const state=async()=>{const r=await fetch(api+'/bridge-state');if(!r.ok)throw Error('fixture read');return r.json();};
const enqueue=async spec=>{const r=await fetch(api+'/enqueue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(spec)});if(!r.ok)throw Error('enqueue');return r.json();};
const until=async p=>{const end=Date.now()+150000;while(Date.now()<end){const s=await state();if(p(s))return s;await new Promise(r=>setTimeout(r,750));}throw Error('native condition timeout');};
const op=(s,r)=>s.ops.find(o=>o.role===r);
const done=r=>until(s=>['applied','completed','uncertain','rejected','failed','expired','busy'].includes(op(s,r)?.status));
let browser,context,page;
const launch=async()=>{browser=await chromium.launch();context=await browser.newContext({viewport:{width:1440,height:900}});await context.route('**/*',r=>new URL(r.request().url()).origin===code?r.continue():r.abort());page=await context.newPage();};
const open=async()=>{await page.goto(code+'/?folder='+encodeURIComponent(required('EZIL_EFFORT_WORKSPACE')));await page.locator('.part.auxiliarybar .chat-input-container .monaco-editor').first().waitFor({timeout:120000});};
const command=async title=>{await page.keyboard.press('Control+Shift+P');await page.locator('.quick-input-widget input').fill('>'+title);await page.keyboard.press('Enter');};
const send=async(role,marker,model,effort)=>{
 await enqueue({role:marker,kind:'send',sessionRole:role,text:marker,expectedModel:model,expectedEffort:effort});
 const s=await done(marker),o=op(s,marker),w=s.upstream.filter(x=>x.marker===marker);
 check(marker+' real output',o?.status==='completed'&&o.responseText?.includes('EZIL_NATIVE_OK '+marker));
 check(marker+' exact single wire request',w.length===1&&w[0].body.model===model&&(w[0].body.reasoning?.effort??null)===effort);
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
 results.push({name:'pending native tool approval',status:'NOT_EXERCISED',reason:'Requires separate real tool approval fixture; no approval state fabricated.'});
 await page.screenshot({path:join(out,'native-effort.png')});
} catch(e) {results.push({name:'native run',ok:false,error:String(e.message)});process.exitCode=1;}
finally {await browser?.close();writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2));try{writeFileSync(join(out,'fixture-state.json'),JSON.stringify(await state(),null,2));}catch{} }
