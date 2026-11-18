/**
 * The native wrapper against the REAL shared core: published-shape ES256 assertions signed with throwaway keys
 * (`delegation.test-support.ts`), the real `verifyDelegation`, `parseDelegationConfig` and `inputDigest`. Only the
 * replay ledger and account lookup are injected spies, so every refusal below is proven to happen before either.
 */
import { randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { inputDigest, parseDelegationConfig } from '@/server/api/delegation-core';
import { CLIENT_ID, MCP_ORIGIN, OS_ORIGIN, SUPABASE_ISSUER, delegationEnv, signAssertion, signingKey, type SigningKey } from '@/server/api/delegation.test-support';
import { AUTH0_ISSUER } from '@/server/auth/issuer';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import { UNAVAILABLE_HOST_TRANSPORT } from '@/server/native-session/host-transport';

import { matchNativeRestRoute, nativeRestTranscript, type NativeProcedure } from './contract';
import { nativeDelegationVerifier } from './delegation-verifier';
import { handleNativeAuthRest } from './rest';

const OP = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const BODY = '{"kind":"renew","operationId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111"}';
const SCOPE = { write: 'ezil:native-sessions:write', read: 'ezil:native-sessions:read' };

let key: SigningKey;
let consumeJti: ReturnType<typeof vi.fn>;
let findAccount: ReturnType<typeof vi.fn>;
const sub = randomUUID();
beforeAll(async () => { key = await signingKey(); });
beforeEach(() => {
    consumeJti = vi.fn(async () => true);
    findAccount = vi.fn(async () => ({ id: sub, createdAt: '2026-01-01T00:00:00Z' }));
});

const verifier = () => nativeDelegationVerifier({
    config: () => parseDelegationConfig(delegationEnv([key]), AUTH0_ISSUER), now: () => Math.floor(Date.now() / 1000), consumeJti, findAccount,
});
const transcript = (method: 'GET' | 'POST', pathname: string, body = '') => nativeRestTranscript({ method, pathname }, body);
async function signed(procedure: NativeProcedure, serialized: string, overrides: Record<string, unknown> = {}): Promise<Headers> {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: MCP_ORIGIN, aud: OS_ORIGIN, sub, idp_iss: SUPABASE_ISSUER, client_id: CLIENT_ID,
        scope: procedure === 'nativeAuthorization.prepare' ? SCOPE.write : SCOPE.read, proc: procedure, inp: inputDigest(serialized),
        jti: randomUUID(), iat: now, exp: now + 60, ...overrides };
    return new Headers({ authorization: `EZiL-Delegation ${await signAssertion(key, claims)}` });
}
const allowed = new Set([CLIENT_ID]);
const noIo = () => { expect(consumeJti).not.toHaveBeenCalled(); expect(findAccount).not.toHaveBeenCalled(); };

