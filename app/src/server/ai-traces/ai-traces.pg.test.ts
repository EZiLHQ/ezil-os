/** ROOT ONLY: no hosted DB. Explicit disposable loopback fixture and exact database name. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ingestTraces, retainTraces } from './store';
import { validateInferenceTrace } from './schema';
import fixture from './fixture.json';
const PG = process.env.EZIL_AI_TRACES_PG_TEST_URL;
if (PG) {
    const url = new URL(PG);
    if (process.env.EZIL_PG_TEST_DISPOSABLE !== '1' || !['postgres:', 'postgresql:'].includes(url.protocol)
        || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/ezil_ai_traces_test' || url.search || url.hash)
        throw new Error('AI trace PG tests require disposable opt-in and loopback /ezil_ai_traces_test without URL options');
}
describe.skipIf(!PG)('AI trace disposable PostgreSQL', () => {
    const schema = `ai_traces_${randomUUID().replaceAll('-', '')}`;
    const admin = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    const client = PG ? postgres(PG, { max: 8, prepare: false, onnotice: () => {}, connection: { search_path: schema, application_name: schema } }) : null;
    const db = client ? drizzle(client) : null!;
    let created = false;
    beforeAll(async () => {
        const rows = await admin!`SELECT current_database() AS name`;
        if (rows[0]?.name !== 'ezil_ai_traces_test') throw new Error('Wrong disposable database');
        await admin!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await admin!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        const migration = readFileSync(new URL('../../../drizzle/0025_ai_request_traces.sql', import.meta.url), 'utf8');
        await admin!.begin(tx => tx.unsafe(migration.replaceAll('public.', `${schema}.`)));
    });
    afterAll(async () => { await client?.end(); if (created) await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`); await admin?.end(); });
    it('deduplicates per user, bounds concurrent ingest durably, preserves null and zero, RLS denies client roles and retention purges only old rows', async () => {
        const user = randomUUID(); const other = randomUUID(); const trace = validateInferenceTrace(fixture)!;
        await ingestTraces(db, user, [trace]); await ingestTraces(db, user, [trace]); await ingestTraces(db, other, [trace]);
        expect((await client!.unsafe('SELECT * FROM ezil_ai_request_traces')).length).toBe(2);
        expect((await client!.unsafe('SELECT input_tokens FROM ezil_ai_request_traces'))[0]!.input_tokens).toBeNull();
        const flood = randomUUID();
        await Promise.all(Array.from({ length: 30 }, () => ingestTraces(db, flood, Array.from({ length: 8 }, () => ({ ...trace, requestId: randomUUID() })))));
        const count = await client!.unsafe('SELECT count(*)::integer AS n FROM ezil_ai_request_traces WHERE user_id=$1', [flood]);
        expect(count[0]!.n).toBe(120);
        const zero = { ...trace, requestId: randomUUID(), usageSource: 'provider_reported' as const, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
        await ingestTraces(db, user, [zero]);
        expect((await client!.unsafe('SELECT input_tokens FROM ezil_ai_request_traces WHERE request_id=$1', [zero.requestId]))[0]!.input_tokens).toBe(0);
        const rls = await admin!.unsafe('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass', [`${schema}.ezil_ai_request_traces`]);
        expect(rls[0]!.relrowsecurity).toBe(true);
        for (const role of ['anon','authenticated']) {
            const privilege = await admin!.unsafe('SELECT has_table_privilege($1, $2, $3) AS allowed', [role, `${schema}.ezil_ai_request_traces`, 'SELECT']);
            expect(privilege[0]!.allowed).toBe(false);
        }
        for (const role of ['anon','authenticated']) await expect(admin!.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx.unsafe(`SELECT * FROM ${schema}.ezil_ai_request_traces`); })).rejects.toThrow();
        await client!.unsafe("UPDATE ezil_ai_request_traces SET received_at=now()-interval '8 days' WHERE user_id=$1", [flood]);
        expect(await retainTraces(db)).toMatchObject({ deleted: 120, hitBudget: false });
        expect((await client!.unsafe('SELECT count(*)::integer AS n FROM ezil_ai_request_traces'))[0]!.n).toBe(3);
    });
    it('refuses an older bucket instead of resetting a newer exhausted quota', async () => {
        const user = randomUUID(); const trace = { ...validateInferenceTrace(fixture)!, requestId: randomUUID() };
        await client!.unsafe("INSERT INTO ezil_ai_trace_limits VALUES ($1, date_trunc('minute', clock_timestamp()) + interval '1 minute', 120)", [user]);
        const before = (await client!.unsafe('SELECT window_start, used FROM ezil_ai_trace_limits WHERE user_id=$1', [user]))[0]!;
        await ingestTraces(db, user, [trace]);
        const after = (await client!.unsafe('SELECT window_start, used FROM ezil_ai_trace_limits WHERE user_id=$1', [user]))[0]!;
        expect(after).toEqual(before);
        expect((await client!.unsafe('SELECT count(*)::integer AS n FROM ezil_ai_request_traces WHERE user_id=$1', [user]))[0]!.n).toBe(0);
    });
    it('waits on the account lock before accepting concurrent request observations', async () => {
        const user = randomUUID(); const trace = validateInferenceTrace(fixture)!;
        let entered!: () => void; let release!: () => void;
        const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
        const holder = admin!.begin(async tx => {
            await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended('ezil.ai-traces:' || $1::text, 0))", [user]);
            entered(); await gate;
        });
        await ready;
        const calls = [1,2].map(() => ingestTraces(db, user, [{ ...trace, requestId: randomUUID() }]));
        try {
            const deadline = Date.now() + 5000;
            for (;;) {
                const waiting = (await client!.unsafe("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [schema]))[0]!.n;
                if (waiting === 2) break;
                if (Date.now() >= deadline) throw new Error('Two independent collectors must wait on the account lock');
                await new Promise(r => setTimeout(r, 10));
            }
        } finally { release(); }
        await holder; await Promise.all(calls);
        expect((await client!.unsafe('SELECT used FROM ezil_ai_trace_limits WHERE user_id=$1', [user]))[0]!.used).toBe(2);
        expect((await client!.unsafe('SELECT count(*)::integer AS n FROM ezil_ai_request_traces WHERE user_id=$1', [user]))[0]!.n).toBe(2);
    });

});
