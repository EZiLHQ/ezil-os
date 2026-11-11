/**
 * `delegation-auth.ts`: every way an `EZiL-Delegation` assertion can be wrong
 * is a REJECTION (never `none`, so never a cookie fallback), and only an
 * exact, fresh, first-use assertion for an existing account is accepted.
 * The signer here mirrors the EZiL MCP's `src/os/delegation.ts` byte for byte.
 */
import { randomUUID, webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
    authenticateDelegation,
    bytesDigest,
    delegationBinding,
    delegatedProcedureType,
    DELEGATED_PROCEDURES,
    DELEGATION_MAX_BODY_BYTES,
    inputDigest,
    parseDelegationConfig,
    type DelegationBinding,
    type DelegationConfig,
    type DelegationDeps,
    type DelegationEnv,
} from './delegation-auth';

const MCP = 'https://mcp-staging.ezil.work';
const OS = 'https://os-staging.ezil.work';
const SUPABASE = 'https://btgqfmnzycdecmeyqubx.supabase.co';
const IDP = `${SUPABASE}/auth/v1`;
const AUTH0 = 'https://id.ezil.work/';
const ALICE_AUTH0 = 'google-oauth2|104593827465';
const CLIENT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const ALICE = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000;

/** A JWK as it appears in a JWKS document (kid/alg/use plus anything a misconfiguration adds). */
type Jwk = webcrypto.JsonWebKey & Record<string, unknown>;
interface Signer { kid: string; privateKey: webcrypto.CryptoKey; publicJwk: Jwk }

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

async function newSigner(kid: string): Promise<Signer> {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    return { kid, privateKey: pair.privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}

const GET_INPUT = JSON.stringify({ json: { id: '44444444-4444-4444-8444-444444444444' } });
const claimsFor = (overrides: Record<string, unknown> = {}) => ({
    iss: MCP, aud: OS, sub: ALICE, idp_iss: IDP, client_id: CLIENT, scope: 'ezil:computers:read',
    proc: 'computer.list', inp: inputDigest(''), jti: randomUUID(), iat: NOW, exp: NOW + 60, ...overrides,
});

async function sign(signer: Signer, claims: Record<string, unknown> = claimsFor(),
    header: Record<string, unknown> = { alg: 'ES256', typ: 'ezil-delegation+jwt', kid: signer.kid }): Promise<string> {
    const input = `${b64(header)}.${b64(claims)}`;
    const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

const headersWith = (authorization?: string) => new Headers(authorization === undefined ? {} : { authorization });
const present = (assertion: string) => headersWith(`EZiL-Delegation ${assertion}`);

let signer: Signer;
let other: Signer;
let config: DelegationConfig;

const envFor = (overrides: Partial<DelegationEnv> = {}, keys: Jwk[] = [{ ...signer.publicJwk, kid: signer.kid }]): DelegationEnv => ({
    EZIL_DELEGATION_ISSUER: MCP,
    EZIL_DELEGATION_AUDIENCE: OS,
    EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys }),
    EZIL_DELEGATION_CLIENT_IDS: CLIENT,
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
    ...overrides,
});

/** An in-memory one-time ledger with the same contract as the Postgres one. */
function memoryLedger() {
    const used = new Set<string>();
    return { used, consumeJti: async (jti: string) => (used.has(jti) ? false : (used.add(jti), true)) };
}

function deps(overrides: Partial<DelegationDeps> = {}): DelegationDeps {
    const ledger = memoryLedger();
    return {
        config,
        binding: { method: 'GET', procedure: 'computer.list', input: '' },
        now: () => NOW,
        consumeJti: ledger.consumeJti,
        findAccount: async ({ issuer, subject }) =>
            (issuer === 'supabase' && subject === ALICE) || (issuer === 'auth0' && subject === ALICE_AUTH0)
                ? { id: ALICE, createdAt: '2026-01-01T00:00:00.000Z' } : null,
        ...overrides,
    };
}

beforeAll(async () => {
    signer = await newSigner('mcp-2026-11');
    other = await newSigner('mcp-2026-11');
    config = (await parseDelegationConfig(envFor(), AUTH0))!;
    expect(config).toBeDefined();
});

