/**
 * The Chat CLI channel on a real Postgres: proof that it enqueues work through
 * the SAME services as `agentSession.create / send / list / events`, so a CLI
 * session is the very record those procedures (and MCP `list_sessions`) read.
 *
 * It drives the real editor sync route to connect a protocol-2 editor and create
 * sessions, then calls the real `handleEditorCli` (signed with the editor-cli
 * label) and compares the rows it wrote in `ezil_control_operations` /
 * `ezil_agent_operations` against a direct call of the same service. Isolation
 * (another owner, another computer) is proven against real rows.
 *
 * Needs a THROWAWAY database (it creates auth.users, ezil_computers, 0034/0035/0036):
 *   DELEGATION_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/ws2_chat_channel
 */
import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleEditorCli, signEditorCli, type CliChannelDeps } from './cli-channel';
import { createSession, type ControlTiming } from './control-store';
import { ensureTestSchema } from './pg-test-schema';
import { getSession, listEvents, listSessions, sendInstruction, type SessionDb } from './store';
import { computerForSandbox, handleEditorSync, signEditorSync } from './sync-route';

const URL_ = process.env.DELEGATION_TEST_DATABASE_URL;
const OS = 'https://os-staging.ezil.work';
const WORKER_SECRET = 'worker-secret-for-tests-only';
const FAST: ControlTiming = { createWaitMs: 100, configureWaitMs: 100, pollMs: 20 };
const compact = (id: string) => id.replace(/-/g, '').toLowerCase().slice(0, 16);
const sandboxOf = (userId: string, computerId: string) => `guac-${compact(userId)}-${compact(computerId)}`;

type Json = { ok: boolean; result?: Record<string, unknown>; error?: string };
const cols = ['kind', 'proc', 'status', 'session_id', 'computer_id', 'user_id', 'client_id', 'requested_model', 'requested_effort'] as const;
const sendCols = ['kind', 'proc', 'status', 'session_id', 'computer_id', 'user_id', 'client_id', 'text'] as const;

