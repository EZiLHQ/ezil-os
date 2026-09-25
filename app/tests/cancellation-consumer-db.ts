import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';
import { requestComputerStopCancellation } from '../src/server/app-platform/computer-cancellation-producer';
import { authorizeCancellation, claimCancellation, dispatchCancellation, type CancellationConsumerOptions } from '../src/server/app-platform/cancellation-consumer';
import { parseComputerLifecycleWork } from '../src/server/app-platform/computer-lifecycle-work';
import { type CancellationAuthorityRequest, type CancellationReceipt, cancellationAuthoritySignature,
    CANCELLATION_AUTHORITY_PATH } from '../src/server/app-platform/cancellation-authority-protocol';
import { createCancellationAuthorityHandler } from '../src/server/app-platform/cancellation-authority-http';

const fixture = await runtimeTestDatabase(), { sql } = fixture;
const options: CancellationConsumerOptions = { database: drizzle(sql, { schema }), enabled: true, deployments: [deployment],
    workflows: { [deployment.stateMachineVersionArn]: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-cancel:1' },
    advance: async () => ({ state: 'pending' }) };
const handle = (prefix: string) => prefix+'-'+randomUUID().replaceAll('-','').slice(0,17);
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
async function setup(operation: 'provision' | 'start' | 'replace' | 'recover' = 'provision', running = true) {
    const computerId = randomUUID(), userId = randomUUID(), email = userId+'@example.com', jobId = randomUUID(), fence = randomUUID(),
        volume = handle('vol'), instance = handle('i');
    await sql`INSERT INTO auth.users(id,email) VALUES (${userId},${email})`;
    await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'test')`;
    await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${computerId},${userId},1,'aws-ec2')`;
    await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,desired_state) VALUES (${computerId},'us-east-1','running')`;
    await sql.begin(async tx => {
        const initial = operation === 'recover' ? randomUUID() : jobId, op = operation === 'recover' ? 'provision' : operation;
        if (op !== 'provision') {
            await tx`UPDATE ezil_computer_runtimes SET data_volume_id=${volume},availability_zone='us-east-1a',next_generation=2 WHERE computer_id=${computerId}`;
            await tx`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state,observed_at)
                VALUES (${computerId},1,${instance},${fence},'running',now())`;
        }
        await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key) VALUES (${initial},${computerId},${userId},${op},${randomUUID()})`;
        await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${initial},${computerId})`;
        await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,
            provider_instance_id,data_volume_id,previous_generation,previous_instance_id,previous_fence_token,deployment)
            VALUES (${initial},${computerId},1,${op},${op === 'replace' ? 2 : 1},${op === 'replace' ? randomUUID() : fence},
                ${['provision','replace'].includes(op) ? null : instance},${op === 'provision' ? null : volume},${op === 'replace' ? 1 : null},
                ${op === 'replace' ? instance : null},${op === 'replace' ? fence : null},${JSON.stringify(deployment)})`;
        if (operation === 'recover') {
            await tx`UPDATE ezil_computer_runtimes SET data_volume_id=${volume},availability_zone='us-east-1a' WHERE computer_id=${computerId}`;
            await tx`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state,observed_at,fenced_at)
                VALUES (${computerId},1,${instance},${fence},'stopped',now(),now())`;
            await tx`UPDATE ezil_computer_lifecycle_jobs SET status='failed',error_code='lifecycle_recovered',completed_at=now() WHERE id=${initial}`;
            await tx`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${initial}`;
            await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key) VALUES (${jobId},${computerId},${userId},'recover',${randomUUID()})`;
            await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${computerId})`;
            await tx`INSERT INTO ezil_computer_recovery_intents(job_id,computer_id,source_job_id,source_schema_version,source_digest,
                revision,target_generation,fence_token,data_volume_id,data_generation,data_fence_token,deployment)
                SELECT ${jobId},${computerId},${initial},1,digest,2,2,${randomUUID()},${volume},1,${fence},${JSON.stringify(deployment)}
                FROM ezil_computer_lifecycle_intents WHERE job_id=${initial}`;
        }
        if (running) await tx`UPDATE ezil_computer_lifecycle_jobs SET status='running',started_at=now() WHERE id=${jobId}`;
    });
    const result = await requestComputerStopCancellation({ ...options, osAccessMode: 'invite' }, userId, { computerId });
    assert.equal(result.state, 'pending'); if (result.state !== 'pending') throw new Error('missing cancellation');
    const [row] = await sql`SELECT digest,created_at,ezil_computer_cancellation_document(c) document FROM ezil_computer_cancellations c WHERE id=${result.cancellationId}`;
    const [origin] = operation === 'recover'
        ? await sql`SELECT digest,created_at,ezil_computer_recovery_document(i) document FROM ezil_computer_recovery_intents i WHERE job_id=${jobId}`
        : await sql`SELECT digest,created_at,ezil_lifecycle_intent_document(i) document FROM ezil_computer_lifecycle_intents i WHERE job_id=${jobId}`;
    const work = { document: row!.document as string, digest: row!.digest as string, createdAt: new Date(row!.created_at) };
    const source = { document: origin!.document as string, digest: origin!.digest as string, createdAt: new Date(origin!.created_at) };
    const input: CancellationAuthorityRequest = { schemaVersion: 1, computerId, cancellationId: result.cancellationId, digest: work.digest };
    return { input, work, source, intent: parseComputerLifecycleWork(source), computerId, jobId, userId, email, volume, instance };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function claim(s: Setup) {
    await sql`UPDATE ezil_computer_cancellation_outbox SET available_at=CASE WHEN cancellation_id=${s.input.cancellationId} THEN now() ELSE now()+interval '1 day' END WHERE delivered_at IS NULL`;
    const c = await claimCancellation(options); assert.ok(c); assert.equal(c.cancellationId,s.input.cancellationId); return c;
}
async function state(s: Setup) { return (await sql`SELECT j.status,j.error_code,o.delivered_at source_ack,d.delivered_at cancel_ack,d.error_code delivery_error,
    d.attempts,r.data_volume_id FROM ezil_computer_lifecycle_jobs j JOIN ezil_computer_lifecycle_outbox o ON o.job_id=j.id
    JOIN ezil_computer_cancellations c ON c.source_job_id=j.id JOIN ezil_computer_cancellation_outbox d ON d.cancellation_id=c.id
    JOIN ezil_computer_runtimes r ON r.computer_id=j.computer_id WHERE j.id=${s.jobId}`)[0]!; }
