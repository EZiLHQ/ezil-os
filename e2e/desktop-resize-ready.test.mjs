import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import vm from 'node:vm';
import {observeScreenResizes, readDesktopReadiness, waitForDesktopResize} from './desktop-resize-ready.mjs';

const app = 'https://app.example';
const want = {computerId:'desktop-1', width:1440, height:857};
function fixture(t) {
  const page = new EventEmitter();
  const observer = observeScreenResizes(page, app);
  t.after(() => observer.dispose());
  const request = (patch = {}, url = `${app}/api/shell/screen`) => {
    const req = {url:()=>url, method:()=> 'POST', postDataJSON:()=>({...want, ...patch})};
    page.emit('request', req);
    return req;
  };
  const respond = (req, body = {ok:true,width:1440,height:856}, ok = true) => {
    page.emit('response', {request:()=>req, json:async()=>body, ok:()=>ok});
  };
  return {page, observer, request, respond};
}

test('browser measurement uses the full-bleed body in device pixels and reads the actual child video', async () => {
  for (const [width,height,dpr] of [[1440,857,1], [390,801,3]]) {
    let disposed = false;
    const video = {videoWidth:1440,videoHeight:856,paused:false,readyState:2};
    const body = {clientWidth:width,clientHeight:height};
    const win = {classList:{contains:()=>true},querySelector:()=>body,getAttribute:()=>want.computerId};
    const page = {
      evaluate:fn=>vm.runInNewContext(`(${fn})()`, {document:{querySelector:()=>win},window:{devicePixelRatio:dpr,innerHeight:900}}),
      $:async()=>({dispose:async()=>{disposed=true;},contentFrame:async()=>({
        evaluate:async fn=>vm.runInNewContext(`(${fn})()`, {document:{querySelector:()=>video}}),
      })}),
    };
    const result = JSON.parse(JSON.stringify(await readDesktopReadiness(page)));
    assert.deepEqual(result, {want:{computerId:want.computerId,width:width*dpr,height:height*dpr},video:{width:1440,height:856,playing:true}});
    assert.equal(disposed,true);
    win.classList.contains = () => false;
    assert.equal((await readDesktopReadiness(page)).want,null);
  }
});

test('readiness waits for the full-bleed resize and decoded dimensions, including responses before waiting', async t => {
  const {page, observer, request, respond} = fixture(t);
  const boot = request({height:900});
  respond(boot, {ok:true,width:1440,height:900});
  const resize = request();
  let video = {width:1440,height:900,playing:true}, done = false;
  const ready = waitForDesktopResize(page, observer, {timeoutMs:500,pollMs:1,read:async()=>({want,video})})
    .then(value => { done = true; return value; });
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(done,false, 'boot stream cannot satisfy the full-bleed resize');
  respond(resize);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(done,false, 'HTTP success alone is not decoded resize readiness');
  video = {width:1440,height:856,playing:true};
  assert.match(await ready, /applied=1440x856 video=1440x856/);
  assert.match(await waitForDesktopResize(page,observer,{timeoutMs:100,read:async()=>({want,video})}), /applied=1440x856/);
});

test('a completed resize to the wrong aspect still reaches the unchanged geometry assertions', async t => {
  const {page,observer,request,respond} = fixture(t);
  respond(request(), {ok:true,width:1440,height:900});
  await Promise.resolve();
  await waitForDesktopResize(page,observer,{timeoutMs:100,read:async()=>({want,video:{width:1440,height:900,playing:true}})});
  // The incident's boot aspect still wastes 4.8%. Readiness never polls that
  // quality threshold, so a completed but wrong mode remains a real failure.
  const frameWidth = Math.round(857 * 1440 / 900);
  assert.ok(100 * (1 - frameWidth / 1440) > 3);
});

test('resize failures fail immediately without sending or retrying any request', async t => {
  for (const body of [{ok:false,error:{code:'TIMEOUT'}}, {ok:false,error:{code:'UNSUPPORTED'}}, {ok:true,width:0,height:856}]) {
    const {page,observer,request,respond} = fixture(t);
    respond(request(),body);
    await Promise.resolve();
    await assert.rejects(waitForDesktopResize(page,observer,{timeoutMs:100,read:async()=>({want})}), /Desktop resize failed/);
  }
  const {page,observer,request} = fixture(t);
  page.emit('requestfailed',request());
  await assert.rejects(waitForDesktopResize(page,observer,{timeoutMs:100,read:async()=>({want})}), /Desktop resize failed/);
});

test('missing, stale, unrelated, paused and hung observations have a bounded failure', async t => {
  const {page,observer,request,respond} = fixture(t);
  respond(request({computerId:'another-desktop'}));
  respond(request({height:900}));
  respond(request({},'https://unrelated.example/api/shell/screen'));
  await Promise.resolve();
  const video = {width:1440,height:856,playing:true};
  await assert.rejects(waitForDesktopResize(page,observer,{timeoutMs:20,pollMs:1,read:async()=>({want,video})}), /resize=missing/);
  respond(request());
  await Promise.resolve();
  await assert.rejects(waitForDesktopResize(page,observer,{timeoutMs:20,pollMs:1,read:async()=>({want,video:{...video,playing:false}})}), /timed out/);
  await assert.rejects(waitForDesktopResize(page,observer,{timeoutMs:20,read:()=>new Promise(()=>{})}), /timed out/);
  await assert.rejects(waitForDesktopResize(page,observer,{timeoutMs:20,pollMs:1,read:async()=>({want:null,video})}), /not full-bleed/);
  observer.dispose();
  for (const event of ['request','response','requestfailed']) assert.equal(page.listenerCount(event),0);
});