describe.skipIf(!URL_)('EZiL Chat CLI channel on Postgres', () => {
    let client: ReturnType<typeof postgres>;
    let db: SessionDb;
    const alice = randomUUID();
    const bob = randomUUID();
    const ids = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() };
    let a1Sessions: string[] = [];
    let a2Session = '';

    const syncDeps = () => ({ db, secret: WORKER_SECRET, enabled: 'enabled' as const, controls: 'enabled' as const, now: () => Date.now() });
    const syncReq = (sandbox: string, body: unknown) => {
        const raw = JSON.stringify(body);
        const ts = String(Math.floor(Date.now() / 1000));
        return new Request(new URL('/api/editor-bridge/v1/sync', OS), {
            method: 'POST', body: raw,
            headers: { 'content-type': 'application/json', 'x-ezil-sandbox': sandbox, 'x-ezil-timestamp': ts, 'x-ezil-signature': signEditorSync(WORKER_SECRET, ts, sandbox, new TextEncoder().encode(raw)) },
        });
    };
    const connect = async (sandbox: string, computerId: string, opts: { protocol?: 1 | 2; count?: number } = {}) => {
        const protocol = opts.protocol ?? 1;
        const resources = Array.from({ length: opts.count ?? 2 }, () => `vscode-chat-session://local/${randomUUID()}`);
        const sessions = resources.map((resource, i) => ({ resource, title: `Chat ${i + 1}`, open: true, status: 'idle', ...(protocol === 2 ? { model: null, requests: null } : {}) }));
        const res = await handleEditorSync(syncReq(sandbox, { protocol, seq: 1, ownerId: `w-${randomUUID()}`, epoch: 0, sessions }), syncDeps());
        const json = await res.json() as { owner: string };
        expect([res.status, json.owner]).toEqual([200, 'self']);
        const rows = await client`SELECT id::text AS id, resource FROM public.ezil_agent_sessions WHERE computer_id = ${computerId}::uuid AND present`;
        const byResource = new Map(rows.map((r) => [String(r.resource), String(r.id)]));
        return resources.map((r) => byResource.get(r)!);
    };

    const deps: CliChannelDeps = {
        db: undefined as unknown as SessionDb, secret: WORKER_SECRET, enabled: true, now: () => Date.now(), computerForSandbox,
        services: {
            create: (d, caller, input) => createSession(d, caller, input, FAST),
            send: (d, caller, input) => sendInstruction(d, caller, input),
            list: (d, u, c) => listSessions(d, u, c),
            getSession: (d, u, s) => getSession(d, u, s),
            events: (d, u, s, a, l) => listEvents(d, u, s, a, l),
        },
    };
    const cli = async (sandbox: string, op: string, args: unknown, requestId = randomUUID()): Promise<{ status: number; json: Json }> => {
        const body = JSON.stringify({ op, args, requestId });
        const ts = String(Math.floor(Date.now() / 1000));
        const req = new Request(new URL('/api/editor-bridge/v1/cli', OS), {
            method: 'POST', body,
            headers: { 'content-type': 'application/json', 'x-ezil-sandbox': sandbox, 'x-ezil-timestamp': ts, 'x-ezil-signature': signEditorCli(WORKER_SECRET, ts, sandbox, new TextEncoder().encode(body)) },
        });
        const res = await handleEditorCli(req, deps);
        return { status: res.status, json: await res.json() as Json };
    };
    const row = async (table: string, id: string, keep: readonly string[]) => {
        const [r] = await client.unsafe(`SELECT ${keep.join(', ')} FROM public.${table} WHERE id = '${id}'::uuid`);
        return r;
    };

    beforeAll(async () => {
        client = postgres(URL_!, { max: 8, prepare: false, onnotice: () => {} });
        db = drizzle(client) as unknown as SessionDb;
        deps.db = db;
        await ensureTestSchema(client);
        await client`INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (${alice}::uuid, 'a@cli.test', now()), (${bob}::uuid, 'b@cli.test', now())`;
        await client`INSERT INTO public.ezil_computers (id, user_id, name, slot, deleted_at) VALUES
            (${ids.a1}::uuid, ${alice}::uuid, 'A1', 1, NULL), (${ids.a2}::uuid, ${alice}::uuid, 'A2', 2, NULL),
            (${ids.b1}::uuid, ${bob}::uuid, 'B1', 1, NULL)`;
        a1Sessions = await connect(sandboxOf(alice, ids.a1), ids.a1, { protocol: 2, count: 2 });
        [a2Session] = await connect(sandboxOf(alice, ids.a2), ids.a2, { protocol: 1, count: 1 });
        await connect(sandboxOf(bob, ids.b1), ids.b1, { protocol: 1, count: 1 });
    }, 60_000);
    afterAll(async () => { await client?.end(); });

    it('chat.new queues the SAME ezil_control_operations row agentSession.create writes', async () => {
        // No model: a protocol-2 live editor queues it (a model would need an attested catalog; that path is in the DI test).
        const res = await cli(sandboxOf(alice, ids.a1), 'chat.new', {});
        expect(res.status).toBe(200);
        expect(res.json.ok).toBe(true);
        expect(res.json.result).toMatchObject({ sessionId: null, status: 'accepted' });
        const operationId = String(res.json.result!.operationId);

        const direct = await createSession(db, { userId: alice, clientId: '' }, { computerId: ids.a1, idempotencyKey: randomUUID() }, FAST);
        expect(await row('ezil_control_operations', operationId, cols)).toEqual(await row('ezil_control_operations', direct.id, cols));
        expect(await row('ezil_control_operations', operationId, cols)).toMatchObject({
            kind: 'create', proc: 'agentSession.create', status: 'queued', computer_id: ids.a1, user_id: alice, client_id: '', requested_model: null,
        });
    });

    it('chat.send writes the SAME ezil_agent_operations row agentSession.send writes, and chat.read echoes agentSession.events', async () => {
        const target = a1Sessions[1]!;
        const res = await cli(sandboxOf(alice, ids.a1), 'chat.send', { sessionId: target, text: 'run the tests' });
        expect(res.status).toBe(200);
        expect(res.json.result).toMatchObject({ sessionId: target, status: 'queued' });
        const operationId = String(res.json.result!.operationId);

        const direct = await sendInstruction(db, { userId: alice, clientId: '' }, { sessionId: target, text: 'run the tests', idempotencyKey: randomUUID() });
        expect(await row('ezil_agent_operations', operationId, sendCols)).toEqual(await row('ezil_agent_operations', direct.id, sendCols));
        expect(await row('ezil_agent_operations', operationId, sendCols)).toMatchObject({
            kind: 'send', proc: 'agentSession.send', status: 'queued', session_id: target, computer_id: ids.a1, user_id: alice, client_id: '', text: 'run the tests',
        });

        const read = await cli(sandboxOf(alice, ids.a1), 'chat.read', { sessionId: target });
        expect(read.status).toBe(200);
        const expected = await listEvents(db, alice, target, 0);
        expect(read.json.result).toEqual({ sessionId: target, events: expected.events, cursor: expected.next });
        expect((read.json.result!.events as unknown[]).length).toBeGreaterThan(0);
    });

    it('chat.list returns exactly agentSession.list for this owner on this computer, excluding other computers and owners', async () => {
        const res = await cli(sandboxOf(alice, ids.a1), 'chat.list', {});
        expect(res.status).toBe(200);
        const sessions = res.json.result!.sessions as { id: string; computerId: string }[];
        expect(sessions).toEqual(await listSessions(db, alice, ids.a1));
        expect(sessions.map((s) => s.id).sort()).toEqual([...a1Sessions].sort());
        expect(sessions.every((s) => s.computerId === ids.a1)).toBe(true);
        // a2 (same owner, other computer) and b1 (other owner) are not visible here.
        expect(sessions.some((s) => s.id === a2Session)).toBe(false);
    });

    it('a session on another computer of the same owner is session_not_found for send and read, but reachable from its own sandbox', async () => {
        const send = await cli(sandboxOf(alice, ids.a1), 'chat.send', { sessionId: a2Session, text: 'hi' });
        expect([send.status, send.json.error]).toEqual([404, 'session_not_found']);
        const read = await cli(sandboxOf(alice, ids.a1), 'chat.read', { sessionId: a2Session });
        expect([read.status, read.json.error]).toEqual([404, 'session_not_found']);
        const fromOwn = await cli(sandboxOf(alice, ids.a2), 'chat.read', { sessionId: a2Session });
        expect(fromOwn.status).toBe(200);
        expect(fromOwn.json.result).toMatchObject({ sessionId: a2Session });
    });
});