describe('authenticateDelegation — acceptance', () => {
    it('accepts an exact, fresh assertion and maps it to the existing account', async () => {
        const claims = claimsFor();
        const outcome = await authenticateDelegation(present(await sign(signer, claims)), deps());
        expect(outcome).toMatchObject({ kind: 'accepted', account: { id: ALICE }, call: { jti: claims.jti, clientId: CLIENT, sub: ALICE } });
        if (outcome.kind !== 'accepted') throw new Error('unreachable');
        expect(outcome.call.procedure).toBe('computer.list');
    });

    it('no Authorization header, or a Bearer one, is `none` (not this module\'s credential)', async () => {
        expect(await authenticateDelegation(headersWith(), deps())).toEqual({ kind: 'none' });
        expect(await authenticateDelegation(headersWith('Bearer abc'), deps())).toEqual({ kind: 'none' });
    });

    it('a key added for rotation verifies alongside the current one', async () => {
        const next = await newSigner('mcp-2027-01');
        const rotated = (await parseDelegationConfig(envFor({}, [
            { ...signer.publicJwk, kid: signer.kid }, { ...next.publicJwk, kid: next.kid, alg: 'ES256', use: 'sig' },
        ]), AUTH0))!;
        const outcome = await authenticateDelegation(present(await sign(next)), deps({ config: rotated }));
        expect(outcome.kind).toBe('accepted');
        // ...and once the old key is unpinned, its assertions stop verifying.
        const retired = (await parseDelegationConfig(envFor({}, [{ ...next.publicJwk, kid: next.kid }]), AUTH0))!;
        expect(await authenticateDelegation(present(await sign(signer)), deps({ config: retired })))
            .toMatchObject({ kind: 'rejected', reason: 'unknown_key' });
    });

    it('an EZiL ID (Auth0) subject maps through its linked account, and only through it', async () => {
        const seen: unknown[] = [];
        const d = deps();
        const findAccount = d.findAccount;
        d.findAccount = async (identity) => { seen.push(identity); return findAccount(identity); };
        const outcome = await authenticateDelegation(present(await sign(signer, claimsFor({ idp_iss: AUTH0, sub: ALICE_AUTH0 }))), d);
        expect(outcome).toMatchObject({ kind: 'accepted', account: { id: ALICE }, call: { sub: ALICE_AUTH0, userId: ALICE } });
        expect(seen).toEqual([{ issuer: 'auth0', subject: ALICE_AUTH0 }]);
    });

    it('an iat up to the clock-skew allowance in the future is still accepted', async () => {
        const outcome = await authenticateDelegation(present(await sign(signer, claimsFor({ iat: NOW + 10, exp: NOW + 70 }))), deps());
        expect(outcome.kind).toBe('accepted');
    });
});

