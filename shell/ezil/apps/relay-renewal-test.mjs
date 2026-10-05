import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayRenewal } from './relay-renewal.js';
function fixture(refresh) {
  let clock=100000, queue=[]; const states=[];
  const loop=createRelayRenewal({state:{runtimeId:'runtime',expiresAt:clock+300000},refresh,onState:s=>states.push(s),
    now:()=>clock,schedule:(fn,ms)=>{const timer={fn,ms};queue.push(timer);return timer;},cancel:t=>{queue=queue.filter(x=>x!==t);}});
  return {loop,states,get queue(){return queue;},advance:ms=>{clock+=ms;}};
}
test('renews60 seconds before expiry and serializes concurrent reconnects', async()=>{
  let finish,count=0;
  const f=fixture(()=>{count++;return new Promise(r=>finish=r);});
  assert.equal(f.queue[0].ms,240000);
  const a=f.loop.reconnect(),b=f.loop.reconnect(); assert.equal(a,b);
  await Promise.resolve();assert.equal(count,1);
  finish({ok:true,runtimeId:'runtime',expiresAt:700000});await new Promise(setImmediate);
  assert.equal(f.states.at(-1),'confirming'); f.loop.viewerLive(); await a;
  assert.deepEqual(f.states,['reconnecting','confirming','connected']);assert.equal(f.queue[0].ms,540000);
  f.loop.stop();assert.equal(f.queue.length,0);
});
test('sleep return renews expired credentials without extending their lifetime',async()=>{
  let count=0; const f=fixture(async()=>{count++;return {ok:true,runtimeId:'runtime',expiresAt:900000};});
  f.advance(350000);const pending=f.loop.resume();await new Promise(setImmediate);f.loop.viewerLive();await pending;assert.equal(count,1);assert.equal(f.states.at(-1),'connected');f.loop.stop();
});
test('stale runtime and unavailable TURN end in bounded actionable failure',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return {ok:true,runtimeId:'other',expiresAt:700000};});
  await f.loop.reconnect();await f.queue[0].fn();await f.queue[0].fn();
  assert.equal(calls,3);assert.equal(f.states.at(-1),'error');assert.equal(f.queue.length,0);
});
test('disposed viewer cannot publish a delayed refresh result',async()=>{
  let finish;const f=fixture(()=>new Promise(r=>finish=r));const a=f.loop.reconnect();await Promise.resolve();
  f.loop.stop();finish({ok:true,runtimeId:'runtime',expiresAt:700000});await a;
  assert.deepEqual(f.states,['reconnecting']);assert.equal(f.queue.length,0);
});
test('API success without resumed frames cannot report connected',async()=>{
  const f=fixture(async()=>({ok:true,runtimeId:'runtime',expiresAt:700000}));
  const pending=f.loop.reconnect();await new Promise(setImmediate);
  assert.equal(f.states.at(-1),'confirming');
  f.queue[0].fn();await pending;
  assert.equal(f.states.includes('connected'),false);assert.equal(f.states.at(-1),'reconnecting');f.loop.stop();
});
