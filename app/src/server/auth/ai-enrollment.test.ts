import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_CREDIT_KICK_SQL } from '@/server/billing/ai-credit-outbox-store';
import { aiCreditEntitlement, aiCreditOutboxItem } from '@/server/billing/ai-credits';
import type { OutboxInsert } from '@/server/billing/ports';

vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({
    config: vi.fn(), postgres: vi.fn(), socket: vi.fn(), sharedDb: vi.fn(),
    listUsers: vi.fn(), createUser: vi.fn(), generateLink: vi.fn(), verifyOtp: vi.fn(),
}));
vi.mock('@/server/billing/config', () => ({ readBillingConfig: stub.config }));
vi.mock('postgres', () => ({ default: stub.postgres }));
vi.mock('node:net', () => ({ Socket: class { constructor() { return stub.socket(); } } }));
vi.mock('@/server/db', () => { stub.sharedDb(); throw new Error('Shared pool must not be imported'); });
vi.mock('./supabase-admin', () => ({ createAdminClient: () => ({ auth: { admin: {
    listUsers: stub.listUsers, createUser: stub.createUser, generateLink: stub.generateLink,
} } }) }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { verifyOtp: stub.verifyOtp } }) }));

import { AI_ENROLL_SQL_REFUSALS, AI_ENROLL_UNAVAILABLE, enrollAiMember, isAiEnrollRefusal } from './ai-enrollment';
import { bridgeAuth0Identity } from './bridge';

const userId = '3f2f95a1-5420-4a63-94f9-79b85a1ceeb4';
const sub = 'auth0|verified-subject';
const firstGrant = new Date('2026-10-26T00:00:00.000Z');
const narrowRole = 'ezil_os_ai_enroller';
const fixtureUrl = 'postgres://fixture:fixture@db.example.test:5432/fixture?sslmode=require';
const STAGING = 'https://ai-staging.ezil.work';
const PRODUCTION = 'https://ai.ezil.work';
const fundingHmacSecret = 'fixture-funding-hmac';
const STAGING_CALL = 'select ezil_works.enroll_ai_member($1::uuid, $2::text) as enrollment';
const PRODUCTION_CALL = 'select ezil_ai.enroll_os_member($1::uuid, $2::text) as enrollment';
const isEnrollCall = (statement: string) => statement === STAGING_CALL || statement === PRODUCTION_CALL;
/** The effective-caller ACL probe, whitespace-collapsed, naming one enrollment regprocedure. */
const probeFor = (procedure: string) => 'select exists ( select 1 from pg_catalog.pg_roles r join pg_catalog.pg_proc p'
    + ` on p.oid = pg_catalog.to_regprocedure('${procedure}') cross join lateral pg_catalog.aclexplode(p.proacl) a`
    + " where r.rolname = current_user and r.rolname = 'ezil_os_ai_enroller'"
    + ' and not (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolcanlogin)'
    + " and r.oid <> p.proowner and a.grantee = r.oid and a.privilege_type = 'EXECUTE' ) as allowed";
type Stage = 'acquire' | 'role' | 'probe' | 'enroll' | 'outbox' | 'kick' | 'enroll_commit' | 'kick_commit' | 'outbox_commit';
type ClientOptions = {
    max: number; max_pipeline: number; prepare: boolean; fetch_types: boolean; connect_timeout: number;
    socket: (address: { host: string[]; port: number[]; path?: string }) => Promise<FakeSocket>;
};
type Query = { statement: string; parameters: unknown[]; role: string; at: number };
let allowed: unknown;
let enrollment: unknown;
let receipts: Map<string, OutboxInsert>;
let kicks: string[][];
let effects: { kind: string; at: number }[];
let sockets: FakeSocket[];
let clients: FakeClient[];
let connectMode: 'normal' | 'hang' | 'error';
let closeHangs: boolean;
let removeDriverListeners: boolean;
let holdStage: Stage | undefined;
let failStage: Stage | undefined;
let releaseHeld: () => void;
let held: Promise<void>;
let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

class FakeSocket extends EventEmitter {
    host?: string;
    port?: number;
    destroyed = false;
    closed = false;
    connect = vi.fn((..._address: unknown[]) => {
        if (connectMode === 'normal') queueMicrotask(() => { if (!this.destroyed) this.emit('connect'); });
        if (connectMode === 'error') queueMicrotask(() => this.emit('error', new Error('private-connect-detail')));
        return this;
    });
    destroy = vi.fn(() => {
        this.destroyed = true;
        if (!closeHangs && !this.closed) {
            this.closed = true;
            queueMicrotask(() => this.emit('close'));
        }
        return this;
    });
}