describe('authenticateDelegation — every malformed or altered assertion is rejected, never `none`', () => {
    const rejects = async (headers: Headers, reason: string, d = deps()) =>
        expect(await authenticateDelegation(headers, d)).toMatchObject({ kind: 'rejected', reason });

    it('missing config rejects (fail closed), it does not pass through', async () => {
        await rejects(present(await sign(signer)), 'not_configured', deps({ config: undefined }));
    });

    it('malformed: no token, two segments, junk characters, non-canonical base64url, oversized', async () => {
        await rejects(headersWith('EZiL-Delegation'), 'malformed');
        await rejects(headersWith('EZiL-Delegation a.b'), 'malformed');
        await rejects(headersWith('EZiL-Delegation a.b.c d'), 'malformed');
        const good = await sign(signer);
        await rejects(present(`${good}=`), 'malformed');
        await rejects(present(`${good}\tx`), 'malformed');
        await rejects(present('a'.repeat(5000)), 'malformed');
    });

    it('a payload changed after signing fails the signature (sub swapped to another user)', async () => {
        const [h, , s] = (await sign(signer)).split('.');
        const forged = `${h}.${b64(claimsFor({ sub: '22222222-2222-4222-8222-222222222222' }))}.${s}`;
        await rejects(present(forged), 'signature');
    });

    it('a key that merely reuses the pinned kid fails the signature', async () => {
        await rejects(present(await sign(other)), 'signature');
    });

    it('header: alg none / HS256, wrong typ, an extra member (jku), unknown kid', async () => {
        const claims = claimsFor();
        const unsigned = `${b64({ alg: 'none', typ: 'ezil-delegation+jwt', kid: signer.kid })}.${b64(claims)}.${b64('x'.repeat(64))}`;
        await rejects(present(unsigned), 'header');
        await rejects(present(await sign(signer, claims, { alg: 'HS256', typ: 'ezil-delegation+jwt', kid: signer.kid })), 'header');
        await rejects(present(await sign(signer, claims, { alg: 'ES256', typ: 'JWT', kid: signer.kid })), 'header');
        await rejects(present(await sign(signer, claims, { alg: 'ES256', typ: 'ezil-delegation+jwt', kid: signer.kid, jku: 'https://evil.example/jwks' })), 'header');
        await rejects(present(await sign(signer, claims, { alg: 'ES256', typ: 'ezil-delegation+jwt', kid: 'someone-else' })), 'unknown_key');
    });

    it('signature: DER-length or truncated forms are refused before verify', async () => {
        const [h, p, s] = (await sign(signer)).split('.');
        const raw = Buffer.from(s!, 'base64url');
        await rejects(present(`${h}.${p}.${raw.subarray(0, 63).toString('base64url')}`), 'signature');
        await rejects(present(`${h}.${p}.${Buffer.concat([raw, Buffer.from([0])]).toString('base64url')}`), 'signature');
    });

    it('bound to one call: proc and inp must name the request\'s own procedure and exact input', async () => {
        const get = { method: 'GET' as const, procedure: 'computer.get', input: GET_INPUT };
        const ok = await authenticateDelegation(present(await sign(signer, claimsFor({ proc: 'computer.get', inp: inputDigest(GET_INPUT) }))), deps({ binding: get }));
        expect(ok.kind).toBe('accepted');
        // Same assertion shape, but the request asks for another computer / another procedure / no input.
        await rejects(present(await sign(signer, claimsFor({ proc: 'computer.get', inp: inputDigest(GET_INPUT) }))), 'binding',
            deps({ binding: { method: 'GET', procedure: 'computer.get', input: GET_INPUT.replace('4444', '5555') } }));
        await rejects(present(await sign(signer, claimsFor({ proc: 'computer.get', inp: inputDigest(GET_INPUT) }))), 'binding',
            deps({ binding: { method: 'GET', procedure: 'computer.systemInfo', input: GET_INPUT } }));
        await rejects(present(await sign(signer, claimsFor())), 'binding', deps({ binding: undefined }));
        // A procedure outside the scope's allowlist is refused even when the request matches it.
        await rejects(present(await sign(signer, claimsFor({ proc: 'computer.rename' }))), 'scope',
            deps({ binding: { method: 'GET', procedure: 'computer.rename', input: '' } }));
    });

    it('wrong iss / aud / idp_iss / client_id each reject with their own reason', async () => {
        await rejects(present(await sign(signer, claimsFor({ iss: 'https://mcp.ezil.work' }))), 'issuer');
        await rejects(present(await sign(signer, claimsFor({ aud: 'https://os.ezil.work' }))), 'audience');
        await rejects(present(await sign(signer, claimsFor({ aud: `${OS}/` }))), 'audience');
        await rejects(present(await sign(signer, claimsFor({ idp_iss: 'https://other-project.supabase.co/auth/v1' }))), 'identity_issuer');
        await rejects(present(await sign(signer, claimsFor({ client_id: 'https://evil.example/client' }))), 'client');
    });

    it('a subject must have its issuer\'s shape: a uuid for Supabase, provider|id for EZiL ID', async () => {
        await rejects(present(await sign(signer, claimsFor({ idp_iss: IDP, sub: ALICE_AUTH0 }))), 'claims');
        await rejects(present(await sign(signer, claimsFor({ idp_iss: AUTH0, sub: ALICE }))), 'claims');
        await rejects(present(await sign(signer, claimsFor({ idp_iss: AUTH0, sub: "x|' OR 1=1 --" }))), 'claims');
        await rejects(present(await sign(signer, claimsFor({ idp_iss: 'https://id.ezil.work' }))), 'identity_issuer');
    });

    it('EZiL ID subjects: connection|id where the id may contain more pipes; bounded, no spaces or control characters', async () => {
        const accepted = ['google-oauth2|104593827465', 'auth0|abc123', 'samlp|Customer1|123xyz', 'oauth2|provider|id', 'waad|tenant|a.b@c', `auth0|${'x'.repeat(249)}`];
        for (const sub of accepted) {
            const seen: string[] = [];
            const outcome = await authenticateDelegation(present(await sign(signer, claimsFor({ idp_iss: AUTH0, sub }))), deps({
                findAccount: async (identity) => { seen.push(identity.subject); return { id: ALICE, createdAt: '' }; },
            }));
            expect([sub, outcome.kind]).toEqual([sub, 'accepted']);
            expect(seen).toEqual([sub]);
        }
        const refused = ['auth0|', '|abc', 'nopipe', 'a b|c', 'auth0|a b', 'auth0|a\u0000b', 'auth0|a\u007fb', `auth0|${'x'.repeat(250)}`, '|'];
        for (const sub of refused) {
            await rejects(present(await sign(signer, claimsFor({ idp_iss: AUTH0, sub }))), 'claims');
        }
    });

    it('an Auth0 mapping that yields a non-uuid, or a Supabase one that yields another id, is refused', async () => {
        await rejects(present(await sign(signer, claimsFor({ idp_iss: AUTH0, sub: ALICE_AUTH0 }))), 'unknown_account',
            deps({ findAccount: async () => ({ id: 'not-a-uuid', createdAt: '' }) }));
        await rejects(present(await sign(signer, claimsFor({ idp_iss: AUTH0, sub: 'auth0|nobody' }))), 'unknown_account');
    });

    it('claims: missing, extra, or wrongly typed members; non-uuid sub or jti', async () => {
        const missing: Record<string, unknown> = claimsFor();
        delete missing.jti;
        await rejects(present(await sign(signer, missing)), 'claims');
        await rejects(present(await sign(signer, claimsFor({ email: 'alice@example.com' }))), 'claims');
        await rejects(present(await sign(signer, claimsFor({ exp: String(NOW + 60) }))), 'claims');
        await rejects(present(await sign(signer, claimsFor({ sub: 'alice@example.com' }))), 'claims');
        await rejects(present(await sign(signer, claimsFor({ jti: 'not-a-uuid' }))), 'claims');
    });

    it('session scopes: a mutation only by POST over its exact body, a query only by GET, one scope each', async () => {
        const body = '{"json":{"sessionId":"11111111-2222-4333-8444-555555555555","text":"run the tests","idempotencyKey":"66666666-7777-4888-9999-aaaaaaaaaaaa"}}';
        const send = { method: 'POST' as const, procedure: 'agentSession.send', input: body, raw: Buffer.from(body) };
        const sendClaims = claimsFor({ scope: 'ezil:sessions:write', proc: 'agentSession.send', inp: inputDigest(body) });
        const ok = await authenticateDelegation(present(await sign(signer, sendClaims)), deps({ binding: send }));
        expect(ok.kind === 'accepted' && ok.call).toMatchObject({ procedure: 'agentSession.send', scopes: ['ezil:sessions:write'] });
        // The same mutation by GET with the same input string, one changed byte, or under the read scope.
        await rejects(present(await sign(signer, sendClaims)), 'binding', deps({ binding: { ...send, method: 'GET', raw: undefined } }));
        await rejects(present(await sign(signer, sendClaims)), 'binding', deps({ binding: { ...send, raw: Buffer.from(body.replace('tests', 'Tests')) } }));
        // A POST binding must carry its bytes; the decoded string alone is not enough.
        await rejects(present(await sign(signer, sendClaims)), 'binding', deps({ binding: { ...send, raw: undefined } }));
        await rejects(present(await sign(signer, { ...sendClaims, scope: 'ezil:sessions:read' })), 'scope', deps({ binding: send }));
        await rejects(present(await sign(signer, { ...sendClaims, scope: 'ezil:sessions:read ezil:sessions:write' })), 'scope', deps({ binding: send }));
        // A query by POST is refused even with a body whose digest matches.
        const list = '{"json":{}}';
        const listClaims = claimsFor({ scope: 'ezil:sessions:read', proc: 'agentSession.list', inp: inputDigest(list) });
        await rejects(present(await sign(signer, listClaims)), 'binding', deps({ binding: { method: 'POST', procedure: 'agentSession.list', input: list, raw: Buffer.from(list) } }));
        const read = await authenticateDelegation(present(await sign(signer, listClaims)), deps({ binding: { method: 'GET', procedure: 'agentSession.list', input: list } }));
        expect(read.kind).toBe('accepted');
        // The write scope does not reach reads, and the computers scope does not reach sessions.
        await rejects(present(await sign(signer, { ...listClaims, scope: 'ezil:sessions:write' })), 'scope',
            deps({ binding: { method: 'GET', procedure: 'agentSession.list', input: list } }));
        await rejects(present(await sign(signer, { ...listClaims, scope: 'ezil:computers:read' })), 'scope',
            deps({ binding: { method: 'GET', procedure: 'agentSession.list', input: list } }));
        expect(delegatedProcedureType('agentSession.send')).toBe('mutation');
        expect(delegatedProcedureType('agentSession.events')).toBe('query');
        expect(delegatedProcedureType('agentSession.create')).toBe('mutation');
        expect(delegatedProcedureType('constructor')).toBeUndefined();
    });

    it('the MCP control procedures: exactly this allowlist, one scope and one type each, closed to everything else', async () => {
        // The whole list, so an added or moved entry is a visible decision. Each procedure is in exactly one scope.
        expect(DELEGATED_PROCEDURES).toEqual({
            'ezil:computers:read': { 'computer.list': 'query', 'computer.get': 'query', 'computer.progress': 'query', 'computer.systemInfo': 'query' },
            'ezil:computers:start': { 'computer.start': 'mutation' },
            'ezil:sessions:read': {
                'agentSession.list': 'query', 'agentSession.get': 'query', 'agentSession.events': 'query', 'agentSession.operation': 'query',
                'agentSession.models': 'query', 'agentSession.settings': 'query', 'agentSession.control': 'query',
            },
            'ezil:sessions:write': {
                'agentSession.send': 'mutation', 'agentSession.cancel': 'mutation',
                'agentSession.create': 'mutation', 'agentSession.configure': 'mutation',
            },
        });
        const names = Object.values(DELEGATED_PROCEDURES).flatMap((procedures) => Object.keys(procedures));
        expect(new Set(names).size).toBe(names.length);
        expect(Object.isFrozen(DELEGATED_PROCEDURES) && Object.values(DELEGATED_PROCEDURES).every((entry) => Object.isFrozen(entry))).toBe(true);

        const post = (procedure: string, json: unknown): DelegationBinding => {
            const body = JSON.stringify({ json });
            return { method: 'POST' as const, procedure, input: body, raw: Buffer.from(body) };
        };
        const get = (procedure: string, json: unknown): DelegationBinding => ({ method: 'GET', procedure, input: JSON.stringify({ json }) });
        const key = '66666666-7777-4888-9999-aaaaaaaaaaaa';
        const computerId = '11111111-2222-4333-8444-555555555555';
        const cases = [
            { scope: 'ezil:computers:start', binding: post('computer.start', { computerId, idempotencyKey: key }) },
            { scope: 'ezil:sessions:read', binding: get('agentSession.models', { computerId }) },
            { scope: 'ezil:sessions:read', binding: get('agentSession.settings', { sessionId: computerId }) },
            { scope: 'ezil:sessions:read', binding: get('agentSession.control', { kind: 'create', idempotencyKey: key }) },
            { scope: 'ezil:sessions:write', binding: post('agentSession.create', { computerId, idempotencyKey: key }) },
            { scope: 'ezil:sessions:write', binding: post('agentSession.configure', { sessionId: computerId, model: 'm', idempotencyKey: key }) },
        ];
        for (const { scope, binding } of cases) {
            const claims = claimsFor({ scope, proc: binding.procedure, inp: binding.raw ? bytesDigest(binding.raw) : inputDigest(binding.input) });
            const outcome = await authenticateDelegation(present(await sign(signer, claims)), deps({ binding }));
            expect([binding.procedure, outcome.kind]).toEqual([binding.procedure, 'accepted']);
            // Fail closed: every OTHER scope refuses this procedure, and a lookalike procedure is not on any list.
            for (const other of ['ezil:computers:read', 'ezil:computers:start', 'ezil:sessions:read', 'ezil:sessions:write', 'ezil:account'].filter((s) => s !== scope)) {
                await rejects(present(await sign(signer, { ...claims, scope: other })), 'scope', deps({ binding }));
            }
            await rejects(present(await sign(signer, { ...claims, proc: `${binding.procedure}X` })), 'scope', deps({ binding }));
        }
        // A mutation by GET and a query by POST are refused even under the right scope, and start never reaches a read.
        const start = cases[0]!.binding;
        const startClaims = claimsFor({ scope: 'ezil:computers:start', proc: 'computer.start', inp: bytesDigest(start.raw!) });
        await rejects(present(await sign(signer, startClaims)), 'binding', deps({ binding: { ...start, method: 'GET', raw: undefined } }));
        const models = cases[1]!.binding;
        const modelsClaims = claimsFor({ scope: 'ezil:sessions:read', proc: 'agentSession.models', inp: inputDigest(models.input) });
        await rejects(present(await sign(signer, modelsClaims)), 'binding', deps({ binding: { method: 'POST', procedure: 'agentSession.models', input: models.input, raw: Buffer.from(models.input) } }));
        for (const proc of ['computer.get', 'computer.restartComputer', 'computer.switchConfiguration', 'cloudflareGuacamole.previewUrl', 'agentSession.admin']) {
            expect(delegatedProcedureType(proc)).toBe(proc === 'computer.get' ? 'query' : undefined);
        }
    });

    it('scope: unknown, empty, duplicated, or known-plus-unknown all reject', async () => {
        for (const scope of ['ezil:computers:write', '', 'ezil:computers:read ezil:computers:read', 'ezil:computers:read ezil:account', 'ezil:computers:read  ',
            'ezil:computers:read ezil:sessions:read', 'ezil:sessions:read', 'ezil:sessions:write']) {
            await rejects(present(await sign(signer, claimsFor({ scope }))), 'scope');
        }
    });

    it('a bare, lowercase or whitespace-only scheme is offered-and-invalid, never "absent"', async () => {
        for (const header of ['EZiL-Delegation', 'ezil-delegation', 'EZIL-DELEGATION', 'EZiL-Delegation    ', 'ezil-delegation \t ', '  EZiL-Delegation']) {
            await rejects(headersWith(header), 'malformed');
        }
    });

    it('exp boundary: valid at exp-1, refused at exp; the jti is kept past exp', async () => {
        let keptUntil = 0;
        const claims = claimsFor({ iat: NOW - 59, exp: NOW + 1 });
        const ok = await authenticateDelegation(present(await sign(signer, claims)), deps({
            consumeJti: async (_jti, until) => { keptUntil = until; return true; },
        }));
        expect(ok.kind).toBe('accepted');
        expect(keptUntil).toBeGreaterThanOrEqual(claims.exp as number);
        await rejects(present(await sign(signer, claimsFor({ iat: NOW - 59, exp: NOW + 1 }))), 'expired', deps({ now: () => NOW + 1 }));
    });

    it('time: expired at exp, lifetime over 60 s, exp before iat, iat beyond skew', async () => {
        await rejects(present(await sign(signer, claimsFor({ iat: NOW - 60, exp: NOW }))), 'expired');
        await rejects(present(await sign(signer, claimsFor({ iat: NOW, exp: NOW + 61 }))), 'lifetime');
        await rejects(present(await sign(signer, claimsFor({ iat: NOW, exp: NOW }))), 'lifetime');
        await rejects(present(await sign(signer, claimsFor({ iat: NOW + 11, exp: NOW + 71 }))), 'not_yet_valid');
    });

    it('an assertion is valid once: the second presentation is a replay', async () => {
        const d = deps();
        const assertion = await sign(signer);
        expect((await authenticateDelegation(present(assertion), d)).kind).toBe('accepted');
        await rejects(present(assertion), 'replayed', d);
    });

    it('a re-signed twin (ECDSA s → n−s malleability) is still caught as a replay, by jti', async () => {
        const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
        const d = deps();
        const assertion = await sign(signer);
        expect((await authenticateDelegation(present(assertion), d)).kind).toBe('accepted');
        const [h, p, s] = assertion.split('.');
        const raw = Buffer.from(s!, 'base64url');
        const twinS = (n - BigInt(`0x${raw.subarray(32).toString('hex')}`)).toString(16).padStart(64, '0');
        const twin = `${h}.${p}.${Buffer.concat([raw.subarray(0, 32), Buffer.from(twinS, 'hex')]).toString('base64url')}`;
        await rejects(present(twin), 'replayed', d);
    });

    it('concurrent presentations of one assertion: exactly one is accepted', async () => {
        const d = deps();
        const assertion = await sign(signer);
        const outcomes = await Promise.all(Array.from({ length: 25 }, () => authenticateDelegation(present(assertion), d)));
        expect(outcomes.filter((o) => o.kind === 'accepted')).toHaveLength(1);
        expect(outcomes.filter((o) => o.kind === 'rejected' && o.reason === 'replayed')).toHaveLength(24);
    });

    it('an unavailable replay ledger rejects (fail closed), and the account is never looked up', async () => {
        let looked = false;
        await rejects(present(await sign(signer)), 'replay_store_unavailable', deps({
            consumeJti: async () => { throw new Error('relation "ezil_delegation_replay" does not exist'); },
            findAccount: async () => { looked = true; return { id: ALICE, createdAt: '' }; },
        }));
        expect(looked).toBe(false);
    });

    it('a subject with no verified account is rejected, and its jti is still burned', async () => {
        const ledger = memoryLedger();
        const claims = claimsFor({ sub: '33333333-3333-4333-8333-333333333333' });
        await rejects(present(await sign(signer, claims)), 'unknown_account', deps({ consumeJti: ledger.consumeJti }));
        expect(ledger.used.has(claims.jti as string)).toBe(true);
    });

    it('an account lookup that throws, or returns a different id, rejects', async () => {
        await rejects(present(await sign(signer)), 'unknown_account', deps({ findAccount: async () => { throw new Error('db down'); } }));
        await rejects(present(await sign(signer)), 'unknown_account', deps({ findAccount: async () => ({ id: '22222222-2222-4222-8222-222222222222', createdAt: '' }) }));
    });

    it('bad signatures and bad claims never touch the replay ledger or the account store', async () => {
        let touched = 0;
        const d = deps({ consumeJti: async () => { touched++; return true; }, findAccount: async () => { touched++; return null; } });
        const [h, , s] = (await sign(signer)).split('.');
        await rejects(present(`${h}.${b64(claimsFor())}.${s}`), 'signature', d);
        await rejects(present(await sign(signer, claimsFor({ aud: 'https://os.ezil.work' }))), 'audience', d);
        expect(touched).toBe(0);
    });
});

