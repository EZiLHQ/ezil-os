// Model choice through the MCP, end to end without injecting availability anywhere:
//   real ezil-models Gateway read (accountAvailableIds, real fetch, real config parser) against a TOKEN-BOUND Gateway
//   stand-in (an HTTP server: each computer's AI token sees its own /v1/models) -> real editor client catalog -> real
//   Worker forwarder -> real OS sync route -> OS attestation -> the delegated agentSession.models / create / configure
//   requests the EZiL MCP makes (signed assertions, the real tRPC route).
// Two people, two computers, two AI tokens with different allowed sets; denied, static, missing, legacy, stale and failed
// evidence. The chat runtime is the workbench bridge over the fake 4.141.0 services (chat-bridge-fake.cjs). STAND-INS: the
// Gateway (no model is called) and the chat runtime; nothing here touches staging.
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import superjson from 'superjson';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';

import { ensureTestSchema } from './pg-test-schema';

const REPO = path.resolve(__dirname, '../../../..');
type BridgeClient = { tick(): Promise<number> };
type ClientCtor = new (deps: {
    syncUrl: string; token: string; ownerId: string; execute: (request: Record<string, unknown>) => Promise<unknown>;
    fetch: (url: string, init: RequestInit) => Promise<Response>; log: (line: string) => void;
    effortOf?: (modelId: string) => string | null; availableIds?: (ids: string[]) => Promise<Set<string>>;
}) => BridgeClient;
type Resolved = { id: string };
let ChatBridgeClient: ClientCtor;
let parseModelsConfig: (text: string, options?: { env?: Record<string, string | undefined> }) => { models: Resolved[] };
let accountAvailableIds: (models: readonly Resolved[], ids: readonly string[], doFetch: typeof fetch, now?: number) => Promise<Set<string>>;
let forgetGatewayModels: () => void;
let sentEffort: (model: Resolved) => string | null;
let deriveEditorBridgeToken: (secret: string, sandboxId: string, nonce: string) => Promise<string>;
let handleEditorBridgeRequest: (request: Request, deps: {
    sandboxId: string; osUrl: string | null; secret: string | null; nonce: string | null;
    fetch: (request: Request) => Promise<Response>; now: () => number; log: (fields: Record<string, unknown>) => void;
}) => Promise<Response>;

const MCP = 'https://mcp-staging.ezil.work';
const OS = 'https://os-staging.ezil.work';
const SUPABASE = 'https://btgqfmnzycdecmeyqubx.supabase.co';
const CLIENT = 'https://chatgpt.com/oauth/client.json';
const WORKER_SECRET = 'worker-secret-for-availability-tests-only';
const QWEN = 'qwen.qwen3-coder-next';
const KIMI = 'us.moonshotai.kimi-k3';

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/db', () => ({ get db() { return h.db; } }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }) }));

type FakeWorld = { bridge: { handle(request: unknown): Promise<unknown> }; models: Map<string, unknown>; calls: { started: number; switched: { id: string; identifier: string }[] };
    widget(id: string): { input: { currentLanguageModel: string } } };
const fake = createRequire(import.meta.url)('../../../../worker/copilot-chat/chat-bridge-fake.cjs') as {
    world: (opts?: Record<string, unknown>) => FakeWorld };
// The picker as the editor offers it: the computer's configured models, one of them a direct (static) provider.
const PICKER = [
    { identifier: 'ezil/kimi-k2', metadata: { id: 'kimi-k2', name: 'Kimi K3', vendor: 'ezil', isUserSelectable: true } },
    { identifier: 'ezil/qwen', metadata: { id: 'qwen', name: 'Qwen3 Coder Next', vendor: 'ezil', isUserSelectable: true } },
    { identifier: 'ezil/probe', metadata: { id: 'probe', name: 'Direct probe', vendor: 'ezil', isUserSelectable: true } },
];

const URL_ = process.env.DELEGATION_TEST_DATABASE_URL;
const compact = (id: string) => id.replace(/-/g, '').toLowerCase().slice(0, 16);
const row = (id: string, state: 'available' | 'unavailable' | null, enabled = true) => ({ id, enabled, max_input_tokens: 131072, max_output_tokens: 8192,
    protocols: ['anthropic-messages'], ...(state ? { availability: { state, reasons: state === 'available' ? [] : ['not_allowed_for_caller'] } } : {}) });
