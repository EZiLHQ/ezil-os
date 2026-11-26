import { assignmentMarker } from '@/server/git/assignment-bootstrap';
import { expectedRepositoryURL } from '@/server/git/assignment-enrollment';
import { makeChallenge, readOpen, sealOpen, signRepoOpen } from './repo-open';
import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordingAction } from './broker';
import { checkedPut, creatorUnlinked, drain, hour, issuer, objectOrigin, requestSchema, type Prepare } from './contract';

const attempt = '00000000-0000-4000-8000-000000000001';
const recording = '00000000-0000-4000-8000-000000000002';
const initial = Date.parse('2026-11-22T19:00:00.000Z');
const identity = {userId:'qa-os', issuer, subject:'auth0|fixture', token:'qa.retained.token', sessionId:'session-one', expiresAt:initial+2*hour};
const cap = 'test_recording_capability_123456789';
const time = (t: number) => new Date(t).toISOString();
const bytes = Buffer.from('synthetic bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const owner = createHash('sha256').update(issuer).update('\0').update(identity.subject).digest('hex');
const input: Prepare = {action:'prepare', attemptId:attempt, sequence:0, startMs:2000, endMs:5000,
    sha256:hash, byteLength:bytes.length, mimeType:'video/webm'};
const testSigner = 'fixture-only-independent-signing-key'.repeat(2);
const repo = expectedRepositoryURL(identity.subject, 'a-' + attempt);
const eligibility = {status:'eligible' as const, attemptId:attempt, jobId:'9', expiresAt:time(initial+60000),
    repositoryUrl:repo, providerId:'provider123', ref:'refs/heads/main' as const,
    manifestSha256:makeChallenge(attempt,repo).manifestSha256, windowStartedAt:time(initial), deadlineAt:time(initial+hour)};
const witness = sealOpen(identity,eligibility,'qa-computer','qa-workspace',recording,initial+1000,testSigner);
const begin = {repoOpenProof:witness.proof, action:'begin' as const, attemptId:attempt, consentAccepted:true as const, consentVersion:1};
const state = {recordingId:recording,status:'recording',startedAt:time(initial),deadlineAt:time(initial+hour),
    stopRequestedAt:null,revoked:false};
const signed = {putUrl:objectOrigin+'/universe-staging/assignment-media/v1/'+owner+'/'+attempt+'/'+recording+'/segments/0/'+hash+
    '.webm?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=60&X-Amz-SignedHeaders='+
    'content-length%3Bcontent-type%3Bhost%3Bif-none-match%3Bx-amz-checksum-sha256%3Bx-amz-server-side-encryption'+
    '&X-Amz-Signature='+'a'.repeat(64),expiresAt:time(initial+65000),
    headers:{'content-type':'video/webm','if-none-match':'*','x-amz-server-side-encryption':'AES256',
        'x-amz-checksum-sha256':Buffer.from(hash,'hex').toString('base64')}};
let clock = initial+5000;
let remoteState: Record<string,unknown>;
const calls: {url:string; init?:RequestInit}[]=[];
const fetcher: typeof fetch = async (url,init) => {
    calls.push({url:String(url),init});
    const path = new URL(String(url)).pathname;
    const res = path.endsWith('/begin') ? {...remoteState,uploadToken:cap} : path.endsWith('/status') ? remoteState :
        path.endsWith('/segments') ? signed : path.endsWith('/confirm') ? {recordingId:recording,sequence:0,confirmed:true} :
        {...remoteState,status:'partial'};
    return Response.json(res);
};
const deps = () => ({leases:new Map(),fetcher,clock:()=>clock});
vi.mock('server-only',()=>({}));
beforeEach(()=>{vi.stubEnv('UNIVERSE_ASSIGNMENT_REPO_OPEN_SECRET',testSigner);clock=initial+5000;remoteState={...state};calls.length=0;});

describe('assignment media broker',()=>{
    it('signs the editor-ready phase and receipt without accepting a browser clock',async()=>{
        const phase = '00000000-0000-4000-8000-000000000008';
        const request = {action:'editor-ready' as const,attemptId:attempt,captureSessionId:phase,repoOpenProof:witness.proof};
        const anchor = time(initial);
        const workClock = {startedAt:time(clock),deadlineAt:time(clock+hour),serverNow:time(clock+20)};
        remoteState = {...state,captureSessionId:phase,nextSequence:1,phaseReady:true,workspaceUnlocked:true,editorReadySupported:true};
        const sent: {url:string; init?:RequestInit}[] = [];
        const d = {...deps(),fetcher:async (url:URL|Request|string,init?:RequestInit)=>{
            sent.push({url:String(url),init});
            return Response.json(String(url).endsWith('/editor-ready') ? workClock : {...remoteState, uploadToken:cap});
        }};
        await expect(recordingAction(identity,request,d)).rejects.toMatchObject({code:'recording_phase_changed'});
        expect(sent).toHaveLength(0);
        await recordingAction(identity,{...begin,captureSessionId:phase,consentVersion:4},d);
        await expect(recordingAction(identity,request,d)).resolves.toEqual(workClock);
        expect(sent).toHaveLength(2);
        const path = '/internal/assignment-video/editor-ready';
        expect(new URL(sent[1].url).pathname).toBe(path);
        const exact = sent[1].init?.body as string;
        expect(JSON.parse(exact)).toEqual({
            userIdToken:identity.token,attemptId:attempt,osSessionId:identity.sessionId,captureSessionId:phase,
            repoOpen:readOpen(witness.proof,identity,attempt,clock,testSigner),
        });
        const headers = new Headers(sent[1].init?.headers);
        const stamp = headers.get('X-Ezil-Repo-Open-Timestamp');
        expect(headers.get('X-Ezil-Repo-Open-Signature')).toBe(createHmac('sha256',testSigner)
            .update(stamp+'.POST '+path+'.'+exact).digest('hex'));
        expect(requestSchema.safeParse({...request,startedAt:anchor}).success).toBe(false);
        expect(requestSchema.safeParse({...request,captureSessionId:undefined}).success).toBe(false);
        await expect(recordingAction(identity,{...request,repoOpenProof:'x'.repeat(75)},d))
            .rejects.toMatchObject({code:'assignment_open_required'});
        expect(sent).toHaveLength(2);
    });
    it('updates only a bounded trusted media cutoff while retaining its original anchor',async()=>{
        const phase = '00000000-0000-4000-8000-000000000008';
        remoteState = {...state,captureSessionId:phase,nextSequence:1,phaseReady:true,workspaceUnlocked:true,
            editorReadySupported:true,deadlineAt:time(initial+hour+240000)};
        const d = deps();
        await recordingAction(identity,{...begin,captureSessionId:phase,consentVersion:4},d);
        const status = {action:'status' as const,attemptId:attempt,captureSessionId:phase};
        remoteState.deadlineAt = time(initial+hour+60000);
        await expect(recordingAction(identity,status,d)).resolves.toMatchObject({deadlineAt:remoteState.deadlineAt,startedAt:state.startedAt});
        remoteState.deadlineAt = time(initial+hour+240000);
        await expect(recordingAction(identity,status,d)).resolves.toMatchObject({deadlineAt:remoteState.deadlineAt});
        remoteState.startedAt = time(initial+1000);
        await expect(recordingAction(identity,status,d)).rejects.toMatchObject({code:'media_unavailable'});
        remoteState.startedAt = state.startedAt;
        remoteState.deadlineAt = time(initial+hour+240001);
        await expect(recordingAction(identity,status,d)).rejects.toMatchObject({code:'media_unavailable'});
        remoteState.editorReadySupported = undefined;
        await expect(recordingAction(identity,{...begin,captureSessionId:phase,consentVersion:4},deps()))
            .rejects.toMatchObject({code:'recording_closed'});
    });

    it('carries only an exact creator-link refusal from the verified Universe preflight',async()=>{
        const preflight = {action:'preflight' as const,attemptId:attempt};
        const reply = (payload:unknown,status=409) => ({...deps(),fetcher:async()=>Response.json(payload,{status})});
        await expect(recordingAction(identity,preflight,reply({error:creatorUnlinked})))
            .rejects.toMatchObject({code:creatorUnlinked,status:409});
        for (const response of [
            reply({error:'private_provider_reason'}),
            reply({error:creatorUnlinked,identity:'private'}),
            reply({error:creatorUnlinked.repeat(60)}),
            {...deps(),fetcher:async()=>new Response(JSON.stringify({error:creatorUnlinked}),{status:409})},
            {...deps(),fetcher:async()=>new Response('{broken',{status:409,headers:{'content-type':'application/json'}})},
        ]) {
            await expect(recordingAction(identity,preflight,response)).rejects.toMatchObject({code:'recording_refused',status:409});
        }
        await expect(recordingAction(identity,begin,reply({error:creatorUnlinked})))
            .rejects.toMatchObject({code:'recording_refused',status:409});
        await expect(recordingAction(identity,preflight,reply({error:creatorUnlinked},404)))
            .rejects.toMatchObject({code:'recording_unavailable',status:404});
    });
    it('requires a real retained session and strict inputs before a capability is usable',async()=>{
        expect(requestSchema.safeParse({...begin,creatorSub:'not trusted'}).success).toBe(false);
        expect(requestSchema.safeParse({...begin,consentAccepted:false}).success).toBe(false);
        expect(requestSchema.safeParse({...input,sequence:600}).success).toBe(false);
        await expect(recordingAction({...identity,issuer:'https://other.example/'},begin,deps())).rejects.toMatchObject({status:401});
        expect(calls).toHaveLength(0);
    });
    it('refuses cross-attempt/session, expired, missing-key or modified receipts before any service call',async()=>{
        const d=deps();
        for(const [actor,request] of [[{...identity,sessionId:'another'},begin],[identity,{...begin,attemptId:recording}],
            [identity,{...begin,repoOpenProof:witness.proof.slice(0,27)+'a'.repeat(20)+witness.proof.slice(47)}]] as const){
            await expect(recordingAction(actor,request,d)).rejects.toMatchObject({code:'assignment_open_required'});
        }
        clock+=301000;
        await expect(recordingAction(identity,begin,d)).rejects.toMatchObject({code:'assignment_open_required'});
        vi.stubEnv('UNIVERSE_ASSIGNMENT_REPO_OPEN_SECRET',undefined);
        await expect(recordingAction(identity,begin,d)).rejects.toMatchObject({code:'assignment_open_unavailable'});
        expect(calls).toHaveLength(0);
    });
    it('holds the capability in server memory and exchanges only an exact verified object',async()=>{
        const d=deps(), returned=await recordingAction(identity,begin,d);
        expect(returned).toEqual(state);
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({attemptId:attempt,osSessionId:identity.sessionId,
            userIdToken:identity.token,consentAccepted:true,consentVersion:1,
            repoOpen:readOpen(witness.proof,identity,attempt,clock,testSigner)});
        expect(calls[0].init?.headers).toMatchObject(signRepoOpen(testSigner,'begin',String(calls[0].init?.body),clock));
        expect(calls[0].url).toBe('https://universe-staging.ezil.work/internal/assignment-video/begin');
        expect(await recordingAction(identity,input,d)).toEqual(signed);
        expect(calls.at(-2)?.url).toBe('https://universe-staging.ezil.work/internal/assignment-video/status');
        expect(calls.at(-1)?.url).toBe('https://api-staging.ezil.work/universe/assignment-media/segments');
        expect(calls.at(-1)?.init?.headers).toMatchObject({authorization:'Bearer '+cap});
        expect(String(calls.at(-1)?.init?.body)).not.toContain(identity.token);
        expect(await recordingAction(identity,{action:'confirm',attemptId:attempt,sequence:0},d))
            .toEqual({recordingId:recording,sequence:0,confirmed:true});
        await recordingAction(identity,{action:'finalize',attemptId:attempt,expectedSegments:1,reason:'submitted'},d);
        expect(JSON.parse(String(calls.at(-1)?.init?.body))).toMatchObject({reason:'submitted',expectedSegments:1,osSessionId:identity.sessionId});
        expect(d.leases.size).toBe(0);
    });
    it.each([false,true])('starts or resumes a phase only with an actual bounded seed and immutable accepted frame (resume=%s)',async resume=>{
        const session='00000000-0000-4000-8000-000000000099';
        const awaiting={...state,status:resume ? 'recording' : 'awaiting_frame',phaseReady:false,workspaceUnlocked:false,
            captureSessionId:session,nextSequence:0,authorizationExpiresAt:time(clock+60000),
            startedAt:resume ? time(initial):null,deadlineAt:resume ? time(initial+hour):null};
        let receipt:Record<string,unknown>={...state,recordingId:recording,captureSessionId:session,
            phaseReady:true,firstFrameAt:time(initial),nextSequence:1,confirmed:true,sequence:0};
        const d={...deps(),fetcher:async (url:RequestInfo | URL,init?:RequestInit) => {
            if (String(url).endsWith('/confirm')) return Response.json(receipt);
            return fetcher(url,init);
        }};
        remoteState={...awaiting};
        const prepared=await recordingAction(identity,{...begin,captureSessionId:session},d);
        expect(prepared).toEqual(awaiting);
        expect(prepared.uploadToken).toBeUndefined();
        const seed={...input,captureSessionId:session,startMs:0,endMs:1};
        for (const bad of [{...seed,sequence:1},{...seed,endMs:12},{...seed,byteLength:1024*1024+1}])
            await expect(recordingAction(identity,bad,d)).rejects.toMatchObject({status:409});
        expect(await recordingAction(identity,seed,d)).toEqual(signed);
        const confirm={action:'confirm' as const,attemptId:attempt,captureSessionId:session,sequence:0};
        const valid=receipt;
        receipt={...valid,firstFrameAt:null};
        await expect(recordingAction(identity,confirm,d)).rejects.toMatchObject({code:'seed_not_confirmed'});
        receipt=valid;
        const confirmed=await recordingAction(identity,confirm,d);
        expect(confirmed).toMatchObject({phaseReady:true,serverNow:time(clock),firstFrameAt:time(initial),startedAt:time(initial),deadlineAt:time(initial+hour)});
        const next={...input,sequence:1,captureSessionId:session};
        await expect(recordingAction(identity,next,d)).rejects.toMatchObject({status:409});
        remoteState={...state,workspaceUnlocked:true,phaseReady:true,captureSessionId:session};
        const gate=await recordingAction(identity,{action:'status',attemptId:attempt,captureSessionId:session},d);
        expect(gate).toMatchObject({workspaceUnlocked:true,phaseReady:true,startedAt:time(initial)});
        await recordingAction(identity,{action:'checkpoint',attemptId:attempt,captureSessionId:session,reason:'sharing_stopped'},d);
        expect(d.leases.size).toBe(0);
    });
    it('does not reuse another actor, verified session or attempt capability',async()=>{
        const d=deps();await recordingAction(identity,begin,d);
        for(const other of [{...identity,sessionId:'different'}, {...identity,subject:'other'}, {...identity,userId:'other'}]){
            await expect(recordingAction(other,input,d)).rejects.toMatchObject({code:'recording_session_refresh_required'});
        }
        await expect(recordingAction(identity,{...input,attemptId:recording},d)).rejects.toMatchObject({status:409});
        remoteState={...state,recordingId:attempt};
        await expect(recordingAction(identity,input,d)).rejects.toMatchObject({status:409});
        expect(calls.some(x=>x.url.includes('api-staging.'))).toBe(false);
    });
    it('rejects any new frames outside the real stop, expiry, revocation, or bounded segment window',async()=>{
        const d=deps();await recordingAction(identity,begin,d);
        for(const invalid of [{...input,endMs:60001,startMs:0},{...input,endMs:10000},{...input,endMs:1000}]){
            await expect(recordingAction(identity,invalid,d)).rejects.toMatchObject({status:409});
        }
        remoteState={...state,stopRequestedAt:time(initial+4000),stopReason:'submitted'};
        await expect(recordingAction(identity,input,d)).rejects.toMatchObject({status:409});
        remoteState={...state,revoked:true};
        await expect(recordingAction(identity,input,d)).rejects.toMatchObject({status:409});
        remoteState={...state};clock=initial+hour+drain+1;
        await expect(recordingAction(identity,input,d)).rejects.toMatchObject({status:409});
        expect(calls.some(x=>x.url.includes('api-staging.'))).toBe(false);
    });
    it('refuses a previously minted segment whose end falls past a later authoritative submission cutoff', async () => {
        const d=deps();await recordingAction(identity,begin,d);
        await expect(recordingAction(identity,input,d)).resolves.toEqual(signed);
        remoteState={...state,stopRequestedAt:time(initial+4800),stopReason:'submitted'};
        await expect(recordingAction(identity,{action:'confirm',attemptId:attempt,sequence:0},d)).rejects.toMatchObject({code:'segment_outside_recording'});
        await expect(recordingAction(identity,{action:'confirm',attemptId:attempt,sequence:1},d)).rejects.toMatchObject({code:'segment_outside_recording'});
        expect(calls.some(c=>c.url.endsWith('/segments/confirm'))).toBe(false);
    });
    it('drains real pre-submission slices and refuses all newer frames and expired confirmations',async()=>{
        const d=deps();await recordingAction(identity,begin,d);
        remoteState={...state,stopRequestedAt:time(initial+4500),stopReason:'submitted'};
        await expect(recordingAction(identity,{...input,endMs:4200},d)).resolves.toEqual(signed);
        await expect(recordingAction(identity,{...input,endMs:4501},d)).rejects.toMatchObject({status:409});
        await expect(recordingAction(identity,{action:'confirm',attemptId:attempt,sequence:0},d)).resolves.toMatchObject({confirmed:true});
        clock=initial+4500+drain+1;
        await expect(recordingAction(identity,{action:'confirm',attemptId:attempt,sequence:0},d)).rejects.toMatchObject({status:409});
    });
    it('does not close on a forged attach or timeout refused by the authoritative Universe owner',async()=>{
        const d=deps();await recordingAction(identity,begin,d);
        const rejected=vi.fn(async()=>Response.json({detail:'private upstream error'},{status:409}));
        await expect(recordingAction(identity,{action:'finalize',attemptId:attempt,reason:'submitted',expectedSegments:0},
            {...d,fetcher:rejected})).rejects.toMatchObject({status:409,code:'recording_refused'});
        expect(d.leases.size).toBe(1);
    });
    it('refuses arbitrary S3 targets, checksum, unexpected headers and stale or overlong URLs',()=>{
        const wrong = [signed.putUrl.replace(owner,'1'.repeat(64)),signed.putUrl.replace(attempt,recording),
            signed.putUrl.replace('segments/0','segments/1'),signed.putUrl.replace('s3.ap-south-1.amazonaws.com','example.test'),
            signed.putUrl.replace('X-Amz-Expires=60','X-Amz-Expires=3600'),signed.putUrl.replace('content-length%3B','')];
        for(const putUrl of wrong) expect(()=>checkedPut({...signed,putUrl},identity.subject,recording,input,clock)).toThrow();
        for(const expiresAt of [time(initial),time(initial+hour)]) expect(()=>checkedPut({...signed,expiresAt},identity.subject,recording,input,clock)).toThrow();
        for(const h of [{'x-amz-checksum-sha256':'a'}, {authorization:'forbidden'}])
            expect(()=>checkedPut({...signed,headers:{...signed.headers,...h}},identity.subject,recording,input,clock)).toThrow();
    });
    it('authorizes the real attempt without minting media, and rejects a foreign or stale eligibility receipt',async()=>{
        const d=deps();
        const eligible={...eligibility,unexpectedSecret:cap};
        const preflight={action:'preflight' as const,attemptId:attempt};
        const permitted=vi.fn(async()=>Response.json(eligible));
        const receipt=await recordingAction(identity,preflight,{...d,fetcher:permitted});
        expect(receipt).toEqual(eligibility);
        expect(d.leases.size).toBe(0);
        for(const change of [{attemptId:recording},{expiresAt:time(initial-1)},{jobId:'test'},{repositoryUrl:'https://github.com/test/private.git'},{manifestSha256:'0'.repeat(64)},
            {manifestSha256:createHash('sha256').update(assignmentMarker(repo,1)).digest('hex')},{windowStartedAt:time(initial+6000)}]) {
            await expect(recordingAction(identity,preflight,{...d,fetcher:async()=>Response.json({...eligible,...change})}))
                .rejects.toMatchObject({status:404});
        }
    });
    it('does not return upstream secret bodies/errors',async()=>{
        const broken=vi.fn(async()=>new Response(identity.token+cap,{status:503}));
        await expect(recordingAction(identity,begin,{...deps(),fetcher:broken})).rejects.toMatchObject({message:'media_unavailable'});
    });
});
