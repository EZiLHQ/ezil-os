// Executes pinned native methods; services/observables are synthetic, no running Code UI.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=process.env.COPILOT_TEST_ROOT;
const isolation=vm.runInThisContext(fs.readFileSync(path.join(__dirname,'session-effort-isolation.js'),'utf8'));
test('pinned native draft, configuration and JSON methods isolate session effort across recreation', {skip:!root&&'COPILOT_TEST_ROOT not set'},async()=>{
 const wb=fs.readFileSync(path.join(root,'out/vs/code/browser/workbench/workbench.js'),'utf8');
 assert.equal(crypto.createHash('sha256').update(wb).digest('hex'),'5adda0751dea27657788e05f4ddd2afdcd34f8cd08369c8c814e6fc8ebd1af3f');
 const section=(a,b)=>{const i=wb.indexOf(a),j=wb.indexOf(b,i+a.length);assert.ok(i>0&&j>i,a);return wb.slice(i,j)};
 const native=(text,env={})=>new Function(...Object.keys(env),'return ({'+text+'})')(...Object.values(env));
 // Native storage projection/parse and session InputModel serializer/deserializer.
 const parse=new Function('sk',section('function N4i(s){','function y7t(s)')+';return N4i')({fromExport:x=>x});
 const klass=section('P4i=class{','},sC=class')+'}';
 const Input=new Function('Ah','qt','Utr','eU','N8t','qT','sk','return '+klass.slice(4))(
  (_,v)=>({get:()=>v,set:n=>{v=n}}),()=>false,()=>{},()=>false,()=>false,()=>false,{toExport:x=>x});
 const serializer=new Function('t7','Qp',section('function Tcn(s){','function Rcn(s)')+';return {Tcn,Dcn}')(JSON.stringify,JSON.parse);
 const applySource=section('_applyLocalModelConfiguration(e,t,i=!0){','getModelConfigurationActions(e)');
 const applyEnv={
  fcn:new Function(section('function fcn(', 'var Nli=')+';return fcn')(),iF:'__autoTier',qt:(a,b)=>JSON.stringify(a)===JSON.stringify(b),ezilSessionEffortV1:isolation
 };
 const oldMethods=native(applySource,applyEnv);
 const methods=native(applySource.replace('this.getModelConfiguration(e);let r=fcn(', 'this.getModelConfiguration(e);ezilSessionEffortV1.beforeApply(this,e,t,i);let r=fcn(').replace('let c=i?this._readBucket():void 0;', 'ezilSessionEffortV1.afterApply(this,e,a,r);let c=i?this._readBucket():void 0;'),applyEnv);
 const manualSetter=native(section('async setModelConfiguration(e,t){','_applyLocalModelConfiguration(e,t,i=!0){'));
 const restore=native(section('restoreModelConfiguration(e,t,i=!0){let n=','clear(){this._overrides'),{Ali:x=>({...x}),iF:'__autoTier',xio:()=>false,kio:()=>false});
 const getSource=section('getModelConfiguration(e){let t=this._overrides','async setModelConfiguration');
 const oldGet=native(getSource);
 const get=native(getSource.replace('return Object.keys(t)', 't=ezilSessionEffortV1.get(this,e,t);return Object.keys(t)'),{ezilSessionEffortV1:isolation});
 const resolve=native(section('_resolveConfiguration(e,t,i){','_usesManagedDefault(e)'));
 const syncSource=section('_syncInputStateToModel(){','flushInputStateToModel()');
 const syncEnv={sw:()=>{},queueMicrotask:()=>{},ezilSessionEffortV1:isolation};
 const oldSync=native(syncSource,syncEnv)._syncInputStateToModel;
 const newSync=native(syncSource.replace('this._emptyInputState.set(e,void 0)','this._emptyInputState.set(ezilSessionEffortV1.draft(this,e),void 0)'),syncEnv)._syncInputStateToModel;
 const currentSource=section('getCurrentInputState(){','_getAriaLabel()');
 const current=native(currentSource.replace('return i}', 'return ezilSessionEffortV1.annotate(this,i)}'),{Dt:{empty:()=>[]},ezilSessionEffortV1:isolation}).getCurrentInputState;
 const oldCurrent=native(currentSource,{Dt:{empty:()=>[]}}).getCurrentInputState;
 let shared, bucket={},writes=0;
 function input(key,{patched=true,manual,loaded}={}){
  if(manual!==undefined)bucket={m:{reasoningEffort:manual,other:'manual-field'}};
  const model={identifier:'m',metadata:{name:'synthetic'}};
  const x={_inputModelSessionResource:{toString:()=>key},_currentSessionKey:key,currentLanguageModel:'m',currentModeKind:'agent',_chatSessionIsEmpty:true,
   _inputModel:new Input(loaded,{},key),_currentModeObservable:{get:()=>({id:'agent',kind:'agent'})},_currentLanguageModel:{get:()=>model},
   _modelSelectionController:{selectionReason:'sessionRestore'},_currentPermissionLevel:{get:()=> 'default'},_attachmentModel:{attachments:[{id:'attachment'}]},_inputEditor:{getValue:()=> 'keep text',getSelections:()=>[1]},
   _widget:{contribs:[{getInputState:c=>{c.other={keep:true}}}]},_emptyInputState:{set:s=>{shared=structuredClone(s)}}};
  const store={...(patched?methods:oldMethods),...restore,...(patched?get:oldGet),...resolve,...manualSetter,_overrides:new Map(),_preferences:new Map(),_explicitAutoTiers:new Set(),_sessionAutoTiers:new Set(),
   isEmpty:()=>x._chatSessionIsEmpty,_schemaDefaults:()=>({}),_readBucket:()=>structuredClone(bucket),_writeBucket:b=>{writes++;bucket=b},
   languageModelsService:{lookupLanguageModel:()=>({id:'synthetic'}),getModelConfiguration:()=>undefined,setModelConfiguration:async(id,patch)=>{x.globalPatches.push({id,patch})}},_onDidSelectConfiguration:{fire:()=>x.flushInputStateToModel()},_onDidChange:{fire:()=>x.flushInputStateToModel()}};
  x.globalPatches=[];x.selectModel=id=>{model.identifier=id;x.currentLanguageModel=id;x.flushInputStateToModel()};
  x.languageModelsService={lookupLanguageModel:()=>({vendor:'ezil'})};
  x._modelConfigStore=store;x.getModelConfiguration=id=>store.getModelConfiguration(id);
  x.restoreModelConfiguration=(id,c,p=true)=>store.restoreModelConfiguration(id,c,p);
  x.getCurrentInputState=patched?current:oldCurrent;x.flushInputStateToModel=patched?newSync:oldSync;
  x.serialize=()=>JSON.parse(JSON.stringify(x._inputModel.toJSON()));
  return x;
 }
 // Reproduce pre-fix shared draft pollution despite persist=false, followed by bucket promotion.
 const old=input('old',{patched:false});old.restoreModelConfiguration('m',{reasoningEffort:'low'},false);
 assert.equal(writes,0);assert.equal(shared.modelConfiguration.reasoningEffort,'low');
 const inherited=serializer.Dcn(serializer.Tcn(shared));const next=input('old-next',{patched:false});
 next.restoreModelConfiguration('m',inherited.modelConfiguration);assert.equal(bucket.m.reasoningEffort,'low');assert.equal(writes,1);
 // Fresh synthetic baseline, not clearing any runtime/user storage.
 shared=undefined;bucket={};writes=0;
 const a=input('A');assert.equal(isolation.set(a,'A','m','low'),true);
 assert.equal(shared.modelConfiguration.reasoningEffort,undefined);assert.equal(shared.contrib.ezilSessionEffortV1,undefined);
 assert.equal(shared.inputText,'keep text');assert.deepEqual(shared.attachments,[{id:'attachment'}]);assert.deepEqual(shared.contrib.other,{keep:true});
 assert.equal(shared.permissionLevel,'default');assert.equal(shared.mode.kind,'agent');
 const b=input('B');assert.equal(isolation.set(b,'B','m','high'),true);
 assert.equal(a.getModelConfiguration('m').reasoningEffort,'low');assert.equal(b.getModelConfiguration('m').reasoningEffort,'high');
 const c=input('C');assert.equal(c.getModelConfiguration('m'),undefined);assert.equal(shared.modelConfiguration.reasoningEffort,undefined);
 assert.equal(writes,0);assert.deepEqual(bucket,{});
 // Native export -> JSON -> native import, fresh InputPart/store, correct marked restore is nonpersistent.
 const saved=a.serialize();assert.equal(saved.contrib.ezilSessionEffortV1.resource,'A');
 const loaded=parse(saved);const reopened=input('A',{loaded});
 const prepared=isolation.prepare(reopened,loaded,{toString:()=> 'A'});
 isolation.restore(reopened,prepared.selectedModel.identifier,prepared.modelConfiguration);
 assert.equal(reopened.getModelConfiguration('m').reasoningEffort,'low');assert.equal(writes,0);
 reopened.flushInputStateToModel();assert.equal(reopened.serialize().contrib.ezilSessionEffortV1.resource,'A');assert.equal(shared.modelConfiguration.reasoningEffort,undefined);
 // Shared-draft codec preserves unrelated fields; native draft serializer deliberately excludes attachments.
 const round=serializer.Dcn(serializer.Tcn(shared));assert.deepEqual(round.contrib.other,{keep:true});assert.equal(round.inputText,'keep text');
 // Existing manual preference is restored in shared projection, never deleted or overwritten in bucket.
 const manual=input('manual',{manual:'medium'});const before=structuredClone(bucket);
 assert.equal(isolation.set(manual,'manual','m','low'),true);assert.equal(shared.modelConfiguration.reasoningEffort,'medium');
 assert.equal(isolation.set(manual,'manual','m','high'),true);assert.equal(shared.modelConfiguration.reasoningEffort,'medium');assert.deepEqual(bucket,before);assert.equal(writes,0);
 // Native manual selection changes provenance: tombstone survives InputModel's merging setState.
 await manual._modelConfigStore.setModelConfiguration('m',{reasoningEffort:'manual'});manual.flushInputStateToModel();
 assert.equal(manual.serialize().contrib.ezilSessionEffortV1,undefined);assert.equal(shared.modelConfiguration.reasoningEffort,'manual');writes=0;
 bucket={}; // New synthetic baseline for foreign marker refusal; no runtime state touched.
 for(const key of ['foreign','A']){
  const state=parse(saved);if(key==='A')state.selectedModel.identifier='other-model';
  const target=input(key);const clean=isolation.prepare(target,state,{toString:()=>key});
  assert.equal(clean.contrib.ezilSessionEffortV1,undefined);assert.equal(clean.modelConfiguration.reasoningEffort,undefined);
 }
 // R1: retain all per-model native selections, including through native JSON recreation.
 const multi=input('multi');isolation.set(multi,'multi','m','low');multi.selectModel('n');isolation.set(multi,'multi','n','high');
 multi.selectModel('m');assert.equal(multi.getModelConfiguration('m').reasoningEffort,'low');assert.equal(shared.modelConfiguration.reasoningEffort,undefined);
 assert.equal(multi.serialize().contrib.ezilSessionEffortV1.selections.length,2);
 // Native conversation switching pre-flushes the old bound input before clearing/rebinding.
 multi._currentSessionKey='next-widget';multi.flushInputStateToModel();
 assert.equal(shared.modelConfiguration.reasoningEffort,undefined);assert.equal(multi.serialize().contrib.ezilSessionEffortV1.resource,'multi');
 assert.equal(isolation.set(multi,'multi','m','high'),false,'controls require widget AND bound resource');
 multi._currentSessionKey='multi';
 const multiLoaded=parse(multi.serialize()),multiAgain=input('multi',{loaded:multiLoaded});
 isolation.prepare(multiAgain,multiLoaded,{toString:()=> 'multi'});isolation.restore(multiAgain,'m',multiLoaded.modelConfiguration);
 multiAgain.selectModel('n');assert.equal(multiAgain.getModelConfiguration('n').reasoningEffort,'high');assert.equal(shared.modelConfiguration.reasoningEffort,undefined);
 multiAgain.selectModel('m');assert.equal(multiAgain.getModelConfiguration('m').reasoningEffort,'low');assert.equal(writes,0);
 // R2: no preference may come from a rejected payload's prior, including old v1 payloads.
 const poison=parse(saved);poison.contrib.ezilSessionEffortV1={version:1,resource:'A',model:'m',effort:'low',prior:{present:true,value:'high'}};
 const victim=input('victim'),clean=isolation.prepare(victim,poison,{toString:()=> 'victim'});
 isolation.restore(victim,'m',clean.modelConfiguration);victim.flushInputStateToModel();
 assert.equal(victim.getModelConfiguration('m'),undefined);assert.equal(shared.modelConfiguration?.reasoningEffort,undefined);
 const preferred=input('preferred',{manual:'medium'}),cleanPreferred=isolation.prepare(preferred,poison,{toString:()=> 'preferred'});
 isolation.restore(preferred,'m',cleanPreferred.modelConfiguration);preferred.flushInputStateToModel();
 assert.equal(shared.modelConfiguration.reasoningEffort,'medium');assert.equal(bucket.m.reasoningEffort,'medium');assert.equal(writes,0);
 // R3: actual native manual setter for another key persists that key only; all effort provenance survives.
 bucket={};const other=input('other');isolation.set(other,'other','m','low');
 await other._modelConfigStore.setModelConfiguration('m',{contextSize:2048});
 assert.equal(bucket.m.contextSize,2048);assert.equal(bucket.m.reasoningEffort,undefined);
 assert.equal(other.getModelConfiguration('m').reasoningEffort,'low');assert.equal(shared.modelConfiguration.reasoningEffort,undefined);
 assert.equal(other.serialize().contrib.ezilSessionEffortV1.selections[0].effort,'low');
 assert.deepEqual(other.globalPatches,[{id:'m',patch:{contextSize:2048}}]);
 // Same-value explicit reasoning IS manual intent; unrelated model's selection remains tracked.
 other.selectModel('n');isolation.set(other,'other','n','high');other.selectModel('m');
 await other._modelConfigStore.setModelConfiguration('m',{reasoningEffort:'low'});
 assert.equal(bucket.m.reasoningEffort,'low');assert.equal(shared.modelConfiguration.reasoningEffort,'low');
 assert.deepEqual(other.serialize().contrib.ezilSessionEffortV1.selections,[{model:'n',effort:'high'}]);
 other.selectModel('n');assert.equal(shared.modelConfiguration.reasoningEffort,undefined);writes=0;
 const legacy=input('legacy');isolation.restore(legacy,'m',{reasoningEffort:'low'});
 assert.equal(writes,0,'unmarked EZiL session restore is never a preference write');
 const foreign=input('foreign-vendor');foreign.languageModelsService.lookupLanguageModel=()=>({vendor:'other'});
 isolation.restore(foreign,'m',{reasoningEffort:'high'});assert.equal(writes,1,'other vendor restore behavior unchanged');writes=0;
 const denied=input('denied');assert.equal(isolation.set(denied,'foreign','m','low'),false);
 assert.equal(isolation.set(denied,'denied','other','low'),false);denied.currentModeKind='ask';assert.equal(isolation.set(denied,'denied','m','low'),false);
 assert.equal(denied._inputModel.state.get(),undefined);assert.equal(writes,0);
});

