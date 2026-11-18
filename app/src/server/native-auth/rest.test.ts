import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeOperation } from '@/server/native-session/authority';

vi.mock('@/server/native-session/authority', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/native-session/authority')>();
    return { ...actual, lookupNativeOperation: vi.fn(), nativeComputerOwnedNow: vi.fn(), readNativeSessionStatus: vi.fn() };
});
vi.mock('./store', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./store')>();
    return { ...actual, lookupNativeIntent: vi.fn(), insertNativeIntent: vi.fn(), deriveRenewNativeIntent: vi.fn(), decideNativeIntent: vi.fn(),
        blockApprovedNativeIntent: vi.fn() };
});

const authority = await import('@/server/native-session/authority');
const store = await import('./store');
const { handleNativeAuthRest, productionNativeAuthRestDeps } = await import('./rest');
const { nativeInstructionDigest, nativeIntentInputDigest, nativeRestTranscript } = await import('./contract');
type Deps = import('./rest').NativeAuthRestDeps;
type Intent = import('./store').NativeIntent;
type Verifier = import('./delegation').NativeDelegationVerifier;

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const ORIGIN = 'https://os-staging.ezil.work';
const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const OP = '22222222-2222-4222-8222-222222222222';
const CLIENT = 'ezil-mcp-staging';
const INSTRUCTION = 'SECRET-TASK: refactor the parser\n';
const DIGEST = nativeInstructionDigest(INSTRUCTION);
const ENV = {
    EZIL_NATIVE_AUTHORIZATION: 'enabled', EZIL_NATIVE_AUTHORIZATION_ISSUER: 'fixture', EZIL_NATIVE_AUTHORIZATION_AUDIENCE: 'fixture',
    EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY_ID: 'fixture', EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY: 'fixture',
    EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL: 'fixture', EZIL_NATIVE_AUTHORIZATION_SERVICE_EXPIRES_AT: 'fixture',
    EZIL_NATIVE_GRANT_WRAPPING_KEY_ID: 'fixture', EZIL_NATIVE_GRANT_WRAPPING_KEY: 'fixture', EZIL_NATIVE_AUTH_INTENTS: '1', EZIL_NATIVE_SESSIONS: '1', EZIL_NATIVE_SESSIONS_ORIGIN: ORIGIN, EZIL_NATIVE_AUTH_CLIENT_IDS: `${CLIENT},other-client` };
const CREATE = { kind: 'create', operationId: OP, sessionId: SESSION, computerId: COMPUTER, instructionRevision: 1, instructionDigest: DIGEST, instruction: INSTRUCTION };
const CALLER = { userId: USER, idpIssuer: 'https://id.ezil.work/', subject: 'auth0|abc', clientId: CLIENT,
    scope: ['ezil:native-sessions:write ezil:native-sessions:read'] };

const mocked = {
    lookupIntent: vi.mocked(store.lookupNativeIntent), insert: vi.mocked(store.insertNativeIntent), derive: vi.mocked(store.deriveRenewNativeIntent),
    decide: vi.mocked(store.decideNativeIntent), blockApproved: vi.mocked(store.blockApprovedNativeIntent),
    lookupOp: vi.mocked(authority.lookupNativeOperation), owned: vi.mocked(authority.nativeComputerOwnedNow),
    status: vi.mocked(authority.readNativeSessionStatus),
};

function intent(overrides: Partial<Intent> = {}): Intent {
    return {
        userId: USER, operationId: OP, kind: 'create', sessionId: SESSION, computerId: COMPUTER, instructionRevision: 1, instructionDigest: DIGEST,
        instruction: INSTRUCTION, inputDigest: nativeIntentInputDigest({ ...CREATE, kind: 'create', instructionRevision: 1 }), clientId: CLIENT,
        idpIssuer: CALLER.idpIssuer, subject: CALLER.subject, scope: 'ezil:native-sessions:write', state: 'required', reason: null, terms: null,
        createdAt: new Date(NOW), expiresAt: new Date(NOW + 300_000), decidedAt: null, ...overrides,
    };
}

