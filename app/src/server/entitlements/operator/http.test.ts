import { createPrivateKey, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sourceCatalog } from './contract';
import { handleAdminEntitlementRequest } from './http';
import type { OperatorEntitlementDeps } from './service';
import { HEADERS, SENDER_KEYS_ENV, signingInput } from './signature';
import { SourceUnavailable } from './store';

// RFC 8032 section 7.1 test 1 key (TEST ONLY), as the Gateway's signing-vector.json.
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUBLIC = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url');
const KEY = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(SEED, 'hex')]), format: 'der', type: 'pkcs8' });
const env = { [SENDER_KEYS_ENV]: JSON.stringify({ 'test-ae-1': { kty: 'OKP', crv: 'Ed25519', x: PUBLIC } }) };
const NOW = 1_793_800_000;
const BASE = 'https://os-staging.example.test/api/gateway/admin-entitlements/v1';
const USER = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT = '10000000-0000-4000-8000-0000000000a1';

function signed(method: string, endpoint: string, body = '', over: Record<string, string> = {}): Request {
    const url = new URL(`${BASE}/${endpoint}`);
    const bytes = new TextEncoder().encode(body);
    const signature = sign(null, signingInput(method, url.pathname + url.search, NOW, bytes), KEY).toString('base64url');
    return new Request(url, { method, body: method === 'GET' ? undefined : body,
        headers: { [HEADERS.kid]: 'test-ae-1', [HEADERS.timestamp]: String(NOW), [HEADERS.signature]: signature, ...over } });
}

function deps(over: Partial<OperatorEntitlementDeps> = {}): () => Promise<OperatorEntitlementDeps> {
    const value: OperatorEntitlementDeps = {
        now: () => new Date(NOW * 1000), newId: () => '00000000-0000-4000-8000-000000000001',
        identity: async () => 'ok', stripe: async () => ({ paidAccess: false, computeActive: false, productRef: null, state: null, checkoutOpen: false }),
        readAssignments: async () => [], withCommand: async (_c, _u, run) => run({
            findEvent: async () => null, withAccessTransaction: run => run(), assignments: async () => [], insertAssignment: async () => {}, updateAssignment: async () => true,
            closeLapsed: async () => {}, insertEvent: async () => {} }),
        ...over,
    };
    return async () => value;
}
const call = (request: Request, endpoint: 'catalog' | 'assignments' | 'commands', options: { env?: Record<string, string | undefined>; deps?: () => Promise<OperatorEntitlementDeps> } = {}) =>
    handleAdminEntitlementRequest(request, endpoint, { env: options.env ?? env, deps: options.deps ?? deps(), nowSeconds: () => NOW });

describe('ezil-os entitlement routes', () => {
    it('no sender key configured → 503 before anything else; nothing is read', async () => {
        const read = vi.fn();
        for (const raw of [undefined, '', '{}', 'nope']) {
            const response = await call(signed('GET', 'catalog'), 'catalog', { env: { [SENDER_KEYS_ENV]: raw }, deps: read });
            expect([response.status, await response.json()]).toEqual([503, { error: 'source_unconfigured' }]);
        }
        expect(read).not.toHaveBeenCalled();
    });

    it('every endpoint, GET included, needs a valid signature: 401 unauthorized_sender otherwise', async () => {
        const read = vi.fn();
        for (const [request, endpoint] of [
            [new Request(`${BASE}/catalog`), 'catalog'],
            [signed('GET', 'catalog', '', { [HEADERS.kid]: 'other' }), 'catalog'],
            [signed('GET', `assignments?os_user_id=${USER}&account_public_id=${ACCOUNT}`, '', { [HEADERS.timestamp]: String(NOW - 301) }), 'assignments'],
            [signed('POST', 'commands', '{"command_id":"x"}', { [HEADERS.signature]: 'A'.repeat(86) }), 'commands'],
        ] as const) {
            const response = await call(request, endpoint, { deps: read });
            expect([response.status, await response.json()]).toEqual([401, { error: 'unauthorized_sender' }]);
        }
        expect(read).not.toHaveBeenCalled();
    });

    it('GET catalog → 200 with the OS catalog, no store read', async () => {
        const response = await call(signed('GET', 'catalog'), 'catalog');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual(sourceCatalog());
    });

    it('GET assignments: both ids required (400), a non-linked pair is 404 and reveals nothing, a linked one is 200', async () => {
        expect((await call(signed('GET', `assignments?os_user_id=${USER}`), 'assignments')).status).toBe(400);
        expect((await call(signed('GET', `assignments?os_user_id=${USER}&account_public_id=${ACCOUNT}&x=1`), 'assignments')).status).toBe(400);
        const notLinked = await call(signed('GET', `assignments?os_user_id=${USER}&account_public_id=${ACCOUNT}`), 'assignments',
            { deps: deps({ identity: async () => 'identity_not_found' }) });
        expect([notLinked.status, await notLinked.json()]).toEqual([404, { error: 'identity_not_found' }]);
        const linked = await call(signed('GET', `assignments?os_user_id=${USER}&account_public_id=${ACCOUNT}`), 'assignments');
        expect(linked.status).toBe(200);
        expect(await linked.json()).toMatchObject({ format: 'ezil.product-source-assignments.v1', effective_access: { state: 'none' }, assignments: [], stripe: null });
    });

    it('POST commands: not JSON or no valid command_id → 400; a refused command is 200', async () => {
        expect((await call(signed('POST', 'commands', 'not json'), 'commands')).status).toBe(400);
        expect((await call(signed('POST', 'commands', '{"command_id":"nope"}'), 'commands')).status).toBe(400);
        const refused = await call(signed('POST', 'commands', canonicalJson({ command_id: '6f9619ff-8b86-4011-b42d-00cf4fc964ff', action: 'assign' })), 'commands');
        expect(refused.status).toBe(200);
        expect(await refused.json()).toMatchObject({ outcome: 'refused', refusal: { code: 'invalid_command' }, command_id: '6f9619ff-8b86-4011-b42d-00cf4fc964ff' });
    });

    it('a wrong method is 405 after the signature; an unavailable source is 503, never a refusal', async () => {
        expect((await call(signed('POST', 'catalog', ''), 'catalog')).status).toBe(405);
        const down = await call(signed('GET', `assignments?os_user_id=${USER}&account_public_id=${ACCOUNT}`), 'assignments',
            { deps: deps({ identity: async () => { throw new SourceUnavailable('identity'); } }) });
        expect([down.status, await down.json()]).toEqual([503, { error: 'source_unavailable' }]);
    });
});
