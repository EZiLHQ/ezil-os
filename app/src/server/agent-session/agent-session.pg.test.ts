/**
 * EZiL Chat sessions through the editor bridge, end to end on a real Postgres:
 * the real `/api/trpc` route (delegated GET reads and POST writes, the gate,
 * the agentSession router) and the real `/api/editor-bridge/v1/sync` route
 * (Worker signature, sandbox -> computer, the owner lease, handout, reports),
 * over the real 0023 tables. Only Supabase's cookie client is stubbed.
 *
 * Needs a THROWAWAY database (it creates auth.users, ezil_computers, 0022, 0023):
 *   DELEGATION_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres
 */
import { createHash, randomUUID, webcrypto } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import superjson from 'superjson';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';

import { ensureTestSchema } from './pg-test-schema';

const MCP = 'https://mcp-staging.ezil.work';
const OS = 'https://os-staging.ezil.work';
const SUPABASE = 'https://btgqfmnzycdecmeyqubx.supabase.co';
const CLIENT = 'https://chatgpt.com/oauth/client.json';
const WORKER_SECRET = 'worker-secret-for-tests-only';

const h = vi.hoisted(() => ({ db: undefined as unknown, cookieUser: null as { id: string } | null }));

vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/db', () => ({ get db() { return h.db; } }));
vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.cookieUser }, error: null }) } }),
}));

const URL_ = process.env.DELEGATION_TEST_DATABASE_URL;
const compact = (id: string) => id.replace(/-/g, '').toLowerCase().slice(0, 16);
const sandboxOf = (userId: string, computerId: string) => `guac-${compact(userId)}-${compact(computerId)}`;

type Op = { id: string; sessionId: string; kind: string; status: string; idempotencyKey: string; targetOperationId?: string; expiresAt?: string; reason?: string; mode?: string; selectedModelId?: string };
type Session = { id: string; computerId: string; title: string | null; status: string; bridge: string; open: boolean };
type Delivery = { operationId: string; attemptId: string; kind: 'send' | 'cancel'; sessionResource: string; deliverWithinMs: number; text?: string; targetOperationId?: string };
type Sync = { ok: true; owner: 'self'; epoch: number; deliver: Delivery[]; applied: number } | { ok: true; owner: 'other' };

