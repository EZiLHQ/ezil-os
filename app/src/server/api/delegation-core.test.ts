import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { authenticateDelegation, delegationBinding } from './delegation-auth';
import {
    inputDigest, parseDelegationConfig, verifyDelegation, type DelegationConfig, type DelegationCoreDeps, type DelegationPolicy,
} from './delegation-core';
import { consumeDelegationJti } from './delegation-store';
import {
    CLIENT_ID, SUPABASE_ISSUER, delegationEnv, mcpInput, readClaims, readUrl, signAssertion, signingKey, type Claims, type SigningKey,
} from './delegation.test-support';

const AUTH0 = 'https://id.ezil.work/';
const USER = randomUUID();
const OPERATION = randomUUID();
const SESSION = randomUUID();

/** Root-specified native REST transcript: domain tag, method, canonical path, then the exact body (empty for GET), LF-separated. */
const transcript = (method: 'GET' | 'POST', pathname: string, body = '') => `EZIL-NATIVE-REST/1\n${method}\n${pathname}\n${body}`;

/** The future native wrapper's fixed source policy (owned by the auth-intent lane), reproduced here only as a fixture. */
const NATIVE_POLICY: DelegationPolicy = {
    scopeByProcedure: new Map([
        ['nativeAuthorization.prepare', 'ezil:native-sessions:write'],
        ['nativeAuthorization.get', 'ezil:native-sessions:read'],
        ['nativeSession.get', 'ezil:native-sessions:read'],
    ]),
};

let key: SigningKey;
let config: DelegationConfig;
beforeAll(async () => {
    key = await signingKey();
    config = (await parseDelegationConfig(delegationEnv([key]), AUTH0))!;
});

const nativeClaims = (procedure: string, scope: string, serializedInput: string, overrides: Claims = {}): Claims =>
    readClaims(USER, 'computer.list', '', { proc: procedure, scope, inp: inputDigest(serializedInput), ...overrides });
const headersFor = async (claims: Claims) => new Headers({ authorization: `EZiL-Delegation ${await signAssertion(key, claims)}` });

function nativeDeps(binding: DelegationCoreDeps['binding'], overrides: Partial<DelegationCoreDeps> = {}) {
    const consumeJti = vi.fn(async () => true);
    const findAccount = vi.fn(async () => ({ id: USER, createdAt: '2026-11-01T00:00:00.000Z' }));
    const deps: DelegationCoreDeps = { enabled: true, config, binding, policy: NATIVE_POLICY, now: () => Math.floor(Date.now() / 1000),
        consumeJti, findAccount, ...overrides };
    return { deps, consumeJti, findAccount };
}

