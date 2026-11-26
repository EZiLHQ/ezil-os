import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ consume: vi.fn(), account: vi.fn(), cookie: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: h.cookie }));
vi.mock('./delegation-store', () => ({ consumeDelegationJti: h.consume, findDelegatedAccount: h.account }));
vi.mock('@/server/api/root', async () => {
    const { createTRPCRouter, protectedProcedure, publicProcedure } = await import('./trpc');
    const { z } = await import('zod');
    return { appRouter: createTRPCRouter({
        computer: createTRPCRouter({ list: protectedProcedure.query(({ ctx }) => ({ owner: ctx.user.id })) }),
        agentSession: createTRPCRouter({
            send: protectedProcedure.input(z.object({ text: z.string() })).mutation(({ ctx, input }) => ({ owner: ctx.user.id, ...input })),
        }),
        account: createTRPCRouter({
            completeMcpConnection: publicProcedure.input(z.object({ decision: z.literal('deny') }))
                .mutation(({ ctx }) => ({ user: ctx.user, state: ctx.delegation?.status })),
        }),
    }) };
});

import { GET, POST } from '@/app/api/trpc/[trpc]/route';
import { AUTH0_ISSUER } from '@/server/auth/auth0';
import { delegationEnv, mcpInput, readClaims, readUrl, signAssertion, signingKey, type SigningKey } from './delegation.test-support';

const owner = randomUUID();
const issuer = 'https://connect.ezil.work';
const audience = 'https://os.ezil.work';
let key: SigningKey;
beforeAll(async () => { key = await signingKey(); });
beforeEach(() => {
    const pins = delegationEnv([key], { EZIL_DELEGATION_ISSUER: issuer, EZIL_DELEGATION_AUDIENCE: audience });
    for (const [name, value] of Object.entries({ ...pins, EZIL_OS_PUBLIC_ORIGIN: audience,
        EZIL_EDITOR_WORKER_ORIGIN: 'https://worker.example.test', CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.example.test',
        EZIL_EDITOR_WORKER_PROTOCOL: '2', EZIL_DELEGATED_EDITOR_SESSIONS: 'enabled', EZIL_EDITOR_BRIDGE: 'enabled',
        EZIL_DELEGATED_ONBOARDING: 'enabled', EZIL_DELEGATED_COMPUTER_READS: 'enabled',
        EZIL_MCP_IDENTITY_BOOTSTRAP_AUTH0_CLIENT_ID: 'synthetic-client-1234',
    })) vi.stubEnv(name, value);
    h.consume.mockReset().mockResolvedValue(true);
    h.account.mockReset().mockResolvedValue({ id: owner, createdAt: '2026-11-01T00:00:00Z' });
    h.cookie.mockReset().mockImplementation(() => { throw new Error('delegation must not use cookies'); });
});
afterEach(() => vi.unstubAllEnvs());

async function request(proc: string, scope: string, body: string, overrides: Record<string, unknown> = {}, sentBody = body) {
    const claims = readClaims(owner, 'computer.list', body, { iss: issuer, aud: audience, proc, scope, ...overrides });
    return new Request(readUrl(proc, undefined, audience), { method: 'POST',
        headers: { authorization: 'EZiL-Delegation ' + await signAssertion(key, claims), 'content-type': 'application/json' }, body: sentBody });
}

describe('real delegated request binding and context', () => {
    it('accepts production editor mutation bytes with the existing owner mapping', async () => {
        const response = await POST(await request('agentSession.send', 'ezil:sessions:write', mcpInput({ text: 'hello' })));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ result: { data: { json: { owner, text: 'hello' } } } });
        expect(h.account).toHaveBeenCalledTimes(1);
        expect(h.cookie).not.toHaveBeenCalled();
    });

    it('rejects changed bytes, wrong scope, wrong owner mapping and replay without cookie fallback', async () => {
        const body = mcpInput({ text: 'hello' });
        expect((await POST(await request('agentSession.send', 'ezil:sessions:write', body, {}, body + ' '))).status).toBe(401);
        expect((await POST(await request('agentSession.send', 'ezil:computers:read', body))).status).toBe(401);
        h.account.mockResolvedValueOnce(null);
        expect((await POST(await request('agentSession.send', 'ezil:sessions:write', body))).status).toBe(401);
        h.consume.mockResolvedValueOnce(false);
        expect((await POST(await request('agentSession.send', 'ezil:sessions:write', body))).status).toBe(401);
        expect(h.cookie).not.toHaveBeenCalled();
    });

    it('keeps computer reads working independently of the new editor gate', async () => {
        vi.stubEnv('EZIL_EDITOR_WORKER_PROTOCOL', '');
        const claims = readClaims(owner, 'computer.list', '', { iss: issuer, aud: audience });
        const response = await GET(new Request(readUrl('computer.list', undefined, audience), {
            headers: { authorization: 'EZiL-Delegation ' + await signAssertion(key, claims) },
        }));
        expect(response.status).toBe(200);
        expect((await POST(await request('agentSession.send', 'ezil:sessions:write', mcpInput({ text: 'hello' })))).status).toBe(401);
    });

    it('bootstraps only the Auth0 consent context and reserves replay for the full consent interval', async () => {
        const jti = randomUUID();
        const before = Math.floor(Date.now() / 1000);
        const response = await POST(await request('account.completeMcpConnection', 'ezil:account:bootstrap', mcpInput({ decision: 'deny' }), {
            idp_iss: AUTH0_ISSUER, sub: 'mcp-consent|' + jti, jti,
        }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ result: { data: { json: { user: null, state: 'bootstrap' } } } });
        expect(h.account).not.toHaveBeenCalled();
        expect(h.consume.mock.calls[0]![2]).toBeGreaterThanOrEqual(before + 600);
    });

    it('bounds signed POSTs before verification and rejects unsupported content types', async () => {
        const body = mcpInput({ text: 'x'.repeat(65_536) });
        expect((await POST(await request('agentSession.send', 'ezil:sessions:write', body))).status).toBe(413);
        const unsupported = await request('agentSession.send', 'ezil:sessions:write', mcpInput({ text: 'hello' }));
        unsupported.headers.set('content-type', 'text/plain');
        expect((await POST(unsupported)).status).toBe(415);
        expect(h.consume).not.toHaveBeenCalled();
    });
});
