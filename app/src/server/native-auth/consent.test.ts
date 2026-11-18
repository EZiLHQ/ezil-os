import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeOperation } from '@/server/native-session/authority';

vi.mock('@/server/native-session/authority', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/native-session/authority')>();
    return { ...actual, lookupNativeOperation: vi.fn(), nativeComputerOwnedNow: vi.fn() };
});
vi.mock('@/server/native-session/http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/native-session/http')>();
    return { ...actual, runNativeOperation: vi.fn() };
});
vi.mock('./store', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./store')>();
    return { ...actual, lookupNativeIntent: vi.fn(), decideNativeIntent: vi.fn(), approveNativeIntent: vi.fn(), blockApprovedNativeIntent: vi.fn(),
        revokeNativeConsent: vi.fn(), nativeConsentRevokedAt: vi.fn(async () => null) };
});

vi.mock('./consent-binding', async importOriginal => ({ ...await importOriginal<typeof import('./consent-binding')>(), readApprovedNativeConsentBinding: vi.fn() }));

const authority = await import('@/server/native-session/authority');
const consentBinding = await import('./consent-binding');
const http = await import('@/server/native-session/http');
const store = await import('./store');
const { brokerRequestFor, handleNativeConsentDecision, loadNativeConsent, productionNativeConsentDeps } = await import('./consent');
const { nativeConsentTermsDigest, nativeInstructionDigest, nativeIntentInputDigest } = await import('./contract');
type Deps = import('@/server/native-session/http').NativeSessionDeps;
type Intent = import('./store').NativeIntent;

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const ORIGIN = 'https://os-staging.ezil.work';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const COMPUTER = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const OP = '22222222-2222-4222-8222-222222222222';
const INSTRUCTION = 'SECRET-TASK: ship it\n';
const DIGEST = nativeInstructionDigest(INSTRUCTION);
const INPUT_DIGEST = nativeIntentInputDigest({ kind: 'create', operationId: OP, sessionId: SESSION, computerId: COMPUTER, instructionRevision: 1,
    instructionDigest: DIGEST, instruction: INSTRUCTION });
const SERVICE = `ezs_${Buffer.alloc(32, 0x5a).toString('base64url')}`;
const ENV = {
    EZIL_NATIVE_AUTHORIZATION: 'enabled', EZIL_NATIVE_AUTHORIZATION_ISSUER: 'fixture', EZIL_NATIVE_AUTHORIZATION_AUDIENCE: 'fixture',
    EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY_ID: 'fixture', EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY: 'fixture',
    EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL: SERVICE, EZIL_NATIVE_AUTHORIZATION_SERVICE_EXPIRES_AT: '2026-11-17T00:00:00+00:00',
    EZIL_NATIVE_GRANT_WRAPPING_KEY_ID: 'fixture', EZIL_NATIVE_GRANT_WRAPPING_KEY: 'fixture',
    EZIL_NATIVE_AUTH_INTENTS: '1', EZIL_NATIVE_SESSIONS: '1', EZIL_NATIVE_SESSIONS_ORIGIN: ORIGIN, EZIL_NATIVE_AUTHORIZATION_POLICY_ID: '0b6f8a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b',
    EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: SERVICE, EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT: '2026-11-17T00:00:00+00:00',
    EZIL_NATIVE_CONSENT_EPOCH: '7', EZIL_NATIVE_CONSENT_BUDGET_MICRO: '2500000', EZIL_NATIVE_CONSENT_TTL_SECONDS: '86400',
};
const TERMS = { policyId: '0b6f8a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b', epoch: '7', budgetMicro: '2500000', ttlSeconds: 86_400 };
const TERMS_DIGEST = nativeConsentTermsDigest(TERMS);
const PLACEMENT = { generation: '3000000001', leaseEpoch: '4294967301', instanceId: 'i-0123456789abcdef0', fenceToken: '66666666-6666-4666-8666-666666666666' };
const BOUND = { authzId: '77777777-7777-4777-8777-777777777777', epoch: '7', budgetMicro: '2500000', policyId: TERMS.policyId,
    service: 'ezil-os-native' as const, profile: 'ezil-native-claude-v1' as const, initialApprovalAt: new Date(NOW),
    authorizationDeadline: new Date(NOW + 86_400_000), placement: PLACEMENT };
