import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { runtimeTestDatabase } from './helpers/runtime-database';

const fixture = await runtimeTestDatabase(), { sql } = fixture;
let passed = 0;
const test = async (name: string, work: () => Promise<void>) => { await work(); passed++; console.log(`PASS ${name}`); };
const reject = (work: () => Promise<unknown>, code = '23514') => assert.rejects(work, (error: { code?: string }) => error.code === code);
const deployment = { accountId: '123456789012', region: 'us-east-1', availabilityZone: 'us-east-1a',
    subnetId: 'subnet-11111111111111111', securityGroupId: 'sg-11111111111111111', launchTemplateId: 'lt-11111111111111111',
    launchTemplateVersion: '1', amiId: 'ami-11111111111111111', namespace: 'pilot',
    instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/ezil/host',
    dataKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    stateMachineVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-lifecycle:1' };
async function computer(existing = false) {
    const userId = randomUUID(), computerId = randomUUID(), fenceToken = randomUUID();
    const instanceId = 'i-' + randomUUID().replaceAll('-', '').slice(0,17), volumeId = 'vol-' + randomUUID().replaceAll('-', '').slice(0,17);
    await sql`INSERT INTO auth.users(id) VALUES (${userId})`;
    await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${computerId},${userId},1,'aws-ec2')`;
    await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,availability_zone,data_volume_id,next_generation)
        VALUES (${computerId},'us-east-1',${existing ? 'us-east-1a' : null},${existing ? volumeId : null},${existing ? 2 : 1})`;
    if (existing) await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token)
        VALUES (${computerId},1,${instanceId},${fenceToken})`;
    return { userId, computerId, fenceToken, instanceId, volumeId };
}
type Computer = Awaited<ReturnType<typeof computer>>;
async function intent(tx: TransactionSql, c: Computer, operation = 'provision', options: {
    revision?: number; generation?: number; fence?: string; previousGeneration?: number | null;
    previousInstance?: string | null; previousFence?: string | null; volume?: string | null;
    instance?: string | null; deployment?: unknown; event?: boolean; jobComputer?: string;
} = {}) {
    const generation = options.generation ?? (operation === 'replace' ? 2 : 1);
    const [job] = await tx`INSERT INTO ezil_computer_lifecycle_jobs(computer_id,requested_by,operation,idempotency_key)
        VALUES (${options.jobComputer ?? c.computerId},${c.userId},${operation},${randomUUID()}) RETURNING id`;
    if (options.event !== false) await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${job!.id},${options.jobComputer ?? c.computerId})`;
    const [row] = await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,
        provider_instance_id,data_volume_id,previous_generation,previous_instance_id,previous_fence_token,deployment,digest)
        VALUES (${job!.id},${c.computerId},${options.revision ?? 1},${operation},${generation},${options.fence ?? (operation === 'replace' ? randomUUID() : c.fenceToken)},
            ${options.instance !== undefined ? options.instance : ['provision','replace'].includes(operation) ? null : c.instanceId},
            ${options.volume !== undefined ? options.volume : operation === 'provision' ? null : c.volumeId},
            ${options.previousGeneration !== undefined ? options.previousGeneration : operation === 'replace' ? 1 : null},
            ${options.previousInstance !== undefined ? options.previousInstance : operation === 'replace' ? c.instanceId : null},
            ${options.previousFence !== undefined ? options.previousFence : operation === 'replace' ? c.fenceToken : null},
            ${JSON.stringify(options.deployment ?? deployment)},'caller-digest-is-replaced') RETURNING *`;
    return row!;
}
try {
    await test('provision intent reserves a generation and durable event without creating a writer or disk', async () => {
        const c = await computer(), row = await sql.begin(tx => intent(tx,c));
        const [stored] = await sql`SELECT digest,encode(sha256(convert_to((to_jsonb(i)-ARRAY['digest','created_at'])::text,'UTF8')),'hex') AS expected
            FROM ezil_computer_lifecycle_intents i WHERE job_id=${row.job_id}`;
        assert.equal(stored!.digest, stored!.expected);
        assert.equal((await sql`SELECT next_generation,data_volume_id,desired_state FROM ezil_computer_runtimes WHERE computer_id=${c.computerId}`)[0]!.next_generation,2);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_instances WHERE computer_id=${c.computerId}`)[0]!.n,0);
        assert.equal((await sql`SELECT target_generation FROM ezil_computer_lifecycle_jobs WHERE id=${row.job_id}`)[0]!.target_generation,1);
    });
    await test('missing outbox rolls back the intent and generation reservation', async () => {
        const c = await computer(); await reject(() => sql.begin(tx => intent(tx,c,'provision',{ event:false })), '23503');
        assert.equal((await sql`SELECT next_generation FROM ezil_computer_runtimes WHERE computer_id=${c.computerId}`)[0]!.next_generation,1);
    });
    await test('replacement retains the previous writer until independent provider fencing', async () => {
        const c = await computer(true); await sql.begin(tx => intent(tx,c,'replace'));
        assert.equal((await sql`SELECT next_generation FROM ezil_computer_runtimes WHERE computer_id=${c.computerId}`)[0]!.next_generation,3);
        assert.equal((await sql`SELECT fenced_at FROM ezil_computer_instances WHERE computer_id=${c.computerId} AND generation=1`)[0]!.fenced_at,null);
        await reject(() => sql`INSERT INTO ezil_computer_instances(computer_id,generation) VALUES (${c.computerId},2)`, '23505');
    });
    await test('unknown deployment fields, mutable pins, foreign accounts and wrong AZ fail', async () => {
        const c = await computer(true);
        for (const changed of [{ ...deployment, secret: 'DO_NOT_PERSIST' }, { ...deployment, launchTemplateVersion: '$Latest' },
            { ...deployment, stateMachineVersionArn: deployment.stateMachineVersionArn.replace(/:1$/,':alias') },
            { ...deployment, amiId: 'latest' }, { ...deployment, region: 'eu-west-1' },
            { ...deployment, instanceProfileArn: deployment.instanceProfileArn.replace('123456789012','999999999999') },
            { ...deployment, availabilityZone: 'us-east-1b' }, { ...deployment, accountId: 123456789012 }]) {
            await reject(() => sql.begin(tx => intent(tx,c,'start',{ deployment:changed })));
        }
    });
    await test('cross-computer jobs and volume/instance/fence substitution fail', async () => {
        const a = await computer(true), b = await computer(true);
        await reject(() => sql.begin(tx => intent(tx,a,'start',{ jobComputer:b.computerId })), '23503');
        for (const changed of [{ instance:b.instanceId }, { volume:b.volumeId }, { fence:b.fenceToken }])
            await reject(() => sql.begin(tx => intent(tx,a,'start',changed)));
        for (const changed of [{ previousGeneration:null }, { previousInstance:b.instanceId },
            { previousFence:b.fenceToken }, { fence:a.fenceToken }]) await reject(() => sql.begin(tx => intent(tx,a,'replace',changed)));
    });
    await test('intent, bound job identity and durable event cannot be rewritten or removed', async () => {
        const c = await computer(true), row = await sql.begin(tx => intent(tx,c,'start'));
        await reject(() => sql`UPDATE ezil_computer_lifecycle_intents SET digest=${'a'.repeat(64)} WHERE job_id=${row.job_id}`);
        await reject(() => sql`DELETE FROM ezil_computer_lifecycle_intents WHERE job_id=${row.job_id}`);
        await reject(() => sql`UPDATE ezil_computer_lifecycle_jobs SET target_generation=2 WHERE id=${row.job_id}`);
        await reject(() => sql`DELETE FROM ezil_computer_lifecycle_outbox WHERE job_id=${row.job_id}`, '23503');
        await sql`UPDATE ezil_computer_lifecycle_jobs SET status='running',started_at=now() WHERE id=${row.job_id}`;
        await reject(() => sql.begin(tx => intent(tx,c,'stop',{ revision:2 })));
        await sql`UPDATE ezil_computer_lifecycle_jobs SET status='succeeded',completed_at=now() WHERE id=${row.job_id}`;
        await reject(() => sql`UPDATE ezil_computer_lifecycle_jobs SET status='running' WHERE id=${row.job_id}`);
        await sql.begin(tx => intent(tx,c,'stop',{ revision:2 }));
    });
    await test('concurrent reservations serialize; only one consumes a generation', async () => {
        const c = await computer();
        const result = await Promise.allSettled([sql.begin(tx => intent(tx,c)),sql.begin(tx => intent(tx,c))]);
        assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
        assert.equal((await sql`SELECT next_generation FROM ezil_computer_runtimes WHERE computer_id=${c.computerId}`)[0]!.next_generation,2);
    });
    await test('even direct table grants cannot expose intents to authenticated users', async () => {
        const c = await computer(true); await sql.begin(tx => intent(tx,c,'start'));
        await sql.begin(async tx => {
            await tx`GRANT ALL ON ezil_computer_lifecycle_intents TO authenticated`;
            await tx`SET LOCAL ROLE authenticated`;
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',${c.userId},true)`;
            assert.equal((await tx`SELECT count(*)::int n FROM ezil_computer_lifecycle_intents`)[0]!.n,0);
        });
    });
    console.log(`${passed} lifecycle intent database checks passed; 0 failed`);
} finally { await fixture.close(); }
