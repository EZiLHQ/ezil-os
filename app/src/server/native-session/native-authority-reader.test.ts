import { createHash, createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveControlKey } from '@/server/lib/compute/aws-enroll';

import type { NativeAuthorityCheck, NativeOperation } from './authority';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), recheck: vi.fn() }));
vi.mock('./authority', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./authority')>()),
    lookupNativeOperation: mocks.lookup, recheckNativeAuthority: mocks.recheck,
}));

const { handleNativeAuthorityQuery, NATIVE_POLICY_DIGEST } = await import('./native-authority-reader');

const SECRET = 'fixture-secret-not-real', CID = '33333333-3333-4333-8333-333333333333', OWN = '44444444-4444-4444-8444-444444444444';
const OP = '11111111-1111-4111-8111-111111111111', SES = '22222222-2222-4222-8222-222222222222', RT = '55555555-5555-4555-8555-555555555555';
const FENCE = '66666666-6666-4666-8666-666666666666', NONCE_HASH = 'a'.repeat(64);
const NOW = Date.parse('2026-11-16T22:00:00.000Z');
const PLACE = { generation: '7', leaseEpoch: '3', instanceId: 'i-0123456789abcdef0', fenceToken: FENCE };
const key = deriveControlKey(SECRET, { computerId: CID, generation: 7, leaseEpoch: 3, nonceHash: NONCE_HASH });
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const mac = (parts: (string | number)[]) => `v1=${createHmac('sha256', key).update(parts.join('|')).digest('hex')}`;

function op(state: NativeOperation['state'] = 'delivered'): NativeOperation {
    return { userId: OWN, operationId: OP, kind: 'create', sessionId: SES, computerId: CID, instructionRevision: '1',
        instructionDigest: `sha256:${'b'.repeat(64)}`, taskRef: 'task:x', requestDigest: `sha256:${'c'.repeat(64)}`, placement: { ...PLACE },
        state, reason: null, grantId: FENCE, grantExpiresAt: new Date(NOW + 200_000), createdAt: new Date(NOW), updatedAt: new Date(NOW) };
}
function body(over: Record<string, unknown> = {}) {
    return { v: 1, phase: 'runtime', operationId: OP, sessionId: SES, computerId: CID, ownerUserId: OWN, placement: { ...PLACE },
        runtimeId: RT, policyDigest: NATIVE_POLICY_DIGEST, requestNonce: 'n'.repeat(43), issuedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 30_000).toISOString(), ...over };
}
function request(b: Record<string, unknown>, signature?: string) {
    const raw = JSON.stringify(b);
    const ts = String(Math.floor(NOW / 1000));
    return { raw, req: new Request('https://os.example/api/compute/aws/native-authority', { method: 'POST', body: raw, headers: {
        'x-ezil-computer-id': CID, 'x-ezil-generation': '7', 'x-ezil-lease-epoch': '3', 'x-ezil-timestamp': ts,
        'x-ezil-signature': signature ?? mac(['ezil-native-authority-v1', ts, CID, '7', '3', sha(raw)]) } }) };
}
const deps = (consent: boolean | 'missing' = true) => ({
    env: { CLOUDFLARE_GUACAMOLE_HMAC_SECRET: SECRET }, db: {} as never, now: () => new Date(NOW),
    placement: async () => ({ provider: 'aws-ec2', computerId: CID, generation: 7, leaseEpoch: 3, state: 'RUNNING', instanceId: PLACE.instanceId,
        enrollConsumedHash: NONCE_HASH }) as never,
    consent: consent === 'missing' ? null : async () => consent ? { authorizationDeadline: new Date(NOW + 100_000).toISOString() } : null,
});
async function ask(b: Record<string, unknown>, d = deps()) {
    const { raw, req } = request(b);
    const res = await handleNativeAuthorityQuery(req, d);
    const text = await res.text();
    return { status: res.status, json: JSON.parse(text), signed: res.headers.get('x-ezil-authority'),
        expectMac: mac(['ezil-native-authority-v1-reply', CID, '7', '3', sha(raw), sha(text)]) };
}

