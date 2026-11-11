/**
 * EZiL MCP session controls on a real Postgres, through the real delegated `/api/trpc` route (assertion, gate,
 * routers, stores) and the real editor-bridge sync route: `computer.start`, `agentSession.models`, `.settings`,
 * `.control`, `.create`, `.configure`, over the real 0022/0023/0024 tables. Only Supabase's cookie client is
 * stubbed, and the start's heavy collaborators (routing, billing gate, providers) are a fake `StartPort`, whose
 * call order is exactly what is asserted.
 *
 * Needs a THROWAWAY database (it creates auth.users, ezil_computers, 0022, 0023, 0024):
 *   DELEGATION_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres
 */
import { createHash, randomUUID, webcrypto } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import superjson from 'superjson';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import type { StartPort } from '@/server/computer-start/start';

import { ensureTestSchema } from './pg-test-schema';

const MCP = 'https://mcp-staging.ezil.work';
const OS = 'https://os-staging.ezil.work';
const SUPABASE = 'https://btgqfmnzycdecmeyqubx.supabase.co';
const CLIENT = 'https://chatgpt.com/oauth/client.json';
const CLIENT2 = 'https://claude.ai/oauth/client.json';
const WORKER_SECRET = 'worker-secret-for-tests-only';

const h = vi.hoisted(() => ({ db: undefined as unknown, cookieUser: null as { id: string } | null, port: undefined as unknown }));

vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/db', () => ({ get db() { return h.db; } }));
vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.cookieUser }, error: null }) } }),
}));
vi.mock('@/server/computer-start/port', () => ({ startPort: () => h.port }));

const URL_ = process.env.DELEGATION_TEST_DATABASE_URL;
const compact = (id: string) => id.replace(/-/g, '').toLowerCase().slice(0, 16);
const sandboxOf = (userId: string, computerId: string) => `guac-${compact(userId)}-${compact(computerId)}`;

type Control = {
    id: string; kind: string; status: string; sessionId: string | null; computerId: string; updatedAt: string; expiresAt: string | null;
    reason: string | null; requested: { model: string | null; effort: string | null }; effective: unknown;
};
type Start = { id: string; computerId: string; status: string; updatedAt: string; reason: string | null };

