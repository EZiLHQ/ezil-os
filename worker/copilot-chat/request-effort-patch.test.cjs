// Real pinned Code4.141/Copilot0.69 options expression, before and after the full patch.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const crypto=require('node:crypto');
const source=process.env.COPILOT_TEST_ROOT;
const files=['extensions/copilot/dist/extension.js','extensions/copilot/package.json','extensions/copilot/package.nls.json','extensions/copilot/LICENSE.txt','product.json','out/nls.messages.js','out/nls.messages.json','out/vs/code/browser/workbench/workbench.js','out/vs/code/browser/workbench/workbench.css','out/server-main.js'];
function options(bundle){
 const start=bundle.indexOf('async makeChatRequest2({');
 const a=bundle.indexOf('y={includeEncryptedThinking:',start),b=bundle.indexOf(';bBn(g)',a);
 assert.ok(start>0&&a>start&&b>a);
 return new Function('a','g','f','h','d','p','ezilPrimaryRequestEffort','return '+bundle.slice(a+2,b));
}
const build=(fn,vendor,cap,primary=true)=>fn.call({languageModel:{vendor}},{tools:[]},'synthetic-correlation',null,undefined,cap,undefined,primary);
test('pinned external endpoint forwards only explicit request effort for EZiL', {skip:!source&&'COPILOT_TEST_ROOT not set'},async()=>{
 const pristine=fs.readFileSync(path.join(source,files[0]),'utf8');
 assert.equal(crypto.createHash('sha256').update(pristine).digest('hex'),'e32a017f658f518eaaf38bb52df8bb6a1cbac68610e997addac835630622530f');
 const before=options(pristine);
 for(const effort of ['low','high'])assert.equal(build(before,'ezil',{reasoningEffort:effort}).configuration,undefined,'original loses explicit effort');
 const root=fs.mkdtempSync(path.join(process.env.EZIL_PATCH_SCRATCH||os.tmpdir(),'ezil-request-effort-'));
 try{
  for(const file of files){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.copyFileSync(path.join(source,file),path.join(root,file));}
  const script=path.join(__dirname,'patch-copilot-chat.sh');
  for(const args of [[root],['--verify',root]]){
   const run=spawnSync('bash',[script,...args],{encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(run.status,0,run.stderr+'\n'+run.stdout);
  }
  const syntax=spawnSync(process.execPath,['--check',path.join(root,files[0])],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
  const patched=fs.readFileSync(path.join(root,files[0]),'utf8'),after=options(patched);
  const sdk=fs.readFileSync(path.join(source,'out/vs/workbench/api/node/extensionHostProcess.js'),'utf8');
  assert.ok(sdk.includes('modelConfiguration:i.configuration'),'pinned SDK maps configuration into provider modelConfiguration');
  // Internal Agent location overrides SDK Panel: bind this regression to real pinned source.
  assert.ok(pristine.includes('u[u.Agent=7]="Agent"'));
  assert.ok(pristine.includes('overrideRequestLocation:7}}async handleRequest(n,r,o,a,s,c,l,u,d)'));
  assert.ok(pristine.includes('s=this.options.overrideRequestLocation??this.options.location'));
  // Execute the actual patched primary callsite provenance expression.
  const ca=patched.indexOf('ezilPrimaryRequestEffort:s===7');
  assert.ok(ca>0);
  const ce=patched.slice(ca+'ezilPrimaryRequestEffort:'.length,patched.indexOf(',modeChanged:p',ca));
  const eligible=new Function('s','d','n','u','return '+ce);
  const primary=(request={},n={},location=7,effort="low")=>eligible.call({options:{request}},location,!!request.subAgentInvocationId,n,effort);
  assert.equal(primary(),true);
  // Root v5 actual context was Agent7 + explicit low + all exclusion flags false.
  for(const effort of ['low','high']){
   const provenance=primary({}, {},7,effort);
   assert.deepEqual(build(after,'ezil',{reasoningEffort:effort},provenance).configuration,{reasoningEffort:effort});
  }
  for(const req of [{subAgentInvocationId:'child'}, {parentRequestId:'parent'}, {isSystemInitiated:true}])assert.equal(primary(req),false);
  assert.equal(primary({}, {isKeepAliveProbe:true}),false);
  for(const location of [1,4,6,9])assert.equal(primary({}, {},location),false);
  for(const effort of [null,7])assert.equal(primary({}, {},7,effort),false);
  assert.equal(eligible.call({options:{request:{}}},7,false,{},undefined),false);
  assert.equal(eligible.call({options:{request:{}}},undefined,false,{},'low'),false);
  // Actual background summarizer copies parent capabilities but never receives the provenance field.
  const summary=pristine.indexOf('debugName:"summarizeConversationHistory",messages:E');
  assert.ok(summary>0);const summaryCall=pristine.slice(summary,pristine.indexOf('},v)',summary));
  assert.ok(summaryCall.includes('modelCapabilities:y'));
  assert.ok(summaryCall.includes('location:7'),'summary uses same location but lacks primary-call provenance');
  assert.ok(!summaryCall.includes('ezilPrimaryRequestEffort'));
  const title=pristine.indexOf('debugName:"title",messages:c');assert.ok(title>0);
  assert.ok(!pristine.slice(title,pristine.indexOf('},n)',title)).includes('modelCapabilities:'));
  for(const provenance of [false,undefined,null,'true',1]){
   const result=after.call({languageModel:{vendor:'ezil'}},{},'synthetic',null,undefined,{reasoningEffort:'low'},undefined,provenance);
   assert.equal(result.configuration,undefined,'inherited summary/child/unknown effort is not authorized');
  }
  const inputs=[{reasoningEffort:'low'},{reasoningEffort:'high'}];
  const [low,high]=await Promise.all(inputs.map(async cap=>build(after,'ezil',cap)));
  assert.deepEqual(low.configuration,{reasoningEffort:'low'});assert.deepEqual(high.configuration,{reasoningEffort:'high'});
  assert.notEqual(low.configuration,high.configuration);assert.notEqual(low.configuration,inputs[0]);
  low.configuration.reasoningEffort='changed';assert.equal(high.configuration.reasoningEffort,'high');assert.equal(inputs[0].reasoningEffort,'low');
  // Utility/child calls carry no effort of their own; prior parent calls cannot supply it.
  for(const cap of [undefined,{}, {enableThinking:true},{reasoningEffort:null},{reasoningEffort:7}])assert.deepEqual(build(after,'ezil',cap),build(before,'ezil',cap));
  for(const vendor of ['copilot','other','EZiL',undefined])assert.deepEqual(build(after,vendor,{reasoningEffort:'low'}),build(before,vendor,{reasoningEffort:'low'}));
  assert.equal(build(after,'ezil',{reasoningEffort:'revoked'}).configuration.reasoningEffort,'revoked','provider fresh validation, not endpoint guesses, rejects unsupported strings');
  for(const file of [files[0],files[7]])console.log('patched-sha256',file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'));
  // An older partially patched bundle cannot silently pass the new verification gate.
  const insertion='...ezilPrimaryRequestEffort===!0&&this.languageModel.vendor==="ezil"&&typeof d?.reasoningEffort==="string"?{configuration:{reasoningEffort:d.reasoningEffort}}:{},';
  assert.equal(patched.split(insertion).length,2);
  fs.writeFileSync(path.join(root,files[0]),patched.replace(insertion,''));
  const refusal=spawnSync('bash',[script,'--verify',root],{encoding:'utf8',maxBuffer:8*1024*1024});assert.notEqual(refusal.status,0);assert.match(refusal.stderr,/ezil-request-effort/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
