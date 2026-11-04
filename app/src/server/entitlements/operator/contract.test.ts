import { createPrivateKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, commandIdOf, InvalidCommand, parseCommand, payloadSha256, sourceCatalog } from './contract';
import { HEADERS, readSenderKeys, signingInput, verifySender } from './signature';

// Gateway contract 58d78935 fixtures (test/fixtures/product-entitlements at 93ed03f2), copied verbatim.
const ASSIGN = {
    format: 'ezil.admin-entitlement-command.v1', command_id: '6f9619ff-8b86-4011-b42d-00cf4fc964ff', action: 'assign', producer: 'ezil-os', scope: 'individual',
    operator: { via: 'auth0_operator', actor: '00000000-0000-4000-8000-000000000001', email: 'operator@example.test' },
    product: { ref: 'standard_monthly_v3', catalog_revision: 'v3.2026-11-04' },
    target: { kind: 'individual', os_user_id: '00000000-0000-4000-8000-0000000000a1', account_public_id: '10000000-0000-4000-8000-0000000000a1' },
    quantity: null, starts_at: '2026-11-04T12:00:00.000Z', validity: { ends_at: '2026-12-04T12:00:00.000Z' }, reason: 'Synthetic: staging access for review',
    assignment: null, billing_effect: 'none', credit_option: 'none',
};
const END = {
    format: 'ezil.admin-entitlement-command.v1', command_id: '8b1b3cff-8b86-4011-b42d-00cf4fc96401', action: 'end', producer: 'ezil-os', scope: 'individual',
    operator: { via: 'auth0_operator', actor: '00000000-0000-4000-8000-000000000001', email: 'operator@example.test' }, product: null,
    target: { kind: 'individual', os_user_id: '00000000-0000-4000-8000-0000000000a1', account_public_id: '10000000-0000-4000-8000-0000000000a1' },
    quantity: null, starts_at: null, validity: null, reason: 'Synthetic: end staging access', assignment: { ref: 'asg-os-1', expected_revision: 1 },
    billing_effect: 'none', credit_option: 'none',
};
// signing-vector.json: RFC 8032 section 7.1 test 1 key (TEST ONLY).
const VECTOR = {
    seedHex: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    publicHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', kid: 'test-ae-1', method: 'POST',
    path: '/gateway/admin-entitlements/v1/commands', timestamp: 1793800000,
    bodySha256: '73663c016a92983db6dec72dceca632cdfe5f48094a9220066811ac33d6c9ed4',
    payloadSha256: '5191e7827927d788d8ec0ceec8902dddba980a6b0671eb43c281334ec8e15d6d',
    signature: 'jt4P9IjBD-LYgWNHAYvp5C5QX5hQ6oRz4E5C_nTFTZwvOdAjOa5qQG9C0iy7idwgaypxc42BI-Uce-kwsT7QBA',
};
const publicB64url = Buffer.from(VECTOR.publicHex, 'hex').toString('base64url');
const keysEnv = JSON.stringify({ [VECTOR.kid]: { kty: 'OKP', crv: 'Ed25519', x: publicB64url } });
const headers = (h: Record<string, string>) => new Headers(h);

describe('ezil-os contract parity with the Gateway fixtures (58d78935)', () => {
    it('parses the Gateway assign and end commands exactly', () => {
        expect(parseCommand(ASSIGN)).toEqual(ASSIGN);
        expect(parseCommand(END)).toEqual(END);
        expect(commandIdOf(ASSIGN)).toBe(ASSIGN.command_id);
    });
    it('the canonical body and payload hash match the signing vector', async () => {
        const { createHash } = await import('node:crypto');
        expect(createHash('sha256').update(canonicalJson(ASSIGN)).digest('hex')).toBe(VECTOR.bodySha256);
        expect(payloadSha256(ASSIGN)).toBe(VECTOR.payloadSha256);
        // command_id is outside the payload: another id, same payload hash; another reason, another hash.
        expect(payloadSha256({ ...ASSIGN, command_id: '00000000-0000-4000-8000-00000000ffff' })).toBe(VECTOR.payloadSha256);
        expect(payloadSha256({ ...ASSIGN, reason: 'other' })).not.toBe(VECTOR.payloadSha256);
    });
    it.each([
        ['another producer', { producer: 'universe' }], ['organization scope', { scope: 'organization' }],
        ['a billing effect', { billing_effect: 'charge' }], ['a credit option', { credit_option: 'one_time' }],
        ['a quantity', { quantity: 1 }], ['an organization target', { target: { kind: 'organization', organization_ref: 'org-1' } }],
        ['an extra field', { extra: true }], ['assign without validity', { validity: null }], ['assign with an assignment', { assignment: { ref: 'asg-1', expected_revision: 1 } }],
        ['a bad date', { starts_at: '2026-13-45T00:00:00Z' }], ['a control character in the reason', { reason: 'a\u0007b' }],
        ['until_revoked false', { validity: { until_revoked: false } }],
    ])('refuses %s', (_name, patch) => {
        expect(() => parseCommand({ ...ASSIGN, ...patch })).toThrow(InvalidCommand);
    });
    it('a missing field is invalid; a missing or bad command_id has no id', () => {
        const noReason: Record<string, unknown> = { ...ASSIGN };
        delete noReason.reason;
        expect(() => parseCommand(noReason)).toThrow(InvalidCommand);
        expect(commandIdOf({ ...ASSIGN, command_id: 'nope' })).toBeNull();
        expect(commandIdOf([ASSIGN])).toBeNull();
    });
    it('the catalog: Free never assignable, Standard and Premium at their catalog prices, no included AI credits', () => {
        const catalog = sourceCatalog();
        expect(catalog).toMatchObject({ format: 'ezil.product-source-catalog.v1', producer: 'ezil-os', scope: 'individual' });
        expect(catalog.catalog_revision).toMatch(/^os-v3\.[0-9a-f]{16}$/);
        expect(catalog.products).toEqual([
            { ref: 'free_v3', name: 'Free', price: { amount_minor: 0, currency: 'usd', interval: 'month', per: 'account' }, included_ai_credits: null,
                assignable: false, refusal: "Free is every account's default plan." },
            { ref: 'standard_monthly_v3', name: 'Standard', price: { amount_minor: 2000, currency: 'usd', interval: 'month', per: 'account' },
                included_ai_credits: null, assignable: true, refusal: null },
            { ref: 'premium_monthly_v3', name: 'Premium', price: { amount_minor: 10000, currency: 'usd', interval: 'month', per: 'account' },
                included_ai_credits: null, assignable: true, refusal: null },
        ]);
        expect(sourceCatalog().catalog_revision).toBe(catalog.catalog_revision);
    });
});