function observed(s: Setup) {
    const i = s.intent, old = i.schemaVersion === 1 ? i.previousInstanceId ?? i.providerInstanceId : null;
    const source: CancellationReceipt['source'] = { schemaVersion: i.schemaVersion, computerId: i.computerId, jobId: i.jobId,
        digest: s.source.digest, sourceExecutionArn: deployment.stateMachineVersionArn.slice(0,-2).replace(':stateMachine:',':execution:')+`:computer-${i.jobId}`,
        state: 'fenced', volumeId: i.dataVolumeId ?? s.volume,
        instances: [...(old && i.schemaVersion === 1 ? [{ instanceId: old, generation: i.previousGeneration ?? i.targetGeneration,
            fenceToken: i.previousFenceToken ?? i.fenceToken, state: 'terminated' as const }] : []),
            ...(['provision','replace','recover'].includes(i.operation) ? [{ instanceId: handle('i'), generation: i.targetGeneration,
                fenceToken: i.fenceToken, state: 'terminated' as const }] : [])] };
    return { state: 'observed' as const, observedAt: new Date(), receipt: { ...s.input, source } };
}
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    await test('disabled consumers/authority never touch storage or provider', async () => {
        const disabled = { ...options, database: null as never, enabled: false };
        assert.equal(await claimCancellation(disabled),null); assert.equal(await dispatchCancellation(disabled,null as never),'disabled');
        assert.equal(await authorizeCancellation(disabled,null as never),null);
    });
    await test('two consumers claim one cancellation delivery; source delivery is unchanged', async () => {
        const s = await setup(); const results = await Promise.all([claimCancellation(options),claimCancellation(options)]);
        assert.equal(results.filter(Boolean).length,1);
        assert.equal((await sql`SELECT attempts FROM ezil_computer_lifecycle_outbox WHERE job_id=${s.jobId}`)[0]!.attempts,0);
    });
    await test('only unclaimed queued provision settles without contacting AWS', async () => {
        const s = await setup('provision',false);
        assert.equal(await dispatchCancellation({ ...options, advance: async () => { throw new Error('must not call'); } },await claim(s)),'cancelled');
        const row = await state(s); assert.equal(row.status,'cancelled'); assert.equal(row.error_code,'lifecycle_cancelled');
        assert.ok(row.source_ack); assert.ok(row.cancel_ack); assert.equal(row.data_volume_id,null);
        for (const operation of ['start','recover'] as const) {
            const c = await setup(operation,false); let called = false;
            assert.equal(await dispatchCancellation({ ...options, advance: async () => { called=true; return {state:'pending'}; } },await claim(c)),'waiting');
            assert.ok(called); assert.equal((await state(c)).status,'queued');
        }
        const attempted = await setup('provision',false); await sql`UPDATE ezil_computer_lifecycle_outbox SET attempts=1 WHERE job_id=${attempted.jobId}`;
        let called = false;
        await dispatchCancellation({ ...options, advance: async () => { called=true; return {state:'pending'}; } },await claim(attempted)); assert.ok(called);
    });
    await test('independent observed receipts settle provision/start/replace/recover, retaining disk and fences', async () => {
        for (const operation of ['provision','start','replace','recover'] as const) {
            const s = await setup(operation), receipt = observed(s), before = await sql`SELECT * FROM ezil_computer_instances WHERE computer_id=${s.computerId} AND fenced_at IS NOT NULL`;
            assert.equal(await dispatchCancellation({ ...options, advance: async (work, source, scope) => {
                assert.equal(work.document,s.work.document); assert.equal(source.document,s.source.document);
                assert.equal(scope.source.jobId,s.jobId);
                await sql.begin(async tx => { await tx`SET LOCAL lock_timeout='100ms'`; await tx`SELECT id FROM ezil_computers WHERE id=${s.computerId} FOR UPDATE`; });
                return receipt;
            } },await claim(s)),'cancelled');
            const row = await state(s); assert.equal(row.status,'cancelled'); assert.equal(row.error_code,'lifecycle_recovered');
            assert.ok(row.source_ack); assert.ok(row.cancel_ack); assert.equal(row.data_volume_id,s.volume);
            const writers = await sql`SELECT * FROM ezil_computer_instances WHERE computer_id=${s.computerId}`;
            assert.ok(writers.every(w => w.observed_state==='stopped' && w.fenced_at && w.observed_at));
            for (const historical of before) assert.deepEqual(writers.find(w=>w.generation===historical.generation),historical);
            assert.equal(await authorizeCancellation(options,s.input),null);
        }
    });
    await test('signed authority rechecks exact scope and cannot replay after settlement', async () => {
        const s = await setup(), key='cd'.repeat(32), timestamp=String(Math.floor(Date.now()/1000)),body=JSON.stringify(s.input);
        const request = new Request('https://control.example'+CANCELLATION_AUTHORITY_PATH,{method:'POST',body,headers:{'content-type':'application/json',
            'x-ezil-workflow-timestamp':timestamp,'x-ezil-workflow-signature':cancellationAuthoritySignature(Buffer.from(body),key,timestamp)}});
        const handler=createCancellationAuthorityHandler({enabled:true,secret:key,authorize:input=>authorizeCancellation(options,input)});
        const response = await handler(request.clone());assert.equal(response.status,200);
        const payload=await response.json();assert.equal(payload.source.digest,s.source.digest);assert.deepEqual(payload.writers,[]);
        assert.equal(await authorizeCancellation(options,{...s.input,digest:'0'.repeat(64)}),null);
        assert.equal(await authorizeCancellation(options,{...s.input,computerId:randomUUID()}),null);
        await dispatchCancellation({...options,advance:async()=>observed(s)},await claim(s));
        assert.equal((await handler(request)).status,403);
    });
    await test('access revocation does not withdraw explicit cancellation authority or prevent verified cleanup', async () => {
        const s=await setup('start');await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`;
        assert.ok(await authorizeCancellation(options,s.input));
        assert.equal(await dispatchCancellation({...options,advance:async()=>observed(s)},await claim(s)),'cancelled');
    });
    await test('missing approval/map denies authority and defers delivery without provider calls', async () => {
        for (const override of [{deployments:[]},{workflows:{}}]) {
            const s=await setup(),c=await claim(s);const denied={...options,...override,advance:async()=>{throw new Error('must not call')}};
            assert.equal(await authorizeCancellation(denied,s.input),null);
            assert.equal(await dispatchCancellation(denied,c),'waiting');assert.equal((await state(s)).status,'running');
        }
    });
    await test('pending and failed observations preserve admission and unacknowledged events', async () => {
        const s=await setup();
        assert.equal(await dispatchCancellation(options,await claim(s)),'waiting');
        assert.equal(await dispatchCancellation({...options,advance:async()=>{throw new Error('sensitive-sentinel')}},await claim(s)),'waiting');
        const row=await state(s);assert.equal(row.status,'running');assert.equal(row.source_ack,null);assert.equal(row.cancel_ack,null);
        assert.equal(row.delivery_error,'lifecycle_unavailable');
    });
    await test('an observer that ignores abort cannot hold delivery indefinitely', async () => {
        const s=await setup(),c=await claim(s);let aborted=false;const began=Date.now();
        assert.equal(await dispatchCancellation({...options,advance:async(_work,_source,_scope,signal)=>{
            signal.addEventListener('abort',()=>{aborted=true},{once:true});return new Promise(()=>{});
        }},c),'waiting');
        assert.ok(aborted);assert.ok(Date.now()-began<35000);
        const row=await state(s);assert.equal(row.status,'running');assert.equal(row.cancel_ack,null);assert.equal(row.delivery_error,'lifecycle_unconfirmed');
    });
    await test('expired leases and cross-computer claims cannot acknowledge or mutate another delivery', async () => {
        const s=await setup(),c=await claim(s),before=await state(s);
        assert.equal(await dispatchCancellation(options,{...c,computerId:randomUUID()}),'stale');assert.deepEqual(await state(s),before);
        let replacement: Awaited<ReturnType<typeof claim>> | undefined;
        assert.equal(await dispatchCancellation({...options,advance:async()=>{
            await sql`UPDATE ezil_computer_cancellation_outbox SET lease_until=now()-interval '1 second' WHERE cancellation_id=${c.cancellationId}`;
            replacement=await claim(s);return observed(s);
        }},c),'stale');
        assert.ok(replacement);assert.equal((await state(s)).status,'running');
        assert.equal(await dispatchCancellation({...options,advance:async()=>observed(s)},replacement),'cancelled');
    });
    await test('stale observation, changed fences and foreign receipts never free admission', async () => {
        const s=await setup('start');
        assert.equal(await dispatchCancellation({...options,advance:async()=>({...observed(s),observedAt:new Date(Date.now()-60000)})},await claim(s)),'waiting');
        const other=await setup();
        const foreignClaim=await claim(s);
        await assert.rejects(()=>dispatchCancellation({...options,advance:async()=>observed(other)},foreignClaim),/lifecycle_unavailable/);
        await sql`UPDATE ezil_computer_cancellation_outbox SET lease_until=now()-interval '1 second' WHERE cancellation_id=${s.input.cancellationId}`;
        const c=await claim(s);
        assert.equal(await dispatchCancellation({...options,advance:async()=>{
            await sql`UPDATE ezil_computer_instances SET observed_at=clock_timestamp() WHERE computer_id=${s.computerId}`;
            return observed(s);
        }},c),'waiting');assert.equal((await state(s)).status,'running');
    });
    await test('data-only provider cleanup retains a disk without inventing an instance', async () => {
        for(const operation of ['provision','recover'] as const){
            const s=await setup(operation),r=observed(s);r.receipt.source.instances=[];
            assert.equal(await dispatchCancellation({...options,advance:async()=>r},await claim(s)),'cancelled');
            assert.equal((await state(s)).data_volume_id,s.volume);
            assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_instances WHERE computer_id=${s.computerId}`)[0]!.n,operation==='recover'?1:0);
        }
    });
    await test('a changed disk association during observation cannot be overwritten by a late receipt', async () => {
        const s=await setup('start'),foreign=handle('vol');
        assert.equal(await dispatchCancellation({...options,advance:async()=>{
            await sql`UPDATE ezil_computer_runtimes SET data_volume_id=${foreign} WHERE computer_id=${s.computerId}`;
            return observed(s);
        }},await claim(s)),'waiting');
        assert.equal((await state(s)).data_volume_id,foreign);assert.equal((await state(s)).status,'running');
        assert.equal(await authorizeCancellation(options,s.input),null);
    });
    console.log(`${passed} cancellation consumer database checks passed; 0 failed`);
} finally { await fixture.close(); }
