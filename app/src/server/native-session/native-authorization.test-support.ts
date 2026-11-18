/** Test fixtures only: every key is generated in RAM per run; nothing is read from the environment or disk. */
import { randomUUID } from 'node:crypto';

import type { NativeWrappingKey } from './native-authorization-candidate';
import { NativeAuthorizationConfig } from './native-authorization-config';
import { ed25519NativeSigner, type NativeConsentBinding } from './native-authorization-protocol';

export const ISSUER = 'https://os-staging.ezil.work/native-authorization';
export const AUDIENCE = 'https://ai-staging.ezil.work';
export const POLICY_ID = '7c0c9a41-2f43-4c7e-9a52-4d1d3b6e8f10';
export const SERVICE_CREDENTIAL = `ezs_${'S'.repeat(43)}`;
export const SIGNING_KID = 'os-native-test-1';
export const WRAPPING_KID = 'grant-wrap-test-1';

export interface FixtureKeys {
    readonly privateJwk: JsonWebKey;
    readonly publicJwk: JsonWebKey;
    readonly privateKey: CryptoKey;
    readonly wrappingRaw: Uint8Array;
    readonly wrapping: NativeWrappingKey;
}

export async function fixtureKeys(wrappingKid: string = WRAPPING_KID): Promise<FixtureKeys> {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privateKey = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x, d: privateJwk.d },
        { name: 'Ed25519' }, false, ['sign']);
    const wrappingRaw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', wrappingRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return { privateJwk, publicJwk, privateKey, wrappingRaw, wrapping: { keyId: wrappingKid, key } };
}

export function fixtureConfig(keys: FixtureKeys, serviceExpiresAt: Date = new Date(Date.now() + 24 * 3_600_000),
    wrapping: NativeWrappingKey = keys.wrapping): NativeAuthorizationConfig {
    return new NativeAuthorizationConfig(ISSUER, AUDIENCE, POLICY_ID, SERVICE_CREDENTIAL, serviceExpiresAt,
        ed25519NativeSigner(SIGNING_KID, keys.privateKey), wrapping);
}

const instance = () => `i-${randomUUID().replaceAll('-', '').slice(0, 17)}`;

/** The exact 13-field approved v1 binding the trusted reader returns, approved `approvedAgoMs` before `now`. */
export function approvedConsent(now: number, overrides: Partial<Record<keyof NativeConsentBinding, unknown>> = {},
    approvedAgoMs = 60_000, lifetimeMs = 8 * 3_600_000): NativeConsentBinding {
    const initial = now - approvedAgoMs;
    return {
        authorizationId: randomUUID(),
        epoch: '3000000001',
        ownerUserId: randomUUID(),
        sessionId: randomUUID(),
        computerId: randomUUID(),
        placement: { generation: '4294967301', leaseEpoch: '7', instanceId: instance(), fenceToken: randomUUID() },
        clientId: 'ezil-mcp-client.claude',
        profileId: 'ezil-native-claude-v1',
        policyId: POLICY_ID,
        serviceId: 'ezil-os-native',
        budgetMicro: '25000000',
        initialApprovalAt: new Date(initial).toISOString(),
        authorizationDeadline: new Date(initial + lifetimeMs).toISOString(),
        ...overrides,
    } as NativeConsentBinding;
}

/** A recording fetch that answers from `respond`. */
export function recordingFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown> });
        return respond(url, init ?? {});
    }) as typeof fetch;
    return { calls, fetchImpl };
}

export function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
