import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./project-launch.js',import.meta.url),'utf8');
const {documentLaunchIntent}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function tab(id) {const store=new Map([['ezil.project-launch.pending',id]]);return {sessionStorage:{getItem:k=>store.get(k),removeItem:k=>store.delete(k),setItem:(k,v)=>store.set(k,v)},history:{state:null,replaceState(value){this.state=value}}};}
const a='a'.repeat(43),b='b'.repeat(43);const tabA=tab(a),tabB=tab(b);
assert.equal(documentLaunchIntent(tabA),a);assert.equal(documentLaunchIntent(tabB),b);
assert.equal(documentLaunchIntent(tabA),a,'old A refresh retains A after tab B launches');
const oldState=tabA.history.state;tabA.history.state=null;tabA.sessionStorage.setItem('ezil.project-launch.pending',b);
assert.equal(documentLaunchIntent(tabA),b);tabA.history.state=oldState;
assert.equal(documentLaunchIntent(tabA),a,'back/refresh uses immutable history entry, never latest sessionStorage');
tabA.history.state={ezilProjectLaunchIntent:'invalid'};tabA.sessionStorage.setItem('ezil.project-launch.pending',b);
assert.equal(documentLaunchIntent(tabA),undefined,'invalid document state never falls back to newer intent');
assert.equal(documentLaunchIntent(tab(undefined)),undefined,'missing intent fails closed');
console.log('PASS per-tab launch correlation, overlapping launches and old history refresh');
