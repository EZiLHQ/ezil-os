import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeAuthorityCheck, NativeOperation, NativeOperationState } from './authority';

vi.mock('./authority', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./authority')>();
    return {
        ...actual,
        lookupNativeOperation: vi.fn(), claimNativeOperation: vi.fn(), advanceNativeOperation: vi.fn(),
        recheckNativeAuthority: vi.fn(), readNativeSessionStatus: vi.fn(), nativeComputerOwnedNow: vi.fn(),
    };
});

vi.mock('./native-authorization-outbox', async importOriginal => ({
    ...await importOriginal<typeof import('./native-authorization-outbox')>(),
    prepareNativeRenewal: vi.fn(), dispatchNativeOperationOnce: vi.fn(), openNativeGrantCandidate: vi.fn(),
}));
vi.mock('./native-authorization-config', async importOriginal => ({
    ...await importOriginal<typeof import('./native-authorization-config')>(),
    loadNativeAuthorizationConfig: vi.fn(),
}));
const outbox = await import('./native-authorization-outbox');
const authorizationConfig = await import('./native-authorization-config');
const { fixtureConfig, fixtureKeys } = await import('./native-authorization.test-support');
const FIXTURE_CONFIG = fixtureConfig(await fixtureKeys());
const authority = await import('./authority');
const {
    handleNativeSessionCreate, handleNativeSessionRenew, handleNativeSessionStatus, nativeRunResponse, parseNativeCreateBody, parseNativeRenewBody,
    productionNativeSessionDeps, runNativeOperation,
} = await import('./http');
type Deps = import('./http').NativeSessionDeps;

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const ORIGIN = 'https://os-staging.ezil.work';
const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const OP = '44444444-4444-4444-8444-444444444444';
const GRANT_ID = '55555555-5555-4555-8555-555555555555';
const DIGEST = `sha256:${'d'.repeat(64)}`;
// Synthetic c9-shaped secrets (prefix + 32 bytes base64url) and policy UUID. Not real credentials.
const SERVICE = `ezs_${Buffer.alloc(32, 0x5a).toString('base64url')}`;
const GRANT = `ezg_${Buffer.alloc(32, 0xa5).toString('base64url')}`;
const POLICY = '0b6f8a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const proofFor = (sub: string, expMs: number) => `${b64({ alg: 'HS256' })}.${b64({ sub, exp: expMs / 1000 })}.sig`;
const PROOF = proofFor(USER, NOW + 3_600_000);
const SECRETS = [SERVICE, PROOF, GRANT, 'ezs_', 'ezg_'];
const ENV = {
    ...Object.fromEntries(authorizationConfig.NATIVE_AUTHORIZATION_ENV.map(key => [key, 'fixture'])), EZIL_NATIVE_AUTHORIZATION: 'enabled',
    EZIL_NATIVE_SESSIONS: '1', EZIL_NATIVE_SESSIONS_ORIGIN: ORIGIN, EZIL_NATIVE_GATEWAY_POLICY_ID: POLICY,
    EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: SERVICE, EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT: '2026-11-17T00:00:00+00:00',
};
const PLACEMENT = { generation: '3000000001', leaseEpoch: '4294967301', instanceId: 'i-0123456789abcdef0', fenceToken: '66666666-6666-4666-8666-666666666666' };
const CREATE = { operationId: OP, sessionId: SESSION, computerId: COMPUTER, instructionRevision: 1, instructionDigest: DIGEST, taskRef: 'task:native-smoke' };
const TASK = { taskRef: 'task:native-smoke', instructionRevision: 1 as const, instructionDigest: DIGEST, instruction: 'fixture instruction' };

const mocked = {
    lookup: vi.mocked(authority.lookupNativeOperation), claim: vi.mocked(authority.claimNativeOperation),
    advance: vi.mocked(authority.advanceNativeOperation), recheck: vi.mocked(authority.recheckNativeAuthority),
    status: vi.mocked(authority.readNativeSessionStatus), owned: vi.mocked(authority.nativeComputerOwnedNow),
};

function operation(kind: 'create' | 'renew' = 'create', state: NativeOperationState = 'claimed'): NativeOperation {
    const request = kind === 'create' ? { kind, ...CREATE, instructionRevision: 1 as const } : { kind, operationId: OP, sessionId: SESSION };
    return {
        userId: USER, operationId: OP, kind, sessionId: SESSION, computerId: COMPUTER, instructionRevision: '1', instructionDigest: DIGEST,
        taskRef: 'task:native-smoke', requestDigest: authority.nativeRequestDigest(request), placement: PLACEMENT, state, reason: null,
        grantId: null, grantExpiresAt: null, createdAt: new Date(NOW), updatedAt: new Date(NOW),
    };
}

/** In-memory compare-and-swap with the same contract as the real store. */
let stored: NativeOperation;
let events: string[];
function installStore(kind: 'create' | 'renew' = 'create') {
    stored = operation(kind);
    mocked.lookup.mockResolvedValue(null);
    mocked.owned.mockResolvedValue(true);
    mocked.claim.mockImplementation(async () => { events.push('claim'); return { kind: 'claimed', operation: stored, leaseUntil: new Date(NOW + 600_000) }; });
    mocked.advance.mockImplementation(async (_db, _op, from, to, detail = {}) => {
        events.push(`advance:${to}`);
        if (stored.state !== from) return null;
        stored = { ...stored, state: to, reason: detail.reason ?? null, grantId: detail.grant?.id ?? stored.grantId,
            grantExpiresAt: detail.grant?.expiresAt ?? stored.grantExpiresAt };
        return stored;
    });
    mocked.recheck.mockImplementation(async (): Promise<NativeAuthorityCheck> => {
        events.push('recheck');
        return { ok: true, placement: PLACEMENT, leaseUntil: new Date(NOW + 600_000) };
    });
}

const throwing = (name: string) => vi.fn(() => { throw new Error(`unexpected ${name}`); });