describe('native wrapper over the real shared core', () => {
    it('accepts the exact signed transcript once, returning the core\'s original verified identity', async () => {
        const input = transcript('POST', '/api/mcp/native-auth-intents', BODY);
        const headers = await signed('nativeAuthorization.prepare', input);
        expect(await verifier().verify({ headers, procedure: 'nativeAuthorization.prepare', serializedInput: input, allowedClientIds: allowed }))
            .toEqual({ ok: true, caller: { userId: sub, idpIssuer: SUPABASE_ISSUER, subject: sub, clientId: CLIENT_ID, scope: [SCOPE.write] } });
        expect(consumeJti).toHaveBeenCalledTimes(1);
        expect(findAccount).toHaveBeenCalledWith({ issuer: 'supabase', subject: sub });
        consumeJti.mockResolvedValueOnce(false);
        expect(await verifier().verify({ headers, procedure: 'nativeAuthorization.prepare', serializedInput: input, allowedClientIds: allowed }))
            .toEqual({ ok: false, status: 401, code: 'replayed' });
    });

    it('binds the Root-pinned Unicode POST vector: the core digest of our transcript is the pinned inp', () => {
        const raw = '{"kind":"create","operationId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","computerId":"33333333-3333-4333-8333-333333333333","instructionRevision":1,"instructionDigest":"sha256:79a8924631d435fa4b3c887f6cf1db91527191a15f296ff3c102179524501898","instruction":"Build a café\\n"}';
        expect(inputDigest(transcript('POST', '/api/mcp/native-auth-intents', raw))).toBe('ILqNNwiHTt6gcyAH1ASaWAXzpKmXJsHdnbipFnfqivQ');
        expect(inputDigest(transcript('GET', `/api/mcp/native-auth-intents/${OP}`))).toBe('KPP3Wa7Aiid1LBiGYeVC_14Vrvlr743HxbvgLvcefsE');
    });

    it('refuses a raw body, path selector or method tamper before any JTI or account I/O', async () => {
        const post = transcript('POST', '/api/mcp/native-auth-intents', BODY);
        const postHeaders = await signed('nativeAuthorization.prepare', post);
        for (const tampered of [transcript('POST', '/api/mcp/native-auth-intents', `${BODY} `),
            transcript('POST', '/api/mcp/native-auth-intents', BODY.replace(OP, OTHER))]) {
            expect(await verifier().verify({ headers: postHeaders, procedure: 'nativeAuthorization.prepare', serializedInput: tampered, allowedClientIds: allowed }))
                .toEqual({ ok: false, status: 401, code: 'binding' });
        }
        const get = transcript('GET', `/api/mcp/native-auth-intents/${OP}`);
        const getHeaders = await signed('nativeAuthorization.get', get);
        expect(await verifier().verify({ headers: getHeaders, procedure: 'nativeAuthorization.get',
            serializedInput: transcript('GET', `/api/mcp/native-auth-intents/${OTHER}`), allowedClientIds: allowed })).toMatchObject({ ok: false, code: 'binding' });
        // Signed-method tamper: the token binds a GET transcript of the same path and body, presented as the POST.
        const asGet = `EZIL-NATIVE-REST/1\nGET\n/api/mcp/native-auth-intents\n${BODY}`;
        const methodHeaders = await signed('nativeAuthorization.prepare', asGet);
        expect(await verifier().verify({ headers: methodHeaders, procedure: 'nativeAuthorization.prepare', serializedInput: post, allowedClientIds: allowed }))
            .toEqual({ ok: false, status: 401, code: 'binding' });
        // Same path signed for the intent read, presented as the session read: another fixed procedure.
        expect(await verifier().verify({ headers: getHeaders, procedure: 'nativeSession.get', serializedInput: get, allowedClientIds: allowed }))
            .toMatchObject({ ok: false, code: 'binding' });
        noIo();
    });

    it('refuses a wrong scope (including the computer read scope) and a procedure outside the native policy before I/O', async () => {
        const input = transcript('POST', '/api/mcp/native-auth-intents', BODY);
        for (const scope of [SCOPE.read, 'ezil:computers:read', `${SCOPE.read} ${SCOPE.write}`]) {
            const headers = await signed('nativeAuthorization.prepare', input, { scope });
            expect(await verifier().verify({ headers, procedure: 'nativeAuthorization.prepare', serializedInput: input, allowedClientIds: allowed }))
                .toEqual({ ok: false, status: 403, code: 'scope' });
        }
        const computer = await signed('nativeAuthorization.prepare', input, { proc: 'computer.list', scope: 'ezil:computers:read' });
        expect(await verifier().verify({ headers: computer, procedure: 'nativeAuthorization.prepare', serializedInput: input, allowedClientIds: allowed }))
            .toMatchObject({ ok: false, status: 403, code: 'scope' });
        noIo();
    });

    it('intersects the shared client ids with the native allowlist before verification: a refused client never reaches JTI or account', async () => {
        const input = transcript('GET', `/api/mcp/native-sessions/${OP}`);
        const headers = await signed('nativeSession.get', input);
        for (const clients of [new Set<string>(), new Set(['another-client'])]) {
            expect(await verifier().verify({ headers, procedure: 'nativeSession.get', serializedInput: input, allowedClientIds: clients }))
                .toEqual({ ok: false, status: 403, code: 'client' });
        }
        noIo();
    });

    it('through the REST handler: tampered requests are refused before any ledger, account or database read', async () => {
        const db = { execute: vi.fn(() => { throw new Error('database touched'); }), transaction: vi.fn(() => { throw new Error('database touched'); }) };
        const env = { EZIL_NATIVE_AUTH_INTENTS: '1', EZIL_NATIVE_SESSIONS: '1', EZIL_NATIVE_SESSIONS_ORIGIN: OS_ORIGIN, EZIL_NATIVE_AUTH_CLIENT_IDS: CLIENT_ID };
        const deps = { env, db: db as unknown as NativeAuthorityDb, verifier: verifier(), hostTransport: UNAVAILABLE_HOST_TRANSPORT, now: () => Date.now() };
        const route = matchNativeRestRoute('GET', `${OS_ORIGIN}/api/mcp/native-auth-intents/${OP}`)!;
        const headers = await signed('nativeAuthorization.get', transcript('GET', route.pathname));
        for (const req of [new Request(`${OS_ORIGIN}/api/mcp/native-auth-intents/${OTHER}`, { headers }),
            new Request(`${OS_ORIGIN}/api/mcp/native-sessions/${OP}`, { headers })]) {
            expect((await handleNativeAuthRest(req, deps)).status).toBe(401);
        }
        const postHeaders = await signed('nativeAuthorization.prepare', transcript('POST', '/api/mcp/native-auth-intents', BODY));
        postHeaders.set('content-type', 'application/json');
        const res = await handleNativeAuthRest(new Request(`${OS_ORIGIN}/api/mcp/native-auth-intents`, { method: 'POST', body: `${BODY}\n`, headers: postHeaders }), deps);
        expect(res.status).toBe(401);
        expect(db.execute).not.toHaveBeenCalled();
        expect(db.transaction).not.toHaveBeenCalled();
        noIo();
    });
});
