import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAssignmentVideoTransport} from './transport.js';

const attemptId = '00000000-0000-4000-8000-000000000001';
const captureSessionId = '00000000-0000-4000-8000-000000000002';
const recordingId = '00000000-0000-4000-8000-000000000003';
const repoOpenProof = 'fixture'.repeat(16);
const now = Date.parse('2026-11-26T00:00:00Z');
const hour = 3600000;
const iso = timestamp => new Date(timestamp).toISOString();

function fixture({policy=true, phaseReady=true}={}) {
    const calls = [];
    const work = {startedAt:iso(now+2800),deadlineAt:iso(now+2800+hour),serverNow:iso(now+3000)};
    const media = {status:phaseReady ? 'recording' : 'awaiting_frame',recordingId,captureSessionId,nextSequence:1,phaseReady,
        startedAt:iso(now),deadlineAt:iso(now+hour+(policy ? 240000 : 0)),serverNow:iso(now+3000),
        authorizationExpiresAt:iso(now+480000)};
    const transport = createAssignmentVideoTransport({attemptId,captureSessionId,repoOpenProof,consentVersion:4,
        clock:()=>now+3000,fetcher:async (_url,init)=>{
            const body = JSON.parse(init.body);
            calls.push(body);
            if (body.action==='preflight') return Response.json({status:'eligible',attemptId,expiresAt:iso(now+60000),
                ...(policy ? {editorReadySupported:true} : {})});
            if (body.action==='begin' || body.action==='status') return Response.json(media);
            if (body.action==='editor-ready') return Response.json(work);
            assert.fail('Unexpected media API call: '+body.action);
        }});
    return {transport, calls, work, media};
}

test('editor readiness sends only exact phase plus checkout proof and returns a separate work clock',async t=>{
    const h=fixture();
    t.after(()=>h.transport.dispose());
    await assert.rejects(h.transport.editorReady(),{code:'recording_unavailable'});
    assert.equal(h.calls.length,0);
    await h.transport.begin();
    assert.deepEqual(await h.transport.editorReady(),h.work);
    assert.deepEqual(h.calls.at(-1),{action:'editor-ready',attemptId,captureSessionId,repoOpenProof});
    assert.notEqual(h.work.startedAt,h.media.startedAt);
    h.work.deadlineAt = iso(now+hour+500000);
    await assert.rejects(h.transport.editorReady(),{code:'media_unavailable'});
});

test('an old or unconfirmed transport never sends editor readiness',async t=>{
    for (const h of [fixture({policy:false}),fixture({phaseReady:false})]) {
        t.after(()=>h.transport.dispose());
        await h.transport.begin();
        await assert.rejects(h.transport.editorReady(),{code:'recording_unavailable'});
        assert.equal(h.calls.some(body=>body.action==='editor-ready'),false);
    }
});

test('prep media cutoff can move in either direction only with the immutable media anchor',async t=>{
    const h=fixture();
    t.after(()=>h.transport.dispose());
    await h.transport.begin();
    h.media.deadlineAt = iso(now+hour+5000);
    assert.equal((await h.transport.status()).deadlineAt,h.media.deadlineAt);
    h.media.deadlineAt = iso(now+hour+240000);
    assert.equal((await h.transport.status()).deadlineAt,h.media.deadlineAt);
    h.media.startedAt = iso(now+1000);
    await assert.rejects(h.transport.status(),{code:'recording_changed'});
    h.media.startedAt = iso(now);
    h.media.deadlineAt = iso(now+hour+240001);
    await assert.rejects(h.transport.status(),{code:'recording_changed'});
});
