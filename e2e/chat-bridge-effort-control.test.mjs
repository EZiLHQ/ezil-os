import {test} from 'node:test';
import assert from 'node:assert/strict';
import {controllerAllowed,validEnqueue} from './chat-bridge-effort-control.mjs';
import {overlapBarrier} from './chat-bridge-effort-barrier.mjs';
const secret='c'.repeat(64),ops=[{role:'A',kind:'create',status:'applied'}];
const send={role:'sendA',kind:'send',sessionRole:'A',text:'EZIL_NATIVE_A',expectedModel:'native-a',expectedEffort:'low'};
test('control requires its own exact bearer and rejects browser Origin',()=>{
 assert.equal(controllerAllowed({authorization:'Bearer '+secret},secret),true);
 for(const headers of [{},{authorization:'Bearer '+'a'.repeat(64)},{authorization:'Bearer '+secret,origin:'null'},{authorization:'Bearer '+secret,origin:'http://127.0.0.1'}])assert.equal(controllerAllowed(headers,secret),false);
});
test('enqueue cannot forge status ids response or dispatch settings',()=>{
 assert.equal(validEnqueue(send,ops),true);
 for(const extra of [{status:'completed'},{id:'forged'},{responseText:'fake'},{effort:'high'},{model:'native-b'},{attemptId:'fake'}])assert.equal(validEnqueue({...send,...extra},ops),false);
 assert.equal(validEnqueue(send,[...ops,{...send}]),false);
 assert.equal(validEnqueue({...send,sessionRole:'unknown'},ops),false);
 assert.equal(validEnqueue({...send,text:'EZIL_NATIVE_A EZIL_NATIVE_B'},ops),false);
});
test('barrier waits for two distinct in-flight resources',async()=>{
 const hold=overlapBarrier(100);let released=false;
 const a=hold('g','a').then(x=>{released=true;return x;});await Promise.resolve();assert.equal(released,false);
 const b=hold('g','b');assert.deepEqual(await Promise.all([a,b]),[true,true]);
 assert.equal(await hold('g','a'),false);
});
test('sequential or same-resource requests never qualify as overlap',async()=>{
 const hold=overlapBarrier(5),a=hold('g','a');assert.equal(await hold('g','a'),false);assert.equal(await a,false);assert.equal(await hold('g','b'),false);
});

import {captureEvidence} from './chat-bridge-effort-evidence.mjs';
test('failed final fetch writes failing receipt and returns failure',async()=>{
 const results=[],writes=[];
 assert.equal(await captureEvidence('/unused',results,async()=>{throw Error('offline');},(p,s)=>writes.push([p,s])),false);
 assert.equal(results.at(-1).ok,false);assert.equal(writes.length,1);assert.match(writes[0][0],/results.json$/);
});
test('failed final state write cannot produce success',async()=>{
 const results=[];assert.equal(await captureEvidence('/unused',results,async()=>({ok:true}),(p)=>{if(p.endsWith('fixture-state.json'))throw Error('disk');}),false);
 assert.equal(results.at(-1).ok,false);
 await assert.rejects(captureEvidence('/unused',[],async()=>({}),()=>{throw Error('disk');}));
});
