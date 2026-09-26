import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runtimeTestDatabase } from './helpers/runtime-database';

const fixture = await runtimeTestDatabase({ throughMigration: '0009_computer_cancellations' }), { sql } = fixture;
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
const reject = (run: () => Promise<unknown>, code = '23514') => assert.rejects(run, (e: { code?: string }) => e.code === code);
const volume = () => `vol-${randomUUID().replaceAll('-', '').slice(0, 17)}`;
async function computer() {
    const id = randomUUID(), user = randomUUID();
    await sql`INSERT INTO auth.users(id) VALUES (${user})`;
    await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${id},${user},1,'aws-ec2')`;
    return { id, user };
}
async function runtime(boundVolume: string | null = null, uuid?: string) {
    const c = await computer();
    const [r] = uuid === undefined
        ? await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,data_volume_id,availability_zone)
            VALUES (${c.id},'us-east-1',${boundVolume},${boundVolume ? 'us-east-1a' : null}) RETURNING *`
        : await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,data_volume_id,availability_zone,data_filesystem_uuid)
            VALUES (${c.id},'us-east-1',${boundVolume},${boundVolume ? 'us-east-1a' : null},${uuid}) RETURNING *`;
    return { ...c, row: r! };
}
try {
    const legacyEmpty = await runtime(), legacyBound = await runtime(volume());
    await sql`INSERT INTO ezil_computer_instances(computer_id,generation,observed_state)
        VALUES (${legacyBound.id},1,'running')`;
    const migration = await readFile(new URL('../drizzle/0010_computer_filesystem_identity.sql', import.meta.url), 'utf8');
    await sql.begin(async tx => {
        for (const s of migration.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) await tx.unsafe(s);
    });
    await test('migration preserves existing disk/writer records and leaves unknown UUIDs unknown', async () => {
        for (const c of [legacyEmpty, legacyBound]) {
            const [after] = await sql`SELECT * FROM ezil_computer_runtimes WHERE computer_id=${c.id}`;
            const { data_filesystem_uuid: uuid, ...unchanged } = after!;
            assert.equal(uuid, null); assert.deepEqual(unchanged, c.row);
            await sql`UPDATE ezil_computer_runtimes SET desired_state='stopped' WHERE computer_id=${c.id}`;
            assert.equal((await sql`SELECT data_filesystem_uuid FROM ezil_computer_runtimes WHERE computer_id=${c.id}`)[0]!.data_filesystem_uuid, null);
        }
        assert.equal((await sql`SELECT observed_state FROM ezil_computer_instances WHERE computer_id=${legacyBound.id}`)[0]!.observed_state, 'running');
    });
    await test('new unallocated computers reserve distinct durable UUIDs before volume association', async () => {
        const a = await runtime(), b = await runtime();
        assert.match(a.row.data_filesystem_uuid, /^[a-f0-9-]{36}$/);
        assert.notEqual(a.row.data_filesystem_uuid, b.row.data_filesystem_uuid);
        assert.equal(a.row.data_volume_id, null);
        await sql`UPDATE ezil_computer_runtimes SET data_volume_id=${volume()},availability_zone='us-east-1a',
            desired_state='running',next_generation=2 WHERE computer_id=${a.id}`;
        await sql`INSERT INTO ezil_computer_instances(computer_id,generation,observed_state) VALUES (${a.id},1,'running')`;
        await sql`UPDATE ezil_computer_instances SET observed_state='stopped',fenced_at=clock_timestamp() WHERE computer_id=${a.id}`;
        await sql`INSERT INTO ezil_computer_instances(computer_id,generation,observed_state) VALUES (${a.id},2,'starting')`;
        await sql`UPDATE ezil_computer_runtimes SET next_generation=3 WHERE computer_id=${a.id}`;
        assert.equal((await sql`SELECT data_filesystem_uuid FROM ezil_computer_runtimes WHERE computer_id=${a.id}`)[0]!.data_filesystem_uuid,
            a.row.data_filesystem_uuid, 'instance replacement cannot regenerate filesystem identity');
    });
    await test('retained imports never invent a UUID; a verified explicit UUID is retained', async () => {
        const unknown = await runtime(volume());
        assert.equal(unknown.row.data_filesystem_uuid, null);
        const known = randomUUID(), imported = await runtime(volume(), known);
        assert.equal(imported.row.data_filesystem_uuid, known);
        await sql`UPDATE ezil_computer_runtimes SET data_filesystem_uuid=${known} WHERE computer_id=${imported.id}`;
        await reject(() => sql`UPDATE ezil_computer_runtimes SET data_filesystem_uuid=${randomUUID()} WHERE computer_id=${imported.id}`);
        await reject(() => sql`UPDATE ezil_computer_runtimes SET data_filesystem_uuid=NULL WHERE computer_id=${imported.id}`);
    });
    await test('UUIDs cannot be shared across computers or moved to another computer', async () => {
        const a = await runtime(), b = await computer();
        await reject(() => sql`INSERT INTO ezil_computer_runtimes(computer_id,region,data_filesystem_uuid)
            VALUES (${b.id},'us-east-1',${a.row.data_filesystem_uuid})`, '23505');
        await reject(() => sql`UPDATE ezil_computer_runtimes SET computer_id=${b.id} WHERE computer_id=${a.id}`);
    });
    await test('concurrent legacy identity registration commits exactly one UUID', async () => {
        const c = await runtime(volume());
        const choices = [randomUUID(), randomUUID()];
        const results = await Promise.allSettled(choices.map(uuid =>
            sql`UPDATE ezil_computer_runtimes SET data_filesystem_uuid=${uuid} WHERE computer_id=${c.id} RETURNING data_filesystem_uuid`));
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
        assert.equal(failure.reason.code, '23514');
        const success = results.find(r => r.status === 'fulfilled');
        assert.ok(success && success.status === 'fulfilled');
        assert.equal((await sql`SELECT data_filesystem_uuid FROM ezil_computer_runtimes WHERE computer_id=${c.id}`)[0]!.data_filesystem_uuid,
            success.value[0]!.data_filesystem_uuid);
    });
    await test('rolled-back registration leaves no identity; malformed UUIDs fail', async () => {
        const c = await runtime(volume()), rollback = new Error('test rollback');
        await assert.rejects(sql.begin(async tx => {
            await tx`UPDATE ezil_computer_runtimes SET data_filesystem_uuid=${randomUUID()} WHERE computer_id=${c.id}`;
            throw rollback;
        }), error => error === rollback);
        assert.equal((await sql`SELECT data_filesystem_uuid FROM ezil_computer_runtimes WHERE computer_id=${c.id}`)[0]!.data_filesystem_uuid, null);
        await reject(() => sql`UPDATE ezil_computer_runtimes SET data_filesystem_uuid='not-a-uuid' WHERE computer_id=${c.id}`, '22P02');
    });
    await test('direct authenticated owners cannot read or change filesystem identities', async () => {
        const c = await runtime();
        await sql.begin(async tx => {
            await tx`GRANT ALL ON ezil_computer_runtimes TO authenticated`;
            await tx`SET LOCAL ROLE authenticated`;
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',${c.user},true)`;
            assert.equal((await tx`SELECT count(*)::int n FROM ezil_computer_runtimes`)[0]!.n, 0);
            assert.equal((await tx`UPDATE ezil_computer_runtimes SET data_filesystem_uuid=${randomUUID()} WHERE computer_id=${c.id} RETURNING computer_id`).length, 0);
        });
        assert.equal((await sql`SELECT data_filesystem_uuid FROM ezil_computer_runtimes WHERE computer_id=${c.id}`)[0]!.data_filesystem_uuid,
            c.row.data_filesystem_uuid);
    });
    console.log(`PASS ${passed} filesystem identity database checks`);
} finally { await fixture.close(); }
