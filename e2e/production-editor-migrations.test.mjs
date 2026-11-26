// In-memory PostgreSQL only. No URL, environment file, provider or deployed database is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { additiveSQL, applySQL, catalogSQL, hash, snapshotHash } from '../.github/scripts/production-migrations.mjs';

const ids = ['0035_editor_agent_sessions', '0036_editor_control_operations', '0037_editor_protocol_2', '0039_named_computer_creation'];
const read = name => readFile(new URL(`../app/drizzle/${name}.sql`, import.meta.url), 'utf8');
const rows = async (db, sql) => (await db.query(sql)).rows;
const state = async db => (await rows(db, catalogSQL(['public'])))[0];
const tables = ['ezil_editor_bridge_owner', 'ezil_agent_sessions', 'ezil_agent_operations', 'ezil_agent_events', 'ezil_control_operations', 'ezil_named_computer_creations'];

async function fixture(t, populated = true) {
    const db = new PGlite(); t.after(() => db.close());
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE public.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL, slot smallint NOT NULL, deleted_at timestamptz);
        CREATE TABLE public.ezil_compute_migrations (id uuid PRIMARY KEY, user_id uuid, computer_id uuid, state text, workspace_head jsonb);
        CREATE TABLE public.ezil_computer_placements (computer_id uuid, owner_user_id uuid, instance_type text, instance_id text, volume_id text, generation bigint, lease_epoch bigint, state text, provider text);
        CREATE TABLE public.ezil_staging_schema_log (file text PRIMARY KEY, sha256 text NOT NULL, mode text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());`);
    // The actual production-only tables/triggers survive the new additive batch.
    await db.exec(await read('0029_native_session_operations'));
    await db.exec(await read('0034_assignment_migration_clock'));
    if (populated) await db.exec(`
        INSERT INTO public.ezil_computers VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Existing paid computer',1,NULL);
        INSERT INTO public.ezil_compute_migrations VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','requested','{}');
        UPDATE public.ezil_compute_migrations SET state='fenced';
        INSERT INTO public.ezil_staging_schema_log(file,sha256,mode) VALUES ('app/drizzle/0034_editor_agent_sessions.sql','synthetic-historical-stage-receipt','apply');
        INSERT INTO public.ezil_native_session_operations VALUES (
            '00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','create',
            '00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001',1,
            'sha256:'||repeat('a',64),'fixture.task','sha256:'||repeat('b',64),1,1,'i-12345678',
            '00000000-0000-4000-8000-000000000006','claimed',NULL,NULL,NULL,now(),now());`);
    // Match the engine's catalog rendering context (qualified function/constraint identities).
    await db.exec('SET search_path=pg_catalog;');
    return db;
}

// Observe before/after catalogs inside disposable savepoints. These digests never leave this test
// and are NOT legitimate production observations or an executable release manifest.
async function candidate(db) {
    const manifest = { version: 1, repository: 'synthetic/editor-parity', project: 'synthetic', schemas: ['public'], sources: [],
        initialCatalog: { ...await state(db), capturedAt: new Date().toISOString(), sourceDigest: '' }, migrations: [],
        trustedWorkflowRuns: [], reviewedEventTriggers: [] };
    delete manifest.initialCatalog.schemas;
    const files = new Map();
    await db.exec('BEGIN;');
    try {
        for (const id of ids) {
            const sql = await read(id), path = `app/drizzle/${id}.sql`, sha256 = hash(sql);
            const before = (await state(db)).digest;
            await db.exec(additiveSQL(sql, manifest.schemas));
            const after = (await state(db)).digest;
            manifest.sources.push({ path, sha256, kind: 'migration' });
            manifest.migrations.push({ id, path, sha256, before, after }); files.set(path, { sql });
        }
    } finally { await db.exec('ROLLBACK;'); }
    manifest.initialCatalog.sourceDigest = snapshotHash(manifest);
    return { manifest, files };
}

const oldReader = db => rows(db, `SELECT id,user_id,name,slot,deleted_at FROM public.ezil_computers ORDER BY id`);
const preserved = async db => ({ computers: await oldReader(db),
    native: await rows(db, 'SELECT * FROM public.ezil_native_session_operations'),
    assignment: await rows(db, 'SELECT * FROM public.ezil_assignment_migration_clock'),
    stagingLedger: await rows(db, 'SELECT * FROM public.ezil_staging_schema_log') });

for (const populated of [false, true]) test(`editor batch on ${populated ? 'old production rows' : 'empty new database'}: actual engine apply/retry, old reader, no override`, async t => {
    const db = await fixture(t, populated), before = await preserved(db), loaded = await candidate(db);
    await db.exec(applySQL(loaded));
    const journal = await rows(db, 'SELECT * FROM ezil_ci.journal ORDER BY ordinal');
    await db.exec(applySQL(loaded));
    assert.deepEqual(await preserved(db), before);
    assert.deepEqual(await rows(db, 'SELECT * FROM ezil_ci.journal ORDER BY ordinal'), journal);
    assert.deepEqual(journal.map(x => x.id), ids);
    assert.equal((await rows(db, "SELECT to_regclass('public.ezil_operator_entitlements') AS override"))[0].override, null);
    for (const name of tables) {
        const [access] = await rows(db, `SELECT relrowsecurity AS rls, has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE') AS anon,
            has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE') AS authenticated FROM pg_class WHERE oid='public.${name}'::regclass`);
        assert.deepEqual(access, { rls: true, anon: false, authenticated: false });
    }
    if (populated) {
        await db.exec("UPDATE public.ezil_compute_migrations SET state='failed_reopened'");
        assert.equal((await rows(db, 'SELECT resume_event FROM public.ezil_assignment_migration_clock'))[0].resume_event, 'recovered');
    }
});

test('ambiguous failure rolls back the whole batch and retry preserves historical receipt; unknown ledger/checksum refuses', async t => {
    const db = await fixture(t), loaded = await candidate(db), before = await preserved(db);
    const bad = structuredClone(loaded); bad.manifest.migrations[3].after = '0'.repeat(64);
    await assert.rejects(db.exec(applySQL(bad)), /after catalog mismatch/); await db.exec('ROLLBACK;');
    assert.equal((await rows(db, "SELECT to_regnamespace('ezil_ci') AS ledger"))[0].ledger, null);
    assert.deepEqual(await preserved(db), before);
    await db.exec(applySQL(loaded));
    const drift = structuredClone(loaded); drift.manifest.migrations[0].sha256 = '1'.repeat(64);
    await assert.rejects(db.exec(applySQL(drift)), /checksum\/order drift/); await db.exec('ROLLBACK;');
    await db.exec("UPDATE ezil_ci.journal SET id='unexpected_external_id' WHERE ordinal=1");
    await assert.rejects(db.exec(applySQL(loaded)), /journal|migration/i); await db.exec('ROLLBACK;');
    assert.deepEqual(await preserved(db), before);
});

test('existing stage editor objects are refused, never adopted from a filename or re-executed', async t => {
    const db = await fixture(t), loaded = await candidate(db);
    await db.exec(await read(ids[0]));
    const before = await preserved(db);
    await assert.rejects(db.exec(applySQL(loaded)), /catalog|baseline/i); await db.exec('ROLLBACK;');
    assert.deepEqual(await preserved(db), before);
});