describe('parseDelegationConfig — anything incomplete or unsafe is no config at all', () => {
    const none = async (env: DelegationEnv) => expect(await parseDelegationConfig(env, AUTH0)).toBeUndefined();

    it('each missing value', async () => {
        for (const key of ['EZIL_DELEGATION_ISSUER', 'EZIL_DELEGATION_AUDIENCE', 'EZIL_DELEGATION_PUBLIC_JWKS', 'EZIL_DELEGATION_CLIENT_IDS', 'NEXT_PUBLIC_SUPABASE_URL'] as const) {
            await none(envFor({ [key]: undefined }));
            await none(envFor({ [key]: '' }));
        }
    });

    it('issuer/audience must each be ONE bare https origin, and differ', async () => {
        await none(envFor({ EZIL_DELEGATION_ISSUER: `${MCP}, https://other.example` }));
        await none(envFor({ EZIL_DELEGATION_ISSUER: `${MCP} https://other.example` }));
        await none(envFor({ EZIL_DELEGATION_ISSUER: 'http://mcp-staging.ezil.work' }));
        await none(envFor({ EZIL_DELEGATION_ISSUER: `${MCP}/` }));
        await none(envFor({ EZIL_DELEGATION_AUDIENCE: `${OS}/api` }));
        await none(envFor({ EZIL_DELEGATION_AUDIENCE: MCP }));
    });

    it('keys: private member present, duplicate kid, wrong curve/alg/use, unknown member, too many, not JSON', async () => {
        const pub = { ...signer.publicJwk, kid: signer.kid };
        await none(envFor({}, [{ ...pub, d: 'AAAA' }]));
        await none(envFor({}, [pub, { ...other.publicJwk, kid: signer.kid }]));
        await none(envFor({}, [{ ...pub, crv: 'P-384' }]));
        await none(envFor({}, [{ ...pub, alg: 'RS256' }]));
        await none(envFor({}, [{ ...pub, use: 'enc' }]));
        await none(envFor({}, [{ ...pub, x5u: 'https://evil.example' } as Jwk]));
        await none(envFor({}, [1, 2, 3, 4].map((i) => ({ ...pub, kid: `k${i}` }))));
        await none(envFor({}, []));
        await none(envFor({ EZIL_DELEGATION_PUBLIC_JWKS: 'not json' }));
        await none(envFor({}, [{ ...pub, x: 'short' }]));
    });

    it('the identity issuer is derived from NEXT_PUBLIC_SUPABASE_URL (https only)', async () => {
        expect((await parseDelegationConfig(envFor({ NEXT_PUBLIC_SUPABASE_URL: `${SUPABASE}/` }), AUTH0))?.supabaseIssuer).toBe(IDP);
        await none(envFor({ NEXT_PUBLIC_SUPABASE_URL: 'http://btgqfmnzycdecmeyqubx.supabase.co' }));
    });

    it('client ids: space- or comma-separated exact list', async () => {
        const parsed = await parseDelegationConfig(envFor({ EZIL_DELEGATION_CLIENT_IDS: `${CLIENT}, https://claude.ai/oauth/mcp` }), AUTH0);
        expect([...parsed!.clientIds]).toEqual([CLIENT, 'https://claude.ai/oauth/mcp']);
    });
});

