/**
 * The Chat CLI OS receiver (`./cli-channel.ts`), driven by dependency injection:
 * the gate, the editor-cli signature (including a VALID sync signature rejected),
 * each op, every enumerated error, and owner/computer isolation. The services are
 * fakes, so these assert the CHANNEL's behaviour (what it calls, with which
 * owner/computer/clientId, and how it maps results and store errors to codes);
 * `cli-channel.pg.test.ts` proves the channel writes the same rows as the real
 * `agentSession.*` services.
 */
import { describe, expect, it, vi } from 'vitest';

import { signEditorSync } from './sync-route';
import { SessionStoreError, type Op, type SessionDb, type SessionRow, type SqlExecutor } from './store';
import type { ControlRow } from './control-store';
import { handleEditorCli, signEditorCli, type CliChannelDeps, type CliChannelServices } from './cli-channel';

const SECRET = 'cli-channel-test-secret';
const SANDBOX = 'guac-0123456789abcdef-fedcba9876543210';
const OWNER = '11111111-2222-4333-8444-555555555555';
const OTHER_OWNER = '22222222-3333-4444-8555-666666666666';
const COMPUTER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_COMPUTER = 'ffffffff-0000-4111-8222-333333333333';
const SESSION = 'cccccccc-dddd-4eee-8fff-000000000000';
const REQ = '99999999-8888-4777-8666-555544443333';
const NOW = 1_700_000_000_000;
const TS = '1700000000';

const controlRow = (over: Partial<ControlRow> = {}): ControlRow => ({
    id: 'op-create-1', kind: 'create', status: 'accepted', sessionId: null, computerId: COMPUTER,
    updatedAt: '2026-11-22T00:00:00.000Z', expiresAt: null, reason: null, requested: { model: null, effort: null }, effective: null, ...over,
});
const sendOp = (over: Partial<Op> = {}): Op => ({
    id: 'op-send-1', sessionId: SESSION, kind: 'send', status: 'queued', idempotencyKey: REQ, updatedAt: '2026-11-22T00:00:00.000Z', ...over,
});
const sessionRow = (over: Partial<SessionRow> = {}): SessionRow => ({
    id: SESSION, computerId: COMPUTER, title: 'Chat', status: 'idle', bridge: 'connected', open: true, updatedAt: '2026-11-22T00:00:00.000Z', ...over,
});

const services = (over: Partial<CliChannelServices> = {}): CliChannelServices => ({
    create: vi.fn(async () => controlRow()),
    send: vi.fn(async () => sendOp()),
    list: vi.fn(async () => [sessionRow()]),
    getSession: vi.fn(async () => sessionRow()),
    events: vi.fn(async () => ({ events: [] as SessionEvent[], next: null })),
    ...over,
});

const deps = (over: Partial<CliChannelDeps> = {}): CliChannelDeps => ({
    db: {} as SessionDb,
    secret: SECRET,
    enabled: true,
    now: () => NOW,
    computerForSandbox: vi.fn(async (_db: SqlExecutor, _sandbox: string) => ({ id: COMPUTER, userId: OWNER })),
    services: services(),
    ...over,
});

type SessionEvent = { seq: number; at: string; kind: 'user' | 'assistant' | 'operation'; operationId: string };