describe.skipIf(!URL_)('EZiL Chat sessions through the editor bridge on Postgres', () => {
    let client: ReturnType<typeof postgres>;
    let signer: { kid: string; privateKey: webcrypto.CryptoKey };
    let trpcGet: (req: Request) => Promise<Response>;
    let trpcPost: (req: Request) => Promise<Response>;
    let syncRoute: (req: Request) => Promise<Response>;
    let signEditorSync: typeof import('./sync-route').signEditorSync;
    const alice = randomUUID();
    const bob = randomUUID();
    const ids = { a1: randomUUID(), a2: randomUUID(), aDeleted: randomUUID(), b1: randomUUID() };
    let env: Record<string, string> = {};

    const sign = async (scope: string, proc: string, inputBytes: string, overrides: Record<string, unknown> = {}) => {
        const now = Math.floor(Date.now() / 1000);
        const claims = {
            iss: MCP, aud: OS, sub: alice, idp_iss: `${SUPABASE}/auth/v1`, client_id: CLIENT, scope, proc,
            inp: createHash('sha256').update(inputBytes, 'utf8').digest('base64url'), jti: randomUUID(), iat: now, exp: now + 60, ...overrides,
        };
        const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
        const signingInput = `${b64({ alg: 'ES256', typ: 'ezil-delegation+jwt', kid: signer.kid })}.${b64(claims)}`;
        const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.privateKey, new TextEncoder().encode(signingInput));
        return `${signingInput}.${Buffer.from(sig).toString('base64url')}`;
    };
    /** Exactly what the MCP sends for a read: one GET, input percent-encoded, digest of the decoded value. */
    const read = async (proc: string, input?: unknown, overrides: Record<string, unknown> = {}) => {
        const serialized = input === undefined ? '' : JSON.stringify({ json: input });
        const url = new URL(`/api/trpc/${proc}`, OS);
        if (input !== undefined) url.searchParams.set('input', serialized);
        const assertion = await sign('ezil:sessions:read', proc, serialized, overrides);
        return trpcGet(new Request(url, { headers: { authorization: `EZiL-Delegation ${assertion}` } }));
    };
    /** Exactly what the MCP sends for a write: one POST whose body is `{"json":<input>}`, digest of those bytes. */
    const write = async (proc: string, input: unknown, overrides: Record<string, unknown> = {}, scope = 'ezil:sessions:write') => {
        const body = JSON.stringify({ json: input });
        const assertion = await sign(scope, proc, body, overrides);
        return trpcPost(new Request(new URL(`/api/trpc/${proc}`, OS), {
            method: 'POST', headers: { authorization: `EZiL-Delegation ${assertion}`, 'content-type': 'application/json' }, body,
        }));
    };
    const data = async <T>(response: Response) => {
        const json = await response.json();
        if (!json.result) throw new Error(`expected a result, got ${response.status} ${JSON.stringify(json)}`);
        return superjson.deserialize(json.result.data) as T;
    };
    const code = async (response: Response) => (await response.json()).error?.json?.data?.code as string | undefined;

    /** What the Worker forwards after verifying the computer's token. */
    const syncRequest = (sandbox: string, body: unknown, opts: { secret?: string; ts?: number; raw?: string; contentType?: string } = {}) => {
        const raw = opts.raw ?? JSON.stringify(body);
        const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
        const bytes = new TextEncoder().encode(raw);
        return new Request(new URL('/api/editor-bridge/v1/sync', OS), {
            method: 'POST', body: raw,
            headers: { 'content-type': opts.contentType ?? 'application/json', 'x-ezil-sandbox': sandbox, 'x-ezil-timestamp': ts,
                'x-ezil-signature': signEditorSync(opts.secret ?? WORKER_SECRET, ts, sandbox, bytes) },
        });
    };
    // What the extension client does: a strictly increasing seq per owner, and each report names the
    // attempt it was handed (filled in here from the last delivery, unless a test passes its own).
    const seqs = new Map<string, number>();
    const attempts = new Map<string, string>();
    const syncBody = (body: Record<string, unknown>) => {
        const owner = String(body.ownerId);
        const seq = typeof body.seq === 'number' ? body.seq : (seqs.get(owner) ?? 0) + 1;
        seqs.set(owner, Math.max(seq, seqs.get(owner) ?? 0));
        const reports = (body.reports as Record<string, unknown>[] | undefined)?.map((r) => ({ attemptId: attempts.get(String(r.operationId)) ?? randomUUID(), ...r }));
        return { protocol: 1, ...body, seq, ...(reports ? { reports } : {}) };
    };
    const syncRaw = async (body: Record<string, unknown>, sandbox = sandboxOf(alice, ids.a1)) => {
        const response = await syncRoute(syncRequest(sandbox, syncBody(body)));
        const json = await response.json() as Sync;
        if (response.status === 200 && json.owner === 'self') for (const d of json.deliver) attempts.set(d.operationId, d.attemptId);
        return { status: response.status, json };
    };
    const sync = async (body: Record<string, unknown>, sandbox = sandboxOf(alice, ids.a1)): Promise<Sync> => {
        const { status, json } = await syncRaw(body, sandbox);
        expect(status).toBe(200);
        return json;
    };
    /** Bring a backed-off requeue forward so the next sync can hand it out. */
    const ready = (operationId: string) =>
        client`UPDATE public.ezil_agent_operations SET not_before = now() - interval '1 second' WHERE id = ${operationId}::uuid`;
    const editorSessions = (...resources: string[]) =>
        resources.map((resource, i) => ({ resource, title: `Chat ${i + 1}`, open: true, status: 'idle' }));
    const expireLease = (computerId = ids.a1) =>
        client`UPDATE public.ezil_editor_bridge_owner SET lease_until = now() - interval '1 second' WHERE computer_id = ${computerId}::uuid`;

    /** A fresh owner on a1 with two open sessions; returns their OS ids and the epoch. */
    const connect = async (owner = `w-${randomUUID()}`) => {
        // A new window takes over once the previous one's lease has lapsed (the owner row is never deleted).
        await expireLease();
        const resources = [`vscode-chat-session://local/${randomUUID()}`, `vscode-chat-session://local/${randomUUID()}`];
        const first = await sync({ ownerId: owner, epoch: 0, sessions: editorSessions(...resources) });
        if (first.owner !== 'self') throw new Error('expected ownership');
        const rows = await client`SELECT id, resource FROM public.ezil_agent_sessions WHERE computer_id = ${ids.a1}::uuid AND present`;
        const byResource = new Map(rows.map((row) => [row.resource as string, row.id as string]));
        return { owner, epoch: first.epoch, resources, sessions: resources.map((r) => byResource.get(r)!) };
    };

    beforeAll(async () => {
        client = postgres(URL_!, { max: 8, prepare: false, onnotice: () => {} });
        h.db = drizzle(client, { schema });
        await ensureTestSchema(client);
        await client`INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (${alice}::uuid, 'a@example.com', now()), (${bob}::uuid, 'b@example.com', now())`;
        await client`INSERT INTO public.ezil_computers (id, user_id, name, slot, deleted_at) VALUES
            (${ids.a1}::uuid, ${alice}::uuid, 'A1', 1, NULL), (${ids.a2}::uuid, ${alice}::uuid, 'A2', 2, NULL),
            (${ids.aDeleted}::uuid, ${alice}::uuid, 'gone', 1, now()), (${ids.b1}::uuid, ${bob}::uuid, 'B1', 1, NULL)`;

        const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
        signer = { kid: 'mcp-test', privateKey: pair.privateKey };
        env = {
            NEXT_PUBLIC_SUPABASE_URL: SUPABASE, EZIL_DELEGATION_ISSUER: MCP, EZIL_DELEGATION_AUDIENCE: OS, EZIL_DELEGATION_CLIENT_IDS: CLIENT,
            EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: 'mcp-test' }] }),
            EZIL_EDITOR_BRIDGE: 'enabled', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: WORKER_SECRET,
        };
        const trpc = await import('@/app/api/trpc/[trpc]/route');
        trpcGet = trpc.GET as (req: Request) => Promise<Response>;
        trpcPost = trpc.POST as (req: Request) => Promise<Response>;
        syncRoute = (await import('@/app/api/editor-bridge/v1/sync/route')).POST;
        ({ signEditorSync } = await import('./sync-route'));
    }, 60_000);

    beforeEach(() => { for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value); });
    afterEach(() => { h.cookieUser = null; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    afterAll(async () => { await client?.end(); });

    describe('the editor sync route (Worker-forwarded)', () => {
        it('refuses an unsigned, mis-signed, stale, oversized or mistyped request, and anything for an unknown computer', async () => {
            const sandbox = sandboxOf(alice, ids.a1);
            const body = { protocol: 1, ownerId: 'w-x', epoch: 0, seq: 1 };
            const status = async (req: Request) => (await syncRoute(req)).status;
            expect(await status(syncRequest(sandbox, body, { secret: 'another-secret' }))).toBe(401);
            expect(await status(syncRequest(sandbox, body, { ts: Math.floor(Date.now() / 1000) - 61 }))).toBe(401);
            expect(await status(syncRequest(sandbox, body, { ts: Math.floor(Date.now() / 1000) + 61 }))).toBe(401);
            const valid = syncRequest(sandbox, body);
            // The signature binds the sandbox and the body: replaying it for another computer or body fails.
            const moved = new Request(valid.url, { method: 'POST', body: JSON.stringify(body), headers: { ...Object.fromEntries(valid.headers), 'x-ezil-sandbox': sandboxOf(bob, ids.b1) } });
            expect(await status(moved)).toBe(401);
            const altered = new Request(valid.url, { method: 'POST', body: JSON.stringify({ ...body, ownerId: 'w-y' }), headers: Object.fromEntries(valid.headers) });
            expect(await status(altered)).toBe(401);
            const unsigned = new Request(valid.url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-ezil-sandbox': sandbox } });
            expect(await status(unsigned)).toBe(401);
            expect(await status(syncRequest(sandbox, null, { raw: JSON.stringify({ ...body, pad: 'x'.repeat(256 * 1024) }) }))).toBe(413);
            expect(await status(syncRequest(sandbox, body, { contentType: 'text/plain' }))).toBe(415);
            for (const bad of [{ ...body, protocol: 3 }, { ...body, ownerId: 'has space' }, { ...body, extra: 1 },
                { ...body, reports: [{ operationId: randomUUID(), attemptId: randomUUID(), status: 'completed', reason: 'NOT ok' }] },
                { ...body, reports: [{ operationId: randomUUID(), status: 'completed' }] }, { ...body, seq: 0 },
                { ...body, sessions: [{ resource: 'r', title: 't', open: true, status: 'busy' }] }]) {
                expect(await status(syncRequest(sandbox, bad))).toBe(400);
            }
            expect(await status(syncRequest(sandboxOf(alice, ids.aDeleted), body))).toBe(404);
            expect(await status(syncRequest(sandboxOf(bob, ids.a1), body))).toBe(404);
            expect(await status(syncRequest('guac-0000000000000000-0000000000000000', body))).toBe(404);
            expect(await status(syncRequest('../../etc', body))).toBe(401);
        });

        it('is off unless EZIL_EDITOR_BRIDGE=enabled and the Worker secret is set', async () => {
            const req = () => syncRequest(sandboxOf(alice, ids.a1), { protocol: 1, ownerId: 'w-x', epoch: 0, seq: 1 });
            vi.stubEnv('EZIL_EDITOR_BRIDGE', '');
            expect((await syncRoute(req())).status).toBe(503);
            vi.stubEnv('EZIL_EDITOR_BRIDGE', 'true');
            expect((await syncRoute(req())).status).toBe(503);
            vi.stubEnv('EZIL_EDITOR_BRIDGE', 'enabled');
            vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', ' ');
            expect((await syncRoute(req())).status).toBe(503);
        });
    });

    describe('send, deliver and report', () => {
        it('a delegated send reaches the session once, and its outcome and response come back as events', async () => {
            const { owner, epoch, sessions, resources } = await connect();
            const listed = await data<Session[]>(await read('agentSession.list', { computerId: ids.a1 }));
            expect(listed.map((s) => s.id).sort()).toEqual([...sessions].sort());
            expect(listed.every((s) => s.bridge === 'connected' && s.open && s.status === 'idle')).toBe(true);
            expect(JSON.stringify(listed)).not.toContain('vscode-chat-session');

            const key = randomUUID();
            const op = await data<Op>(await write('agentSession.send', { sessionId: sessions[0], text: 'run the tests', idempotencyKey: key }));
            expect(op).toMatchObject({ kind: 'send', status: 'queued', sessionId: sessions[0], idempotencyKey: key });
            expect(Date.parse(op.expiresAt!) - Date.now()).toBeGreaterThan(9 * 60_000);

            const handed = await sync({ ownerId: owner, epoch });
            expect(handed.owner === 'self' && handed.deliver).toEqual([expect.objectContaining({ operationId: op.id, kind: 'send', sessionResource: resources[0], text: 'run the tests' })]);
            const delivery = (handed as { deliver: Delivery[] }).deliver[0]!;
            expect(delivery.attemptId).toMatch(/^[0-9a-f-]{36}$/);
            expect(delivery.deliverWithinMs).toBeGreaterThan(9 * 60_000);
            expect(delivery.deliverWithinMs).toBeLessThanOrEqual(10 * 60_000);
            // Handed out exactly once: the next sync does not deliver it again.
            const again = await sync({ ownerId: owner, epoch });
            expect(again.owner === 'self' && again.deliver).toEqual([]);
            // Handed to the editor, not yet confirmed: "accepted", never "queued" (it may already be running).
            expect((await data<Op>(await read('agentSession.operation', { operationId: op.id }))).status).toBe('accepted');

            await sync({ ownerId: owner, epoch, reports: [{ operationId: op.id, status: 'running', requestId: 'request_1', mode: 'agent', selectedModelId: 'ezil/qwen3-coder-next' }] });
            expect(await data<Op>(await read('agentSession.operation', { operationId: op.id }))).toMatchObject({ status: 'running', mode: 'agent', selectedModelId: 'ezil/qwen3-coder-next' });
            await sync({ ownerId: owner, epoch, reports: [{ operationId: op.id, status: 'completed', responseText: 'All 12 tests pass.' }] });
            expect((await data<Op>(await read('agentSession.operation', { operationId: op.id }))).status).toBe('completed');
            // Terminal is final: a late or forged report cannot move it.
            const late = await sync({ ownerId: owner, epoch, reports: [{ operationId: op.id, status: 'uncertain' }] });
            expect(late.owner === 'self' && late.applied).toBe(0);

            const { events } = await data<{ events: { seq: number; kind: string; status?: string; text?: string; operationId: string }[] }>(
                await read('agentSession.events', { sessionId: sessions[0] }));
            expect(events.map((e) => [e.kind, e.status ?? e.text])).toEqual([
                ['operation', 'queued'], ['operation', 'accepted'], ['user', 'run the tests'], ['operation', 'running'], ['operation', 'completed'],
                ['assistant', 'All 12 tests pass.'],
            ]);
            expect(events.every((e) => e.operationId === op.id)).toBe(true);
            expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
            const page = await data<{ events: unknown[]; next: number | null }>(await read('agentSession.events', { sessionId: sessions[0], after: 2, limit: 2 }));
            expect([page.events.length, page.next]).toEqual([2, 4]);
        });

        it('busy or not open: back in the queue and delivered again; a definitive refusal is rejected', async () => {
            const { owner, epoch, sessions } = await connect();
            const op = await data<Op>(await write('agentSession.send', { sessionId: sessions[1], text: 'hello', idempotencyKey: randomUUID() }));
            await sync({ ownerId: owner, epoch });
            // Requeued with a pause (not handed straight back), then delivered again under a NEW attempt.
            const requeued = await sync({ ownerId: owner, epoch, reports: [{ operationId: op.id, status: 'not_delivered', reason: 'busy' }] });
            expect(requeued.owner === 'self' && requeued.deliver).toEqual([]);
            expect(await data<Op>(await read('agentSession.operation', { operationId: op.id }))).toMatchObject({ status: 'queued', reason: 'busy' });
            const firstAttempt = attempts.get(op.id);
            await ready(op.id);
            const redelivered = await sync({ ownerId: owner, epoch });
            expect(redelivered.owner === 'self' && redelivered.deliver.map((d) => d.operationId)).toEqual([op.id]);
            expect(attempts.get(op.id)).not.toBe(firstAttempt);
            await sync({ ownerId: owner, epoch, reports: [{ operationId: op.id, status: 'rejected', reason: 'unsupported_session' }] });
            expect(await data<Op>(await read('agentSession.operation', { operationId: op.id }))).toMatchObject({ status: 'rejected', reason: 'unsupported_session' });
            // A requeue is only taken for work still undelivered at this epoch.
            const after = await sync({ ownerId: owner, epoch, reports: [{ operationId: op.id, status: 'not_delivered' }] });
            expect(after.owner === 'self' && after.applied).toBe(0);
        });

        it('concurrent syncs by one owner hand each operation out exactly once; reordered ones are refused as replays', async () => {
            const { owner, epoch, sessions } = await connect();
            const ops = await Promise.all(sessions.map((sessionId, i) =>
                write('agentSession.send', { sessionId, text: `task ${i}`, idempotencyKey: randomUUID() }).then((r) => data<Op>(r))));
            const results = await Promise.all(Array.from({ length: 10 }, () => syncRaw({ ownerId: owner, epoch })));
            expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
            const delivered = results.flatMap((r) => (r.status === 200 && r.json.owner === 'self' ? r.json.deliver.map((d) => d.operationId) : []));
            expect(delivered.sort()).toEqual(ops.map((o) => o.id).sort());
        });
    });

    describe('one owner per computer, fenced by epoch', () => {
        it('a second window is refused while the first holds the lease; on takeover, held work becomes uncertain and old reports are refused', async () => {
            const a = await connect('window-a');
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'long task', idempotencyKey: randomUUID() }));
            await sync({ ownerId: 'window-a', epoch: a.epoch });
            await sync({ ownerId: 'window-a', epoch: a.epoch, reports: [{ operationId: op.id, status: 'running' }] });

            const refused = await sync({ ownerId: 'window-b', epoch: 0, sessions: [], reports: [{ operationId: op.id, status: 'completed' }] });
            expect(refused.owner).toBe('other');
            expect((await data<Op>(await read('agentSession.operation', { operationId: op.id }))).status).toBe('running');
            // Window B's empty session list was not taken either.
            expect((await data<Session[]>(await read('agentSession.list', { computerId: ids.a1 }))).length).toBe(2);

            // Window A stops syncing: the reader sees an unknown outcome at once, never "completed".
            await expireLease();
            expect((await data<Op>(await read('agentSession.operation', { operationId: op.id }))).status).toBe('uncertain');
            expect((await data<Session[]>(await read('agentSession.list', { computerId: ids.a1 })))
                .every((s) => s.bridge === 'disconnected' && s.status === 'unknown' && !s.open)).toBe(true);

            const b = await sync({ ownerId: 'window-b', epoch: 0 });
            expect(b.owner === 'self' && b.epoch).toBe(a.epoch + 1);
            const [row] = await client`SELECT status, reason FROM public.ezil_agent_operations WHERE id = ${op.id}::uuid`;
            expect(row).toMatchObject({ status: 'uncertain', reason: 'owner_changed' });
            // A comes back with its old epoch: refused as owner, and its report is not taken.
            const stale = await sync({ ownerId: 'window-a', epoch: a.epoch, reports: [{ operationId: op.id, status: 'completed' }] });
            expect(stale.owner).toBe('other');
            expect((await data<Op>(await read('agentSession.operation', { operationId: op.id }))).status).toBe('uncertain');
            // Even the current owner cannot report on work handed out at an earlier epoch.
            const b2 = await sync({ ownerId: 'window-b', epoch: (b as { epoch: number }).epoch, reports: [{ operationId: op.id, status: 'completed' }] });
            expect(b2.owner === 'self' && b2.applied).toBe(0);
        });

        it('the same owner after its lease lapsed (an editor restart) gets a new epoch and its held work is uncertain', async () => {
            const a = await connect('window-r');
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'x', idempotencyKey: randomUUID() }));
            await sync({ ownerId: 'window-r', epoch: a.epoch });
            await expireLease();
            const back = await sync({ ownerId: 'window-r', epoch: a.epoch, reports: [{ operationId: op.id, status: 'running' }] });
            expect(back.owner === 'self' && [back.epoch, back.applied]).toEqual([a.epoch + 1, 0]);
            expect((await data<Op>(await read('agentSession.operation', { operationId: op.id }))).status).toBe('uncertain');
        });

        it('no editor: queued_disconnected with an expiry; past it, expired and never delivered', async () => {
            const a = await connect();
            await expireLease();
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'later', idempotencyKey: randomUUID() }));
            expect(op.status).toBe('queued_disconnected');
            expect(op.expiresAt).toBeDefined();
            await client`UPDATE public.ezil_agent_operations SET expires_at = now() - interval '1 second' WHERE id = ${op.id}::uuid`;
            expect((await data<Op>(await read('agentSession.operation', { operationId: op.id }))).status).toBe('expired');
            const back = await sync({ ownerId: `w-${randomUUID()}`, epoch: 0 });
            expect(back.owner === 'self' && back.deliver).toEqual([]);
            const [row] = await client`SELECT status FROM public.ezil_agent_operations WHERE id = ${op.id}::uuid`;
            expect(row!.status).toBe('expired');
        });

        it('a session the editor no longer lists disappears and cannot be sent to', async () => {
            const a = await connect();
            await sync({ ownerId: a.owner, epoch: a.epoch, sessions: editorSessions(a.resources[0]!) });
            const listed = await data<Session[]>(await read('agentSession.list', { computerId: ids.a1 }));
            expect(listed.map((s) => s.id)).toEqual([a.sessions[0]]);
            const gone = await write('agentSession.send', { sessionId: a.sessions[1], text: 'x', idempotencyKey: randomUUID() });
            expect(await code(gone)).toBe('NOT_FOUND');
        });
    });

    describe('cancel one operation', () => {
        it('queued: withdrawn here and never delivered', async () => {
            const a = await connect();
            await expireLease();
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'x', idempotencyKey: randomUUID() }));
            const cancel = await data<Op>(await write('agentSession.cancel', { operationId: op.id, idempotencyKey: randomUUID() }));
            expect(cancel).toMatchObject({ kind: 'cancel', status: 'completed' });
            expect(await data<Op>(await read('agentSession.operation', { operationId: op.id }))).toMatchObject({ status: 'cancelled', reason: 'withdrawn' });
            const back = await sync({ ownerId: `w-${randomUUID()}`, epoch: 0 });
            expect(back.owner === 'self' && back.deliver).toEqual([]);
        });

        it('delivered: a cancel goes to the same owner; its outcome and the target\'s come back separately', async () => {
            const a = await connect();
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'x', idempotencyKey: randomUUID() }));
            await sync({ ownerId: a.owner, epoch: a.epoch });
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, status: 'running', requestId: 'r1' }] });
            const cancel = await data<Op>(await write('agentSession.cancel', { operationId: op.id, idempotencyKey: randomUUID() }));
            expect(cancel.status).toBe('queued');
            const handed = await sync({ ownerId: a.owner, epoch: a.epoch });
            expect(handed.owner === 'self' && handed.deliver).toEqual([expect.objectContaining({ operationId: cancel.id, kind: 'cancel', sessionResource: a.resources[0], targetOperationId: op.id })]);
            // An editor cannot mark a cancel "completed": that word means withdrawn before delivery.
            const forged = await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: cancel.id, status: 'completed' }] });
            expect(forged.owner === 'self' && forged.applied).toBe(0);
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [
                { operationId: cancel.id, status: 'cancel_requested' }, { operationId: op.id, status: 'cancel_requested' }] });
            const status = async (id: string) => (await data<Op>(await read('agentSession.operation', { operationId: id }))).status;
            expect([await status(cancel.id), await status(op.id)]).toEqual(['cancel_requested', 'cancel_requested']);
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, status: 'cancelled', responseText: 'Stopped.' }] });
            expect([await status(cancel.id), await status(op.id)]).toEqual(['cancelled', 'cancelled']);
        });

        it('asked to stop but the request finished anyway: the cancel is rejected as already_finished; lost ownership makes both uncertain', async () => {
            const a = await connect();
            const status = async (id: string) => (await data<Op>(await read('agentSession.operation', { operationId: id }))).status;
            const ops = [];
            for (const text of ['finishes', 'orphaned']) {
                const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text, idempotencyKey: randomUUID() }));
                await sync({ ownerId: a.owner, epoch: a.epoch });
                await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, status: 'running' }] });
                const cancel = await data<Op>(await write('agentSession.cancel', { operationId: op.id, idempotencyKey: randomUUID() }));
                await sync({ ownerId: a.owner, epoch: a.epoch });
                await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: cancel.id, status: 'cancel_requested' }, { operationId: op.id, status: 'cancel_requested' }] });
                ops.push({ op, cancel });
            }
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: ops[0]!.op.id, status: 'completed' }] });
            expect([await status(ops[0]!.cancel.id), await status(ops[0]!.op.id)]).toEqual(['rejected', 'completed']);
            expect((await data<Op>(await read('agentSession.operation', { operationId: ops[0]!.cancel.id }))).reason).toBe('already_finished');
            await expireLease();
            await sync({ ownerId: `w-${randomUUID()}`, epoch: 0 });
            expect([await status(ops[1]!.cancel.id), await status(ops[1]!.op.id)]).toEqual(['uncertain', 'uncertain']);
        });

        it('the editor cannot verify the request is ours: the cancel is rejected and the target keeps its status', async () => {
            const a = await connect();
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'x', idempotencyKey: randomUUID() }));
            await sync({ ownerId: a.owner, epoch: a.epoch });
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, status: 'running' }] });
            const cancel = await data<Op>(await write('agentSession.cancel', { operationId: op.id, idempotencyKey: randomUUID() }));
            await sync({ ownerId: a.owner, epoch: a.epoch });
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: cancel.id, status: 'rejected', reason: 'cannot_verify' }] });
            expect(await data<Op>(await read('agentSession.operation', { operationId: cancel.id }))).toMatchObject({ status: 'rejected', reason: 'cannot_verify' });
            expect((await data<Op>(await read('agentSession.operation', { operationId: op.id }))).status).toBe('running');
        });

        it('finished: rejected as already_finished; a cancel can only name a send', async () => {
            const a = await connect();
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'x', idempotencyKey: randomUUID() }));
            await sync({ ownerId: a.owner, epoch: a.epoch });
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, status: 'completed' }] });
            const cancel = await data<Op>(await write('agentSession.cancel', { operationId: op.id, idempotencyKey: randomUUID() }));
            expect(cancel).toMatchObject({ status: 'rejected', reason: 'already_finished' });
            expect(await code(await write('agentSession.cancel', { operationId: cancel.id, idempotencyKey: randomUUID() }))).toBe('NOT_FOUND');
        });
    });

    describe('idempotency and ownership', () => {
        it('the same key and input returns the original operation; another input under that key is CONFLICT', async () => {
            const a = await connect();
            const key = randomUUID();
            const input = { sessionId: a.sessions[0], text: 'once', idempotencyKey: key };
            const first = await data<Op>(await write('agentSession.send', input));
            const second = await data<Op>(await write('agentSession.send', input));
            expect(second.id).toBe(first.id);
            expect(await code(await write('agentSession.send', { ...input, text: 'twice' }))).toBe('CONFLICT');
            expect(await code(await write('agentSession.send', { ...input, sessionId: a.sessions[1] }))).toBe('CONFLICT');
            // Concurrent replays of one key create one operation.
            const raced = await Promise.all(Array.from({ length: 8 }, () => write('agentSession.send', input).then((r) => data<Op>(r))));
            expect(new Set(raced.map((o) => o.id))).toEqual(new Set([first.id]));
            const [{ count }] = await client`SELECT count(*)::int AS count FROM public.ezil_agent_operations WHERE idempotency_key = ${key}::uuid`;
            expect(count).toBe(1);
            // The key belongs to the person, not the connection: the same key through their own session
            // (no OAuth client) or another client finds the original, and other input is still CONFLICT.
            h.cookieUser = { id: alice };
            const own = (body: unknown) => trpcPost(new Request(new URL('/api/trpc/agentSession.send', OS), {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: body }) }));
            expect((await data<Op>(await own(input))).id).toBe(first.id);
            expect(await code(await own({ ...input, text: 'other' }))).toBe('CONFLICT');
        });

        it('a retry with the same key returns the original even after its session has gone', async () => {
            const a = await connect();
            const input = { sessionId: a.sessions[1], text: 'before it closed', idempotencyKey: randomUUID() };
            const first = await data<Op>(await write('agentSession.send', input));
            await sync({ ownerId: a.owner, epoch: a.epoch, sessions: editorSessions(a.resources[0]!) });
            expect((await data<Op>(await write('agentSession.send', input))).id).toBe(first.id);
        });

        it('text is 1 to 16384 UTF-8 bytes (not UTF-16 units) and not only whitespace', async () => {
            const a = await connect();
            const send = (text: string) => write('agentSession.send', { sessionId: a.sessions[0], text, idempotencyKey: randomUUID() });
            expect(Buffer.byteLength('€'.repeat(5462))).toBe(16386);
            expect(await code(await send('€'.repeat(5462)))).toBe('BAD_REQUEST');
            expect((await data<Op>(await send('€'.repeat(5461) + 'a'))).status).toBe('queued');
            expect(await code(await send('a'.repeat(16385)))).toBe('BAD_REQUEST');
            for (const blank of ['', ' ', '\n\t ']) expect(await code(await send(blank))).toBe('BAD_REQUEST');
        });

        it("another person's session or operation is NOT_FOUND, the same as a missing one, for every procedure", async () => {
            const bobSession = randomUUID();
            await client`INSERT INTO public.ezil_agent_sessions (id, computer_id, user_id, resource, title, present, open, status, seen_at, next_seq)
                VALUES (${bobSession}::uuid, ${ids.b1}::uuid, ${bob}::uuid, 'vscode-chat-session://local/bob', null, true, true, 'idle', now(), 0)`;
            const [bobOp] = await client`INSERT INTO public.ezil_agent_operations (id, session_id, computer_id, user_id, client_id, proc,
                idempotency_key, input_digest, kind, text, status, attempts, not_before, expires_at, created_at, updated_at)
                VALUES (gen_random_uuid(), ${bobSession}::uuid, ${ids.b1}::uuid, ${bob}::uuid, ${CLIENT}, 'agentSession.send', ${randomUUID()}::uuid, 'x', 'send',
                    'bob task', 'queued', 0, now(), now() + interval '1 hour', now(), now())
                RETURNING id`;
            for (const id of [bobSession, randomUUID()]) {
                expect(await code(await read('agentSession.get', { sessionId: id }))).toBe('NOT_FOUND');
                expect(await code(await read('agentSession.events', { sessionId: id }))).toBe('NOT_FOUND');
                expect(await code(await write('agentSession.send', { sessionId: id, text: 'x', idempotencyKey: randomUUID() }))).toBe('NOT_FOUND');
            }
            for (const id of [bobOp!.id as string, randomUUID()]) {
                expect(await code(await read('agentSession.operation', { operationId: id }))).toBe('NOT_FOUND');
                expect(await code(await write('agentSession.cancel', { operationId: id, idempotencyKey: randomUUID() }))).toBe('NOT_FOUND');
            }
            const listed = await data<Session[]>(await read('agentSession.list'));
            expect(listed.some((s) => s.id === bobSession)).toBe(false);
            expect(await data<Session[]>(await read('agentSession.list', { computerId: ids.b1 }))).toEqual([]);
            // Alice's editor cannot see, take or report Bob's work.
            const a = await connect();
            const handed = await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: bobOp!.id as string, status: 'completed' }] });
            expect(handed.owner === 'self' && [handed.deliver, handed.applied]).toEqual([[], 0]);
            const [row] = await client`SELECT status FROM public.ezil_agent_operations WHERE id = ${bobOp!.id}::uuid`;
            expect(row!.status).toBe('queued');
        });
    });

    describe('reproduced review findings (regressions)', () => {
        it('a re-owned computer: the new owner\'s editor never receives the previous owner\'s queued instruction', async () => {
            const a = await connect();
            const queued = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'alice only', idempotencyKey: randomUUID() }));
            const held = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[1], text: 'alice held', idempotencyKey: randomUUID() }));
            await sync({ ownerId: a.owner, epoch: a.epoch, sessions: editorSessions(a.resources[1]!) });
            await client`UPDATE public.ezil_agent_operations SET status = 'running' WHERE id = ${held.id}::uuid AND status = 'delivered'`;
            await client`UPDATE public.ezil_agent_operations SET status = 'queued', delivered_epoch = NULL, attempt_id = NULL WHERE id = ${queued.id}::uuid`;
            await client`UPDATE public.ezil_agent_sessions SET present = true WHERE id = ${a.sessions[0]}::uuid`;
            try {
                // The computer now belongs to Bob, and Bob's editor (same chat URIs) syncs within Alice's lease.
                await client`UPDATE public.ezil_computers SET user_id = ${bob}::uuid WHERE id = ${ids.a1}::uuid`;
                const bobSync = await sync({ ownerId: 'bob-window', epoch: 0, sessions: editorSessions(...a.resources) }, sandboxOf(bob, ids.a1));
                expect(bobSync.owner).toBe('self');
                const again = await sync({ ownerId: 'bob-window', epoch: (bobSync as { epoch: number }).epoch }, sandboxOf(bob, ids.a1));
                expect(again.owner === 'self' && again.deliver).toEqual([]);
                const rows = await client`SELECT id, status, reason FROM public.ezil_agent_operations WHERE id IN (${queued.id}::uuid, ${held.id}::uuid) ORDER BY text`;
                expect(rows.map((r) => [r.status, r.reason])).toEqual([['uncertain', 'computer_reassigned'], ['rejected', 'computer_reassigned']]);
                // Bob's sessions are his own rows; Alice's are gone from her list.
                const bobRows = await client`SELECT count(*)::int AS n FROM public.ezil_agent_sessions WHERE computer_id = ${ids.a1}::uuid AND user_id = ${bob}::uuid AND present`;
                expect(bobRows[0]!.n).toBe(2);
                expect(await data<Session[]>(await read('agentSession.list', { computerId: ids.a1 }))).toEqual([]);
            } finally {
                await client`UPDATE public.ezil_computers SET user_id = ${alice}::uuid WHERE id = ${ids.a1}::uuid`;
                await expireLease();
            }
        });

        it('a sync that waits on the owner lock past the lease end does not renew it: new epoch, its old report refused', async () => {
            const a = await connect();
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'x', idempotencyKey: randomUUID() }));
            await sync({ ownerId: a.owner, epoch: a.epoch });
            const blocker = postgres(URL_!, { max: 1, prepare: false, onnotice: () => {} });
            try {
                let release!: () => void;
                const held = new Promise<void>((resolve) => { release = resolve; });
                let locked!: () => void;
                const isLocked = new Promise<void>((resolve) => { locked = resolve; });
                const tx = blocker.begin(async (t) => {
                    await t`UPDATE public.ezil_editor_bridge_owner SET lease_until = clock_timestamp() + interval '400 milliseconds' WHERE computer_id = ${ids.a1}::uuid`;
                    locked();
                    await held;
                });
                await isLocked;
                const waiting = sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, status: 'completed' }] });
                await new Promise((resolve) => setTimeout(resolve, 900));
                release();
                await tx;
                const result = await waiting;
                expect(result.owner === 'self' && [result.epoch, result.applied]).toEqual([a.epoch + 1, 0]);
                const [row] = await client`SELECT status, reason FROM public.ezil_agent_operations WHERE id = ${op.id}::uuid`;
                expect(row).toMatchObject({ status: 'uncertain', reason: 'owner_changed' });
            } finally {
                await blocker.end();
            }
        });

        it('the exact same signed sync replayed is refused, and nothing is handed out twice', async () => {
            const a = await connect();
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'once', idempotencyKey: randomUUID() }));
            const body = syncBody({ ownerId: a.owner, epoch: a.epoch });
            const first = await syncRoute(syncRequest(sandboxOf(alice, ids.a1), body));
            expect(first.status).toBe(200);
            expect(((await first.json()) as { deliver: Delivery[] }).deliver.map((d) => d.operationId)).toEqual([op.id]);
            const replay = await syncRoute(syncRequest(sandboxOf(alice, ids.a1), body));
            expect(replay.status).toBe(409);
            expect(await replay.json()).toEqual({ error: 'replayed_sync' });
        });

        it('an old not_delivered report replayed later never requeues the new attempt', async () => {
            const a = await connect();
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'x', idempotencyKey: randomUUID() }));
            await sync({ ownerId: a.owner, epoch: a.epoch });
            const oldAttempt = attempts.get(op.id)!;
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, attemptId: oldAttempt, status: 'not_delivered', reason: 'busy' }] });
            await ready(op.id);
            await sync({ ownerId: a.owner, epoch: a.epoch });
            const newAttempt = attempts.get(op.id)!;
            expect(newAttempt).not.toBe(oldAttempt);
            const stale = await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, attemptId: oldAttempt, status: 'not_delivered', reason: 'busy' }] });
            expect(stale.owner === 'self' && [stale.applied, stale.deliver]).toEqual([0, []]);
            expect((await data<Op>(await read('agentSession.operation', { operationId: op.id }))).status).toBe('accepted');
            // A forged attempt id is refused the same way; the real one is taken.
            expect((await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, attemptId: randomUUID(), status: 'running' }] })) as { applied: number }).toMatchObject({ applied: 0 });
            expect((await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, attemptId: newAttempt, status: 'running' }] })) as { applied: number }).toMatchObject({ applied: 1 });
        });

        it('a delivered cancel whose target finishes first is settled (rejected as already_finished); its late report changes nothing', async () => {
            const a = await connect();
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'x', idempotencyKey: randomUUID() }));
            await sync({ ownerId: a.owner, epoch: a.epoch });
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, status: 'running' }] });
            const cancel = await data<Op>(await write('agentSession.cancel', { operationId: op.id, idempotencyKey: randomUUID() }));
            expect(cancel.targetOperationId).toBe(op.id);
            await sync({ ownerId: a.owner, epoch: a.epoch });
            expect((await data<Op>(await read('agentSession.operation', { operationId: cancel.id }))).status).toBe('accepted');
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: op.id, status: 'completed', responseText: 'done' }] });
            expect(await data<Op>(await read('agentSession.operation', { operationId: cancel.id }))).toMatchObject({ status: 'rejected', reason: 'already_finished' });
            const late = await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: cancel.id, status: 'cancel_requested' }] });
            expect(late.owner === 'self' && late.applied).toBe(0);
            expect((await data<Op>(await read('agentSession.operation', { operationId: cancel.id }))).status).toBe('rejected');
        });

        it('fair handout: one operation per session per sync, busy work backs off, a ready session is never starved', async () => {
            const a = await connect();
            const busy: Op[] = [];
            for (let i = 0; i < 5; i++) busy.push(await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: `busy ${i}`, idempotencyKey: randomUUID() })));
            const readyOp = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[1], text: 'ready', idempotencyKey: randomUUID() }));
            const first = await sync({ ownerId: a.owner, epoch: a.epoch });
            expect(first.owner === 'self' && first.deliver.map((d) => d.operationId).sort()).toEqual([busy[0]!.id, readyOp.id].sort());
            // The busy session refuses again and again; it backs off and only ever has one attempt out.
            for (let round = 0; round < 3; round++) {
                const handedNow = await sync({ ownerId: a.owner, epoch: a.epoch, reports: [...attempts.keys()]
                    .filter((id) => busy.some((b) => b.id === id)).map((operationId) => ({ operationId, status: 'not_delivered', reason: 'busy' })) });
                expect(handedNow.owner === 'self' && handedNow.deliver.length).toBeLessThanOrEqual(1);
                await client`UPDATE public.ezil_agent_operations SET not_before = now() WHERE session_id = ${a.sessions[0]}::uuid AND status = 'queued'`;
            }
            const backoff = await client`SELECT max(attempts)::int AS n FROM public.ezil_agent_operations WHERE session_id = ${a.sessions[0]}::uuid`;
            expect(backoff[0]!.n).toBeGreaterThan(1);
        });

        it('a second send to a session is not handed out while the first is with the editor and unreported', async () => {
            const a = await connect();
            const first = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'first', idempotencyKey: randomUUID() }));
            const second = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'second', idempotencyKey: randomUUID() }));
            const one = await sync({ ownerId: a.owner, epoch: a.epoch });
            expect(one.owner === 'self' && one.deliver.map((d) => d.operationId)).toEqual([first.id]);
            const two = await sync({ ownerId: a.owner, epoch: a.epoch });
            expect(two.owner === 'self' && two.deliver).toEqual([]);
            const three = await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: first.id, status: 'running' }] });
            expect(three.owner === 'self' && three.deliver.map((d) => d.operationId)).toEqual([second.id]);
        });

        it('a failed or rejected report without a reason is stored with reason "unspecified"', async () => {
            const a = await connect();
            const ops = [];
            for (const sessionId of a.sessions) ops.push(await data<Op>(await write('agentSession.send', { sessionId, text: 'x', idempotencyKey: randomUUID() })));
            await sync({ ownerId: a.owner, epoch: a.epoch });
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [{ operationId: ops[0]!.id, status: 'failed' }, { operationId: ops[1]!.id, status: 'rejected' }] });
            for (const op of ops) expect((await data<Op>(await read('agentSession.operation', { operationId: op.id }))).reason).toBe('unspecified');
        });

        it('handed out and never reported: uncertain after the report timeout, never redelivered', async () => {
            const a = await connect();
            const op = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'x', idempotencyKey: randomUUID() }));
            await sync({ ownerId: a.owner, epoch: a.epoch });
            await client`UPDATE public.ezil_agent_operations SET delivered_at = now() - interval '3 minutes' WHERE id = ${op.id}::uuid`;
            const next = await sync({ ownerId: a.owner, epoch: a.epoch });
            expect(next.owner === 'self' && next.deliver).toEqual([]);
            expect(await data<Op>(await read('agentSession.operation', { operationId: op.id }))).toMatchObject({ status: 'uncertain', reason: 'no_report' });
        });

        it('expired at the workbench, failed responses, and one assistant event per finished send even when empty', async () => {
            const a = await connect();
            const late = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[0], text: 'too late', idempotencyKey: randomUUID() }));
            const failing = await data<Op>(await write('agentSession.send', { sessionId: a.sessions[1], text: 'fails', idempotencyKey: randomUUID() }));
            await sync({ ownerId: a.owner, epoch: a.epoch });
            await sync({ ownerId: a.owner, epoch: a.epoch, reports: [
                { operationId: late.id, status: 'expired', reason: 'deadline_passed' },
                { operationId: failing.id, status: 'failed', reason: 'model_error', requestId: 'r9' }] });
            expect((await data<Op>(await read('agentSession.operation', { operationId: late.id }))).status).toBe('expired');
            expect(await data<Op>(await read('agentSession.operation', { operationId: failing.id }))).toMatchObject({ status: 'failed', reason: 'model_error' });
            const { events } = await data<{ events: { kind: string; text?: string; operationId: string }[] }>(await read('agentSession.events', { sessionId: a.sessions[1] }));
            const mine = events.filter((e) => e.operationId === failing.id);
            expect(mine.filter((e) => e.kind === 'assistant')).toEqual([expect.objectContaining({ kind: 'assistant', text: '' })]);
            const lateEvents = (await data<{ events: { kind: string; operationId: string }[] }>(await read('agentSession.events', { sessionId: a.sessions[0] })))
                .events.filter((e) => e.operationId === late.id);
            expect(lateEvents.some((e) => e.kind === 'user' || e.kind === 'assistant')).toBe(false);
        });

        it('a send whose computer is deleted right after it commits still returns the recorded operation, never NOT_FOUND', async () => {
            const a = await connect();
            const { sendInstruction } = await import('./store');
            const side = postgres(URL_!, { max: 1, prepare: false, onnotice: () => {} });
            const db = h.db as import('./store').SessionDb;
            const racing: import('./store').SessionDb = {
                execute: (q) => db.execute(q),
                transaction: (run) => db.transaction((tx) => run({
                    execute: async (q) => {
                        const text = JSON.stringify(q);
                        if (text.includes('agent-session:op')) await side`UPDATE public.ezil_computers SET deleted_at = now() WHERE id = ${ids.a1}::uuid`;
                        return tx.execute(q);
                    },
                })),
            };
            try {
                const op = await sendInstruction(racing, { userId: alice, clientId: CLIENT }, { sessionId: a.sessions[0]!, text: 'x', idempotencyKey: randomUUID() });
                expect(op.kind).toBe('send');
                expect(await code(await read('agentSession.operation', { operationId: op.id }))).toBe('NOT_FOUND');
            } finally {
                await side`UPDATE public.ezil_computers SET deleted_at = NULL WHERE id = ${ids.a1}::uuid`;
                await side.end();
            }
        });
    });

    describe('delegated POST body bound', () => {
        it('a body over 64 KiB is refused while streaming, whether its length is missing, understated or chunked', async () => {
            const a = await connect();
            const key = randomUUID();
            const body = JSON.stringify({ json: { sessionId: a.sessions[0], text: 'x'.repeat(70_000), idempotencyKey: key } });
            const assertion = await sign('ezil:sessions:write', 'agentSession.send', body);
            const chunks = (text: string) => new ReadableStream<Uint8Array>({
                start(controller) { const bytes = Buffer.from(text); for (let i = 0; i < bytes.length; i += 8192) controller.enqueue(bytes.subarray(i, i + 8192)); controller.close(); },
            });
            for (const length of [undefined, '10', '65536']) {
                const response = await trpcPost(new Request(new URL('/api/trpc/agentSession.send', OS), {
                    method: 'POST', body: chunks(body), duplex: 'half',
                    headers: { authorization: `EZiL-Delegation ${assertion}`, 'content-type': 'application/json', ...(length ? { 'content-length': length } : {}) },
                } as RequestInit));
                expect([length, response.status]).toEqual([length, 413]);
            }
            const declared = await trpcPost(new Request(new URL('/api/trpc/agentSession.send', OS), {
                method: 'POST', body, headers: { authorization: `EZiL-Delegation ${assertion}`, 'content-type': 'application/json' } }));
            expect(declared.status).toBe(413);
            const [{ count }] = await client`SELECT count(*)::int AS count FROM public.ezil_agent_operations WHERE idempotency_key = ${key}::uuid`;
            expect(count).toBe(0);
        });
    });

    describe('delegated transport for sessions', () => {
        it('a mutation by GET, a query by POST, the read scope on a write, and a non-envelope body are all refused', async () => {
            const a = await connect();
            const input = { sessionId: a.sessions[0], text: 'x', idempotencyKey: randomUUID() };
            const serialized = JSON.stringify({ json: input });
            const url = new URL('/api/trpc/agentSession.send', OS);
            url.searchParams.set('input', serialized);
            const byGet = await trpcGet(new Request(url, { headers: { authorization: `EZiL-Delegation ${await sign('ezil:sessions:write', 'agentSession.send', serialized)}` } }));
            // tRPC itself refuses a mutation over GET (405) before the gate would (401); either way nothing runs.
            expect([401, 405]).toContain(byGet.status);
            const listBody = JSON.stringify({ json: {} });
            const listByPost = await trpcPost(new Request(new URL('/api/trpc/agentSession.list', OS), {
                method: 'POST', body: listBody,
                headers: { authorization: `EZiL-Delegation ${await sign('ezil:sessions:read', 'agentSession.list', listBody)}`, 'content-type': 'application/json' } }));
            expect([401, 405]).toContain(listByPost.status);
            expect((await write('agentSession.send', input, {}, 'ezil:sessions:read')).status).toBe(401);
            expect((await write('agentSession.send', input, {}, 'ezil:computers:read')).status).toBe(401);
            const meta = JSON.stringify({ json: input, meta: { values: {} } });
            const withMeta = await trpcPost(new Request(new URL('/api/trpc/agentSession.send', OS), {
                method: 'POST', body: meta,
                headers: { authorization: `EZiL-Delegation ${await sign('ezil:sessions:write', 'agentSession.send', meta)}`, 'content-type': 'application/json' } }));
            expect(withMeta.status).toBe(401);
            // The assertion is bound to the exact body bytes.
            const body = JSON.stringify({ json: input });
            const assertion = await sign('ezil:sessions:write', 'agentSession.send', body);
            const swapped = await trpcPost(new Request(new URL('/api/trpc/agentSession.send', OS), {
                method: 'POST', body: JSON.stringify({ json: { ...input, text: 'rm -rf' } }),
                headers: { authorization: `EZiL-Delegation ${assertion}`, 'content-type': 'application/json' } }));
            expect(swapped.status).toBe(401);
            const [{ count }] = await client`SELECT count(*)::int AS count FROM public.ezil_agent_operations WHERE idempotency_key = ${input.idempotencyKey}::uuid`;
            expect(count).toBe(0);
        });
    });
});
