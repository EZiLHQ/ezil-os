import { createPublicKey, randomUUID, sign as nodeSign, verify as nodeVerify, createPrivateKey } from 'node:crypto';
import { inspect } from 'node:util';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';

import {
    NATIVE_CANDIDATE_CIPHERTEXT_BYTES, NativeGrantBearer, isNativeGrantCandidate, nativeTokenSha256, newNativeGrantCandidate,
    openNativeCandidate, sealNativeCandidate, type NativeCandidateBinding,
} from './native-authorization-candidate';
import { NATIVE_AUTHORIZATION_ENV, loadNativeAuthorizationConfig } from './native-authorization-config';
import { NATIVE_RENEW_URL, NATIVE_REVOKE_URL, postNativeRenewal, postNativeRevoke } from './native-authorization-exchange';
import {
    NATIVE_AUTHORIZATION_SIGNATURE_DOMAIN, nativeCanonicalJson, nativeConsentBinding, nativeRenewSemantic,
    nativeRevokeSemantic, nativeSemanticBinding, signNativeAssertion,
} from './native-authorization-protocol';
import {
    AUDIENCE, ISSUER, POLICY_ID, SERVICE_CREDENTIAL, SIGNING_KID, WRAPPING_KID, approvedConsent, fixtureConfig, fixtureKeys,
    jsonResponse, recordingFetch,
} from './native-authorization.test-support';

