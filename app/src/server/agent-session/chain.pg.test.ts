/**
 * The whole OS <-> editor path in one process, every hop real except the chat model:
 *
 *   delegated POST /api/trpc/agentSession.send  (real route, verifier, gate, router)
 *   -> Postgres queue                           (real 0023 tables)
 *   <- extension sync client                    (extensions/ezil-models/src/chat-bridge-client.ts)
 *   -> Worker /editor-bridge/v1/sync            (worker/src/editor-bridge.ts: boot-token check, signed forward)
 *   -> OS /api/editor-bridge/v1/sync            (real route: signature, sandbox -> computer, lease, handout)
 *   -> workbench bridge                         (worker/copilot-chat/chat-bridge.js, evaluated as shipped)
 *   -> FAKE code-server 4.141.0 chat service    (worker/copilot-chat/chat-bridge-fake.cjs)
 *
 * Mock boundary: the chat service and its model are fakes; Supabase's cookie client is stubbed; the
 * Worker's Durable Object / tunnel record is replaced by the nonce passed in. Nothing here proves the
 * real workbench at runtime.
 *   DELEGATION_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres
 */
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import superjson from 'superjson';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';

import { ensureTestSchema } from './pg-test-schema';

// Loaded at run time from the other packages, so this app's typecheck does not compile them under its own lib
// settings (each package typechecks itself). The shapes used here are declared below.
const REPO = path.resolve(__dirname, '../../../..');
type BridgeClient = { tick(): Promise<number> };
type ClientCtor = new (deps: {
    syncUrl: string; token: string; ownerId: string; execute: (request: Record<string, unknown>) => Promise<unknown>;
    fetch: (url: string, init: RequestInit) => Promise<Response>; log: (line: string) => void;
    effortOf?: (modelId: string) => string | null; availableIds?: (ids: string[]) => Promise<Set<string>>;
}) => BridgeClient;
let ChatBridgeClient: ClientCtor;
let parseModelsConfig: (text: string) => { models: { id: string }[] };
let accountAvailableIds: (models: readonly { id: string }[], ids: readonly string[], doFetch: typeof fetch) => Promise<Set<string>>;
let sentEffort: (model: { id: string }) => string | null;
let deriveAiProxyToken: (secret: string, sandboxId: string, nonce: string) => Promise<string>;
let deriveEditorBridgeToken: (secret: string, sandboxId: string, nonce: string) => Promise<string>;
let handleEditorBridgeRequest: (request: Request, deps: {
    sandboxId: string; osUrl: string | null; secret: string | null; nonce: string | null;
    fetch: (request: Request) => Promise<Response>; now: () => number; log: (fields: Record<string, unknown>) => void;
}) => Promise<Response>;

const MCP = 'https://mcp-staging.ezil.work';
const OS = 'https://os-staging.ezil.work';
const SUPABASE = 'https://btgqfmnzycdecmeyqubx.supabase.co';
const CLIENT = 'https://chatgpt.com/oauth/client.json';
const WORKER_SECRET = 'worker-secret-for-chain-tests-only';

const h = vi.hoisted(() => ({ db: undefined as unknown, cookieUser: null as { id: string } | null }));
vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/db', () => ({ get db() { return h.db; } }));
vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.cookieUser }, error: null }) } }),
}));

type FakeModel = { requests: { id: string; response: { text: string; isComplete: boolean; finish: (canceled: boolean) => void } }[] };
type FakeWorld = {
    bridge: { handle(request: unknown): Promise<unknown>; dispose(): void };
    models: Map<string, FakeModel>;
    calls: { send: { id: string; text: string }[]; cancel: unknown[]; started: number; opened: { id: string; target: unknown; options: unknown }[];
        switched: { id: string; identifier: string; persist: boolean; userAction: boolean }[] };
    open: string[];
    widget(id: string): { input: { currentLanguageModel: string } };
};
let fake: {
    world: (opts?: { sessions?: string[]; open?: string[] }) => FakeWorld;
};

const URL_ = process.env.DELEGATION_TEST_DATABASE_URL;
const compact = (id: string) => id.replace(/-/g, '').toLowerCase().slice(0, 16);

