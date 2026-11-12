import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SocketDouble {
    readyState: string;
    destroyed: boolean;
    closed: boolean;
    writes: Buffer[];
    onWrite?: (data: Buffer) => void;
    destroy(): SocketDouble;
    emit(event: string, ...args: unknown[]): boolean;
    connectNow(): void;
    closeNow(): void;
}

const transport = vi.hoisted(() => ({ sockets: [] as SocketDouble[] }));
vi.mock('server-only', () => ({}));
// Keep postgres.js real. Only the helper's owned transport is simulated; no
// operating-system socket, network endpoint or PostgreSQL server is created.
vi.mock('node:net', async () => {
    const { EventEmitter } = await import('node:events');
    return { Socket: class extends EventEmitter implements SocketDouble {
        readyState = 'opening';
        destroyed = false;
        closed = false;
        writes: Buffer[] = [];
        onWrite?: (data: Buffer) => void;
        constructor() { super(); transport.sockets.push(this); }
        connect() { return this; }
        connectNow() { this.readyState = 'open'; this.emit('connect'); }
        setKeepAlive() { return this; }
        write(data: Uint8Array) {
            const bytes = Buffer.from(data);
            this.writes.push(bytes);
            this.onWrite?.(bytes);
            return true;
        }
        end(data?: Uint8Array) { if (data) this.write(data); return this.destroy(); }
        destroy() {
            if (!this.destroyed) {
                this.destroyed = true;
                this.readyState = 'closed';
                queueMicrotask(() => this.closeNow());
            }
            return this;
        }
        closeNow() {
            if (this.closed) return;
            this.destroyed = this.closed = true;
            this.readyState = 'closed';
            this.emit('close', false);
        }
    } };
});

import { aiCreditEntitlement, aiCreditOutboxItem } from '@/server/billing/ai-credits';
import { enrollStagingAiMember } from './staging-ai-enrollment';

const userId = '3f2f95a1-5420-4a63-94f9-79b85a1ceeb4';
const subject = 'auth0|offline-driver-fixture';

function frame(type: string, payload: Buffer) {
    const bytes = Buffer.alloc(5 + payload.length);
    bytes.write(type, 0);
    bytes.writeInt32BE(4 + payload.length, 1);
    payload.copy(bytes, 5);
    return bytes;
}
const ready = (status = 'I') => frame('Z', Buffer.from(status));
const complete = (command: string) => frame('C', Buffer.from(`${command}\0`));

const OID = { bool: 16, bigint: 20, int4: 23, text: 25, uuid: 2950, jsonb: 3802 } as const;
type Bound = { statement: string; types: number[]; values: (string | null)[] };

/**
 * A minimal PostgreSQL backend for the real driver. It answers the extended protocol as PostgreSQL
 * does, including the parameter types it infers from the statement (`$4::jsonb` is 3802; an uncast
 * parameter compared with or stored into text is 25), and records each Bind's text values exactly as
 * PostgreSQL's input functions would receive them.
 */