const PAGE = `${ORIGIN}/native/authorize/${OP}`;

const mocked = {
    lookupIntent: vi.mocked(store.lookupNativeIntent), decide: vi.mocked(store.decideNativeIntent), approve: vi.mocked(store.approveNativeIntent),
    blockApproved: vi.mocked(store.blockApprovedNativeIntent), lookupOp: vi.mocked(authority.lookupNativeOperation),
    owned: vi.mocked(authority.nativeComputerOwnedNow), run: vi.mocked(http.runNativeOperation),
    binding: vi.mocked(consentBinding.readApprovedNativeConsentBinding), revoke: vi.mocked(store.revokeNativeConsent),
    revokedAt: vi.mocked(store.nativeConsentRevokedAt),
};
const BINDING = Object.freeze({
    authorizationId: BOUND.authzId, epoch: '7', budgetMicro: '2500000', ownerUserId: USER, sessionId: SESSION, computerId: COMPUTER,
    placement: PLACEMENT, clientId: 'ezil-mcp-staging', serviceId: 'ezil-os-native' as const, profileId: 'ezil-native-claude-v1' as const,
    policyId: TERMS.policyId, initialApprovalAt: new Date(NOW).toISOString(), authorizationDeadline: new Date(NOW + 86_400_000).toISOString(),
});

function intent(overrides: Partial<Intent> = {}): Intent {
    return {
        userId: USER, operationId: OP, kind: 'create', sessionId: SESSION, computerId: COMPUTER, instructionRevision: 1, instructionDigest: DIGEST,
        instruction: INSTRUCTION, inputDigest: INPUT_DIGEST, clientId: 'ezil-mcp-staging', idpIssuer: 'https://id.ezil.work/', subject: 'auth0|abc',
        scope: 'ezil:native-sessions:read ezil:native-sessions:write', state: 'required', reason: null, terms: null, createdAt: new Date(NOW - 10_000),
        expiresAt: new Date(NOW + 290_000), decidedAt: null, ...overrides,
    };
}

function op(state: NativeOperation['state']): NativeOperation {
    return {
        userId: USER, operationId: OP, kind: 'create', sessionId: SESSION, computerId: COMPUTER, instructionRevision: '1', instructionDigest: DIGEST,
        taskRef: `native-task:${OP}`, requestDigest: `sha256:${'a'.repeat(64)}`, placement: { generation: '1', leaseEpoch: '1', instanceId: 'i-0123456789abcdef0',
            fenceToken: '66666666-6666-4666-8666-666666666666' }, state, reason: null, grantId: null, grantExpiresAt: null,
        createdAt: new Date(NOW), updatedAt: new Date(NOW),
    };
}

const throwing = (name: string) => vi.fn(() => { throw new Error(`unexpected ${name}`); });

function deps(overrides: Partial<Deps> = {}, user: string | null = USER) {
    const supabaseClient = { auth: { getUser: vi.fn(async () => ({ data: { user: user ? { id: user } : null } })),
        getSession: throwing('getSession'), refreshSession: throwing('refreshSession') } };
    const d: Deps = {
        env: ENV, supabase: vi.fn(async () => supabaseClient), db: { execute: throwing('db.execute'), transaction: throwing('db.transaction') } as unknown as Deps['db'],
        fetch: throwing('fetch') as unknown as typeof fetch, hostTransport: { available: true, supportsKind: () => true, checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: throwing('deliver') },
        taskResolver: { resolve: throwing('resolve') }, currentAccessToken: throwing('currentAccessToken'), now: () => NOW, ...overrides,
    };
    return { d, supabaseClient };
}

/** The page's form: allow, the shown intent digest and the shown terms digest. A null override removes a field. */
const decide = (overrides: Record<string, string | null> = {}, headers: Record<string, string> = {}) => {
    const fields = Object.entries({ decision: 'allow', inputDigest: INPUT_DIGEST, termsDigest: TERMS_DIGEST, ...overrides })
        .filter((entry): entry is [string, string] => entry[1] !== null);
    return new Request(`${ORIGIN}/api/native/authorize/${OP}`, { method: 'POST', body: new URLSearchParams(fields).toString(),
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', cookie: 'sb=1', ...headers } });
};

let logs: unknown[];
beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...a) => { logs.push(a); });
    mocked.lookupIntent.mockResolvedValue(intent());
    mocked.lookupOp.mockResolvedValue(null);
    mocked.owned.mockResolvedValue(true);
    mocked.decide.mockImplementation(async (_db, _u, _o, to, reason = null) => intent({ state: to, reason, decidedAt: new Date(NOW) }));
    mocked.approve.mockImplementation(async () => ({ kind: 'approved', intent: intent({ state: 'approved', decidedAt: new Date(NOW), terms: BOUND }) }));
    mocked.blockApproved.mockResolvedValue(null);
    mocked.binding.mockResolvedValue(BINDING);
    mocked.run.mockResolvedValue({ kind: 'operation', operation: op('delivered'), replayed: false });
});

