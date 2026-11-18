/** Disposable PostgreSQL only (`EZIL_PG_TEST_URL`); never imports the app DB or reads credentials. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PLACEMENT_LOCK_NAMESPACE, type PlacementExecutor } from '@/server/lib/compute/placement';

import type { NativeAuthorityDb } from './authority';
import { nativeTokenSha256 } from './native-authorization-candidate';
import { NATIVE_RENEW_URL, NATIVE_REVOKE_URL } from './native-authorization-exchange';
import {
    NATIVE_ABANDONED_DISPATCH_MS, dispatchNativeOperationOnce, openNativeGrantCandidate, prepareNativeRenewal, prepareNativeRevoke,
    readNativeAuthorizationOperation, reconcileNativeOperation, type NativeDispatchDeps, type ReadApprovedNativeConsentBinding,
} from './native-authorization-outbox';
import type { NativeConsentBinding } from './native-authorization-protocol';
import { approvedConsent, fixtureConfig, fixtureKeys, jsonResponse, type FixtureKeys } from './native-authorization.test-support';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `native_grant_outbox_test_${randomUUID().replaceAll('-', '')}`;
const ROOT = path.resolve(__dirname, '../../../..');
const OPS = 'public.ezil_native_authorization_operations';
const AUTHZ = 'public.ezil_native_authorizations';

/** The claim inside a subject token (test-side decoding; the signature is checked by the protocol suite). */
const claimOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, string>;

