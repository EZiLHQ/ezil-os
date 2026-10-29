import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aiCreditEntitlement, aiCreditOutboxItem } from '@/server/billing/ai-credits';
import type { OutboxInsert } from '@/server/billing/ports';

vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({
    config: vi.fn(), postgres: vi.fn(), socket: vi.fn(), sharedDb: vi.fn(),
    listUsers: vi.fn(), generateLink: vi.fn(), verifyOtp: vi.fn(),
}));
vi.mock('@/server/billing/config', () => ({ readBillingConfig: stub.config }));
vi.mock('postgres', () => ({ default: stub.postgres }));
vi.mock('node:net', () => ({ Socket: class { constructor() { return stub.socket(); } } }));
vi.mock('@/server/db', () => { stub.sharedDb(); throw new Error('Shared pool must not be imported'); });
vi.mock('./supabase-admin', () => ({ createAdminClient: () => ({ auth: { admin: {
    listUsers: stub.listUsers, generateLink: stub.generateLink,
} } }) }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { verifyOtp: stub.verifyOtp } }) }));

import { AI_ENROLL_SQL_REFUSALS, enrollAiMember, enrollStagingAiMember } from './staging-ai-enrollment';
import { bridgeAuth0Identity } from './bridge';

const userId = '3f2f95a1-5420-4a63-94f9-79b85a1ceeb4';
const sub = 'auth0|verified-subject';
const firstGrant = new Date('2026-10-26T00:00:00.000Z');
const narrowRole = 'ezil_os_ai_enroller';
const fixtureUrl = 'postgres://fixture:fixture@db.example.test:5432/fixture?sslmode=require';
type Stage = 'acquire' | 'role' | 'probe' | 'enroll' | 'outbox' | 'kick' | 'enroll_commit' | 'outbox_commit';
type ClientOptions = {
    max: number; max_pipeline: number; prepare: boolean; fetch_types: boolean; connect_timeout: number;
    socket: (address: { host: string[]; port: number[]; path?: string }) => Promise<FakeSocket>;
};
type Query = { statement: string; parameters: string[]; role: string; at: number };
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
        if (statement.startsWith('select ezil_works.enroll_ai_member')) return 'enroll';
        if (statement.startsWith('insert into')) return 'outbox';
        if (statement.startsWith('update public.ezil_billing_outbox')) return 'kick';
        if (statement === 'commit') return this.transaction === 1 ? 'enroll_commit' : 'outbox_commit';
    }
    unsafe = vi.fn(async (statement: string, parameters: string[] = []) => {
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
        } else if (statement.startsWith('select ezil_works.enroll_ai_member')) {
            if (this.role !== narrowRole) throw new Error('enrollment used original app role');
            this.pendingEnrollment = !!enrollment && (enrollment as { ok?: unknown }).ok === true;
            return [{ enrollment }];
        } else if (statement.startsWith('insert into')) {
            if (this.role !== 'postgres' || !this.inTransaction) throw new Error('outbox used enrollment role');
            if (!statement.trim().endsWith('on conflict do nothing')) throw new Error('receipt replay may overwrite');
            this.pendingReceipt = {
                eventKey: parameters[0], userId: parameters[1], kind: parameters[2] as OutboxInsert['kind'],
                payload: JSON.parse(parameters[3]),
            };
        } else if (statement.startsWith('update public.ezil_billing_outbox')) {
            if (this.role !== 'postgres' || !this.inTransaction) throw new Error('kick used enrollment role');
            this.pendingKick = parameters;
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
    allowed = true;
    enrollment = { ok: true, public_id: '15fe6bbf-a471-4e1c-a03b-403c503b88fe', role: 'creator', created: true };
    receipts = new Map(); kicks = []; effects = []; sockets = []; clients = [];
    connectMode = 'normal'; closeHangs = false; removeDriverListeners = false;
    holdStage = undefined; failStage = undefined;
    held = new Promise<void>(resolve => { releaseHeld = resolve; });
    stub.config.mockReturnValue({ fundingUrl: 'https://ai-staging.ezil.work' });
    stub.socket.mockImplementation(() => { const socket = new FakeSocket(); sockets.push(socket); return socket; });
    stub.postgres.mockImplementation((_url: string, options: ClientOptions) => {
        const client = new FakeClient(options); clients.push(client); return client;
    });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function queries() { return clients.flatMap(client => client.queries); }
async function settleMicrotasks() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function mockSignIn() {
    const user = { id: userId, email: 'verified@example.test', email_confirmed_at: '2026-10-01T00:00:00Z', app_metadata: { auth0_sub: sub } };
    stub.listUsers.mockResolvedValue({ data: { users: [user] }, error: null });
    stub.generateLink.mockResolvedValue({ data: { user, properties: { hashed_token: 'fixture-otp' } }, error: null });
    stub.verifyOtp.mockResolvedValue({ data: { user, session: { access_token: 'fixture-supabase-jwt' } }, error: null });
    return () => bridgeAuth0Identity({ sub, email: user.email });
}

describe('staging AI enrollment with a bounded owned connection', () => {
    it.each([
        undefined, '', 'not a url', '/relative', 'https://ai.ezil.work',
        'http://ai-staging.ezil.work', 'https://ai-staging.ezil.work:444',
        'https://ai-staging.ezil.work.attacker.test', 'https://ai-staging.ezil.work@attacker.test',
        'https://os-staging.ezil.work', 'https://ai-staging.ezil.work.',
    ])('opens no client for funding URL %s', async fundingUrl => {
        stub.config.mockReturnValue({ fundingUrl });
        await expect(enrollStagingAiMember(userId, sub)).resolves.toEqual({ ok: false, code: 'disabled' });
        expect(stub.postgres).not.toHaveBeenCalled();
        expect(stub.socket).not.toHaveBeenCalled();
    });

    it('opens no client without the existing database URL', async () => {
        vi.stubEnv('SUPABASE_DATABASE_URL', '');
        await enrollStagingAiMember(userId, sub);
        expect(stub.postgres).not.toHaveBeenCalled();
    });

    it.each(['https://ai-staging.ezil.work', 'https://ai-staging.ezil.work:443/v1/integrations/entitlements?x=1'])
    ('accepts the exact parsed staging origin for %s', async fundingUrl => {
        stub.config.mockReturnValue({ fundingUrl });
        await enrollStagingAiMember(userId, sub);
        expect(receipts.size).toBe(1);
    });

    it('uses only one owned client and bounded options while retaining URL TLS settings and socket address', async () => {
        await enrollStagingAiMember(userId, sub);
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
        await enrollStagingAiMember(userId, sub);
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
        expect(all.filter(query => query.statement === 'commit')).toHaveLength(2);
    });

    it('parameterizes the exact linked UUID and verified Auth0 subject', async () => {
        const hostileSub = "auth0|subject'); select 'injected";
        await enrollStagingAiMember(userId, hostileSub);
        const enroll = queries().find(query => query.statement.startsWith('select ezil_works.enroll_ai_member'))!;
        expect(enroll.parameters).toEqual([userId, hostileSub]);
        expect(enroll.statement).toBe('select ezil_works.enroll_ai_member($1::uuid, $2::text) as enrollment');
        expect(enroll.statement).not.toContain(hostileSub);
    });

    it.each([false, null, undefined, 'true'])('does not enroll without a strict successful effective caller probe: %s', async value => {
        allowed = value;
        await enrollStagingAiMember(userId, sub);
        expect(queries().some(query => query.statement.startsWith('select ezil_works.enroll_ai_member'))).toBe(false);
        expect(receipts.size).toBe(0);
        expect(clients[0].role).toBe('postgres');
    });

    it.each([
        'user_not_found', 'email_unconfirmed', 'subject_mismatch', 'user_banned',
        'user_deleted', 'anonymous_user', 'public_id_collision',
    ])('honors G4 eligibility refusal %s without creating a receipt or writing member metadata itself', async error => {
        enrollment = { ok: false, error };
        await enrollStagingAiMember(userId, sub);
        expect(receipts.size).toBe(0);
        expect(clients[0].enrolled).toBe(false);
        expect(queries().some(query => /\b(update|delete|insert)\b/i.test(query.statement))).toBe(false);
    });

    it.each([null, {}, { ok: 'true' }])('refuses an invalid enrollment result %j', async result => {
        enrollment = result;
        await enrollStagingAiMember(userId, sub);
        expect(receipts.size).toBe(0);
    });

    it('queues the existing Free 100 receipt after both role scope and enrollment transaction end', async () => {
        await enrollStagingAiMember(userId, sub);
        expect([...receipts.values()]).toEqual([{
            userId, eventKey: `ezil-os:v1:free-once:${userId}:grant`, kind: 'ai_grant', payload: {
                protocol: 'ezil-ai-credits-v1', policyVersion: 1, invoiceId: null,
                entitlementId: `ezil-os:v1:free-once:${userId}`, eventId: `ezil-os:v1:free-once:${userId}:grant`,
                action: 'grant', credits: 100, expiresAt: '2027-10-26T00:00:00.000Z',
            },
        }]);
        expect(effects.map(effect => effect.kind)).toEqual(['enrollment', 'receipt', 'kick']);
    });

    it('preserves the first Free receipt on repeated/concurrent existing-member sign-ins', async () => {
        await enrollStagingAiMember(userId, sub);
        const first = [...receipts.values()][0];
        enrollment = { ok: true, public_id: 'unchanged', role: 'operations', created: false };
        vi.setSystemTime(new Date('2026-11-26T00:00:00.000Z'));
        await Promise.all([enrollStagingAiMember(userId, sub), enrollStagingAiMember(userId, sub)]);
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
        await enrollStagingAiMember(userId, sub);
        expect([...receipts.values()]).toEqual([existing]);
    });

    it.each([
        ['role', 'role', 'set_role_failed'], ['probe', 'probe', 'probe_failed'], ['enroll', 'enroll', 'unknown_refusal'],
        ['enroll_commit', 'enroll', 'unknown_refusal'], ['outbox', 'enqueue', 'enqueue_failed'],
        ['kick', 'enqueue', 'enqueue_failed'], ['outbox_commit', 'enqueue', 'enqueue_failed'],
    ] as const)('rolls back local role/pending receipt on %s failure and logs one coded line (stage %s, code %s)', async (stage, logged, code) => {
        failStage = stage;
        await expect(enrollStagingAiMember(userId, sub)).resolves.toEqual({ ok: false, code });
        expect(queries().at(-1)?.statement).toBe('rollback');
        expect(clients[0].role).toBe('postgres');
        expect(receipts.size).toBe(0);
        expect(kicks).toEqual([]);
        expect(clients[0].enrolled).toBe(logged === 'enqueue');
        expect(warn.mock.calls).toEqual([[JSON.stringify({ event: 'ai-enroll', source: 'auth0', stage: logged, code })]]);
    });

    it('retries the same entitlement after an outbox rollback without changing existing membership', async () => {
        failStage = 'outbox_commit';
        await enrollStagingAiMember(userId, sub);
        expect(clients[0].enrolled).toBe(true);
        expect(receipts.size).toBe(0);
        failStage = undefined;
        enrollment = { ok: true, public_id: 'unchanged', role: 'creator', created: false };
        await enrollStagingAiMember(userId, sub);
        expect([...receipts.keys()]).toEqual([`ezil-os:v1:free-once:${userId}:grant`]);
    });

    it('bounds a stalled TCP connect to two seconds and destroys the pending transport', async () => {
        connectMode = 'hang';
        let settled = false;
        const result = enrollStagingAiMember(userId, sub).then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await result;
        expect(sockets[0].destroyed).toBe(true);
        expect(clients[0].end).toHaveBeenCalledWith({ timeout: 0 });
        expect(effects).toEqual([]);
    });

    it('refuses a delayed connect callback when the monotonic deadline passed before its timer runs', async () => {
        connectMode = 'hang';
        const result = enrollStagingAiMember(userId, sub);
        await settleMicrotasks();
        vi.spyOn(performance, 'now').mockReturnValue(5_001);
        sockets[0].emit('connect');
        await result;
        expect(sockets[0].destroyed).toBe(true);
        expect(queries().map(query => query.statement)).toEqual(['begin']);
        expect(effects).toEqual([]);
    });

    it.each(['acquire', 'role', 'probe', 'enroll', 'outbox', 'enroll_commit', 'outbox_commit'] as const)
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
    });

    it('bounds shutdown acknowledgment at six seconds even if client.end and socket close stall', async () => {
        holdStage = 'enroll'; closeHangs = true;
        let settled = false;
        const result = enrollStagingAiMember(userId, sub).then(() => { settled = true; });
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
        const result = enrollStagingAiMember(userId, sub);
        await vi.advanceTimersByTimeAsync(5_000);
        await result;
        expect(sockets[0].destroyed).toBe(true);
        const created = sockets.length;
        expect(() => clients[0].options.socket({ host: ['db.example.test'], port: [5432] })).toThrow('staging_enrollment_unavailable');
        expect(sockets).toHaveLength(created);
        releaseHeld();
        await settleMicrotasks();
        expect(effects).toEqual([]);
    });

    it('refuses a second socket while a transaction is still active so reconnect cannot lose its role or transaction', async () => {
        holdStage = 'enroll';
        const result = enrollStagingAiMember(userId, sub);
        await settleMicrotasks();
        expect(clients[0].role).toBe(narrowRole);
        expect(sockets).toHaveLength(1);
        expect(() => clients[0].options.socket({ host: ['db.example.test'], port: [5432] })).toThrow('staging_enrollment_unavailable');
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
    });

    it.each(['role', 'probe', 'enroll', 'outbox'] as const)('still mints the normal Supabase session after %s failure', async stage => {
        failStage = stage;
        await expect(mockSignIn()()).resolves.toBeUndefined();
        expect(stub.generateLink).toHaveBeenCalledOnce();
        expect(stub.verifyOtp).toHaveBeenCalledExactlyOnceWith({ type: 'magiclink', token_hash: 'fixture-otp' });
        expect(clients[0].end.mock.invocationCallOrder[0]).toBeLessThan(stub.generateLink.mock.invocationCallOrder[0]);
    });
});