const effects = () => [mocked.decide, mocked.approve, mocked.blockApproved, mocked.run];

describe('request guard (origin, CSRF, cookie only)', () => {
    it('refuses bearer, foreign or missing origin and cross-site fetches before reading the body or identity', async () => {
        for (const [headers, status] of [[{ authorization: 'Bearer x' }, 401], [{ origin: 'https://evil.example' }, 403], [{ origin: 'null' }, 403],
            [{ 'sec-fetch-site': 'cross-site' }, 403], [{ 'sec-fetch-site': 'same-site' }, 403]] as const) {
            const { d } = deps();
            expect((await handleNativeConsentDecision(decide(undefined, headers), OP, d)).status).toBe(status);
            expect(d.supabase).not.toHaveBeenCalled();
        }
        const noOrigin = new Request(`${ORIGIN}/api/native/authorize/${OP}`, { method: 'POST', body: 'decision=allow',
            headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        expect((await handleNativeConsentDecision(noOrigin, OP, deps().d)).status).toBe(403);
        for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
    });

    it('accepts only the exact small form with decision and the shown intent digest', async () => {
        for (const [req, status] of [
            [decide(undefined, { 'content-type': 'application/json' }), 415],
            [decide({ inputDigest: null }), 400], [decide({ termsDigest: null }), 400], [decide({ decision: 'maybe' }), 400],
            [decide({ extra: '1' }), 400], [decide({ inputDigest: 'sha256:x' }), 400], [decide({ termsDigest: 'sha256:x' }), 400],
            [new Request(`${ORIGIN}/api/native/authorize/${OP}`, { method: 'POST',
                body: `decision=allow&decision=deny&inputDigest=${INPUT_DIGEST}&termsDigest=${TERMS_DIGEST}`,
                headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } }), 400],
            [decide({ pad: 'x'.repeat(600) }), 413],
        ] as const) {
            expect((await handleNativeConsentDecision(req, OP, deps().d)).status).toBe(status);
        }
        expect((await handleNativeConsentDecision(decide(), 'ABCDEF22-2222-4222-8222-222222222222', deps().d)).status).toBe(404);
        for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
    });

    it('is off (404) unless both gates are on', async () => {
        for (const env of [{ ...ENV, EZIL_NATIVE_AUTH_INTENTS: undefined }, { ...ENV, EZIL_NATIVE_SESSIONS: '0' }]) {
            expect((await handleNativeConsentDecision(decide(), OP, deps({ env }).d)).status).toBe(404);
        }
    });
});

describe('identity and ownership', () => {
    it('sends a signed-out POST through normal sign-in with the exact consent page as the return URL', async () => {
        const res = await handleNativeConsentDecision(decide(), OP, deps({}, null).d);
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe(`${ORIGIN}/login?returnUrl=%2Fnative%2Fauthorize%2F${OP}`);
        expect(mocked.lookupIntent).not.toHaveBeenCalled();
    });

    it('treats another account (an account switch) exactly like a missing intent and never rebinds', async () => {
        mocked.lookupIntent.mockImplementation(async (_db, userId) => (userId === USER ? intent() : null));
        const res = await handleNativeConsentDecision(decide(), OP, deps({}, OTHER_USER).d);
        expect(res.status).toBe(404);
        expect(mocked.lookupIntent).toHaveBeenCalledWith(expect.anything(), OTHER_USER, OP);
        expect(JSON.stringify(await res.json())).not.toContain(SESSION);
        for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
    });

    it('answers 404 once the computer is deleted or transferred, and 409 for a stale page', async () => {
        mocked.owned.mockResolvedValueOnce(false);
        expect((await handleNativeConsentDecision(decide(), OP, deps().d)).status).toBe(404);
        expect((await handleNativeConsentDecision(decide({ inputDigest: `sha256:${'f'.repeat(64)}` }), OP, deps().d)).status).toBe(409);
        for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
    });

    it('loads the private instruction for the owner page only, and nothing for another account', async () => {
        mocked.lookupIntent.mockImplementation(async (_db, userId) => (userId === USER ? intent() : null));
        const { d } = deps();
        const view = await loadNativeConsent(d, USER, OP);
        expect(view).toMatchObject({ instruction: INSTRUCTION, inputDigest: INPUT_DIGEST, decidable: true,
            receipt: { authorization: { state: 'required', authorizationUrl: PAGE } }, terms: { offered: TERMS, bound: null }, termsDigest: TERMS_DIGEST });
        expect(JSON.stringify(view!.receipt)).not.toContain('SECRET-TASK');
        expect(await loadNativeConsent(d, OTHER_USER, OP)).toBeNull();
        for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
    });

    it('shows the actual terms and is not decidable without admitted terms or for a renewal', async () => {
        const noTerms = await loadNativeConsent(deps({ env: { ...ENV, EZIL_NATIVE_CONSENT_BUDGET_MICRO: '0' } }).d, USER, OP);
        expect(noTerms).toMatchObject({ decidable: false, terms: { offered: null, bound: null } });
        mocked.lookupIntent.mockResolvedValueOnce(intent({ kind: 'renew', instruction: null, instructionDigest: null, instructionRevision: null }));
        expect(await loadNativeConsent(deps().d, USER, OP)).toMatchObject({ decidable: false, instruction: null });
        mocked.lookupIntent.mockResolvedValueOnce(intent({ state: 'approved', decidedAt: new Date(NOW), terms: BOUND }));
        expect(await loadNativeConsent(deps().d, USER, OP)).toMatchObject({ decidable: false, terms: { bound: BOUND } });
    });
});

describe('decisions', () => {
    it('denies with one CAS and no dispatch', async () => {
        const res = await handleNativeConsentDecision(decide({ decision: 'deny' }), OP, deps().d);
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe(PAGE);
        expect(mocked.decide).toHaveBeenCalledWith(expect.anything(), USER, OP, 'denied');
        for (const fn of [mocked.approve, mocked.run]) expect(fn).not.toHaveBeenCalled();
    });

    it('never resurrects or re-dispatches a decided intent (reload, second tab)', async () => {
        for (const state of ['approved', 'denied', 'expired', 'blocked'] as const) {
            mocked.lookupIntent.mockResolvedValueOnce(intent({ state, decidedAt: new Date(NOW), reason: state === 'blocked' ? 'host_unavailable' : null }));
            expect((await handleNativeConsentDecision(decide(), OP, deps().d)).status).toBe(303);
        }
        for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
    });

    it('settles an expired intent as expired, never approves it', async () => {
        mocked.lookupIntent.mockResolvedValueOnce(intent({ expiresAt: new Date(NOW) }));
        expect((await handleNativeConsentDecision(decide(), OP, deps().d)).status).toBe(303);
        expect(mocked.decide).toHaveBeenCalledWith(expect.anything(), USER, OP, 'expired');
        for (const fn of [mocked.approve, mocked.run]) expect(fn).not.toHaveBeenCalled();
    });

    it('blocks for good at preflight when the host is missing or the kind unsupported: zero proof, claim, exchange or dispatch', async () => {
        const cases: [Partial<Deps>, Partial<Intent>, string][] = [
            [{ hostTransport: { available: false, supportsKind: () => true, checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: throwing('deliver') } }, {}, 'host_unavailable'],
            [{ hostTransport: { available: true, supportsKind: kind => kind === 'renew', checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: throwing('deliver') } }, {}, 'host_unavailable'],
            [{ env: { ...ENV, EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL: undefined } }, {}, 'gateway_exchange_unconfigured'],
            [{ taskResolver: null }, {}, 'task_resolver_unavailable'],
            [{}, { scope: 'ezil:native-sessions:read' }, 'scope_missing'],
            [{ env: { ...ENV, EZIL_NATIVE_CONSENT_EPOCH: undefined } }, {}, 'consent_terms_unavailable'],
            [{ env: { ...ENV, EZIL_NATIVE_CONSENT_TTL_SECONDS: '86401' } }, {}, 'consent_terms_unavailable'],
            [{ env: { ...ENV, EZIL_NATIVE_CONSENT_BUDGET_MICRO: '01' } }, {}, 'consent_terms_unavailable'],
        ];
        for (const [overrides, stored, reason] of cases) {
            vi.clearAllMocks();
            mocked.lookupIntent.mockResolvedValue(intent(stored));
            mocked.owned.mockResolvedValue(true);
            mocked.lookupOp.mockResolvedValue(null);
            const { d } = deps(overrides);
            expect((await handleNativeConsentDecision(decide(), OP, d)).status, reason).toBe(303);
            expect(mocked.decide, reason).toHaveBeenCalledWith(expect.anything(), USER, OP, 'blocked', reason);
            for (const fn of [mocked.approve, mocked.run, d.currentAccessToken, d.fetch, d.hostTransport.deliver]) expect(fn, reason).not.toHaveBeenCalled();
        }
    });

    it('refuses unseen terms: a changed budget, policy, epoch or lifetime is a stale page with no state change', async () => {
        for (const env of [{ ...ENV, EZIL_NATIVE_CONSENT_BUDGET_MICRO: '2500001' }, { ...ENV, EZIL_NATIVE_CONSENT_EPOCH: '8' },
            { ...ENV, EZIL_NATIVE_CONSENT_TTL_SECONDS: '3600' }, { ...ENV, EZIL_NATIVE_AUTHORIZATION_POLICY_ID: '1b6f8a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b' }]) {
            const res = await handleNativeConsentDecision(decide(), OP, deps({ env }).d);
            expect(res.status).toBe(409);
            expect((await res.json() as { error: { code: string } }).error.code).toBe('terms_changed');
        }
        for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
    });

    it('blocks before any proof or claim when the computer is not deliverable at approval (checked under the broker locks)', async () => {
        mocked.approve.mockResolvedValueOnce({ kind: 'refused', reason: 'computer_not_running' });
        const { d } = deps();
        expect((await handleNativeConsentDecision(decide(), OP, d)).status).toBe(303);
        expect(mocked.decide).toHaveBeenCalledWith(expect.anything(), USER, OP, 'blocked', 'computer_not_running');
        for (const fn of [mocked.run, d.currentAccessToken, d.fetch]) expect(fn).not.toHaveBeenCalled();
    });

    it('takes delivery metadata only from the trusted reader: no binding is a pre-claim block with zero proof or dispatch', async () => {
        mocked.binding.mockResolvedValueOnce(null);
        const { d } = deps();
        expect((await handleNativeConsentDecision(decide(), OP, d)).status).toBe(303);
        expect(mocked.blockApproved).toHaveBeenCalledWith(expect.anything(), USER, OP, 'authorization_unavailable');
        for (const fn of [mocked.run, d.currentAccessToken, d.fetch]) expect(fn).not.toHaveBeenCalled();
    });

    it('never browser-approves a renewal: no decision, proof, claim or dispatch', async () => {
        mocked.lookupIntent.mockResolvedValue(intent({ kind: 'renew', instruction: null, instructionDigest: null, instructionRevision: null }));
        const { d } = deps();
        expect((await handleNativeConsentDecision(decide(), OP, d)).status).toBe(303);
        for (const fn of [...effects(), d.currentAccessToken, d.fetch]) expect(fn).not.toHaveBeenCalled();
    });

    it('approves and seals once, then dispatches the exact server-derived request with this request\'s own cookie identity', async () => {
        const { d, supabaseClient } = deps();
        const req = decide();
        expect((await handleNativeConsentDecision(req, OP, d)).status).toBe(303);
        expect(mocked.approve).toHaveBeenCalledWith(expect.anything(), USER, OP, COMPUTER, INPUT_DIGEST, TERMS);
        expect(mocked.run).toHaveBeenCalledTimes(1);
        // The claim receives the tuple pinned at approval, never one inferred later.
        expect(mocked.run).toHaveBeenCalledWith(d, { userId: USER, supabase: supabaseClient, headers: req.headers }, {
            kind: 'create', operationId: OP, sessionId: SESSION, computerId: COMPUTER, instructionRevision: 1, instructionDigest: DIGEST, taskRef: `native-task:${OP}`,
        }, { placement: PLACEMENT, sourceAuthorization: { authorizationId: BOUND.authzId, epoch: '7', authorizationDeadline: new Date(NOW + 86_400_000).toISOString(),
            clientId: 'ezil-mcp-staging', profileId: 'ezil-native-claude-v1', policyId: TERMS.policyId, budgetMicro: '2500000',
            initialApprovalAt: new Date(NOW).toISOString() }, computerId: COMPUTER, consentOperationId: OP, consentRecheck: expect.any(Function) });
        expect(mocked.binding).toHaveBeenCalledWith(expect.anything(), { ownerUserId: USER, operationId: OP });
        // The recheck re-reads the trusted binding; when it is gone it distinguishes a stop from any other loss.
        const recheck = mocked.run.mock.calls[0]![3]!.consentRecheck!;
        expect(await recheck()).toBe('ok');
        mocked.binding.mockResolvedValueOnce(null);
        mocked.revokedAt.mockResolvedValueOnce(new Date(NOW));
        expect(await recheck()).toBe('authorization_revoked');
        mocked.binding.mockResolvedValueOnce(null);
        expect(await recheck()).toBe('authorization_unavailable');
        expect(mocked.binding.mock.invocationCallOrder[0]).toBeLessThan(mocked.run.mock.invocationCallOrder[0]!);
        expect(req.headers.get('authorization')).toBeNull();
        expect(mocked.blockApproved).not.toHaveBeenCalled();
        expect(JSON.stringify(logs)).not.toContain('SECRET-TASK');
    });

    it('dispatches exactly once across concurrent approvals: the CAS loser never runs the broker', async () => {
        let won = false;
        mocked.approve.mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 1));
            if (won) return { kind: 'not_approvable' as const };
            won = true;
            return { kind: 'approved' as const, intent: intent({ state: 'approved', decidedAt: new Date(NOW), terms: BOUND }) };
        });
        const results = await Promise.all([1, 2, 3].map(() => handleNativeConsentDecision(decide(), OP, deps().d)));
        expect(results.map(r => r.status)).toEqual([303, 303, 303]);
        expect(mocked.approve).toHaveBeenCalledTimes(3);
        expect(mocked.run).toHaveBeenCalledTimes(1);
    });

    it('records a definite pre-claim refusal as approved>blocked, but keeps a post-claim or unknown operation approved', async () => {
        for (const [result, reason] of [[{ kind: 'refused', code: 'subject_token_unavailable', status: 401 }, 'subject_token_unavailable'],
            [{ kind: 'refused', code: 'computer_not_running', status: 409, reason: 'computer_not_running' }, 'computer_not_running'],
            [{ kind: 'blocked', reason: 'host_unavailable' }, 'host_unavailable'], [{ kind: 'refused', code: 'weird_thing', status: 409 }, 'dispatch_refused']] as const) {
            mocked.blockApproved.mockClear();
            mocked.run.mockResolvedValueOnce(result as never);
            expect((await handleNativeConsentDecision(decide(), OP, deps().d)).status).toBe(303);
            expect(mocked.blockApproved).toHaveBeenCalledWith(expect.anything(), USER, OP, reason);
        }
        mocked.blockApproved.mockClear();
        for (const state of ['delivery_unknown', 'exchange_unknown', 'host_refused', 'delivered'] as const) {
            mocked.run.mockResolvedValueOnce({ kind: 'operation', operation: op(state), replayed: false });
            await handleNativeConsentDecision(decide(), OP, deps().d);
        }
        expect(mocked.blockApproved).not.toHaveBeenCalled();
    });

    it('leaves an approval whose dispatch threw as approved (reported as dispatch_unknown later), never retried', async () => {
        mocked.run.mockRejectedValueOnce(new Error(`boom ${INSTRUCTION}`));
        const res = await handleNativeConsentDecision(decide(), OP, deps().d);
        expect(res.status).toBe(500);
        expect(mocked.blockApproved).not.toHaveBeenCalled();
        expect(mocked.run).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(logs)).not.toContain('SECRET-TASK');
    });
});

