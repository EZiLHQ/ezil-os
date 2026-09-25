import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { claimLifecycleWork, dispatchLifecycleClaim, authorizeLifecycleWork, type LifecycleConsumerOptions } from '../src/server/app-platform/lifecycle-consumer';
import { parseLifecycleWork, type LifecycleIntent, type LifecycleReceipt, type LifecycleWork } from '../src/server/app-platform/lifecycle-protocol';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';
import { createLifecycleAuthorityHandler } from '../src/server/app-platform/lifecycle-authority-http';
import { LIFECYCLE_AUTHORITY_PATH, lifecycleAuthoritySignature } from '../src/server/app-platform/lifecycle-authority-protocol';
import { runtimeTestDatabase } from './helpers/runtime-database';
const fixture=await runtimeTestDatabase(), {sql}=fixture;
const options: LifecycleConsumerOptions={ database:drizzle(sql,{schema}), enabled:true, osAccessMode:'invite', deployments:[deployment], advance:async()=>({state:'pending'}) };
let passed=0;
const test=async(name:string,run:()=>Promise<void>)=>{await run();passed++;console.log(`PASS ${name}`)};
const handle=(prefix:string)=>prefix+'-'+randomUUID().replaceAll('-','').slice(0,17);
async function setup(operation:LifecycleIntent['operation']='start') {
    const computerId=randomUUID(), userId=randomUUID(), email=userId+'@example.com', jobId=randomUUID(), fence=randomUUID();
    const volume=handle('vol'), instance=handle('i'), previousFence=randomUUID();
    const desired=operation==='stop'?'stopped':operation==='retire'?'retired':'running', newComputer=operation==='provision';
    await sql`INSERT INTO auth.users(id,email) VALUES (${userId},${email})`;
    await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'test')`;
    await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${computerId},${userId},1,'aws-ec2')`;
    await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,availability_zone,data_volume_id,next_generation,desired_state)
        VALUES (${computerId},'us-east-1',${newComputer?null:'us-east-1a'},${newComputer?null:volume},${newComputer?1:2},${desired})`;
    if(!newComputer)await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state,observed_at)
        VALUES (${computerId},1,${instance},${operation==='replace'?previousFence:fence},'stopped',now())`;
    await sql.begin(async tx=>{
        await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${jobId},${computerId},${userId},${operation},${randomUUID()})`;
        await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${computerId})`;
        await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,provider_instance_id,
            data_volume_id,previous_generation,previous_instance_id,previous_fence_token,deployment)
            VALUES (${jobId},${computerId},1,${operation},${operation==='replace'?2:1},${fence},${['provision','replace'].includes(operation)?null:instance},
                ${newComputer?null:volume},${operation==='replace'?1:null},${operation==='replace'?instance:null},${operation==='replace'?previousFence:null},${JSON.stringify(deployment)})`;
    });
    return {computerId,userId,email,jobId,volume,instance,fence};
}
type Setup=Awaited<ReturnType<typeof setup>>;
async function claim(s:Setup) {
    // Keep unrelated fixture jobs out of the global work queue, but retained in
    // admission. We do not remove them or truncate immutable production tables.
    await sql`UPDATE ezil_computer_lifecycle_outbox SET available_at=CASE WHEN job_id=${s.jobId} THEN now() ELSE now()+interval '1 day' END`;
    const c=await claimLifecycleWork(options);assert.ok(c);assert.equal(c.jobId,s.jobId);return c;
}
async function state(s:Setup) {return (await sql`SELECT j.status,j.error_code,o.delivered_at,o.attempts FROM ezil_computer_lifecycle_jobs j
    JOIN ezil_computer_lifecycle_outbox o ON o.job_id=j.id WHERE j.id=${s.jobId}`)[0]!;}
const observed=(work:LifecycleWork)=>{
    const i=parseLifecycleWork(work);
    const receipt:LifecycleReceipt={schemaVersion:1,jobId:i.jobId,digest:work.digest,computerId:i.computerId,generation:i.targetGeneration,
        fenceToken:i.fenceToken,instanceId:i.providerInstanceId??handle('i'),volumeId:i.dataVolumeId??handle('vol'),
        state:i.operation==='stop'?'stopped':i.operation==='retire'?'retired':'running'};
    return {state:'observed' as const,receipt,observedAt:new Date()};
};
async function releaseFixtures() {
    // Tests do not claim these SQL writes prove a real stop; they isolate the
    // subsequent scenario's admission state in this disposable database only.
    await sql`UPDATE ezil_computer_lifecycle_jobs SET status='cancelled' WHERE status IN ('queued','running')`;
    await sql`UPDATE ezil_computer_instances SET observed_state='stopped',observed_at=now()`;
}
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    await test('disabled consumer does not touch database or provider',async()=>{
        const disabled={...options,enabled:false,database:null as never};assert.equal(await claimLifecycleWork(disabled),null);
        assert.equal(await dispatchLifecycleClaim(disabled,null as never),'disabled');
    });
    await test('two consumers cannot claim the same event concurrently',async()=>{
        const s=await setup();const results=await Promise.all([claimLifecycleWork(options),claimLifecycleWork(options)]);
        assert.equal(results.filter(Boolean).length,1);assert.equal((await state(s)).attempts,1);await releaseFixtures();
    });
    await test('wrong deployment, revoked user and deleted computer deny before cloud work',async()=>{
        for(const reason of ['deployment','revoked','deleted']) {
            const s=await setup(),c=await claim(s);let calls=0;
            if(reason==='revoked')await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`;
            if(reason==='deleted')await sql`UPDATE ezil_computers SET deleted_at=now() WHERE id=${s.computerId}`;
            const o={...options,deployments:reason==='deployment'?[]:[deployment],advance:async()=>{calls++;return {state:'pending' as const}}};
            assert.equal(await dispatchLifecycleClaim(o,c),'waiting');assert.equal(calls,0);assert.equal((await state(s)).status,'queued');
            await releaseFixtures();
        }
    });
    await test('the original PostgreSQL document is dispatched and provider calls hold no SQL locks',async()=>{
        const s=await setup(),c=await claim(s);
        assert.equal(await dispatchLifecycleClaim({...options,advance:async work=>{
            const [stored]=await sql`SELECT digest,ezil_lifecycle_intent_document(i) document FROM ezil_computer_lifecycle_intents i WHERE job_id=${s.jobId}`;
            assert.equal(work.document,stored!.document);assert.equal(work.digest,stored!.digest);
            await sql.begin(async tx=>{await tx`SET LOCAL lock_timeout='200ms'`;await tx`SELECT * FROM ezil_computers WHERE id=${s.computerId} FOR UPDATE`;});
            assert.equal(await authorizeLifecycleWork(options,{computerId:s.computerId,jobId:s.jobId,digest:work.digest}),true);
            assert.equal(await authorizeLifecycleWork(options,{computerId:s.computerId,jobId:s.jobId,digest:'0'.repeat(64)}),false);
            return {state:'pending'};
        }},c),'waiting');assert.equal((await state(s)).status,'running');await releaseFixtures();
    });
    await test('signed lifecycle HTTP checks current database authority on every replay',async()=>{
        const s=await setup(),c=await claim(s);let work:LifecycleWork|undefined;
        await dispatchLifecycleClaim({...options,advance:async w=>{work=w;return {state:'pending'}}},c);
        const secret='ab'.repeat(32), timestamp=String(Math.floor(Date.now()/1000));
        const body=JSON.stringify({schemaVersion:1,computerId:s.computerId,jobId:s.jobId,digest:work!.digest});
        const handler=createLifecycleAuthorityHandler({enabled:true,secret,authorize:input=>authorizeLifecycleWork(options,input)});
        const request=new Request('https://control.example'+LIFECYCLE_AUTHORITY_PATH,{method:'POST',body,headers:{'content-type':'application/json',
            'x-ezil-workflow-timestamp':timestamp,'x-ezil-workflow-signature':lifecycleAuthoritySignature(Buffer.from(body),secret,timestamp)}});
        assert.equal((await handler(request.clone())).status,200);
        await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`;
        assert.equal((await handler(request)).status,403);await releaseFixtures();
    });
    await test('unknown provider results retain active admission and block replacement intent',async()=>{
        const s=await setup(),c=await claim(s);
        assert.equal(await dispatchLifecycleClaim({...options,advance:async()=>{throw new Error('secret provider input')}},c),'waiting');
        const stored=await state(s);assert.equal(stored.status,'running');assert.equal(stored.error_code,'lifecycle_unavailable');assert.equal(stored.delivered_at,null);
        await assert.rejects(sql.begin(async tx=>{
            const job=randomUUID();await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,operation,idempotency_key) VALUES (${job},${s.computerId},'stop',${randomUUID()})`;
            await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${job},${s.computerId})`;
            await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,provider_instance_id,data_volume_id,deployment)
                VALUES (${job},${s.computerId},2,'stop',1,${s.fence},${s.instance},${s.volume},${JSON.stringify(deployment)})`;
        }));await releaseFixtures();
    });
    await test('two pilot reservations prevent a third start, even after lease expiration',async()=>{
        const a=await setup(),b=await setup(),c=await setup();
        await sql`UPDATE ezil_computer_lifecycle_jobs SET status='running' WHERE id IN (${a.jobId},${b.jobId})`;
        const cc=await claim(c);let called=false;
        assert.equal(await dispatchLifecycleClaim({...options,advance:async()=>{called=true;return {state:'pending'}}},cc),'waiting');
        assert.equal(called,false);assert.equal((await state(c)).error_code,'lifecycle_capacity');await releaseFixtures();
    });
    await test('atomic concurrent admission allows at most two computers',async()=>{
        const a=await setup(),b=await setup(),c=await setup();
        const claims=[];for(const s of [a,b,c])claims.push(await claim(s));
        let calls=0;
        await Promise.all(claims.map(claim=>dispatchLifecycleClaim({...options,advance:async()=>{calls++;return {state:'pending'}}},claim)));
        assert.equal(calls,2);assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_lifecycle_jobs WHERE status='running'`)[0]!.n,2);
        await releaseFixtures();
    });
    await test('lease takeover rejects a stale provider acknowledgment',async()=>{
        const s=await setup(),c=await claim(s);
        assert.equal(await dispatchLifecycleClaim({...options,advance:async work=>{
            await sql`UPDATE ezil_computer_lifecycle_outbox SET lease_until=now()-interval '1 second',available_at=now() WHERE job_id=${s.jobId}`;
            const next=await claimLifecycleWork(options);assert.equal(next?.attempt,2);return observed(work);
        }},c),'stale');assert.equal((await state(s)).delivered_at,null);await releaseFixtures();
    });
    await test('revocation during a start cannot produce a successful receipt or release admission',async()=>{
        const s=await setup(),c=await claim(s);
        assert.equal(await dispatchLifecycleClaim({...options,advance:async work=>{
            await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`;return observed(work);
        }},c),'waiting');assert.equal((await state(s)).status,'running');
        await sql`UPDATE ezil_computer_lifecycle_outbox SET available_at=now() WHERE job_id=${s.jobId}`;
        const next=await claim(s);assert.equal(await dispatchLifecycleClaim({...options,advance:async(_work,allowStart)=>{assert.equal(allowStart,false);return {state:'pending'}}},next),'waiting');
        await releaseFixtures();
    });
    await test('stop after revocation records observed stop and keeps the volume and writer identity',async()=>{
        const s=await setup('stop'),c=await claim(s);await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`;
        assert.equal(await dispatchLifecycleClaim({...options,advance:async work=>observed(work)},c),'succeeded');
        const [r]=await sql`SELECT r.data_volume_id,i.fenced_at,i.observed_state FROM ezil_computer_runtimes r
            JOIN ezil_computer_instances i ON i.computer_id=r.computer_id WHERE r.computer_id=${s.computerId}`;
        assert.equal(r!.data_volume_id,s.volume);assert.equal(r!.fenced_at,null);assert.equal(r!.observed_state,'stopped');
        assert.ok((await state(s)).delivered_at);await releaseFixtures();
    });
    await test('stale observation is deferred rather than presented as stopped',async()=>{
        const s=await setup('stop'),c=await claim(s);
        assert.equal(await dispatchLifecycleClaim({...options,advance:async work=>({...observed(work),observedAt:new Date(0)})},c),'waiting');
        assert.equal((await state(s)).status,'running');await releaseFixtures();
    });
    await test('provision receipt binds the generated resources without installing or starting applications',async()=>{
        const s=await setup('provision'),c=await claim(s);let receipt:LifecycleReceipt|undefined;
        assert.equal(await dispatchLifecycleClaim({...options,advance:async work=>{const r=observed(work);receipt=r.receipt;return r;}},c),'succeeded');
        const [r]=await sql`SELECT r.data_volume_id,i.provider_instance_id,i.fence_token FROM ezil_computer_runtimes r
            JOIN ezil_computer_instances i ON i.computer_id=r.computer_id WHERE r.computer_id=${s.computerId}`;
        assert.equal(r!.data_volume_id,receipt!.volumeId);assert.equal(r!.provider_instance_id,receipt!.instanceId);assert.equal(r!.fence_token,s.fence);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_installations WHERE computer_id=${s.computerId}`)[0]!.n,0);await releaseFixtures();
    });
    await test('replacement retains the old writer until one atomic verified receipt switches generations',async()=>{
        const s=await setup('replace'),c=await claim(s);
        assert.equal(await dispatchLifecycleClaim({...options,advance:async work=>{
            const [old]=await sql`SELECT provider_instance_id,fenced_at FROM ezil_computer_instances WHERE computer_id=${s.computerId}`;
            assert.equal(old!.provider_instance_id,s.instance);assert.equal(old!.fenced_at,null);return observed(work);
        }},c),'succeeded');
        const rows=await sql`SELECT generation,fenced_at FROM ezil_computer_instances WHERE computer_id=${s.computerId} ORDER BY generation`;
        assert.equal(rows.length,2);assert.ok(rows[0]!.fenced_at);assert.equal(rows[1]!.fenced_at,null);
        assert.equal((await sql`SELECT data_volume_id FROM ezil_computer_runtimes WHERE computer_id=${s.computerId}`)[0]!.data_volume_id,s.volume);await releaseFixtures();
    });
    await test('retirement fences observed terminated compute while retaining its disk association',async()=>{
        const s=await setup('retire'),c=await claim(s);assert.equal(await dispatchLifecycleClaim({...options,advance:async work=>observed(work)},c),'succeeded');
        const [r]=await sql`SELECT r.data_volume_id,i.fenced_at FROM ezil_computer_runtimes r JOIN ezil_computer_instances i ON i.computer_id=r.computer_id WHERE r.computer_id=${s.computerId}`;
        assert.equal(r!.data_volume_id,s.volume);assert.ok(r!.fenced_at);
    });
    console.log(`${passed} lifecycle consumer database checks passed; 0 failed`);
} finally {await fixture.close();}
