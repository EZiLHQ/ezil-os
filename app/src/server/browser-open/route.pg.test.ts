import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureTestSchema } from '../agent-session/pg-test-schema';
import { inputDigest } from '../api/delegation-auth';
import { delegationEnv, readClaims, signAssertion, signingKey, type SigningKey } from '../api/delegation.test-support';
import { BROWSER_STAGING_MCP, BROWSER_STAGING_OS, BROWSER_STAGING_WORKER } from '../browser-observe/contract';
import { BROWSER_OPEN_PROCEDURE, BROWSER_OPEN_SCOPE } from './contract';

const fixture = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/db', () => ({ get db() { return fixture.db; } }));

const databaseUrl = process.env.DELEGATION_TEST_DATABASE_URL;
const owner = randomUUID();
const stranger = randomUUID();
const computer = randomUUID();
const routePath = '/api/mcp/browser-sessions/' + computer + '/open-url';
const fixtureOrigin = 'https://project-fixture.example';
const fixtureUrl = fixtureOrigin + '/ready';

describe.skipIf(!databaseUrl)('staging Browser open route with signed delegation and real placement', () => {
    let client: ReturnType<typeof postgres>;
    let signer: SigningKey;
    let post: (request: Request) => Promise<Response>;

    const forwarded = vi.fn(async (_url: URL, init: RequestInit) => {
        const input = JSON.parse(String(init.body));
        return Response.json({ ok: true, runId: input.requestId, finalUrl: fixtureUrl + '?private=fixture#fragment',
            title: '\nFixture', httpStatus: 200, elapsedMs: 12 });
    });

    beforeAll(async () => {
        client = postgres(databaseUrl!, { max: 4, prepare: false, onnotice: () => {} });
        fixture.db = drizzle(client);
        await ensureTestSchema(client);
        const [placement] = await client.unsafe("SELECT to_regclass('public.ezil_computer_placements') AS name");
        if (!placement?.name) {
            for (const file of ['0001_compute_placement', '0002_image_rebase']) {
                const source = new URL('../../../../docs/aws-computers/sql/' + file + '.sql.txt', import.meta.url);
                await client.unsafe(readFileSync(source, 'utf8'));
            }
        }
        await client.unsafe("INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1::uuid,'browser-owner@example.invalid',now()),($2::uuid,'browser-other@example.invalid',now())", [owner, stranger]);
        await client.unsafe('INSERT INTO public.ezil_computers (id,user_id,slot) VALUES ($1::uuid,$2::uuid,1)', [computer, owner]);
        await client.unsafe("INSERT INTO public.ezil_computer_placements (computer_id,owner_user_id,provider,workspace_store,generation,lease_epoch,state,updated_at) VALUES ($1::uuid,$2::uuid,'cloudflare','r2',0,0,'RUNNING',now())", [computer, owner]);
        signer = await signingKey();
        post = (await import('@/app/api/mcp/browser-sessions/[computerId]/open-url/route')).POST;
    });

    beforeEach(() => {
        for (const [key, value] of Object.entries({
            ...delegationEnv([signer], { EZIL_DELEGATION_ISSUER: BROWSER_STAGING_MCP, EZIL_DELEGATION_AUDIENCE: BROWSER_STAGING_OS }),
            EZIL_DELEGATED_BROWSER_OPEN_URL: 'enabled', EZIL_BROWSER_TEST_ALLOWED_ORIGINS: fixtureOrigin,
            CLOUDFLARE_GUACAMOLE_WORKER_URL: BROWSER_STAGING_WORKER, CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'synthetic-worker-key',
        })) vi.stubEnv(key, value);
        forwarded.mockClear();
        vi.stubGlobal('fetch', forwarded);
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
    afterAll(async () => { await client?.end(); });

    const body = (url = fixtureUrl) => JSON.stringify({ requestId: randomUUID(), url });
    async function signed(raw = body(), user = owner, scope = BROWSER_OPEN_SCOPE, issuer = BROWSER_STAGING_MCP) {
        const material = ['EZIL-BROWSER-OPEN-URL/1', 'POST', routePath, raw].join('\n');
        const assertion = await signAssertion(signer, readClaims(user, 'computer.list', '', {
            iss: issuer, aud: BROWSER_STAGING_OS, proc: BROWSER_OPEN_PROCEDURE, scope, inp: inputDigest(material),
        }));
        return (payload = raw) => new Request(BROWSER_STAGING_OS + routePath, { method: 'POST', body: payload,
            headers: { authorization: 'EZiL-Delegation ' + assertion, 'content-type': 'application/json' } });
    }

    it('requires canonical staging pins, exact navigation scope and bytes, and the current owner', async () => {
        const authorized = await signed();
        vi.stubEnv('EZIL_DELEGATED_BROWSER_OPEN_URL', undefined);
        expect((await post(authorized())).status).toBe(404);
        vi.stubEnv('EZIL_DELEGATED_BROWSER_OPEN_URL', 'enabled');
        vi.stubEnv('EZIL_DELEGATION_ISSUER', 'https://other-stage.example');
        expect((await post((await signed(body(), owner, BROWSER_OPEN_SCOPE, 'https://other-stage.example'))())).status).toBe(404);
        vi.stubEnv('EZIL_DELEGATION_ISSUER', BROWSER_STAGING_MCP);
        for (const scope of ['ezil:browser:read', 'ezil:sessions:write', 'ezil:computers:read']) {
            expect((await post((await signed(body(), owner, scope))())).status).toBe(401);
        }
        expect((await post(authorized(body()))).status).toBe(401);
        expect((await post((await signed(body(), stranger))())).status).toBe(404);
        const outsideProject = await signed(body('https://other.example/'));
        expect((await post(outsideProject())).status).toBe(403);
        expect(forwarded).not.toHaveBeenCalled();

        const response = await post(authorized());
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, finalUrl: fixtureUrl, title: 'Fixture', httpStatus: 200 });
        expect(forwarded).toHaveBeenCalledOnce();
        const [endpoint, sent] = forwarded.mock.calls[0]!;
        expect(endpoint.origin).toBe(BROWSER_STAGING_WORKER);
        expect(endpoint.pathname).toMatch(/^\/sandbox\/guac-[a-z0-9-]+\/browser-open-url$/);
        expect(sent).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
        expect(JSON.parse(String(sent.body))).toMatchObject({ url: fixtureUrl, timeoutMs: 15000, binding: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect((await post(authorized())).status).toBe(401);
        expect(forwarded).toHaveBeenCalledOnce();
    });
});
