/**
 * EZiL MCP delegation end to end, on a real Postgres: the real `/api/trpc`
 * route handler, the real context + `delegationGate`, the real computer
 * router's ownership filters, the real `0022` replay table and the real
 * `auth.users` account rules. Only Supabase's cookie client is stubbed (to
 * prove a delegation never falls back to it).
 *
 * Needs a THROWAWAY database: it creates `auth.users`, `ezil_computers` and
 * the replay table. Never point it at a shared one.
 *   DELEGATION_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres
 */
import { createHash, randomUUID, webcrypto } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import superjson from 'superjson';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';

import { ensureTestSchema } from '../agent-session/pg-test-schema';

const MCP = 'https://mcp-staging.ezil.work';
const OS = 'https://os-staging.ezil.work';
const SUPABASE = 'https://btgqfmnzycdecmeyqubx.supabase.co';
const CLIENT = 'https://chatgpt.com/connector_platform_oauth_redirect';

const h = vi.hoisted(() => ({
    db: undefined as unknown,
    cookieUser: null as { id: string } | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/db', () => ({ get db() { return h.db; } }));
vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.cookieUser }, error: null }) } }),
}));

const URL_ = process.env.DELEGATION_TEST_DATABASE_URL;

describe.skipIf(!URL_)('EZiL MCP delegation on Postgres (real route, gate, router, ledger)', () => {
    let client: ReturnType<typeof postgres>;
    let signer: { kid: string; privateKey: webcrypto.CryptoKey };
    let handler: (req: Request) => Promise<Response>;
    let createTRPCContext: typeof import('./trpc').createTRPCContext;
    const alice = randomUUID();
    const bob = randomUUID();
    const ids = { a1: randomUUID(), a2: randomUUID(), aDeleted: randomUUID(), b1: randomUUID() };
    let delegationEnv: Record<string, string> = {};

    /** Signs like the MCP's `osQuery`: bound to `procedure` and the exact serialized input. */
    const sign = async (overrides: Record<string, unknown> = {}, procedure = 'computer.list', input?: unknown) => {
        const now = Math.floor(Date.now() / 1000);
        const serialized = input === undefined ? '' : JSON.stringify({ json: input });
        const claims = {
            iss: MCP, aud: OS, sub: alice, idp_iss: `${SUPABASE}/auth/v1`, client_id: CLIENT,
            scope: 'ezil:computers:read', proc: procedure, inp: createHash('sha256').update(serialized).digest('base64url'),
            jti: randomUUID(), iat: now, exp: now + 60, ...overrides,
        };
        const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
        const signingInput = `${b64({ alg: 'ES256', typ: 'ezil-delegation+jwt', kid: signer.kid })}.${b64(claims)}`;
        const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.privateKey, new TextEncoder().encode(signingInput));
        return `${signingInput}.${Buffer.from(sig).toString('base64url')}`;
    };

    /** Exactly what the MCP's `osQuery` sends. */
    const query = (procedure: string, assertion: string, input?: unknown, extra: Record<string, string> = {}) => {
        const url = new URL(`/api/trpc/${procedure}`, OS);
        if (input !== undefined) url.searchParams.set('input', JSON.stringify({ json: input }));
        return handler(new Request(url, { headers: { authorization: `EZiL-Delegation ${assertion}`, accept: 'application/json', ...extra } }));
    };
    const data = async (response: Response) => superjson.deserialize((await response.json()).result.data) as unknown;
    const code = async (response: Response) => (await response.json()).error?.json?.data?.code as string | undefined;

    beforeAll(async () => {
        client = postgres(URL_!, { max: 4, prepare: false, onnotice: () => {} });
        h.db = drizzle(client, { schema });
        // Supabase's auth.users, reduced to the columns the account rule reads.
        await ensureTestSchema(client);
        await client`INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
            (${alice}::uuid, 'alice@example.com', now()), (${bob}::uuid, 'bob@example.com', now())`;
        await client`INSERT INTO public.ezil_computers (id, user_id, name, slot, deleted_at) VALUES
            (${ids.a1}::uuid, ${alice}::uuid, 'Alice one', 1, NULL), (${ids.a2}::uuid, ${alice}::uuid, 'Alice two', 2, NULL),
            (${ids.aDeleted}::uuid, ${alice}::uuid, 'Alice gone', 1, now()), (${ids.b1}::uuid, ${bob}::uuid, 'Bob one', 1, NULL)`;

        const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
        signer = { kid: 'mcp-test', privateKey: pair.privateKey };
        delegationEnv = {
            NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
            EZIL_DELEGATION_ISSUER: MCP,
            EZIL_DELEGATION_AUDIENCE: OS,
            EZIL_DELEGATION_CLIENT_IDS: CLIENT,
            EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: 'mcp-test' }] }),
        };
        handler = (await import('@/app/api/trpc/[trpc]/route')).GET as (req: Request) => Promise<Response>;
        ({ createTRPCContext } = await import('./trpc'));
    }, 60_000);

    beforeEach(() => { for (const [key, value] of Object.entries(delegationEnv)) vi.stubEnv(key, value); });
    afterEach(() => { h.cookieUser = null; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    afterAll(async () => { await client?.end(); });

    it("computer.list returns only the person's own live computers", async () => {
        const response = await query('computer.list', await sign());
        expect(response.status).toBe(200);
        const rows = (await data(response)) as { id: string }[];
        expect(rows.map((row) => row.id).sort()).toEqual([ids.a1, ids.a2].sort());
    });

    it("computer.get on another person's computer is NOT_FOUND — the same answer as a missing id", async () => {
        const own = await query('computer.get', await sign({}, 'computer.get', { id: ids.a1 }), { id: ids.a1 });
        expect(own.status).toBe(200);
        expect(((await data(own)) as { id: string }).id).toBe(ids.a1);
        const foreign = await query('computer.get', await sign({}, 'computer.get', { id: ids.b1 }), { id: ids.b1 });
        const absent = { id: randomUUID() };
        const missing = await query('computer.get', await sign({}, 'computer.get', absent), absent);
        expect([foreign.status, await code(foreign)]).toEqual([404, 'NOT_FOUND']);
        expect([missing.status, await code(missing)]).toEqual([404, 'NOT_FOUND']);
        const deleted = await query('computer.get', await sign({}, 'computer.get', { id: ids.aDeleted }), { id: ids.aDeleted });
        expect(await code(deleted)).toBe('NOT_FOUND');
    });

    it('a replayed assertion is refused', async () => {
        const assertion = await sign();
        expect((await query('computer.list', assertion)).status).toBe(200);
        const replay = await query('computer.list', assertion);
        expect([replay.status, await code(replay)]).toEqual([401, 'UNAUTHORIZED']);
    });

    it('concurrent presentations of one assertion: the primary key lets exactly one through', async () => {
        const assertion = await sign();
        const statuses = await Promise.all(Array.from({ length: 12 }, () => query('computer.list', assertion).then((r) => r.status)));
        expect(statuses.filter((s) => s === 200)).toHaveLength(1);
        expect(statuses.filter((s) => s === 401)).toHaveLength(11);
    });

    it('an assertion is spent only on the call it names: another id, another procedure, or a batch is refused', async () => {
        const forA1 = await sign({}, 'computer.get', { id: ids.a1 });
        const swapped = await query('computer.get', forA1, { id: ids.a2 });
        expect([swapped.status, await code(swapped)]).toEqual([401, 'UNAUTHORIZED']);
        const forList = await sign();
        expect((await query('computer.progress', forList, { computerId: ids.a1 })).status).toBe(401);
        const extra = new URL('/api/trpc/computer.list', OS);
        extra.searchParams.set('batch', '1');
        const batched = await handler(new Request(extra, { headers: { authorization: `EZiL-Delegation ${await sign()}` } }));
        expect(batched.status).toBe(401);
    });

    it('a mutation is refused even with a valid delegation, and nothing changes', async () => {
        const url = new URL('/api/trpc/computer.rename', OS);
        const response = await handler(new Request(url, {
            method: 'POST',
            headers: { authorization: `EZiL-Delegation ${await sign()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ json: { id: ids.a1, name: 'pwned' } }),
        }));
        expect([response.status, await code(response)]).toEqual([401, 'UNAUTHORIZED']);
        const [row] = await client`SELECT name FROM public.ezil_computers WHERE id = ${ids.a1}::uuid`;
        expect(row!.name).toBe('Alice one');
    });

    it('a batch is refused as a whole, even when it starts with the bound procedure', async () => {
        const url = new URL('/api/trpc/computer.list,billing.summary', OS);
        url.searchParams.set('batch', '1');
        url.searchParams.set('input', JSON.stringify({}));
        const response = await handler(new Request(url, { headers: { authorization: `EZiL-Delegation ${await sign()}` } }));
        const results = (await response.json()) as { result?: unknown; error?: { json: { data: { code: string } } } }[];
        expect(results.map((entry) => entry.error?.json.data.code)).toEqual(['UNAUTHORIZED', 'UNAUTHORIZED']);
    });

    it('a rejected delegation never falls back to the session cookie', async () => {
        h.cookieUser = { id: alice };
        const now = Math.floor(Date.now() / 1000);
        const expired = await query('computer.list', await sign({ iat: now - 120, exp: now - 60 }));
        expect([expired.status, await code(expired)]).toEqual([401, 'UNAUTHORIZED']);
        const otherAudience = await query('computer.list', await sign({ aud: 'https://os.ezil.work' }));
        expect(otherAudience.status).toBe(401);
    });

    it('a bare or whitespace-only EZiL-Delegation header is refused, not read as absent (no cookie fallback)', async () => {
        h.cookieUser = { id: alice };
        for (const authorization of ['EZiL-Delegation', 'ezil-delegation', 'EZiL-Delegation   ']) {
            const response = await handler(new Request(new URL('/api/trpc/computer.list', OS), { headers: { authorization } }));
            expect([authorization, response.status]).toEqual([authorization, 401]);
        }
    });

    it('the jti row outlives exp, and the insert is a single atomic statement', async () => {
        const assertion = await sign();
        const { jti, exp } = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString()) as { jti: string; exp: number };
        expect((await query('computer.list', assertion)).status).toBe(200);
        const [row] = await client`SELECT extract(epoch FROM expires_at)::bigint AS until FROM public.ezil_delegation_replay WHERE jti = ${jti}::uuid` as { until: string }[];
        expect(Number(row!.until)).toBeGreaterThanOrEqual(exp);
    });

    it('a delegation for Alice is Alice, even with Bob\'s cookie on the request', async () => {
        h.cookieUser = { id: bob };
        const rows = (await data(await query('computer.list', await sign()))) as { id: string }[];
        expect(rows.map((row) => row.id).sort()).toEqual([ids.a1, ids.a2].sort());
    });

    it('outside /api/trpc (shell routes, RSC), a delegation header resolves to no user at all', async () => {
        h.cookieUser = { id: alice };
        const ctx = await createTRPCContext({ headers: new Headers({ authorization: `EZiL-Delegation ${await sign()}` }) });
        expect(ctx.user).toBeNull();
        expect(ctx.delegation).toEqual({ status: 'rejected' });
    });

    it('subjects that are not a verified, active account are refused (never auto-created)', async () => {
        const cases = {
            unconfirmed: randomUUID(), banned: randomUUID(), deleted: randomUUID(), anonymous: randomUUID(), absent: randomUUID(),
        };
        await client`INSERT INTO auth.users (id, email, email_confirmed_at, banned_until, deleted_at, is_anonymous) VALUES
            (${cases.unconfirmed}::uuid, 'u@example.com', NULL, NULL, NULL, false),
            (${cases.banned}::uuid, 'b@example.com', now(), now() + interval '1 day', NULL, false),
            (${cases.deleted}::uuid, 'd@example.com', now(), NULL, now(), false),
            (${cases.anonymous}::uuid, NULL, now(), NULL, NULL, true)`;
        for (const [label, sub] of Object.entries(cases)) {
            const response = await query('computer.list', await sign({ sub }));
            expect([label, response.status]).toEqual([label, 401]);
        }
        const [{ count }] = await client`SELECT count(*)::int AS count FROM auth.users WHERE id = ${cases.absent}::uuid` as { count: number }[];
        expect(count).toBe(0);
    });

    it('an EZiL ID subject reaches exactly its one linked account; unlinked or doubly linked is refused', async () => {
        // Unique per run: the throwaway database outlives a single run.
        const linked = `google-oauth2|${randomUUID().slice(0, 8)}`;
        const doubled = `auth0|doubled-${randomUUID().slice(0, 8)}`;
        await client`UPDATE auth.users SET raw_app_meta_data = ${JSON.stringify({ provider: 'email', auth0_sub: linked })}::jsonb WHERE id = ${alice}::uuid`;
        const twinA = randomUUID();
        const twinB = randomUUID();
        await client`INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data) VALUES
            (${twinA}::uuid, 'ta@example.com', now(), ${JSON.stringify({ auth0_sub: doubled })}::jsonb),
            (${twinB}::uuid, 'tb@example.com', now(), ${JSON.stringify({ auth0_sub: doubled })}::jsonb)`;
        const auth0 = { idp_iss: 'https://id.ezil.work/' };
        const rows = (await data(await query('computer.list', await sign({ ...auth0, sub: linked })))) as { id: string }[];
        expect(rows.map((row) => row.id).sort()).toEqual([ids.a1, ids.a2].sort());
        expect((await query('computer.list', await sign({ ...auth0, sub: 'google-oauth2|unlinked' }))).status).toBe(401);
        expect((await query('computer.list', await sign({ ...auth0, sub: doubled }))).status).toBe(401);
        // A multi-pipe enterprise subject maps through its exact stored link.
        const enterprise = `samlp|Customer1|${randomUUID().slice(0, 8)}`;
        const carol = randomUUID();
        await client`INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data) VALUES
            (${carol}::uuid, 'c@example.com', now(), ${JSON.stringify({ auth0_sub: enterprise })}::jsonb)`;
        expect((await query('computer.list', await sign({ ...auth0, sub: enterprise }))).status).toBe(200);
        // A prefix of it is a different subject, not a match.
        expect((await query('computer.list', await sign({ ...auth0, sub: enterprise.split('|').slice(0, 2).join('|') }))).status).toBe(401);
        // The Supabase issuer with Alice's Auth0 subject is not a uuid, so it never reaches the lookup.
        expect((await query('computer.list', await sign({ sub: linked }))).status).toBe(401);
    });

    it('without the replay table, every delegation is refused (fail closed)', async () => {
        await client`ALTER TABLE public.ezil_delegation_replay RENAME TO ezil_delegation_replay_hidden`;
        try {
            const response = await query('computer.list', await sign());
            expect(response.status).toBe(401);
        } finally {
            await client`ALTER TABLE public.ezil_delegation_replay_hidden RENAME TO ezil_delegation_replay`;
        }
    });

    it('with any delegation config missing, every delegation is refused', async () => {
        vi.stubEnv('EZIL_DELEGATION_CLIENT_IDS', '');
        expect((await query('computer.list', await sign())).status).toBe(401);
    });

    it('audit lines carry jti, client, subject, procedure and outcome — never the assertion', async () => {
        const lines: string[] = [];
        vi.spyOn(console, 'info').mockImplementation((line: unknown) => { lines.push(String(line)); });
        const assertion = await sign();
        await query('computer.list', assertion);
        await query('computer.list', assertion);
        const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((e) => e.event === 'ezil_delegation');
        expect(events).toEqual([
            expect.objectContaining({ client_id: CLIENT, sub: alice, user_id: alice, procedure: 'computer.list', outcome: 'ok' }),
            expect.objectContaining({ client_id: CLIENT, sub: alice, procedure: '<context>', outcome: 'rejected:replayed' }),
            expect.objectContaining({ procedure: 'computer.list', outcome: 'refused:rejected_assertion' }),
        ]);
        expect(lines.join('\n')).not.toContain(assertion.split('.')[2]!);
    });
});
