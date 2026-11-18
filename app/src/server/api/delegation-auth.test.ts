import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
    authenticateDelegation, delegatedReadsEnabled, delegationBinding, inputDigest, isDelegationHeader, parseDelegationConfig,
    type DelegationConfig, type DelegationDeps,
} from './delegation-auth';
import {
    CLIENT_ID, MCP_ORIGIN, OS_ORIGIN, SUPABASE_ISSUER, delegationEnv, mcpInput, readClaims, readUrl, signAssertion, signingKey,
    type Claims, type SigningKey,
} from './delegation.test-support';

const AUTH0 = 'https://id.ezil.work/';
const USER = randomUUID();
const COMPUTER = randomUUID();
let key: SigningKey;
let other: SigningKey;
let config: DelegationConfig;

beforeAll(async () => {
    key = await signingKey();
    other = await signingKey();
    config = (await parseDelegationConfig(delegationEnv([key]), AUTH0))!;
    expect(config).toBeDefined();
});

const headers = (assertion: string, scheme = 'EZiL-Delegation') => new Headers({ authorization: `${scheme} ${assertion}` });
const getInput = mcpInput({ id: COMPUTER });

function deps(overrides: Partial<DelegationDeps> = {}) {
    const consumeJti = vi.fn(async () => true);
    const findAccount = vi.fn(async () => ({ id: USER, createdAt: '2026-11-01T00:00:00.000Z' }));
    const d: DelegationDeps = {
        enabled: true, config, binding: delegationBinding({ method: 'GET', url: readUrl('computer.get', getInput), hasBody: false }),
        now: () => Math.floor(Date.now() / 1000), consumeJti, findAccount, ...overrides,
    };
    return { d, consumeJti, findAccount };
}

async function check(claims: Claims, overrides: Partial<DelegationDeps> = {}, header: Claims = {}, signer = key) {
    const assertion = await signAssertion(signer, claims, header);
    const t = deps(overrides);
    return { outcome: await authenticateDelegation(headers(assertion), t.d), ...t };
}

describe('gate and header recognition', () => {
    it('is enabled only by the exact value "enabled"', () => {
        expect(delegatedReadsEnabled('enabled')).toBe(true);
        for (const value of [undefined, '', '1', 'true', 'Enabled', ' enabled']) expect(delegatedReadsEnabled(value)).toBe(false);
    });

    it('recognises any EZiL-Delegation header, well-formed or not, and nothing else', async () => {
        for (const header of ['EZiL-Delegation x', 'ezil-delegation x', 'EZiL-Delegation', ' EZiL-Delegation\tx']) expect(isDelegationHeader(header)).toBe(true);
        for (const header of [null, 'Bearer x', 'EZiL-DelegationX y', 'Basic eA==']) expect(isDelegationHeader(header)).toBe(false);
        const { d } = deps();
        expect(await authenticateDelegation(new Headers(), d)).toEqual({ kind: 'none' });
        expect(await authenticateDelegation(new Headers({ authorization: 'Bearer abc' }), d)).toEqual({ kind: 'none' });
    });

    it('rejects while off or misconfigured, before any parsing or I/O', async () => {
        const claims = readClaims(USER, 'computer.get', getInput);
        for (const [overrides, reason] of [[{ enabled: false }, 'disabled'], [{ config: undefined }, 'not_configured']] as const) {
            const { outcome, consumeJti, findAccount } = await check(claims, overrides);
            expect(outcome).toEqual({ kind: 'rejected', reason });
            expect(consumeJti).not.toHaveBeenCalled();
            expect(findAccount).not.toHaveBeenCalled();
        }
    });
});

