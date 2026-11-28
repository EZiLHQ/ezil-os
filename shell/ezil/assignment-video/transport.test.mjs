import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./transport.js', import.meta.url),'utf8');
const {createAssignmentVideoTransport} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value:webcrypto});
Object.defineProperty(globalThis,'location',{configurable:true,value:new URL('https://os-staging.ezil.work')});
const attemptId='00000000-0000-4000-8000-000000000001', recordingId='00000000-0000-4000-8000-000000000002';
const media=Buffer.from('synthetic bounded test segment');
const sha=createHash('sha256').update(media).digest('hex');
const url='https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com/universe-staging/assignment-media/v1/test-owner/'+attemptId+'/'+recordingId+'/segments/0/'+sha+'.webm?test';
const part={sequence:0,startMs:0,endMs:1000,mimeType:'video/webm',bytes:media};
function fixture(replace={}) {
  const calls=[], stops=[];
  const normal={recordingId,status:'recording',startedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+60000).toISOString()};
  const fetcher=async(path,options)=>{
    if(options.method==='PUT'){calls.push({kind:'put',path,options});return new Response(null,{status:replace.put??200});}
    const body=JSON.parse(options.body);calls.push({kind:body.action,path,options,body});
    const responses={preflight:{status:'eligible',attemptId,jobId:'9',expiresAt:normal.deadlineAt},begin:normal,status:normal,prepare:{putUrl:url,headers:{'content-type':'video/webm'}},
      confirm:{confirmed:true,recordingId,sequence:0},finalize:{...normal,status:'complete'},...replace};
    return Response.json(responses[body.action]);
  };
  const t=createAssignmentVideoTransport({attemptId,repoOpenProof:"p".repeat(100),consentVersion:1,fetcher,onStop:(reason,stamp)=>stops.push([reason,stamp])});
  return {t,calls,stops};
}
test('checks fresh signed upload, sends real bytes, waits for authoritative confirmation and stops on successful submission',async()=>{
  const cutoff = new Date().toISOString();
  const {t,calls,stops}=fixture({status:{recordingId,status:'recording',revoked:false,stopReason:'submitted',stopRequestedAt:cutoff}});
  try {
    await t.begin();assert.match((await t.upload(part)).recordingId,/0002$/);
    assert.equal(calls.find(x=>x.kind==='prepare').body.sha256,sha);
    assert.ok(calls.every(x=>x.kind==='put'||x.options.headers['X-Ezil-Assignment-Video']==='1'));
    const put=calls.find(x=>x.kind==='put');
    assert.equal(put.options.credentials,'omit');assert.equal(put.options.redirect,'error');
    assert.deepEqual(Buffer.from(await put.options.body.arrayBuffer()),media);
    await t.status();assert.deepEqual(stops,[['submitted',cutoff]]);
    await t.finalize({reason:'submitted',expectedSegments:1});
    assert.deepEqual(calls.map(x=>x.kind),['preflight','begin','prepare','put','confirm','status','finalize']);
  } finally { t.dispose(); }
});
test('an already-written conditional PUT is accepted only after real confirmation',async()=>{
  const {t}=fixture({put:412,confirm:{confirmed:false,recordingId,sequence:0}});
  try {await t.begin();await assert.rejects(t.upload(part),/upload_unconfirmed/);} finally {t.dispose();}
});
test('refuses a foreign domain before transmitting any bytes',async()=>{
  const {t,calls}=fixture({prepare:{putUrl:url.replace('.amazonaws.com','.example.test'),headers:{}}});
  try {await t.begin();await assert.rejects(t.upload(part),/invalid_upload_target/);assert.ok(!calls.some(x=>x.kind==='put'));}
  finally{t.dispose();}
});

test('version four provisional phase has no countdown, checkpoints without finalizing, and carries the exact capture scope',async()=>{
    const phase='00000000-0000-4000-8000-000000000009',calls=[];
    const deadline=new Date(Date.now()+50000).toISOString(), start=new Date().toISOString();
    const base={recordingId,captureSessionId:phase,revoked:false,stopRequestedAt:null};
    const fetcher=async(_url,options)=>{
        const body=JSON.parse(options.body);calls.push(body);
        if(body.action==='preflight')return Response.json({attemptId,status:'eligible',expiresAt:deadline,windowStartedAt:null,deadlineAt:null});
        if(body.action==='begin')return Response.json({...base,status:'awaiting_frame',startedAt:null,deadlineAt:null,authorizationExpiresAt:deadline,nextSequence:17});
        if(body.action==='checkpoint')return Response.json({...base,status:'paused',startedAt:start,deadlineAt:deadline});
        return Response.json({...base,status:'awaiting_frame',startedAt:null,deadlineAt:null});
    };
    const t=createAssignmentVideoTransport({attemptId,repoOpenProof:'p'.repeat(80),consentVersion:4,captureSessionId:phase,fetcher});
    try {
        const initial=await t.begin();assert.equal(initial.startedAt,null);assert.equal(initial.nextSequence,17);
        await t.status();await t.checkpoint('sharing_stopped');
        assert.equal(calls.find(c=>c.action==='begin').consentVersion,4);
        assert.ok(calls.filter(c=>c.action!=='preflight').every(c=>c.captureSessionId===phase));
        assert.deepEqual(calls.map(c=>c.action),['preflight','begin','status','checkpoint']);
    }finally{t.dispose();}
});
test('a begin whose phase stopped during its preflight sends no begin; one already sent is always read',async()=>{
  const stopped=new AbortController();
  const before=fixture();
  stopped.abort();
  await assert.rejects(before.t.begin({signal:stopped.signal}),{code:'cancelled'});
  assert.deepEqual(before.calls.map(x=>x.kind),['preflight']);
  await assert.rejects(before.t.checkpoint('connection_lost'),{code:'recording_unavailable'});
  before.t.dispose();
  // Stopped only after the begin left: its grant is still returned to the caller that must close it.
  const during=new AbortController(),session='00000000-0000-4000-8000-000000000003',calls=[];
  const t=createAssignmentVideoTransport({attemptId,repoOpenProof:'p'.repeat(100),consentVersion:4,captureSessionId:session,onStop(){},fetcher:async(_path,options)=>{
    const body=JSON.parse(options.body);calls.push(body.action);
    if(body.action==='preflight')return Response.json({status:'eligible',attemptId,expiresAt:new Date(Date.now()+60000).toISOString()});
    if(body.action==='begin')during.abort();
    return Response.json({recordingId,captureSessionId:session,status:body.action==='begin'?'awaiting_frame':'paused',nextSequence:0,
      authorizationExpiresAt:new Date(Date.now()+60000).toISOString()});
  }});
  try{
    assert.equal((await t.begin({signal:during.signal})).status,'awaiting_frame');
    await t.checkpoint('connection_lost');
    assert.deepEqual(calls,['preflight','begin','checkpoint']);
  }finally{t.dispose();}
});