function op(state: NativeOperation['state'], overrides: Partial<NativeOperation> = {}): NativeOperation {
    return {
        userId: USER, operationId: OP, kind: 'create', sessionId: SESSION, computerId: COMPUTER, instructionRevision: '1', instructionDigest: DIGEST,
        taskRef: `native-task:${OP}`, requestDigest: `sha256:${'a'.repeat(64)}`, placement: { generation: '1', leaseEpoch: '1', instanceId: 'i-0123456789abcdef0',
            fenceToken: '66666666-6666-4666-8666-666666666666' }, state, reason: null, grantId: null, grantExpiresAt: null,
        createdAt: new Date(NOW), updatedAt: new Date(NOW), ...overrides,
    };
}

const throwing = (name: string) => vi.fn(() => { throw new Error(`unexpected ${name}`); });

/** A verifier double that accepts only the exact transcript the request is expected to carry. */
function verifierFor(expected: () => string | null, caller = CALLER): Verifier & { verify: ReturnType<typeof vi.fn> } {
    return {
        verify: vi.fn(async ({ serializedInput }) => serializedInput === expected()
            ? { ok: true as const, caller } : { ok: false as const, status: 401 as const, code: 'inp_mismatch' }),
    };
}

let signed: string | null;
function deps(overrides: Partial<Deps> = {}) {
    const d: Deps = {
        env: ENV, db: { execute: throwing('db.execute'), transaction: throwing('db.transaction') } as unknown as Deps['db'],
        verifier: verifierFor(() => signed),
        hostTransport: { available: true, supportsKind: kind => kind === 'create', checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: throwing('deliver') }, now: () => NOW, ...overrides,
    };
    return d;
}

const post = (body: unknown, url = `${ORIGIN}/api/mcp/native-auth-intents`, headers: Record<string, string> = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    signed = nativeRestTranscript({ method: 'POST', pathname: '/api/mcp/native-auth-intents' }, raw);
    return new Request(url, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', authorization: 'EZiL-Delegation sig', ...headers } });
};
const get = (path: string) => {
    signed = nativeRestTranscript({ method: 'GET', pathname: path }, '');
    return new Request(`${ORIGIN}${path}`, { headers: { authorization: 'EZiL-Delegation sig' } });
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- arbitrary JSON response bodies under test
type Json = Record<string, any>;
const read = async (res: Response) => ({ status: res.status, body: await res.json() as Json, cache: res.headers.get('cache-control') });

let logs: unknown[];
beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...a) => { logs.push(a); });
    mocked.lookupIntent.mockResolvedValue(null);
    mocked.lookupOp.mockResolvedValue(null);
    mocked.owned.mockResolvedValue(true);
    mocked.insert.mockImplementation(async (_db, _user, _input, _computer, inputDigest) => ({ kind: 'inserted', intent: intent({ inputDigest }) }));
});

const RECEIPT_KEYS = ['authorization', 'capabilities', 'computerId', 'kind', 'operation', 'operationId', 'sessionId'];
const OPERATION_KEYS = ['computerId', 'grantExpiresAt', 'grantId', 'kind', 'operationId', 'reason', 'sessionId', 'settled', 'state'];

