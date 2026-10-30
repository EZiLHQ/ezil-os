import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SocketDouble {
    readyState: string;
    destroyed: boolean;
    closed: boolean;
    writes: Buffer[];
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
        constructor() { super(); transport.sockets.push(this); }
        connect() { return this; }
        connectNow() { this.readyState = 'open'; this.emit('connect'); }
        setKeepAlive() { return this; }
        write(data: Uint8Array) { this.writes.push(Buffer.from(data)); return true; }
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