describe('same-ID recovery of an approved create', () => {
    const approvedIntent = () => intent({ state: 'approved', decidedAt: new Date(NOW - 120_000), terms: BOUND });

    it('starts an approved create that has no operation under the same id, binding and terms, once', async () => {
        mocked.lookupIntent.mockResolvedValue(approvedIntent());
        const { d } = deps();
        expect((await handleNativeConsentDecision(decide(), OP, d)).status).toBe(303);
        expect(mocked.approve).not.toHaveBeenCalled();
        expect(mocked.run).toHaveBeenCalledTimes(1);
        expect(mocked.run.mock.calls[0]![2]).toEqual(brokerRequestFor(approvedIntent()));
        expect(mocked.run.mock.calls[0]![3]).toMatchObject({ placement: PLACEMENT, sourceAuthorization: { authorizationId: BOUND.authzId } });
    });

    it('answers any existing operation with zero effects, and never slides terms', async () => {
        mocked.lookupIntent.mockResolvedValue(approvedIntent());
        for (const state of ['claimed', 'exchange_unknown', 'delivery_unknown', 'exchange_refused', 'delivered'] as const) {
            mocked.lookupOp.mockResolvedValueOnce(op(state)).mockResolvedValueOnce(op(state));
            const { d } = deps();
            expect((await handleNativeConsentDecision(decide(), OP, d)).status).toBe(303);
            for (const fn of [mocked.run, mocked.binding, mocked.blockApproved, d.currentAccessToken, d.fetch]) expect(fn, state).not.toHaveBeenCalled();
        }
        // The page must carry the BOUND terms: today's (different) configuration is a stale page.
        const changed = await handleNativeConsentDecision(decide({ termsDigest: nativeConsentTermsDigest({ ...TERMS, budgetMicro: '1' }) }), OP, deps().d);
        expect(changed.status).toBe(409);
        expect((await handleNativeConsentDecision(decide({ decision: 'deny' }), OP, deps().d)).status).toBe(303);
        for (const fn of [mocked.run, mocked.decide, mocked.approve]) expect(fn).not.toHaveBeenCalled();
    });

    it('offers recovery on the owner page only while no operation exists and the consent is not stopped', async () => {
        mocked.lookupIntent.mockResolvedValue(approvedIntent());
        expect(await loadNativeConsent(deps().d, USER, OP)).toMatchObject({ recoveryTermsDigest: TERMS_DIGEST, decidable: false });
        mocked.lookupOp.mockResolvedValue(op('delivery_unknown'));
        expect(await loadNativeConsent(deps().d, USER, OP)).toMatchObject({ recoveryTermsDigest: null });
        mocked.lookupOp.mockResolvedValue(null);
        mocked.revokedAt.mockResolvedValue(new Date(NOW));
        expect(await loadNativeConsent(deps().d, USER, OP)).toMatchObject({ recoveryTermsDigest: null, revokedAt: new Date(NOW) });
        mocked.revokedAt.mockResolvedValue(null);
    });

    it('projects a stopped consent as blocked/authorization_unavailable, keeping the exact operation and the persisted intent', async () => {
        mocked.lookupIntent.mockResolvedValue(approvedIntent());
        mocked.lookupOp.mockResolvedValue({ ...op('delivery_unknown'), reason: 'host_timeout', grantId: '55555555-5555-4555-8555-555555555555',
            grantExpiresAt: new Date(NOW + 240_000) });
        mocked.revokedAt.mockResolvedValue(new Date(NOW));
        const view = await loadNativeConsent(deps().d, USER, OP);
        expect(view!.receipt.authorization).toEqual({ state: 'blocked', expiresAt: approvedIntent().expiresAt.toISOString(), authorizationUrl: null,
            reason: 'authorization_unavailable' });
        expect(view!.receipt.operation).toMatchObject({ state: 'delivery_unknown', reason: 'host_timeout', grantId: '55555555-5555-4555-8555-555555555555' });
        mocked.revokedAt.mockResolvedValue(null);
        for (const fn of [mocked.decide, mocked.blockApproved, mocked.run]) expect(fn).not.toHaveBeenCalled();
    });

    it('a consent stopped before dispatch leaves the persisted intent approved; any other unreadable binding is a pre-claim block', async () => {
        mocked.lookupIntent.mockResolvedValue(approvedIntent());
        mocked.binding.mockResolvedValueOnce(null);
        // First read is the projection (not yet stopped), the second is the dispatch's (stopped meanwhile).
        mocked.revokedAt.mockResolvedValueOnce(null).mockResolvedValueOnce(new Date(NOW));
        await handleNativeConsentDecision(decide(), OP, deps().d);
        expect(mocked.blockApproved).not.toHaveBeenCalled();
        mocked.binding.mockResolvedValueOnce(null);
        await handleNativeConsentDecision(decide(), OP, deps().d);
        expect(mocked.blockApproved).toHaveBeenCalledWith(expect.anything(), USER, OP, 'authorization_unavailable');
        expect(mocked.run).not.toHaveBeenCalled();
    });
});