describe('EZIL-AE-V1 sender verification', () => {
    const body = new TextEncoder().encode(canonicalJson(ASSIGN));
    const signed = { [HEADERS.kid]: VECTOR.kid, [HEADERS.timestamp]: String(VECTOR.timestamp), [HEADERS.signature]: VECTOR.signature };
    const keys = readSenderKeys(keysEnv)!;
    it('verifies the Gateway signing vector, and our own signer produces the same signature', () => {
        expect(verifySender(keys, { method: 'POST', pathWithQuery: VECTOR.path, headers: headers(signed), body }, VECTOR.timestamp)).toBe(VECTOR.kid);
        const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(VECTOR.seedHex, 'hex')]);
        const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
        expect(sign(null, signingInput('POST', VECTOR.path, VECTOR.timestamp, body), key).toString('base64url')).toBe(VECTOR.signature);
    });
    it.each([
        ['an unknown kid', { [HEADERS.kid]: 'other' }], ['a skew of 301 s', { [HEADERS.timestamp]: String(VECTOR.timestamp - 301) }],
        ['a tampered signature', { [HEADERS.signature]: `A${VECTOR.signature.slice(1)}` }], ['no signature', { [HEADERS.signature]: '' }],
        ['a non-numeric timestamp', { [HEADERS.timestamp]: '1793800000.5' }],
    ])('refuses %s', (_name, patch) => {
        expect(verifySender(keys, { method: 'POST', pathWithQuery: VECTOR.path, headers: headers({ ...signed, ...patch }), body }, VECTOR.timestamp)).toBeNull();
    });
    it('binds the method, the path with query and the body', () => {
        const check = (method: string, path: string, b: Uint8Array) => verifySender(keys, { method, pathWithQuery: path, headers: headers(signed), body: b }, VECTOR.timestamp);
        expect(check('GET', VECTOR.path, body)).toBeNull();
        expect(check('POST', `${VECTOR.path}?x=1`, body)).toBeNull();
        expect(check('POST', VECTOR.path, new TextEncoder().encode(canonicalJson({ ...ASSIGN, reason: 'changed' })))).toBeNull();
        expect(verifySender(keys, { method: 'POST', pathWithQuery: VECTOR.path, headers: headers(signed), body }, VECTOR.timestamp + 300)).toBe(VECTOR.kid);
        // A correctly signed request outside the 300 s window (replayed later, or from a skewed clock) is refused.
        expect(verifySender(keys, { method: 'POST', pathWithQuery: VECTOR.path, headers: headers(signed), body }, VECTOR.timestamp + 301)).toBeNull();
        expect(verifySender(keys, { method: 'POST', pathWithQuery: VECTOR.path, headers: headers(signed), body }, VECTOR.timestamp - 301)).toBeNull();
    });
    it('reads only public keys; anything else is "not configured" (fail closed)', () => {
        expect(readSenderKeys(JSON.stringify({ k: publicB64url }))?.size).toBe(1);
        expect(readSenderKeys(JSON.stringify({ k: Buffer.from(VECTOR.publicHex, 'hex').toString('base64') }))?.size).toBe(1);
        for (const raw of [undefined, '', ' ', 'not json', '[]', '{}', JSON.stringify({ k: 'AAAA' }),
            JSON.stringify({ k: { kty: 'OKP', crv: 'Ed25519', x: publicB64url, d: Buffer.from(VECTOR.seedHex, 'hex').toString('base64url') } }),
            JSON.stringify({ k: { kty: 'EC', crv: 'P-256', x: publicB64url } }), JSON.stringify({ 'bad kid!': publicB64url }),
            JSON.stringify({ good: publicB64url, bad: 'xx' })]) {
            expect(readSenderKeys(raw)).toBeNull();
        }
    });
});