describe('verifyDelegation (shared core)', () => {
    it('accepts a Supabase identity under a native policy and returns the exact verified caller', async () => {
        const body = JSON.stringify({ v: 1, operationId: OPERATION });
        const input = transcript('POST', '/api/mcp/native-auth-intents', body);
        const claims = nativeClaims('nativeAuthorization.prepare', 'ezil:native-sessions:write', input);
        const { deps, consumeJti, findAccount } = nativeDeps({ procedure: 'nativeAuthorization.prepare', serializedInput: input });
        expect(await verifyDelegation(await headersFor(claims), deps)).toEqual({
            kind: 'accepted',
            caller: { userId: USER, idpIssuer: SUPABASE_ISSUER, subject: USER, clientId: CLIENT_ID, scope: 'ezil:native-sessions:write',
                procedure: 'nativeAuthorization.prepare', jti: claims.jti },
            account: { id: USER, createdAt: '2026-11-01T00:00:00.000Z' },
        });
        expect(consumeJti).toHaveBeenCalledTimes(1);
        expect(findAccount).toHaveBeenCalledWith({ issuer: 'supabase', subject: USER });
    });

    it('accepts a linked EZiL ID identity: the caller keeps the original subject and the mapped account id', async () => {
        const subject = `auth0|${randomUUID()}`;
        const pathname = `/api/mcp/native-sessions/${SESSION}`;
        const claims = nativeClaims('nativeSession.get', 'ezil:native-sessions:read', transcript('GET', pathname), { sub: subject, idp_iss: AUTH0 });
        const { deps } = nativeDeps({ procedure: 'nativeSession.get', serializedInput: transcript('GET', pathname) });
        const outcome = await verifyDelegation(await headersFor(claims), deps);
        expect(outcome).toMatchObject({ kind: 'accepted', caller: { userId: USER, idpIssuer: AUTH0, subject, procedure: 'nativeSession.get' } });
    });

    it('refuses every native scope, procedure, path selector, method or body mismatch before any ledger or account I/O', async () => {
        const getIntent = `/api/mcp/native-auth-intents/${OPERATION}`;
        const getSession = `/api/mcp/native-sessions/${SESSION}`;
        const body = JSON.stringify({ v: 1, operationId: OPERATION });
        const cases: [string, Claims, DelegationCoreDeps['binding'], string][] = [
            ['write proc with read scope', nativeClaims('nativeAuthorization.prepare', 'ezil:native-sessions:read', transcript('POST', '/api/mcp/native-auth-intents', body)),
                { procedure: 'nativeAuthorization.prepare', serializedInput: transcript('POST', '/api/mcp/native-auth-intents', body) }, 'scope'],
            ['read proc with write scope', nativeClaims('nativeSession.get', 'ezil:native-sessions:write', transcript('GET', getSession)),
                { procedure: 'nativeSession.get', serializedInput: transcript('GET', getSession) }, 'scope'],
            ['both scopes', nativeClaims('nativeSession.get', 'ezil:native-sessions:read ezil:native-sessions:write', transcript('GET', getSession)),
                { procedure: 'nativeSession.get', serializedInput: transcript('GET', getSession) }, 'scope'],
            ['procedure outside the native policy', nativeClaims('computer.list', 'ezil:computers:read', ''), { procedure: 'computer.list', serializedInput: '' }, 'scope'],
            ['caller-invented procedure', nativeClaims('nativeSession.delete', 'ezil:native-sessions:write', transcript('GET', getSession)),
                { procedure: 'nativeSession.delete', serializedInput: transcript('GET', getSession) }, 'scope'],
            ['proc vs route', nativeClaims('nativeAuthorization.get', 'ezil:native-sessions:read', transcript('GET', getSession)),
                { procedure: 'nativeSession.get', serializedInput: transcript('GET', getSession) }, 'binding'],
            ['session selector swapped', nativeClaims('nativeSession.get', 'ezil:native-sessions:read', transcript('GET', getSession)),
                { procedure: 'nativeSession.get', serializedInput: transcript('GET', `/api/mcp/native-sessions/${randomUUID()}`) }, 'binding'],
            ['operation selector swapped', nativeClaims('nativeAuthorization.get', 'ezil:native-sessions:read', transcript('GET', getIntent)),
                { procedure: 'nativeAuthorization.get', serializedInput: transcript('GET', `/api/mcp/native-auth-intents/${randomUUID()}`) }, 'binding'],
            ['method swapped', nativeClaims('nativeSession.get', 'ezil:native-sessions:read', transcript('POST', getSession)),
                { procedure: 'nativeSession.get', serializedInput: transcript('GET', getSession) }, 'binding'],
            ['body changed', nativeClaims('nativeAuthorization.prepare', 'ezil:native-sessions:write', transcript('POST', '/api/mcp/native-auth-intents', body)),
                { procedure: 'nativeAuthorization.prepare', serializedInput: transcript('POST', '/api/mcp/native-auth-intents', body.replace(OPERATION, randomUUID())) }, 'binding'],
            ['body-only digest (no transcript)', nativeClaims('nativeAuthorization.prepare', 'ezil:native-sessions:write', body),
                { procedure: 'nativeAuthorization.prepare', serializedInput: transcript('POST', '/api/mcp/native-auth-intents', body) }, 'binding'],
            ['empty GET digest (no transcript)', nativeClaims('nativeSession.get', 'ezil:native-sessions:read', ''),
                { procedure: 'nativeSession.get', serializedInput: transcript('GET', getSession) }, 'binding'],
            ['no binding', nativeClaims('nativeSession.get', 'ezil:native-sessions:read', transcript('GET', getSession)), undefined, 'binding'],
        ];
        for (const [name, claims, binding, reason] of cases) {
            const { deps, consumeJti, findAccount } = nativeDeps(binding);
            expect(await verifyDelegation(await headersFor(claims), deps), name).toEqual({ kind: 'rejected', reason });
            expect(consumeJti, name).not.toHaveBeenCalled();
            expect(findAccount, name).not.toHaveBeenCalled();
        }
    });

    it('keeps the computer digest unchanged: it hashes only the decoded input string, never a transcript', async () => {
        const input = mcpInput({ id: randomUUID() });
        const binding = delegationBinding({ method: 'GET', url: readUrl('computer.get', input), hasBody: false });
        expect(binding).toEqual({ procedure: 'computer.get', input });
        const base = { enabled: true, config, binding, now: () => Math.floor(Date.now() / 1000), consumeJti: async () => true,
            findAccount: async () => ({ id: USER, createdAt: 'x' }) };
        expect((await authenticateDelegation(await headersFor(readClaims(USER, 'computer.get', input)), base)).kind).toBe('accepted');
        const asTranscript = readClaims(USER, 'computer.get', '', { inp: inputDigest(transcript('GET', `/api/trpc/computer.get`, input)) });
        expect(await authenticateDelegation(await headersFor(asTranscript), base)).toEqual({ kind: 'rejected', reason: 'binding' });
    });

    it('accepts one jti once across policies: a native assertion reusing a computer jti is a replay', async () => {
        const ledger = new Set<string>();
        const consumeJti = vi.fn(async (jti: string) => (ledger.has(jti) ? false : (ledger.add(jti), true)));
        const findAccount = async () => ({ id: USER, createdAt: 'x' });
        const jti = randomUUID();
        const computer = await authenticateDelegation(await headersFor(readClaims(USER, 'computer.list', '', { jti })), {
            enabled: true, config, binding: { procedure: 'computer.list', input: '' }, now: () => Math.floor(Date.now() / 1000), consumeJti, findAccount });
        expect(computer.kind).toBe('accepted');
        const pathname = `/api/mcp/native-sessions/${SESSION}`;
        const native = await verifyDelegation(await headersFor(nativeClaims('nativeSession.get', 'ezil:native-sessions:read', transcript('GET', pathname), { jti })),
            nativeDeps({ procedure: 'nativeSession.get', serializedInput: transcript('GET', pathname) }, { consumeJti, findAccount }).deps);
        expect(native).toEqual({ kind: 'rejected', reason: 'replayed' });
        expect(consumeJti).toHaveBeenCalledTimes(2);
    });
});

