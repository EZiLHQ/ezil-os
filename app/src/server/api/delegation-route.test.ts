/**
 * The real `/api/trpc` route, context and procedure gate for delegated computer reads, on disposable PostgreSQL
 * (`EZIL_PG_TEST_URL`). Only the Supabase cookie/Bearer client is mocked, so a cookie fallback is observable.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
    const url = process.env.EZIL_PG_TEST_URL;
    const schema = `delegation_route_test_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    // env.ts validates at import; these are inert placeholders (no live service is contacted).
    process.env.SUPABASE_DATABASE_URL ||= url ?? 'postgres://unused:unused@127.0.0.1:1/unused';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'anon-key-placeholder';
    return { url, schema, cookieUser: { current: null as null | { id: string } }, bearerUser: { current: null as null | { id: string } } };
});

vi.mock('server-only', () => ({}));
vi.mock('@/server/db', async () => {
    const [{ drizzle }, postgresModule, schemaModule, { SQL, StringChunk, sql }] = await Promise.all([
        import('drizzle-orm/postgres-js'), import('postgres'), import('@/server/db/schema'), import('drizzle-orm')]);
    const client = postgresModule.default(fixture.url ?? 'postgres://unused:unused@127.0.0.1:1/unused',
        { max: 8, prepare: false, onnotice: () => {}, connection: { search_path: fixture.schema } });
    const real = drizzle(client, { schema: schemaModule });
    const local = (q: string) => q.replaceAll('public.', `${fixture.schema}.`).replaceAll('auth.users', `${fixture.schema}.auth_users`);
    const scoped = (q: InstanceType<typeof SQL>): InstanceType<typeof SQL> => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const db = new Proxy(real, { get: (target, key, receiver) => key === 'execute'
        ? (q: InstanceType<typeof SQL>) => target.execute(scoped(q)) : Reflect.get(target, key, receiver) });
    return { db, __client: client };
});
const createClient = vi.fn(async () => ({
    auth: {
        getUser: async (jwt?: string) => jwt === undefined
            ? { data: { user: fixture.cookieUser.current }, error: null }
            : fixture.bearerUser.current && jwt === 'good-bearer' ? { data: { user: fixture.bearerUser.current }, error: null }
                : { data: { user: null }, error: { message: 'invalid' } },
    },
}));
vi.mock('@/utils/supabase/server', () => ({ createClient }));

import postgres from 'postgres';

import {
    AUTH_USERS_DDL, CLIENT_ID, delegationEnv, mcpInput, readClaims, readUrl, signAssertion, signingKey, type SigningKey,
} from './delegation.test-support';

const ROOT = path.resolve(__dirname, '../../../..');
const route = await import('@/app/api/trpc/[trpc]/route');
const { appRouter } = await import('./root');
const { createTRPCContext, createTRPCRouter, publicProcedure } = await import('./trpc');
const dbModule = await import('@/server/db') as unknown as { db: never; __client: ReturnType<typeof postgres> };

describe.skipIf(!fixture.url)('delegated computer reads through the real /api/trpc route', () => {
    const admin = fixture.url ? postgres(fixture.url, { max: 2, prepare: false, onnotice: () => {} }) : null;
    const s = fixture.schema;
    let key: SigningKey;
    let created = false;
    const owner = randomUUID();
    const stranger = randomUUID();
    const auth0Owner = randomUUID();
    const AUTH0_SUB = `auth0|${randomUUID()}`;
    const live = [randomUUID(), randomUUID()];
    const deleted = randomUUID();
    const foreign = randomUUID();

    beforeAll(async () => {
        await admin!.unsafe(`CREATE SCHEMA ${s}`); created = true;
        await admin!.unsafe(AUTH_USERS_DDL(s));
        await admin!.unsafe(`CREATE TABLE ${s}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL DEFAULT 'Computer',
            slot smallint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_opened_at timestamptz NULL, deleted_at timestamptz NULL, metadata jsonb NULL)`);
        await admin!.unsafe(readFileSync(path.join(ROOT, 'app/drizzle/0030_delegation_replay.sql'), 'utf8').replaceAll('public.', `${s}.`));
        await admin!.unsafe(`INSERT INTO ${s}.auth_users (id, email_confirmed_at, raw_app_meta_data) VALUES
            ('${owner}', now(), '{}'), ('${stranger}', now(), '{}'), ('${auth0Owner}', now(), '{"auth0_sub":"${AUTH0_SUB}"}')`);
        await admin!.unsafe(`INSERT INTO ${s}.ezil_computers (id, user_id, slot, deleted_at) VALUES
            ('${live[0]}', '${owner}', 1, NULL), ('${live[1]}', '${owner}', 2, NULL), ('${deleted}', '${owner}', 1, now()),
            ('${foreign}', '${stranger}', 1, NULL), ('${randomUUID()}', '${auth0Owner}', 1, NULL)`);
        key = await signingKey();
    });
    afterAll(async () => {
        try { if (created) await admin!.unsafe(`DROP SCHEMA ${s} CASCADE`); }
        finally { await admin?.end(); await dbModule.__client.end(); }
    });
    beforeEach(() => {
        createClient.mockClear();
        fixture.cookieUser.current = null;
        fixture.bearerUser.current = null;
        vi.unstubAllEnvs();
        for (const [name, value] of Object.entries({ ...delegationEnv([key]), EZIL_DELEGATED_COMPUTER_READS: 'enabled' })) vi.stubEnv(name, value);
        vi.spyOn(console, 'info').mockImplementation(() => {});
    });

    const ledger = async () => Number((await admin!.unsafe(`SELECT count(*)::int AS n FROM ${s}.ezil_delegation_replay`))[0]!.n);
    const call = async (url: string, assertion: string, init: RequestInit = {}) => {
        const res = await route.GET(new Request(url, { ...init, headers: { authorization: `EZiL-Delegation ${assertion}`, ...(init.headers ?? {}) } }));
        return { status: res.status, body: await res.json() as { result?: { data: { json: unknown } }; error?: { json: { data: { code: string } } } } };
    };
    const list = async (sub: string = owner, extra = {}) => signAssertion(key, readClaims(sub, 'computer.list', '', extra));
    const getFor = async (id: string, sub: string = owner) => {
        const input = mcpInput({ id });
        return { url: readUrl('computer.get', input), assertion: await signAssertion(key, readClaims(sub, 'computer.get', input)) };
    };

    it('lists only the caller\'s own live computers, and gets an own one with the exact MCP input serialisation', async () => {
        const res = await call(readUrl('computer.list'), await list());
        expect(res.status).toBe(200);
        expect((res.body.result!.data.json as { id: string }[]).map(c => c.id).sort()).toEqual([...live].sort());
        const own = await getFor(live[1]!);
        const got = await call(own.url, own.assertion);
        expect(got.status).toBe(200);
        expect(got.body.result!.data.json).toMatchObject({ id: live[1], userId: owner });
        expect(createClient).not.toHaveBeenCalled();
    });

    it('answers NOT_FOUND for a foreign or deleted computer', async () => {
        for (const id of [foreign, deleted]) {
            const g = await getFor(id);
            const res = await call(g.url, g.assertion);
            expect(res.status).toBe(404);
            expect(res.body.error!.json.data.code).toBe('NOT_FOUND');
        }
    });

    it('resolves a linked EZiL ID subject to its account', async () => {
        const res = await call(readUrl('computer.list'), await list(AUTH0_SUB, { idp_iss: 'https://id.ezil.work/' }));
        expect(res.status).toBe(200);
        expect((res.body.result!.data.json as { userId: string }[]).every(c => c.userId === auth0Owner)).toBe(true);
    });

    it('admits each assertion once; an unknown account still burns its jti', async () => {
        const assertion = await list();
        expect((await call(readUrl('computer.list'), assertion)).status).toBe(200);
        expect((await call(readUrl('computer.list'), assertion)).status).toBe(401);
        const before = await ledger();
        expect((await call(readUrl('computer.list'), await list(randomUUID()))).status).toBe(401);
        expect(await ledger()).toBe(before + 1);
        expect(createClient).not.toHaveBeenCalled();
    });

    it('rejects anything but one plain bound GET read before verification or I/O, with no cookie fallback', async () => {
        fixture.cookieUser.current = { id: owner }; // a cookie is present: it must never be used for a delegated request
        const own = await getFor(live[0]!);
        const listAssertion = await list();
        const before = await ledger();
        // A POST to a query path is refused by tRPC itself (405); a POST to a mutation path reaches the gate (401).
        for (const [procedure, status] of [['computer.list', 405], ['computer.create', 401], ['computer.getOrCreateDefault', 401]] as const) {
            const res = await route.POST(new Request(readUrl(procedure), { method: 'POST', headers: { authorization: `EZiL-Delegation ${listAssertion}`,
                'content-type': 'application/json' }, body: '{"json":{}}' }));
            expect(res.status, `POST ${procedure}`).toBe(status);
            expect(await res.text()).not.toContain('"result"');
        }
        const refused: [string, () => Promise<Response>][] = [
            ['GET with Content-Length', async () => route.GET(new Request(readUrl('computer.list'), { headers: { authorization: `EZiL-Delegation ${listAssertion}`, 'content-length': '2' } }))],
            ['batch', async () => route.GET(new Request(`${readUrl('computer.list,computer.get')}?batch=1`, { headers: { authorization: `EZiL-Delegation ${listAssertion}` } }))],
            ['batch flag', async () => route.GET(new Request(`${readUrl('computer.list')}?batch=1`, { headers: { authorization: `EZiL-Delegation ${listAssertion}` } }))],
            ['trailing path', async () => route.GET(new Request(`${readUrl('computer.list')}/`, { headers: { authorization: `EZiL-Delegation ${listAssertion}` } }))],
            ['encoded path', async () => route.GET(new Request(readUrl('computer%2Elist'), { headers: { authorization: `EZiL-Delegation ${listAssertion}` } }))],
            ['extra param', async () => route.GET(new Request(`${own.url}&extra=1`, { headers: { authorization: `EZiL-Delegation ${own.assertion}` } }))],
            ['duplicate input', async () => route.GET(new Request(`${own.url}&input=x`, { headers: { authorization: `EZiL-Delegation ${own.assertion}` } }))],
            ['tampered input', async () => route.GET(new Request(readUrl('computer.get', mcpInput({ id: live[1] })), { headers: { authorization: `EZiL-Delegation ${own.assertion}` } }))],
            ['missing input', async () => route.GET(new Request(readUrl('computer.get'), { headers: { authorization: `EZiL-Delegation ${own.assertion}` } }))],
            ['list assertion on get', async () => route.GET(new Request(own.url, { headers: { authorization: `EZiL-Delegation ${listAssertion}` } }))],
            ['other read path', async () => route.GET(new Request(readUrl('computer.systemInfo', mcpInput({ id: live[0] })), { headers: { authorization: `EZiL-Delegation ${own.assertion}` } }))],
        ];
        for (const [name, send] of refused) {
            const res = await send();
            expect(res.status, name).toBe(401);
        }
        expect(await ledger()).toBe(before);
        expect(createClient).not.toHaveBeenCalled();
        // The untouched assertions are still usable exactly once: nothing above consumed them.
        expect((await call(own.url, own.assertion)).status).toBe(200);
    });

    it('rejects while the gate is off or the pins are incomplete, with no cookie, ledger or account I/O', async () => {
        fixture.cookieUser.current = { id: owner };
        const before = await ledger();
        for (const [name, value] of [['EZIL_DELEGATED_COMPUTER_READS', ''], ['EZIL_DELEGATED_COMPUTER_READS', 'true'],
            ['EZIL_DELEGATION_PUBLIC_JWKS', ''], ['EZIL_DELEGATION_CLIENT_IDS', ''], ['EZIL_DELEGATION_AUDIENCE', 'https://other-os.test']] as const) {
            vi.stubEnv(name, value);
            expect((await call(readUrl('computer.list'), await list())).status, `${name}=${value}`).toBe(401);
            vi.stubEnv(name, name === 'EZIL_DELEGATED_COMPUTER_READS' ? 'enabled' : delegationEnv([key])[name as keyof ReturnType<typeof delegationEnv>]);
        }
        expect(await ledger()).toBe(before);
        expect(createClient).not.toHaveBeenCalled();
    });

    it('rejects when the replay ledger is unavailable, and never creates it', async () => {
        await admin!.unsafe(`ALTER TABLE ${s}.ezil_delegation_replay RENAME TO ezil_delegation_replay_hidden`);
        try {
            expect((await call(readUrl('computer.list'), await list())).status).toBe(401);
            expect(await admin!.unsafe(`SELECT to_regclass('${s}.ezil_delegation_replay') AS t`)).toEqual([{ t: null }]);
        } finally {
            await admin!.unsafe(`ALTER TABLE ${s}.ezil_delegation_replay_hidden RENAME TO ezil_delegation_replay`);
        }
    });

    it('confines an accepted assertion to its one read at the common public and protected base', async () => {
        const accepted = { db: dbModule.db, headers: new Headers(), user: { id: owner, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '' },
            delegation: { status: 'accepted' as const, call: { jti: randomUUID(), clientId: CLIENT_ID, userId: owner, procedure: 'computer.list' } } };
        const caller = appRouter.createCaller(accepted);
        await expect(caller.computer.list()).resolves.toHaveLength(2);
        for (const attempt of [() => caller.computer.get({ id: live[0]! }), () => caller.computer.systemInfo({ id: live[0]! } as never),
            () => caller.computer.create({}), () => caller.computer.getOrCreateDefault(), () => caller.computer.delete({ id: live[0]! } as never)]) {
            await expect(attempt()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        }
        const pub = createTRPCRouter({ ping: publicProcedure.query(() => 'pong') });
        await expect(pub.createCaller(accepted).ping()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(pub.createCaller({ ...accepted, delegation: { status: 'rejected' } }).ping()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(pub.createCaller({ db: dbModule.db, headers: new Headers(), user: null }).ping()).resolves.toBe('pong');
    });

    it('a context built without the actual request line rejects a delegation (no binding, no ledger write)', async () => {
        const before = await ledger();
        const ctx = await createTRPCContext({ headers: new Headers({ authorization: `EZiL-Delegation ${await list()}` }) });
        expect(ctx).toMatchObject({ user: null, delegation: { status: 'rejected' } });
        await expect(appRouter.createCaller(ctx).computer.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(await ledger()).toBe(before);
        expect(createClient).not.toHaveBeenCalled();
    });

    it('keeps ordinary cookie and Bearer behaviour', async () => {
        fixture.cookieUser.current = { id: owner };
        const cookie = await route.GET(new Request(readUrl('computer.list')));
        expect(cookie.status).toBe(200);
        fixture.cookieUser.current = null;
        fixture.bearerUser.current = { id: stranger };
        const bearer = await route.GET(new Request(readUrl('computer.list'), { headers: { authorization: 'Bearer good-bearer' } }));
        expect(((await bearer.json()) as { result: { data: { json: { id: string }[] } } }).result.data.json.map(c => c.id)).toEqual([foreign]);
        fixture.cookieUser.current = { id: owner };
        expect((await route.GET(new Request(readUrl('computer.list'), { headers: { authorization: 'Bearer bad' } }))).status).toBe(401);
        expect(createClient).toHaveBeenCalledTimes(3);
    });
});