describe('pinned configuration', () => {
    it('accepts only exact bare https origins, a derived Supabase issuer, a non-empty client list and public P-256 keys', async () => {
        const good = delegationEnv([key]);
        const bad: [string, Record<string, string | undefined>][] = [
            ['no issuer', { EZIL_DELEGATION_ISSUER: undefined }], ['http issuer', { EZIL_DELEGATION_ISSUER: 'http://mcp.delegation.test' }],
            ['trailing slash', { EZIL_DELEGATION_ISSUER: `${MCP_ORIGIN}/` }], ['path audience', { EZIL_DELEGATION_AUDIENCE: `${OS_ORIGIN}/os` }],
            ['issuer list', { EZIL_DELEGATION_ISSUER: `${MCP_ORIGIN},https://other.test` }], ['issuer is audience', { EZIL_DELEGATION_AUDIENCE: MCP_ORIGIN }],
            ['no clients', { EZIL_DELEGATION_CLIENT_IDS: ' , ' }], ['wildcard client', { EZIL_DELEGATION_CLIENT_IDS: '*' }],
            ['no supabase url', { NEXT_PUBLIC_SUPABASE_URL: undefined }], ['not JSON', { EZIL_DELEGATION_PUBLIC_JWKS: 'keys' }],
            ['no keys', { EZIL_DELEGATION_PUBLIC_JWKS: '{"keys":[]}' }],
            ['extra set member', { EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [key.publicJwk], jku: 'https://x.test' }) }],
            ['private member', { EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...key.publicJwk, d: 'AAAA' }] }) }],
            ['wrong curve', { EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...key.publicJwk, crv: 'P-384' }] }) }],
            ['wrong alg', { EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...key.publicJwk, alg: 'RS256' }] }) }],
            ['duplicate kid', { EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [key.publicJwk, key.publicJwk] }) }],
            ['four keys', { EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [1, 2, 3, 4].map(i => ({ ...key.publicJwk, kid: `k${i}` })) }) }],
        ];
        expect(await parseDelegationConfig(good, AUTH0)).toBeDefined();
        for (const [name, overrides] of bad) expect(await parseDelegationConfig({ ...good, ...overrides }, AUTH0), name).toBeUndefined();
        expect(await parseDelegationConfig(good, '')).toBeUndefined();
    });
});

describe('request binding', () => {
    const bind = (method: string, url: string, hasBody = false) => delegationBinding({ method, url, hasBody });

    it('binds only one literal GET read with at most a single input parameter', () => {
        expect(bind('GET', readUrl('computer.list'))).toEqual({ procedure: 'computer.list', input: '' });
        expect(bind('GET', readUrl('computer.get', getInput))).toEqual({ procedure: 'computer.get', input: getInput });
        const refused = [
            ['POST', readUrl('computer.list')], ['PUT', readUrl('computer.list')], ['GET', `${OS_ORIGIN}/api/trpc/computer.list,computer.get`],
            ['GET', `${OS_ORIGIN}/api/trpc/computer.list/`], ['GET', `${OS_ORIGIN}/api/trpc/computer%2Elist`], ['GET', `${OS_ORIGIN}/api/trpc/computer.List`],
            ['GET', `${OS_ORIGIN}/api/trpc//computer.list`], ['GET', `${OS_ORIGIN}/api/trpc/computer.systemInfo`], ['GET', `${OS_ORIGIN}/api/trpc/computer.start`],
            ['GET', `${OS_ORIGIN}/api/trpc/computer.list?batch=1`], ['GET', `${readUrl('computer.get', getInput)}&input=x`],
            ['GET', `${readUrl('computer.get', getInput)}&extra=1`], ['GET', `${OS_ORIGIN}/api/trpc/computer.list?x`], ['GET', 'not a url'],
        ] as const;
        for (const [method, url] of refused) expect(bind(method, url), `${method} ${url}`).toBeUndefined();
        expect(bind('GET', readUrl('computer.list'), true)).toBeUndefined();
    });

    it('digests the exact decoded input string, never a re-serialisation', () => {
        const spaced = '{"json": {"id":"x"}}';
        expect(bind('GET', readUrl('computer.get', spaced))!.input).toBe(spaced);
        expect(inputDigest(spaced)).not.toBe(inputDigest(JSON.stringify(JSON.parse(spaced))));
        expect(inputDigest('')).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
    });
});

