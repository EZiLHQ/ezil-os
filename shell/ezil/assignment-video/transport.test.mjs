import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./transport.js', import.meta.url),'utf8');
const {createAssignmentVideoTransport} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value:webcrypto});
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
  const t=createAssignmentVideoTransport({attemptId,consentVersion:1,fetcher,onStop:r=>stops.push(r)});
  return {t,calls,stops};
}
test('checks fresh signed upload, sends real bytes, waits for authoritative confirmation and stops on Attach',async()=>{
  const {t,calls,stops}=fixture({status:{recordingId,status:'recording',revoked:true,stopReason:'attached'}});
  try {
    await t.begin();assert.match((await t.upload(part)).recordingId,/0002$/);
    assert.equal(calls.find(x=>x.kind==='prepare').body.sha256,sha);
    assert.ok(calls.every(x=>x.kind==='put'||x.options.headers['X-Ezil-Assignment-Video']==='1'));
    const put=calls.find(x=>x.kind==='put');
    assert.equal(put.options.credentials,'omit');assert.equal(put.options.redirect,'error');
    assert.deepEqual(Buffer.from(await put.options.body.arrayBuffer()),media);
    await t.status();assert.deepEqual(stops,['attached']);
    await t.finalize({reason:'attached',expectedSegments:1});
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