function serve(socket: SocketDouble, starter?: { eventKey: string; payload: Record<string, unknown>; stallAt?: string }) {
    const bound: Bound[] = [];
    const out: Buffer[] = [];
    let statement = '';
    let types: number[] = [];
    let inTransaction = false;
    const inferred = (sql: string, n: number) => {
        const cast = new RegExp(`\\$${n}(?!\\d)::(\\w+)`).exec(sql)?.[1];
        return cast === 'uuid' ? OID.uuid : cast === 'jsonb' ? OID.jsonb : cast === 'bigint' ? OID.bigint : OID.text;
    };
    // `starter` answers the scoped delivery on the same connection: the claimed Free row, its Works account, and the pin.
    const columns = (sql: string): [name: string, type: number, value: string][] | null =>
        sql.includes('select exists') ? [['allowed', OID.bool, 't']]
            : sql.includes('enroll_ai_member') ? [['enrollment', OID.jsonb, '{"ok":true}']]
                : starter && sql.includes('skip locked') ? [['id', OID.uuid, '6b1c2a54-0000-4000-8000-000000000001'], ['eventKey', OID.text, starter.eventKey],
                    ['userId', OID.uuid, userId], ['kind', OID.text, 'ai_grant'], ['payload', OID.jsonb, JSON.stringify({ ...starter.payload, delivery: { status: 'processing', nextAttemptAt: 1, leaseToken: 'lease' } })],
                    ['attempts', OID.int4, '1'], ['dependencyWaits', OID.int4, '0'], ['exhausted', OID.bool, 'f']]
                    : starter && sql.includes('ezil_works.ai_members') ? [['public_id', OID.text, 'works-public-id']]
                        : starter && sql.includes('jsonb_set(payload, \'{accountPublicId}\'') ? [['id', OID.uuid, '6b1c2a54-0000-4000-8000-000000000001']]
                            : null;
    const int16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
    const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
    const flush = () => {
        const data = Buffer.concat(out.splice(0));
        if (data.length) queueMicrotask(() => socket.emit('data', data));
    };
    const rowDescription = (cols: [string, number, string][]) => frame('T', Buffer.concat([int16(cols.length),
        ...cols.map(([name, oid]) => Buffer.concat([Buffer.from(`${name}\0`), int32(0), int16(0), int32(oid), int16(-1), int32(-1), int16(0)]))]));
    const execute = () => {
        const cols = columns(statement);
        if (cols) out.push(frame('D', Buffer.concat([int16(cols.length),
            ...cols.map(([, , value]) => Buffer.concat([int32(Buffer.byteLength(value)), Buffer.from(value)]))])));
        const verb = statement.trim().split(/\s+/)[0]!.toUpperCase();
        if (verb === 'BEGIN') inTransaction = true;
        if (verb === 'COMMIT' || verb === 'ROLLBACK') inTransaction = false;
        out.push(complete({ INSERT: 'INSERT 0 1', UPDATE: 'UPDATE 0', SELECT: 'SELECT 1' }[verb] ?? verb));
    };
    socket.onWrite = data => {
        if (data.length >= 8 && data.readInt32BE(4) === 196608) return; // StartupMessage (protocol 3.0) has no type byte.
        for (let at = 0; at < data.length;) {
            const type = String.fromCharCode(data[at]!);
            const body = data.subarray(at + 5, at + 1 + data.readInt32BE(at + 1));
            at += 1 + data.readInt32BE(at + 1);
            if (type === 'Q') { // Simple query: postgres.js sends a parameterless unsafe() this way.
                statement = body.toString('utf8', 0, body.indexOf(0));
                const cols = columns(statement);
                if (cols) out.push(rowDescription(cols));
                execute();
                out.push(ready(inTransaction ? 'T' : 'I'));
                flush();
            } else if (type === 'P') {
                const nameEnd = body.indexOf(0);
                const end = body.indexOf(0, nameEnd + 1);
                statement = body.toString('utf8', nameEnd + 1, end);
                types = Array.from({ length: body.readInt16BE(end + 1) },
                    (_, i) => body.readInt32BE(end + 3 + i * 4) || inferred(statement, i + 1));
                out.push(frame('1', Buffer.alloc(0)));
            } else if (type === 'D') {
                out.push(frame('t', Buffer.concat([int16(types.length), ...types.map(int32)])));
                const cols = columns(statement);
                out.push(cols ? rowDescription(cols) : frame('n', Buffer.alloc(0)));
            } else if (type === 'B') {
                let i = body.indexOf(0, body.indexOf(0) + 1) + 1;
                i += 2 + body.readInt16BE(i) * 2; // parameter format codes
                const values: (string | null)[] = [];
                for (let n = body.readInt16BE(i), k = 0, p = i + 2; k < n; k++) {
                    const length = body.readInt32BE(p);
                    values.push(length < 0 ? null : body.toString('utf8', p + 4, p + 4 + length));
                    p += 4 + Math.max(length, 0);
                }
                bound.push({ statement, types, values });
                out.push(frame('2', Buffer.alloc(0)));
            } else if (type === 'E') {
                execute();
            } else if (type === 'S') {
                if (starter?.stallAt && statement.includes(starter.stallAt)) continue; // The backend goes quiet mid-delivery.
                out.push(ready(inTransaction ? 'T' : 'I'));
                flush();
            } else if (type === 'H') {
                if (starter?.stallAt && statement.includes(starter.stallAt)) continue;
                flush();
            }
        }
    };
    return bound;
}