interface ReqOpts { ts?: string; sandbox?: string; sign?: (s: string, t: string, b: string, body: Uint8Array) => string; method?: string; contentType?: string | null; headers?: Record<string, string>; secret?: string }
const request = (payload: unknown, opts: ReqOpts = {}): Request => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const bytes = new TextEncoder().encode(body);
    const ts = opts.ts ?? TS;
    const sandbox = opts.sandbox ?? SANDBOX;
    const signer = opts.sign ?? signEditorCli;
    const headers = new Headers({ 'x-ezil-sandbox': sandbox, 'x-ezil-timestamp': ts, 'x-ezil-signature': signer(opts.secret ?? SECRET, ts, sandbox, bytes) });
    if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'application/json');
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
    const method = opts.method ?? 'POST';
    return new Request('https://os-staging.ezil.work/api/editor-bridge/v1/cli', { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
};
const chat = (op: string, args: unknown, requestId = REQ) => request({ op, args, requestId });

const run = async (req: Request, d: CliChannelDeps = deps()) => {
    const res = await handleEditorCli(req, d);
    return { status: res.status, cache: res.headers.get('cache-control'), body: (await res.json()) as { ok: boolean; result?: Record<string, unknown>; error?: string } };
};

describe('gate', () => {
    it('off -> 404 cli_unavailable even with a valid signature; on -> proceeds (mutation proof of the gate)', async () => {
        const off = await run(chat('chat.list', {}), deps({ enabled: false }));
        expect([off.status, off.body.error]).toEqual([404, 'cli_unavailable']);
        const on = await run(chat('chat.list', {}));
        expect(on.status).toBe(200);
    });
});

describe('method, size and content-type (all fold into the enumerated codes)', () => {
    it('non-POST, oversize, and wrong content-type are 400 cli_invalid_request', async () => {
        expect((await run(chat('chat.list', {}), deps())).status).toBe(200);
        const get = await run(request({ op: 'chat.list', args: {}, requestId: REQ }, { method: 'GET' }));
        expect([get.status, get.body.error]).toEqual([400, 'cli_invalid_request']);
        const declaredBig = await run(request({ op: 'chat.list', args: {}, requestId: REQ }, { headers: { 'content-length': String(32 * 1024 + 1) } }));
        expect(declaredBig.status).toBe(400);
        const big = 'a'.repeat(32 * 1024 + 50);
        const streamBig = await run(request({ op: 'chat.send', args: { sessionId: SESSION, text: big }, requestId: REQ }, { headers: { 'content-length': '0' } }));
        expect(streamBig.status).toBe(400);
        const text = await run(request({ op: 'chat.list', args: {}, requestId: REQ }, { contentType: 'text/plain' }));
        expect([text.status, text.body.error]).toEqual([400, 'cli_invalid_request']);
    });
});

describe('signature (±60s, timing-safe, distinct editor-cli label)', () => {
    it('accepts a correct editor-cli signature and refuses wrong/missing/stale/other-sandbox ones', async () => {
        expect((await run(chat('chat.list', {}))).status).toBe(200);
        expect((await run(chat('chat.list', {}), deps({ secret: undefined }))).status).toBe(401);
        expect((await run(request({ op: 'chat.list', args: {}, requestId: REQ }, { secret: 'wrong-secret' }))).status).toBe(401);
        const noSig = request({ op: 'chat.list', args: {}, requestId: REQ });
        noSig.headers.delete('x-ezil-signature');
        expect((await run(noSig)).status).toBe(401);
        expect((await run(request({ op: 'chat.list', args: {}, requestId: REQ }, { ts: String(NOW / 1000 - 61) }))).status).toBe(401);
        expect((await run(request({ op: 'chat.list', args: {}, requestId: REQ }, { ts: String(NOW / 1000 + 61) }))).status).toBe(401);
        // The signature binds the sandbox: a signature for another sandbox is refused for this one.
        const moved = request({ op: 'chat.list', args: {}, requestId: REQ }, { sandbox: 'guac-1111111111111111-2222222222222222' });
        moved.headers.set('x-ezil-sandbox', SANDBOX);
        expect((await run(moved)).status).toBe(401);
        const r = await run(request({ op: 'chat.list', args: {}, requestId: REQ }, { secret: 'wrong-secret' }));
        expect(r.body.error).toBe('cli_unauthorized');
    });

    it('a VALID sync signature (editor-bridge.v1 label) is rejected; only the editor-cli label verifies', async () => {
        const syncSigned = await run(request({ op: 'chat.list', args: {}, requestId: REQ }, { sign: signEditorSync }));
        expect([syncSigned.status, syncSigned.body.error]).toEqual([401, 'cli_unauthorized']);
        // Same bytes, editor-cli label: accepted.
        expect((await run(chat('chat.list', {}))).status).toBe(200);
    });
});

describe('request validation', () => {
    it('400 cli_invalid_request for bad JSON, unknown/missing op, extra keys, non-v4 requestId, and out-of-range args', async () => {
        const bad: Request[] = [
            request('{not json', {}),
            request({ op: 'chat.boom', args: {}, requestId: REQ }),
            request({ args: {}, requestId: REQ }),
            request({ op: 'chat.list', args: {}, requestId: REQ, extra: 1 }),
            request({ op: 'chat.list', args: { x: 1 }, requestId: REQ }),
            request({ op: 'chat.list', args: {}, requestId: 'not-a-uuid' }),
            request({ op: 'chat.list', args: {}, requestId: '11111111-1111-1111-1111-111111111111' }), // v1, not v4
            request({ op: 'chat.send', args: { sessionId: SESSION, text: '' }, requestId: REQ }),
            request({ op: 'chat.send', args: { sessionId: SESSION, text: 'a'.repeat(16_385) }, requestId: REQ }),
            request({ op: 'chat.send', args: { sessionId: 'nope', text: 'hi' }, requestId: REQ }),
            request({ op: 'chat.read', args: { sessionId: SESSION, cursor: -1 }, requestId: REQ }),
            request({ op: 'chat.new', args: { model: 'm', bogus: 1 }, requestId: REQ }),
        ];
        for (const req of bad) {
            const r = await run(req);
            expect([r.status, r.body.error]).toEqual([400, 'cli_invalid_request']);
        }
    });
});

describe('sandbox resolution', () => {
    it('an unresolvable sandbox is 404 cli_unavailable', async () => {
        const d = deps({ computerForSandbox: vi.fn(async () => null) });
        const r = await run(chat('chat.list', {}), d);
        expect([r.status, r.body.error]).toEqual([404, 'cli_unavailable']);
    });
});

describe('chat.new', () => {
    it('calls the create service with the owner, computer, clientId "" and requestId as the idempotency key', async () => {
        const create = vi.fn(async () => controlRow({ status: 'accepted', sessionId: null, id: 'op-create-1' }));
        const d = deps({ services: services({ create }) });
        const r = await run(request({ op: 'chat.new', args: { model: 'ezil/kimi' }, requestId: REQ }), d);
        expect(r.body).toEqual({ ok: true, result: { sessionId: null, operationId: 'op-create-1', status: 'accepted' } });
        expect(r.cache).toBe('no-store');
        expect(create).toHaveBeenCalledWith(d.db, { userId: OWNER, clientId: '' }, { computerId: COMPUTER, model: 'ezil/kimi', effort: undefined, idempotencyKey: REQ });
    });

    it('maps the editor states: disconnected -> 409 editor_disconnected, controls -> 409 editor_controls_unsupported', async () => {
        const dc = await run(chat('chat.new', {}), deps({ services: services({ create: vi.fn(async () => controlRow({ status: 'disconnected', reason: 'no_connected_editor' })) }) }));
        expect([dc.status, dc.body.error]).toEqual([409, 'editor_disconnected']);
        const unsup = await run(chat('chat.new', {}), deps({ services: services({ create: vi.fn(async () => controlRow({ status: 'rejected', reason: 'editor_controls_unsupported' })) }) }));
        expect([unsup.status, unsup.body.error]).toEqual([409, 'editor_controls_unsupported']);
    });

    it('a model rejection is still {ok:true} with the status (not a 409), and effort is refused 400', async () => {
        const rej = await run(chat('chat.new', { model: 'x' }), deps({ services: services({ create: vi.fn(async () => controlRow({ status: 'rejected', reason: 'model_not_offered' })) }) }));
        expect(rej.status).toBe(200);
        expect(rej.body.result).toEqual({ sessionId: null, operationId: 'op-create-1', status: 'rejected' });
        const effort = await run(chat('chat.new', { effort: 'high' }), deps({ services: services({ create: vi.fn(async () => { throw new SessionStoreError('BAD_REQUEST', 'effort_not_per_session'); }) }) }));
        expect([effort.status, effort.body.error]).toEqual([400, 'cli_invalid_request']);
    });

    it('a NOT_FOUND computer -> session_not_found, a CONFLICT -> cli_invalid_request', async () => {
        const nf = await run(chat('chat.new', {}), deps({ services: services({ create: vi.fn(async () => { throw new SessionStoreError('NOT_FOUND'); }) }) }));
        expect([nf.status, nf.body.error]).toEqual([404, 'session_not_found']);
        const cf = await run(chat('chat.new', {}), deps({ services: services({ create: vi.fn(async () => { throw new SessionStoreError('CONFLICT'); }) }) }));
        expect([cf.status, cf.body.error]).toEqual([400, 'cli_invalid_request']);
    });
});

describe('chat.send', () => {
    it('checks the session is on this computer, then sends with the owner and clientId ""', async () => {
        const getSession = vi.fn(async () => sessionRow());
        const send = vi.fn(async () => sendOp({ status: 'queued' }));
        const d = deps({ services: services({ getSession, send }) });
        const r = await run(chat('chat.send', { sessionId: SESSION, text: 'run the tests' }), d);
        expect(r.body).toEqual({ ok: true, result: { sessionId: SESSION, operationId: 'op-send-1', status: 'queued' } });
        expect(getSession).toHaveBeenCalledWith(d.db, OWNER, SESSION);
        expect(send).toHaveBeenCalledWith(d.db, { userId: OWNER, clientId: '' }, { sessionId: SESSION, text: 'run the tests', idempotencyKey: REQ });
    });

    it('a session on another computer is session_not_found and never sent (computer isolation)', async () => {
        const send = vi.fn(async () => sendOp());
        const d = deps({ services: services({ getSession: vi.fn(async () => sessionRow({ computerId: OTHER_COMPUTER })), send }) });
        const r = await run(chat('chat.send', { sessionId: SESSION, text: 'hi' }), d);
        expect([r.status, r.body.error]).toEqual([404, 'session_not_found']);
        expect(send).not.toHaveBeenCalled();
    });

    it('a missing session is session_not_found; a bad-text BAD_REQUEST is cli_invalid_request', async () => {
        const nf = await run(chat('chat.send', { sessionId: SESSION, text: 'hi' }), deps({ services: services({ getSession: vi.fn(async () => { throw new SessionStoreError('NOT_FOUND'); }) }) }));
        expect([nf.status, nf.body.error]).toEqual([404, 'session_not_found']);
        const bad = await run(chat('chat.send', { sessionId: SESSION, text: 'hi' }), deps({ services: services({ send: vi.fn(async () => { throw new SessionStoreError('BAD_REQUEST'); }) }) }));
        expect([bad.status, bad.body.error]).toEqual([400, 'cli_invalid_request']);
        const gone = await run(chat('chat.send', { sessionId: SESSION, text: 'hi' }), deps({ services: services({ send: vi.fn(async () => { throw new SessionStoreError('NOT_FOUND'); }) }) }));
        expect([gone.status, gone.body.error]).toEqual([404, 'session_not_found']);
    });
});

describe('chat.list', () => {
    it('lists this owner\'s sessions scoped to this computer', async () => {
        const list = vi.fn(async () => [sessionRow()]);
        const d = deps({ services: services({ list }) });
        const r = await run(chat('chat.list', {}), d);
        expect(r.body.ok).toBe(true);
        expect((r.body.result as { sessions: unknown[] }).sessions).toHaveLength(1);
        expect(list).toHaveBeenCalledWith(d.db, OWNER, COMPUTER);
    });
});

describe('chat.read', () => {
    it('checks the computer, reads events from the cursor, and returns the next cursor', async () => {
        const events = vi.fn(async () => ({ events: [{ seq: 4, at: 'x', kind: 'user' as const, operationId: 'o' }], next: 4 }));
        const d = deps({ services: services({ events }) });
        const r = await run(chat('chat.read', { sessionId: SESSION, cursor: 2 }), d);
        expect(r.body).toEqual({ ok: true, result: { sessionId: SESSION, events: [{ seq: 4, at: 'x', kind: 'user', operationId: 'o' }], cursor: 4 } });
        expect(events).toHaveBeenCalledWith(d.db, OWNER, SESSION, 2);
        // No cursor -> after 0.
        await run(chat('chat.read', { sessionId: SESSION }), d);
        expect(events).toHaveBeenLastCalledWith(d.db, OWNER, SESSION, 0);
    });

    it('a session on another computer is session_not_found and never read', async () => {
        const events = vi.fn(async () => ({ events: [], next: null }));
        const d = deps({ services: services({ getSession: vi.fn(async () => sessionRow({ computerId: OTHER_COMPUTER })), events }) });
        const r = await run(chat('chat.read', { sessionId: SESSION }), d);
        expect([r.status, r.body.error]).toEqual([404, 'session_not_found']);
        expect(events).not.toHaveBeenCalled();
    });
});

describe('owner isolation and internal faults', () => {
    it('uses the owner the sandbox resolves to, not a fixed one', async () => {
        const create = vi.fn(async () => controlRow());
        const d = deps({ computerForSandbox: vi.fn(async () => ({ id: OTHER_COMPUTER, userId: OTHER_OWNER })), services: services({ create }) });
        await run(chat('chat.new', {}), d);
        expect(create).toHaveBeenCalledWith(d.db, { userId: OTHER_OWNER, clientId: '' }, { computerId: OTHER_COMPUTER, model: undefined, effort: undefined, idempotencyKey: REQ });
    });

    it('an unexpected (non-store) error is a 500, never a false success', async () => {
        const r = await run(chat('chat.list', {}), deps({ services: services({ list: vi.fn(async () => { throw new Error('db exploded'); }) }) }));
        expect(r.status).toBe(500);
        expect(r.body.ok).toBe(false);
    });
});