class FakeClient {
    queries: Query[] = [];
    role = 'postgres';
    closed = false;
    enrolled = false;
    transaction = 0;
    private inTransaction = false;
    private pendingEnrollment = false;
    private pendingReceipt: OutboxInsert | undefined;
    private pendingKick: string[] | undefined;
    private connection: Promise<FakeSocket> | undefined;
    constructor(readonly options: ClientOptions) {}
    private rollback() {
        this.role = 'postgres';
        this.inTransaction = false;
        this.pendingEnrollment = false;
        this.pendingReceipt = undefined;
        this.pendingKick = undefined;
    }
    private stage(statement: string): Stage | undefined {
        if (statement === 'begin' && this.transaction === 0) return 'acquire';
        if (statement.startsWith('set local role')) return 'role';
        if (statement.includes('select exists')) return 'probe';
        if (isEnrollCall(statement)) return 'enroll';
        if (statement.startsWith('insert into')) return 'outbox';
        if (statement.startsWith('update public.ezil_billing_outbox')) return 'kick';
        if (statement === 'commit') return this.transaction === 1 ? 'enroll_commit' : this.pendingKick ? 'kick_commit' : 'outbox_commit';
    }
    unsafe = vi.fn(async (statement: string, parameters: unknown[] = []) => {
        this.queries.push({ statement, parameters, role: this.role, at: performance.now() });
        const stage = this.stage(statement);
        if (stage === 'acquire' && holdStage === 'acquire') await held;
        if (this.closed) throw new Error('client closed');
        this.connection ??= this.options.socket({ host: ['db.example.test'], port: [5432] });
        const socket = await this.connection;
        if (removeDriverListeners) socket.removeAllListeners(); // TLS wrapping removes creation-time listeners.
        if (stage && stage !== 'acquire' && stage === holdStage) await held;
        if (this.closed || socket.destroyed) throw new Error('transport closed');
        if (stage && stage === failStage) throw new Error('postgres://private:secret@host private-provider-detail');
        if (statement === 'begin') {
            if (this.inTransaction) throw new Error('nested transaction');
            this.inTransaction = true;
            this.transaction += 1;
        } else if (statement.startsWith('set local statement_timeout')) {
            if (!this.inTransaction) throw new Error('timeout outside transaction');
        } else if (statement === `set local role ${narrowRole}`) {
            if (!this.inTransaction) throw new Error('role escaped transaction');
            this.role = narrowRole;
        } else if (statement.includes('select exists')) {
            if (this.role !== narrowRole) throw new Error('caller checked before SET LOCAL ROLE');
            return [{ allowed }];
        } else if (isEnrollCall(statement)) {
            if (this.role !== narrowRole) throw new Error('enrollment used original app role');
            this.pendingEnrollment = !!enrollment && (enrollment as { ok?: unknown }).ok === true;
            return [{ enrollment }];
        } else if (statement.startsWith('insert into')) {
            if (this.role !== 'postgres' || !this.inTransaction) throw new Error('outbox used enrollment role');
            if (!statement.trim().endsWith('on conflict do nothing')) throw new Error('receipt replay may overwrite');
            // postgres.js serializes a jsonb parameter: a pre-stringified payload is stored as a jsonb string.
            if (typeof parameters[3] !== 'object' || parameters[3] === null) throw new Error('payload bound as a JSON string');
            this.pendingReceipt = {
                eventKey: parameters[0] as string, userId: parameters[1] as string, kind: parameters[2] as OutboxInsert['kind'],
                payload: parameters[3] as OutboxInsert['payload'],
            };
        } else if (statement.startsWith('update public.ezil_billing_outbox')) {
            if (this.role !== 'postgres' || !this.inTransaction) throw new Error('kick used enrollment role');
            this.pendingKick = parameters as string[];
        } else if (statement === 'commit') {
            if (this.pendingEnrollment) { this.enrolled = true; effects.push({ kind: 'enrollment', at: performance.now() }); }
            if (this.pendingReceipt && !receipts.has(this.pendingReceipt.eventKey)) {
                receipts.set(this.pendingReceipt.eventKey, this.pendingReceipt);
                effects.push({ kind: 'receipt', at: performance.now() });
            }
            if (this.pendingKick) { kicks.push(this.pendingKick); effects.push({ kind: 'kick', at: performance.now() }); }
            this.rollback();
        } else if (statement === 'rollback') this.rollback();
        else throw new Error('Unexpected SQL');
        return [];
    });
    end = vi.fn(async (_options: { timeout: number }) => {
        this.closed = true;
        this.rollback();
        if (closeHangs) await new Promise<void>(() => {});
    });
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(firstGrant);
    vi.stubEnv('SUPABASE_DATABASE_URL', fixtureUrl);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    allowed = true;
    enrollment = { ok: true, public_id: '15fe6bbf-a471-4e1c-a03b-403c503b88fe', role: 'creator', created: true };
    receipts = new Map(); kicks = []; effects = []; sockets = []; clients = [];
    connectMode = 'normal'; closeHangs = false; removeDriverListeners = false;
    holdStage = undefined; failStage = undefined;
    held = new Promise<void>(resolve => { releaseHeld = resolve; });
    stub.config.mockReturnValue({ fundingUrl: STAGING, fundingHmacSecret });
    stub.socket.mockImplementation(() => { const socket = new FakeSocket(); sockets.push(socket); return socket; });
    stub.postgres.mockImplementation((_url: string, options: ClientOptions) => {
        const client = new FakeClient(options); clients.push(client); return client;
    });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function queries() { return clients.flatMap(client => client.queries); }
/** Every console line this unit wrote, as [level, parsed line]; each must be one fixed-shape JSON string. */
function logLines() {
    return [...info.mock.calls.map(call => ['info', call] as const), ...warn.mock.calls.map(call => ['warn', call] as const)].map(([level, call]) => {
        expect(call).toHaveLength(1);
        const text = call[0] as string;
        for (const secret of [userId, sub, fixtureUrl, STAGING, PRODUCTION, 'ai.ezil.work', fundingHmacSecret, 'private']) expect(text).not.toContain(secret);
        const line = JSON.parse(text);
        expect(Object.keys(line)).toEqual(['event', 'source', 'stage', 'code']);
        return [level, line] as const;
    });
}
const enrolled = [['info', { event: 'ai-enroll', source: 'auth0', stage: 'done', code: null }]];
const refused = (stage: string, code: string) => [['warn', { event: 'ai-enroll', source: 'auth0', stage, code }]];
async function settleMicrotasks() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function mockSignIn() {
    const user = { id: userId, email: 'verified@example.test', email_confirmed_at: '2026-10-01T00:00:00Z', app_metadata: { auth0_sub: sub } };
    stub.listUsers.mockResolvedValue({ data: { users: [user] }, error: null });
    stub.generateLink.mockResolvedValue({ data: { user, properties: { hashed_token: 'fixture-otp' } }, error: null });
    stub.verifyOtp.mockResolvedValue({ data: { user, session: { access_token: 'fixture-supabase-jwt' } }, error: null });
    return () => bridgeAuth0Identity({ sub, email: user.email });
}

describe('AI enrollment with a bounded owned connection', () => {
    it.each([undefined, ''])('opens no client and logs disabled without a funding URL (%j)', async fundingUrl => {
        stub.config.mockReturnValue({ fundingUrl, fundingHmacSecret });
        await expect(enrollAiMember(userId, sub)).resolves.toEqual({ ok: false, code: 'disabled' });
        expect(stub.postgres).not.toHaveBeenCalled();
        expect(stub.socket).not.toHaveBeenCalled();
        expect(logLines()).toEqual(refused('config', 'disabled'));
    });

    it.each([
        'not a url', '/relative',
        'http://ai-staging.ezil.work', 'https://ai-staging.ezil.work:444',
        'https://ai-staging.ezil.work.attacker.test', 'https://ai-staging.ezil.work@attacker.test',
        'https://os-staging.ezil.work', 'https://ai-staging.ezil.work.',
        'http://ai.ezil.work', 'https://ai.ezil.work:444', 'https://ai.ezil.work.attacker.test',
        'https://ai.ezil.work@attacker.test', 'https://ai.ezil.work.', 'https://ai.ezil.org', 'https://x.ai.ezil.work',
        'https://os.ezil.work', 'https://ezil.work', 'wss://ai.ezil.work',
    ])('opens no client and logs origin_refused for funding URL %s', async fundingUrl => {
        stub.config.mockReturnValue({ fundingUrl, fundingHmacSecret });
        await expect(enrollAiMember(userId, sub)).resolves.toEqual({ ok: false, code: 'origin_refused' });
        expect(stub.postgres).not.toHaveBeenCalled();
        expect(stub.socket).not.toHaveBeenCalled();
        expect(logLines()).toEqual(refused('config', 'origin_refused'));
    });

    it.each([STAGING, PRODUCTION])('opens no client and logs disabled without the funding HMAC secret (%s)', async fundingUrl => {
        stub.config.mockReturnValue({ fundingUrl, fundingHmacSecret: undefined });
        await enrollAiMember(userId, sub);
        expect(stub.postgres).not.toHaveBeenCalled();
        expect(stub.socket).not.toHaveBeenCalled();
        expect(logLines()).toEqual(refused('config', 'disabled'));
    });

    it('opens no client without the existing database URL', async () => {
        vi.stubEnv('SUPABASE_DATABASE_URL', '');
        await enrollAiMember(userId, sub);
        expect(stub.postgres).not.toHaveBeenCalled();
        expect(logLines()).toEqual(refused('config', 'disabled'));
    });

    it.each([
        STAGING, `${STAGING}:443/v1/integrations/entitlements?x=1`,
        PRODUCTION, `${PRODUCTION}:443/v1/integrations/entitlements?x=1`, 'https://AI.EZIL.WORK/',
    ])('accepts the exact parsed staging or production origin for %s', async fundingUrl => {
        stub.config.mockReturnValue({ fundingUrl, fundingHmacSecret });
        await enrollAiMember(userId, sub);
        expect(clients[0].enrolled).toBe(true);
        expect(receipts.size).toBe(1);
        expect(logLines()).toEqual(enrolled);
    });

    it('uses only one owned client and bounded options while retaining URL TLS settings and socket address', async () => {
        await enrollAiMember(userId, sub);
        expect(stub.postgres).toHaveBeenCalledExactlyOnceWith(fixtureUrl, expect.objectContaining({
            max: 1, max_pipeline: 1, prepare: false, fetch_types: false, connect_timeout: 2,
        }));
        expect(stub.postgres.mock.calls[0][1]).not.toHaveProperty('ssl');
        expect(stub.sharedDb).not.toHaveBeenCalled();
        expect(sockets[0].connect).toHaveBeenCalledWith(5432, 'db.example.test');
        expect(sockets[0]).toMatchObject({ host: 'db.example.test', port: 5432, destroyed: true });
        expect(clients[0].end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    });

    it('sets the literal local role before the effective caller probe and restores app privilege before the outbox', async () => {
        await enrollAiMember(userId, sub);
        const all = queries();
        expect(all.map(query => query.statement.trim()).slice(0, 3)).toEqual([
            'begin', "set local statement_timeout = '3000ms'", `set local role ${narrowRole}`,
        ]);
        const probe = all.findIndex(query => query.statement.includes('select exists'));
        const enroll = all.findIndex(query => query.statement.startsWith('select ezil_works.enroll_ai_member'));
        const firstCommit = all.findIndex(query => query.statement === 'commit');
        const insert = all.findIndex(query => query.statement.startsWith('insert into'));
        expect(probe).toBeGreaterThan(2);
        expect(enroll).toBeGreaterThan(probe);
        expect(firstCommit).toBeGreaterThan(enroll);
        expect(insert).toBeGreaterThan(firstCommit);
        expect(all[probe].role).toBe(narrowRole);
        expect(all[enroll].role).toBe(narrowRole);
        expect(all[insert].role).toBe('postgres');
        expect(clients[0].role).toBe('postgres');
        // Enrollment, the account-wait kick and the Free receipt each commit on their own.
        expect(all.filter(query => query.statement === 'commit')).toHaveLength(3);
    });

    it('parameterizes the exact linked UUID and verified Auth0 subject', async () => {
        const hostileSub = "auth0|subject'); select 'injected";
        await enrollAiMember(userId, hostileSub);
        const enroll = queries().find(query => query.statement.startsWith('select ezil_works.enroll_ai_member'))!;
        expect(enroll.parameters).toEqual([userId, hostileSub]);
        expect(enroll.statement).toBe('select ezil_works.enroll_ai_member($1::uuid, $2::text) as enrollment');
        expect(enroll.statement).not.toContain(hostileSub);
    });

    it.each([
        { fundingUrl: STAGING, procedure: 'ezil_works.enroll_ai_member(uuid,text)', call: STAGING_CALL, other: 'ezil_ai.' },
        { fundingUrl: PRODUCTION, procedure: 'ezil_ai.enroll_os_member(uuid,text)', call: PRODUCTION_CALL, other: 'ezil_works.' },
    ])('on $fundingUrl probes and calls only that Gateway\'s routine, $procedure', async ({ fundingUrl, procedure, call, other }) => {
        stub.config.mockReturnValue({ fundingUrl, fundingHmacSecret });
        await enrollAiMember(userId, sub);
        const statements = queries().map(query => query.statement.replace(/\s+/g, ' ').trim());
        expect(statements).toEqual([
            'begin', "set local statement_timeout = '3000ms'", `set local role ${narrowRole}`, probeFor(procedure), call, 'commit',
            // Round 5 D1: the account-wait kick commits on its own, before the Free receipt.
            'begin', "set local statement_timeout = '3000ms'", AI_CREDIT_KICK_SQL.replace(/\s+/g, ' ').trim(), 'commit',
            'begin', "set local statement_timeout = '3000ms'", 'insert into public.ezil_billing_outbox (event_key, user_id, kind, payload)'
                + ' values ($1, $2::uuid, $3, $4::jsonb) on conflict do nothing', 'commit',
        ]);
        expect(statements.some(statement => statement.includes(other))).toBe(false);
        expect(clients[0].enrolled).toBe(true);
        expect(logLines()).toEqual(enrolled);
    });

    it.each([false, null, undefined, 'true'])('does not enroll without a strict successful effective caller probe: %s', async value => {
        allowed = value;
        await enrollAiMember(userId, sub);
        expect(queries().some(query => isEnrollCall(query.statement))).toBe(false);
        expect(receipts.size).toBe(0);
        expect(clients[0].role).toBe('postgres');
        expect(logLines()).toEqual(refused('probe', 'probe_failed'));
    });

    it.each([
        ...['user_not_found', 'email_unconfirmed', 'subject_mismatch', 'user_banned',
            'user_deleted', 'anonymous_user', 'public_id_collision'].map(error => [STAGING, error]),
        // Gateway 0030 adds invalid_identity and source_conflict; a public-id collision raises instead.
        ...['user_not_found', 'email_unconfirmed', 'subject_mismatch', 'user_banned',
            'user_deleted', 'anonymous_user', 'invalid_identity', 'source_conflict'].map(error => [PRODUCTION, error]),
    ])('on %s honors G4 eligibility refusal %s without creating a receipt or writing member metadata itself', async (fundingUrl, error) => {
        stub.config.mockReturnValue({ fundingUrl, fundingHmacSecret });
        enrollment = { ok: false, error };
        await enrollAiMember(userId, sub);
        expect(receipts.size).toBe(0);
        expect(clients[0].enrolled).toBe(false);
        expect(queries().some(query => /\b(update|delete|insert)\b/i.test(query.statement))).toBe(false);
        expect(logLines()).toEqual(refused('enroll', error));
    });

    it.each([
        null, {}, { ok: 'true' }, { ok: false }, { ok: false, error: 'not_in_vocabulary' }, { ok: false, error: 42 },
        { ok: false, error: 'postgres://private:secret@host private-provider-detail' },
    ])('refuses an invalid enrollment result %j and never echoes its text', async result => {
        enrollment = result;
        await enrollAiMember(userId, sub);
        expect(receipts.size).toBe(0);
        expect(logLines()).toEqual(refused('enroll', 'unknown_refusal'));
    });

    it('queues the existing Free 100 receipt after both role scope and enrollment transaction end', async () => {
        await enrollAiMember(userId, sub);
        expect([...receipts.values()]).toEqual([{
            userId, eventKey: `ezil-os:v1:free-once:${userId}:grant`, kind: 'ai_grant', payload: {
                protocol: 'ezil-ai-credits-v1', policyVersion: 1, invoiceId: null,
                entitlementId: `ezil-os:v1:free-once:${userId}`, eventId: `ezil-os:v1:free-once:${userId}:grant`,
                action: 'grant', credits: 100, expiresAt: '2027-10-26T00:00:00.000Z',
            },
        }]);
        expect(effects.map(effect => effect.kind)).toEqual(['enrollment', 'kick', 'receipt']);
    });

    it('preserves the first Free receipt on repeated/concurrent existing-member sign-ins', async () => {
        await enrollAiMember(userId, sub);
        const first = [...receipts.values()][0];
        enrollment = { ok: true, public_id: 'unchanged', role: 'operations', created: false };
        vi.setSystemTime(new Date('2026-11-26T00:00:00.000Z'));
        await Promise.all([enrollAiMember(userId, sub), enrollAiMember(userId, sub)]);
        expect([...receipts.values()]).toEqual([first]);
        expect(clients).toHaveLength(3);
        expect(effects.filter(effect => effect.kind === 'receipt')).toHaveLength(1);
        expect(clients.every(client => client.closed && client.role === 'postgres')).toBe(true);
    });

    it('deduplicates against the receipt already enqueued by the billing summary', async () => {
        const existing = aiCreditOutboxItem(userId, aiCreditEntitlement({
            userId, sku: 'free_v3', subscriptionId: null,
            periodStart: new Date('2026-09-26T00:00:00.000Z'), periodEnd: null, invoiceId: null,
        }), 'grant', null);
        receipts.set(existing.eventKey, existing);
        await enrollAiMember(userId, sub);
        expect([...receipts.values()]).toEqual([existing]);
    });

    it.each([
        ['role', 'role', 'set_role_failed'], ['probe', 'probe', 'probe_failed'], ['enroll', 'enroll', 'unknown_refusal'],
        ['enroll_commit', 'enroll', 'unknown_refusal'],
    ] as const)('rolls back local role/pending receipt on %s failure and logs one coded line (stage %s, code %s)', async (stage, logged, code) => {
        failStage = stage;
        await expect(enrollAiMember(userId, sub)).resolves.toEqual({ ok: false, code });
        expect(queries().at(-1)?.statement).toBe('rollback');
        expect(clients[0].role).toBe('postgres');
        expect(receipts.size).toBe(0);
        expect(kicks).toEqual([]);
        expect(clients[0].enrolled).toBe(false);
        expect(warn.mock.calls).toEqual([[JSON.stringify({ event: 'ai-enroll', source: 'auth0', stage: logged, code })]]);
    });

    // Review fix (r5 L1): the kick commits on its own, before and independent of the Free receipt, so a
    // receipt failure after a committed enrollment never strands rows parked on the account.
    it.each(['outbox', 'outbox_commit'] as const)('keeps the committed kick when the Free receipt fails at %s', async stage => {
        failStage = stage;
        await expect(enrollAiMember(userId, sub)).resolves.toEqual({ ok: false, code: 'enqueue_failed' });
        expect(queries().at(-1)?.statement).toBe('rollback');
        expect(clients[0].enrolled).toBe(true);
        expect(kicks).toEqual([[userId, String(firstGrant.getTime()), 'ezil-ai-credits-v1']]);
        expect(receipts.size).toBe(0);
        expect(clients[0].role).toBe('postgres');
        expect(warn.mock.calls).toEqual([[JSON.stringify({ event: 'ai-enroll', source: 'auth0', stage: 'enqueue', code: 'enqueue_failed' })]]);
    });

    it.each(['kick', 'kick_commit'] as const)('treats a %s failure as best effort: still enrolled, Free receipt still queued', async stage => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        failStage = stage;
        await expect(enrollAiMember(userId, sub)).resolves.toEqual({ ok: true });
        expect(clients[0].enrolled).toBe(true);
        expect(kicks).toEqual([]);
        expect([...receipts.keys()]).toEqual([`ezil-os:v1:free-once:${userId}:grant`]);
        expect(clients[0].role).toBe('postgres');
        expect(warn).not.toHaveBeenCalled();
        expect(info.mock.calls).toEqual([[JSON.stringify({ event: 'ai-enroll', source: 'auth0', stage: 'done', code: null })]]);
    });

    it.each(['connect', 'begin'] as const)('logs connect_failed when the owned session cannot start (%s)', async failure => {
        if (failure === 'connect') connectMode = 'error';
        else failStage = 'acquire';
        await enrollAiMember(userId, sub);
        expect(effects).toEqual([]);
        expect(queries().some(query => query.statement.startsWith('set local role'))).toBe(false);
        expect(logLines()).toEqual(refused('connect', 'connect_failed'));
    });

    it('retries the same entitlement after an outbox rollback without changing existing membership', async () => {
        failStage = 'outbox_commit';
        await enrollAiMember(userId, sub);
        expect(clients[0].enrolled).toBe(true);
        expect(receipts.size).toBe(0);
        failStage = undefined;
        enrollment = { ok: true, public_id: 'unchanged', role: 'creator', created: false };
        await enrollAiMember(userId, sub);
        expect([...receipts.keys()]).toEqual([`ezil-os:v1:free-once:${userId}:grant`]);
    });

    it('enrolls on a later sign-in a member who first signed in while funding was unset', async () => {
        const signIn = mockSignIn();
        stub.config.mockReturnValue({ fundingUrl: undefined, fundingHmacSecret: undefined });
        await expect(signIn()).resolves.toBeUndefined();
        expect(stub.postgres).not.toHaveBeenCalled();
        expect(stub.verifyOtp).toHaveBeenCalledOnce();

        stub.config.mockReturnValue({ fundingUrl: PRODUCTION, fundingHmacSecret });
        await expect(signIn()).resolves.toBeUndefined();
        enrollment = { ok: true, public_id: '15fe6bbf-a471-4e1c-a03b-403c503b88fe', role: 'creator', created: false };
        await expect(signIn()).resolves.toBeUndefined();
        expect(clients.map(client => client.enrolled)).toEqual([true, true]);
        expect(queries().filter(query => isEnrollCall(query.statement)).map(query => query.statement)).toEqual([PRODUCTION_CALL, PRODUCTION_CALL]);
        expect([...receipts.keys()]).toEqual([`ezil-os:v1:free-once:${userId}:grant`]);
        expect(stub.verifyOtp).toHaveBeenCalledTimes(3);
        expect(logLines()).toEqual([...enrolled, ...enrolled, ...refused('config', 'disabled')]);
    });

    it('bounds a stalled TCP connect to two seconds and destroys the pending transport', async () => {
        connectMode = 'hang';
        let settled = false;
        const result = enrollAiMember(userId, sub).then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await result;
        expect(sockets[0].destroyed).toBe(true);
        expect(clients[0].end).toHaveBeenCalledWith({ timeout: 0 });
        expect(effects).toEqual([]);
        expect(logLines()).toEqual(refused('connect', 'connect_failed'));
    });

    it('refuses a delayed connect callback when the monotonic deadline passed before its timer runs', async () => {
        connectMode = 'hang';
        const result = enrollAiMember(userId, sub);
        await settleMicrotasks();
        vi.spyOn(performance, 'now').mockReturnValue(5_001);
        sockets[0].emit('connect');
        await result;
        expect(sockets[0].destroyed).toBe(true);
        expect(queries().map(query => query.statement)).toEqual(['begin']);
        expect(effects).toEqual([]);
    });

    it.each(['acquire', 'role', 'probe', 'enroll', 'kick', 'outbox', 'enroll_commit', 'kick_commit', 'outbox_commit'] as const)
    ('closes before returning at the deadline and sends no late SQL after a stalled %s', async stage => {
        holdStage = stage;
        const signingIn = mockSignIn()();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(stub.generateLink).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await signingIn;
        expect(clients[0].closed).toBe(true);
        expect(sockets.every(socket => socket.destroyed)).toBe(true);
        expect(stub.verifyOtp).toHaveBeenCalledOnce();
        const dispatches = queries().length;
        const atReturn = [...effects];
        releaseHeld();
        await settleMicrotasks();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(queries()).toHaveLength(dispatches);
        expect(effects).toEqual(atReturn);
        expect(receipts.size).toBe(0);
        expect(clients[0].role).toBe('postgres');
        const at = { acquire: 'connect', role: 'role', probe: 'probe', enroll: 'enroll', kick: 'kick', outbox: 'enqueue',
            enroll_commit: 'enroll', kick_commit: 'kick', outbox_commit: 'enqueue' }[stage];
        expect(logLines()).toEqual(refused(at, 'timeout'));
    });

    it('bounds shutdown acknowledgment at six seconds even if client.end and socket close stall', async () => {
        holdStage = 'enroll'; closeHangs = true;
        let settled = false;
        const result = enrollAiMember(userId, sub).then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(5_999);
        expect(settled).toBe(false);
        expect(sockets[0].destroyed).toBe(true);
        expect(clients[0].end).toHaveBeenCalledWith({ timeout: 0 });
        await vi.advanceTimersByTimeAsync(1);
        await result;
        releaseHeld();
        await settleMicrotasks();
        expect(effects).toEqual([]);
    });

    it('destroys tracked transport after the driver removes creation-time listeners and refuses reconnect', async () => {
        holdStage = 'enroll'; removeDriverListeners = true;
        const result = enrollAiMember(userId, sub);
        await vi.advanceTimersByTimeAsync(5_000);
        await result;
        expect(sockets[0].destroyed).toBe(true);
        const created = sockets.length;
        expect(() => clients[0].options.socket({ host: ['db.example.test'], port: [5432] })).toThrow('ai_enrollment_unavailable');
        expect(sockets).toHaveLength(created);
        releaseHeld();
        await settleMicrotasks();
        expect(effects).toEqual([]);
    });

    it('refuses a second socket while a transaction is still active so reconnect cannot lose its role or transaction', async () => {
        holdStage = 'enroll';
        const result = enrollAiMember(userId, sub);
        await settleMicrotasks();
        expect(clients[0].role).toBe(narrowRole);
        expect(sockets).toHaveLength(1);
        expect(() => clients[0].options.socket({ host: ['db.example.test'], port: [5432] })).toThrow('ai_enrollment_unavailable');
        expect(sockets).toHaveLength(1);
        releaseHeld();
        await result;
        expect(clients[0].role).toBe('postgres');
    });

    it.each(['throw', 'reject'] as const)('contains an end() %s after destroying the owned transport', async failure => {
        holdStage = 'enroll';
        const signingIn = mockSignIn()();
        await settleMicrotasks();
        const error = new Error('private-shutdown-detail');
        if (failure === 'throw') clients[0].end.mockImplementationOnce(() => { throw error; });
        else clients[0].end.mockRejectedValueOnce(error);
        releaseHeld();
        await expect(signingIn).resolves.toBeUndefined();
        expect(sockets[0].destroyed).toBe(true);
        expect(stub.verifyOtp).toHaveBeenCalledOnce();
        expect(warn).not.toHaveBeenCalled();
        expect(logLines()).toEqual(enrolled);
    });

    it.each(['role', 'probe', 'enroll', 'outbox'] as const)('still mints the normal Supabase session after %s failure', async stage => {
        failStage = stage;
        await expect(mockSignIn()()).resolves.toBeUndefined();
        expect(stub.generateLink).toHaveBeenCalledOnce();
        expect(stub.verifyOtp).toHaveBeenCalledExactlyOnceWith({ type: 'magiclink', token_hash: 'fixture-otp' });
        expect(clients[0].end.mock.invocationCallOrder[0]).toBeLessThan(stub.generateLink.mock.invocationCallOrder[0]);
    });

    it('enrolls a new password-less EZiL ID (Auth0-only) member on the production origin, then mints the session', async () => {
        stub.config.mockReturnValue({ fundingUrl: PRODUCTION, fundingHmacSecret });
        const user = { id: userId, email: 'new-member@example.test', email_confirmed_at: '2026-10-26T00:00:00Z', app_metadata: { auth0_sub: sub } };
        stub.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
        stub.createUser.mockResolvedValue({ data: { user }, error: null });
        stub.generateLink.mockResolvedValue({ data: { user, properties: { hashed_token: 'fixture-otp' } }, error: null });
        stub.verifyOtp.mockResolvedValue({ data: { user, session: { access_token: 'fixture-supabase-jwt' } }, error: null });
        await expect(bridgeAuth0Identity({ sub, email: 'New-Member@example.test' })).resolves.toBeUndefined();
        expect(stub.createUser).toHaveBeenCalledExactlyOnceWith({ email: user.email, email_confirm: true, app_metadata: { auth0_sub: sub } });
        expect(stub.createUser.mock.calls[0][0]).not.toHaveProperty('password');
        const enroll = queries().find(query => isEnrollCall(query.statement))!;
        expect(enroll).toMatchObject({ statement: PRODUCTION_CALL, parameters: [userId, sub], role: narrowRole });
        expect([...receipts.keys()]).toEqual([`ezil-os:v1:free-once:${userId}:grant`]);
        expect(stub.createUser.mock.invocationCallOrder[0]).toBeLessThan(clients[0].unsafe.mock.invocationCallOrder[0]);
        expect(clients[0].end.mock.invocationCallOrder[0]).toBeLessThan(stub.generateLink.mock.invocationCallOrder[0]);
        expect(stub.verifyOtp).toHaveBeenCalledExactlyOnceWith({ type: 'magiclink', token_hash: 'fixture-otp' });
        expect(logLines()).toEqual(enrolled);
    });
});

describe('round 5 D1: coded enrollment split (enrollAiMember)', () => {
    let info: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { info = vi.spyOn(console, 'info').mockImplementation(() => {}); });
    const line = (source: string, stage: string, code: string | null) => [JSON.stringify({ event: 'ai-enroll', source, stage, code })];

    it('pins the SQL refusal vocabulary of ezil_works.enroll_ai_member and ezil_ai.enroll_os_member', () => {
        // gw-ui scripts/os-staging/sql/20_enroll_members.sql (41cc53c :62-97) returns the first seven error codes;
        // Gateway 0030 (production) adds invalid_identity and source_conflict.
        expect([...AI_ENROLL_SQL_REFUSALS]).toEqual([
            'user_not_found', 'email_unconfirmed', 'subject_mismatch', 'user_banned', 'user_deleted', 'anonymous_user', 'public_id_collision',
            'invalid_identity', 'source_conflict',
        ]);
    });

    it.each([...AI_ENROLL_SQL_REFUSALS])('returns the SQL refusal %s as its code and logs one line without identity or DB text', async code => {
        enrollment = { ok: false, error: code };
        await expect(enrollAiMember(userId, sub, 'outbox')).resolves.toEqual({ ok: false, code });
        expect(warn.mock.calls).toEqual([line('outbox', 'enroll', code)]);
        expect(info).not.toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain(userId);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(sub);
    });

    it.each([null, {}, { ok: 'true' }, { ok: false, error: 'private detail: relation does not exist' }, { ok: false }])
    ('maps an invalid or unknown function result %j to unknown_refusal', async result => {
        enrollment = result;
        await expect(enrollAiMember(userId, sub, 'auth0')).resolves.toEqual({ ok: false, code: 'unknown_refusal' });
        expect(warn.mock.calls).toEqual([line('auth0', 'enroll', 'unknown_refusal')]);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private detail');
    });

    it.each([false, null, 'true'])('maps a failed effective-caller probe (%j) to probe_failed after rolling back', async value => {
        allowed = value;
        await expect(enrollAiMember(userId, sub, 'outbox')).resolves.toEqual({ ok: false, code: 'probe_failed' });
        expect(queries().at(-1)?.statement).toBe('rollback');
        expect(warn.mock.calls).toEqual([line('outbox', 'probe', 'probe_failed')]);
    });

    it.each([['role', 'set_role_failed'], ['probe', 'probe_failed'], ['enroll', 'unknown_refusal'], ['acquire', 'connect_failed']] as const)
    ('maps a thrown %s stage to %s without logging the driver error', async (stage, code) => {
        failStage = stage;
        await expect(enrollAiMember(userId, sub, 'outbox')).resolves.toEqual({ ok: false, code });
        expect(warn.mock.calls).toHaveLength(1);
        expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ event: 'ai-enroll', source: 'outbox', code });
        expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret|postgres:\/\//);
    });

    it.each(['error', 'hang'] as const)('maps a connect %s to connect_failed', async mode => {
        connectMode = mode;
        const result = enrollAiMember(userId, sub, 'outbox');
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(result).resolves.toEqual({ ok: false, code: 'connect_failed' });
        expect(warn.mock.calls).toEqual([line('outbox', 'connect', 'connect_failed')]);
    });

    it('maps the five-second deadline to timeout at the stalled stage', async () => {
        holdStage = 'enroll';
        const result = enrollAiMember(userId, sub, 'outbox');
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(result).resolves.toEqual({ ok: false, code: 'timeout' });
        expect(warn.mock.calls).toEqual([line('outbox', 'enroll', 'timeout')]);
        releaseHeld();
    });

    it('maps the disabled configuration to disabled without opening a client', async () => {
        stub.config.mockReturnValue({ fundingUrl: 'https://ai.ezil.work' });
        await expect(enrollAiMember(userId, sub, 'outbox')).resolves.toEqual({ ok: false, code: 'disabled' });
        expect(stub.postgres).not.toHaveBeenCalled();
        expect(warn.mock.calls).toEqual([line('outbox', 'config', 'disabled')]);
    });

    it('drain enrollment: one owned client, no Free receipt, kicks the user\'s other account waits, one success line', async () => {
        await expect(enrollAiMember(userId, sub, 'outbox')).resolves.toEqual({ ok: true });
        expect(clients).toHaveLength(1);
        expect(clients[0].enrolled).toBe(true);
        expect(receipts.size).toBe(0);
        // Review fix (r5 L1): a drain enrollment also wakes sibling rows parked as needs_ezil_id.
        expect(kicks).toEqual([[userId, String(firstGrant.getTime()), 'ezil-ai-credits-v1']]);
        expect(queries().some(query => /^insert\b/.test(query.statement.trim()))).toBe(false);
        expect(effects.map(effect => effect.kind)).toEqual(['enrollment', 'kick']);
        expect(info.mock.calls).toEqual([line('outbox', 'done', null)]);
        expect(warn).not.toHaveBeenCalled();
        expect(clients[0].closed).toBe(true);
    });

    it('sign-in enrollment enqueues the Free receipt and kicks this user\'s account waits on the same client with app privileges', async () => {
        await expect(enrollAiMember(userId, sub)).resolves.toEqual({ ok: true });
        expect(clients).toHaveLength(1);
        expect(kicks).toEqual([[userId, String(firstGrant.getTime()), 'ezil-ai-credits-v1']]);
        const kick = queries().find(query => query.statement.startsWith('update public.ezil_billing_outbox'))!;
        expect(kick.role).toBe('postgres');
        // Only waiting retries on an account dependency; never processing rows; attempts untouched.
        expect(kick.statement).toMatch(/payload->'delivery'->>'status' = 'retry'/);
        expect(kick.statement).toMatch(/last_error in \('no_ai_account', 'account_not_found'\)/);
        expect(kick.statement).toMatch(/delivered_at is null/);
        expect(kick.statement).not.toMatch(/attempts/);
        expect(info.mock.calls).toEqual([line('auth0', 'done', null)]);
    });

    it.each([...AI_ENROLL_SQL_REFUSALS, 'unknown_refusal'] as const)('isAiEnrollRefusal(%s) is true', code => {
        expect(isAiEnrollRefusal(code)).toBe(true);
    });
    it.each([...AI_ENROLL_UNAVAILABLE])('isAiEnrollRefusal(%s) is false: an OS-side failure, not the member', code => {
        expect(isAiEnrollRefusal(code)).toBe(false);
    });
    it('pins all seventeen codes', () => {
        expect(AI_ENROLL_SQL_REFUSALS.length + 1 + AI_ENROLL_UNAVAILABLE.length).toBe(17);
        expect([...AI_ENROLL_UNAVAILABLE]).toEqual(['set_role_failed', 'probe_failed', 'timeout', 'connect_failed', 'enqueue_failed', 'disabled',
            'origin_refused']);
    });

    it.each([...AI_ENROLL_SQL_REFUSALS])('never kicks or enqueues after refusal %s', async code => {
        enrollment = { ok: false, error: code };
        await expect(enrollAiMember(userId, sub)).resolves.toEqual({ ok: false, code });
        expect(kicks).toEqual([]);
        expect(receipts.size).toBe(0);
    });
});