beforeEach(() => {
    vi.useFakeTimers();
    transport.sockets = [];
    vi.stubEnv('SUPABASE_DATABASE_URL', 'postgres://fixture:fixture@fixture.invalid:5432/postgres?sslmode=disable');
    vi.stubEnv('BILLING_FUNDING_URL', 'https://ai-staging.ezil.work');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function start() {
    let settled = false;
    const signingIn = enrollStagingAiMember(userId, subject).then(() => { settled = true; });
    // postgres.js schedules the first connect through its own reconnect timer.
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.sockets).toHaveLength(1);
    return { socket: transport.sockets[0], signingIn, settled: () => settled };
}

describe('installed postgres.js enrollment transport lifetime', () => {
    it('destroys a pending TCP connect and refuses a late connect callback', async () => {
        const run = await start();
        expect(run.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(2_010);
        await run.signingIn;
        expect(run.socket.destroyed).toBe(true);
        expect(run.socket.closed).toBe(true);
        expect(run.socket.writes).toHaveLength(0);

        // Model a connection completion queued before the socket was destroyed.
        run.socket.connectNow();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(transport.sockets).toHaveLength(1);
        expect(run.socket.writes).toHaveLength(0);
    });

    it('closes an established transport whose PostgreSQL startup handshake stalls', async () => {
        const run = await start();
        run.socket.connectNow();
        await vi.advanceTimersByTimeAsync(1);
        expect(run.socket.writes).toHaveLength(1); // Startup packet, no SQL yet.
        expect(run.settled()).toBe(false);

        await vi.advanceTimersByTimeAsync(2_010);
        await run.signingIn;
        expect(run.socket.destroyed).toBe(true);
        const writesAtReturn = run.socket.writes.length;
        run.socket.emit('data', ready());
        await vi.advanceTimersByTimeAsync(10_000);
        expect(transport.sockets).toHaveLength(1);
        expect(run.socket.writes).toHaveLength(writesAtReturn);
    });

    it('rejects connect completion after the monotonic deadline before the timer callback runs', async () => {
        const run = await start();
        // Model an event-loop delay: the clock has passed the deadline, but its
        // timer callback has not run when the queued connect event is handled.
        vi.spyOn(performance, 'now').mockReturnValue(5_001);
        run.socket.connectNow();
        await vi.advanceTimersByTimeAsync(2_010);
        await run.signingIn;
        expect(run.socket.destroyed).toBe(true);
        expect(run.socket.writes).toHaveLength(0);
        expect(transport.sockets).toHaveLength(1);
    });

    it('destroys the real driver’s pending BEGIN at the total deadline with no late SQL', async () => {
        const run = await start();
        run.socket.connectNow();
        await vi.advanceTimersByTimeAsync(1);
        run.socket.emit('data', ready());
        await vi.advanceTimersByTimeAsync(1);
        expect(run.socket.writes.map(buffer => buffer.toString()).join('')).toContain('begin');
        expect(run.settled()).toBe(false);

        await vi.advanceTimersByTimeAsync(5_010);
        await run.signingIn;
        expect(run.socket.destroyed).toBe(true);
        const writesAtReturn = run.socket.writes.length;
        run.socket.emit('data', Buffer.concat([complete('BEGIN'), ready('T')]));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(transport.sockets).toHaveLength(1);
        expect(run.socket.writes).toHaveLength(writesAtReturn);
        expect(run.socket.writes.map(buffer => buffer.toString()).join('')).not.toContain('set local');
    });

    it('refuses driver reconnection after losing the physical transaction connection', async () => {
        const run = await start();
        run.socket.connectNow();
        await vi.advanceTimersByTimeAsync(1);
        run.socket.emit('data', ready());
        await vi.advanceTimersByTimeAsync(1);
        run.socket.emit('data', Buffer.concat([complete('BEGIN'), ready('T')]));
        // The next statement must not migrate to a new session where BEGIN and
        // SET LOCAL ROLE would have been lost. Close before its continuation.
        run.socket.closeNow();
        const writesAtClose = run.socket.writes.length;
        await vi.advanceTimersByTimeAsync(6_010);
        await run.signingIn;
        expect(transport.sockets).toHaveLength(1);
        expect(run.socket.writes).toHaveLength(writesAtClose);
        expect(run.socket.writes.map(buffer => buffer.toString()).join('')).not.toContain('set local');
    });
});

describe('installed postgres.js serialization of the sign-in Free receipt', () => {
    it('binds the payload so PostgreSQL stores a jsonb object the outbox can claim, not a jsonb string', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => {});
        vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
        const signingIn = enrollStagingAiMember(userId, subject);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.sockets).toHaveLength(1);
        const bound = serve(transport.sockets[0]!);
        transport.sockets[0]!.connectNow();
        await vi.advanceTimersByTimeAsync(1);
        transport.sockets[0]!.emit('data', ready());
        await vi.advanceTimersByTimeAsync(100);
        await expect(signingIn).resolves.toEqual({ ok: true });

        const inserts = bound.filter(bind => bind.statement.startsWith('insert into public.ezil_billing_outbox'));
        expect(inserts).toHaveLength(1);
        const [{ types, values }] = inserts as [Bound];
        expect(types).toEqual([OID.text, OID.uuid, OID.text, OID.jsonb]);
        expect(values.slice(0, 3)).toEqual([`ezil-os:v1:free-once:${userId}:grant`, userId, 'ai_grant']);
        // jsonb input parses this text: a JSON object here is jsonb_typeof 'object', whose
        // payload->>'protocol' the outbox claim matches. A JSON string here never delivers.
        const stored: unknown = JSON.parse(values[3]!);
        expect(stored).toEqual({
            protocol: 'ezil-ai-credits-v1', policyVersion: 1, invoiceId: null,
            entitlementId: `ezil-os:v1:free-once:${userId}`, eventId: `ezil-os:v1:free-once:${userId}:grant`,
            action: 'grant', credits: 10, expiresAt: expect.stringMatching(/^2027-11-05T12:00:00\.\d{3}Z$/),
        });
        // The kick before it keeps its typed text parameters.
        const kick = bound.find(bind => bind.statement.startsWith('update public.ezil_billing_outbox'))!;
        expect(kick.types).toEqual([OID.uuid, OID.bigint, OID.text]);
        expect([kick.values[0], kick.values[2]]).toEqual([userId, 'ezil-ai-credits-v1']);
    });
});