function deps(overrides: Partial<Deps> = {}) {
    const supabaseClient = {
        auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER } } })), getSession: throwing('getSession'), refreshSession: throwing('refreshSession') },
    };
    const deliveries: unknown[] = [];
    const d: Deps = {
        env: ENV,
        supabase: vi.fn(async () => supabaseClient),
        db: { execute: throwing('db.execute'), transaction: throwing('db.transaction') } as unknown as Deps['db'],
        fetch: vi.fn(async () => { events.push('exchange'); return new Response(JSON.stringify({ token_type: 'Bearer', access_token: GRANT, grant_id: GRANT_ID,
            expires_at: new Date(NOW + 240_000).toISOString() }), { status: 201, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch,
        hostTransport: { available: true, supportsKind: () => true,
            checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: vi.fn(async (delivery) => { events.push('deliver'); deliveries.push(delivery); return { kind: 'acknowledged' as const }; }) },
        taskResolver: { resolve: vi.fn(async () => TASK) },
        currentAccessToken: vi.fn(async () => PROOF),
        now: () => NOW,
        ...overrides,
    };
    return { d, supabaseClient, deliveries };
}

const post = (body: unknown, headers: Record<string, string> = {}, url = `${ORIGIN}/api/shell/native-sessions`) =>
    new Request(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: 'sb=1', ...headers } });
const get = (headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/shell/native-sessions/${SESSION}`, { headers: { cookie: 'sb=1', ...headers } });
/** Consent metadata exactly as the trusted consent reader returns it. */
const SOURCE = Object.freeze({
    authorizationId: '77777777-7777-4777-8777-777777777777', epoch: '7', authorizationDeadline: new Date(NOW + 86_400_000).toISOString(),
    clientId: 'ezil-mcp-staging', profileId: 'ezil-native-claude-v1' as const, policyId: POLICY, budgetMicro: '2500000',
    initialApprovalAt: new Date(NOW).toISOString(),
});
const ADMITTED = { consentOperationId: OP, placement: PLACEMENT, computerId: COMPUTER, sourceAuthorization: SOURCE, consentRecheck: async () => 'ok' as const };

/**
 * The admitted path: the same cookie identity, request headers and body shape as the legacy route, run through
 * the trusted runner with consent metadata (as the consent POST does). Errors map to a fixed 500.
 */
async function admitted(req: Request, d: Deps, parse: (body: unknown) => import('./authority').NativeOperationRequest | null): Promise<Response> {
    try {
        const supabase = await d.supabase();
        const id = (await supabase.auth.getUser()).data.user?.id;
        if (!id) return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        const request = parse(await req.json());
        if (!request) return new Response(JSON.stringify({ error: { code: 'bad_request' } }), { status: 400 });
        return nativeRunResponse(await runNativeOperation(d, { userId: id, supabase, headers: req.headers }, request, ADMITTED));
    } catch {
        return new Response(JSON.stringify({ error: { code: 'internal_error' } }), { status: 500 });
    }
}
const admittedCreate = (req: Request, d: Deps) => admitted(req, d, parseNativeCreateBody);
const admittedRenew = (req: Request, sessionId: string, d: Deps) => admitted(req, d, body => parseNativeRenewBody(body, sessionId));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- arbitrary JSON response bodies under test
type Json = Record<string, any>;
const read = async (res: Response) => ({ status: res.status, body: await res.json() as Json, cache: res.headers.get('cache-control') });

let logs: unknown[];
beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    logs = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...a) => { logs.push(a); });
    installStore();
    vi.mocked(authorizationConfig.loadNativeAuthorizationConfig).mockResolvedValue({ state: 'ready', config: FIXTURE_CONFIG });
    vi.mocked(outbox.prepareNativeRenewal).mockResolvedValue({ kind: 'prepared', status: {} as never });
    vi.mocked(outbox.dispatchNativeOperationOnce).mockImplementation(async (_db, d) => {
        try {
            const res = await d.fetchImpl('https://ai-staging.ezil.work/v1/token/exchange', { method: 'POST' });
            if (res.status >= 400 && res.status < 500) return { kind: 'settled', status: { state: 'refused' } as never };
            if (!res.ok) return { kind: 'settled', status: { state: 'delivery_unknown', reason: 'gateway_unavailable' } as never };
            const body = await res.json() as { grant_id: string; expires_at: string };
            if (!body.grant_id || !body.expires_at) return { kind: 'settled', status: { state: 'delivery_unknown', reason: 'gateway_invalid_response' } as never };
            return { kind: 'settled', status: { state: 'granted', grantId: body.grant_id, grantExpiresAt: body.expires_at } as never };
        } catch { return { kind: 'settled', status: { state: 'delivery_unknown', reason: 'gateway_unavailable' } as never }; }
    });
    vi.mocked(outbox.openNativeGrantCandidate).mockResolvedValue({ kind: 'opened', bearer: { authorizationHeader: () => `Bearer ${GRANT}` } as never,
        tokenSha256: createHash('sha256').update(GRANT, 'utf8').digest('hex'), sourceAuthorization: SOURCE });
});

describe('gate off', () => {
    it('answers 404 from every route while touching nothing', async () => {
        const all = new Proxy({}, { get: (_t, key) => { throw new Error(`touched ${String(key)}`); } });
        const d = { env: {}, supabase: all, db: all, fetch: all, hostTransport: all, taskResolver: all, currentAccessToken: all, now: all } as unknown as Deps;
        for (const res of [await handleNativeSessionCreate(post(CREATE), d), await handleNativeSessionRenew(post({ operationId: OP }), SESSION, d),
            await handleNativeSessionStatus(get(), SESSION, d)]) {
            expect(await read(res)).toMatchObject({ status: 404, body: { error: { code: 'native_sessions_disabled' } }, cache: expect.stringContaining('no-store') });
        }
        for (const value of ['0', 'true', 'on', ' 1']) {
            expect((await handleNativeSessionStatus(get(), SESSION, { ...d, env: { EZIL_NATIVE_SESSIONS: value } })).status).toBe(404);
        }
    });

    it('production wiring is truthfully blocked even with the gate and sealed config present', async () => {
        const { d } = deps();
        // The fixture clock, not the wall clock: ENV's sealed service credential expires 2026-11-17T00:00Z.
        const prod = { ...productionNativeSessionDeps(d.db, d.supabase), env: ENV, fetch: d.fetch, currentAccessToken: d.currentAccessToken, now: d.now };
        expect((await read(await handleNativeSessionCreate(post(CREATE), prod))).body.error).toMatchObject({ code: 'native_session_blocked', reason: 'task_resolver_unavailable' });
        expect((await read(await handleNativeSessionRenew(post({ operationId: OP }), SESSION, prod))).body.error).toMatchObject({ code: 'native_session_blocked', reason: 'host_unavailable' });
        expect(d.fetch).not.toHaveBeenCalled();
        expect(d.currentAccessToken).not.toHaveBeenCalled();
        expect(mocked.claim).not.toHaveBeenCalled();
        expect(mocked.advance).not.toHaveBeenCalled();
    });
});

describe('consent required to mint', () => {
    it('the legacy cookie route never proves, claims, exchanges or delivers a new key without trusted consent metadata', async () => {
        for (const res of [await handleNativeSessionCreate(post(CREATE), deps().d), await handleNativeSessionRenew(post({ operationId: OP }), SESSION, deps().d)]) {
            expect(await read(res)).toMatchObject({ status: 503, body: { error: { code: 'native_session_blocked', reason: 'consent_terms_unavailable' } } });
        }
        const { d } = deps();
        expect((await runNativeOperation(d, { userId: USER, supabase: await d.supabase(), headers: new Headers() },
            { kind: 'renew', operationId: OP, sessionId: SESSION }, { sourceAuthorization: SOURCE }))).toEqual({ kind: 'blocked', reason: 'consent_terms_unavailable' });
        expect(d.currentAccessToken).not.toHaveBeenCalled();
        expect(d.fetch).not.toHaveBeenCalled();
        expect(d.hostTransport.deliver).not.toHaveBeenCalled();
        for (const fn of [mocked.claim, mocked.advance]) expect(fn).not.toHaveBeenCalled();
    });

    it('asks the host about exactly the approved target, once, before any proof, claim or exchange', async () => {
        const { d } = deps();
        expect((await admittedCreate(post(CREATE), d)).status).toBe(201);
        const probe = vi.mocked(d.hostTransport.checkReadiness);
        expect(probe).toHaveBeenCalledTimes(1);
        const [target, signal] = probe.mock.calls[0]!;
        expect(target).toEqual({ kind: 'create', profileId: 'ezil-native-claude-v1', ownerUserId: USER, computerId: COMPUTER, placement: PLACEMENT });
        expect(Object.isFrozen(target) && Object.isFrozen(target.placement)).toBe(true);
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(probe.mock.invocationCallOrder[0]).toBeLessThan(mocked.claim.mock.invocationCallOrder[0]!);
    });

    it('blocks with zero effects when readiness is refused, unknown, rejected or past its hard deadline', async () => {
        const answers: [string, () => Promise<unknown>][] = [
            ['refused', async () => ({ kind: 'refused' })], ['unknown', async () => ({ kind: 'unknown' })],
            ['rejected', async () => { throw new Error('probe failed'); }], ['malformed', async () => ({ kind: 'READY' })],
            ['deadline', () => new Promise(() => {})], // ignores abort and never answers
        ];
        for (const [name, answer] of answers) {
            vi.clearAllMocks();
            installStore();
            const { d } = deps({ readinessTimeoutMs: 20 });
            d.hostTransport = { ...d.hostTransport, checkReadiness: vi.fn(answer) as unknown as Deps['hostTransport']['checkReadiness'] };
            expect(await read(await admittedCreate(post(CREATE), d)), name).toMatchObject({ status: 503,
                body: { error: { code: 'native_session_blocked', reason: 'host_unavailable' } } });
            for (const fn of [d.currentAccessToken, d.fetch, d.hostTransport.deliver, d.taskResolver!.resolve]) expect(fn, name).not.toHaveBeenCalled();
            for (const fn of [mocked.claim, mocked.advance]) expect(fn, name).not.toHaveBeenCalled();
        }
    });

    it('a stored key replays without any readiness probe, and the production transport answers refused', async () => {
        mocked.lookup.mockResolvedValueOnce(operation('create', 'delivery_unknown'));
        const { d } = deps();
        expect((await read(await admittedCreate(post(CREATE), d))).body.operation).toMatchObject({ state: 'delivery_unknown', replayed: true });
        expect(d.hostTransport.checkReadiness).not.toHaveBeenCalled();
        const { UNAVAILABLE_HOST_TRANSPORT } = await import('./host-transport');
        expect(await UNAVAILABLE_HOST_TRANSPORT.checkReadiness({ kind: 'create', profileId: 'ezil-native-claude-v1', ownerUserId: USER, computerId: COMPUTER,
            placement: PLACEMENT })).toEqual({ kind: 'refused' });
    });

    it('a consent stopped or unreadable after the exchange ends the operation before any host dispatch', async () => {
        for (const verdict of ['authorization_revoked', 'authorization_unavailable'] as const) {
            installStore();
            events = [];
            const { d } = deps();
            const recheck = vi.fn(async () => { events.push('consent'); return verdict; });
            const result = await runNativeOperation(d, { userId: USER, supabase: await d.supabase(), headers: new Headers() },
                { kind: 'create', ...CREATE, instructionRevision: 1 }, { ...ADMITTED, consentRecheck: recheck });
            expect(result).toMatchObject({ kind: 'operation', operation: { state: 'authority_changed', reason: verdict } });
            expect(events).toEqual(['claim', 'advance:exchanging', 'exchange', 'advance:granted', 'recheck', 'consent', 'advance:authority_changed']);
            expect(d.hostTransport.deliver).not.toHaveBeenCalled();
        }
    });

    it('an admitted run replays a stored unknown operation with zero proof, claim, exchange or host dispatch', async () => {
        for (const state of ['exchange_unknown', 'delivery_unknown'] as const) {
            mocked.lookup.mockResolvedValueOnce(operation('create', state));
            const { d } = deps();
            const res = await read(await admittedCreate(post(CREATE), d));
            expect(res).toMatchObject({ status: 202, body: { operation: { state, replayed: true } } });
            expect(d.currentAccessToken).not.toHaveBeenCalled();
            expect(d.fetch).not.toHaveBeenCalled();
            expect(d.hostTransport.deliver).not.toHaveBeenCalled();
            for (const fn of [mocked.claim, mocked.advance, mocked.recheck]) expect(fn).not.toHaveBeenCalled();
        }
    });
});

describe('write guards', () => {
    it('refuses any Authorization header before reading the cookie session', async () => {
        for (const value of [`Bearer ${PROOF}`, 'Bearer', '', 'Basic eA==']) {
            const { d } = deps();
            for (const res of [await handleNativeSessionCreate(post(CREATE, { authorization: value }), d),
                await handleNativeSessionRenew(post({ operationId: OP }, { authorization: value }), SESSION, d),
                await handleNativeSessionStatus(get({ authorization: value }), SESSION, d)]) {
                expect(await read(res)).toMatchObject({ status: 401, body: { error: { code: 'bearer_not_accepted' } } });
            }
            expect(d.supabase).not.toHaveBeenCalled();
        }
    });

    it('requires the exact configured origin and same-origin fetch metadata; Host and X-Forwarded-Host are ignored', async () => {
        for (const configured of [undefined, `${ORIGIN}/`, 'http://os-staging.ezil.work', `${ORIGIN}:443`, `${ORIGIN}/x`, 'nonsense']) {
            const { d } = deps({ env: { ...ENV, EZIL_NATIVE_SESSIONS_ORIGIN: configured } });
            expect((await read(await handleNativeSessionCreate(post(CREATE), d))).body.error).toMatchObject({ code: 'native_session_blocked', reason: 'origin_unconfigured' });
        }
        const refused: Record<string, string>[] = [
            { origin: '' }, { origin: 'null' }, { origin: 'https://evil.example' }, { origin: 'https://evil-app.ezil.work' },
            { origin: 'http://os-staging.ezil.work' }, { origin: 'https://OS-STAGING.ezil.work' }, { origin: `${ORIGIN}:443` },
            { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'none' },
            { origin: 'https://evil.example', host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
        ];
        for (const headers of refused) {
            const { d } = deps();
            const req = post(CREATE, headers);
            if (headers.origin === '') req.headers.delete('origin');
            expect((await read(await handleNativeSessionCreate(req, d))).status, JSON.stringify(headers)).toBe(403);
            expect((await read(await handleNativeSessionRenew(post({ operationId: OP }, headers), SESSION, d))).status).toBe(403);
            expect(d.supabase).not.toHaveBeenCalled();
        }
        const { d } = deps();
        const noFetchMetadata = post(CREATE);
        noFetchMetadata.headers.delete('sec-fetch-site');
        // Absent fetch metadata passes the guard; the legacy route then mints nothing without a consent.
        expect(await read(await handleNativeSessionCreate(noFetchMetadata, d))).toMatchObject({ status: 503,
            body: { error: { code: 'native_session_blocked', reason: 'consent_terms_unavailable' } } });
    });

    it('accepts only a small exact JSON body', async () => {
        const bad: [unknown, Record<string, string>, number][] = [
            [CREATE, { 'content-type': 'text/plain' }, 415], [CREATE, { 'content-type': 'application/json; charset=latin1' }, 415],
            [CREATE, { 'content-length': '999999' }, 413], [{ ...CREATE, pad: 'x'.repeat(4096) }, {}, 413],
            ['{"operationId":', {}, 400], ['￾', {}, 400], [[CREATE], {}, 400], [null, {}, 400],
            [{ ...CREATE, extra: 1 }, {}, 400], [{ ...CREATE, command: 'rm -rf /' }, {}, 400], [{ ...CREATE, model: 'x' }, {}, 400],
            [Object.fromEntries(Object.entries(CREATE).filter(([key]) => key !== 'taskRef')), {}, 400], [{ ...CREATE, instructionRevision: 2 }, {}, 400],
            [{ ...CREATE, instructionRevision: '1' }, {}, 400], [{ ...CREATE, instructionRevision: 1.5 }, {}, 400],
            [{ ...CREATE, operationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, {}, 400], [{ ...CREATE, computerId: 'not-a-uuid' }, {}, 400],
            [{ ...CREATE, instructionDigest: 'sha256:abc' }, {}, 400], [{ ...CREATE, taskRef: 'https://evil.example/task' }, {}, 400],
            [{ ...CREATE, taskRef: '../root' }, {}, 400], [`{"__proto__":{},${JSON.stringify(CREATE).slice(1)}`, {}, 400],
        ];
        for (const [body, headers, status] of bad) {
            const { d } = deps();
            expect((await handleNativeSessionCreate(post(body, headers), d)).status, JSON.stringify(body).slice(0, 80)).toBe(status);
            expect(d.supabase).not.toHaveBeenCalled();
        }
        const streamed = new Request(`${ORIGIN}/api/shell/native-sessions`, { method: 'POST', duplex: 'half',
            headers: { origin: ORIGIN, 'content-type': 'application/json' },
            body: new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('x'.repeat(1024))); } }) } as RequestInit);
        expect((await handleNativeSessionCreate(streamed, deps().d)).status).toBe(413);
        for (const body of [{}, { operationId: OP, sessionId: SESSION }, { operationId: 'x' }]) {
            expect((await handleNativeSessionRenew(post(body), SESSION, deps().d)).status).toBe(400);
        }
        expect((await handleNativeSessionRenew(post({ operationId: OP }), 'not-a-session', deps().d)).status).toBe(400);
    });
});

describe('readiness and identity before any claim', () => {
    const missing: [Partial<Deps>, string][] = [
        [{ env: { ...ENV, EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL: undefined } }, 'gateway_exchange_unconfigured'],
        [{ env: { ...ENV, EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY: undefined } }, 'gateway_exchange_unconfigured'],
        [{ env: { ...ENV, EZIL_NATIVE_AUTHORIZATION: undefined } }, 'gateway_exchange_unconfigured'],
        [{ env: { ...ENV, EZIL_NATIVE_AUTHORIZATION_POLICY_ID: undefined } }, 'gateway_exchange_unconfigured'],
        [{ env: { ...ENV, EZIL_NATIVE_GRANT_WRAPPING_KEY: undefined } }, 'gateway_exchange_unconfigured'],
        [{ taskResolver: null }, 'task_resolver_unavailable'],
        [{ hostTransport: { available: false, supportsKind: () => true, checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: throwing('deliver') } }, 'host_unavailable'],
        [{ hostTransport: { available: true, supportsKind: kind => kind === 'renew', checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: throwing('deliver') } }, 'host_unavailable'],
    ];

    it('blocks a kind the qualified host bundle does not support, with zero proof, claim, exchange or delivery', async () => {
        const createOnly = { available: true, supportsKind: (kind: 'create' | 'renew') => kind === 'create',
            checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: vi.fn(async () => { events.push('deliver'); return { kind: 'acknowledged' as const }; }) };
        const { d } = deps({ hostTransport: createOnly });
        expect(await read(await admittedRenew(post({ operationId: OP }), SESSION, d)))
            .toMatchObject({ status: 503, body: { error: { code: 'native_session_blocked', reason: 'host_unavailable' } } });
        expect(d.currentAccessToken).not.toHaveBeenCalled();
        expect(d.fetch).not.toHaveBeenCalled();
        expect(mocked.claim).not.toHaveBeenCalled();
        expect(createOnly.deliver).not.toHaveBeenCalled();
        // The same create-only fixture still delivers a create.
        expect((await admittedCreate(post(CREATE), d)).status).toBe(201);
        expect(createOnly.deliver).toHaveBeenCalledTimes(1);
    });

    it('blocks a new key with zero proof, exchange, claim or launch when sealed config, resolver or transport is missing', async () => {
        for (const [overrides, reason] of missing) {
            const { d } = deps(overrides);
            expect(await read(await admittedCreate(post(CREATE), d))).toMatchObject({ status: 503, body: { error: { code: 'native_session_blocked', reason } } });
            expect(mocked.lookup).toHaveBeenLastCalledWith(d.db, USER, OP);
            expect(d.fetch).not.toHaveBeenCalled();
            expect(d.currentAccessToken).not.toHaveBeenCalled();
        }
        expect(mocked.claim).not.toHaveBeenCalled();
        expect(mocked.advance).not.toHaveBeenCalled();
    });

    it('replays the original stored operation for the same key even after capabilities disappear', async () => {
        for (const [overrides] of missing) {
            mocked.lookup.mockResolvedValueOnce(operation('create', 'delivery_unknown'));
            const { d } = deps(overrides);
            expect(await read(await admittedCreate(post(CREATE), d))).toMatchObject({ status: 202,
                body: { operation: { operationId: OP, state: 'delivery_unknown', replayed: true } } });
            mocked.lookup.mockResolvedValueOnce(operation('create', 'delivery_unknown'));
            expect((await read(await admittedCreate(post({ ...CREATE, instructionDigest: `sha256:${'e'.repeat(64)}` }), d))).body.error.code).toBe('operation_conflict');
            expect(d.fetch).not.toHaveBeenCalled();
            expect(d.currentAccessToken).not.toHaveBeenCalled();
            expect(d.hostTransport.deliver).not.toHaveBeenCalled();
        }
        expect(mocked.claim).not.toHaveBeenCalled();
    });

    it('uses cookie identity for approval without reading a browser proof', async () => {
        const { d, supabaseClient } = deps({ currentAccessToken: throwing('browser proof') });
        expect((await admittedCreate(post(CREATE), d)).status).toBe(201);
        expect(supabaseClient.auth.getUser).toHaveBeenCalledTimes(1);
        expect(d.currentAccessToken).not.toHaveBeenCalled();
        expect(outbox.prepareNativeRenewal).toHaveBeenCalledWith(d.db, expect.anything(), expect.objectContaining({ consentOperationId: OP, operationId: OP }));
    });

    it('resolves the task only through the owner resolver and refuses a mismatch without claiming', async () => {
        for (const task of [null, { ...TASK, instructionDigest: `sha256:${'e'.repeat(64)}` }, { ...TASK, taskRef: 'task:other' }]) {
            const { d } = deps({ taskResolver: { resolve: vi.fn(async () => task) } });
            expect(await read(await admittedCreate(post(CREATE), d))).toMatchObject({ status: 409, body: { error: { code: 'task_unavailable' } } });
            expect(d.taskResolver!.resolve).toHaveBeenCalledWith('task:native-smoke', { userId: USER });
            expect(mocked.claim).not.toHaveBeenCalled();
        }
    });
});

describe('operation pipeline', () => {
    it('claims, exchanges once, rechecks, then delivers a fixed payload and reports sanitised state', async () => {
        const { d, deliveries } = deps();
        const res = await read(await admittedCreate(post(CREATE), d));
        expect(events).toEqual(['claim', 'advance:exchanging', 'exchange', 'advance:granted', 'recheck', 'advance:delivering', 'deliver', 'advance:delivered']);
        expect(res).toMatchObject({ status: 201, body: { operation: { operationId: OP, state: 'delivered', settled: true, grantId: GRANT_ID,
            grantExpiresAt: new Date(NOW + 240_000).toISOString(), replayed: false } } });
        expect(deliveries).toEqual([{ profileId: 'ezil-native-claude-v1', kind: 'create', operationId: OP, sessionId: SESSION, computerId: COMPUTER,
            ownerUserId: USER, placement: PLACEMENT, leaseUntil: new Date(NOW + 600_000).toISOString(), task: TASK, sourceAuthorization: SOURCE,
            grant: { accessToken: GRANT, tokenSha256: createHash('sha256').update(GRANT).digest('hex'), grantId: GRANT_ID,
                expiresAt: new Date(NOW + 240_000).toISOString() } }]);
        expect((deliveries[0] as { grant: { tokenSha256: string } }).grant.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(deliveries)).not.toContain(SERVICE);
        expect(JSON.stringify(deliveries)).not.toContain(PROOF);
        expect(JSON.stringify([res, logs])).not.toMatch(/ezs_|ezg_/);
    });

    it('replays a stored operation (any state) with zero exchange, and conflicts on a different request', async () => {
        for (const state of ['claimed', 'exchanging', 'exchange_unknown', 'delivery_unknown', 'delivered'] as const) {
            mocked.lookup.mockResolvedValueOnce(operation('create', state));
            const { d } = deps();
            const res = await read(await admittedCreate(post(CREATE), d));
            expect(res.body.operation).toMatchObject({ state, replayed: true });
            expect(d.fetch).not.toHaveBeenCalled();
            expect(d.hostTransport.deliver).not.toHaveBeenCalled();
            expect(d.currentAccessToken).not.toHaveBeenCalled();
        }
        mocked.lookup.mockResolvedValueOnce(operation('create', 'delivered'));
        expect(await read(await admittedCreate(post({ ...CREATE, taskRef: 'task:other' }), deps().d))).toMatchObject({ status: 409, body: { error: { code: 'operation_conflict' } } });
        mocked.claim.mockResolvedValueOnce({ kind: 'existing', operation: operation('create', 'exchange_unknown') });
        const raced = deps();
        expect((await read(await admittedCreate(post(CREATE), raced.d))).body.operation).toMatchObject({ state: 'exchange_unknown', replayed: true });
        expect(raced.d.fetch).not.toHaveBeenCalled();
    });

    it('maps claim conflicts and authority refusals to typed answers with no exchange', async () => {
        const cases: [Awaited<ReturnType<typeof authority.claimNativeOperation>>, number, string][] = [
            [{ kind: 'conflict', reason: 'session_exists' }, 409, 'session_exists'], [{ kind: 'conflict', reason: 'operation_conflict' }, 409, 'operation_conflict'],
            [{ kind: 'refused', reason: 'computer_not_found' }, 404, 'computer_not_found'], [{ kind: 'refused', reason: 'lease_expired' }, 409, 'lease_expired'],
            [{ kind: 'refused', reason: 'renewal_unreconciled' }, 409, 'renewal_unreconciled'], [{ kind: 'refused', reason: 'session_not_found' }, 404, 'session_not_found'],
        ];
        for (const [result, status, code] of cases) {
            mocked.claim.mockResolvedValueOnce(result);
            const { d } = deps();
            expect((await read(await admittedCreate(post(CREATE), d)))).toMatchObject({ status, body: { error: { code } } });
            expect(d.fetch).not.toHaveBeenCalled();
        }
    });

    it('quarantines an unknown or refused exchange: no recheck, delivery or second exchange', async () => {
        const responses: [() => Response | Promise<Response>, NativeOperationState, string, number][] = [
            [() => { throw new TypeError('fetch failed'); }, 'exchange_unknown', 'gateway_unavailable', 202],
            [() => new Response('{}', { status: 503 }), 'exchange_unknown', 'gateway_unavailable', 202],
            [() => new Response('{"token_type":"Bearer"}', { status: 201, headers: { 'content-type': 'application/json' } }), 'exchange_unknown', 'gateway_invalid_response', 202],
            [() => new Response('{}', { status: 403 }), 'exchange_refused', 'gateway_refused', 409],
        ];
        for (const [respond, state, reason, status] of responses) {
            installStore();
            events = [];
            const fetchImpl = vi.fn(async () => respond()) as unknown as typeof fetch;
            const { d } = deps({ fetch: fetchImpl });
            expect(await read(await admittedCreate(post(CREATE), d))).toMatchObject({ status, body: { operation: { state, reason } } });
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(events).not.toContain('recheck');
            expect(d.hostTransport.deliver).not.toHaveBeenCalled();
        }
    });

    it('stops before delivery when placement changes during the exchange or the grant outlives the lease', async () => {
        mocked.recheck.mockResolvedValueOnce({ ok: false, reason: 'placement_changed' });
        const changed = deps();
        expect((await read(await admittedCreate(post(CREATE), changed.d))).body.operation).toMatchObject({ state: 'authority_changed', reason: 'placement_changed', grantId: GRANT_ID });
        expect(changed.d.hostTransport.deliver).not.toHaveBeenCalled();

        installStore();
        mocked.recheck.mockResolvedValueOnce({ ok: true, placement: PLACEMENT, leaseUntil: new Date(NOW + 60_000) });
        const short = deps();
        expect((await read(await admittedCreate(post(CREATE), short.d))).body.operation).toMatchObject({ state: 'authority_changed', reason: 'lease_boundary' });
        expect(short.d.hostTransport.deliver).not.toHaveBeenCalled();
    });

    it('never sends when the claimed→exchanging compare-and-swap is lost', async () => {
        mocked.advance.mockResolvedValueOnce(null);
        mocked.lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(operation('create', 'exchanging'));
        const { d } = deps();
        expect((await read(await admittedCreate(post(CREATE), d))).body.operation).toMatchObject({ state: 'exchanging', settled: false });
        expect(d.fetch).not.toHaveBeenCalled();
    });

    it('records host refusal and unknown acknowledgement truthfully, without a fake ACK or retry', async () => {
        const outcomes: [() => Promise<unknown>, NativeOperationState, string][] = [
            [async () => ({ kind: 'refused', reason: 'placement_mismatch' }), 'host_refused', 'placement_mismatch'],
            [async () => ({ kind: 'unknown', reason: 'host_timeout' }), 'delivery_unknown', 'host_timeout'],
            [async () => { throw new Error('socket hang up'); }, 'delivery_unknown', 'host_no_ack'],
        ];
        for (const [deliver, state, reason] of outcomes) {
            installStore();
            const transport = { available: true, supportsKind: () => true, checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: vi.fn(deliver) } as unknown as Deps['hostTransport'];
            const { d } = deps({ hostTransport: transport });
            expect((await read(await admittedCreate(post(CREATE), d))).body.operation).toMatchObject({ state, reason });
            expect(transport.deliver).toHaveBeenCalledTimes(1);
            expect(d.fetch).toHaveBeenCalledTimes(1);
        }
    });

    it('blocks renewal without an actual Core admission revision CAS', async () => {
        installStore('renew');
        const { d, deliveries } = deps({ taskResolver: null });
        expect(await read(await admittedRenew(post({ operationId: OP }), SESSION, d))).toMatchObject({ status: 503, body: { error: { reason: 'host_unavailable' } } });
        expect(mocked.claim).not.toHaveBeenCalled();expect(outbox.prepareNativeRenewal).not.toHaveBeenCalled();expect(deliveries).toHaveLength(0);
    });
});

describe('replay ownership (Root decision)', () => {
    it('answers an identical key 404 with no receipt once the computer is no longer the caller\'s, but conflicts on other input forever', async () => {
        for (const prior of ['lookup', 'claim-race'] as const) {
            mocked.owned.mockResolvedValue(false);
            if (prior === 'lookup') mocked.lookup.mockResolvedValue(operation('create', 'delivered'));
            else mocked.claim.mockResolvedValue({ kind: 'existing', operation: operation('create', 'delivered') });
            const { d } = deps();
            const res = await read(await admittedCreate(post(CREATE), d));
            expect(res).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
            expect(res.body).not.toHaveProperty('operation');
            const text = JSON.stringify(res);
            for (const field of [OP, COMPUTER, SESSION, 'delivered', 'grant']) expect(text, `${prior} ${field}`).not.toContain(field);
            expect(mocked.owned).toHaveBeenLastCalledWith(d.db, USER, COMPUTER);
            expect(d.fetch).not.toHaveBeenCalled();
            expect(d.hostTransport.deliver).not.toHaveBeenCalled();
            expect(mocked.advance).not.toHaveBeenCalled();
            installStore();
        }
        mocked.owned.mockClear();
        mocked.owned.mockResolvedValue(false);
        mocked.lookup.mockResolvedValue(operation('create', 'delivered'));
        expect(await read(await admittedCreate(post({ ...CREATE, taskRef: 'task:other' }), deps().d)))
            .toMatchObject({ status: 409, body: { error: { code: 'operation_conflict' } } });
        expect(mocked.owned).not.toHaveBeenCalled();
    });

    it('returns the original read-only receipt to the current owner with every capability off and zero effects', async () => {
        mocked.lookup.mockResolvedValue({ ...operation('create', 'authority_changed'), reason: 'lease_expired' });
        const { d } = deps({ env: { ...ENV, EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL: undefined }, taskResolver: null,
            hostTransport: { available: false, supportsKind: () => false, checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: throwing('deliver') }, currentAccessToken: throwing('currentAccessToken') });
        expect(await read(await admittedCreate(post(CREATE), d))).toMatchObject({ status: 409,
            body: { operation: { operationId: OP, state: 'authority_changed', reason: 'lease_expired', replayed: true } } });
        expect(d.fetch).not.toHaveBeenCalled();
        for (const fn of [mocked.claim, mocked.advance, mocked.recheck]) expect(fn).not.toHaveBeenCalled();
    });
});

describe('fresh pre-send admission', () => {


    it('refuses an expired post-CAS lease before Gateway dispatch', async () => {
        vi.mocked(outbox.prepareNativeRenewal).mockResolvedValueOnce({ kind: 'refused', reason: 'lease_invalid' });
        const { d } = deps();
        expect(await read(await admittedCreate(post(CREATE), d))).toMatchObject({ status: 409, body: { operation: { state: 'exchange_refused', reason: 'lease_boundary' } } });
        expect(outbox.dispatchNativeOperationOnce).not.toHaveBeenCalled();expect(d.fetch).not.toHaveBeenCalled();
    });

    it('records service expiry or a revoked consent as a definite unsent refusal', async () => {
        for (const reason of ['service_expired', 'authorization_revoked'] as const) {
            installStore();
            vi.mocked(outbox.prepareNativeRenewal).mockResolvedValueOnce({ kind: 'refused', reason });
            const { d } = deps();
            expect((await read(await admittedCreate(post(CREATE), d))).body.operation).toMatchObject({ state: 'exchange_refused', reason: reason === 'service_expired' ? reason : 'gateway_refused' });
            expect(d.fetch).not.toHaveBeenCalled();expect(d.currentAccessToken).not.toHaveBeenCalled();
        }
    });
});

describe('lease bound and hard delivery deadline', () => {
    it('pins claim to the approved placement without a browser proof expiry ceiling', async () => {
        mocked.claim.mockResolvedValueOnce({ kind: 'refused', reason: 'lease_boundary' });
        const { d } = deps();
        expect(await read(await admittedCreate(post(CREATE), d))).toMatchObject({ status: 409, body: { error: { code: 'lease_boundary' } } });
        expect(mocked.claim).toHaveBeenCalledWith(d.db, USER, expect.objectContaining({ kind: 'create', operationId: OP }), { expectPlacement: PLACEMENT });
        expect(d.fetch).not.toHaveBeenCalled();
    });

    it('bounds the durable outbox lease by the admitted placement lease', async () => {
        mocked.claim.mockImplementationOnce(async () => ({ kind: 'claimed', operation: stored, leaseUntil: new Date(NOW + 180_000) }));
        const { d } = deps();await admittedCreate(post(CREATE), d);
        expect(outbox.prepareNativeRenewal).toHaveBeenCalledWith(d.db, expect.anything(), expect.objectContaining({ leaseExpiresAt: new Date(NOW + 180_000).toISOString() }));
    });

    it('stops waiting at the deadline even if the adapter ignores abort; a late ACK never promotes the operation', async () => {
        let ack!: (outcome: { kind: 'acknowledged' }) => void;
        let sawAbort = false;
        const transport = { available: true, supportsKind: () => true, checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: vi.fn((_delivery: unknown, signal: AbortSignal) => {
            signal.addEventListener('abort', () => { sawAbort = true; });
            return new Promise<{ kind: 'acknowledged' }>(resolve => { ack = resolve; }); // ignores the signal
        }) } as unknown as Deps['hostTransport'];
        const { d } = deps({ hostTransport: transport, deliveryTimeoutMs: 25 });
        const res = await read(await admittedCreate(post(CREATE), d));
        expect(res).toMatchObject({ status: 202, body: { operation: { state: 'delivery_unknown', reason: 'host_timeout', settled: true } } });
        expect(sawAbort).toBe(true);
        ack({ kind: 'acknowledged' });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(stored.state).toBe('delivery_unknown');
        expect(mocked.advance.mock.calls.map(call => call[3])).not.toContain('delivered');
        expect(transport.deliver).toHaveBeenCalledTimes(1);
        expect(d.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('status (GET)', () => {
    it('reads persisted current-owner status with no proof refresh, exchange, host call or write', async () => {
        mocked.status.mockResolvedValueOnce({ created: { ...operation('create', 'delivered'), grantId: GRANT_ID, grantExpiresAt: new Date(NOW + 240_000) },
            latest: operation('renew', 'exchange_unknown') });
        const { d, supabaseClient } = deps({ hostTransport: { get available(): boolean { throw new Error('host lookup'); }, supportsKind: throwing('supportsKind'), checkReadiness: throwing('checkReadiness'), deliver: throwing('deliver') },
            taskResolver: { resolve: throwing('resolve') }, currentAccessToken: throwing('currentAccessToken'), fetch: throwing('fetch') as unknown as typeof fetch });
        const res = await read(await handleNativeSessionStatus(get(), SESSION, d));
        expect(res).toMatchObject({ status: 200, cache: expect.stringContaining('no-store'), body: { session: { sessionId: SESSION, computerId: COMPUTER, instructionRevision: 1,
            created: { state: 'delivered', grantId: GRANT_ID }, latest: { kind: 'renew', state: 'exchange_unknown', settled: true } } } });
        expect(mocked.status).toHaveBeenCalledWith(d.db, USER, SESSION);
        expect(supabaseClient.auth.getUser).toHaveBeenCalledTimes(1);
        expect(supabaseClient.auth.getSession).not.toHaveBeenCalled();
        expect(supabaseClient.auth.refreshSession).not.toHaveBeenCalled();
        for (const fn of [mocked.claim, mocked.advance, mocked.recheck, mocked.lookup]) expect(fn).not.toHaveBeenCalled();
        expect(JSON.stringify(res)).not.toMatch(/ezs_|ezg_|placement|fence/);
    });

    it('answers 404 for no current owned session, 400 for a bad id and 401 without a cookie user', async () => {
        mocked.status.mockResolvedValueOnce(null);
        expect((await read(await handleNativeSessionStatus(get(), SESSION, deps().d))).body.error.code).toBe('session_not_found');
        expect((await handleNativeSessionStatus(get(), 'nope', deps().d)).status).toBe(400);
        const anonymous = deps();
        anonymous.supabaseClient.auth.getUser.mockResolvedValue({ data: { user: null } } as never);
        expect((await handleNativeSessionStatus(get(), SESSION, anonymous.d)).status).toBe(401);
        expect(mocked.status).toHaveBeenCalledTimes(1);
    });
});

describe('no secret leakage', () => {
    it('keeps proof, service credential and grant out of every response and log, including failures', async () => {
        const responses: Response[] = [];
        mocked.claim.mockRejectedValueOnce(new Error(`db exploded near ${PROOF} ${SERVICE}`));
        responses.push(await admittedCreate(post(CREATE), deps().d));
        installStore();
        mocked.advance.mockImplementationOnce(async () => { throw new Error(`write failed ${GRANT}`); });
        responses.push(await admittedCreate(post(CREATE), deps().d));
        installStore();
        responses.push(await admittedCreate(post(CREATE), deps().d));
        const bodies = await Promise.all(responses.map(read));
        expect(bodies.map(b => b.status)).toEqual([500, 500, 201]);
        const text = JSON.stringify([bodies, logs]);
        for (const secret of SECRETS) expect(text).not.toContain(secret);
    });

    it('logs only a fixed category, never an error name, code, message, stack or cause carrying secrets', async () => {
        const poisoned = Object.assign(new Error(`message ${PROOF}`), { code: SERVICE, cause: GRANT });
        poisoned.name = `Leak ${SERVICE} ${PROOF} ${GRANT}`;
        poisoned.stack = `${poisoned.name}\n at ${GRANT}`;
        mocked.lookup.mockRejectedValueOnce(poisoned);
        mocked.status.mockRejectedValueOnce(poisoned);
        const bodies = [await read(await handleNativeSessionCreate(post(CREATE), deps().d)), await read(await handleNativeSessionStatus(get(), SESSION, deps().d))];
        expect(bodies.map(b => [b.status, b.body.error.code])).toEqual([[500, 'internal_error'], [500, 'internal_error']]);
        expect(logs).toEqual([
            ['[native-session] POST /api/shell/native-sessions failed', { category: 'unexpected' }],
            ['[native-session] GET /api/shell/native-sessions/[sessionId] failed', { category: 'unexpected' }],
        ]);
        const text = JSON.stringify([bodies, logs]);
        for (const secret of [...SECRETS, 'Leak']) expect(text).not.toContain(secret);
    });
});
