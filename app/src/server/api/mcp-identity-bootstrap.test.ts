import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ verify: vi.fn(), ensure: vi.fn(), admin: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/auth0', () => ({ Auth0Error: class extends Error {}, verifyIdTokenForAudience: h.verify }));
vi.mock('@/server/auth/auth0-account', () => ({ ensureMcpAuth0Account: h.ensure }));
vi.mock('@/server/auth/supabase-admin', () => ({ createAdminClient: h.admin }));

import { completeMcpConnection, mcpIdentityProof } from './mcp-identity-bootstrap';

const jti = randomUUID();
const sub = 'auth0|synthetic-person';
const context = (subject = sub) => ({ db: {}, user: null,
    delegation: { status: 'bootstrap', type: 'mutation', call: { subject, jti, procedure: 'account.completeMcpConnection' } },
}) as Parameters<typeof completeMcpConnection>[0];
const allow = { decision: 'allow', nonce: 'n'.repeat(43), idToken: 'e30.e30.signature' } as const;

beforeEach(() => {
    vi.stubEnv('EZIL_OS_PUBLIC_ORIGIN', 'https://os.example.test');
    vi.stubEnv('EZIL_DELEGATION_AUDIENCE', 'https://os.example.test');
    vi.stubEnv('EZIL_DELEGATION_ISSUER', 'https://connect.example.test');
    vi.stubEnv('EZIL_DELEGATED_ONBOARDING', 'enabled');
    vi.stubEnv('EZIL_MCP_IDENTITY_BOOTSTRAP_AUTH0_CLIENT_ID', 'synthetic-client-1234');
    h.verify.mockReset().mockResolvedValue({ sub, email: 'person@example.test' });
    h.ensure.mockReset().mockResolvedValue(undefined);
    h.admin.mockReset().mockReturnValue({ auth: { admin: {} } });
});
afterEach(() => vi.unstubAllEnvs());

describe('MCP identity consent', () => {
    it('registers only the verified nonce/audience/subject and returns no identity or provider credential', async () => {
        expect(await completeMcpConnection(context(), allow)).toEqual({ ready: true });
        expect(h.verify).toHaveBeenCalledWith(allow.idToken, { nonce: allow.nonce, clientId: 'synthetic-client-1234', maxAgeSeconds: 600 });
        expect(h.admin).toHaveBeenCalledWith({ timeoutMs: 5_000 });
        expect(h.ensure).toHaveBeenCalledWith({}, {}, { sub, email: 'person@example.test' });
    });

    it('records denial without provider/account access only for its consent replay key', async () => {
        expect(await completeMcpConnection(context('mcp-consent|' + jti), { decision: 'deny' })).toEqual({ denied: true });
        await expect(completeMcpConnection(context(), { decision: 'deny' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(h.verify).not.toHaveBeenCalled();
        expect(h.ensure).not.toHaveBeenCalled();
        expect(h.admin).not.toHaveBeenCalled();
    });

    it('refuses mismatched or invalid proof and ordinary authenticated callers before account creation', async () => {
        h.verify.mockResolvedValueOnce({ sub: 'auth0|other', email: 'person@example.test' }).mockRejectedValueOnce(new Error('invalid'));
        for (let i = 0; i < 2; i++) await expect(completeMcpConnection(context(), allow)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(completeMcpConnection({ ...context(), user: { id: randomUUID() } } as never, allow))
            .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(h.ensure).not.toHaveBeenCalled();
        expect(h.admin).not.toHaveBeenCalled();
    });

    it('rejects extra identity fields and refuses with the onboarding gate off', async () => {
        expect(mcpIdentityProof.safeParse({ ...allow, userId: randomUUID() }).success).toBe(false);
        vi.stubEnv('EZIL_DELEGATED_ONBOARDING', '');
        await expect(completeMcpConnection(context(), allow)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(h.verify).not.toHaveBeenCalled();
    });
});