const v1 = (rows: unknown[]) => ({ contract: 'ezil.gateway.models.v1', killswitch: false, pause: null, data: rows });

describe.skipIf(!URL_)('model choice through the MCP: real Gateway evidence per account -> editor catalog -> OS attestation -> models/create/configure', { timeout: 60_000 }, () => {
    let client: ReturnType<typeof postgres>;
    let signer: { kid: string; privateKey: webcrypto.CryptoKey };
    let trpcGet: (req: Request) => Promise<Response>;
    let trpcPost: (req: Request) => Promise<Response>;
    let syncRoute: (req: Request) => Promise<Response>;
    let env: Record<string, string> = {};
    let gatewayUrl = '';
    let privateJwk: JsonWebKey = {};
    let server: http.Server;
    /** The Gateway stand-in's answer per bearer token: a catalog, or an HTTP status. */
    const answers: Record<string, unknown> = {};
    const gatewayCalls: string[] = [];
    let clock = 1_900_000_000_000;

    const people = {
        alice: { user: randomUUID(), computer: randomUUID(), aiToken: `tok-a-${randomUUID()}` },
        bob: { user: randomUUID(), computer: randomUUID(), aiToken: `tok-b-${randomUUID()}` },
    };
    type Who = keyof typeof people;
    const sandboxOf = (who: Who) => `guac-${compact(people[who].user)}-${compact(people[who].computer)}`;

    const sign = async (who: Who, scope: string, proc: string, bytes: string) => {
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: MCP, aud: OS, sub: people[who].user, idp_iss: `${SUPABASE}/auth/v1`, client_id: CLIENT, scope, proc,
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
    const read = async <T>(who: Who, proc: string, input: unknown) => {
        const serialized = JSON.stringify({ json: input });
        const url = new URL(`/api/trpc/${proc}`, OS);
        url.searchParams.set('input', serialized);
        return unwrap<T>(await trpcGet(new Request(url, { headers: { authorization: `EZiL-Delegation ${await sign(who, 'ezil:sessions:read', proc, serialized)}` } })));
    };
    const write = async <T>(who: Who, proc: string, input: unknown) => {
        const body = JSON.stringify({ json: input });
        return unwrap<T>(await trpcPost(new Request(new URL(`/api/trpc/${proc}`, OS), {
            method: 'POST', body, headers: { authorization: `EZiL-Delegation ${await sign(who, 'ezil:sessions:write', proc, body)}`, 'content-type': 'application/json' } })));
    };
    type Models = { catalog: string; accountScoped?: boolean; reason?: string; models: { id: string; configuredEffort: string | null }[] };
    type Row = { status: string; reason: string | null; sessionId: string | null; requested: { model: string | null; effort: string | null };
        effective: { model: string | null; effort: string | null; source: string } | null };

    /** One computer's editor: the real extension pieces with that computer's own AI token in its models config. */
    const editor = async (who: Who) => {
        const config = parseModelsConfig(JSON.stringify({
            providers: {
                ezil: { type: 'ezil-gateway', baseUrl: gatewayUrl, apiKey: people[who].aiToken },
                direct: { type: 'anthropic', baseUrl: 'http://127.0.0.1:9/never', apiKey: 'static-key' },
            },
            models: [
                { id: 'kimi-k2', model: KIMI, name: 'Kimi K3', provider: 'ezil', stream: false, maxInputTokens: 131072, maxOutputTokens: 4096 },
                { id: 'qwen', model: QWEN, name: 'Qwen3 Coder Next', provider: 'ezil', default: true, maxInputTokens: 131072, maxOutputTokens: 8192 },
                { id: 'probe', model: 'claude-probe', name: 'Direct probe', provider: 'direct', maxInputTokens: 131072, maxOutputTokens: 8192,
                    thinking: { type: 'adaptive', effort: 'high' } },
            ],
        }));
        expect(config.models.map((m) => m.id)).toEqual(['kimi-k2', 'qwen', 'probe']);
        const w = fake.world({ sessions: ['s1'], open: ['s1'], picker: PICKER });
        const bodies: Record<string, unknown>[] = [];
        const sync = new ChatBridgeClient({
            syncUrl: `https://8443-${sandboxOf(who)}-code.ezil.work/editor-bridge/v1/sync`,
            token: await deriveEditorBridgeToken(WORKER_SECRET, sandboxOf(who), `boot-${who}`),
            ownerId: `ext.${randomUUID()}`,
            execute: (request) => w.bridge.handle(request),
            // Exactly the extension's wiring (extension.ts): real Gateway evidence, real effort-as-sent.
            availableIds: (ids) => accountAvailableIds(config.models, ids, fetch, clock),
            effortOf: (id) => { const m = config.models.find((x) => x.id === id); return m ? sentEffort(m) : null; },
            fetch: async (url, init) => {
                if (typeof init.body === 'string') bodies.push(JSON.parse(init.body));
                return handleEditorBridgeRequest(new Request(url, init), {
                    sandboxId: sandboxOf(who), osUrl: OS, secret: WORKER_SECRET, nonce: `boot-${who}`,
                    fetch: (forward) => syncRoute(forward), now: () => Date.now(), log: () => {},
                });
            },
            log: () => {},
        });
        const tick = async (n = 1) => { for (let i = 0; i < n; i++) await sync.tick(); };
        /** Rounds until the client sends a new catalog (it does every few rounds). */
        const catalogRound = async () => { const seen = bodies.length; for (let i = 0; i < 8; i++) { await tick(); if (bodies.slice(seen).some((b) => 'catalog' in b)) return; } throw new Error('no catalog sent'); };
        return { w, bodies, tick, catalogRound, lastCatalog: () => [...bodies].reverse().find((b) => 'catalog' in b)!.catalog as { models: Record<string, unknown>[] } };
    };
    const drive = async <T>(a: { tick: (n?: number) => Promise<void> }, pending: Promise<T>) => {
        let done = false;
        const settled = pending.finally(() => { done = true; });
        for (let i = 0; i < 80 && !done; i += 1) { await a.tick(); await new Promise((r) => setTimeout(r, 30)); }
        return settled;
    };
    /** A clean slate for both computers (a new editor must not meet the previous test's live owner). */
    const fresh = async () => {
        for (const p of Object.values(people)) {
            await client`DELETE FROM public.ezil_editor_bridge_owner WHERE computer_id = ${p.computer}::uuid`;
            await client`DELETE FROM public.ezil_control_operations WHERE computer_id = ${p.computer}::uuid`;
            await client`DELETE FROM public.ezil_agent_events WHERE session_id IN (SELECT id FROM public.ezil_agent_sessions WHERE computer_id = ${p.computer}::uuid)`;
            await client`DELETE FROM public.ezil_agent_operations WHERE computer_id = ${p.computer}::uuid`;
            await client`DELETE FROM public.ezil_agent_sessions WHERE computer_id = ${p.computer}::uuid`;
        }
        for (const k of Object.keys(answers)) delete answers[k];
        gatewayCalls.length = 0;
    };
    const personSession = async (who: Who) =>
        String((await client`SELECT id FROM public.ezil_agent_sessions WHERE computer_id = ${people[who].computer}::uuid AND resource LIKE '%/s1'`)[0]!.id);

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
            gatewayCalls.push(`${token.slice(0, 5)} ${req.method} ${req.url}`);
            const answer = answers[token];
            if (req.method !== 'GET' || req.url !== '/ai/v1/models' || answer === undefined) { res.writeHead(401).end(); return; }
            if (typeof answer === 'number') { res.writeHead(answer).end(); return; }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ai/v1`;
        client = postgres(URL_!, { max: 8, prepare: false, onnotice: () => {} });
        h.db = drizzle(client, { schema });
        await ensureTestSchema(client);
        for (const p of Object.values(people)) {
            await client`INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (${p.user}::uuid, ${`${p.user}@example.com`}, now())`;
            await client`INSERT INTO public.ezil_computers (id, user_id, slot) VALUES (${p.computer}::uuid, ${p.user}::uuid, 1)`;
        }
        const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
        signer = { kid: 'mcp-test', privateKey: pair.privateKey };
        privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
        env = {
            NEXT_PUBLIC_SUPABASE_URL: SUPABASE, EZIL_DELEGATION_ISSUER: MCP, EZIL_DELEGATION_AUDIENCE: OS, EZIL_DELEGATION_CLIENT_IDS: CLIENT,
            EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: 'mcp-test' }] }),
            EZIL_EDITOR_BRIDGE: 'enabled', EZIL_EDITOR_BRIDGE_CONTROLS: 'enabled', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: WORKER_SECRET,
        };
        const trpc = await import('@/app/api/trpc/[trpc]/route');
        trpcGet = trpc.GET as (req: Request) => Promise<Response>;
        trpcPost = trpc.POST as (req: Request) => Promise<Response>;
        syncRoute = (await import('@/app/api/editor-bridge/v1/sync/route')).POST;
        const load = (file: string) => import(/* @vite-ignore */ path.join(REPO, file));
        ({ ChatBridgeClient } = await load('extensions/ezil-models/src/chat-bridge-client.ts'));
        ({ parseModelsConfig } = await load('extensions/ezil-models/src/config.ts'));
        ({ accountAvailableIds, forgetGatewayModels } = await load('extensions/ezil-models/src/gateway.ts'));
        ({ sentEffort } = await load('extensions/ezil-models/src/client.ts'));
        ({ handleEditorBridgeRequest, deriveEditorBridgeToken } = await load('worker/src/editor-bridge.ts'));
    }, 60_000);
    beforeEach(() => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); forgetGatewayModels(); });
    afterEach(() => { vi.unstubAllEnvs(); });
    afterAll(async () => { await client?.end(); await new Promise((r) => server?.close(r)); });

    it('two accounts, two AI tokens: each computer offers exactly what the Gateway allows THAT account; create and configure follow it', async () => {
        await fresh();
        answers[people.alice.aiToken] = v1([row(QWEN, 'available'), row(KIMI, 'unavailable')]);
        answers[people.bob.aiToken] = v1([row(KIMI, 'available')]);
        const a = await editor('alice');
        const b = await editor('bob');
        await a.tick(3); await b.tick(3);

        // The editor marks only Gateway-attested rows; the static (direct) probe and every unattested row are listed unmarked.
        expect(a.lastCatalog().models.map((m) => [m.id, m.availability ?? null, m.configuredEffort])).toEqual(
            [['ezil/kimi-k2', null, null], ['ezil/qwen', 'available', null], ['ezil/probe', null, 'high']]);
        expect(b.lastCatalog().models.map((m) => [m.id, m.availability ?? null])).toEqual([['ezil/kimi-k2', 'available'], ['ezil/qwen', null], ['ezil/probe', null]]);
        // Each read used that computer's own token, and no other request reached the Gateway.
        expect(gatewayCalls.every((c) => / GET \/ai\/v1\/models$/.test(c))).toBe(true);
        expect(new Set(gatewayCalls.map((c) => c.slice(0, 5)))).toEqual(new Set(['tok-a', 'tok-b']));

        // OS attests per account; the MCP sees only those (actual ids kept).
        const ma = await read<Models>('alice', 'agentSession.models', { computerId: people.alice.computer });
        expect(ma).toMatchObject({ catalog: 'available', accountScoped: true });
        expect(ma.models.map((m) => m.id)).toEqual(['ezil/qwen']);
        const mb = await read<Models>('bob', 'agentSession.models', { computerId: people.bob.computer });
        expect(mb.models.map((m) => m.id)).toEqual(['ezil/kimi-k2']);
        // Another account's computer is not found, not someone else's catalog.
        await expect(read('alice', 'agentSession.models', { computerId: people.bob.computer })).rejects.toThrow(/NOT_FOUND|not found/i);

        // create: an allowed model applies in a new session; a denied one, a static one, the other account's one are refused before the editor.
        const madeA = await drive(a, write<Row>('alice', 'agentSession.create', { computerId: people.alice.computer, model: 'ezil/qwen', idempotencyKey: randomUUID() }));
        expect(madeA).toMatchObject({ status: 'applied', requested: { model: 'ezil/qwen', effort: null }, effective: { model: 'ezil/qwen', effort: null, source: 'runtime' } });
        expect(madeA.sessionId).toBeTruthy();
        for (const model of ['ezil/kimi-k2', 'ezil/probe']) {
            expect(await write<Row>('alice', 'agentSession.create', { computerId: people.alice.computer, model, idempotencyKey: randomUUID() }))
                .toMatchObject({ status: 'rejected', reason: 'model_not_offered' });
        }
        expect(a.w.calls.started).toBe(1);
        const madeB = await drive(b, write<Row>('bob', 'agentSession.create', { computerId: people.bob.computer, model: 'ezil/kimi-k2', idempotencyKey: randomUUID() }));
        expect(madeB).toMatchObject({ status: 'applied', effective: { model: 'ezil/kimi-k2' } });
        expect(await write<Row>('bob', 'agentSession.create', { computerId: people.bob.computer, model: 'ezil/qwen', idempotencyKey: randomUUID() }))
            .toMatchObject({ status: 'rejected', reason: 'model_not_offered' });

        // configure: only to an attested model for that account; the person's chat is changed only to an allowed one.
        const sA = await personSession('alice');
        expect(await write<Row>('alice', 'agentSession.configure', { sessionId: sA, model: 'ezil/kimi-k2', idempotencyKey: randomUUID() }))
            .toMatchObject({ status: 'rejected', reason: 'model_not_offered' });
        const cfgA = await drive(a, write<Row>('alice', 'agentSession.configure', { sessionId: sA, model: 'ezil/qwen', idempotencyKey: randomUUID() }));
        expect(cfgA).toMatchObject({ status: 'applied', effective: { model: 'ezil/qwen', source: 'runtime' } });
        expect(a.w.widget('s1').input.currentLanguageModel).toBe('ezil/qwen');
        const sB = await personSession('bob');
        expect(await write<Row>('bob', 'agentSession.configure', { sessionId: sB, model: 'ezil/qwen', idempotencyKey: randomUUID() }))
            .toMatchObject({ status: 'rejected', reason: 'model_not_offered' });
        expect(b.w.widget('s1').input.currentLanguageModel).toBe('ezil/kimi-k2');
        // Effort stays fixed: never accepted as a session setting.
        await expect(write('alice', 'agentSession.create', { computerId: people.alice.computer, model: 'ezil/qwen', effort: 'high', idempotencyKey: randomUUID() }))
            .rejects.toThrow(/effort_not_per_session/);
    });

    it('stale, failed, missing, legacy and fully denied evidence: the editor marks nothing, OS attests nothing, a model choice is refused', async () => {
        await fresh();
        answers[people.alice.aiToken] = v1([row(QWEN, 'available')]);
        const a = await editor('alice');
        await a.tick(3);
        expect((await read<Models>('alice', 'agentSession.models', { computerId: people.alice.computer })).models.map((m) => m.id)).toEqual(['ezil/qwen']);

        const cases: [string, unknown][] = [
            // The earlier read is now older than the evidence window and the Gateway fails: never the older catalog.
            ['stale read, Gateway failing', 503],
            ['Gateway unreachable for this token', undefined],
            // Only an unrelated alias is available: no row of this computer's picker is.
            ['rows missing', v1([row('glm-5', 'available')])],
            ['legacy catalog without availability', { killswitch: false, pause: null, data: [row(QWEN, null)] }],
            ['denied for this account', v1([row(QWEN, 'unavailable'), row(KIMI, 'unavailable')])],
            ['killswitch', { ...v1([row(QWEN, 'available')]), killswitch: true }],
        ];
        for (const [name, answer] of cases) {
            clock += 61_000;
            if (answer === undefined) delete answers[people.alice.aiToken]; else answers[people.alice.aiToken] = answer;
            await a.catalogRound();
            expect([name, a.lastCatalog().models.some((m) => 'availability' in m)]).toEqual([name, false]);
            const models = await read<Models>('alice', 'agentSession.models', { computerId: people.alice.computer });
            expect([name, models.catalog, models.models.length, 'accountScoped' in models]).toEqual([name, 'unavailable', 0, false]);
            expect([name, (await write<Row>('alice', 'agentSession.create', { computerId: people.alice.computer, model: 'ezil/qwen', idempotencyKey: randomUUID() })).status])
                .toEqual([name, 'rejected']);
        }
        expect(a.w.calls.started).toBe(0);

        // Fresh evidence again: attested again, and the choice works.
        clock += 61_000;
        answers[people.alice.aiToken] = v1([row(QWEN, 'available')]);
        await a.catalogRound();
        expect((await read<Models>('alice', 'agentSession.models', { computerId: people.alice.computer })).models.map((m) => m.id)).toEqual(['ezil/qwen']);
        const made = await drive(a, write<Row>('alice', 'agentSession.create', { computerId: people.alice.computer, model: 'ezil/qwen', idempotencyKey: randomUUID() }));
        expect(made).toMatchObject({ status: 'applied', effective: { model: 'ezil/qwen' } });
    });
    // The EZiL MCP's own control tools, at the head named by EZIL_MCP_SOURCE_DIR (read only: its source is imported, never
    // edited), calling THIS OS through the real delegated route with its own signing key. Off unless that directory is set.
    it.skipIf(!process.env.EZIL_MCP_SOURCE_DIR)('the real MCP controls tools (list_models, create_session, get_session_settings, configure_session) against this OS: two accounts, then stale and denied evidence', async () => {
        const dir = process.env.EZIL_MCP_SOURCE_DIR!;
        const mcp = await import(/* @vite-ignore */ path.join(dir, 'src/tools/controls.ts')) as {
            listModels: Tool; createSession: Tool; getSessionSettings: Tool; configureSession: Tool; startComputer: Tool };
        // The MCP's structured results are read loosely on purpose: the point is what its own validator let through.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type Tool = { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<{ structuredContent?: Record<string, any>; isError?: boolean; content: { text: string }[] }> };
        await fresh();
        const realFetch = globalThis.fetch;
        // The MCP calls OS with the global fetch; route exactly that origin to the real tRPC route, and let everything else through.
        vi.stubGlobal('fetch', async (input: URL | string | Request, init?: RequestInit) => {
            const request = new Request(input as never, init);
            if (new URL(request.url).origin !== OS) return realFetch(input as never, init);
            return request.method === 'GET' ? trpcGet(request) : trpcPost(request);
        });
        const ctxFor = (who: Who) => ({
            props: { issuer: `${SUPABASE}/auth/v1`, sub: people[who].user, email: `${who}@example.com`, name: who, provider: 'email' },
            scopes: ['ezil:account', 'ezil:computers:read', 'ezil:computers:start', 'ezil:sessions:read', 'ezil:sessions:write'], clientId: CLIENT,
            env: { SESSION_TOOLS: 'enabled', SESSION_CONTROLS: 'enabled', OS_ORIGIN: OS, PUBLIC_ORIGIN: MCP, SUPABASE_URL: SUPABASE, DELEGATION_CLIENT_IDS: CLIENT,
                DELEGATION_KID: 'mcp-test', DELEGATION_PRIVATE_JWK: JSON.stringify(privateJwk) },
        });
        const call = (tool: Tool, who: Who, args: Record<string, unknown>) => tool.handler(args, ctxFor(who));
        try {
            answers[people.alice.aiToken] = v1([row(QWEN, 'available'), row(KIMI, 'unavailable')]);
            answers[people.bob.aiToken] = v1([row(KIMI, 'available')]);
            const a = await editor('alice');
            const b = await editor('bob');
            await a.tick(3); await b.tick(3);

            // Each account's tools see its own token's models, accountScoped, fresh.
            const la = await call(mcp.listModels, 'alice', { computerId: people.alice.computer });
            expect(la.isError).toBeFalsy();
            expect(la.structuredContent).toMatchObject({ catalog: 'available', models: [{ id: 'ezil/qwen', engine: 'ezil-chat', configuredEffort: null }] });
            expect((await call(mcp.listModels, 'bob', { computerId: people.bob.computer })).structuredContent!.models.map((m: { id: string }) => m.id)).toEqual(['ezil/kimi-k2']);
            // Another person's computer: a definite not found, not their catalog.
            expect((await call(mcp.listModels, 'alice', { computerId: people.bob.computer })).isError).toBe(true);

            // create with an offered model: applied, and what the editor read back is what is shown.
            const key = randomUUID();
            const made = await drive(a, call(mcp.createSession, 'alice', { computerId: people.alice.computer, model: 'ezil/qwen', idempotencyKey: key }));
            expect(made.isError).toBeFalsy();
            expect(made.structuredContent).toMatchObject({ kind: 'create', status: 'applied', sent: true, reconciled: false, matchesRequested: true,
                requested: { model: 'ezil/qwen', effort: null }, effective: { model: 'ezil/qwen', effort: null, source: 'runtime', historical: false } });
            expect(made.structuredContent!.sessionId).toBeTruthy();
            // A retry shows that stored outcome and sends nothing (and creates no second chat).
            const retry = await call(mcp.createSession, 'alice', { computerId: people.alice.computer, model: 'ezil/qwen', idempotencyKey: key });
            expect(retry.structuredContent).toMatchObject({ status: 'applied', sent: false, reconciled: true, operationId: made.structuredContent!.operationId, effective: { historical: true } });
            expect(a.w.calls.started).toBe(1);
            // A model this account is not offered is refused by the MCP before anything is sent.
            const denied = await call(mcp.createSession, 'alice', { computerId: people.alice.computer, model: 'ezil/kimi-k2', idempotencyKey: randomUUID() });
            expect(denied.structuredContent).toMatchObject({ status: 'invalid_selection', sent: false });
            expect(a.w.calls.started).toBe(1);
            // Settings: the model the editor read in that session's own input.
            await a.tick(6);
            const settings = await call(mcp.getSessionSettings, 'alice', { sessionId: made.structuredContent!.sessionId });
            expect(settings.structuredContent).toMatchObject({ bridge: 'connected', settings: { model: 'ezil/qwen', effort: null, effortSupported: false, source: 'runtime' } });

            // configure the person's own chat to the offered model; the other account's model is refused client-side.
            const sA = await personSession('alice');
            const cfg = await drive(a, call(mcp.configureSession, 'alice', { sessionId: sA, model: 'ezil/qwen', idempotencyKey: randomUUID() }));
            expect(cfg.structuredContent).toMatchObject({ kind: 'configure', status: 'applied', matchesRequested: true, sessionId: sA, effective: { model: 'ezil/qwen' } });
            expect(a.w.widget('s1').input.currentLanguageModel).toBe('ezil/qwen');
            expect((await call(mcp.configureSession, 'alice', { sessionId: sA, model: 'ezil/kimi-k2', idempotencyKey: randomUUID() })).structuredContent).toMatchObject({ status: 'invalid_selection', sent: false });
            // A running session is busy (never queued, nothing changed).
            (a.w.models.get('s1') as unknown as { requestInProgress: { value: boolean } }).requestInProgress.value = true;
            await a.tick(6);
            const busy = await drive(a, call(mcp.configureSession, 'alice', { sessionId: sA, model: 'ezil/qwen', idempotencyKey: randomUUID() }));
            expect(busy.structuredContent).toMatchObject({ status: 'busy', effective: null });
            (a.w.models.get('s1') as unknown as { requestInProgress: { value: boolean } }).requestInProgress.value = false;

            // Create without a model needs no catalog.
            const plain = await drive(a, call(mcp.createSession, 'alice', { computerId: people.alice.computer, idempotencyKey: randomUUID() }));
            expect(plain.structuredContent).toMatchObject({ status: 'applied', requested: { model: null, effort: null }, effective: { model: expect.any(String) } });

            // Stale or denied evidence: the MCP sees an unavailable catalog and refuses a model before sending anything.
            for (const answer of [503, v1([row(QWEN, 'unavailable')])]) {
                clock += 61_000;
                answers[people.alice.aiToken] = answer;
                await a.catalogRound();
                const gone = await call(mcp.listModels, 'alice', { computerId: people.alice.computer });
                expect(gone.structuredContent).toMatchObject({ catalog: 'unavailable', models: [] });
                const refused = await call(mcp.createSession, 'alice', { computerId: people.alice.computer, model: 'ezil/qwen', idempotencyKey: randomUUID() });
                expect(refused.structuredContent).toMatchObject({ status: 'catalog_unavailable', sent: false });
                expect(refused.isError).toBe(true);
            }
        } finally {
            vi.stubGlobal('fetch', realFetch);
        }
    });
});