describe('installed postgres.js: the scoped starter delivery on the enrollment\'s own connection', () => {
    const item = aiCreditOutboxItem(userId, aiCreditEntitlement({ userId, sku: 'free_v3', subscriptionId: null,
        periodStart: new Date('2026-11-05T12:00:00.000Z'), periodEnd: null, invoiceId: null }), 'grant', null);

    async function signIn(fetcher: ReturnType<typeof vi.fn>, stallAt?: string) {
        vi.stubEnv('BILLING_FUNDING_HMAC_SECRET', 'driver-fixture-secret');
        vi.stubGlobal('fetch', fetcher);
        vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
        const signingIn = enrollStagingAiMember(userId, subject);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.sockets).toHaveLength(1);
        const bound = serve(transport.sockets[0]!, { eventKey: item.eventKey, payload: item.payload, ...(stallAt ? { stallAt } : {}) });
        transport.sockets[0]!.connectNow();
        await vi.advanceTimersByTimeAsync(1);
        transport.sockets[0]!.emit('data', ready());
        return { bound, signingIn };
    }

    it('claims exactly the user\'s Free grant, pins the account, sends the 2 s event and finishes it, all on the one socket', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
        const { bound, signingIn } = await signIn(fetcher);
        await vi.advanceTimersByTimeAsync(100);
        await expect(signingIn).resolves.toEqual({ ok: true });

        expect(transport.sockets).toHaveLength(1);
        const claim = bound.find(bind => bind.statement.includes('skip locked'))!;
        expect(claim.statement).toMatch(/pending\.user_id = \$\d+::uuid and pending\.event_key = \$\d+ and pending\.kind = \$\d+/);
        expect(claim.values).toEqual(expect.arrayContaining([userId, item.eventKey, 'ai_grant']));
        // The receipt insert still binds its payload as a jsonb object (drizzle only wraps the client after it).
        const insert = bound.find(bind => bind.statement.startsWith('insert into public.ezil_billing_outbox'))!;
        expect(insert.types).toEqual([OID.text, OID.uuid, OID.text, OID.jsonb]);
        expect(typeof JSON.parse(insert.values[3]!)).toBe('object');
        expect(bound.some(bind => bind.statement.includes('{accountPublicId}'))).toBe(true);
        const finish = bound.find(bind => bind.statement.includes('last_error ='))!;
        expect(finish.values).toEqual(expect.arrayContaining([null, expect.stringContaining('"status":"done"')]));
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string))
            .toMatchObject({ eventId: item.eventKey, action: 'grant', accountPublicId: 'works-public-id' });
        expect(info.mock.calls.at(-1)).toEqual([JSON.stringify({ event: 'ai-enroll', source: 'auth0', stage: 'done', code: null, starter: 'delivered' })]);
    });

    it('a Gateway that hangs never fails the enrollment: it is aborted at 2 s and the sign-in is still ok', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
            init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        }));
        const { bound, signingIn } = await signIn(hang);
        await vi.advanceTimersByTimeAsync(100);
        expect(hang).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(signingIn).resolves.toEqual({ ok: true });
        expect(bound.some(bind => bind.statement.includes('last_error =') && bind.values.some(v => v?.includes('"status":"retry"')))).toBe(true);
        expect(info.mock.calls.at(-1)).toEqual([JSON.stringify({ event: 'ai-enroll', source: 'auth0', stage: 'done', code: null, starter: 'queued' })]);
    });

    it('the five-second socket deadline cutting the database mid-delivery still reports an enrolled member, not a timeout', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const never = vi.fn(async () => new Response(null, { status: 204 }));
        // The backend answers the claim, then goes quiet on the account lookup: the pin, the HTTP call and the finish never happen.
        const { bound, signingIn } = await signIn(never, 'ezil_works.ai_members');
        await vi.advanceTimersByTimeAsync(100);
        expect(bound.some(bind => bind.statement.includes('skip locked'))).toBe(true);
        await vi.advanceTimersByTimeAsync(6_000);
        await expect(signingIn).resolves.toEqual({ ok: true });
        expect(transport.sockets[0]!.destroyed).toBe(true);
        expect(never).not.toHaveBeenCalled();
        expect(bound.some(bind => bind.statement.includes('last_error ='))).toBe(false);
        // The committed enrollment and receipt stand; the claimed row stays `processing` until its 30 s lease lapses.
        expect(JSON.parse(info.mock.calls.at(-1)![0] as string)).toMatchObject({ event: 'ai-enroll', source: 'auth0', stage: 'deliver', code: null });
    });
});