describe('round 5 D1: coded enrollment split (enrollAiMember)', () => {
    let info: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { info = vi.spyOn(console, 'info').mockImplementation(() => {}); });
    const line = (source: string, stage: string, code: string | null) => [JSON.stringify({ event: 'ai-enroll', source, stage, code })];

    it('pins the SQL refusal vocabulary of ezil_works.enroll_ai_member', () => {
        // gw-ui scripts/os-staging/sql/20_enroll_members.sql (41cc53c :62-97) returns exactly these error codes.
        expect([...AI_ENROLL_SQL_REFUSALS]).toEqual([
            'user_not_found', 'email_unconfirmed', 'subject_mismatch', 'user_banned', 'user_deleted', 'anonymous_user', 'public_id_collision',
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

    it('enrolls only: one owned client, no Free receipt, no kick, one success line', async () => {
        await expect(enrollAiMember(userId, sub, 'outbox')).resolves.toEqual({ ok: true });
        expect(clients).toHaveLength(1);
        expect(clients[0].enrolled).toBe(true);
        expect(receipts.size).toBe(0);
        expect(kicks).toEqual([]);
        expect(queries().some(query => /^(insert|update)\b/.test(query.statement.trim()))).toBe(false);
        expect(info.mock.calls).toEqual([line('outbox', 'done', null)]);
        expect(warn).not.toHaveBeenCalled();
        expect(clients[0].closed).toBe(true);
    });

    it('sign-in enrollment enqueues the Free receipt and kicks this user\'s account waits on the same client with app privileges', async () => {
        await expect(enrollStagingAiMember(userId, sub)).resolves.toEqual({ ok: true });
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

    it.each([...AI_ENROLL_SQL_REFUSALS])('never kicks or enqueues after refusal %s', async code => {
        enrollment = { ok: false, error: code };
        await expect(enrollStagingAiMember(userId, sub)).resolves.toEqual({ ok: false, code });
        expect(kicks).toEqual([]);
        expect(receipts.size).toBe(0);
    });
});