/* An independent reference: canonical JSON and Ed25519 through node:crypto, sharing no code with the module. */
function referenceCanonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(referenceCanonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${referenceCanonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

const ENVELOPE = ['alg', 'audience', 'expiresAt', 'format', 'issuedAt', 'issuer', 'keyId'];

/** Mirrors the Gateway's order and rules: shape, canonical form, exact keys, key, signature, time, binding. */
function referenceVerify(token: string, publicJwk: JsonWebKey, nowMs: number): { ok: true; claim: Record<string, unknown> } | { ok: false; reason: string } {
    const parts = /^([A-Za-z0-9_-]{16,5900})\.([A-Za-z0-9_-]{86})$/.exec(token);
    if (!parts) return { ok: false, reason: 'malformed' };
    const payload = Buffer.from(parts[1]!, 'base64url');
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (payload.toString('base64url') !== parts[1] || signature.length !== 64) return { ok: false, reason: 'malformed' };
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
    let claim: Record<string, unknown>;
    try { claim = JSON.parse(text) as Record<string, unknown>; } catch { return { ok: false, reason: 'malformed' }; }
    if (referenceCanonical(claim) !== text) return { ok: false, reason: 'not_canonical' };
    const renew = claim.operation === 'renew';
    const keys = [...ENVELOPE, 'authorizationDeadline', 'authorizationId', 'budgetMicro', 'clientId', 'computerId', 'environment', 'epoch',
        'initialApprovalAt', 'operation', 'operationId', 'ownerUserId', 'placement', 'policyId', 'profileId', 'serviceId', 'sessionId',
        ...(renew ? ['leaseExpiresAt', 'tokenSha256'] : [])].sort();
    if (Object.keys(claim).sort().join(',') !== keys.join(',')) return { ok: false, reason: 'claim_invalid' };
    if (claim.keyId !== SIGNING_KID) return { ok: false, reason: 'unknown_key' };
    const signed = Buffer.from(`${NATIVE_AUTHORIZATION_SIGNATURE_DOMAIN}.${parts[1]}`, 'utf8');
    if (!nodeVerify(null, signed, createPublicKey({ key: { ...publicJwk } as Record<string, string>, format: 'jwk' }), signature)) return { ok: false, reason: 'signature' };
    const issuedAt = Date.parse(claim.issuedAt as string);
    const expiresAt = Date.parse(claim.expiresAt as string);
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 60_000) return { ok: false, reason: 'too_long' };
    if (issuedAt > nowMs + 10_000) return { ok: false, reason: 'not_yet_valid' };
    if (nowMs >= expiresAt) return { ok: false, reason: 'expired' };
    if (claim.issuer !== ISSUER || claim.audience !== AUDIENCE || claim.environment !== 'staging' || claim.policyId !== POLICY_ID) {
        return { ok: false, reason: 'unbound' };
    }
    return { ok: true, claim };
}

/** Signs an arbitrary payload text with node:crypto, to build tokens the module would never produce. */
function forge(text: string, privateJwk: JsonWebKey): string {
    const payload = Buffer.from(text, 'utf8').toString('base64url');
    const key = createPrivateKey({ key: { ...privateJwk } as Record<string, string>, format: 'jwk' });
    return `${payload}.${nodeSign(null, Buffer.from(`${NATIVE_AUTHORIZATION_SIGNATURE_DOMAIN}.${payload}`, 'utf8'), key).toString('base64url')}`;
}

const lease = (now: number) => new Date(now + 4 * 60_000).toISOString();

describe('native authorization protocol', () => {
    it('signs a renew claim that an independent canonical JSON and node:crypto Ed25519 verifier accepts byte for byte', async () => {
        const keys = await fixtureKeys();
        const now = Date.now();
        const consent = approvedConsent(now);
        const binding = nativeConsentBinding(consent)!;
        const candidate = newNativeGrantCandidate();
        const semantic = nativeRenewSemantic(binding, randomUUID(), lease(now), nativeTokenSha256(candidate));
        const assertion = await signNativeAssertion(fixtureConfig(keys).signer, semantic, { issuer: ISSUER, audience: AUDIENCE, nowMs: now });
        const verified = referenceVerify(assertion.token, keys.publicJwk, now);
        expect(verified.ok).toBe(true);
        if (!verified.ok) return;
        const { claim } = verified;
        expect(claim).toMatchObject({ format: 'ezil.native-authorization.v1', alg: 'Ed25519', keyId: SIGNING_KID, operation: 'renew',
            environment: 'staging', serviceId: 'ezil-os-native', profileId: 'ezil-native-claude-v1', tokenSha256: semantic.tokenSha256,
            issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString() });
        // Only its hash is in the claim, never the candidate.
        expect(assertion.token).not.toContain(candidate.slice(4));
        // Same key and payload: the module's signature equals node:crypto's (Ed25519 is deterministic).
        expect(forge(referenceCanonical(claim), keys.privateJwk)).toBe(assertion.token);
        // A rotated envelope keeps the semantic tuple exactly.
        const later = await signNativeAssertion(fixtureConfig(keys).signer, semantic, { issuer: ISSUER, audience: AUDIENCE, nowMs: now + 45_000 });
        const again = referenceVerify(later.token, keys.publicJwk, now + 45_000);
        const semanticOf = (c: Record<string, unknown>) => Object.fromEntries(Object.entries(c).filter(([k]) => !ENVELOPE.includes(k)));
        expect(again.ok && semanticOf(again.claim)).toEqual(semanticOf(claim));
    });

    it('signs a revoke without lease or token hash, and the reference refuses tamper, BOM, extra keys, expiry and wrong keys', async () => {
        const keys = await fixtureKeys();
        const other = await fixtureKeys();
        const now = Date.now();
        const binding = nativeConsentBinding(approvedConsent(now))!;
        const semantic = nativeRevokeSemantic(binding, randomUUID());
        const { token } = await signNativeAssertion(fixtureConfig(keys).signer, semantic, { issuer: ISSUER, audience: AUDIENCE, nowMs: now });
        const verified = referenceVerify(token, keys.publicJwk, now);
        expect(verified.ok).toBe(true);
        if (!verified.ok) return;
        expect(verified.claim).not.toHaveProperty('leaseExpiresAt');
        expect(verified.claim).not.toHaveProperty('tokenSha256');
        const text = referenceCanonical(verified.claim);
        const [payload, signature] = token.split('.') as [string, string];
        const flipped = `${payload.slice(0, 10)}${payload[10] === 'A' ? 'B' : 'A'}${payload.slice(11)}.${signature}`;
        expect(referenceVerify(flipped, keys.publicJwk, now)).toMatchObject({ ok: false });
        expect(referenceVerify(token, other.publicJwk, now)).toEqual({ ok: false, reason: 'signature' });
        expect(referenceVerify(forge(`﻿${text}`, keys.privateJwk), keys.publicJwk, now)).toMatchObject({ ok: false });
        expect(referenceVerify(forge(referenceCanonical({ ...verified.claim, extra: 'x' }), keys.privateJwk), keys.publicJwk, now))
            .toEqual({ ok: false, reason: 'claim_invalid' });
        expect(referenceVerify(forge(JSON.stringify(verified.claim, null, 1), keys.privateJwk), keys.publicJwk, now))
            .toEqual({ ok: false, reason: 'not_canonical' });
        expect(referenceVerify(token, keys.publicJwk, now + 30_000)).toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses to sign out-of-shape envelopes and terms before signing', async () => {
        const keys = await fixtureKeys();
        const signer = fixtureConfig(keys).signer;
        const now = Date.now();
        const binding = nativeConsentBinding(approvedConsent(now))!;
        const semantic = nativeRevokeSemantic(binding, randomUUID());
        let signed = 0;
        const counting = { keyId: signer.keyId, sign: async (m: Uint8Array) => { signed += 1; return signer.sign(m); } };
        for (const options of [{ ttlMs: 61_000 }, { ttlMs: 999 }, { issuer: 'http://os.ezil.work' }, { audience: '' }]) {
            await expect(signNativeAssertion(counting, semantic, { issuer: ISSUER, audience: AUDIENCE, nowMs: now, ...options })).rejects.toThrow();
        }
        // Consent approved in the future relative to the envelope.
        await expect(signNativeAssertion(counting, semantic, { issuer: ISSUER, audience: AUDIENCE,
            nowMs: Date.parse(binding.initialApprovalAt) - 11_000 })).rejects.toThrow();
        await expect(signNativeAssertion(counting, { ...semantic, extra: 'x' } as never, { issuer: ISSUER, audience: AUDIENCE, nowMs: now })).rejects.toThrow();
        expect(signed).toBe(0);
        expect(() => nativeRenewSemantic(binding, randomUUID(), lease(now), 'A'.repeat(64))).toThrow();
        expect(() => nativeRenewSemantic(binding, randomUUID().toUpperCase(), lease(now), 'a'.repeat(64))).toThrow();
    });

    it('accepts only the exact 13-field approved v1 binding and never fills in missing terms', () => {
        const now = Date.now();
        const good = approvedConsent(now);
        expect(Object.keys(good)).toHaveLength(13);
        expect(nativeConsentBinding(good)).toEqual(good);
        expect(Object.isFrozen(nativeConsentBinding(good)!.placement)).toBe(true);
        const bad: Record<string, unknown>[] = [
            { authorizationId: good.authorizationId.toUpperCase() }, { epoch: '0' }, { epoch: '01' }, { epoch: 7 },
            { budgetMicro: '9223372036854775808' }, { budgetMicro: '-1' }, { budgetMicro: null },
            { profileId: 'ezil-native-codex-v1' }, { serviceId: 'ezil-mcp' }, { clientId: 'has space' },
            { initialApprovalAt: good.initialApprovalAt.replace('Z', '+00:00') },
            { authorizationDeadline: new Date(Date.parse(good.initialApprovalAt) + 24 * 3_600_000 + 1).toISOString() },
            { authorizationDeadline: good.initialApprovalAt },
            { placement: { ...good.placement, instanceId: 'i-XYZ' } }, { placement: { ...good.placement, extra: '1' } },
            { budgetMicro: undefined },
        ];
        for (const override of bad) expect(nativeConsentBinding({ ...good, ...override })).toBeNull();
        const missing: Record<string, unknown> = { ...good };
        delete missing.budgetMicro;
        expect(nativeConsentBinding(missing)).toBeNull();
        // Task digests and instructions are not consent terms: a reader result carrying them is refused, not trimmed.
        expect(nativeConsentBinding({ ...good, inputDigest: `sha256:${'b'.repeat(64)}` })).toBeNull();
        expect(nativeConsentBinding({ ...good, privateInstruction: 'x' })).toBeNull();
        const semantic = nativeRevokeSemantic(nativeConsentBinding(good)!, randomUUID());
        expect(nativeSemanticBinding(semantic)).toEqual(good);
    });

    it('writes canonical JSON by UTF-16 code unit and refuses what JSON cannot represent', () => {
        expect(nativeCanonicalJson({ b: 1, a: { d: [2, 'x'], c: null } })).toBe('{"a":{"c":null,"d":[2,"x"]},"b":1}');
        // U+10000 is a surrogate pair (0xD800...), which sorts before U+FFFF by code unit, after it by code point.
        expect(nativeCanonicalJson({ '￿': 1, '\u{10000}': 2 })).toBe('{"\u{10000}":2,"￿":1}');
        expect(nativeCanonicalJson({ s: ' "é' })).toBe(JSON.stringify({ s: ' "é' }));
        const sample = { z: 'é', a: [1, { y: true, b: false }] };
        expect(JSON.parse(nativeCanonicalJson(sample))).toEqual(sample);
        for (const bad of [{ a: undefined }, { a: Number.NaN }, new Date(0), { a: () => 1 }]) expect(() => nativeCanonicalJson(bad)).toThrow();
    });
});

describe('native grant candidate', () => {
    const bindingFor = (token: string): NativeCandidateBinding => ({ ownerUserId: randomUUID(), operationId: randomUUID(),
        authorizationId: randomUUID(), semanticDigest: `sha256:${'c'.repeat(64)}`, tokenSha256: nativeTokenSha256(token) });

    it('is 32 random bytes in the Gateway opaque form, hashed over its full UTF-8 text', () => {
        const a = newNativeGrantCandidate();
        expect(isNativeGrantCandidate(a)).toBe(true);
        expect(Buffer.from(a.slice(4), 'base64url')).toHaveLength(32);
        expect(newNativeGrantCandidate()).not.toBe(a);
        // FIPS 180-2 vector, then the full UTF-8 text (prefix included) of a token.
        expect(nativeTokenSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(nativeTokenSha256(a)).toMatch(/^[0-9a-f]{64}$/);
        expect(nativeTokenSha256(a)).not.toBe(nativeTokenSha256(a.slice(4)));
    });

    it('opens only under the same key, version, nonce, ciphertext and every bound field', async () => {
        const keys = await fixtureKeys();
        const token = newNativeGrantCandidate();
        const binding = bindingFor(token);
        const sealed = await sealNativeCandidate(keys.wrapping, token, binding);
        expect(sealed.ciphertext).toHaveLength(NATIVE_CANDIDATE_CIPHERTEXT_BYTES);
        expect(Buffer.from(sealed.ciphertext).includes(Buffer.from(token))).toBe(false);
        expect(await openNativeCandidate(keys.wrapping, sealed, binding)).toBe(token);
        const flip = (b: Uint8Array, i: number) => { const c = new Uint8Array(b); c[i]! ^= 1; return c; };
        expect(await openNativeCandidate(keys.wrapping, { ...sealed, ciphertext: flip(sealed.ciphertext, 3) }, binding)).toBeNull();
        expect(await openNativeCandidate(keys.wrapping, { ...sealed, ciphertext: flip(sealed.ciphertext, 62) }, binding)).toBeNull();
        expect(await openNativeCandidate(keys.wrapping, { ...sealed, nonce: flip(sealed.nonce, 0) }, binding)).toBeNull();
        expect(await openNativeCandidate(keys.wrapping, { ...sealed, version: 2 }, binding)).toBeNull();
        for (const field of ['ownerUserId', 'operationId', 'authorizationId'] as const) {
            expect(await openNativeCandidate(keys.wrapping, sealed, { ...binding, [field]: randomUUID() })).toBeNull();
        }
        expect(await openNativeCandidate(keys.wrapping, sealed, { ...binding, semanticDigest: `sha256:${'d'.repeat(64)}` })).toBeNull();
        expect(await openNativeCandidate(keys.wrapping, sealed, { ...binding, tokenSha256: 'e'.repeat(64) })).toBeNull();
        // Rotation fails closed: another key id, or another key under the same id.
        const rotated = await fixtureKeys('grant-wrap-test-2');
        expect(await openNativeCandidate(rotated.wrapping, sealed, binding)).toBeNull();
        expect(await openNativeCandidate({ keyId: WRAPPING_KID, key: rotated.wrapping.key }, sealed, binding)).toBeNull();
        await expect(sealNativeCandidate(keys.wrapping, token, { ...binding, tokenSha256: 'f'.repeat(64) })).rejects.toThrow();
        await expect(sealNativeCandidate(keys.wrapping, 'ezs_' + token.slice(4), binding)).rejects.toThrow();
    });

    it('exposes the bearer only through its header and never through JSON, superjson, strings or inspection', () => {
        const token = newNativeGrantCandidate();
        const bearer = new NativeGrantBearer(token, randomUUID(), randomUUID(), new Date(Date.now() + 60_000));
        expect(bearer.authorizationHeader()).toBe(`Bearer ${token}`);
        for (const text of [JSON.stringify(bearer), JSON.stringify({ bearer }), superjson.stringify({ bearer }), String(bearer),
            `${bearer}`, inspect(bearer), inspect({ bearer }, { depth: 5, showHidden: true }), Object.keys(bearer).join()]) {
            expect(text).not.toContain(token.slice(4));
        }
    });
});

describe('native authorization configuration', () => {
    const envFor = async () => {
        const keys = await fixtureKeys();
        return { keys, env: {
            EZIL_NATIVE_SESSIONS_ORIGIN: 'https://os-staging.ezil.work',
            EZIL_NATIVE_AUTHORIZATION: 'enabled', EZIL_NATIVE_AUTHORIZATION_ISSUER: ISSUER, EZIL_NATIVE_AUTHORIZATION_AUDIENCE: AUDIENCE,
            EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY_ID: SIGNING_KID,
            EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: keys.privateJwk.x, d: keys.privateJwk.d }),
            EZIL_NATIVE_AUTHORIZATION_POLICY_ID: POLICY_ID, EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL: SERVICE_CREDENTIAL,
            EZIL_NATIVE_AUTHORIZATION_SERVICE_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString().replace('Z', '+00:00'),
            EZIL_NATIVE_GRANT_WRAPPING_KEY_ID: WRAPPING_KID, EZIL_NATIVE_GRANT_WRAPPING_KEY: Buffer.from(keys.wrappingRaw).toString('base64url'),
        } as Record<string, string | undefined> };
    };

    it('signs and sends production authorizations only to the main Gateway', async () => {
        const now = Date.now();
        const { env } = await envFor();
        const prod = { ...env, EZIL_NATIVE_SESSIONS_ORIGIN: 'https://os.ezil.work',
            EZIL_NATIVE_AUTHORIZATION_ISSUER: 'https://os.ezil.work/native-authorization',
            EZIL_NATIVE_AUTHORIZATION_AUDIENCE: 'https://ai.ezil.work' };
        for (const invalid of [{ EZIL_NATIVE_AUTHORIZATION_AUDIENCE: AUDIENCE },
            { EZIL_NATIVE_AUTHORIZATION_ISSUER: ISSUER }, { EZIL_NATIVE_SESSIONS_ORIGIN: 'https://foreign.example.test' }]) {
            expect((await loadNativeAuthorizationConfig({ ...prod, ...invalid }, now)).state).toBe('misconfigured');
        }
        const loaded = await loadNativeAuthorizationConfig(prod, now);
        expect(loaded.state).toBe('ready');
        if (loaded.state !== 'ready') throw Error('missing production fixture');
        const { config } = loaded;
        const binding = nativeConsentBinding(approvedConsent(now))!;
        const renewal = nativeRenewSemantic(binding, randomUUID(), lease(now), nativeTokenSha256(newNativeGrantCandidate()), config.environment);
        const revoke = nativeRevokeSemantic(binding, randomUUID(), config.environment);
        const options = { issuer: config.issuer, audience: config.audience, nowMs: now };
        const assertion = await signNativeAssertion(config.signer, renewal, options);
        const revocation = await signNativeAssertion(config.signer, revoke, options);
        expect(JSON.parse(Buffer.from(assertion.token.split('.')[0]!, 'base64url').toString())).toMatchObject({
            environment: 'production', audience: 'https://ai.ezil.work', issuer: config.issuer,
        });
        const fetch = recordingFetch(() => new Response(null, { status: 403 }));
        const deps = { fetchImpl: fetch.fetchImpl, now: () => now };
        await postNativeRenewal(config, renewal, assertion, deps);
        await postNativeRevoke(config, revoke, revocation, deps);
        expect(fetch.calls.map(call => call.url)).toEqual(['https://ai.ezil.work/v1/token/exchange',
            'https://ai.ezil.work/v1/token/native-authorization/revoke']);
        await expect(postNativeRenewal(config, { ...renewal, environment: 'staging' }, assertion, deps)).rejects.toThrow('gateway_origin_mismatch');
        expect(fetch.calls).toHaveLength(2);
    });

    it('is off with every pin absent, misconfigured with any one missing or invalid, and ready only when complete', async () => {
        const now = Date.now();
        expect(await loadNativeAuthorizationConfig({}, now)).toEqual({ state: 'off' });
        const { keys, env } = await envFor();
        const ready = await loadNativeAuthorizationConfig(env, now);
        expect(ready.state).toBe('ready');
        for (const name of NATIVE_AUTHORIZATION_ENV) {
            expect((await loadNativeAuthorizationConfig({ ...env, [name]: undefined }, now)).state).toBe('misconfigured');
        }
        const other = await fixtureKeys();
        const cases: Record<string, string>[] = [
            { EZIL_NATIVE_AUTHORIZATION: 'true' }, { EZIL_NATIVE_AUTHORIZATION_ISSUER: 'http://os.ezil.work' },
            { EZIL_NATIVE_AUTHORIZATION_POLICY_ID: POLICY_ID.toUpperCase() },
            { EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL: `ezg_${'S'.repeat(43)}` },
            { EZIL_NATIVE_AUTHORIZATION_SERVICE_EXPIRES_AT: new Date(now - 1).toISOString() },
            // Mismatched pair: the public half of another key.
            { EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: other.privateJwk.x, d: keys.privateJwk.d }) },
            { EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY: JSON.stringify({ ...keys.privateJwk, kid: 'x' }) },
            { EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY_ID: 'bad kid' },
            { EZIL_NATIVE_GRANT_WRAPPING_KEY: Buffer.from(keys.wrappingRaw.slice(0, 16)).toString('base64url') },
            { EZIL_NATIVE_GRANT_WRAPPING_KEY: `${Buffer.from(keys.wrappingRaw).toString('base64url')}=` },
        ];
        for (const override of cases) expect((await loadNativeAuthorizationConfig({ ...env, ...override }, now)).state).toBe('misconfigured');
        if (ready.state !== 'ready') return;
        for (const text of [JSON.stringify(ready), inspect(ready, { depth: 5 }), superjson.stringify(ready)]) {
            expect(text).not.toContain(SERVICE_CREDENTIAL);
            expect(text).not.toContain(String(keys.privateJwk.d));
            expect(text).not.toContain(Buffer.from(keys.wrappingRaw).toString('base64url'));
        }
    });
});