describe('gates and readiness before any ledger read', () => {
    it('answers 404 while off, touching nothing', async () => {
        const all = new Proxy({}, { get: (_t, key) => { throw new Error(`touched ${String(key)}`); } });
        for (const env of [{}, { ...ENV, EZIL_NATIVE_AUTH_INTENTS: 'true' }, { ...ENV, EZIL_NATIVE_SESSIONS: undefined }]) {
            const res = await handleNativeAuthRest(post(CREATE), { env, db: all, verifier: all, hostTransport: all, now: all } as unknown as Deps);
            expect(await read(res)).toMatchObject({ status: 404, body: { error: { code: 'native_auth_disabled' } } });
        }
    });

    it('answers 503 with no verifier, before any ledger or account read', async () => {
        for (const req of [post(CREATE), get(`/api/mcp/native-auth-intents/${OP}`), get(`/api/mcp/native-sessions/${SESSION}`)]) {
            expect(await read(await handleNativeAuthRest(req, deps({ verifier: null })))).toMatchObject({ status: 503,
                body: { error: { code: 'native_auth_blocked', reason: 'delegation_verifier_unavailable' } } });
        }
        for (const fn of Object.values(mocked)) expect(fn).not.toHaveBeenCalled();
    });

    it('production wiring uses the real shared-core wrapper: without the shared pins it rejects with zero DB I/O', async () => {
        const prod = { ...productionNativeAuthRestDeps(deps().db), env: ENV };
        expect(prod.verifier).not.toBeNull();
        expect(prod.hostTransport.supportsKind('create')).toBe(false);
        for (const req of [post(CREATE), get(`/api/mcp/native-auth-intents/${OP}`), get(`/api/mcp/native-sessions/${SESSION}`)]) {
            expect(await read(await handleNativeAuthRest(req, prod))).toMatchObject({ status: 401, body: { error: { code: 'delegation_refused' } } });
        }
        for (const fn of Object.values(mocked)) expect(fn).not.toHaveBeenCalled();
    });

    it('blocks a missing origin or client policy before verification', async () => {
        for (const [env, reason] of [[{ ...ENV, EZIL_NATIVE_SESSIONS_ORIGIN: undefined }, 'origin_unconfigured'],
            [{ ...ENV, EZIL_NATIVE_AUTH_CLIENT_IDS: '' }, 'client_policy_unconfigured'], [{ ...ENV, EZIL_NATIVE_AUTH_CLIENT_IDS: 'a b' }, 'client_policy_unconfigured']] as const) {
            const d = deps({ env });
            expect((await read(await handleNativeAuthRest(post(CREATE), d))).body.error).toMatchObject({ code: 'native_auth_blocked', reason });
            expect((d.verifier as ReturnType<typeof verifierFor>).verify).not.toHaveBeenCalled();
        }
    });

    it('refuses non-canonical routes as not_found before verification', async () => {
        const d = deps();
        for (const req of [new Request(`${ORIGIN}/api/mcp/native-auth-intents?x=1`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
            new Request(`${ORIGIN}/api/mcp/native-auth-intents/ABCDEF22-2222-4222-8222-222222222222`), new Request(`${ORIGIN}/api/mcp/native-sessions/${SESSION}/`),
            new Request(`${ORIGIN}/api/mcp/native-auth-intents/${OP}`, { method: 'DELETE' })]) {
            expect(await read(await handleNativeAuthRest(req, d))).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
        }
        expect((d.verifier as ReturnType<typeof verifierFor>).verify).not.toHaveBeenCalled();
    });
});

describe('signed input binding', () => {
    it('hands the verifier the complete transcript, the request headers, the fixed procedure and the client allowlist', async () => {
        const d = deps();
        const req = post(CREATE);
        expect((await handleNativeAuthRest(req, d)).status).toBe(200);
        const call = (d.verifier as ReturnType<typeof verifierFor>).verify.mock.calls[0]![0];
        expect(call.procedure).toBe('nativeAuthorization.prepare');
        expect(call.serializedInput).toBe(`EZIL-NATIVE-REST/1\nPOST\n/api/mcp/native-auth-intents\n${JSON.stringify(CREATE)}`);
        expect(call.headers).toBe(req.headers);
        expect([...call.allowedClientIds]).toEqual([CLIENT, 'other-client']);
    });

    it('refuses a tampered body, path id or method at verification, before any ledger or account read', async () => {
        const d = deps();
        const tampered: Request[] = [];
        post(CREATE); const signedCreate = signed;
        tampered.push(new Request(`${ORIGIN}/api/mcp/native-auth-intents`, { method: 'POST', body: JSON.stringify({ ...CREATE, sessionId: COMPUTER }),
            headers: { 'content-type': 'application/json' } }));
        get(`/api/mcp/native-auth-intents/${OP}`); const signedGet = signed;
        for (const req of tampered) {
            signed = signedCreate;
            expect((await read(await handleNativeAuthRest(req, d))).body.error.code).toBe('delegation_refused');
        }
        signed = signedGet;
        expect((await handleNativeAuthRest(new Request(`${ORIGIN}/api/mcp/native-auth-intents/${SESSION}`), d)).status).toBe(401);
        expect((await handleNativeAuthRest(new Request(`${ORIGIN}/api/mcp/native-sessions/${OP}`), d)).status).toBe(401);
        for (const fn of Object.values(mocked)) expect(fn).not.toHaveBeenCalled();
    });

    it('requires the procedure scope and an allowed client on the verified caller', async () => {
        for (const [caller, code] of [[{ ...CALLER, scope: ['ezil:native-sessions:read'] }, 'scope_missing'],
            [{ ...CALLER, scope: [] }, 'scope_missing'], [{ ...CALLER, clientId: 'stranger' }, 'client_not_allowed']] as const) {
            const d = deps({ verifier: verifierFor(() => signed, caller as typeof CALLER) });
            expect(await read(await handleNativeAuthRest(post(CREATE), d))).toMatchObject({ status: 403, body: { error: { code } } });
        }
        const reader = deps({ verifier: verifierFor(() => signed, { ...CALLER, scope: ['ezil:native-sessions:write'] }) });
        expect((await handleNativeAuthRest(get(`/api/mcp/native-auth-intents/${OP}`), reader)).status).toBe(403);
        expect(mocked.lookupIntent).not.toHaveBeenCalled();
    });
});

describe('prepare', () => {
    it('stores a new intent and answers the flat 200 receipt with a URL carrying only the operation id', async () => {
        const res = await read(await handleNativeAuthRest(post(CREATE), deps()));
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(RECEIPT_KEYS);
        expect(res.body).toEqual({
            operationId: OP, kind: 'create', sessionId: SESSION, computerId: COMPUTER,
            authorization: { state: 'required', expiresAt: new Date(NOW + 300_000).toISOString(), authorizationUrl: `${ORIGIN}/native/authorize/${OP}`, reason: null },
            operation: null,
            capabilities: { create: false, renew: false, status: true, send: false, prompts: false, answer: false, cancel: false },
        });
        expect(res.cache).toContain('no-store');
        expect(mocked.owned).toHaveBeenCalledWith(expect.anything(), USER, COMPUTER);
        expect(mocked.insert).toHaveBeenCalledWith(expect.anything(), USER, expect.objectContaining({ instruction: INSTRUCTION }), COMPUTER,
            expect.stringMatching(/^sha256:/), { clientId: CLIENT, idpIssuer: CALLER.idpIssuer, subject: CALLER.subject,
                scope: 'ezil:native-sessions:read ezil:native-sessions:write' });
        expect(JSON.stringify([res, logs])).not.toContain('SECRET-TASK');
    });

    it('projects per-kind capabilities from real readiness, not constants', async () => {
        const env = { ...ENV, EZIL_NATIVE_AUTHORIZATION_POLICY_ID: '0b6f8a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b',
            EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: `ezs_${Buffer.alloc(32, 0x5a).toString('base64url')}`, EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT: '2026-11-17T00:00:00+00:00' };
        expect((await read(await handleNativeAuthRest(post(CREATE), deps({ env })))).body.capabilities).toMatchObject({ create: true, renew: false });
        expect((await read(await handleNativeAuthRest(post(CREATE), deps({ env, hostTransport: { available: false, supportsKind: () => true, checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: throwing('d') } }))))
            .body.capabilities).toMatchObject({ create: false, renew: false });
    });

    it('replays the same key with identical input as the same intent, and never dispatches', async () => {
        mocked.lookupIntent.mockResolvedValue(intent({ state: 'approved', decidedAt: new Date(NOW - 1_000) }));
        mocked.lookupOp.mockResolvedValue(op('delivery_unknown', { reason: 'host_timeout' }));
        const res = await read(await handleNativeAuthRest(post(CREATE), deps()));
        expect(res).toMatchObject({ status: 200, body: { authorization: { state: 'approved', authorizationUrl: null, reason: null },
            operation: { state: 'delivery_unknown', reason: 'host_timeout', settled: true } } });
        expect(Object.keys(res.body.operation).sort()).toEqual(OPERATION_KEYS);
        expect(res.body.operation).not.toHaveProperty('replayed');
        expect(mocked.insert).not.toHaveBeenCalled();
    });

    it('conflicts forever on changed input or another client, issuer or subject, without reading ownership', async () => {
        const cases: [Partial<Intent>, unknown][] = [
            [{}, { ...CREATE, instruction: `${INSTRUCTION} `, instructionDigest: nativeInstructionDigest(`${INSTRUCTION} `) }],
            [{}, { ...CREATE, computerId: USER }], [{}, { kind: 'renew', operationId: OP, sessionId: SESSION }],
            [{ clientId: 'other-client' }, CREATE], [{ idpIssuer: 'https://other/' }, CREATE], [{ subject: 'auth0|other' }, CREATE],
            [{ state: 'expired', decidedAt: new Date(NOW) }, { ...CREATE, sessionId: COMPUTER }],
        ];
        for (const [stored, body] of cases) {
            mocked.lookupIntent.mockResolvedValueOnce(intent(stored));
            expect(await read(await handleNativeAuthRest(post(body), deps()))).toMatchObject({ status: 409, body: { error: { code: 'operation_conflict' } } });
        }
        expect(mocked.owned).not.toHaveBeenCalled();
        expect(mocked.insert).not.toHaveBeenCalled();
    });

    it('answers 404 not_found with no fields once the computer is deleted or transferred', async () => {
        mocked.lookupIntent.mockResolvedValue(intent());
        mocked.owned.mockResolvedValue(false);
        const res = await read(await handleNativeAuthRest(post(CREATE), deps()));
        expect(res).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
        for (const field of [OP, SESSION, COMPUTER, 'authorization', 'required']) expect(JSON.stringify(res.body)).not.toContain(field);
    });

    it('refuses a computer that is not the caller\'s, and a second create for the session as non-definite', async () => {
        mocked.owned.mockResolvedValueOnce(false);
        expect(await read(await handleNativeAuthRest(post(CREATE), deps()))).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
        expect(mocked.insert).not.toHaveBeenCalled();
        mocked.insert.mockResolvedValueOnce({ kind: 'session_exists' });
        const res = await read(await handleNativeAuthRest(post(CREATE), deps()));
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('session_exists');
    });

    it('binds a renewal to the session\'s create computer, read while it is still the caller\'s', async () => {
        mocked.status.mockResolvedValueOnce({ created: op('delivered'), latest: op('delivered') });
        const renew = { kind: 'renew', operationId: OP, sessionId: SESSION };
        mocked.insert.mockImplementationOnce(async (_db, _u, _i, computer, inputDigest) => ({ kind: 'inserted', intent: intent({ kind: 'renew', computerId: computer,
            instruction: null, instructionDigest: null, instructionRevision: null, inputDigest }) }));
        mocked.derive.mockResolvedValueOnce(null);
        mocked.lookupIntent.mockResolvedValueOnce(null).mockResolvedValueOnce(intent({ kind: 'renew', instruction: null, instructionDigest: null,
            instructionRevision: null, state: 'blocked', reason: 'session_not_active', decidedAt: new Date(NOW) }));
        const res = await read(await handleNativeAuthRest(post(renew), deps()));
        expect(res).toMatchObject({ status: 200, body: { kind: 'renew', computerId: COMPUTER,
            authorization: { state: 'blocked', reason: 'session_not_active', authorizationUrl: null } } });
        expect(mocked.insert).toHaveBeenCalledWith(expect.anything(), USER, renew, COMPUTER, expect.any(String), expect.anything());
        expect(mocked.decide).toHaveBeenCalledWith(expect.anything(), USER, OP, 'blocked', 'session_not_active');
        mocked.status.mockResolvedValueOnce(null);
        expect((await read(await handleNativeAuthRest(post({ ...renew, operationId: USER }), deps()))).body.error.code).toBe('not_found');
    });

    it('derives a renewal from the session consent without any browser approval, then blocks it before any claim', async () => {
        const gateway = { EZIL_NATIVE_AUTHORIZATION_POLICY_ID: '0b6f8a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b',
            EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: `ezs_${Buffer.alloc(32, 0x5a).toString('base64url')}`, EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT: '2026-11-17T00:00:00+00:00' };
        const renewHost = { available: true, supportsKind: () => true, checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: throwing('deliver') };
        const cases: [Partial<Deps>, string][] = [
            [{}, 'gateway_exchange_unconfigured'], [{ env: { ...ENV, ...gateway } }, 'host_unavailable'],
            [{ env: { ...ENV, ...gateway }, hostTransport: renewHost }, 'subject_token_unavailable'],
        ];
        for (const [overrides, reason] of cases) {
            vi.clearAllMocks();
            mocked.owned.mockResolvedValue(true);
            mocked.lookupOp.mockResolvedValue(null);
            mocked.status.mockResolvedValueOnce({ created: op('delivered'), latest: op('delivered') });
            const renewIntent = (o: Partial<Intent>) => intent({ kind: 'renew', instruction: null, instructionDigest: null, instructionRevision: null, ...o });
            mocked.insert.mockResolvedValueOnce({ kind: 'inserted', intent: renewIntent({}) });
            mocked.derive.mockResolvedValueOnce(renewIntent({ state: 'approved', decidedAt: new Date(NOW) }));
            mocked.lookupIntent.mockResolvedValueOnce(null).mockResolvedValueOnce(renewIntent({ state: 'blocked', reason, decidedAt: new Date(NOW) }));
            const res = await read(await handleNativeAuthRest(post({ kind: 'renew', operationId: OP, sessionId: SESSION }), deps(overrides)));
            expect(res.body.authorization, reason).toMatchObject({ state: 'blocked', reason });
            expect(mocked.derive).toHaveBeenCalledWith(expect.anything(), USER, OP);
            expect(mocked.blockApproved).toHaveBeenCalledWith(expect.anything(), USER, OP, reason);
            expect(mocked.decide).not.toHaveBeenCalled();
        }
    });

    it('enforces body limits and exact JSON before verification', async () => {
        const d = deps();
        const big = JSON.stringify({ ...CREATE, pad: 'x'.repeat(65_536) });
        expect((await handleNativeAuthRest(post(big), d)).status).toBe(413);
        expect((await handleNativeAuthRest(post(CREATE, undefined, { 'content-type': 'text/plain' }), d)).status).toBe(415);
        expect((d.verifier as ReturnType<typeof verifierFor>).verify).not.toHaveBeenCalled();
        const bad = new Request(`${ORIGIN}/api/mcp/native-auth-intents`, { method: 'POST', body: new Uint8Array([0x7b, 0xff, 0x7d]),
            headers: { 'content-type': 'application/json' } });
        expect((await handleNativeAuthRest(bad, d)).status).toBe(400);
        for (const [body, code] of [[{ ...CREATE, extra: 1 }, 'bad_request'], [{ ...CREATE, instructionDigest: nativeInstructionDigest('x') }, 'instruction_digest_mismatch'],
            [{ ...CREATE, instruction: ' \n', instructionDigest: nativeInstructionDigest(' \n') }, 'instruction_invalid']] as const) {
            expect((await read(await handleNativeAuthRest(post(body), d))).body.error.code).toBe(code);
        }
        const boundary = 'a'.repeat(16_384);
        expect((await handleNativeAuthRest(post({ ...CREATE, instruction: boundary, instructionDigest: nativeInstructionDigest(boundary) }), d)).status).toBe(200);
        const over = `${boundary}a`;
        expect((await read(await handleNativeAuthRest(post({ ...CREATE, instruction: over, instructionDigest: nativeInstructionDigest(over) }), d))))
            .toMatchObject({ status: 413, body: { error: { code: 'instruction_too_large' } } });
    });
});

describe('reads are pure and exact', () => {
    it('GET intent answers the exact operation under the same key only, never a different same-key row', async () => {
        mocked.lookupIntent.mockResolvedValue(intent({ state: 'approved', decidedAt: new Date(NOW - 120_000) }));
        mocked.lookupOp.mockResolvedValue(op('delivered', { taskRef: 'task:other' }));
        const res = await read(await handleNativeAuthRest(get(`/api/mcp/native-auth-intents/${OP}`), deps()));
        expect(res.body).toMatchObject({ operation: null, authorization: { state: 'approved', reason: 'dispatch_unknown' } });
        expect(mocked.lookupOp).toHaveBeenCalledWith(expect.anything(), USER, OP);
        mocked.lookupOp.mockResolvedValue(op('delivered', { computerId: USER }));
        expect((await read(await handleNativeAuthRest(get(`/api/mcp/native-auth-intents/${OP}`), deps()))).body.operation).toBeNull();
    });

    it('reports approved-without-operation as pending inside the claim window and unknown after it, never retried', async () => {
        mocked.lookupIntent.mockResolvedValue(intent({ state: 'approved', decidedAt: new Date(NOW - 5_000) }));
        expect((await read(await handleNativeAuthRest(get(`/api/mcp/native-auth-intents/${OP}`), deps()))).body.authorization.reason).toBe('dispatch_pending');
        mocked.lookupIntent.mockResolvedValue(intent({ state: 'approved', decidedAt: new Date(NOW - 61_000) }));
        expect((await read(await handleNativeAuthRest(get(`/api/mcp/native-auth-intents/${OP}`), deps()))).body.authorization.reason).toBe('dispatch_unknown');
    });

    it('projects expiry without a write and maps unknown stored reasons to the safe fallback', async () => {
        mocked.lookupIntent.mockResolvedValue(intent({ expiresAt: new Date(NOW) }));
        expect((await read(await handleNativeAuthRest(get(`/api/mcp/native-auth-intents/${OP}`), deps()))).body.authorization)
            .toEqual({ state: 'expired', expiresAt: new Date(NOW).toISOString(), authorizationUrl: null, reason: null });
        mocked.lookupIntent.mockResolvedValue(intent({ state: 'blocked', reason: 'something_new', decidedAt: new Date(NOW) }));
        expect((await read(await handleNativeAuthRest(get(`/api/mcp/native-auth-intents/${OP}`), deps()))).body.authorization.reason).toBe('authorization_unavailable');
        mocked.lookupIntent.mockResolvedValue(intent({ state: 'blocked', reason: 'host_unavailable', decidedAt: new Date(NOW) }));
        expect((await read(await handleNativeAuthRest(get(`/api/mcp/native-auth-intents/${OP}`), deps()))).body.authorization.reason).toBe('host_unavailable');
        expect(mocked.insert).not.toHaveBeenCalled();
    });

    it('hides another client\'s intent and a missing one behind the same 404', async () => {
        mocked.lookupIntent.mockResolvedValueOnce(intent({ clientId: 'other-client' }));
        const other = await read(await handleNativeAuthRest(get(`/api/mcp/native-auth-intents/${OP}`), deps()));
        const missing = await read(await handleNativeAuthRest(get(`/api/mcp/native-auth-intents/${OP}`), deps()));
        expect(other).toEqual(missing);
        expect(other).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    });

    it('GET session answers the frozen broker_status DTO with base views and no replayed marker', async () => {
        mocked.status.mockResolvedValueOnce({ created: op('delivered'), latest: op('exchange_unknown', { kind: 'renew', operationId: USER, reason: 'gateway_timeout' }) });
        const res = await read(await handleNativeAuthRest(get(`/api/mcp/native-sessions/${SESSION}`), deps({ verifier: verifierFor(() => signed, { ...CALLER, scope: ['ezil:native-sessions:read'] }) })));
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['session', 'statusKind']);
        expect(res.body.statusKind).toBe('broker_status');
        expect(Object.keys(res.body.session).sort()).toEqual(['computerId', 'created', 'instructionRevision', 'latest', 'sessionId']);
        expect(res.body.session).toMatchObject({ sessionId: SESSION, computerId: COMPUTER, instructionRevision: 1, latest: { kind: 'renew', state: 'exchange_unknown', settled: true } });
        for (const view of [res.body.session.created, res.body.session.latest]) expect(Object.keys(view).sort()).toEqual(OPERATION_KEYS);
        expect(JSON.stringify(res.body)).not.toMatch(/replayed|placement|fence|taskRef|native-task/);
        mocked.status.mockResolvedValueOnce(null);
        expect(await read(await handleNativeAuthRest(get(`/api/mcp/native-sessions/${SESSION}`), deps({ verifier: verifierFor(() => signed, { ...CALLER, scope: ['ezil:native-sessions:read'] }) }))))
            .toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    });

    it('never logs or returns the instruction, even on an internal failure', async () => {
        mocked.lookupIntent.mockRejectedValueOnce(new Error(`db exploded near ${INSTRUCTION}`));
        const res = await read(await handleNativeAuthRest(post(CREATE), deps()));
        expect(res).toMatchObject({ status: 500, body: { error: { code: 'internal_error' } } });
        expect(JSON.stringify([res, logs])).not.toContain('SECRET-TASK');
    });
});