describe('stop (revoke) the whole AI consent', () => {
    const revokeForm = (overrides: Record<string, string | null> = {}) =>
        decide({ decision: 'revoke', termsDigest: null, authorizationId: BOUND.authzId, ...overrides });

    it('writes the local terminal tombstone for exactly the shown consent, touching no operation', async () => {
        mocked.lookupIntent.mockResolvedValue(intent({ state: 'approved', decidedAt: new Date(NOW), terms: BOUND }));
        mocked.revoke.mockResolvedValue(null);
        const { d } = deps();
        const res = await handleNativeConsentDecision(revokeForm(), OP, d);
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe(PAGE);
        expect(mocked.revoke).toHaveBeenCalledWith(expect.anything(), USER, BOUND.authzId);
        for (const fn of [mocked.decide, mocked.approve, mocked.blockApproved, mocked.run, mocked.binding, d.currentAccessToken, d.fetch]) {
            expect(fn).not.toHaveBeenCalled();
        }
    });

    it('refuses another consent id, an unbound intent, another account, and a malformed form', async () => {
        mocked.lookupIntent.mockResolvedValueOnce(intent({ state: 'approved', decidedAt: new Date(NOW), terms: BOUND }));
        expect((await handleNativeConsentDecision(revokeForm({ authorizationId: '88888888-8888-4888-8888-888888888888' }), OP, deps().d)).status).toBe(409);
        mocked.lookupIntent.mockResolvedValueOnce(intent());
        expect((await handleNativeConsentDecision(revokeForm(), OP, deps().d)).status).toBe(409);
        mocked.lookupIntent.mockImplementationOnce(async (_db, userId) => (userId === USER ? intent({ terms: BOUND, state: 'approved', decidedAt: new Date(NOW) }) : null));
        expect((await handleNativeConsentDecision(revokeForm(), OP, deps({}, OTHER_USER).d)).status).toBe(404);
        for (const form of [revokeForm({ authorizationId: null }), revokeForm({ termsDigest: TERMS_DIGEST }), revokeForm({ authorizationId: 'x' }),
            revokeForm({ inputDigest: null })]) {
            expect((await handleNativeConsentDecision(form, OP, deps().d)).status).toBe(400);
        }
        expect(mocked.revoke).not.toHaveBeenCalled();
    });

    it('shows the stopped state on the owner page', async () => {
        mocked.lookupIntent.mockResolvedValueOnce(intent({ state: 'approved', decidedAt: new Date(NOW), terms: BOUND }));
        // Read twice: by the projection (blocked/authorization_unavailable) and for the page's stopped timestamp.
        mocked.revokedAt.mockResolvedValueOnce(new Date(NOW + 1_000)).mockResolvedValueOnce(new Date(NOW + 1_000));
        expect(await loadNativeConsent(deps().d, USER, OP)).toMatchObject({ revokedAt: new Date(NOW + 1_000), terms: { bound: BOUND },
            receipt: { authorization: { state: 'blocked', reason: 'authorization_unavailable' } } });
    });
});

describe('wiring', () => {
    it('production consent uses the real artifact resolver and a host transport that supports no kind', () => {
        const prod = productionNativeConsentDeps(deps().d.db, deps().d.supabase);
        expect(prod.taskResolver).not.toBeNull();
        expect(prod.hostTransport.available).toBe(false);
        expect(prod.hostTransport.supportsKind('create')).toBe(false);
        expect(prod.hostTransport.supportsKind('renew')).toBe(false);
    });

    it('derives renew requests without any task or computer field', () => {
        expect(brokerRequestFor(intent({ kind: 'renew', instruction: null, instructionDigest: null, instructionRevision: null })))
            .toEqual({ kind: 'renew', operationId: OP, sessionId: SESSION });
    });
});
