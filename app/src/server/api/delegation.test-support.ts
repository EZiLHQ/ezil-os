/**
 * Test fixtures for delegated computer reads: published-shape ES256 assertions (`EZiL-Delegation`, JOSE
 * `ezil-delegation+jwt`, raw 64-byte signature) signed with throwaway P-256 keys. Origins are synthetic `.test`
 * names: no live MCP or OS value is pinned here.
 */
import { randomUUID, webcrypto } from 'node:crypto';

import { DELEGATED_READ_SCOPE, DELEGATION_TYPE, inputDigest, type DelegationEnv } from './delegation-auth';

export const MCP_ORIGIN = 'https://mcp.delegation.test';
export const OS_ORIGIN = 'https://os.delegation.test';
export const SUPABASE_URL = 'https://project.supabase.test';
export const SUPABASE_ISSUER = `${SUPABASE_URL}/auth/v1`;
export const CLIENT_ID = 'mcp-client-qualified';
export const KID = 'delegation-key-1';

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export interface SigningKey {
    privateKey: webcrypto.CryptoKey;
    publicJwk: Record<string, unknown>;
}

export async function signingKey(kid = KID): Promise<SigningKey> {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    return { privateKey: pair.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' } };
}

export function delegationEnv(keys: SigningKey[], overrides: Partial<DelegationEnv> = {}): Required<DelegationEnv> {
    return {
        EZIL_DELEGATION_ISSUER: MCP_ORIGIN, EZIL_DELEGATION_AUDIENCE: OS_ORIGIN,
        EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: keys.map(k => k.publicJwk) }),
        EZIL_DELEGATION_CLIENT_IDS: CLIENT_ID, NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        ...overrides,
    } as Required<DelegationEnv>;
}

export type Claims = Record<string, unknown>;

/** Claims for one read, as the MCP builds them: `inp` digests the exact `input` query string, or '' when absent. */
export function readClaims(sub: string, procedure: 'computer.list' | 'computer.get', input: string, overrides: Claims = {}): Claims {
    const now = Math.floor(Date.now() / 1000);
    return {
        iss: MCP_ORIGIN, aud: OS_ORIGIN, sub, idp_iss: SUPABASE_ISSUER, client_id: CLIENT_ID, scope: DELEGATED_READ_SCOPE,
        proc: procedure, inp: inputDigest(input), jti: randomUUID(), iat: now, exp: now + 60, ...overrides,
    };
}

export async function signAssertion(key: SigningKey, claims: Claims, header: Claims = {}): Promise<string> {
    const h = b64({ alg: 'ES256', typ: DELEGATION_TYPE, kid: key.publicJwk.kid, ...header });
    const p = b64(claims);
    const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${Buffer.from(signature).toString('base64url')}`;
}

/** The columns of Supabase's `auth.users` that the account lookup reads, as a scoped stand-in table. */
export const AUTH_USERS_DDL = (schema: string) => `CREATE TABLE ${schema}.auth_users (id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz NULL, banned_until timestamptz NULL,
    is_anonymous boolean NOT NULL DEFAULT false, email text NULL, email_confirmed_at timestamptz NULL,
    phone_confirmed_at timestamptz NULL, raw_app_meta_data jsonb NULL, raw_user_meta_data jsonb NULL)`;

/** The MCP's serialisation of a tRPC GET input: `JSON.stringify({ json: input })`, URL-encoded once. */
export const mcpInput = (input: unknown) => JSON.stringify({ json: input });
export const readUrl = (procedure: string, input?: string, origin = OS_ORIGIN) =>
    `${origin}/api/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(input)}`}`;