describe('native authority reader', () => {
    beforeEach(() => {
        mocks.lookup.mockReset().mockResolvedValue(op());
        mocks.recheck.mockReset().mockResolvedValue({ ok: true, placement: { ...PLACE }, leaseUntil: new Date(NOW + 20_000) } satisfies NativeAuthorityCheck);
    });

    it('allows with a reply MAC bound to the exact request and a fixed, non-sliding expiry', async () => {
        const a = await ask(body());
        expect([a.status, a.json.decision, a.json.runtimeId, a.json.expiresAt]).toEqual([200, 'allow', RT, new Date(NOW + 20_000).toISOString()]);
        expect(a.signed).toBe(a.expectMac);
        expect((await ask(body())).json.expiresAt).toBe(a.json.expiresAt);           // duplicate: same window
        expect(mocks.lookup).toHaveBeenCalledWith(expect.anything(), OWN, OP);
        const pre = await ask(Object.fromEntries(Object.entries(body({ phase: 'pre-runtime' })).filter(([k]) => k !== 'runtimeId')));
        expect([pre.status, 'runtimeId' in pre.json, pre.json.phase]).toEqual([200, false, 'pre-runtime']);
    });

    it('denies (signed) on state, consent, placement and policy; never builds an operation from input', async () => {
        for (const [setup, reason] of [
            [() => mocks.lookup.mockResolvedValue(op('exchange_unknown')), 'operation_not_admitted'],
            [() => mocks.lookup.mockResolvedValue(op('claimed')), 'operation_not_admitted'],
            [() => mocks.lookup.mockResolvedValue(null), 'operation_not_found'],
            [() => mocks.recheck.mockResolvedValue({ ok: false, reason: 'placement_changed' }), 'placement_changed'],
            [() => mocks.recheck.mockResolvedValue({ ok: true, placement: { ...PLACE, fenceToken: OP }, leaseUntil: new Date(NOW + 9_000) }), 'placement_changed'],
            [() => mocks.recheck.mockResolvedValue({ ok: true, placement: { ...PLACE }, leaseUntil: new Date(NOW - 1) }), 'expired'],
        ] as const) {
            mocks.lookup.mockResolvedValue(op());
            mocks.recheck.mockResolvedValue({ ok: true, placement: { ...PLACE }, leaseUntil: new Date(NOW + 20_000) });
            setup();
            const d = await ask(body());
            expect([d.status, d.json.decision, d.json.reason, d.signed]).toEqual([403, 'deny', reason, d.expectMac]);
        }
        expect((await ask(body(), deps('missing'))).json.reason).toBe('consent_unverified');
        expect((await ask(body(), deps(false))).json.reason).toBe('consent_unverified');
        expect((await ask(body({ policyDigest: `sha256:${'0'.repeat(64)}` }))).json.reason).toBe('policy_mismatch');
    });

    it('answers unsigned 401/400 for bad MACs and phase keysets, before any lookup', async () => {
        const { req } = request(body(), `v1=${'0'.repeat(64)}`);
        expect((await handleNativeAuthorityQuery(req, deps())).status).toBe(401);
        expect((await ask(body({ phase: 'pre-runtime' }))).status).toBe(400);       // runtimeId present in pre-runtime
        expect((await ask(body({ expiresAt: new Date(NOW + 31_000).toISOString() }))).status).toBe(400);
        expect(mocks.lookup).not.toHaveBeenCalled();
    });

    it('policy digest parity with the host profile (native_session.POLICY_DIGEST)', () => {
        expect(NATIVE_POLICY_DIGEST).toBe('sha256:669f2e04be8d8183727f1e750f4b9fe1bad3bd1b991babbbd549debc5a305e3e');
    });
});