describe('native authorization exchange', () => {
    const setup = async (now: number) => {
        const keys = await fixtureKeys();
        const config = fixtureConfig(keys);
        const binding = nativeConsentBinding(approvedConsent(now))!;
        const semantic = nativeRenewSemantic(binding, randomUUID(), lease(now), nativeTokenSha256(newNativeGrantCandidate()));
        const assertion = await signNativeAssertion(config.signer, semantic, { issuer: ISSUER, audience: AUDIENCE, nowMs: now });
        const grant = (extra: Record<string, unknown> = {}) => ({ object: 'native_authorization_grant', grant_id: randomUUID(),
            expires_at: semantic.leaseExpiresAt.replace('Z', '+00:00'), authorization_id: semantic.authorizationId, epoch: semantic.epoch,
            authorization_deadline: semantic.authorizationDeadline.replace(/\.(\d{3})Z$/, '.$1000+00:00'), budget_micro: semantic.budgetMicro,
            replayed: false, ...extra });
        return { config, semantic, assertion, grant };
    };

    it('sends one fixed POST with the exact body and records a new grant or an equal replay', async () => {
        const now = Date.now();
        const { config, semantic, assertion, grant } = await setup(now);
        const body = grant();
        const fetch201 = recordingFetch(() => jsonResponse(201, body));
        const outcome = await postNativeRenewal(config, semantic, assertion, { fetchImpl: fetch201.fetchImpl, now: () => now });
        expect(outcome).toEqual({ kind: 'granted', grantId: body.grant_id, expiresAt: new Date(semantic.leaseExpiresAt), replayed: false });
        expect(fetch201.calls).toHaveLength(1);
        const [call] = fetch201.calls;
        expect(call!.url).toBe(NATIVE_RENEW_URL);
        expect(call!.init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit' });
        expect((call!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SERVICE_CREDENTIAL}`);
        expect(call!.body).toEqual({ policyId: POLICY_ID, proofKind: 'ezil_native_authorization', subjectToken: assertion.token });
        // An equal replay may carry the original, already expired metadata.
        const expired = grant({ replayed: true, expires_at: new Date(now - 60_000).toISOString() });
        const fetch200 = recordingFetch(() => jsonResponse(200, expired));
        expect(await postNativeRenewal(config, semantic, assertion, { fetchImpl: fetch200.fetchImpl, now: () => now }))
            .toMatchObject({ kind: 'granted', replayed: true, expiresAt: new Date(now - 60_000) });
    });

    it('treats any answer that breaks the sealed bindings, bounds or status as unknown, and a clean 4xx as refused', async () => {
        const now = Date.now();
        const { config, semantic, assertion, grant } = await setup(now);
        const run = async (response: () => Response | Promise<Response>, clock: () => number = () => now) =>
            postNativeRenewal(config, semantic, assertion, { fetchImpl: recordingFetch(response).fetchImpl, now: clock, timeoutMs: 200 });
        const unknown = { kind: 'unknown', reason: 'gateway_invalid_response' };
        expect(await run(() => jsonResponse(201, grant({ replayed: true })))).toEqual(unknown);
        expect(await run(() => jsonResponse(200, grant()))).toEqual(unknown);
        expect(await run(() => jsonResponse(201, grant({ authorization_id: randomUUID() })))).toEqual(unknown);
        expect(await run(() => jsonResponse(201, grant({ epoch: '3000000002' })))).toEqual(unknown);
        expect(await run(() => jsonResponse(201, grant({ budget_micro: '25000001' })))).toEqual(unknown);
        expect(await run(() => jsonResponse(201, grant({ authorization_deadline: new Date(now + 3_600_000).toISOString() })))).toEqual(unknown);
        expect(await run(() => jsonResponse(201, grant({ expires_at: new Date(Date.parse(semantic.leaseExpiresAt) + 1).toISOString() })))).toEqual(unknown);
        expect(await run(() => jsonResponse(201, grant({ expires_at: new Date(now).toISOString() })))).toEqual(unknown);
        expect(await run(() => jsonResponse(201, grant({ access_token: newNativeGrantCandidate() })))).toEqual(unknown);
        expect(await run(() => jsonResponse(201, grant({ object: 'delegation_grant' })))).toEqual(unknown);
        expect(await run(() => jsonResponse(201, grant({ grant_id: 'not-a-uuid' })))).toEqual(unknown);
        expect(await run(() => new Response(JSON.stringify(grant()), { status: 201, headers: { 'content-type': 'text/plain' } }))).toEqual(unknown);
        expect(await run(() => jsonResponse(201, { ...grant(), pad: 'x'.repeat(5000) }))).toEqual(unknown);
        expect(await run(() => jsonResponse(202, grant()))).toEqual(unknown);
        // An answer received after the timeout is never used, even a valid one.
        let tick = now;
        expect(await run(() => jsonResponse(201, grant()), () => { const t = tick; tick += 201; return t; }))
            .toEqual({ kind: 'unknown', reason: 'gateway_timeout' });
        expect(await run(() => jsonResponse(503, {}))).toEqual({ kind: 'unknown', reason: 'gateway_unavailable' });
        expect(await run(() => { throw new TypeError('fetch failed'); })).toEqual({ kind: 'unknown', reason: 'gateway_unavailable' });
        const hang = () => new Promise<Response>((_, reject) => setTimeout(() => reject(Object.assign(new Error('t'), { name: 'TimeoutError' })), 10));
        expect(await run(hang)).toEqual({ kind: 'unknown', reason: 'gateway_timeout' });
        for (const status of [400, 401, 402, 403, 409]) expect(await run(() => jsonResponse(status, { error: 'x' }))).toEqual({ kind: 'refused', status });
    });

    it('revokes with exactly policyId and subjectToken at the fixed revoke endpoint', async () => {
        const now = Date.now();
        const { config, semantic } = await setup(now);
        const revoke = nativeRevokeSemantic(nativeSemanticBinding(semantic), randomUUID());
        const assertion = await signNativeAssertion(config.signer, revoke, { issuer: ISSUER, audience: AUDIENCE, nowMs: now });
        const body = { object: 'native_authorization_revocation', authorization_id: revoke.authorizationId,
            revoked_at: new Date(now).toISOString().replace('Z', '+00:00'), already_revoked: false };
        const ok = recordingFetch(() => jsonResponse(200, body));
        expect(await postNativeRevoke(config, revoke, assertion, { fetchImpl: ok.fetchImpl, now: () => now }))
            .toEqual({ kind: 'revoked', revokedAt: new Date(now), alreadyRevoked: false });
        expect(ok.calls[0]!.url).toBe(NATIVE_REVOKE_URL);
        expect(ok.calls[0]!.body).toEqual({ policyId: POLICY_ID, subjectToken: assertion.token });
        const run = (status: number, value: unknown) => postNativeRevoke(config, revoke, assertion,
            { fetchImpl: recordingFetch(() => jsonResponse(status, value)).fetchImpl, now: () => now });
        expect(await run(201, body)).toMatchObject({ kind: 'unknown' });
        expect(await run(200, { ...body, authorization_id: randomUUID() })).toMatchObject({ kind: 'unknown' });
        expect(await run(200, { ...body, extra: 1 })).toMatchObject({ kind: 'unknown' });
        expect(await run(403, {})).toEqual({ kind: 'refused', status: 403 });
    });
});