describe('delegationBinding — only one plain GET or one exact JSON POST can carry a delegation', () => {
    const base = 'https://os-staging.ezil.work/api/trpc/';
    const post = (url: string, body: string | null | undefined, contentType: string | null = 'application/json') =>
        delegationBinding({ method: 'POST', url, contentType, raw: typeof body === 'string' ? Buffer.from(body) : body });

    it('reads the procedure and the percent-decoded input', () => {
        const url = new URL(`${base}computer.get`);
        url.searchParams.set('input', GET_INPUT);
        expect(delegationBinding({ method: 'GET', url: url.href })).toEqual({ method: 'GET', procedure: 'computer.get', input: GET_INPUT });
        expect(delegationBinding({ method: 'GET', url: `${base}computer.list` }))
            .toEqual({ method: 'GET', procedure: 'computer.list', input: '' });
    });

    it('refuses a batch, a comma path, another parameter, a repeated input, or another method', () => {
        const get = (url: string) => delegationBinding({ method: 'GET', url });
        expect(get(`${base}computer.list?batch=1`)).toBeUndefined();
        expect(get(`${base}computer.list,billing.summary`)).toBeUndefined();
        expect(get(`${base}computer.list%2Cbilling.summary`)).toBeUndefined();
        expect(get(`${base}computer.get?input=a&input=b`)).toBeUndefined();
        expect(get(`${base}computer.get?input=a&x=1`)).toBeUndefined();
        expect(get('https://os-staging.ezil.work/api/shell/desktop')).toBeUndefined();
        for (const method of ['PUT', 'DELETE', 'PATCH', 'get']) {
            expect(delegationBinding({ method, url: `${base}computer.list`, raw: Buffer.from('{"json":null}'), contentType: 'application/json' })).toBeUndefined();
        }
    });

    it('a POST binds its exact raw body: one object whose only member is "json"', () => {
        const body = '{"json":{"sessionId":"11111111-2222-4333-8444-555555555555","text":"hi"}}';
        expect(post(`${base}agentSession.send`, body)).toEqual({ method: 'POST', procedure: 'agentSession.send', input: body, raw: Buffer.from(body) });
        expect(post(`${base}agentSession.send`, '{"json":null}', 'application/json; charset=utf-8')?.input).toBe('{"json":null}');
        // Whitespace is part of the bytes the digest covers, so it binds as sent.
        expect(post(`${base}agentSession.send`, ' {"json":1} ')?.input).toBe(' {"json":1} ');
    });

    it('a POST binds its exact bytes: malformed UTF-8 and a BOM are refused or bound as sent, never normalized', async () => {
        const url = `${base}agentSession.send`;
        const raw = (bytes: number[]) => delegationBinding({ method: 'POST', url, contentType: 'application/json', raw: Uint8Array.from(bytes) });
        const enc = (s: string) => [...Buffer.from(s)];
        // "\uFFFD" spelled as valid UTF-8 vs a lone invalid byte: the first binds, the second is refused.
        expect(raw([...enc('{"json":"'), 0xef, 0xbf, 0xbd, ...enc('"}')])).toBeDefined();
        expect(raw([...enc('{"json":"'), 0xff, ...enc('"}')])).toBeUndefined();
        expect(raw([...enc('{"json":"'), 0xc3, ...enc('"}')])).toBeUndefined();
        // A BOM is part of the bytes: it is kept, and the digest covers it (JSON.parse then refuses it).
        expect(raw([0xef, 0xbb, 0xbf, ...enc('{"json":1}')])).toBeUndefined();
        const body = '{"json":{"text":"caf\u00e9"}}';
        const bytes = Buffer.from(body);
        const binding = delegationBinding({ method: 'POST', url, contentType: 'application/json', raw: bytes })!;
        expect(binding.raw).toBe(bytes);
        expect(bytesDigest(binding.raw!)).toBe(inputDigest(body));
    });

    it('refuses a POST with a query string, a batch, no body, another content type, or any other envelope', () => {
        const body = '{"json":{}}';
        for (const url of [`${base}agentSession.send?batch=1`, `${base}agentSession.send?input=x`, `${base}agentSession.send?`,
            `${base}agentSession.send,agentSession.cancel`]) {
            expect(post(url, body)).toBeUndefined();
        }
        for (const bad of [undefined, null, '', 'null', '[]', '{}', '{"json":{},"meta":{}}', '{"0":{"json":{}}}', '"json"', '{"json":1', '{"JSON":1}']) {
            expect(post(`${base}agentSession.send`, bad)).toBeUndefined();
        }
        for (const type of [null, '', 'text/plain', 'application/x-www-form-urlencoded', 'application/json-patch+json', 'multipart/form-data']) {
            expect(post(`${base}agentSession.send`, body, type)).toBeUndefined();
        }
        const atLimit = `{"json":"${'a'.repeat(DELEGATION_MAX_BODY_BYTES - 11)}"}`;
        expect(Buffer.byteLength(atLimit)).toBe(DELEGATION_MAX_BODY_BYTES);
        expect(post(`${base}agentSession.send`, atLimit)).toBeDefined();
        expect(post(`${base}agentSession.send`, `{"json":"${'a'.repeat(DELEGATION_MAX_BODY_BYTES - 10)}"}`)).toBeUndefined();
    });
});