describe('assertion verification', () => {
    it('accepts a published-shape assertion and returns only the mapped call', async () => {
        const claims = readClaims(USER, 'computer.get', getInput);
        const { outcome, consumeJti, findAccount } = await check(claims);
        expect(outcome).toEqual({ kind: 'accepted', call: { jti: claims.jti, clientId: CLIENT_ID, userId: USER, procedure: 'computer.get' },
            account: { id: USER, createdAt: '2026-11-01T00:00:00.000Z' } });
        expect(consumeJti).toHaveBeenCalledWith(claims.jti, (claims.exp as number) + 10);
        expect(findAccount).toHaveBeenCalledWith({ issuer: 'supabase', subject: USER });
        const list = readClaims(USER, 'computer.list', '');
        expect((await check(list, { binding: delegationBinding({ method: 'GET', url: readUrl('computer.list'), hasBody: false }) })).outcome.kind).toBe('accepted');
    });

    it('maps an EZiL ID subject only through the linked admin metadata lookup', async () => {
        const auth0Subject = 'auth0|6720aa0e9f1c2b0012345678';
        const { outcome, findAccount } = await check(readClaims(auth0Subject, 'computer.get', getInput, { idp_iss: AUTH0 }));
        expect(outcome.kind).toBe('accepted');
        expect(findAccount).toHaveBeenCalledWith({ issuer: 'auth0', subject: auth0Subject });
        for (const sub of ['no-pipe', 'auth0|', `auth0|${'x'.repeat(260)}`, 'auth0|a b']) {
            expect((await check(readClaims(sub, 'computer.get', getInput, { idp_iss: AUTH0 }))).outcome, sub).toEqual({ kind: 'rejected', reason: 'claims' });
        }
    });

    it('refuses every wrong signature, key, header, claim, policy, binding or time with no ledger or account I/O', async () => {
        const now = Math.floor(Date.now() / 1000);
        const base = () => readClaims(USER, 'computer.get', getInput, { iat: now, exp: now + 60 });
        const cases: [string, Claims, Claims, SigningKey | null, string][] = [
            ['other key', base(), {}, other, 'signature'], ['unknown kid', base(), { kid: 'nope' }, null, 'unknown_key'],
            ['alg', base(), { alg: 'ES384' }, null, 'header'], ['typ', base(), { typ: 'JWT' }, null, 'header'], ['extra jose', base(), { jku: 'x' }, null, 'header'],
            ['extra claim', { ...base(), nonce: 'x' }, {}, null, 'claims'],
            ['missing claim', Object.fromEntries(Object.entries(base()).filter(([k]) => k !== 'inp')), {}, null, 'claims'],
            ['string iat', { ...base(), iat: String(now) }, {}, null, 'claims'], ['float exp', { ...base(), exp: now + 30.5 }, {}, null, 'claims'],
            ['jti', { ...base(), jti: 'not-a-uuid' }, {}, null, 'claims'], ['supabase sub', { ...base(), sub: 'auth0|x' }, {}, null, 'claims'],
            ['issuer', { ...base(), iss: 'https://evil.test' }, {}, null, 'issuer'], ['audience', { ...base(), aud: 'https://other-os.test' }, {}, null, 'audience'],
            ['idp_iss', { ...base(), idp_iss: 'https://other.supabase.test/auth/v1' }, {}, null, 'identity_issuer'],
            ['client', { ...base(), client_id: 'other-client' }, {}, null, 'client'],
            ['broader scope', { ...base(), scope: 'ezil:computers:read ezil:sessions:read' }, {}, null, 'scope'],
            ['other scope', { ...base(), scope: 'ezil:computers:start' }, {}, null, 'scope'],
            ['mutation proc', { ...base(), proc: 'computer.start' }, {}, null, 'scope'], ['other read', { ...base(), proc: 'computer.systemInfo' }, {}, null, 'scope'],
            ['proc vs path', { ...base(), proc: 'computer.list' }, {}, null, 'binding'],
            ['tampered input digest', { ...base(), inp: inputDigest(mcpInput({ id: randomUUID() })) }, {}, null, 'binding'],
            ['ttl', { ...base(), exp: now + 61 }, {}, null, 'lifetime'], ['exp before iat', { ...base(), exp: now - 1, iat: now }, {}, null, 'lifetime'],
            ['future iat', { ...base(), iat: now + 11, exp: now + 60 }, {}, null, 'not_yet_valid'],
            ['expired', { ...base(), iat: now - 61, exp: now - 1 }, {}, null, 'expired'],
        ];
        for (const [name, claims, header, signer, reason] of cases) {
            const { outcome, consumeJti, findAccount } = await check(claims, { now: () => now }, header, signer ?? key);
            expect(outcome, name).toEqual({ kind: 'rejected', reason });
            expect(consumeJti, name).not.toHaveBeenCalled();
            expect(findAccount, name).not.toHaveBeenCalled();
        }
    });

    it('refuses malformed, oversized and non-canonical encodings and DER-length signatures', async () => {
        const good = await signAssertion(key, readClaims(USER, 'computer.get', getInput));
        const [h, p, s] = good.split('.') as [string, string, string];
        const der = Buffer.concat([Buffer.from([0x30, 0x44]), Buffer.from(s, 'base64url'), Buffer.alloc(4)]).toString('base64url');
        const variants: [string, string][] = [
            ['two parts', `${h}.${p}`], ['padding', `${h}.${p}.${s}=`], ['bad chars', `${h}.${p}.${s}*`], ['oversized', `${h}.${p}.${'A'.repeat(4096)}`],
            ['der length', `${h}.${p}.${der}`], ['empty', ''],
        ];
        for (const [name, assertion] of variants) {
            const { d, consumeJti } = deps();
            const outcome = await authenticateDelegation(headers(assertion), d);
            expect(outcome.kind, name).toBe('rejected');
            expect(consumeJti).not.toHaveBeenCalled();
        }
    });

    it('rejects an unbound request line before verifying anything', async () => {
        const { outcome, consumeJti } = await check(readClaims(USER, 'computer.get', getInput), { binding: undefined });
        expect(outcome).toEqual({ kind: 'rejected', reason: 'binding' });
        expect(consumeJti).not.toHaveBeenCalled();
    });

    it('burns the jti before the account lookup: replay, store failure and unknown accounts all reject', async () => {
        const claims = readClaims(USER, 'computer.get', getInput);
        expect((await check(claims, { consumeJti: vi.fn(async () => false) })).outcome).toEqual({ kind: 'rejected', reason: 'replayed' });
        expect((await check(claims, { consumeJti: vi.fn(async () => { throw new Error('relation does not exist'); }) })).outcome)
            .toEqual({ kind: 'rejected', reason: 'replay_store_unavailable' });
        for (const findAccount of [vi.fn(async () => null), vi.fn(async () => { throw new Error('db down'); }),
            vi.fn(async () => ({ id: randomUUID(), createdAt: 'x' }))]) {
            const consumeJti = vi.fn(async () => true);
            expect((await check(claims, { consumeJti, findAccount })).outcome).toEqual({ kind: 'rejected', reason: 'unknown_account' });
            expect(consumeJti).toHaveBeenCalledTimes(1);
        }
    });
});

describe('fixtures are synthetic', () => {
    it('uses only .test origins for the MCP, OS and Supabase pins', () => {
        for (const origin of [MCP_ORIGIN, OS_ORIGIN, SUPABASE_ISSUER]) expect(new URL(origin).hostname.endsWith('.test')).toBe(true);
    });
});
