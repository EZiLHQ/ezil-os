/** Disposable PostgreSQL only (`EZIL_PG_TEST_URL`); never imports the app DB or reads credentials. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_USERS_DDL } from './delegation.test-support';
import { consumeDelegationJti, findDelegatedAccount, type SqlExecutor } from './delegation-store';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `delegation_store_test_${randomUUID().replaceAll('-', '')}`;
const ROOT = path.resolve(__dirname, '../../../..');

describe.skipIf(!PG)('delegation replay ledger and account lookup on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 6, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const other = PG ? postgres(PG, { max: 6, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const local = (q: string, s = schema) => q.replaceAll('public.', `${s}.`).replaceAll('auth.users', `${s}.auth_users`);
    const scoped = (q: SQL, s: string): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''), s)) : chunk instanceof SQL ? scoped(chunk, s) : chunk), sql.empty());
    const executor = (c: NonNullable<typeof client>, s = schema): SqlExecutor => {
        const db = drizzle(c);
        return { execute: q => db.execute(scoped(q, s)) as unknown as Promise<Record<string, unknown>[]> };
    };
    const rows = (q: string, ...args: unknown[]) => client!.unsafe(local(q), args as never[]);
    const missing = `${schema}_missing`;

    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}; CREATE SCHEMA ${missing}`); created = true;
        await client!.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated;
            ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO anon, authenticated;`);
        await client!.unsafe(AUTH_USERS_DDL(schema));
        await client!.unsafe(local(readFileSync(path.join(ROOT, 'app/drizzle/0030_delegation_replay.sql'), 'utf8')));
    });
    afterAll(async () => {
        try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE; DROP SCHEMA ${missing} CASCADE`); }
        finally { await client?.end(); await other?.end(); }
    });

    const future = () => Math.floor(Date.now() / 1000) + 70;

    it('admits one jti exactly once across concurrent connections', async () => {
        const jti = randomUUID();
        const attempts = await Promise.all([...Array(6)].flatMap(() => [consumeDelegationJti(executor(client!), jti, future()),
            consumeDelegationJti(executor(other!), jti, future())]));
        expect(attempts.filter(Boolean)).toHaveLength(1);
        expect(await consumeDelegationJti(executor(client!), jti, future())).toBe(false);
        expect(await rows(`SELECT count(*)::int AS n FROM public.ezil_delegation_replay WHERE jti = $1`, jti)).toEqual([{ n: 1 }]);
        expect(await consumeDelegationJti(executor(client!), randomUUID(), future())).toBe(true);
    });

    it('fails closed when the ledger table is missing; nothing creates it', async () => {
        const error = await consumeDelegationJti(executor(client!, missing), randomUUID(), future()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(String((error as { cause?: Error }).cause?.message)).toMatch(/does not exist/);
        expect(await client!.unsafe(`SELECT to_regclass('${missing}.ezil_delegation_replay') AS t`)).toEqual([{ t: null }]);
    });

    it('keeps the ledger server-only: RLS on, no policies, nothing granted to anon or authenticated', async () => {
        const [meta] = await client!.unsafe(`SELECT c.relrowsecurity AS rls, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies,
            (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f')::int AS fks,
            has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS client_access
            FROM pg_class c WHERE c.oid = '${schema}.ezil_delegation_replay'::regclass`);
        expect(meta).toEqual({ rls: true, policies: 0, fks: 0, client_access: false });
        await expect(client!.begin(async c => { await c.unsafe('SET LOCAL ROLE authenticated'); return c.unsafe(`SELECT 1 FROM ${schema}.ezil_delegation_replay`); }))
            .rejects.toThrow(/permission denied/);
    });

    it('resolves only one verified, live account per identity, never by user metadata or email', async () => {
        const seed = async (fields: Record<string, unknown>) => {
            const id = randomUUID();
            const f: Record<string, unknown> = { email_confirmed_at: 'now()', ...fields };
            await rows(`INSERT INTO public.auth_users (id, deleted_at, banned_until, is_anonymous, email, email_confirmed_at, phone_confirmed_at,
                raw_app_meta_data, raw_user_meta_data) VALUES ($1, ${f.deleted_at ?? 'NULL'}, ${f.banned_until ?? 'NULL'}, ${f.is_anonymous ?? 'false'},
                $2, ${f.email_confirmed_at}, ${f.phone_confirmed_at ?? 'NULL'}, $3::jsonb, $4::jsonb)`.replace('public.auth_users', 'auth.users'),
            id, (f.email as string) ?? null, JSON.stringify(f.app ?? {}), JSON.stringify(f.user ?? {}));
            return id;
        };
        const db = executor(client!);
        const ok = await seed({});
        expect(await findDelegatedAccount(db, { issuer: 'supabase', subject: ok })).toMatchObject({ id: ok });
        const phoneOnly = await seed({ email_confirmed_at: 'NULL', phone_confirmed_at: 'now()' });
        expect(await findDelegatedAccount(db, { issuer: 'supabase', subject: phoneOnly })).toMatchObject({ id: phoneOnly });
        for (const [name, fields] of [['deleted', { deleted_at: 'now()' }], ['banned', { banned_until: `now() + interval '1 day'` }],
            ['anonymous', { is_anonymous: 'true' }], ['unconfirmed', { email_confirmed_at: 'NULL' }]] as const) {
            expect(await findDelegatedAccount(db, { issuer: 'supabase', subject: await seed(fields) }), name).toBeNull();
        }
        expect(await findDelegatedAccount(db, { issuer: 'supabase', subject: await seed({ banned_until: `now() - interval '1 day'` }) })).not.toBeNull();
        expect(await findDelegatedAccount(db, { issuer: 'supabase', subject: randomUUID() })).toBeNull();

        const linked = `auth0|${randomUUID()}`;
        const linkedId = await seed({ app: { auth0_sub: linked } });
        expect(await findDelegatedAccount(db, { issuer: 'auth0', subject: linked })).toMatchObject({ id: linkedId });
        const userMetaOnly = `auth0|${randomUUID()}`;
        await seed({ user: { auth0_sub: userMetaOnly } });
        expect(await findDelegatedAccount(db, { issuer: 'auth0', subject: userMetaOnly })).toBeNull();
        const emailOnly = `auth0|${randomUUID()}`;
        await seed({ email: emailOnly });
        expect(await findDelegatedAccount(db, { issuer: 'auth0', subject: emailOnly })).toBeNull();
        const duplicate = `auth0|${randomUUID()}`;
        await seed({ app: { auth0_sub: duplicate } });
        await seed({ app: { auth0_sub: duplicate } });
        expect(await findDelegatedAccount(db, { issuer: 'auth0', subject: duplicate })).toBeNull();
        const deletedLink = `auth0|${randomUUID()}`;
        await seed({ app: { auth0_sub: deletedLink }, deleted_at: 'now()' });
        expect(await findDelegatedAccount(db, { issuer: 'auth0', subject: deletedLink })).toBeNull();
    });
});