describe.skipIf(!URL_)('EZiL MCP session controls on Postgres', () => {
    let client: ReturnType<typeof postgres>;
    let signer: { kid: string; privateKey: webcrypto.CryptoKey };
    let trpcGet: (req: Request) => Promise<Response>;
    let trpcPost: (req: Request) => Promise<Response>;
    let syncRoute: (req: Request) => Promise<Response>;
    let signEditorSync: typeof import('./sync-route').signEditorSync;
    let control: typeof import('./control-store');
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
    const read = async (proc: string, input?: unknown, overrides: Record<string, unknown> = {}, scope = 'ezil:sessions:read') => {
        const serialized = input === undefined ? '' : JSON.stringify({ json: input });
        const url = new URL(`/api/trpc/${proc}`, OS);
        if (input !== undefined) url.searchParams.set('input', serialized);
        const assertion = await sign(scope, proc, serialized, overrides);
        return trpcGet(new Request(url, { headers: { authorization: `EZiL-Delegation ${assertion}` } }));
    };
    const write = async (proc: string, input: unknown, overrides: Record<string, unknown> = {}, scope = 'ezil:sessions:write') => {
        const body = JSON.stringify({ json: input });
        const assertion = await sign(scope, proc, body, overrides);
        return trpcPost(new Request(new URL(`/api/trpc/${proc}`, OS), {
            method: 'POST', headers: { authorization: `EZiL-Delegation ${assertion}`, 'content-type': 'application/json' }, body,
        }));
    };
    const start = (input: unknown, overrides: Record<string, unknown> = {}) => write('computer.start', input, overrides, 'ezil:computers:start');
    const data = async <T>(response: Response) => {
        const json = await response.json();
        if (!json.result) throw new Error(`expected a result, got ${response.status} ${JSON.stringify(json)}`);
        return superjson.deserialize(json.result.data) as T;
    };
    const code = async (response: Response) => (await response.json()).error?.json?.data?.code as string | undefined;

    const syncRequest = (sandbox: string, body: unknown) => {
        const raw = JSON.stringify(body);
        const ts = String(Math.floor(Date.now() / 1000));
        return new Request(new URL('/api/editor-bridge/v1/sync', OS), {
            method: 'POST', body: raw,
            headers: { 'content-type': 'application/json', 'x-ezil-sandbox': sandbox, 'x-ezil-timestamp': ts,
                'x-ezil-signature': signEditorSync(WORKER_SECRET, ts, sandbox, new TextEncoder().encode(raw)) },
        });
    };
    const seqs = new Map<string, number>();
    const sync = async (body: Record<string, unknown>, sandbox = sandboxOf(alice, ids.a1)) => {
        const owner = String(body.ownerId);
        const seq = (seqs.get(owner) ?? 0) + 1;
        seqs.set(owner, seq);
        const response = await syncRoute(syncRequest(sandbox, { protocol: 1, seq, ...body }));
        expect(response.status).toBe(200);
        return response.json() as Promise<{ owner: string; epoch: number; deliver: { operationId: string; attemptId: string }[] }>;
    };
    const expireLease = (computerId = ids.a1) =>
        client`UPDATE public.ezil_editor_bridge_owner SET lease_until = now() - interval '1 second' WHERE computer_id = ${computerId}::uuid`;
    /** A fresh editor on a1 with two sessions in the given status; returns the OS session ids. */
    const connect = async (status: 'idle' | 'running' | 'unknown' = 'idle', owner = `w-${randomUUID()}`, protocol: 1 | 2 = 1) => {
        await expireLease();
        const resources = [`vscode-chat-session://local/${randomUUID()}`, `vscode-chat-session://local/${randomUUID()}`];
        const first = await sync({ ownerId: owner, epoch: 0, protocol, sessions: resources.map((resource, i) => ({
            resource, title: `Chat ${i + 1}`, open: true, status, ...(protocol === 2 ? { model: null, requests: null } : {}) })) });
        const rows = await client`SELECT id, resource FROM public.ezil_agent_sessions WHERE computer_id = ${ids.a1}::uuid AND present`;
        const byResource = new Map(rows.map((row) => [row.resource as string, row.id as string]));
        return { owner, epoch: first.epoch, resources, sessions: resources.map((r) => byResource.get(r)!) };
    };
    const setSessionStatus = (sessionId: string, status: string) =>
        client`UPDATE public.ezil_agent_sessions SET status = ${status} WHERE id = ${sessionId}::uuid`;

    /** Everything a control call must not touch: this test's send queue, its events, and its sessions (other files share the database). */
    const untouched = async () => JSON.stringify([
        await client`SELECT id, status, updated_at FROM public.ezil_agent_operations WHERE user_id IN (${alice}::uuid, ${bob}::uuid) ORDER BY id`,
        await client`SELECT e.session_id, e.seq FROM public.ezil_agent_events e JOIN public.ezil_agent_sessions s ON s.id = e.session_id
            WHERE s.user_id IN (${alice}::uuid, ${bob}::uuid) ORDER BY e.session_id, e.seq`,
        await client`SELECT id, resource, status, open, present, seen_at, next_seq FROM public.ezil_agent_sessions WHERE user_id IN (${alice}::uuid, ${bob}::uuid) ORDER BY id`,
    ]);
    const controlRows = (where = client`TRUE`) => client`SELECT * FROM public.ezil_control_operations WHERE ${where} ORDER BY created_at`;

    // The fake start port: records its calls in order and answers what the test sets.
    const calls: string[] = [];
    const port = { moving: false, pinnedKind: 'cloudflare' as 'cloudflare' | 'aws-ec2', pinnedMoving: false, instanceType: null as string | null, pinnedInstanceType: null as string | null, onBoot: undefined as undefined | (() => Promise<void>), gate: { allowed: true } as { allowed: true } | { allowed: false; reason: string }, routeThrows: false,
        boot: { state: 'running' } as { state: 'running' } | { state: 'starting' } | { state: 'failed'; reason: string }, bootThrows: false };
    const resetPort = () => {
        Object.assign(port, { moving: false, pinnedKind: 'cloudflare', pinnedMoving: false, instanceType: null, pinnedInstanceType: null, onBoot: undefined, gate: { allowed: true }, routeThrows: false, boot: { state: 'running' }, bootThrows: false });
        calls.length = 0;
    };
    h.port = {
        route: async (pin: boolean) => {
            calls.push(`route:${pin}`);
            if (port.routeThrows) throw new Error('placement read failed');
            return pin ? { kind: port.pinnedKind, instanceType: port.pinnedInstanceType, moving: port.pinnedMoving } : { kind: port.instanceType === null ? 'cloudflare' as const : 'aws-ec2' as const, instanceType: port.instanceType, moving: port.moving };
        },
        gate: async () => { calls.push('gate'); return port.gate; },
        boot: async () => { calls.push('boot'); await port.onBoot?.(); if (port.bootThrows) throw new Error('worker exploded'); return port.boot; },
    } satisfies StartPort;

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
            NEXT_PUBLIC_SUPABASE_URL: SUPABASE, EZIL_DELEGATION_ISSUER: MCP, EZIL_DELEGATION_AUDIENCE: OS, EZIL_DELEGATION_CLIENT_IDS: `${CLIENT} ${CLIENT2}`,
            EZIL_DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: 'mcp-test' }] }),
            EZIL_EDITOR_BRIDGE: 'enabled', EZIL_EDITOR_BRIDGE_CONTROLS: 'enabled', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: WORKER_SECRET,
        };
        const trpc = await import('@/app/api/trpc/[trpc]/route');
        trpcGet = trpc.GET as (req: Request) => Promise<Response>;
        trpcPost = trpc.POST as (req: Request) => Promise<Response>;
        syncRoute = (await import('@/app/api/editor-bridge/v1/sync/route')).POST;
        ({ signEditorSync } = await import('./sync-route'));
        control = await import('./control-store');
    }, 60_000);

    beforeEach(() => {
        for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
        resetPort();
        // The gate and the control wrapper audit every call; tests that read those lines spy again.
        vi.spyOn(console, 'info').mockImplementation(() => {});
    });
    afterEach(() => { h.cookieUser = null; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    afterAll(async () => { await client?.end(); });


    describe('protocol3 observed effort PostgreSQL regression', () => {
        const offered = { status: 'available', observedAt: 1, models: ['ezil/a', 'ezil/b'].map(id => ({
            id, label: id, engine: 'ezil-chat', availability: 'available', efforts: ['low', 'high'], defaultEffort: null, configuredEffort: null,
        })) };
        const setup = async () => {
            vi.stubEnv('EZIL_EDITOR_BRIDGE_EFFORT', 'enabled');
            const state = await connect('idle', `p3-${randomUUID()}`, 2);
            const tick = (protocol: number, extra: Record<string, unknown> = {}) => sync({ownerId: state.owner, epoch: state.epoch, protocol, ...extra});
            const snapshot = (model: string, effort?: string) => ({resource: state.resources[0], title: 'synthetic', open: true, status: 'idle', model, requests: 0,
                ...(effort === undefined ? {} : {effort})});
            await tick(3, {sessions: [snapshot('ezil/a', 'high')], catalog: offered});
            return {...state, tick, snapshot};
        };
        const settings = (id: string) => read('agentSession.settings', {sessionId: id}).then(data<{settings: {model: string; effort: string|null}|null}>);
        const roundControl = async (state: Awaited<ReturnType<typeof setup>>, kind: 'create'|'configure', input: Record<string, unknown>,
            report: Record<string, unknown>, protocol = 3) => {
            const key = randomUUID();
            const response = write(`agentSession.${kind}`, {...input, idempotencyKey:key});
            let row: Record<string, unknown> | undefined;
            for(let i=0;i<200;i++) {
                row=(await client`SELECT id FROM public.ezil_control_operations WHERE user_id=${alice}::uuid AND idempotency_key=${key}::uuid`)[0];
                if(row) break;
                await new Promise(resolve=>setTimeout(resolve,5));
            }
            expect(row).toBeDefined();
            const delivered=(await state.tick(protocol)).deliver.find(d=>d.operationId===row!.id);
            expect(delivered).toBeDefined();
            await state.tick(protocol,{reports:[{operationId:delivered!.operationId,attemptId:delivered!.attemptId,status:'applied',...report}]});
            return data<Control>(await response);
        };
        it('disabled gate rejects against retained live protocol3 evidence without consuming a key or changing state', async () => {
            const state = await setup();
            const id = state.sessions[0]!;
            const before = (await controlRows()).length;
            const effects = await untouched();
            vi.stubEnv('EZIL_EDITOR_BRIDGE_EFFORT', ''); // no legacy heartbeat: retain protocol3 lease/catalog
            for (const [procedure, target] of [
                ['agentSession.create', {computerId:ids.a1}],
                ['agentSession.configure', {sessionId:id}],
            ] as const) {
                const key = randomUUID();
                const response = await write(procedure, {...target, effort:'high', idempotencyKey:key});
                expect(await code(response)).toBe('BAD_REQUEST');
                expect(await controlRows(client`idempotency_key = ${key}::uuid`)).toHaveLength(0);
            }
            expect((await controlRows()).length).toBe(before);
            expect(await untouched()).toBe(effects);
        });
        it.each(['snapshot2', 'snapshot1', 'configure2'])('3→legacy %s→3 heartbeat never freshens old effort', async legacy => {
            const state=await setup(); const id=state.sessions[0]!;
            expect((await settings(id)).settings).toMatchObject({model:'ezil/a',effort:'high'});
            if(legacy==='snapshot2') await state.tick(2,{sessions:[state.snapshot('ezil/b')]});
            else if(legacy==='snapshot1') await state.tick(1,{sessions:[{resource:state.resources[0],title:'legacy',open:true,status:'idle'}]});
            else {
                await state.tick(2,{catalog:{...offered,models:offered.models.map(m=>({...m,efforts:[],defaultEffort:null}))}});
                const changed=await roundControl(state,'configure',{sessionId:id,model:'ezil/b'}, {model:'ezil/b'},2);
                expect(changed.status).toBe('applied');
                expect((await settings(id)).settings?.model).toBe('ezil/b');
            }
            // No snapshot accompanies this re-upgrade; a retained old value is not a new observation.
            await state.tick(3);
            expect((await settings(id)).settings?.effort).toBeNull();
            const stored=(await client`SELECT effort, effort_observed_at, model_at, seen_at FROM public.ezil_agent_sessions WHERE id=${id}::uuid`)[0]!;
            expect(stored.effort).toBe('high'); // retained history, invalidated witness
            expect(stored.effort_observed_at).not.toBeNull();
            await state.tick(3,{sessions:[state.snapshot('ezil/b','low')],catalog:offered});
            expect((await settings(id)).settings).toMatchObject({model:'ezil/b',effort:'low'});
        });
        it('roundtrips protocol3 create/configure settings and operation selected_effort through real routes/store', async()=>{
            const state=await setup();
            const created=await roundControl(state,'create',{computerId:ids.a1,model:'ezil/a',effort:'low'},
                {sessionResource:`vscode-chat-session://local/${randomUUID()}`,requestCount:0,model:'ezil/a',effort:'low'});
            expect(created.status).toBe('applied');
            expect(created.effective).toMatchObject({model:'ezil/a',effort:'low',source:'runtime'});
            expect((await settings(created.sessionId!)).settings).toMatchObject({model:'ezil/a',effort:'low'});
            const changed=await roundControl(state,'configure',{sessionId:created.sessionId,effort:'high'}, {model:'ezil/a',effort:'high'});
            expect(changed.effective).toMatchObject({model:'ezil/a',effort:'high'});
            expect((await settings(created.sessionId!)).settings?.effort).toBe('high');
            const sent=await data<{id:string}>(await write('agentSession.send',{sessionId:created.sessionId,text:'synthetic bounded instruction',idempotencyKey:randomUUID()}));
            const delivery=(await state.tick(3)).deliver.find(d=>d.operationId===sent.id)!;
            expect(delivery).toBeDefined();
            await state.tick(3,{reports:[{operationId:sent.id,attemptId:delivery.attemptId,status:'completed',selectedModelId:'ezil/a',selectedEffort:'high',responseText:'synthetic output'}]});
            const observed=await data<{selectedEffort:string}>(await read('agentSession.operation',{operationId:sent.id}));
            expect(observed.selectedEffort).toBe('high');
            expect((await client`SELECT selected_effort FROM public.ezil_agent_operations WHERE id=${sent.id}::uuid`)[0]?.selected_effort).toBe('high');
        });
    });

    describe('computer.start', () => {
        it('starts an owned computer: allowance first, then pin, then boot, and the answer carries no URL', async () => {
            const key = randomUUID();
            const row = await data<Start>(await start({ computerId: ids.a1, idempotencyKey: key }));
            expect(calls).toEqual(['route:false', 'gate', 'route:true', 'boot']);
            expect(row).toEqual({ id: expect.any(String), computerId: ids.a1, status: 'running', updatedAt: expect.any(String), reason: null });
            expect(Object.keys(row).sort()).toEqual(['computerId', 'id', 'reason', 'status', 'updatedAt']);
            expect(JSON.stringify(row)).not.toMatch(/https?:|url/i);
            const [stored] = await controlRows(client`id = ${row.id}::uuid`);
            expect(stored).toMatchObject({ user_id: alice, client_id: CLIENT, proc: 'computer.start', kind: 'start', status: 'running', computer_id: ids.a1 });
        });

        it('is idempotent: a retry returns the original row and runs nothing, whatever has changed since', async () => {
            const key = randomUUID();
            const first = await data<Start>(await start({ computerId: ids.a1, idempotencyKey: key }));
            calls.length = 0;
            port.gate = { allowed: false, reason: 'fair_use_paused' };
            expect(await data<Start>(await start({ computerId: ids.a1, idempotencyKey: key }))).toEqual(first);
            expect(calls).toEqual([]);
            expect((await controlRows(client`idempotency_key = ${key}::uuid`)).length).toBe(1);
        });

        it('the same key with another computer is a CONFLICT; another client or person has its own key space', async () => {
            const key = randomUUID();
            const first = await data<Start>(await start({ computerId: ids.a1, idempotencyKey: key }));
            calls.length = 0;
            const other = await start({ computerId: ids.a2, idempotencyKey: key });
            expect(await code(other)).toBe('CONFLICT');
            expect(calls).toEqual([]);
            // Another OAuth client under the same key is a separate request (its own start), not a replay or a conflict.
            const second = await data<Start>(await start({ computerId: ids.a1, idempotencyKey: key }, { client_id: CLIENT2 }));
            expect(second.id).not.toBe(first.id);
            expect(calls).toContain('boot');
            // Another person's identical key never sees alice's row.
            calls.length = 0;
            const bobs = await data<Start>(await start({ computerId: ids.b1, idempotencyKey: key }, { sub: bob }));
            expect(bobs.id).not.toBe(first.id);
            expect((await controlRows(client`idempotency_key = ${key}::uuid`)).length).toBe(3);
        });

        it("another person's or a deleted or a missing computer is NOT_FOUND: nothing recorded, nothing run", async () => {
            for (const computerId of [ids.b1, ids.aDeleted, randomUUID()]) {
                const key = randomUUID();
                expect(await code(await start({ computerId, idempotencyKey: key }))).toBe('NOT_FOUND');
                expect((await controlRows(client`idempotency_key = ${key}::uuid`)).length).toBe(0);
            }
            expect(await code(await start({ computerId: ids.a1, idempotencyKey: randomUUID() }, { sub: bob }))).toBe('NOT_FOUND');
            expect(calls).toEqual([]);
        });

        it('an allowance refusal is recorded and has no side effect: nothing pinned, nothing booted', async () => {
            port.gate = { allowed: false, reason: 'no_plan' };
            const key = randomUUID();
            const row = await data<Start>(await start({ computerId: ids.a1, idempotencyKey: key }));
            expect(row).toMatchObject({ status: 'refused_allowance', reason: 'billing_no_plan' });
            // Routing was read-only (no pin) and the gate ran; the pinning route and the boot never did.
            expect(calls).toEqual(['route:false', 'gate']);
            // A retry shows the recorded refusal and still runs nothing.
            calls.length = 0;
            expect(await data<Start>(await start({ computerId: ids.a1, idempotencyKey: key }))).toEqual(row);
            expect(calls).toEqual([]);
        });

        it('a computer held by a reverse move is not started: failed, before the gate', async () => {
            port.moving = true;
            const row = await data<Start>(await start({ computerId: ids.a1, idempotencyKey: randomUUID() }));
            expect(row).toMatchObject({ status: 'failed', reason: 'computer_move_in_progress' });
            expect(calls).toEqual(['route:false']);
        });

        it('a pin that lands on another route than the one the allowance admitted is failed before any boot', async () => {
            port.pinnedKind = 'aws-ec2';
            const row = await data<Start>(await start({ computerId: ids.a1, idempotencyKey: randomUUID() }));
            expect(row).toMatchObject({ status: 'failed', reason: 'route_changed' });
            expect(calls).toEqual(['route:false', 'gate', 'route:true']);
            // Same kind, another instance type: the allowance rated one size and the pin would boot another.
            resetPort();
            port.instanceType = 'm6i.large';
            port.pinnedKind = 'aws-ec2';
            port.pinnedInstanceType = 'm6i.xlarge';
            expect(await data<Start>(await start({ computerId: ids.a1, idempotencyKey: randomUUID() }))).toMatchObject({ status: 'failed', reason: 'route_changed' });
            expect(calls).not.toContain('boot');
            // The same instance type is fine.
            resetPort();
            port.instanceType = 'm6i.large';
            port.pinnedKind = 'aws-ec2';
            port.pinnedInstanceType = 'm6i.large';
            expect(await data<Start>(await start({ computerId: ids.a1, idempotencyKey: randomUUID() }))).toMatchObject({ status: 'running' });
            resetPort();
            port.pinnedMoving = true;
            expect(await data<Start>(await start({ computerId: ids.a1, idempotencyKey: randomUUID() }))).toMatchObject({ status: 'failed', reason: 'route_changed' });
            expect(calls).not.toContain('boot');
        });

        it('an uppercase computer id under the same key is the same request, not a conflict', async () => {
            const key = randomUUID();
            const first = await data<Start>(await start({ computerId: ids.a1, idempotencyKey: key }));
            calls.length = 0;
            expect(await data<Start>(await start({ computerId: ids.a1.toUpperCase(), idempotencyKey: key }))).toEqual(first);
            expect(calls).toEqual([]);
        });

        it('boot outcomes: starting, and a failure with a bounded reason code', async () => {
            port.boot = { state: 'starting' };
            expect(await data<Start>(await start({ computerId: ids.a1, idempotencyKey: randomUUID() }))).toMatchObject({ status: 'starting', reason: null });
            port.boot = { state: 'failed', reason: 'aws_capacity' };
            expect(await data<Start>(await start({ computerId: ids.a1, idempotencyKey: randomUUID() }))).toMatchObject({ status: 'failed', reason: 'aws_capacity' });
            port.boot = { state: 'failed', reason: 'Worker said: <html>secret https://x.example/?t=1' };
            const row = await data<Start>(await start({ computerId: ids.a1, idempotencyKey: randomUUID() }));
            expect(row).toMatchObject({ status: 'failed', reason: 'start_failed' });
        });

        it('a failure before the boot is recorded as failed (nothing started); a throw during it stays starting and is never rerun', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {});
            port.routeThrows = true;
            const early = await data<Start>(await start({ computerId: ids.a1, idempotencyKey: randomUUID() }));
            expect(early).toMatchObject({ status: 'failed', reason: 'start_error' });
            expect(calls).not.toContain('boot');

            resetPort();
            port.bootThrows = true;
            const key = randomUUID();
            expect((await start({ computerId: ids.a1, idempotencyKey: key })).status).toBe(500);
            // Unknown whether it started: the row says so (starting), and a retry shows it without booting again.
            expect((await controlRows(client`idempotency_key = ${key}::uuid`))[0]).toMatchObject({ status: 'starting' });
            calls.length = 0;
            port.bootThrows = false;
            expect(await data<Start>(await start({ computerId: ids.a1, idempotencyKey: key }))).toMatchObject({ status: 'starting' });
            expect(calls).toEqual([]);
        });

        it('a control row that vanishes mid-start is an unconfirmed outcome (500), not a key conflict', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {});
            const key = randomUUID();
            port.onBoot = async () => { await client`DELETE FROM public.ezil_control_operations WHERE idempotency_key = ${key}::uuid`; };
            const response = await start({ computerId: ids.a1, idempotencyKey: key });
            expect(response.status).toBe(500);
            expect(await code(response)).toBe('INTERNAL_SERVER_ERROR');
        });

        it('takes only { computerId, idempotencyKey }: no plan, size, billing or other field, and a bad key or id is refused before anything runs', async () => {
            for (const extra of [{ size: 'std-2' }, { plan: 'pro' }, { screen: {} }, { intent: 'open' }, { sessionId: randomUUID() }]) {
                expect(await code(await start({ computerId: ids.a1, idempotencyKey: randomUUID(), ...extra }))).toBe('BAD_REQUEST');
            }
            expect(await code(await start({ computerId: ids.a1, idempotencyKey: 'not-a-uuid' }))).toBe('BAD_REQUEST');
            expect(await code(await start({ computerId: 'nope', idempotencyKey: randomUUID() }))).toBe('BAD_REQUEST');
            expect(calls).toEqual([]);
        });

        it('is reachable only under ezil:computers:start, and that scope reaches nothing else', async () => {
            const input = { computerId: ids.a1, idempotencyKey: randomUUID() };
            for (const scope of ['ezil:computers:read', 'ezil:sessions:write', 'ezil:sessions:read']) {
                expect(await code(await write('computer.start', input, {}, scope))).toBe('UNAUTHORIZED');
            }
            expect(await code(await read('computer.get', { id: ids.a1 }, {}, 'ezil:computers:start'))).toBe('UNAUTHORIZED');
            expect(await code(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: randomUUID() }, {}, 'ezil:computers:start'))).toBe('UNAUTHORIZED');
            // An assertion for another procedure cannot be spent on this call.
            const body = JSON.stringify({ json: input });
            const assertion = await sign('ezil:sessions:write', 'agentSession.send', body);
            const spent = await trpcPost(new Request(new URL('/api/trpc/computer.start', OS), {
                method: 'POST', headers: { authorization: `EZiL-Delegation ${assertion}`, 'content-type': 'application/json' }, body }));
            expect(await code(spent)).toBe('UNAUTHORIZED');
            expect(calls).toEqual([]);
            expect(await controlRows(client`idempotency_key = ${input.idempotencyKey}::uuid`)).toHaveLength(0);
        });
    });

    describe('agentSession.models', () => {
        it('a protocol-1 editor (or none) leaves it unavailable with a reason and NO models', async () => {
            await expireLease();
            const offline = await data<Record<string, unknown>>(await read('agentSession.models', { computerId: ids.a1 }));
            expect(offline).toMatchObject({ computerId: ids.a1, catalog: 'unavailable', models: [] });
            expect(String(offline.reason)).toMatch(/No editor is connected/);
            expect(Date.now() - Date.parse(String(offline.observedAt))).toBeLessThan(10_000);
            expect(offline).not.toHaveProperty('accountScoped');

            await connect();
            const online = await data<Record<string, unknown>>(await read('agentSession.models', { computerId: ids.a1 }));
            expect(online).toMatchObject({ catalog: 'unavailable', models: [] });
            expect(String(online.reason)).toMatch(/has not negotiated session controls/);
            expect(Object.keys(online).sort()).toEqual(['catalog', 'computerId', 'models', 'observedAt', 'reason']);
        });

        it("is owner-scoped: another person's, a deleted and a missing computer are NOT_FOUND; a write scope cannot read it", async () => {
            for (const computerId of [ids.b1, ids.aDeleted, randomUUID()]) {
                expect(await code(await read('agentSession.models', { computerId }))).toBe('NOT_FOUND');
            }
            expect(await code(await read('agentSession.models', { computerId: ids.a1 }, { sub: bob }))).toBe('NOT_FOUND');
            expect(await code(await read('agentSession.models', { computerId: ids.a1 }, {}, 'ezil:sessions:write'))).toBe('UNAUTHORIZED');
            expect(await code(await read('agentSession.models', { computerId: ids.a1, extra: 1 }))).toBe('BAD_REQUEST');
        });
    });

    describe('agentSession.settings', () => {
        it('a protocol-1 editor reports no model: settings are null, with the session\'s status and bridge', async () => {
            const { sessions } = await connect('idle');
            const idle = await data<Record<string, unknown>>(await read('agentSession.settings', { sessionId: sessions[0] }));
            expect(idle).toEqual({ sessionId: sessions[0], computerId: ids.a1, status: 'idle', bridge: 'connected', settings: null });
            await setSessionStatus(sessions[0]!, 'running');
            expect(await data(await read('agentSession.settings', { sessionId: sessions[0] }))).toMatchObject({ status: 'running', bridge: 'connected', settings: null });
            // Editor gone: unknown status, disconnected bridge, still no settings.
            await expireLease();
            expect(await data(await read('agentSession.settings', { sessionId: sessions[0] }))).toEqual({
                sessionId: sessions[0], computerId: ids.a1, status: 'unknown', bridge: 'disconnected', settings: null });
        });

        it("never shows a finished send's recorded model as the session's current setting", async () => {
            const { sessions } = await connect('idle');
            const key = randomUUID();
            await data(await write('agentSession.send', { sessionId: sessions[0], text: 'hi', idempotencyKey: key }));
            await client`UPDATE public.ezil_agent_operations SET status = 'completed', selected_model_id = 'kimi-k3' WHERE session_id = ${sessions[0]!}::uuid`;
            const view = await data<{ settings: unknown }>(await read('agentSession.settings', { sessionId: sessions[0] }));
            expect(view.settings).toBeNull();
            expect(JSON.stringify(view)).not.toContain('kimi-k3');
        });

        it("is owner-scoped: another person's or a gone session is NOT_FOUND", async () => {
            const { sessions } = await connect();
            expect(await code(await read('agentSession.settings', { sessionId: sessions[0] }, { sub: bob }))).toBe('NOT_FOUND');
            expect(await code(await read('agentSession.settings', { sessionId: randomUUID() }))).toBe('NOT_FOUND');
            await client`UPDATE public.ezil_computers SET deleted_at = now() WHERE id = ${ids.a1}::uuid`;
            try {
                expect(await code(await read('agentSession.settings', { sessionId: sessions[0] }))).toBe('NOT_FOUND');
            } finally {
                await client`UPDATE public.ezil_computers SET deleted_at = NULL WHERE id = ${ids.a1}::uuid`;
            }
        });
    });

    describe('agentSession.create', () => {
        it('no editor: a durable `disconnected` row, nothing created and nothing queued', async () => {
            await expireLease();
            const before = await untouched();
            const key = randomUUID();
            const row = await data<Control>(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: key }));
            expect(row).toEqual({
                id: expect.any(String), kind: 'create', status: 'disconnected', sessionId: null, computerId: ids.a1, updatedAt: expect.any(String),
                expiresAt: null, reason: 'no_connected_editor', requested: { model: null, effort: null }, effective: null,
            });
            expect(await untouched()).toBe(before);
        });

        it('a protocol-1 editor cannot create: `rejected` with a reason, never queued, never `applied`, no effective value', async () => {
            await connect();
            const before = await untouched();
            const row = await data<Control>(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: randomUUID() }));
            expect(row).toMatchObject({ status: 'rejected', reason: 'editor_controls_unsupported', sessionId: null, effective: null, expiresAt: null });
            expect(await untouched()).toBe(before);
        });

        it('an effort is refused BEFORE anything is stored (BAD_REQUEST effort_not_per_session); a model echoes as requested', async () => {
            await connect();
            const before = (await controlRows()).length;
            for (const bad of [{ model: 'kimi-k3', effort: 'high' }, { effort: 'high' }]) {
                const response = await write('agentSession.create', { computerId: ids.a1, ...bad, idempotencyKey: randomUUID() });
                expect(await code(response.clone())).toBe('BAD_REQUEST');
                expect((await response.json()).error.json.message).toBe('effort_not_per_session');
            }
            const effects = await untouched();
            await expireLease();
            for (const computerId of [ids.a1, ids.b1, randomUUID()]) {
                expect(await code(await write('agentSession.create', { computerId, effort: 'high', idempotencyKey: randomUUID() }))).toBe('BAD_REQUEST');
            }
            for (const sessionId of [randomUUID()]) {
                expect(await code(await write('agentSession.configure', { sessionId, effort: 'high', idempotencyKey: randomUUID() }))).toBe('BAD_REQUEST');
            }
            expect(await untouched()).toBe(effects);
            expect((await controlRows()).length).toBe(before);
            await connect();
            const modelOnly = await data<Control>(await write('agentSession.create', { computerId: ids.a1, model: 'qwen3-coder-next', idempotencyKey: randomUUID() }));
            expect(modelOnly).toMatchObject({ status: 'rejected', requested: { model: 'qwen3-coder-next', effort: null }, effective: null });
            // No editor and a model: disconnected wins (the catalog cannot even be asked).
            await expireLease();
            expect(await data<Control>(await write('agentSession.create', { computerId: ids.a1, model: 'kimi-k3', idempotencyKey: randomUUID() })))
                .toMatchObject({ status: 'disconnected' });
        });

        it('replays the original row under the same key even after the editor connects; other input under it is a CONFLICT', async () => {
            await expireLease();
            const key = randomUUID();
            const first = await data<Control>(await write('agentSession.create', { computerId: ids.a1, model: 'kimi-k3', idempotencyKey: key }));
            expect(first.status).toBe('disconnected');
            await connect();
            expect(await data<Control>(await write('agentSession.create', { computerId: ids.a1, model: 'kimi-k3', idempotencyKey: key }))).toEqual(first);
            for (const other of [{ computerId: ids.a1, model: 'other', idempotencyKey: key }, { computerId: ids.a1, idempotencyKey: key },
                { computerId: ids.a2, model: 'kimi-k3', idempotencyKey: key }]) {
                expect(await code(await write('agentSession.create', other))).toBe('CONFLICT');
            }
            expect((await controlRows(client`idempotency_key = ${key}::uuid`)).length).toBe(1);
        });

        it('a retry returns the original row even after the computer is gone (the key, not the target, decides)', async () => {
            const key = randomUUID();
            const first = await data<Control>(await write('agentSession.create', { computerId: ids.a2, idempotencyKey: key }));
            await client`UPDATE public.ezil_computers SET deleted_at = now() WHERE id = ${ids.a2}::uuid`;
            try {
                expect(await data<Control>(await write('agentSession.create', { computerId: ids.a2, idempotencyKey: key }))).toEqual(first);
                // A NEW key against the gone computer is NOT_FOUND.
                expect(await code(await write('agentSession.create', { computerId: ids.a2, idempotencyKey: randomUUID() }))).toBe('NOT_FOUND');
            } finally {
                await client`UPDATE public.ezil_computers SET deleted_at = NULL WHERE id = ${ids.a2}::uuid`;
            }
        });

        it('an uppercase id under the same key is the same request, not a conflict (create and configure)', async () => {
            await expireLease();
            const key = randomUUID();
            const first = await data<Control>(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: key }));
            expect(await data<Control>(await write('agentSession.create', { computerId: ids.a1.toUpperCase(), idempotencyKey: key }))).toEqual(first);
            const { sessions } = await connect('idle');
            const configureKey = randomUUID();
            const configured = await data<Control>(await write('agentSession.configure', { sessionId: sessions[0], model: 'm', idempotencyKey: configureKey }));
            expect(await data<Control>(await write('agentSession.configure', { sessionId: sessions[0]!.toUpperCase(), model: 'm', idempotencyKey: configureKey }))).toEqual(configured);
        });

        it('keys are per person and per client: another client or person under the same key is a separate request', async () => {
            await expireLease();
            const key = randomUUID();
            const mine = await data<Control>(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: key }));
            const other = await data<Control>(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: key }, { client_id: CLIENT2 }));
            expect(other.id).not.toBe(mine.id);
            const bobs = await data<Control>(await write('agentSession.create', { computerId: ids.b1, idempotencyKey: key }, { sub: bob }));
            expect(bobs).toMatchObject({ computerId: ids.b1 });
            expect(new Set([mine.id, other.id, bobs.id]).size).toBe(3);
        });

        it("another person's, a deleted and a missing computer are NOT_FOUND with nothing recorded", async () => {
            for (const computerId of [ids.b1, ids.aDeleted, randomUUID()]) {
                const key = randomUUID();
                expect(await code(await write('agentSession.create', { computerId, idempotencyKey: key }))).toBe('NOT_FOUND');
                expect(await controlRows(client`idempotency_key = ${key}::uuid`)).toHaveLength(0);
            }
            const key = randomUUID();
            expect(await code(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: key }, { sub: bob }))).toBe('NOT_FOUND');
            expect(await controlRows(client`idempotency_key = ${key}::uuid`)).toHaveLength(0);
        });

        it('takes no instruction text, shell, mode or approvals; a malformed model, effort or key is refused', async () => {
            const base = { computerId: ids.a1, idempotencyKey: randomUUID() };
            for (const extra of [{ text: 'rm -rf /' }, { instruction: 'x' }, { shell: 'sh' }, { mode: 'agent' }, { approvals: 'auto' }, { previewUrl: 'https://x' }, { engine: 'e' }]) {
                expect(await code(await write('agentSession.create', { ...base, ...extra }))).toBe('BAD_REQUEST');
            }
            for (const bad of [{ model: '' }, { model: 'x'.repeat(257) }, { model: 'a\nb' }, { model: 'a‮b' }, { effort: 'has space' }, { effort: 'x'.repeat(33) }, { effort: '' },
                { idempotencyKey: 'not-a-uuid' }]) {
                expect(await code(await write('agentSession.create', { ...base, ...bad }))).toBe('BAD_REQUEST');
            }
            expect(await code(await write('agentSession.create', base, {}, 'ezil:sessions:read'))).toBe('UNAUTHORIZED');
            expect(await controlRows(client`idempotency_key = ${base.idempotencyKey}::uuid`)).toHaveLength(0);
        });
    });

    describe('agentSession.configure', () => {
        const configure = (sessionId: string, extra: Record<string, unknown> = { model: 'kimi-k3' }, overrides: Record<string, unknown> = {}, key = randomUUID()) =>
            write('agentSession.configure', { sessionId, idempotencyKey: key, ...extra }, overrides);

        it('no editor: `disconnected`, a durable row, and nothing changed', async () => {
            const { sessions } = await connect();
            await expireLease();
            const before = await untouched();
            const row = await data<Control>(await configure(sessions[0]!, { model: 'kimi-k3' }));
            expect(row).toEqual({
                id: expect.any(String), kind: 'configure', status: 'disconnected', sessionId: sessions[0], computerId: ids.a1, updatedAt: expect.any(String),
                expiresAt: null, reason: 'no_connected_editor', requested: { model: 'kimi-k3', effort: null }, effective: null,
            });
            expect(await untouched()).toBe(before);
        });

        it('a running session is `busy`: never queued, nothing changed, no operation in the send queue', async () => {
            const { sessions } = await connect('running', undefined, 2);
            const before = await untouched();
            const row = await data<Control>(await configure(sessions[0]!));
            expect(row).toMatchObject({ status: 'busy', reason: 'session_running', effective: null, expiresAt: null });
            expect(await untouched()).toBe(before);
            expect(await client`SELECT 1 FROM public.ezil_agent_operations WHERE session_id = ${sessions[0]!}::uuid`).toHaveLength(0);
        });

        it('an idle-looking session that holds a delivered send is `busy`', async () => {
            const { sessions, owner, epoch } = await connect('idle', undefined, 2);
            await data(await write('agentSession.send', { sessionId: sessions[0], text: 'work', idempotencyKey: randomUUID() }));
            const handed = await sync({ ownerId: owner, epoch, protocol: 2 });
            expect(handed.deliver).toHaveLength(1);
            expect(await data<Control>(await configure(sessions[0]!))).toMatchObject({ status: 'busy', reason: 'session_running' });
            // The other session is idle with nothing held: not busy.
            expect((await data<Control>(await configure(sessions[1]!))).status).not.toBe('busy');
        });

        it('a protocol-1 editor cannot apply it; a protocol-2 editor with no attested catalog is `catalog_unavailable`; an effort is BAD_REQUEST first', async () => {
            const one = await connect('idle');
            const before = await untouched();
            expect(await data<Control>(await configure(one.sessions[0]!, { model: 'kimi-k3' })))
                .toMatchObject({ status: 'rejected', reason: 'editor_controls_unsupported', requested: { model: 'kimi-k3', effort: null }, effective: null });
            const two = await connect('idle', undefined, 2);
            expect(await data<Control>(await configure(two.sessions[0]!, { model: 'kimi-k3' })))
                .toMatchObject({ status: 'rejected', reason: 'catalog_unavailable', effective: null });
            for (const extra of [{ effort: 'high' }, { model: 'kimi-k3', effort: 'high' }]) {
                const response = await configure(two.sessions[0]!, extra);
                expect(await code(response.clone())).toBe('BAD_REQUEST');
                expect((await response.json()).error.json.message).toBe('effort_not_per_session');
            }
            expect(await untouched()).not.toBe('');
            expect(before).not.toBe('');
        });

        it('a session the editor has not shown idle is rejected (not provably safe), not applied', async () => {
            const { sessions } = await connect('unknown', undefined, 2);
            expect(await data<Control>(await configure(sessions[0]!))).toMatchObject({ status: 'rejected', reason: 'session_state_unknown' });
        });

        it('replays the original row even after the session became busy or the editor disconnected; other input is a CONFLICT', async () => {
            const { sessions } = await connect('idle');
            const key = randomUUID();
            const first = await data<Control>(await configure(sessions[0]!, { model: 'kimi-k3' }, {}, key));
            expect(first.status).toBe('rejected');
            await setSessionStatus(sessions[0]!, 'running');
            expect(await data<Control>(await configure(sessions[0]!, { model: 'kimi-k3' }, {}, key))).toEqual(first);
            await expireLease();
            expect(await data<Control>(await configure(sessions[0]!, { model: 'kimi-k3' }, {}, key))).toEqual(first);
            for (const other of [{ model: 'qwen3-coder-next' }]) {
                expect(await code(await configure(sessions[0]!, other, {}, key))).toBe('CONFLICT');
            }
            expect(await code(await configure(sessions[1]!, { model: 'kimi-k3' }, {}, key))).toBe('CONFLICT');
            expect((await controlRows(client`idempotency_key = ${key}::uuid`)).length).toBe(1);
        });

        it('a retry returns the original row even after the session is gone; a new key against it is NOT_FOUND', async () => {
            const { sessions } = await connect('idle');
            const key = randomUUID();
            const first = await data<Control>(await configure(sessions[0]!, { model: 'kimi-k3' }, {}, key));
            await client`UPDATE public.ezil_agent_sessions SET present = false WHERE id = ${sessions[0]!}::uuid`;
            expect(await data<Control>(await configure(sessions[0]!, { model: 'kimi-k3' }, {}, key))).toEqual(first);
            expect(await code(await configure(sessions[0]!, { model: 'kimi-k3' }))).toBe('NOT_FOUND');
        });

        it("another person's or a gone session is NOT_FOUND with nothing recorded; a client or person has its own key space", async () => {
            const { sessions } = await connect();
            const key = randomUUID();
            expect(await code(await configure(sessions[0]!, { model: 'm' }, { sub: bob }, key))).toBe('NOT_FOUND');
            expect(await code(await configure(randomUUID(), { model: 'm' }, {}, key))).toBe('NOT_FOUND');
            expect(await controlRows(client`idempotency_key = ${key}::uuid`)).toHaveLength(0);
            const mine = await data<Control>(await configure(sessions[0]!, { model: 'm' }, {}, key));
            const other = await data<Control>(await configure(sessions[0]!, { model: 'm' }, { client_id: CLIENT2 }, key));
            expect(other.id).not.toBe(mine.id);
        });

        it('needs a model or an effort, takes no instruction text, mode or approvals, and only the write scope', async () => {
            const { sessions } = await connect();
            const key = randomUUID();
            expect(await code(await write('agentSession.configure', { sessionId: sessions[0], idempotencyKey: key }))).toBe('BAD_REQUEST');
            for (const extra of [{ text: 'x' }, { mode: 'agent' }, { approvals: 'auto' }, { instruction: 'x' }, { shell: 'sh' }]) {
                expect(await code(await write('agentSession.configure', { sessionId: sessions[0], model: 'm', idempotencyKey: key, ...extra }))).toBe('BAD_REQUEST');
            }
            expect(await code(await write('agentSession.configure', { sessionId: sessions[0], model: 'm', idempotencyKey: key }, {}, 'ezil:sessions:read'))).toBe('UNAUTHORIZED');
            expect(await controlRows(client`idempotency_key = ${key}::uuid`)).toHaveLength(0);
        });
    });

    describe('agentSession.control (retry reconciliation)', () => {
        it('finds the stored outcome by kind and key, for this person and client only', async () => {
            await expireLease();
            const key = randomUUID();
            expect(await data(await read('agentSession.control', { kind: 'create', idempotencyKey: key }))).toEqual({ found: false });
            const created = await data<Control>(await write('agentSession.create', { computerId: ids.a1, model: 'kimi-k3', idempotencyKey: key }));
            expect(await data(await read('agentSession.control', { kind: 'create', idempotencyKey: key }))).toEqual({ found: true, row: created });
            // Another kind, client or person never finds it.
            expect(await data(await read('agentSession.control', { kind: 'configure', idempotencyKey: key }))).toEqual({ found: false });
            expect(await data(await read('agentSession.control', { kind: 'create', idempotencyKey: key }, { client_id: CLIENT2 }))).toEqual({ found: false });
            expect(await data(await read('agentSession.control', { kind: 'create', idempotencyKey: key }, { sub: bob }))).toEqual({ found: false });
            // A start's row is not a session control row.
            const startKey = randomUUID();
            await data(await start({ computerId: ids.a1, idempotencyKey: startKey }));
            expect(await data(await read('agentSession.control', { kind: 'create', idempotencyKey: startKey }))).toEqual({ found: false });
            expect(await code(await read('agentSession.control', { kind: 'start', idempotencyKey: key }))).toBe('BAD_REQUEST');
            expect(await code(await read('agentSession.control', { kind: 'create', idempotencyKey: key }, {}, 'ezil:sessions:write'))).toBe('UNAUTHORIZED');
        });
    });

    // ── Editor bridge protocol 2: real OS routes and Postgres, a scripted editor ─────────────────────────────────────────
    describe('protocol 2: catalog, settings, create, configure', () => {
        type Delivery = { operationId: string; attemptId: string; kind: string; deliverWithinMs: number; model?: string; sessionResource?: string;
            reveal?: boolean; text?: string; effort?: string };
        type P2 = { owner: string; epoch: number; protocol?: number; deliver: Delivery[]; applied: number };
        const caller = { userId: alice, clientId: CLIENT };
        const fast = { createWaitMs: 0, configureWaitMs: 400, pollMs: 15 };
        const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, engine: 'ezil-chat', efforts: [], defaultEffort: null, configuredEffort: null, ...extra });
        const attestedRow = (id: string, configuredEffort: string | null = null) => row(id, { configuredEffort, availability: 'available' });
        const catalogOf = (...models: Record<string, unknown>[]) => ({ status: 'available', models, observedAt: 1 });
        const p2 = (owner: string, epoch: number, extra: Record<string, unknown> = {}, sandbox?: string) =>
            sync({ ownerId: owner, epoch, protocol: 2, ...extra }, sandbox) as Promise<P2>;
        const resourceOf = () => `vscode-chat-session://local/${randomUUID()}`;
        const sessionRow = async (sessionId: string) => (await client`SELECT * FROM public.ezil_agent_sessions WHERE id = ${sessionId}::uuid`)[0]!;
        const controlRow = async (id: string) => (await client`SELECT * FROM public.ezil_control_operations WHERE id = ${id}::uuid`)[0]!;
        /** A protocol-2 editor on a1 with its sessions and catalog reported; the second sync stores the catalog (it is only taken from the owner at its epoch). */
        const connect2 = async (models: Record<string, unknown>[] = [attestedRow('ezil/kimi-k3', 'high'), attestedRow('ezil/qwen3')], status: 'idle' | 'running' = 'idle') => {
            const base = await connect(status, undefined, 2);
            const sessions = base.resources.map((resource, i) => ({ resource, title: `Chat ${i + 1}`, open: true, status, model: 'ezil/qwen3', requests: 3 }));
            await p2(base.owner, base.epoch, { sessions, catalog: catalogOf(...models) });
            return { ...base, listed: sessions };
        };
        /** Sync as the editor until it is handed a delivery of `kind` (or give up). */
        const untilDelivered = async (owner: string, epoch: number, kind: string, extra: () => Record<string, unknown> = () => ({})) => {
            for (let i = 0; i < 80; i += 1) {
                const reply = await p2(owner, epoch, extra());
                const found = reply.deliver.find((d) => d.kind === kind);
                if (found) return { delivery: found, all: reply.deliver };
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error(`no ${kind} delivery`);
        };
        const applied = (d: Delivery, extra: Record<string, unknown>) => ({ operationId: d.operationId, attemptId: d.attemptId, status: 'applied', observedAt: 5, ...extra });
        const created = (d: Delivery, resource: string, model: string | null = d.model ?? 'ezil/qwen3') =>
            applied(d, { sessionResource: resource, model, requestCount: 0 });

        it('the longest a control request can hold its caller stays under the MCP\'s 10 s call timeout, so it never reports uncertain for a change OS then stores', async () => {
            const sync = await import('./control-sync');
            const worstConfigure = sync.CONFIGURE_WAIT_MS + sync.CONFIGURE_REPORT_GRACE_MS + 1_000;
            expect(worstConfigure).toBeLessThan(10_000 - 1_500);
            expect(control.CONTROL_TIMING.createWaitMs).toBeLessThan(10_000 - 1_500);
            expect(control.CONTROL_TIMING.configureWaitMs).toBe(sync.CONFIGURE_WAIT_MS);
        });

        it('negotiation: protocol 2 is answered only while the controls flag is on; protocol 1 bodies are unchanged and refuse any protocol-2 field', async () => {
            await expireLease();
            const owner = `w-${randomUUID()}`;
            const one = await syncRoute(syncRequest(sandboxOf(alice, ids.a1), { protocol: 1, seq: 1, ownerId: owner, epoch: 0 }));
            expect((await one.json()).protocol).toBe(2);
            vi.stubEnv('EZIL_EDITOR_BRIDGE_CONTROLS', '');
            await expireLease();
            const off = await syncRoute(syncRequest(sandboxOf(alice, ids.a1), { protocol: 2, seq: 1, ownerId: `w-${randomUUID()}`, epoch: 0 }));
            expect(off.status).toBe(200);
            expect((await off.json()).protocol).toBe(1);
            vi.stubEnv('EZIL_EDITOR_BRIDGE_CONTROLS', 'enabled');
            const session = { resource: 'r', title: 't', open: true, status: 'idle' };
            const bad: Record<string, unknown>[] = [
                { protocol: 1, sessions: [{ ...session, model: 'm', requests: 1 }] }, { protocol: 1, catalog: catalogOf(row('m')) },
                { protocol: 1, reports: [{ operationId: randomUUID(), attemptId: randomUUID(), status: 'applied' }] },
                { protocol: 2, sessions: [{ ...session }] }, { protocol: 2, sessions: [{ ...session, model: 'm', requests: 1, extra: 1 }] },
                { protocol: 2, catalog: catalogOf(row('m', { efforts: ['high'] })) }, { protocol: 2, catalog: catalogOf(row('m', { defaultEffort: 'high' })) },
                { protocol: 2, catalog: { status: 'unavailable', reason: 'x', models: [], observedAt: 1 } },
                { protocol: 2, catalog: catalogOf(row('m', { availability: 'unavailable' })) },
                { protocol: 2, reports: [{ operationId: randomUUID(), attemptId: randomUUID(), status: 'applied', effort: 'high' }] },
            ];
            for (const body of bad) {
                expect((await syncRoute(syncRequest(sandboxOf(alice, ids.a1), { seq: 9, ownerId: 'w-x', epoch: 0, ...body }))).status).toBe(400);
            }
        });

        it('flag off: a protocol-2 body is handled as protocol 1 (no catalog, no model, no control handed out) and answered 1', async () => {
            const { owner, epoch, sessions } = await connect2();
            const queued = await control.createSession(h.db as never, caller, { computerId: ids.a1, model: 'ezil/qwen3', idempotencyKey: randomUUID() }, fast);
            expect(queued.status).toBe('accepted');
            vi.stubEnv('EZIL_EDITOR_BRIDGE_CONTROLS', '');
            const reply = await syncRoute(syncRequest(sandboxOf(alice, ids.a1), { protocol: 2, seq: 99, ownerId: owner, epoch,
                sessions: [{ resource: resourceOf(), title: 'x', open: true, status: 'idle', model: 'ezil/zzz', requests: 9 }], catalog: catalogOf(attestedRow('ezil/zzz')) }));
            const body = await reply.json();
            expect(body).toMatchObject({ protocol: 1, owner: 'self' });
            expect(body.deliver).toEqual([]);
            expect((await controlRow(queued.id)).status).toBe('queued');
            expect((await client`SELECT model FROM public.ezil_agent_sessions WHERE computer_id = ${ids.a1}::uuid AND model = 'ezil/zzz'`)).toHaveLength(0);
            expect(JSON.stringify((await client`SELECT catalog FROM public.ezil_editor_bridge_owner WHERE computer_id = ${ids.a1}::uuid`)[0])).not.toContain('zzz');
            expect(sessions).toHaveLength(2);
        });

        describe('agentSession.models', () => {
            it('unavailable without a fresh attested catalog, with the exact gap; never any model, never accountScoped', async () => {
                const base = await connect(undefined, undefined, 2);
                const noCatalog = await data<Record<string, unknown>>(await read('agentSession.models', { computerId: ids.a1 }));
                expect(noCatalog).toMatchObject({ catalog: 'unavailable', models: [] });
                expect(String(noCatalog.reason)).toMatch(/has not reported its models yet/);
                expect(noCatalog).not.toHaveProperty('accountScoped');
                // The configured rows (no Gateway availability) are NOT entitlement proof.
                await p2(base.owner, base.epoch, { catalog: catalogOf(row('ezil/kimi-k3'), row('ezil/qwen3')) });
                const configured = await data<Record<string, unknown>>(await read('agentSession.models', { computerId: ids.a1 }));
                expect(configured).toMatchObject({ catalog: 'unavailable', models: [] });
                expect(String(configured.reason)).toMatch(/configured for every account.*does not report which of them the EZiL Gateway allows this account/);
                expect(configured).not.toHaveProperty('accountScoped');
                expect(JSON.stringify(configured)).not.toContain('kimi');
                // The editor itself could not read its list.
                await p2(base.owner, base.epoch, { catalog: { status: 'unavailable', reason: 'bridge_call_failed', observedAt: 1 } });
                const broken = await data<Record<string, unknown>>(await read('agentSession.models', { computerId: ids.a1 }));
                expect(broken).toMatchObject({ catalog: 'unavailable', models: [] });
                expect(String(broken.reason)).toMatch(/bridge_call_failed/);
            });

            it('available only for the rows the Gateway marked available for this account, stamped with OS\'s clock and accountScoped', async () => {
                await connect2([attestedRow('ezil/kimi-k3', 'high'), row('ezil/not-checked'), attestedRow('ezil/qwen3')]);
                const view = await data<Record<string, unknown>>(await read('agentSession.models', { computerId: ids.a1 }));
                expect(view).toMatchObject({ computerId: ids.a1, catalog: 'available', accountScoped: true });
                expect(view.models).toEqual([
                    { id: 'ezil/kimi-k3', label: 'ezil/kimi-k3', engine: 'ezil-chat', efforts: [], defaultEffort: null, configuredEffort: 'high' },
                    { id: 'ezil/qwen3', label: 'ezil/qwen3', engine: 'ezil-chat', efforts: [], defaultEffort: null, configuredEffort: null }]);
                // The editor said 1 ms; OS stamps its own reading time.
                expect(Math.abs(Date.now() - Date.parse(String(view.observedAt)))).toBeLessThan(15_000);
                expect(Object.keys(view).sort()).toEqual(['accountScoped', 'catalog', 'computerId', 'models', 'observedAt']);
            });

            it('lists only rows the MCP can show whole: an unsafe id, an empty label or a repeated id is left out, not the whole catalog', async () => {
                await connect2([attestedRow('ezil/ok'), attestedRow('ezil/ok'), attestedRow('ezil/bell\u0007'), attestedRow('ezil/blank', null),
                    { ...attestedRow('ezil/spaces'), label: ' \u202e ' }, attestedRow('ezil/second')]);
                const view = await data<{ models: { id: string }[] }>(await read('agentSession.models', { computerId: ids.a1 }));
                // `ezil/blank` has a real label (its id); only the blank-labelled row goes.
                expect(view.models.map((m) => m.id)).toEqual(['ezil/ok', 'ezil/blank', 'ezil/second']);
                await connect2([attestedRow('ezil/bell\u0007')]);
                expect(await data(await read('agentSession.models', { computerId: ids.a1 }))).toMatchObject({ catalog: 'unavailable', models: [] });
            });

            it('is stale after 45 s, gone with the lease, and never the previous window\'s after a takeover', async () => {
                const first = await connect2();
                await client`UPDATE public.ezil_editor_bridge_owner SET catalog_at = now() - interval '2 minutes' WHERE computer_id = ${ids.a1}::uuid`;
                const stale = await data<Record<string, unknown>>(await read('agentSession.models', { computerId: ids.a1 }));
                expect(stale).toMatchObject({ catalog: 'unavailable', models: [] });
                expect(String(stale.reason)).toMatch(/not reported its models recently/);
                await p2(first.owner, first.epoch, { catalog: catalogOf(attestedRow('ezil/qwen3')) });
                expect((await data<Record<string, unknown>>(await read('agentSession.models', { computerId: ids.a1 }))).catalog).toBe('available');
                await expireLease();
                expect(String((await data<Record<string, unknown>>(await read('agentSession.models', { computerId: ids.a1 }))).reason)).toMatch(/No editor is connected/);
                // A new window takes over: it starts with NO catalog.
                const second = await connect(undefined, undefined, 2);
                expect(second.epoch).toBeGreaterThan(first.epoch);
                expect((await client`SELECT catalog, catalog_at FROM public.ezil_editor_bridge_owner WHERE computer_id = ${ids.a1}::uuid`)[0]).toMatchObject({ catalog: null, catalog_at: null });
                expect(String((await data<Record<string, unknown>>(await read('agentSession.models', { computerId: ids.a1 }))).reason)).toMatch(/not reported its models yet/);
            });

            it('a catalog from a stale epoch or another computer is never stored', async () => {
                const { owner, epoch } = await connect2();
                await p2(owner, epoch + 7, { catalog: catalogOf(attestedRow('ezil/evil')) });
                expect(JSON.stringify((await client`SELECT catalog FROM public.ezil_editor_bridge_owner WHERE computer_id = ${ids.a1}::uuid`)[0])).not.toContain('evil');
                expect((await client`SELECT catalog FROM public.ezil_editor_bridge_owner WHERE computer_id = ${ids.a2}::uuid`)).toHaveLength(0);
            });
        });

        describe('agentSession.settings', () => {
            it('is what the editor read in that session\'s own input: its model, that model\'s fixed effort, effortSupported false, runtime', async () => {
                const { sessions, resources, owner, epoch } = await connect2();
                await p2(owner, epoch, { sessions: [{ resource: resources[0]!, title: 'a', open: true, status: 'idle', model: 'ezil/kimi-k3', requests: 4 },
                    { resource: resources[1]!, title: 'b', open: true, status: 'idle', model: 'ezil/qwen3', requests: 1 }] });
                const first = await data<{ settings: Record<string, unknown> | null }>(await read('agentSession.settings', { sessionId: sessions[0] }));
                expect(first.settings).toEqual({ model: 'ezil/kimi-k3', effort: 'high', effortSupported: false, observedAt: expect.any(String), source: 'runtime' });
                expect(Math.abs(Date.now() - Date.parse(String(first.settings!.observedAt)))).toBeLessThan(15_000);
                expect((await data<{ settings: Record<string, unknown> }>(await read('agentSession.settings', { sessionId: sessions[1] }))).settings)
                    .toMatchObject({ model: 'ezil/qwen3', effort: null });
            });

            it('is null when the model is unknown, the session closed, the reading stale, or no editor is connected', async () => {
                const { sessions, resources, owner, epoch } = await connect2();
                const settings = async (id: string) => (await data<{ settings: unknown }>(await read('agentSession.settings', { sessionId: id }))).settings;
                await p2(owner, epoch, { sessions: [{ resource: resources[0]!, title: 'a', open: true, status: 'idle', model: null, requests: null },
                    { resource: resources[1]!, title: 'b', open: false, status: 'unknown', model: null, requests: null }] });
                expect(await settings(sessions[0]!)).toBeNull();
                expect(await settings(sessions[1]!)).toBeNull();
                await p2(owner, epoch, { sessions: [{ resource: resources[0]!, title: 'a', open: true, status: 'idle', model: 'ezil/qwen3', requests: 1 }] });
                expect(await settings(sessions[0]!)).not.toBeNull();
                await client`UPDATE public.ezil_agent_sessions SET model_at = now() - interval '2 minutes' WHERE id = ${sessions[0]!}::uuid`;
                expect(await settings(sessions[0]!)).toBeNull();
                await p2(owner, epoch, { sessions: [{ resource: resources[0]!, title: 'a', open: true, status: 'idle', model: 'ezil/qwen3', requests: 1 }] });
                await expireLease();
                expect(await settings(sessions[0]!)).toBeNull();
            });

            it('a protocol-1 sync never overwrites or invents a session model', async () => {
                const { sessions, owner, epoch, resources } = await connect2();
                await sync({ ownerId: owner, epoch, sessions: [{ resource: resources[0]!, title: 'a', open: true, status: 'idle' }, { resource: resources[1]!, title: 'b', open: true, status: 'idle' }] });
                expect((await sessionRow(sessions[0]!)).model).toBe('ezil/qwen3');
            });
        });

        describe('agentSession.create', () => {
            it('is handed to the editor, answered by its report, and effective is the readback with the model\'s fixed effort (never the request)', async () => {
                const { owner, epoch } = await connect2();
                const key = randomUUID();
                const pending = write('agentSession.create', { computerId: ids.a1, model: 'ezil/kimi-k3', idempotencyKey: key });
                const { delivery } = await untilDelivered(owner, epoch, 'create');
                expect(delivery).toMatchObject({ kind: 'create', model: 'ezil/kimi-k3', attemptId: expect.any(String) });
                expect(delivery).not.toHaveProperty('sessionResource');
                expect(delivery).not.toHaveProperty('reveal');
                expect(delivery).not.toHaveProperty('effort');
                expect(delivery.deliverWithinMs).toBeGreaterThan(0);
                expect(delivery.deliverWithinMs).toBeLessThanOrEqual(60_000);
                const resource = resourceOf();
                // The editor reads back ANOTHER model: that, not the request, is what is effective.
                expect((await p2(owner, epoch, { reports: [created(delivery, resource, 'ezil/qwen3')] })).applied).toBe(1);
                const row2 = await data<Control>(await pending);
                expect(row2).toMatchObject({ kind: 'create', status: 'applied', computerId: ids.a1, expiresAt: null, reason: 'ephemeral_until_first_send',
                    requested: { model: 'ezil/kimi-k3', effort: null },
                    effective: { model: 'ezil/qwen3', effort: null, observedAt: expect.any(String), source: 'runtime' } });
                expect(row2.sessionId).toEqual(expect.any(String));
                const session = await sessionRow(row2.sessionId!);
                expect(session).toMatchObject({ resource, created_by_os: true, created_control_id: row2.id, present: true, open: true, request_count: 0, model: 'ezil/qwen3' });
                // A retry returns the stored readback, and the reconciliation read agrees.
                expect(await data<Control>(await write('agentSession.create', { computerId: ids.a1, model: 'ezil/kimi-k3', idempotencyKey: key }))).toEqual(row2);
                expect(await data(await read('agentSession.control', { kind: 'create', idempotencyKey: key }))).toEqual({ found: true, row: row2 });
                expect((await controlRows(client`idempotency_key = ${key}::uuid`)).length).toBe(1);
            });

            it('a model that matches carries its configured effort; a create with no model leaves the editor\'s default', async () => {
                const { owner, epoch } = await connect2();
                const pending = write('agentSession.create', { computerId: ids.a1, idempotencyKey: randomUUID() });
                const { delivery } = await untilDelivered(owner, epoch, 'create');
                expect(delivery).not.toHaveProperty('model');
                await p2(owner, epoch, { reports: [created(delivery, resourceOf(), 'ezil/kimi-k3')] });
                expect((await data<Control>(await pending))).toMatchObject({ status: 'applied', requested: { model: null, effort: null }, effective: { model: 'ezil/kimi-k3', effort: 'high' } });
            });

            it('a model OS cannot attest, or not in the attested list, is rejected before anything is queued; so is a protocol-1 editor or none', async () => {
                await connect2([row('ezil/unchecked')]);
                expect(await data<Control>(await write('agentSession.create', { computerId: ids.a1, model: 'ezil/unchecked', idempotencyKey: randomUUID() })))
                    .toMatchObject({ status: 'rejected', reason: 'catalog_unavailable', effective: null, expiresAt: null });
                await connect2();
                expect(await data<Control>(await write('agentSession.create', { computerId: ids.a1, model: 'ezil/not-listed', idempotencyKey: randomUUID() })))
                    .toMatchObject({ status: 'rejected', reason: 'model_not_offered' });
                expect(await client`SELECT 1 FROM public.ezil_control_operations WHERE computer_id = ${ids.a1}::uuid AND status IN ('queued', 'delivered')`).toHaveLength(0);
                await connect();
                expect(await data<Control>(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: randomUUID() })))
                    .toMatchObject({ status: 'rejected', reason: 'editor_controls_unsupported' });
                await expireLease();
                expect(await data<Control>(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: randomUUID() }))).toMatchObject({ status: 'disconnected' });
            });

            it('accepted while the editor has not taken it, then expired: never delivered after that, and read as expired without any sync', async () => {
                const { owner, epoch } = await connect2();
                const key = randomUUID();
                const accepted = await control.createSession(h.db as never, caller, { computerId: ids.a1, model: 'ezil/qwen3', idempotencyKey: key }, fast);
                expect(accepted).toMatchObject({ status: 'accepted', effective: null, sessionId: null, requested: { model: 'ezil/qwen3', effort: null } });
                expect(Date.parse(accepted.expiresAt!) - Date.now()).toBeGreaterThan(30_000);
                await client`UPDATE public.ezil_control_operations SET expires_at = now() - interval '1 second' WHERE id = ${accepted.id}::uuid`;
                expect(await data(await read('agentSession.control', { kind: 'create', idempotencyKey: key }))).toMatchObject({ found: true, row: { status: 'expired', reason: 'deadline_passed', expiresAt: null } });
                const reply = await p2(owner, epoch, {});
                expect(reply.deliver).toEqual([]);
                expect((await controlRow(accepted.id)).status).toBe('expired');
            });

            it('fencing: a wrong attempt, a stale epoch, a duplicate and a late report change nothing', async () => {
                const { owner, epoch } = await connect2();
                const key = randomUUID();
                const accepted = await control.createSession(h.db as never, caller, { computerId: ids.a1, model: 'ezil/qwen3', idempotencyKey: key }, fast);
                const { delivery } = await untilDelivered(owner, epoch, 'create');
                const resource = resourceOf();
                const report = created(delivery, resource);
                expect((await p2(owner, epoch, { reports: [{ ...report, attemptId: randomUUID() }] })).applied).toBe(0);
                expect((await p2(owner, epoch, { reports: [{ ...report, operationId: randomUUID() }] })).applied).toBe(0);
                expect((await controlRow(accepted.id)).status).toBe('delivered');
                // Another computer's editor, same ids: never matches.
                expect(await client`SELECT 1 FROM public.ezil_agent_sessions WHERE resource = ${resource}`).toHaveLength(0);
                expect((await p2(owner, epoch, { reports: [report] })).applied).toBe(1);
                const once = await controlRow(accepted.id);
                expect(once.status).toBe('applied');
                // The same report again, and a conflicting late one: no second session, no change.
                expect((await p2(owner, epoch, { reports: [report, { ...report, sessionResource: resourceOf(), model: 'ezil/zzz' }] })).applied).toBe(0);
                expect(await controlRow(accepted.id)).toEqual(once);
                expect(await client`SELECT 1 FROM public.ezil_agent_sessions WHERE created_control_id = ${accepted.id}::uuid`).toHaveLength(1);
            });

            it('a protocol-1 body from the same window is never handed a create (the editor would only refuse it); the next protocol-2 body is', async () => {
                const { owner, epoch } = await connect2();
                const accepted = await control.createSession(h.db as never, caller, { computerId: ids.a1, model: 'ezil/qwen3', idempotencyKey: randomUUID() }, fast);
                const one = await sync({ ownerId: owner, epoch });
                expect(one.deliver).toEqual([]);
                expect((await controlRow(accepted.id)).status).toBe('queued');
                const two = await p2(owner, epoch, {});
                expect(two.deliver.map((d) => d.operationId)).toEqual([accepted.id]);
            });

            it('a report at an old epoch is refused; whatever the old window held is uncertain (owner_changed), and its late report cannot undo that', async () => {
                const first = await connect2();
                const accepted = await control.createSession(h.db as never, caller, { computerId: ids.a1, idempotencyKey: randomUUID() }, fast);
                const { delivery } = await untilDelivered(first.owner, first.epoch, 'create');
                // Read time: still the same live owner at the same epoch.
                expect((await data<{ row: Control }>(await read('agentSession.control', { kind: 'create', idempotencyKey: (await controlRow(accepted.id)).idempotency_key }))).row.status).toBe('accepted');
                await expireLease();
                // Lease lapsed: uncertain at read time, before any sync.
                expect((await data<{ row: Control }>(await read('agentSession.control', { kind: 'create', idempotencyKey: (await controlRow(accepted.id)).idempotency_key }))).row)
                    .toMatchObject({ status: 'uncertain', reason: 'owner_changed', expiresAt: null });
                const second = await connect(undefined, undefined, 2);
                expect(second.epoch).toBeGreaterThan(first.epoch);
                expect((await controlRow(accepted.id)).status).toBe('uncertain');
                const late = await p2(first.owner, first.epoch, { reports: [created(delivery, resourceOf())] });
                // The old window is told it is no longer the owner: its report is never even read.
                expect(late).toMatchObject({ owner: 'other' });
                expect((await controlRow(accepted.id)).status).toBe('uncertain');
                expect(await client`SELECT 1 FROM public.ezil_agent_sessions WHERE created_control_id = ${accepted.id}::uuid`).toHaveLength(0);
                // And it is never handed out again.
                expect((await p2(second.owner, second.epoch, {})).deliver).toEqual([]);
            });

            it('a created session that OS cannot tell is new is uncertain and never marked as OS\'s (no reveal): requests > 0, no count, or a known resource', async () => {
                const { owner, epoch, resources, sessions } = await connect2();
                for (const [label, mutate] of [['busy', { requestCount: 2 }], ['no count', { requestCount: undefined }], ['known', { sessionResource: resources[0] }]] as const) {
                    const accepted = await control.createSession(h.db as never, caller, { computerId: ids.a1, model: 'ezil/qwen3', idempotencyKey: randomUUID() }, fast);
                    const { delivery } = await untilDelivered(owner, epoch, 'create');
                    await p2(owner, epoch, { reports: [{ ...created(delivery, resourceOf()), ...mutate }] });
                    expect({ label, ...(await controlRow(accepted.id)) }).toMatchObject({ label, status: 'uncertain', reason: 'created_session_not_tracked' });
                }
                const marked = await client`SELECT 1 FROM public.ezil_agent_sessions s JOIN public.ezil_control_operations c ON c.id = s.created_control_id
                    WHERE c.computer_id = ${ids.a1}::uuid AND c.created_at > now() - interval '1 minute' AND c.status = 'uncertain' AND c.reason = 'created_session_not_tracked'`;
                expect(marked).toHaveLength(0);
                expect((await sessionRow(sessions[0]!)).created_by_os).toBeNull();
            });

            it('every editor answer maps onto the frozen statuses: not_delivered requeues under a NEW attempt; the rest are final', async () => {
                const { owner, epoch } = await connect2();
                const first = await control.createSession(h.db as never, caller, { computerId: ids.a1, idempotencyKey: randomUUID() }, fast);
                const one = (await untilDelivered(owner, epoch, 'create')).delivery;
                await p2(owner, epoch, { reports: [{ operationId: one.operationId, attemptId: one.attemptId, status: 'not_delivered', reason: 'stale_owner' }] });
                expect((await controlRow(first.id)).status).toBe('queued');
                // Backed off, then again under a different attempt.
                await client`UPDATE public.ezil_control_operations SET not_before = now() WHERE id = ${first.id}::uuid`;
                const two = (await untilDelivered(owner, epoch, 'create')).delivery;
                expect(two.operationId).toBe(one.operationId);
                expect(two.attemptId).not.toBe(one.attemptId);
                // The first attempt's report can no longer move it.
                expect((await p2(owner, epoch, { reports: [{ operationId: one.operationId, attemptId: one.attemptId, status: 'rejected', reason: 'bad_request' }] })).applied).toBe(0);
                const answers: [Record<string, unknown>, string, string | null][] = [
                    [{ status: 'rejected', reason: 'model_not_offered' }, 'rejected', 'model_not_offered'],
                    [{ status: 'rejected', reason: 'effort_not_per_session' }, 'rejected', 'effort_not_per_session'],
                    [{ status: 'expired', reason: 'deadline_passed' }, 'expired', 'deadline_passed'],
                    [{ status: 'failed', reason: 'not_opened' }, 'failed', 'not_opened'],
                    [{ status: 'uncertain', reason: 'create_outcome_unknown' }, 'uncertain', 'create_outcome_unknown'],
                ];
                const rows: string[] = [];
                for (const [answer, status, reason] of answers) {
                    const accepted = await control.createSession(h.db as never, caller, { computerId: ids.a1, idempotencyKey: randomUUID() }, fast);
                    const delivery = (await untilDelivered(owner, epoch, 'create')).delivery;
                    await p2(owner, epoch, { reports: [{ operationId: delivery.operationId, attemptId: delivery.attemptId, ...answer }] });
                    expect(await controlRow(accepted.id)).toMatchObject({ status, reason, effective_model: null, session_id: null });
                    rows.push(accepted.id);
                }
                expect(rows).toHaveLength(5);
                expect((await p2(owner, epoch, {})).deliver).toEqual([]);
            });

            it('two creates under two keys are two sessions, each handed out once; the same key concurrently is one row and one session', async () => {
                const { owner, epoch } = await connect2();
                const a = await control.createSession(h.db as never, caller, { computerId: ids.a1, idempotencyKey: randomUUID() }, fast);
                const b = await control.createSession(h.db as never, caller, { computerId: ids.a1, idempotencyKey: randomUUID() }, fast);
                const reply = await p2(owner, epoch, {});
                expect(reply.deliver.map((d) => d.operationId).sort()).toEqual([a.id, b.id].sort());
                expect((await p2(owner, epoch, {})).deliver).toEqual([]);

                // Same key, two requests at once: the second waits on the first's uncommitted row and gets the same one back.
                let release!: () => void;
                const gate = new Promise<void>((resolve) => { release = resolve; });
                const held = {
                    execute: (query: never) => (h.db as { execute: (q: never) => Promise<never> }).execute(query),
                    transaction: async <T>(run: (tx: never) => Promise<T>) =>
                        (h.db as { transaction: (r: (tx: never) => Promise<T>) => Promise<T> }).transaction(async (tx) => { const result = await run(tx); await gate; return result; }),
                };
                const key = randomUUID();
                const input = { computerId: ids.a1, model: 'ezil/qwen3', idempotencyKey: key };
                const winner = control.createSession(held as never, caller, input, fast);
                for (let i = 0; i < 200 && (await client`SELECT 1 FROM public.ezil_control_operations WHERE idempotency_key = ${key}::uuid`).length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
                const loser = control.createSession(h.db as never, caller, input, fast);
                let waiting = false;
                for (let i = 0; i < 400 && !waiting; i += 1) {
                    waiting = (await client`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%control:insert%'`).length > 0;
                    if (!waiting) await new Promise((r) => setTimeout(r, 5));
                }
                expect(waiting).toBe(true);
                release();
                const [one, two] = await Promise.all([winner, loser]);
                expect(two.id).toBe(one.id);
                expect((await controlRows(client`idempotency_key = ${key}::uuid`)).length).toBe(1);
                expect((await p2(owner, epoch, {})).deliver.filter((d) => d.operationId === one.id)).toHaveLength(1);
            });
        });

        describe('agentSession.configure', () => {
            const cfg = (sessionId: string, model = 'ezil/kimi-k3', key = randomUUID()) =>
                write('agentSession.configure', { sessionId, model, idempotencyKey: key });

            it('applied: handed out only while idle, answered by the report; effective is the readback and the session\'s model follows it', async () => {
                const { owner, epoch, sessions, resources } = await connect2();
                const pending = cfg(sessions[0]!, 'ezil/kimi-k3');
                const { delivery } = await untilDelivered(owner, epoch, 'configure');
                expect(delivery).toMatchObject({ kind: 'configure', model: 'ezil/kimi-k3', sessionResource: resources[0] });
                expect(delivery).not.toHaveProperty('reveal');
                expect(delivery).not.toHaveProperty('effort');
                expect(delivery.deliverWithinMs).toBeLessThanOrEqual(5_000);
                await p2(owner, epoch, { reports: [applied(delivery, { sessionResource: resources[0], model: 'ezil/kimi-k3', requestCount: 3 })] });
                const done = await data<Control>(await pending);
                expect(done).toMatchObject({ kind: 'configure', status: 'applied', sessionId: sessions[0], reason: null,
                    requested: { model: 'ezil/kimi-k3', effort: null }, effective: { model: 'ezil/kimi-k3', effort: 'high', source: 'runtime' } });
                expect((await sessionRow(sessions[0]!)).model).toBe('ezil/kimi-k3');
                expect((await sessionRow(sessions[1]!)).model).toBe('ezil/qwen3');
            });

            it('a readback that differs from the request is still `applied`, with the readback as effective and the editor\'s reason', async () => {
                const { owner, epoch, sessions, resources } = await connect2();
                const pending = cfg(sessions[1]!, 'ezil/kimi-k3');
                const { delivery } = await untilDelivered(owner, epoch, 'configure');
                await p2(owner, epoch, { reports: [applied(delivery, { sessionResource: resources[1], model: 'ezil/qwen3', requestCount: 3, reason: 'model_not_applied' })] });
                expect(await data<Control>(await pending)).toMatchObject({ status: 'applied', reason: 'model_not_applied', requested: { model: 'ezil/kimi-k3' }, effective: { model: 'ezil/qwen3', effort: null } });
            });

            it('never queued: a running session is busy, a held send is busy, the editor\'s `busy` is busy, and nothing is handed out later', async () => {
                const running = await connect2(undefined, 'running');
                expect(await data<Control>(await cfg(running.sessions[0]!))).toMatchObject({ status: 'busy', reason: 'session_running', effective: null });
                const idle = await connect2();
                await data(await write('agentSession.send', { sessionId: idle.sessions[0], text: 'queued work', idempotencyKey: randomUUID() }));
                expect(await data<Control>(await cfg(idle.sessions[0]!))).toMatchObject({ status: 'busy' });
                // The editor answers busy after the handout (the session started between syncs): final, never retried.
                const other = idle.sessions[1]!;
                const pending = cfg(other);
                const { delivery } = await untilDelivered(idle.owner, idle.epoch, 'configure');
                await p2(idle.owner, idle.epoch, { reports: [{ operationId: delivery.operationId, attemptId: delivery.attemptId, status: 'not_delivered', reason: 'busy' }] });
                expect(await data<Control>(await pending)).toMatchObject({ status: 'busy', reason: 'session_running', effective: null });
                expect((await sessionRow(other)).model).toBe('ezil/qwen3');
                expect((await p2(idle.owner, idle.epoch, {})).deliver.filter((d) => d.kind === 'configure')).toEqual([]);
            });

            it('every editor answer maps onto the frozen configure statuses, and none is ever redelivered', async () => {
                const { owner, epoch, sessions } = await connect2();
                const answers: [Record<string, unknown>, string, string][] = [
                    [{ status: 'not_delivered', reason: 'not_open' }, 'rejected', 'session_not_open'],
                    [{ status: 'not_delivered', reason: 'stale_owner' }, 'disconnected', 'stale_owner'],
                    [{ status: 'not_delivered', reason: 'disconnected' }, 'disconnected', 'disconnected'],
                    [{ status: 'rejected', reason: 'model_not_offered' }, 'rejected', 'model_not_offered'],
                    [{ status: 'rejected', reason: 'unknown_session' }, 'rejected', 'unknown_session'],
                    [{ status: 'expired', reason: 'deadline_passed' }, 'failed', 'deadline_passed'],
                    [{ status: 'failed', reason: 'bridge_error' }, 'failed', 'bridge_error'],
                    [{ status: 'uncertain', reason: 'configure_outcome_unknown' }, 'uncertain', 'configure_outcome_unknown'],
                ];
                for (const [answer, status, reason] of answers) {
                    const pending = cfg(sessions[0]!);
                    const { delivery } = await untilDelivered(owner, epoch, 'configure');
                    await p2(owner, epoch, { reports: [{ operationId: delivery.operationId, attemptId: delivery.attemptId, ...answer }] });
                    expect(await data<Control>(await pending)).toMatchObject({ kind: 'configure', status, reason, effective: null });
                }
                expect((await p2(owner, epoch, {})).deliver).toEqual([]);
                expect((await sessionRow(sessions[0]!)).model).toBe('ezil/qwen3');
            });

            it('no sync takes it in time: final (never held), and never delivered afterwards; a delivered one nobody answers is uncertain, and a late report is dropped', async () => {
                const { owner, epoch, sessions, resources } = await connect2();
                const unanswered = await control.configureSession(h.db as never, caller, { sessionId: sessions[0]!, model: 'ezil/kimi-k3', idempotencyKey: randomUUID() }, fast);
                expect(unanswered).toMatchObject({ status: 'failed', reason: 'deadline_passed', effective: null });
                expect((await p2(owner, epoch, {})).deliver.filter((d) => d.kind === 'configure')).toEqual([]);
                // Delivered, then silence: uncertain once the deadline and the grace pass.
                const key = randomUUID();
                const run = control.configureSession(h.db as never, caller, { sessionId: sessions[1]!, model: 'ezil/kimi-k3', idempotencyKey: key }, { ...fast, configureWaitMs: 2_000 });
                const { delivery } = await untilDelivered(owner, epoch, 'configure');
                await client`UPDATE public.ezil_control_operations SET expires_at = now() - interval '10 seconds' WHERE id = ${delivery.operationId}::uuid`;
                const lost = await run;
                expect(lost).toMatchObject({ status: 'uncertain', reason: 'no_report_in_time', effective: null });
                expect((await p2(owner, epoch, { reports: [applied(delivery, { sessionResource: resources[1], model: 'ezil/kimi-k3', requestCount: 3 })] })).applied).toBe(0);
                expect((await controlRow(delivery.operationId)).status).toBe('uncertain');
                expect((await sessionRow(sessions[1]!)).model).toBe('ezil/qwen3');
                // A retry returns exactly that.
                expect(await control.configureSession(h.db as never, caller, { sessionId: sessions[1]!, model: 'ezil/kimi-k3', idempotencyKey: key }, fast)).toEqual(lost);
            });

            it('queued but never taken while its session gets work: `busy` at its deadline, stored that way (not merely derived), and never delivered', async () => {
                const { owner, epoch, sessions } = await connect2();
                const key = randomUUID();
                const run = control.configureSession(h.db as never, caller, { sessionId: sessions[0]!, model: 'ezil/kimi-k3', idempotencyKey: key }, { ...fast, configureWaitMs: 1_500 });
                // Only once the configure is queued does the session get work (deterministic: no timing guess).
                for (let i = 0; i < 400 && (await client`SELECT 1 FROM public.ezil_control_operations WHERE idempotency_key = ${key}::uuid AND status = 'queued'`).length === 0; i += 1) {
                    await new Promise((r) => setTimeout(r, 5));
                }
                await data(await write('agentSession.send', { sessionId: sessions[0], text: 'now busy', idempotencyKey: randomUUID() }));
                const row = await run;
                expect(row).toMatchObject({ status: 'busy', reason: 'session_running', effective: null });
                expect((await controlRow(row.id)).status).toBe('busy');
                expect((await p2(owner, epoch, {})).deliver.filter((d) => d.kind === 'configure')).toEqual([]);
            });

            it('a model that is not attested, not listed, or no editor/protocol 2: rejected at OS before queueing; an effort alone or with a model is BAD_REQUEST', async () => {
                const { sessions } = await connect2([row('ezil/unchecked')]);
                expect(await data<Control>(await cfg(sessions[0]!, 'ezil/unchecked'))).toMatchObject({ status: 'rejected', reason: 'catalog_unavailable' });
                const two = await connect2();
                expect(await data<Control>(await cfg(two.sessions[0]!, 'ezil/not-listed'))).toMatchObject({ status: 'rejected', reason: 'model_not_offered' });
                expect(await client`SELECT 1 FROM public.ezil_control_operations WHERE kind = 'configure' AND status IN ('queued', 'delivered') AND computer_id = ${ids.a1}::uuid`).toHaveLength(0);
                for (const extra of [{ effort: 'high' }, { model: 'ezil/kimi-k3', effort: 'high' }]) {
                    const response = await write('agentSession.configure', { sessionId: two.sessions[0], idempotencyKey: randomUUID(), ...extra });
                    expect(await code(response.clone())).toBe('BAD_REQUEST');
                    expect((await response.json()).error.json.message).toBe('effort_not_per_session');
                }
            });

            it('reveal: only a session OS created gets it, from the database, on sends and configures — never the person\'s chat, never under protocol 1', async () => {
                const { owner, epoch, resources, sessions } = await connect2();
                const pending = write('agentSession.create', { computerId: ids.a1, idempotencyKey: randomUUID() });
                const { delivery } = await untilDelivered(owner, epoch, 'create');
                const resource = resourceOf();
                await p2(owner, epoch, { reports: [created(delivery, resource, 'ezil/qwen3')] });
                const made = await data<Control>(await pending);
                const mine = made.sessionId!;
                // A later sessions report (and its ON CONFLICT upsert) never clears the marking.
                await p2(owner, epoch, { sessions: [{ resource, title: 'New chat', open: true, status: 'idle', model: 'ezil/qwen3', requests: 0 },
                    ...resources.map((r) => ({ resource: r, title: 'x', open: true, status: 'idle', model: 'ezil/qwen3', requests: 3 }))] });
                expect((await sessionRow(mine)).created_by_os).toBe(true);
                expect((await sessionRow(sessions[0]!)).created_by_os).toBeNull();

                await data(await write('agentSession.send', { sessionId: mine, text: 'to the created chat', idempotencyKey: randomUUID() }));
                await data(await write('agentSession.send', { sessionId: sessions[0], text: 'to the person\'s chat', idempotencyKey: randomUUID() }));
                const handed = (await p2(owner, epoch, {})).deliver.filter((d) => d.kind === 'send');
                expect(handed).toHaveLength(2);
                expect(handed.find((d) => d.sessionResource === resource)).toMatchObject({ reveal: true });
                expect(handed.find((d) => d.sessionResource === resources[0])).not.toHaveProperty('reveal');
                for (const d of handed) await p2(owner, epoch, { reports: [{ operationId: d.operationId, attemptId: d.attemptId, status: 'completed' }] });

                // configure: reveal for the created chat only.
                const cfgMine = cfg(mine);
                const one = (await untilDelivered(owner, epoch, 'configure')).delivery;
                expect(one).toMatchObject({ sessionResource: resource, reveal: true });
                await p2(owner, epoch, { reports: [applied(one, { sessionResource: resource, model: 'ezil/kimi-k3', requestCount: 1 })] });
                expect((await data<Control>(await cfgMine)).status).toBe('applied');
                const cfgPerson = cfg(sessions[1]!);
                const two = (await untilDelivered(owner, epoch, 'configure')).delivery;
                expect(two.sessionResource).toBe(resources[1]);
                expect(two).not.toHaveProperty('reveal');
                await p2(owner, epoch, { reports: [applied(two, { sessionResource: resources[1], model: 'ezil/kimi-k3', requestCount: 3 })] });
                await cfgPerson;

                // A protocol-1 body is handed a send with no reveal, even for OS's own session.
                await data(await write('agentSession.send', { sessionId: mine, text: 'again', idempotencyKey: randomUUID() }));
                const v1 = await sync({ ownerId: owner, epoch });
                expect(v1.deliver).toHaveLength(1);
                expect(v1.deliver[0]).not.toHaveProperty('reveal');
            });
        });

        describe('ownership', () => {
            it('the computer\'s current owner is confirmed in the sync transaction: a transfer that commits while a sync waits is refused, and nothing is touched', async () => {
                const carol = randomUUID();
                const computer = randomUUID();
                await client`INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (${carol}::uuid, 'c@example.com', now())`;
                await client`INSERT INTO public.ezil_computers (id, user_id, name, slot) VALUES (${computer}::uuid, ${alice}::uuid, 'T1', 3)`;
                const store = await import('./store');
                let release!: () => void;
                const hold = new Promise<void>((resolve) => { release = resolve; });
                const transfer = client.begin(async (tx) => {
                    await tx`UPDATE public.ezil_computers SET user_id = ${carol}::uuid WHERE id = ${computer}::uuid`;
                    await hold;
                });
                await new Promise((r) => setTimeout(r, 50));
                // The route resolved `alice` before the transfer committed; the sync itself must notice.
                const syncing = store.syncEditor(h.db as never, { id: computer, userId: alice }, { protocol: 2, ownerId: 'w-stale', epoch: 0, seq: 1 }, { controls: true });
                let waiting = false;
                for (let i = 0; i < 400 && !waiting; i += 1) {
                    waiting = (await client`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%agent-session:computer-lock%'`).length > 0;
                    if (!waiting) await new Promise((r) => setTimeout(r, 5));
                }
                expect(waiting).toBe(true);
                release();
                await transfer;
                expect(await syncing).toEqual({ owner: 'gone' });
                expect(await client`SELECT 1 FROM public.ezil_editor_bridge_owner WHERE computer_id = ${computer}::uuid`).toHaveLength(0);
                // The new owner's own sync is a fresh epoch 1.
                const next = await store.syncEditor(h.db as never, { id: computer, userId: carol }, { protocol: 2, ownerId: 'w-carol', epoch: 0, seq: 1 }, { controls: true });
                expect(next).toMatchObject({ owner: 'self', epoch: 1 });
            });

            it('a transfer waits for a control insert holding the computer; and the previous person\'s queued controls never reach the new owner\'s editor', async () => {
                const carol = randomUUID();
                const computer = randomUUID();
                await client`INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (${carol}::uuid, 'c2@example.com', now())`;
                await client`INSERT INTO public.ezil_computers (id, user_id, name, slot) VALUES (${computer}::uuid, ${alice}::uuid, 'T2', 4)`;
                const store = await import('./store');
                const sandbox = sandboxOf(alice, computer);
                const first = await p2('w-alice', 0, {}, sandbox);
                await p2('w-alice', first.epoch, { catalog: catalogOf(attestedRow('ezil/qwen3')) }, sandbox);
                const queued = await control.createSession(h.db as never, caller, { computerId: computer, model: 'ezil/qwen3', idempotencyKey: randomUUID() }, fast);
                expect(queued.status).toBe('accepted');
                await client`UPDATE public.ezil_computers SET user_id = ${carol}::uuid WHERE id = ${computer}::uuid`;
                await client`UPDATE public.ezil_editor_bridge_owner SET lease_until = now() - interval '1 second' WHERE computer_id = ${computer}::uuid`;
                const taken = await store.syncEditor(h.db as never, { id: computer, userId: carol }, { protocol: 2, ownerId: 'w-carol', epoch: 0, seq: 1 }, { controls: true });
                expect(taken).toMatchObject({ owner: 'self', deliver: [] });
                expect(await controlRow(queued.id)).toMatchObject({ status: 'rejected', reason: 'computer_reassigned' });
                // Alice's old window, if it ever syncs again for the computer, is refused.
                const stale = await syncRoute(syncRequest(sandbox, { protocol: 2, seq: 50, ownerId: 'w-alice', epoch: first.epoch }));
                expect(stale.status).toBe(404);
            });
        });
    });

    describe('audit and retention', () => {
        it('one redacted line per control call: jti, client, sub, procedure, key and outcome, and nothing else of the request', async () => {
            const info = vi.spyOn(console, 'info').mockImplementation(() => {});
            await expireLease();
            const key = randomUUID();
            const jti = randomUUID();
            await data(await write('agentSession.create', { computerId: ids.a1, model: 'secret-model-name', idempotencyKey: key }, { jti }));
            const lines = info.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((l) => l.event === 'ezil_control');
            expect(lines).toEqual([{ event: 'ezil_control', jti, client_id: CLIENT, sub: alice, user_id: alice, procedure: 'agentSession.create', idempotency_key: key, outcome: 'disconnected' }]);
            const all = info.mock.calls.map(([line]) => String(line)).join('\n');
            expect(all).not.toMatch(/secret-model-name|EZiL-Delegation|a@example\.com/);
            // The gate's own line still names the procedure and that it went through.
            expect(info.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
                .some((l) => l.event === 'ezil_delegation' && l.procedure === 'agentSession.create' && l.outcome === 'ok' && l.jti === jti)).toBe(true);

            info.mockClear();
            const startJti = randomUUID();
            const startKey = randomUUID();
            port.gate = { allowed: false, reason: 'no_plan' };
            await data(await start({ computerId: ids.a1, idempotencyKey: startKey }, { jti: startJti }));
            const startLine = info.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).find((l) => l.event === 'ezil_control');
            expect(startLine).toEqual({ event: 'ezil_control', jti: startJti, client_id: CLIENT, sub: alice, user_id: alice, procedure: 'computer.start', idempotency_key: startKey, outcome: 'refused_allowance' });

            // A refused effort is audited too, with the code (never the request).
            info.mockClear();
            await write('agentSession.create', { computerId: ids.a1, effort: 'high', idempotencyKey: randomUUID() });
            expect(info.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).find((l) => l.event === 'ezil_control')).toMatchObject({ outcome: 'error:BAD_REQUEST' });

            info.mockClear();
            await write('agentSession.create', { computerId: ids.b1, idempotencyKey: randomUUID() });
            expect(info.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).find((l) => l.event === 'ezil_control')).toMatchObject({ outcome: 'error:NOT_FOUND' });
        });

        it('rows older than 7 days are deleted and their key is free again; newer rows stay', async () => {
            await expireLease();
            const oldKey = randomUUID();
            const newKey = randomUUID();
            const old = await data<Control>(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: oldKey }));
            await data(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: newKey }));
            await client`UPDATE public.ezil_control_operations SET created_at = now() - interval '8 days' WHERE id = ${old.id}::uuid`;
            await control.pruneControl(h.db as never);
            expect(await controlRows(client`idempotency_key = ${oldKey}::uuid`)).toHaveLength(0);
            expect(await controlRows(client`idempotency_key = ${newKey}::uuid`)).toHaveLength(1);
            expect((await data<Control>(await write('agentSession.create', { computerId: ids.a1, idempotencyKey: oldKey }))).id).not.toBe(old.id);
        });
    });
});