const PG = process.env.EZIL_PG_TEST_URL;
describe.skipIf(!PG)('cross-policy one-time jti on the real 0030 ledger (disposable PostgreSQL)', () => {
    const schema = `delegation_core_test_${randomUUID().replaceAll('-', '')}`;
    const client = PG ? postgres(PG, { max: 4, prepare: false, onnotice: () => {} }) : null;
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(chunk.value.join('').replaceAll('public.', `${schema}.`)) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const db = client ? drizzle(client) : null;
    const consume = (jti: string, expiresAt: number) =>
        consumeDelegationJti({ execute: q => db!.execute(scoped(q)) as unknown as Promise<Record<string, unknown>[]> }, jti, expiresAt);
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        await client!.unsafe(readFileSync(path.resolve(__dirname, '../../../drizzle/0030_delegation_replay.sql'), 'utf8').replaceAll('public.', `${schema}.`));
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    it('a jti accepted by the computer wrapper cannot be accepted again by a native policy, even concurrently', async () => {
        const findAccount = async () => ({ id: USER, createdAt: 'x' });
        const pathname = `/api/mcp/native-sessions/${SESSION}`;
        for (const order of ['sequential', 'concurrent'] as const) {
            const jti = randomUUID();
            const computer = async () => authenticateDelegation(await headersFor(readClaims(USER, 'computer.list', '', { jti })), {
                enabled: true, config, binding: { procedure: 'computer.list', input: '' }, now: () => Math.floor(Date.now() / 1000), consumeJti: consume, findAccount });
            const native = async () => verifyDelegation(await headersFor(nativeClaims('nativeSession.get', 'ezil:native-sessions:read',
                transcript('GET', pathname), { jti })), nativeDeps({ procedure: 'nativeSession.get', serializedInput: transcript('GET', pathname) },
                { consumeJti: consume, findAccount }).deps);
            const outcomes = order === 'sequential' ? [await computer(), await native()] : await Promise.all([computer(), native()]);
            expect(outcomes.filter(o => o.kind === 'accepted'), order).toHaveLength(1);
            expect(outcomes.filter(o => o.kind === 'rejected' && o.reason === 'replayed'), order).toHaveLength(1);
            expect(await client!.unsafe(`SELECT count(*)::int AS n FROM ${schema}.ezil_delegation_replay WHERE jti = $1`, [jti])).toEqual([{ n: 1 }]);
        }
    });
});