describe.skipIf(!URL_)('OS <-> editor chain (real OS, Worker forwarder, extension client and workbench bridge; fake chat model)', () => {
    let client: ReturnType<typeof postgres>;
    let signer: { kid: string; privateKey: webcrypto.CryptoKey };
    let trpcGet: (req: Request) => Promise<Response>;
    let trpcPost: (req: Request) => Promise<Response>;
    let syncRoute: (req: Request) => Promise<Response>;
    const alice = randomUUID();
    const computer = randomUUID();
    const sandbox = `guac-${compact(alice)}-${compact(computer)}`;
    let env: Record<string, string> = {};
    const forwarded: { status: number }[] = [];

    const sign = async (scope: string, proc: string, bytes: string) => {
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: MCP, aud: OS, sub: alice, idp_iss: `${SUPABASE}/auth/v1`, client_id: CLIENT, scope, proc,
            inp: createHash('sha256').update(bytes, 'utf8').digest('base64url'), jti: randomUUID(), iat: now, exp: now + 60 };
        const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
        const input = `${b64({ alg: 'ES256', typ: 'ezil-delegation+jwt', kid: signer.kid })}.${b64(claims)}`;
        const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.privateKey, new TextEncoder().encode(input));
        return `${input}.${Buffer.from(sig).toString('base64url')}`;
    };
    const unwrap = async <T>(response: Response) => {
        const json = await response.json();
        if (!json.result) throw new Error(`expected a result, got ${response.status} ${JSON.stringify(json)}`);
        return superjson.deserialize(json.result.data) as T;
    };
    const read = async <T>(proc: string, input: unknown) => {
        const serialized = JSON.stringify({ json: input });
        const url = new URL(`/api/trpc/${proc}`, OS);
        url.searchParams.set('input', serialized);
        return unwrap<T>(await trpcGet(new Request(url, { headers: { authorization: `EZiL-Delegation ${await sign('ezil:sessions:read', proc, serialized)}` } })));
    };
    const write = async <T>(proc: string, input: unknown) => {
        const body = JSON.stringify({ json: input });
        return unwrap<T>(await trpcPost(new Request(new URL(`/api/trpc/${proc}`, OS), {
            method: 'POST', body, headers: { authorization: `EZiL-Delegation ${await sign('ezil:sessions:write', proc, body)}`, 'content-type': 'application/json' } })));
    };
    type Op = { id: string; status: string; reason?: string; mode?: string; selectedModelId?: string };
    const op = (id: string) => read<Op>('agentSession.operation', { operationId: id });

    /** An editor window: the shipped bridge over a fake chat service, and the real extension client syncing through the real Worker code. */
    const editor = async (w: FakeWorld, nonce: string, workerNonce: () => string | null = () => nonce, token?: string,
        opts: { availableIds?: (ids: string[]) => Promise<Set<string>>; effortOf?: (id: string) => string | null } = {}) => {
        const logs: string[] = [];
        const bodies: Record<string, unknown>[] = [];
        const sync = new ChatBridgeClient({
            syncUrl: `https://8443-${sandbox}-code.ezil.work/editor-bridge/v1/sync`,
            token: token ?? await deriveEditorBridgeToken(WORKER_SECRET, sandbox, nonce),
            ownerId: `ext.${randomUUID()}`,
            execute: (request) => w.bridge.handle(request),
            effortOf: opts.effortOf,
            availableIds: opts.availableIds,
            fetch: async (url, init) => {
                if (typeof init.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>);
                return handleEditorBridgeRequest(new Request(url, init), {
                    sandboxId: sandbox, osUrl: OS, secret: WORKER_SECRET, nonce: workerNonce(),
                    fetch: async (forward) => { const res = await syncRoute(forward); forwarded.push({ status: res.status }); return res; },
                    now: () => Date.now(), log: () => {},
                });
            },
            log: (line) => logs.push(line),
        });
        return { sync, logs, bodies, tick: async (n = 1) => { for (let i = 0; i < n; i++) await sync.tick(); } };
    };
    /** Skip a requeued operation's back-off so the next round can hand it out. */
    const ready = () => client`UPDATE public.ezil_agent_operations SET not_before = now() - interval '1 second' WHERE computer_id = ${computer}::uuid AND status = 'queued'`;
    const sessionIds = async () => {
        const rows = await client`SELECT id, resource FROM public.ezil_agent_sessions WHERE computer_id = ${computer}::uuid AND present`;
        return Object.fromEntries(rows.map((r) => [String(r.resource).split('/').pop()!, String(r.id)])) as Record<string, string>;
    };

    beforeAll(async () => {
        // Resolve desktop fixtures only when the database integration suite actually runs.
        fake = createRequire(import.meta.url)('../../../../worker/copilot-chat/chat-bridge-fake.cjs');
        client = postgres(URL_!, { max: 8, prepare: false, onnotice: () => {} });
        h.db = drizzle(client, { schema });
        await ensureTestSchema(client);
        await client`INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (${alice}::uuid, 'chain@example.com', now())`;
        await client`INSERT INTO public.ezil_computers (id, user_id, slot) VALUES (${computer}::uuid, ${alice}::uuid, 1)`;
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
        const load = (file: string) => import(/* @vite-ignore */ path.join(REPO, file));
        ({ ChatBridgeClient } = await load('extensions/ezil-models/src/chat-bridge-client.ts'));
        ({ parseModelsConfig } = await load('extensions/ezil-models/src/config.ts'));
        ({ accountAvailableIds } = await load('extensions/ezil-models/src/gateway.ts'));
        ({ sentEffort } = await load('extensions/ezil-models/src/client.ts'));
        ({ deriveAiProxyToken } = await load('worker/src/ai-proxy.ts'));
        ({ handleEditorBridgeRequest, deriveEditorBridgeToken } = await load('worker/src/editor-bridge.ts'));
    }, 60_000);
    beforeEach(() => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); });
    afterEach(() => { vi.unstubAllEnvs(); });
    afterAll(async () => { await client?.end(); });

    it('send -> the same open session runs it -> completed, with that request\'s response; cancel stops only ours; a closed session waits until opened', async () => {
        const w = fake.world({ sessions: ['s1', 's2'], open: ['s1'] });
        const a = await editor(w, 'boot-1');
        await a.tick(2);
        const ids = await sessionIds();
        expect(Object.keys(ids).sort()).toEqual(['s1', 's2']);
        const listed = await read<{ id: string; status: string; bridge: string; open: boolean }[]>('agentSession.list', { computerId: computer });
        expect(listed.find((s) => s.id === ids.s1)).toMatchObject({ bridge: 'connected', open: true, status: 'idle' });
        expect(listed.find((s) => s.id === ids.s2)).toMatchObject({ bridge: 'connected', open: false, status: 'unknown' });

        // 1) send and complete
        const sent = await write<Op>('agentSession.send', { sessionId: ids.s1, text: 'Add a README section', idempotencyKey: randomUUID() });
        await a.tick();
        expect(w.calls.send.map((c) => [c.id, c.text])).toEqual([['s1', 'Add a README section']]);
        await a.tick();
        expect(await op(sent.id)).toMatchObject({ status: 'running', mode: 'ask', selectedModelId: 'ezil/kimi-k2' });
        const request = w.models.get('s1')!.requests.at(-1)!;
        request.response.text = 'Added "Getting started" to README.md.';
        request.response.finish(false);
        await a.tick(2);
        expect((await op(sent.id)).status).toBe('completed');
        const { events } = await read<{ events: { kind: string; text?: string; status?: string; operationId: string }[] }>('agentSession.events', { sessionId: ids.s1 });
        expect(events.filter((e) => e.operationId === sent.id).map((e) => [e.kind, e.text ?? e.status])).toEqual([
            ['operation', 'queued'], ['operation', 'accepted'], ['user', 'Add a README section'], ['operation', 'running'], ['operation', 'completed'],
            ['assistant', 'Added "Getting started" to README.md.'],
        ]);
        // Never re-sent, however many rounds pass.
        await a.tick(3);
        expect(w.calls.send).toHaveLength(1);

        // 2) cancel a running request: only ours is stopped
        const long = await write<Op>('agentSession.send', { sessionId: ids.s1, text: 'Refactor everything', idempotencyKey: randomUUID() });
        await a.tick(2);
        expect((await op(long.id)).status).toBe('running');
        const cancel = await write<Op>('agentSession.cancel', { operationId: long.id, idempotencyKey: randomUUID() });
        expect(cancel.status).toBe('queued');
        await a.tick(2);
        expect(w.calls.cancel).toHaveLength(1);
        expect([(await op(cancel.id)).status, (await op(long.id)).status]).toEqual(['cancelled', 'cancelled']);

        // 3) the person's own request is running: our send waits (busy), it is not queued behind theirs inside the pane
        const model = w.models.get('s1') as unknown as { requestInProgress: { value: boolean } };
        model.requestInProgress.value = true;
        const waits = await write<Op>('agentSession.send', { sessionId: ids.s1, text: 'After yours', idempotencyKey: randomUUID() });
        await a.tick(2);
        expect(w.calls.send).toHaveLength(2);
        expect(await op(waits.id)).toMatchObject({ status: 'queued', reason: 'busy' });
        model.requestInProgress.value = false;
        await ready();
        await a.tick(2);
        expect(w.calls.send).toHaveLength(3);
        expect((await op(waits.id)).status).toBe('running');
        w.models.get('s1')!.requests.at(-1)!.response.finish(false);
        await a.tick(2);
        expect((await op(waits.id)).status).toBe('completed');

        // 4) a session that is not open stays queued (not_open) until the person opens it
        const closed = await write<Op>('agentSession.send', { sessionId: ids.s2, text: 'In the other chat', idempotencyKey: randomUUID() });
        await a.tick(2);
        expect(await op(closed.id)).toMatchObject({ status: 'queued', reason: 'not_open' });
        expect(w.calls.send.some((c) => c.id === 's2')).toBe(false);
        w.open.push('s2');
        await ready();
        await a.tick(3);
        expect(w.calls.send.filter((c) => c.id === 's2').map((c) => c.text)).toEqual(['In the other chat']);
        expect((await op(closed.id)).status).toBe('running');
        expect(forwarded.every((f) => f.status === 200)).toBe(true);
    });

    it('the AI proxy token alone cannot authorize chat control: the Worker refuses it and OS never sees the sync', async () => {
        const w = fake.world({ sessions: ['s1'], open: ['s1'] });
        const before = forwarded.length;
        const withAiToken = await editor(w, 'boot-1', () => 'boot-1', await deriveAiProxyToken(WORKER_SECRET, sandbox, 'boot-1'));
        await withAiToken.tick(3);
        expect(forwarded.length).toBe(before);
        expect(withAiToken.logs.some((line) => line.includes('HTTP 401'))).toBe(true);
        expect(w.calls.send).toHaveLength(0);
    });

    it('a second window never delivers; a restarted computer\'s old token is refused; held work becomes uncertain, never redelivered', async () => {
        await client`DELETE FROM public.ezil_editor_bridge_owner WHERE computer_id = ${computer}::uuid`;
        const w1 = fake.world({ sessions: ['s1'], open: ['s1'] });
        let currentNonce = 'boot-1';
        const one = await editor(w1, 'boot-1', () => currentNonce);
        await one.tick(2);
        const ids = await sessionIds();
        const held = await write<Op>('agentSession.send', { sessionId: ids.s1, text: 'Held by window one', idempotencyKey: randomUUID() });

        const w2 = fake.world({ sessions: ['s1'], open: ['s1'] });
        const two = await editor(w2, 'boot-1', () => currentNonce);
        await two.tick(3);
        expect(w2.calls.send).toHaveLength(0);
        await one.tick(2);
        expect(w1.calls.send.map((c) => c.text)).toEqual(['Held by window one']);
        expect((await op(held.id)).status).toBe('running');

        // The computer restarts: a new boot nonce. Window one's token (old boot) is refused by the Worker.
        currentNonce = 'boot-2';
        const before = forwarded.length;
        await one.tick();
        expect(forwarded.length).toBe(before);
        expect(one.logs.some((line) => line.includes('HTTP 401'))).toBe(true);
        // The reader already sees the unknown outcome once window one's lease lapses.
        await client`UPDATE public.ezil_editor_bridge_owner SET lease_until = now() - interval '1 second' WHERE computer_id = ${computer}::uuid`;
        expect((await op(held.id)).status).toBe('uncertain');

        // The restarted editor (new boot token, new window) takes over; the held instruction is never sent again.
        const w3 = fake.world({ sessions: ['s1'], open: ['s1'] });
        const three = await editor(w3, 'boot-2', () => currentNonce);
        await three.tick(3);
        expect(w3.calls.send).toHaveLength(0);
        const [row] = await client`SELECT status, reason FROM public.ezil_agent_operations WHERE id = ${held.id}::uuid`;
        expect(row).toMatchObject({ status: 'uncertain', reason: 'owner_changed' });
        // New work flows to the new owner only.
        const fresh = await write<Op>('agentSession.send', { sessionId: ids.s1, text: 'After restart', idempotencyKey: randomUUID() });
        await three.tick(2);
        expect(w3.calls.send.map((c) => c.text)).toEqual(['After restart']);
        expect((await op(fresh.id)).status).toBe('running');
        expect(w1.calls.send).toHaveLength(1);
    });
    describe('protocol 2 against the real client and the real workbench bridge', { timeout: 30_000 }, () => {
        const CONTROLS = { EZIL_EDITOR_BRIDGE_CONTROLS: 'enabled' };
        type Row = { id: string; status: string; reason: string | null; sessionId: string | null; requested: { model: string | null; effort: string | null };
            effective: { model: string | null; effort: string | null; source: string } | null };
        // A new editor on a clean slate: the fake workbench names its created chats new1, new2, ... so earlier tests' rows would collide
        // (which OS rightly refuses to treat as a session it created).
        const fresh = async () => {
            await client`DELETE FROM public.ezil_editor_bridge_owner WHERE computer_id = ${computer}::uuid`;
            await client`DELETE FROM public.ezil_control_operations WHERE computer_id = ${computer}::uuid`;
            await client`DELETE FROM public.ezil_agent_events WHERE session_id IN (SELECT id FROM public.ezil_agent_sessions WHERE computer_id = ${computer}::uuid)`;
            await client`DELETE FROM public.ezil_agent_operations WHERE computer_id = ${computer}::uuid`;
            await client`DELETE FROM public.ezil_agent_sessions WHERE computer_id = ${computer}::uuid`;
        };
        /** Run the editor's rounds while a control request is in flight, until it answers. */
        const drive = async <T>(a: { tick: (n?: number) => Promise<void> }, pending: Promise<T>) => {
            let done = false;
            const settled = pending.finally(() => { done = true; });
            for (let i = 0; i < 80 && !done; i += 1) {
                await a.tick();
                await new Promise((r) => setTimeout(r, 30));
            }
            return settled;
        };
        const sessionBy = async (id: string) => (await client`SELECT * FROM public.ezil_agent_sessions WHERE id = ${id}::uuid`)[0]!;

        it('negotiates protocol 2; a client with no account evidence (no availableIds) is never attested, so models stay unavailable with the exact gap; a create with no model really creates a chat and reads back the runtime model', async () => {
            for (const [k, v] of Object.entries(CONTROLS)) vi.stubEnv(k, v);
            await fresh();
            const w = fake.world({ sessions: ['s1'], open: ['s1'] });
            const a = await editor(w, 'boot-p2');
            await a.tick(3);
            expect(a.bodies.map((b) => b.protocol)).toEqual([1, 2, 2]);
            const catalog = (a.bodies[1] as { catalog: { status: string; models: Record<string, unknown>[] } }).catalog;
            expect(catalog.status).toBe('available');
            expect(catalog.models.map((m) => m.id)).toEqual(['ezil/kimi-k2', 'ezil/qwen']);
            expect(catalog.models.every((m) => !('availability' in m) && (m.efforts as unknown[]).length === 0)).toBe(true);
            const models = await read<Record<string, unknown>>('agentSession.models', { computerId: computer });
            expect(models).toMatchObject({ catalog: 'unavailable', models: [] });
            expect(String(models.reason)).toMatch(/configured for every account/);
            expect(models).not.toHaveProperty('accountScoped');

            const ids = await sessionIds();
            const settings = await read<{ settings: Record<string, unknown> }>('agentSession.settings', { sessionId: ids.s1 });
            expect(settings.settings).toMatchObject({ model: 'ezil/kimi-k2', effort: null, effortSupported: false, source: 'runtime' });

            const key = randomUUID();
            const row = await drive(a, write<Row>('agentSession.create', { computerId: computer, idempotencyKey: key }));
            expect(row).toMatchObject({ status: 'applied', requested: { model: null, effort: null }, effective: { model: 'ezil/kimi-k2', effort: null, source: 'runtime' },
                reason: 'ephemeral_until_first_send' });
            expect(w.calls.started).toBe(1);
            expect(w.calls.opened.map((o) => o.id)).toEqual(['new1']);
            const made = await sessionBy(row.sessionId!);
            expect(made).toMatchObject({ resource: 'vscode-chat-session://local/new1', created_by_os: true, created_control_id: row.id, request_count: 0 });
            // The retry is the stored row, and nothing is created twice however many rounds follow.
            expect(await write<Row>('agentSession.create', { computerId: computer, idempotencyKey: key })).toEqual(row);
            await a.tick(3);
            expect(w.calls.started).toBe(1);
            // A model with no attestation is refused at OS; an effort is refused before anything is stored.
            expect(await write<Row>('agentSession.create', { computerId: computer, model: 'ezil/qwen', idempotencyKey: randomUUID() }))
                .toMatchObject({ status: 'rejected', reason: 'catalog_unavailable' });
            await expect(write('agentSession.create', { computerId: computer, effort: 'high', idempotencyKey: randomUUID() })).rejects.toThrow(/effort_not_per_session/);
            expect(w.calls.started).toBe(1);
        });

        it('with real Gateway evidence for this token (the extension\'s own read, a Gateway stand-in): models are attested; create and configure apply to THAT session only; busy is busy; reveal reaches only OS-created chats', async () => {
            for (const [k, v] of Object.entries(CONTROLS)) vi.stubEnv(k, v);
            await fresh();
            const w = fake.world({ sessions: ['s1'], open: ['s1'] });
            // The extension's own account evidence: its real config parser and Gateway read, against a Gateway stand-in that allows
            // both models for this computer's token. Nothing adds `availability` to a sync body.
            const aliases = { 'kimi-k2': 'us.moonshotai.kimi-k3', qwen: 'qwen.qwen3-coder-next' };
            const config = parseModelsConfig(JSON.stringify({
                providers: { ezil: { type: 'ezil-gateway', baseUrl: 'http://gateway.test/ai/v1', apiKey: 'tok-chain-p2b' } },
                models: Object.entries(aliases).map(([id, model]) => ({ id, model, name: id, provider: 'ezil', maxInputTokens: 131072, maxOutputTokens: 4096 })),
            }));
            const gatewayReads: string[] = [];
            const gateway = (async (url: string, init: RequestInit) => {
                gatewayReads.push(`${String(url)} ${(init.headers as Record<string, string>).authorization}`);
                return Response.json({ contract: 'ezil.gateway.models.v1', killswitch: false, pause: null,
                    data: Object.values(aliases).map((id) => ({ id, enabled: true, max_input_tokens: 131072, max_output_tokens: 4096, protocols: ['anthropic-messages'],
                        availability: { state: 'available', reasons: [] } })) });
            }) as unknown as typeof fetch;
            const a = await editor(w, 'boot-p2b', undefined, undefined, {
                availableIds: (ids) => accountAvailableIds(config.models, ids, gateway),
                effortOf: (id) => { const m = config.models.find((x) => x.id === id); return m ? sentEffort(m) : null; },
            });
            await a.tick(3);
            const models = await read<{ catalog: string; accountScoped?: boolean; models: { id: string; configuredEffort: string | null; efforts: unknown[] }[] }>('agentSession.models', { computerId: computer });
            expect(models).toMatchObject({ catalog: 'available', accountScoped: true });
            expect(models.models).toEqual([
                { id: 'ezil/kimi-k2', label: 'Kimi K2', engine: 'ezil-chat', efforts: [], defaultEffort: null, configuredEffort: null },
                { id: 'ezil/qwen', label: 'Qwen', engine: 'ezil-chat', efforts: [], defaultEffort: null, configuredEffort: null }]);
            const ids = await sessionIds();

            // create with a model: the new session runs it; the person's chat is untouched.
            const one = await drive(a, write<Row>('agentSession.create', { computerId: computer, model: 'ezil/qwen', idempotencyKey: randomUUID() }));
            expect(one).toMatchObject({ status: 'applied', requested: { model: 'ezil/qwen' }, effective: { model: 'ezil/qwen', effort: null } });
            expect(w.calls.switched.filter((c) => c.id === 'new1')).toEqual([{ id: 'new1', identifier: 'ezil/qwen', persist: false, userAction: true }]);
            expect(w.widget('s1').input.currentLanguageModel).toBe('ezil/kimi-k2');
            const two = await drive(a, write<Row>('agentSession.create', { computerId: computer, model: 'ezil/kimi-k2', idempotencyKey: randomUUID() }));
            expect(two).toMatchObject({ status: 'applied', effective: { model: 'ezil/kimi-k2', effort: null } });
            // One chat pane per group: the second created chat hid the first.
            expect(w.open).not.toContain('new1');

            // configure: the hidden created chat is shown again (OS created it), then its model changes; nothing else does.
            const opened = w.calls.opened.length;
            const cfg = await drive(a, write<Row>('agentSession.configure', { sessionId: one.sessionId, model: 'ezil/kimi-k2', idempotencyKey: randomUUID() }));
            expect(cfg).toMatchObject({ status: 'applied', requested: { model: 'ezil/kimi-k2', effort: null }, effective: { model: 'ezil/kimi-k2', effort: null } });
            expect(w.calls.opened.length).toBe(opened + 1);
            expect(w.widget('new1').input.currentLanguageModel).toBe('ezil/kimi-k2');
            expect(w.widget('new2').input.currentLanguageModel).toBe('ezil/kimi-k2');
            await a.tick(6);
            expect((await read<{ settings: { model: string } }>('agentSession.settings', { sessionId: one.sessionId })).settings.model).toBe('ezil/kimi-k2');

            // The person's own chat is changed without being "revealed": it is open, and OS sends no reveal for it.
            const person = await drive(a, write<Row>('agentSession.configure', { sessionId: ids.s1, model: 'ezil/qwen', idempotencyKey: randomUUID() }));
            expect(person).toMatchObject({ status: 'applied', effective: { model: 'ezil/qwen' } });
            expect(w.calls.opened.length).toBe(opened + 1);

            // Running at the editor (OS's last report said idle): busy, never queued, the model unchanged.
            (w.models.get('s1') as unknown as { requestInProgress: { value: boolean } }).requestInProgress.value = true;
            const busy = await drive(a, write<Row>('agentSession.configure', { sessionId: ids.s1, model: 'ezil/kimi-k2', idempotencyKey: randomUUID() }));
            expect(busy).toMatchObject({ status: 'busy', effective: null });
            expect(w.widget('s1').input.currentLanguageModel).toBe('ezil/qwen');
            (w.models.get('s1') as unknown as { requestInProgress: { value: boolean } }).requestInProgress.value = false;
            const pendingAfter = await client`SELECT 1 FROM public.ezil_control_operations WHERE computer_id = ${computer}::uuid AND status IN ('queued', 'delivered')`;
            expect(pendingAfter).toHaveLength(0);

            // A model the editor does not offer is refused by OS before anything reaches it.
            const started = w.calls.started;
            expect(await write<Row>('agentSession.create', { computerId: computer, model: 'ezil/not-offered', idempotencyKey: randomUUID() })).toMatchObject({ status: 'rejected', reason: 'model_not_offered' });
            expect(w.calls.started).toBe(started);
            // Every Gateway read used this computer's own token, and nothing else was asked of the Gateway.
            expect(gatewayReads.length).toBeGreaterThan(0);
            expect(gatewayReads.every((r) => r === 'http://gateway.test/ai/v1/models Bearer tok-chain-p2b')).toBe(true);
            expect(forwarded.every((f) => f.status === 200)).toBe(true);
        });

        it('turning the controls flag off mid-flight keeps the window syncing: it falls back to exactly protocol 1 and nothing is lost or refused', async () => {
            for (const [k, v] of Object.entries(CONTROLS)) vi.stubEnv(k, v);
            await fresh();
            const w = fake.world({ sessions: ['s1'], open: ['s1'] });
            const a = await editor(w, 'boot-p2c');
            await a.tick(3);
            expect(a.bodies.map((b) => b.protocol)).toEqual([1, 2, 2]);
            vi.stubEnv('EZIL_EDITOR_BRIDGE_CONTROLS', '');
            const before = forwarded.length;
            await a.tick(4);
            expect(forwarded.slice(before).every((f) => f.status === 200)).toBe(true);
            // OS answered 1 to the first of those, so the later bodies are protocol 1 again, with the four session fields only.
            expect(a.bodies.slice(3).map((b) => b.protocol)).toEqual([2, 1, 1, 1]);
            for (const body of a.bodies.slice(4)) {
                expect(body).not.toHaveProperty('catalog');
                for (const session of (body.sessions ?? []) as Record<string, unknown>[]) expect(Object.keys(session).sort()).toEqual(['open', 'resource', 'status', 'title']);
            }
            // A send still works.
            const ids = await sessionIds();
            const sent = await write<Op>('agentSession.send', { sessionId: ids.s1, text: 'still works', idempotencyKey: randomUUID() });
            await a.tick(2);
            expect(w.calls.send.map((c) => c.text)).toEqual(['still works']);
            expect((await op(sent.id)).status).toBe('running');
        });
    });
});