test('native isolation patch anchors bind exactly once and patched workbench parses', {skip:!root&&'COPILOT_TEST_ROOT not set'},()=>{
 const {spawnSync}=require('node:child_process'),os=require('node:os');
 const script=fs.readFileSync(path.join(__dirname,'patch-copilot-chat.sh'),'utf8');
 let source=fs.readFileSync(path.join(root,'out/vs/code/browser/workbench/workbench.js'),'utf8');
 const helper=fs.readFileSync(path.join(__dirname,'session-effort-isolation.js'),'utf8').trimEnd();
 for(const name of ['HELPER','API','DRAFT','STATE','PREPARE','RESTORE','BEFORE','AFTER','GET']){
  const a=script.match(new RegExp("^A_ISOLATION_"+name+"='(.*)'$",'m'))[1];
  const r=name==='HELPER'?'var ezilSessionEffortV1='+helper+';function Tcn(s){':script.match(new RegExp("^R_ISOLATION_"+name+"='(.*)'$",'m'))[1];
  const apply=s=>{assert.equal(s.split(a).length-1,1,'exact '+name);return s.replace(a,r)};
  assert.throws(()=>apply(source.replace(a,'')),name+' missing');
  assert.throws(()=>apply(source+a),name+' duplicate');
  assert.throws(()=>apply(source.replace(a,a.slice(0,-1)+'!')),name+' malformed');
  source=apply(source);
 }
 assert.ok(source.includes('restoreModelConfiguration:(ho,fo)=>ezilSessionEffortV1.restore(this,ho,fo),'));
 assert.ok(source.includes('e=ezilSessionEffortV1.prepare(this,e,t);if(this._isSyncingToOrFromInputModel=!0,'));
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ezil-isolation-syntax-'));
 try{const file=path.join(tmp,'workbench.js');fs.writeFileSync(file,source);
  const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});