describe.skipIf(!PG)('native grant outbox on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 12, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (db: Pick<NonNullable<typeof production>, 'execute'>): PlacementExecutor => ({ execute: q => db.execute(scoped(q)) });
    const db: NativeAuthorityDb = {
        execute: q => executor(production!).execute(q),
        transaction: fn => production!.transaction(tx => fn(executor(tx))),
    };
    const rows = (q: string, ...args: unknown[]) => client!.unsafe(local(q), args as never[]);
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m));

    let created = false;
    let keys: FixtureKeys;
    beforeAll(async () => {
        keys = await fixtureKeys();
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        await client!.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated;
            ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO anon, authenticated;`);
        await client!.unsafe(local(readFileSync(path.join(ROOT, 'app/drizzle/0033_native_grant_outbox.sql'), 'utf8')));
    });
    afterAll(async () => {
        try {
            // Nothing in this module logs, on any path exercised here.
            for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
            if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        } finally { await client?.end(); }
    });

    /* A consent store standing in for the auth owner's reader, and a Gateway double with idempotent operations. */
    const consents = new Map<string, NativeConsentBinding | null>();
    // Like the real reader, it reads under the canonical computer lock of the consent's computer.
    const reader: ReadApprovedNativeConsentBinding = async (tx, key) => {
        const found = consents.get(`${key.ownerUserId}/${key.operationId}`) ?? null;
        if (found) await lockComputer(tx, found.computerId);
        return found;
    };
    const lockComputer = (tx: PlacementExecutor, computerId: string) =>
        tx.execute(sql`SELECT pg_advisory_xact_lock(${PLACEMENT_LOCK_NAMESPACE}::int4, hashtext(${computerId}::uuid::text))`);
    interface Gateway { sent: Record<string, string>[]; urls: string[]; issued: Map<string, { grantId: string; expiresAt: string }> }
    const gateway = (answer?: (claim: Record<string, string>, g: Gateway) => Response | Promise<Response> | null): Gateway & { fetchImpl: typeof fetch } => {
        const g: Gateway = { sent: [], urls: [], issued: new Map() };
        const fetchImpl = (async (url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as { subjectToken: string };
            const claim = claimOf(body.subjectToken);
            g.sent.push(claim); g.urls.push(url);
            const custom = answer?.(claim, g);
            if (custom) return custom;
            if (claim.operation === 'revoke') {
                return jsonResponse(200, { object: 'native_authorization_revocation', authorization_id: claim.authorizationId,
                    revoked_at: new Date().toISOString(), already_revoked: false });
            }
            const prior = g.issued.get(claim.operationId);
            const issued = prior ?? { grantId: randomUUID(), expiresAt: claim.leaseExpiresAt };
            g.issued.set(claim.operationId, issued);
            return jsonResponse(prior ? 200 : 201, { object: 'native_authorization_grant', grant_id: issued.grantId, expires_at: issued.expiresAt,
                authorization_id: claim.authorizationId, epoch: claim.epoch, authorization_deadline: claim.authorizationDeadline,
                budget_micro: claim.budgetMicro, replayed: Boolean(prior) });
        }) as unknown as typeof fetch;
        return { ...g, fetchImpl };
    };

    const clock = { offset: 0 };
    const now = () => Date.now() + clock.offset;
    const deps = (fetchImpl: typeof fetch, over: Partial<NativeDispatchDeps> = {}): NativeDispatchDeps =>
        ({ config: fixtureConfig(keys), readConsent: reader, now, fetchImpl, timeoutMs: 2_000, ...over });

    const consent = (over: Partial<Record<keyof NativeConsentBinding, unknown>> = {}) => {
        const c = approvedConsent(now(), over);
        const consentOperationId = randomUUID();
        consents.set(`${c.ownerUserId}/${consentOperationId}`, c);
        return { c, consentOperationId };
    };
    const renewal = (c: NativeConsentBinding, consentOperationId: string, leaseMs = 4 * 60_000) => ({ ownerUserId: c.ownerUserId,
        consentOperationId, operationId: randomUUID(), leaseExpiresAt: new Date(now() + leaseMs).toISOString() });
    const row = async (operationId: string) => (await rows(`SELECT *, row_to_json(o)::text AS whole FROM ${OPS} o WHERE operation_id = $1`, operationId))[0]!;

    it('prepares once: candidate sealed, only its hash in the tuple, no plaintext anywhere, same candidate on retry', async () => {
        const { c, consentOperationId } = consent();
        const request = renewal(c, consentOperationId);
        const first = await prepareNativeRenewal(db, deps(gateway().fetchImpl), request);
        expect(first).toMatchObject({ kind: 'prepared', status: { state: 'prepared', attempt: 0, kind: 'renew', authorizationId: c.authorizationId } });
        const stored = await row(request.operationId);
        expect(stored.whole).not.toMatch(/ezg_/);
        expect(stored.candidate_ciphertext).toHaveLength(63);
        const semantic = JSON.parse(stored.semantic) as Record<string, unknown>;
        expect(semantic).toMatchObject({ tokenSha256: stored.token_sha256, leaseExpiresAt: request.leaseExpiresAt, operationId: request.operationId });
        expect(JSON.stringify(first)).not.toMatch(/token|ciphertext|ezg_/i);
        const again = await prepareNativeRenewal(db, deps(gateway().fetchImpl), request);
        expect(again).toMatchObject({ kind: 'existing' });
        const restored = await row(request.operationId);
        expect([restored.token_sha256, restored.candidate_ciphertext]).toEqual([stored.token_sha256, stored.candidate_ciphertext]);
        // A changed request under the same operation is a conflict and writes nothing.
        expect(await prepareNativeRenewal(db, deps(gateway().fetchImpl), { ...request, leaseExpiresAt: new Date(now() + 200_000).toISOString() }))
            .toEqual({ kind: 'conflict' });
        expect(await prepareNativeRenewal(db, deps(gateway().fetchImpl), { ...request, ownerUserId: randomUUID() })).toEqual({ kind: 'conflict' });
        expect((await row(request.operationId)).updated_at).toEqual(stored.updated_at);
    });

    it('binds exactly one candidate under concurrent prepares of the same operation', async () => {
        const { c, consentOperationId } = consent();
        const request = renewal(c, consentOperationId);
        const results = await Promise.all(Array.from({ length: 8 }, () => prepareNativeRenewal(db, deps(gateway().fetchImpl), request)));
        expect(results.filter(r => r.kind === 'prepared')).toHaveLength(1);
        expect(results.filter(r => r.kind === 'existing')).toHaveLength(7);
        expect(await rows(`SELECT count(*)::int AS n FROM ${OPS} WHERE operation_id = $1`, request.operationId)).toEqual([{ n: 1 }]);
    });

    it('refuses before writing on unavailable, mismatched or out-of-window consent terms', async () => {
        const fetchImpl = gateway().fetchImpl;
        const count = async () => (await rows(`SELECT count(*)::int AS n FROM ${OPS}`))[0]!.n as number;
        const before = await count();
        const { c, consentOperationId } = consent();
        expect(await prepareNativeRenewal(db, deps(fetchImpl), renewal(c, randomUUID()))).toEqual({ kind: 'refused', reason: 'consent_unavailable' });
        // An old approved row without complete v1 terms, or one carrying anything else, is refused, never completed.
        consents.set(`${c.ownerUserId}/${consentOperationId}`, { ...c, budgetMicro: undefined } as never);
        expect(await prepareNativeRenewal(db, deps(fetchImpl), renewal(c, consentOperationId))).toEqual({ kind: 'refused', reason: 'consent_unavailable' });
        consents.set(`${c.ownerUserId}/${consentOperationId}`, { ...c, inputDigest: `sha256:${'b'.repeat(64)}` } as never);
        expect(await prepareNativeRenewal(db, deps(fetchImpl), renewal(c, consentOperationId))).toEqual({ kind: 'refused', reason: 'consent_unavailable' });
        const wrongPolicy = consent({ policyId: randomUUID() });
        expect(await prepareNativeRenewal(db, deps(fetchImpl), renewal(wrongPolicy.c, wrongPolicy.consentOperationId)))
            .toEqual({ kind: 'refused', reason: 'policy_mismatch' });
        const ended = consent({}, );
        consents.set(`${ended.c.ownerUserId}/${ended.consentOperationId}`, approvedConsent(now(), { ownerUserId: ended.c.ownerUserId }, 3_600_000, 3_600_000));
        expect(await prepareNativeRenewal(db, deps(fetchImpl), renewal(ended.c, ended.consentOperationId)))
            .toEqual({ kind: 'refused', reason: 'deadline_passed' });
        const live = consent();
        for (const leaseMs of [10_000, 5 * 60_000, -1_000]) {
            expect(await prepareNativeRenewal(db, deps(fetchImpl), renewal(live.c, live.consentOperationId, leaseMs)))
                .toEqual({ kind: 'refused', reason: 'lease_invalid' });
        }
        const short = consent({}, );
        consents.set(`${short.c.ownerUserId}/${short.consentOperationId}`, approvedConsent(now(), { ownerUserId: short.c.ownerUserId }, 60_000, 120_000));
        expect(await prepareNativeRenewal(db, deps(fetchImpl), renewal(short.c, short.consentOperationId, 4 * 60_000)))
            .toEqual({ kind: 'refused', reason: 'lease_invalid' });
        expect(await prepareNativeRenewal(db, deps(fetchImpl, { config: fixtureConfig(keys, new Date(now() - 1)) }), renewal(live.c, live.consentOperationId)))
            .toEqual({ kind: 'refused', reason: 'service_expired' });
        expect(await count()).toBe(before);
        // Same authorization, different terms: a rebinding needs a new consent.
        const bound = consent();
        expect(await prepareNativeRenewal(db, deps(fetchImpl), renewal(bound.c, bound.consentOperationId))).toMatchObject({ kind: 'prepared' });
        const slid = randomUUID();
        consents.set(`${bound.c.ownerUserId}/${slid}`, { ...bound.c, authorizationDeadline: new Date(Date.parse(bound.c.authorizationDeadline) + 60_000).toISOString() });
        expect(await prepareNativeRenewal(db, deps(fetchImpl), renewal(bound.c, slid))).toEqual({ kind: 'refused', reason: 'binding_conflict' });
    });

    it('dispatches once, binds the grant metadata, and opens exactly the sealed candidate for delivery', async () => {
        const { c, consentOperationId } = consent();
        const request = renewal(c, consentOperationId);
        const g = gateway();
        await prepareNativeRenewal(db, deps(g.fetchImpl), request);
        const outcome = await dispatchNativeOperationOnce(db, deps(g.fetchImpl), request);
        expect(outcome).toMatchObject({ kind: 'settled', status: { state: 'granted', attempt: 1, replayed: false,
            grantId: g.issued.get(request.operationId)!.grantId, grantExpiresAt: request.leaseExpiresAt } });
        expect(g.urls).toEqual([NATIVE_RENEW_URL]);
        const stored = await row(request.operationId);
        expect(g.sent[0]).toMatchObject({ operation: 'renew', operationId: request.operationId, tokenSha256: stored.token_sha256,
            leaseExpiresAt: request.leaseExpiresAt, epoch: c.epoch, budgetMicro: c.budgetMicro });
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), request)).toMatchObject({ kind: 'blocked', reason: 'not_dispatchable' });
        expect(await reconcileNativeOperation(db, deps(g.fetchImpl), request)).toMatchObject({ kind: 'blocked', reason: 'not_dispatchable' });
        expect(g.sent).toHaveLength(1);
        const opened = await openNativeGrantCandidate(db, deps(g.fetchImpl), request);
        expect(opened.kind).toBe('opened');
        if (opened.kind !== 'opened') return;
        const token = opened.bearer.authorizationHeader().slice('Bearer '.length);
        expect(nativeTokenSha256(token)).toBe(stored.token_sha256);
        // The same stored terms and hash, never re-minted or taken from the caller.
        expect(opened.tokenSha256).toBe(stored.token_sha256);
        expect(Object.keys(opened.sourceAuthorization).sort()).toEqual(['authorizationDeadline', 'authorizationId', 'budgetMicro', 'clientId',
            'epoch', 'initialApprovalAt', 'policyId', 'profileId']);
        expect(opened.sourceAuthorization).toEqual({ authorizationId: c.authorizationId, epoch: c.epoch, authorizationDeadline: c.authorizationDeadline,
            clientId: c.clientId, profileId: c.profileId, policyId: c.policyId, budgetMicro: c.budgetMicro, initialApprovalAt: c.initialApprovalAt });
        const serialized = JSON.stringify(opened);
        expect(serialized).not.toContain(token.slice(4));
        expect(JSON.parse(serialized)).toEqual({ kind: 'opened', tokenSha256: stored.token_sha256, sourceAuthorization: opened.sourceAuthorization,
            bearer: { operationId: request.operationId, grantId: opened.bearer.grantId, expiresAt: request.leaseExpiresAt } });
        const reopened = await openNativeGrantCandidate(db, deps(g.fetchImpl), request);
        expect(reopened.kind === 'opened' && reopened.bearer.authorizationHeader()).toBe(`Bearer ${token}`);
        expect(await openNativeGrantCandidate(db, deps(g.fetchImpl), { ...request, ownerUserId: randomUUID() })).toEqual({ kind: 'refused', reason: 'not_found' });
        const status = await readNativeAuthorizationOperation(db, request);
        expect(Object.keys(status!).sort()).toEqual(['alreadyRevoked', 'attempt', 'authorizationId', 'grantExpiresAt', 'grantId', 'kind',
            'leaseExpiresAt', 'operationId', 'reason', 'refusalStatus', 'replayed', 'revokedAt', 'state']);
    });

    it('keeps an unknown outcome on the original operation: no implicit resend, bounded explicit reconciliation of the same tuple', async () => {
        const { c, consentOperationId } = consent();
        const request = renewal(c, consentOperationId);
        let mode: 'down' | 'up' = 'down';
        const g = gateway(() => (mode === 'down' ? jsonResponse(503, {}) : null));
        await prepareNativeRenewal(db, deps(g.fetchImpl), request);
        const parked = renewal(c, consentOperationId); // prepared earlier, not yet sent
        await prepareNativeRenewal(db, deps(g.fetchImpl), parked);
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), request))
            .toMatchObject({ kind: 'settled', status: { state: 'delivery_unknown', reason: 'gateway_unavailable', attempt: 1 } });
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), request)).toMatchObject({ kind: 'blocked', reason: 'not_dispatchable' });
        // While the original is unknown, no other renewal of the authorization is prepared or sent.
        expect(await prepareNativeRenewal(db, deps(g.fetchImpl), renewal(c, consentOperationId)))
            .toEqual({ kind: 'refused', reason: 'unresolved_renewal' });
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), parked)).toMatchObject({ kind: 'blocked', reason: 'unresolved_renewal' });
        expect(g.sent).toHaveLength(1);
        const hash = (await row(request.operationId)).token_sha256;
        mode = 'up';
        g.issued.set(request.operationId, { grantId: randomUUID(), expiresAt: request.leaseExpiresAt }); // the lost first answer did issue
        const reconciled = await reconcileNativeOperation(db, deps(g.fetchImpl), request);
        expect(reconciled).toMatchObject({ kind: 'settled', status: { state: 'granted', attempt: 2, replayed: true } });
        const strip = (claim: Record<string, string>) => Object.fromEntries(Object.entries(claim).filter(([k]) => k !== 'issuedAt' && k !== 'expiresAt'));
        expect(strip(g.sent[1]!)).toEqual(strip(g.sent[0]!));
        expect(g.sent[1]!.tokenSha256).toBe(hash);
        // No new operation was created for the unknown one; once it is resolved, the parked renewal may go.
        expect(await rows(`SELECT count(*)::int AS n FROM ${OPS} WHERE authorization_id = $1`, c.authorizationId)).toEqual([{ n: 2 }]);
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), parked)).toMatchObject({ kind: 'settled', status: { state: 'granted' } });

        // Bounded: three attempts in all; an operation still unknown after them keeps the authorization blocked.
        const other = renewal(c, consentOperationId);
        const down = gateway(() => jsonResponse(502, {}));
        await prepareNativeRenewal(db, deps(down.fetchImpl), other);
        await dispatchNativeOperationOnce(db, deps(down.fetchImpl), other);
        await reconcileNativeOperation(db, deps(down.fetchImpl), other);
        expect(await reconcileNativeOperation(db, deps(down.fetchImpl), other)).toMatchObject({ kind: 'settled', status: { attempt: 3, state: 'delivery_unknown' } });
        expect(await reconcileNativeOperation(db, deps(down.fetchImpl), other)).toMatchObject({ kind: 'blocked', reason: 'attempts_exhausted' });
        expect(down.sent).toHaveLength(3);
        expect(new Set(down.sent.map(s => s.tokenSha256)).size).toBe(1);
        expect(await prepareNativeRenewal(db, deps(g.fetchImpl), renewal(c, consentOperationId)))
            .toEqual({ kind: 'refused', reason: 'unresolved_renewal' });
    });

    it('survives a crash after the dispatch commit: no resend, reconciliation only after the timeout, a late answer is superseded', async () => {
        const { c, consentOperationId } = consent();
        const request = renewal(c, consentOperationId);
        let release: (r: Response) => void = () => {};
        const hung = gateway((claim, g) => (g.sent.length === 1 ? new Promise<Response>(resolve => { release = resolve; }) : null));
        await prepareNativeRenewal(db, deps(hung.fetchImpl), request);
        const inFlight = dispatchNativeOperationOnce(db, deps(hung.fetchImpl), request);
        await vi.waitFor(() => expect(hung.sent).toHaveLength(1));
        expect((await row(request.operationId)).state).toBe('dispatching');
        // A "restarted" process sees the committed attempt and does not send again.
        expect(await dispatchNativeOperationOnce(db, deps(hung.fetchImpl), request)).toMatchObject({ kind: 'blocked', reason: 'not_dispatchable' });
        expect(await reconcileNativeOperation(db, deps(hung.fetchImpl), request)).toMatchObject({ kind: 'blocked', reason: 'dispatch_in_flight' });
        clock.offset = NATIVE_ABANDONED_DISPATCH_MS + 1_000;
        try {
            expect(await reconcileNativeOperation(db, deps(hung.fetchImpl), request)).toMatchObject({ kind: 'settled', status: { state: 'granted', attempt: 2 } });
        } finally { clock.offset = 0; }
        release(jsonResponse(503, {}));
        expect(await inFlight).toEqual({ kind: 'superseded' });
        expect((await row(request.operationId)).state).toBe('granted');
        expect(hung.sent).toHaveLength(2);
        // Crash BEFORE dispatch: the prepared operation simply waits; nothing was sent.
        const waiting = renewal(c, consentOperationId);
        await prepareNativeRenewal(db, deps(hung.fetchImpl), waiting);
        expect(await reconcileNativeOperation(db, deps(hung.fetchImpl), waiting)).toMatchObject({ kind: 'blocked', reason: 'not_dispatchable' });
        expect(hung.sent).toHaveLength(2);
    });

    it('reads the clock after lock waits: time spent blocked on the computer lock can end a lease before insert or send', async () => {
        const { c, consentOperationId } = consent();
        const g = gateway();
        const ready = renewal(c, consentOperationId);
        await prepareNativeRenewal(db, deps(g.fetchImpl), ready);
        const fresh = renewal(c, consentOperationId);
        let release: () => void = () => {};
        let locked: () => void = () => {};
        const held = new Promise<void>(resolve => { release = resolve; });
        const isLocked = new Promise<void>(resolve => { locked = resolve; });
        const holder = production!.transaction(async tx => { await lockComputer(executor(tx), c.computerId); locked(); await held; });
        await isLocked;
        const blockedPrepare = prepareNativeRenewal(db, deps(g.fetchImpl), fresh);
        const blockedDispatch = dispatchNativeOperationOnce(db, deps(g.fetchImpl), ready);
        await new Promise(resolve => setTimeout(resolve, 150)); // both are now waiting in the reader's lock
        clock.offset = 4 * 60_000; // the wait outlasts both leases
        try {
            release();
            await holder;
            expect(await blockedPrepare).toEqual({ kind: 'refused', reason: 'lease_invalid' });
            expect(await blockedDispatch).toMatchObject({ kind: 'blocked', reason: 'lease_ended' });
        } finally { clock.offset = 0; }
        expect(g.sent).toHaveLength(0);
        expect((await row(ready.operationId)).state).toBe('prepared');
        expect(await rows(`SELECT count(*)::int AS n FROM ${OPS} WHERE operation_id = $1`, fresh.operationId)).toEqual([{ n: 0 }]);
    });

    it('records a clean refusal as terminal and an already expired replay as a grant that delivery refuses', async () => {
        const { c, consentOperationId } = consent();
        const refused = renewal(c, consentOperationId);
        const no = gateway(() => jsonResponse(409, { error: 'native_operation_conflict' }));
        await prepareNativeRenewal(db, deps(no.fetchImpl), refused);
        expect(await dispatchNativeOperationOnce(db, deps(no.fetchImpl), refused))
            .toMatchObject({ kind: 'settled', status: { state: 'refused', refusalStatus: 409, reason: 'gateway_refused' } });
        expect(await reconcileNativeOperation(db, deps(no.fetchImpl), refused)).toMatchObject({ kind: 'blocked', reason: 'not_dispatchable' });
        const stale = renewal(c, consentOperationId);
        const replay = gateway(claim => jsonResponse(200, { object: 'native_authorization_grant', grant_id: randomUUID(),
            expires_at: new Date(now() - 1_000).toISOString(), authorization_id: claim.authorizationId, epoch: claim.epoch,
            authorization_deadline: claim.authorizationDeadline, budget_micro: claim.budgetMicro, replayed: true }));
        await prepareNativeRenewal(db, deps(replay.fetchImpl), stale);
        expect(await dispatchNativeOperationOnce(db, deps(replay.fetchImpl), stale)).toMatchObject({ kind: 'settled', status: { state: 'granted', replayed: true } });
        expect(await openNativeGrantCandidate(db, deps(replay.fetchImpl), stale)).toEqual({ kind: 'refused', reason: 'grant_expired' });
    });

    it('follows the approved consent: a changed or withdrawn consent blocks dispatch and delivery', async () => {
        const { c, consentOperationId } = consent();
        const g = gateway();
        const granted = renewal(c, consentOperationId);
        const pending = renewal(c, consentOperationId);
        await prepareNativeRenewal(db, deps(g.fetchImpl), granted);
        await prepareNativeRenewal(db, deps(g.fetchImpl), pending);
        await dispatchNativeOperationOnce(db, deps(g.fetchImpl), granted);
        const key = `${c.ownerUserId}/${consentOperationId}`;
        consents.set(key, { ...c, budgetMicro: '99000000' });
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), pending)).toMatchObject({ kind: 'blocked', reason: 'consent_changed' });
        expect(await openNativeGrantCandidate(db, deps(g.fetchImpl), granted)).toEqual({ kind: 'refused', reason: 'consent_changed' });
        consents.set(key, null);
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), pending)).toMatchObject({ kind: 'blocked', reason: 'consent_unavailable' });
        expect(await openNativeGrantCandidate(db, deps(g.fetchImpl), granted)).toEqual({ kind: 'refused', reason: 'consent_unavailable' });
        // The same approved terms again: the pending renewal proceeds unchanged.
        consents.set(key, { ...c, placement: { ...c.placement } });
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), pending)).toMatchObject({ kind: 'settled', status: { state: 'granted' } });
        expect(g.sent).toHaveLength(2);
    });

    it('fails closed on ciphertext tamper and on a rotated or substituted wrapping key', async () => {
        const { c, consentOperationId } = consent();
        const request = renewal(c, consentOperationId);
        const g = gateway();
        await prepareNativeRenewal(db, deps(g.fetchImpl), request);
        await dispatchNativeOperationOnce(db, deps(g.fetchImpl), request);
        const rotated = await fixtureKeys('grant-wrap-test-2');
        expect(await openNativeGrantCandidate(db, deps(g.fetchImpl, { config: fixtureConfig(keys, undefined, rotated.wrapping) }), request))
            .toEqual({ kind: 'refused', reason: 'wrapping_key_unavailable' });
        expect(await openNativeGrantCandidate(db, deps(g.fetchImpl, { config: fixtureConfig(keys, undefined, { keyId: keys.wrapping.keyId, key: rotated.wrapping.key }) }), request))
            .toEqual({ kind: 'refused', reason: 'candidate_invalid' });
        // Tamper below the guard (a superuser could): the AEAD still refuses.
        await rows(`ALTER TABLE ${OPS} DISABLE TRIGGER ezil_native_authorization_operations_guard_rows`);
        try {
            await rows(`UPDATE ${OPS} SET candidate_ciphertext = overlay(candidate_ciphertext placing '\\x00'::bytea from 5 for 1) WHERE operation_id = $1`, request.operationId);
            expect(await openNativeGrantCandidate(db, deps(g.fetchImpl), request)).toEqual({ kind: 'refused', reason: 'candidate_invalid' });
        } finally {
            await rows(`ALTER TABLE ${OPS} ENABLE TRIGGER ezil_native_authorization_operations_guard_rows`);
        }
        // A swapped candidate from another operation fails its additional data.
        const otherRequest = renewal(c, consentOperationId);
        await prepareNativeRenewal(db, deps(g.fetchImpl), otherRequest);
        await rows(`ALTER TABLE ${OPS} DISABLE TRIGGER ezil_native_authorization_operations_guard_rows`);
        try {
            await rows(`UPDATE ${OPS} t SET candidate_nonce = s.candidate_nonce, candidate_ciphertext = s.candidate_ciphertext
                FROM ${OPS} s WHERE t.operation_id = $1 AND s.operation_id = $2`, request.operationId, otherRequest.operationId);
            expect(await openNativeGrantCandidate(db, deps(g.fetchImpl), request)).toEqual({ kind: 'refused', reason: 'candidate_invalid' });
        } finally {
            await rows(`ALTER TABLE ${OPS} ENABLE TRIGGER ezil_native_authorization_operations_guard_rows`);
        }
    });

    it('revokes terminally: no renewal is prepared, sent, reconciled or opened afterwards, even while the revoke is unknown', async () => {
        const { c, consentOperationId } = consent();
        const g = gateway();
        const granted = renewal(c, consentOperationId);
        const pending = renewal(c, consentOperationId);
        await prepareNativeRenewal(db, deps(g.fetchImpl), granted);
        await prepareNativeRenewal(db, deps(g.fetchImpl), pending);
        await dispatchNativeOperationOnce(db, deps(g.fetchImpl), granted);
        const revoke = { ownerUserId: c.ownerUserId, consentOperationId, operationId: randomUUID(), authorizationId: c.authorizationId };
        expect(await prepareNativeRevoke(db, deps(g.fetchImpl), revoke)).toMatchObject({ kind: 'prepared', status: { kind: 'revoke', state: 'prepared' } });
        expect(await prepareNativeRevoke(db, deps(g.fetchImpl), revoke)).toMatchObject({ kind: 'existing' });
        expect(await prepareNativeRevoke(db, deps(g.fetchImpl), { ...revoke, operationId: randomUUID() }))
            .toEqual({ kind: 'already_revoking', revokeOperationId: revoke.operationId });
        expect(await openNativeGrantCandidate(db, deps(g.fetchImpl), granted)).toEqual({ kind: 'refused', reason: 'authorization_revoked' });
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), pending)).toMatchObject({ kind: 'blocked', reason: 'authorization_revoked' });
        expect(await prepareNativeRenewal(db, deps(g.fetchImpl), renewal(c, consentOperationId))).toEqual({ kind: 'refused', reason: 'authorization_revoked' });
        const lost = gateway(() => jsonResponse(504, {}));
        expect(await dispatchNativeOperationOnce(db, deps(lost.fetchImpl), revoke)).toMatchObject({ kind: 'settled', status: { state: 'delivery_unknown' } });
        expect(lost.urls).toEqual([NATIVE_REVOKE_URL]);
        expect(lost.sent[0]).not.toHaveProperty('tokenSha256');
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), pending)).toMatchObject({ kind: 'blocked', reason: 'authorization_revoked' });
        // Revoke reconciliation needs no live consent.
        consents.set(`${c.ownerUserId}/${consentOperationId}`, null);
        expect(await reconcileNativeOperation(db, deps(g.fetchImpl), revoke)).toMatchObject({ kind: 'settled', status: { state: 'revoked', alreadyRevoked: false } });
        expect(await openNativeGrantCandidate(db, deps(g.fetchImpl), granted)).toEqual({ kind: 'refused', reason: 'authorization_revoked' });
        // History is kept: every operation of the authorization is still there.
        expect(await rows(`SELECT count(*)::int AS n FROM ${OPS} WHERE authorization_id = $1`, c.authorizationId)).toEqual([{ n: 3 }]);

        // An authorization never renewed here is bound from the reader, so the Gateway records a revoked tombstone.
        const fresh = consent();
        const tombstone = { ownerUserId: fresh.c.ownerUserId, consentOperationId: fresh.consentOperationId, operationId: randomUUID(),
            authorizationId: fresh.c.authorizationId };
        expect(await prepareNativeRevoke(db, deps(g.fetchImpl), tombstone)).toMatchObject({ kind: 'prepared' });
        expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), tombstone)).toMatchObject({ kind: 'settled', status: { state: 'revoked' } });
        expect(await prepareNativeRenewal(db, deps(g.fetchImpl), renewal(fresh.c, fresh.consentOperationId)))
            .toEqual({ kind: 'refused', reason: 'authorization_revoked' });
    });

    it('refuses a renew row missing any candidate field, and a revoke row carrying one (no NULL slips past the CHECK)', async () => {
        const { c, consentOperationId } = consent();
        const request = renewal(c, consentOperationId);
        await prepareNativeRenewal(db, deps(gateway().fetchImpl), request);
        const copy = (override: Record<string, unknown>) => rows(`INSERT INTO ${OPS} SELECT (jsonb_populate_record(o,
            jsonb_build_object('operation_id', gen_random_uuid(), 'token_sha256', md5(random()::text) || md5(random()::text)) || $2::jsonb)).*
            FROM ${OPS} o WHERE operation_id = $1`, request.operationId, JSON.stringify(override));
        await copy({}); // the control: an otherwise identical row is accepted
        for (const field of ['lease_expires_at', 'token_sha256', 'candidate_version', 'candidate_key_id', 'candidate_nonce', 'candidate_ciphertext']) {
            await expect(copy({ [field]: null })).rejects.toMatchObject({ code: '23514' });
        }
        await expect(copy({ candidate_version: 2 })).rejects.toMatchObject({ code: '23514' });
        await expect(copy({ kind: 'revoke' })).rejects.toMatchObject({ code: '23514' });
        await expect(copy({ kind: 'revoke', lease_expires_at: null, token_sha256: null, candidate_version: null, candidate_key_id: null,
            candidate_nonce: null })).rejects.toMatchObject({ code: '23514' });
    });

    it('keeps one lock order with a reader under the computer lock and an owner STOP that revokes under it', async () => {
        const { c, consentOperationId } = consent();
        const g = gateway();
        const granted = renewal(c, consentOperationId);
        await prepareNativeRenewal(db, deps(g.fetchImpl), granted);
        await dispatchNativeOperationOnce(db, deps(g.fetchImpl), granted);
        const pending = await Promise.all(Array.from({ length: 4 }, async () => {
            const r = renewal(c, consentOperationId);
            await prepareNativeRenewal(db, deps(g.fetchImpl), r);
            return r;
        }));
        const revoke = { ownerUserId: c.ownerUserId, consentOperationId, operationId: randomUUID(), authorizationId: c.authorizationId };
        // The auth owner's STOP: computer lock first, then the revoke in the same transaction, committed before any send.
        const stop = production!.transaction(async tx => {
            const inner = executor(tx);
            await lockComputer(inner, c.computerId);
            await new Promise(resolve => setTimeout(resolve, 50));
            return prepareNativeRevoke({ ...inner, transaction: fn => fn(inner) }, deps(g.fetchImpl), revoke);
        });
        const results = await Promise.allSettled([stop, ...pending.map(r => dispatchNativeOperationOnce(db, deps(g.fetchImpl), r)),
            openNativeGrantCandidate(db, deps(g.fetchImpl), granted), openNativeGrantCandidate(db, deps(g.fetchImpl), granted)]);
        expect(results.filter(r => r.status === 'rejected')).toEqual([]);
        expect((results[0] as PromiseFulfilledResult<unknown>).value).toMatchObject({ kind: 'prepared' });
        // Each racing renewal went out before the STOP, waited behind another one in flight, or is blocked by the STOP.
        for (const r of results.slice(1, 5)) {
            const value = (r as PromiseFulfilledResult<{ kind: string; reason?: string }>).value;
            expect(value.kind === 'settled' || ['authorization_revoked', 'unresolved_renewal'].includes(value.reason ?? '')).toBe(true);
        }
        for (const r of pending) {
            if ((await row(r.operationId)).state === 'prepared') {
                expect(await dispatchNativeOperationOnce(db, deps(g.fetchImpl), r)).toMatchObject({ reason: 'authorization_revoked' });
            }
        }
    });

    it('guards history in SQL: no delete, truncate, identity change, illegal transition or second revoke; no public grant', async () => {
        const { c, consentOperationId } = consent();
        const request = renewal(c, consentOperationId);
        await prepareNativeRenewal(db, deps(gateway().fetchImpl), request);
        const refuses = async (q: string, ...args: unknown[]) => expect(rows(q, ...args)).rejects.toMatchObject({ code: '23001' });
        await refuses(`DELETE FROM ${OPS} WHERE operation_id = $1`, request.operationId);
        await refuses(`TRUNCATE ${OPS}`);
        await refuses(`DELETE FROM ${AUTHZ} WHERE authorization_id = $1`, c.authorizationId);
        await refuses(`UPDATE ${OPS} SET token_sha256 = repeat('0', 64) WHERE operation_id = $1`, request.operationId);
        await refuses(`UPDATE ${OPS} SET state = 'granted', grant_id = gen_random_uuid(), grant_expires_at = now(), grant_replayed = false
            WHERE operation_id = $1`, request.operationId);
        await refuses(`UPDATE ${AUTHZ} SET binding = '{}' WHERE authorization_id = $1`, c.authorizationId);
        await rows(`UPDATE ${AUTHZ} SET revoke_operation_id = gen_random_uuid(), revoke_requested_at = now() WHERE authorization_id = $1`, c.authorizationId);
        await refuses(`UPDATE ${AUTHZ} SET revoke_operation_id = gen_random_uuid() WHERE authorization_id = $1`, c.authorizationId);
        const privileges = await rows(`SELECT count(*)::int AS n FROM information_schema.role_table_grants
            WHERE table_schema = $1 AND grantee IN ('anon', 'authenticated', 'PUBLIC')`, schema);
        expect(privileges).toEqual([{ n: 0 }]);
        expect(await rows(`SELECT bool_and(relrowsecurity) AS rls FROM pg_class WHERE relnamespace = $1::regnamespace
            AND relname IN ('ezil_native_authorizations', 'ezil_native_authorization_operations')`, schema)).toEqual([{ rls: true }]);
    });
});
