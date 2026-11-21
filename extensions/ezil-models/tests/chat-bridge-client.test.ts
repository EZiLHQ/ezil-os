// The extension side of the EZiL Chat bridge: what the workbench's answers become at OS, and where the client syncs.
// End to end (OS, Worker, this client and the shipped workbench bridge): app/src/server/agent-session/chain.pg.test.ts.

import { describe, expect, test } from 'bun:test';

import { ChatBridgeClient, controlReport, submitReport, syncUrlFrom } from '../src/chat-bridge-client';

const OP = '00000000-0000-4000-8000-000000000001';
const ATTEMPT = '00000000-0000-4000-8000-0000000000aa';

describe('submitReport: only a definite "not sent" goes back to the queue', () => {
    test('refusals before delivery are not_delivered; definitive refusals are rejected', () => {
        for (const view of [{ ok: true, status: 'busy' }, { ok: true, status: 'not_open' }, { ok: false, error: 'stale_owner' }, { ok: false, error: 'no_owner' }, { ok: false, error: 'disconnected' }]) {
            expect(submitReport(OP, view).status).toBe('not_delivered');
        }
        expect(submitReport(OP, { ok: true, status: 'unknown_session' })).toEqual({ operationId: OP, status: 'rejected', reason: 'unknown_session' });
        expect(submitReport(OP, { ok: true, status: 'unsupported_session' }).reason).toBe('unsupported_session');
        expect(submitReport(OP, { ok: true, status: 'rejected', reason: 'Some Free Text!' })).toEqual({ operationId: OP, status: 'rejected', reason: 'chat_rejected' });
        expect(submitReport(OP, { ok: false, error: 'command_conflict' }).status).toBe('rejected');
    });

    test('anything whose outcome is unknown is uncertain, never not_delivered', () => {
        for (const view of [undefined, null, 'sent', {}, { ok: true }, { ok: true, status: 'uncertain' }, { ok: true, status: 'queued' }, { ok: false, error: 'internal_error' }, { ok: false }]) {
            expect([JSON.stringify(view), submitReport(OP, view).status]).toEqual([JSON.stringify(view), 'uncertain']);
        }
    });

    test('accepted states carry the request id, mode and selected model, bounded', () => {
        expect(submitReport(OP, { ok: true, status: 'in_progress', requestId: 'r1', mode: 'agent', selectedModelId: 'ezil/kimi-k2' }))
            .toEqual({ operationId: OP, status: 'running', requestId: 'r1', mode: 'agent', selectedModelId: 'ezil/kimi-k2' });
        for (const status of ['completed', 'cancelled', 'finished_unverified', 'cancel_requested', 'failed', 'expired'] as const) {
            expect(submitReport(OP, { ok: true, status }).status).toBe(status);
        }
        expect(submitReport(OP, { ok: true, status: 'in_progress', mode: 'x'.repeat(500) }).mode).toHaveLength(64);
    });
});

describe('syncUrlFrom and the client boundary', () => {
    test('derives the code host\'s sync route from EZIL_AI_BASE_URL; https only (http only for localhost)', () => {
        expect(syncUrlFrom('https://8443-guac-a-b-code.ezil.work/ai/v1')).toBe('https://8443-guac-a-b-code.ezil.work/editor-bridge/v1/sync');
        expect(syncUrlFrom('http://8443-x.localhost:8787/ai/v1')).toBe('http://8443-x.localhost:8787/editor-bridge/v1/sync');
        for (const bad of [undefined, '', 'not a url', 'http://evil.example/ai/v1', 'file:///etc/passwd']) expect(syncUrlFrom(bad)).toBeNull();
    });

    test('no bridge in this window: no sync is attempted and the token goes nowhere', async () => {
        const fetched: string[] = [];
        const client = new ChatBridgeClient({
            syncUrl: 'https://h/editor-bridge/v1/sync', token: 'a'.repeat(64), ownerId: 'ext.one', log: () => {},
            execute: async () => { throw new Error("command '_ezil.chatBridge.v1' not found"); },
            fetch: async (url) => { fetched.push(url); return Response.json({}); },
        });
        expect(await client.tick()).toBeGreaterThan(1000);
        expect(fetched).toEqual([]);
        expect(() => new ChatBridgeClient({ syncUrl: 'x', token: 't', ownerId: 'has space', log: () => {}, execute: async () => ({}), fetch: async () => Response.json({}) })).toThrow();
    });

    test('logs never contain the token, even when OS refuses', async () => {
        const token = 'b'.repeat(64);
        const logs: string[] = [];
        const client = new ChatBridgeClient({
            syncUrl: 'https://h/editor-bridge/v1/sync', token, ownerId: 'ext.two', log: (line) => logs.push(line),
            execute: async () => ({ ok: true, protocol: 1 }),
            fetch: async () => Response.json({ error: { code: 'os_bridge_unauthorized' } }, { status: 401 }),
        });
        await client.tick();
        expect(logs.join('\n')).toContain('HTTP 401');
        expect(logs.join('\n')).not.toContain(token);
    });

    test('a workbench call that throws mid-submit is reported uncertain and never resubmitted', async () => {
        const bodies: Record<string, unknown>[] = [];
        let submits = 0;
        const replies = [
            { ok: true, owner: 'self', epoch: 3, pollMs: 2000, deliver: [] },
            { ok: true, owner: 'self', epoch: 3, pollMs: 2000, deliver: [{ operationId: OP, attemptId: ATTEMPT, deliverWithinMs: 60000, kind: 'send', sessionResource: 'vscode-chat-session://local/s1', text: 'x' }] },
            { ok: true, owner: 'self', epoch: 3, pollMs: 2000, deliver: [] },
        ];
        const client = new ChatBridgeClient({
            syncUrl: 'https://h/editor-bridge/v1/sync', token: 'c'.repeat(64), ownerId: 'ext.three', log: () => {},
            execute: async (request) => {
                if (request.op === 'submit') { submits += 1; throw new Error('Canceled: window closing'); }
                if (request.op === 'sessions') return { ok: true, sessions: [] };
                return { ok: true, protocol: 1, owner: { id: 'ext.three', epoch: 3 } };
            },
            fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return Response.json(replies.shift() ?? replies.at(-1)); },
        });
        await client.tick();
        await client.tick();
        await client.tick();
        expect(submits).toBe(1);
        expect(bodies[2]!.reports).toEqual([{ operationId: OP, attemptId: ATTEMPT, status: 'uncertain', reason: 'bridge_call_failed' }]);
        // Each sync carries the next seq for this owner.
        expect(bodies.map((b) => b.seq)).toEqual([1, 2, 3]);
    });

    test('the submit carries the delivery deadline as time left, and expired / command_in_flight map truthfully', async () => {
        const submitted: Record<string, unknown>[] = [];
        const bodies: Record<string, unknown>[] = [];
        const replies = [
            { ok: true, owner: 'self', epoch: 1, pollMs: 2000, deliver: [] },
            { ok: true, owner: 'self', epoch: 1, pollMs: 2000, deliver: [{ operationId: OP, attemptId: ATTEMPT, deliverWithinMs: 5000, kind: 'send', sessionResource: 'r', text: 'x' }] },
            { ok: true, owner: 'self', epoch: 1, pollMs: 2000, deliver: [] },
        ];
        const client = new ChatBridgeClient({
            syncUrl: 'https://h/editor-bridge/v1/sync', token: 'd'.repeat(64), ownerId: 'ext.four', log: () => {},
            execute: async (request) => {
                if (request.op === 'submit') { submitted.push(request); return { ok: true, status: 'expired' }; }
                if (request.op === 'sessions') return { ok: true, sessions: [] };
                return { ok: true, protocol: 1 };
            },
            fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return Response.json(replies.shift() ?? replies.at(-1)); },
        });
        await client.tick(); await client.tick(); await client.tick();
        expect(submitted[0]!.deliverWithinMs).toBeGreaterThan(4000);
        expect(submitted[0]!.deliverWithinMs).toBeLessThanOrEqual(5000);
        expect(bodies[2]!.reports).toEqual([{ operationId: OP, attemptId: ATTEMPT, status: 'expired', reason: 'deadline_passed' }]);
        expect(submitReport(OP, { ok: false, error: 'command_in_flight' }).status).toBe('uncertain');
    });

    test('a send waits for the chat agent: not ready means not sent (not_delivered, agent_not_ready)', async () => {
        const bodies: Record<string, unknown>[] = [];
        let submits = 0;
        const replies = [
            { ok: true, owner: 'self', epoch: 1, pollMs: 2000, deliver: [] },
            { ok: true, owner: 'self', epoch: 1, pollMs: 2000, deliver: [{ operationId: OP, attemptId: ATTEMPT, deliverWithinMs: 60000, kind: 'send', sessionResource: 'r', text: 'x' }] },
            { ok: true, owner: 'self', epoch: 1, pollMs: 2000, deliver: [] },
        ];
        const client = new ChatBridgeClient({
            syncUrl: 'https://h/editor-bridge/v1/sync', token: 'e'.repeat(64), ownerId: 'ext.five', log: () => {},
            ensureAgent: async () => false,
            execute: async (request) => { if (request.op === 'submit') submits += 1; return request.op === 'sessions' ? { ok: true, sessions: [] } : { ok: true, protocol: 1 }; },
            fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return Response.json(replies.shift() ?? replies.at(-1)); },
        });
        await client.tick(); await client.tick(); await client.tick();
        expect(submits).toBe(0);
        expect(bodies[2]!.reports).toEqual([{ operationId: OP, attemptId: ATTEMPT, status: 'not_delivered', reason: 'agent_not_ready' }]);
    });
});

// ── Protocol 2 ──────────────────────────────────────────────────────────────────────────────────────────────────
const S1 = 'vscode-chat-session://local/s1';
const NEW = 'vscode-chat-session://local/new1';
const PICKER = [{ id: 'ezil/claude', label: 'Claude', vendor: 'ezil', modelId: 'claude', configurable: false },
    { id: 'ezil/qwen', label: 'Qwen', vendor: 'ezil', modelId: 'qwen', configurable: false }];

/** A workbench speaking protocol 2 behind a scripted OS; records every body and workbench call. */
function harness(replies: Record<string, unknown>[], answer: (request: Record<string, unknown>) => unknown = () => undefined,
    availableIds?: (ids: string[]) => Promise<Set<string>>) {
    const bodies: Record<string, unknown>[] = [];
    const calls: Record<string, unknown>[] = [];
    const client = new ChatBridgeClient({
        syncUrl: 'https://h/editor-bridge/v1/sync', token: 'f'.repeat(64), ownerId: 'ext.p2', log: () => {},
        effortOf: (id) => (id === 'claude' ? 'high' : null), availableIds,
        execute: async (request) => {
            calls.push(request);
            const scripted = answer(request);
            if (scripted !== undefined) return scripted;
            if (request.op === 'sessions') return { ok: true, sessions: [{ resource: S1, title: 't', open: true, status: 'idle', model: 'ezil/qwen', requests: 2 }] };
            if (request.op === 'models') return { ok: true, status: 'ok', models: PICKER, observedAt: 1 };
            return { ok: true, protocol: 2, owner: { id: 'ext.p2', epoch: 1 } };
        },
        fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return Response.json(replies.shift() ?? replies.at(-1)); },
    });
    return { client, bodies, calls };
}
const self = (protocol: number, deliver: unknown[] = []) => ({ ok: true, protocol, owner: 'self', epoch: 1, pollMs: 2000, deliver });

describe('protocol 2 is used only when OS and the workbench both speak it', () => {
    test('OS on protocol 1: bodies stay exactly protocol 1 (four session fields, no catalog), whatever the workbench speaks', async () => {
        const { client, bodies, calls } = harness([self(1), self(1), self(1)]);
        await client.tick(); await client.tick(); await client.tick();
        expect(bodies.map((b) => b.protocol)).toEqual([1, 1, 1]);
        expect(bodies[1]!.sessions).toEqual([{ resource: S1, title: 't', open: true, status: 'idle' }]);
        expect(bodies.some((b) => 'catalog' in b)).toBe(false);
        expect(calls.some((c) => c.op === 'models')).toBe(false);
    });

    test('a create or configure handed out under protocol 1 is refused without touching the workbench', async () => {
        const { client, bodies, calls } = harness([self(1), self(1, [{ operationId: OP, attemptId: ATTEMPT, deliverWithinMs: 60000, kind: 'create', sessionResource: '' }]), self(1)]);
        await client.tick(); await client.tick(); await client.tick();
        expect(calls.some((c) => c.op === 'create')).toBe(false);
        expect(bodies[2]!.reports).toEqual([{ operationId: OP, attemptId: ATTEMPT, status: 'rejected', reason: 'unsupported_kind' }]);
    });

    test('OS on protocol 2: sessions carry their selected model; the catalog is the picker with read-only effort', async () => {
        const { client, bodies } = harness([self(2), self(2), self(2)]);
        await client.tick(); await client.tick();
        expect(bodies.map((b) => b.protocol)).toEqual([1, 2]);
        expect(bodies[1]!.sessions).toEqual([{ resource: S1, title: 't', open: true, status: 'idle', model: 'ezil/qwen', requests: 2 }]);
        const catalog = bodies[1]!.catalog as Record<string, unknown>;
        expect(catalog.status).toBe('available');
        expect(catalog.models).toEqual([
            { id: 'ezil/claude', label: 'Claude', engine: 'ezil-chat', efforts: [], defaultEffort: null, configuredEffort: 'high' },
            { id: 'ezil/qwen', label: 'Qwen', engine: 'ezil-chat', efforts: [], defaultEffort: null, configuredEffort: null },
        ]);
    });

    test('no chat widget: the catalog is unavailable with a reason, never an empty list', async () => {
        const { client, bodies } = harness([self(2), self(2)], (r) => (r.op === 'models' ? { ok: true, status: 'unavailable', reason: 'no_chat_widget' } : undefined));
        await client.tick(); await client.tick();
        const catalog = bodies[1]!.catalog as Record<string, unknown>;
        expect([catalog.status, catalog.reason, 'models' in catalog]).toEqual(['unavailable', 'no_chat_widget', false]);
    });

    test('create and configure: one workbench call each, reported with the runtime readback; effort is refused before any call', async () => {
        const deliver = [
            { operationId: OP, attemptId: ATTEMPT, deliverWithinMs: 60000, kind: 'create', model: 'ezil/claude' },
            { operationId: '00000000-0000-4000-8000-000000000002', attemptId: 'a2', deliverWithinMs: 60000, kind: 'configure', sessionResource: S1, model: 'ezil/claude' },
            { operationId: '00000000-0000-4000-8000-000000000003', attemptId: 'a3', deliverWithinMs: 60000, kind: 'create', model: 'ezil/claude', effort: 'high' },
            { operationId: '00000000-0000-4000-8000-000000000004', attemptId: 'a4', deliverWithinMs: 60000, kind: 'configure', sessionResource: S1, effort: 'low' },
        ];
        const { client, bodies, calls } = harness([self(2), self(2, deliver), self(2)], (r) => {
            if (r.op === 'create') return { ok: true, status: 'created', commandId: r.commandId, kind: 'create', sessionResource: NEW, model: 'ezil/claude', requestCount: 0, reason: null, observedAt: 7 };
            if (r.op === 'setModel') return { ok: true, status: 'busy' };
            return undefined;
        });
        await client.tick(); await client.tick(); await client.tick();
        expect(calls.filter((c) => c.op === 'create' || c.op === 'setModel').map((c) => [c.op, c.commandId, c.model])).toEqual([
            ['create', OP, 'ezil/claude'], ['setModel', '00000000-0000-4000-8000-000000000002', 'ezil/claude']]);
        expect(bodies[2]!.reports).toEqual([
            { operationId: OP, attemptId: ATTEMPT, status: 'applied', sessionResource: NEW, model: 'ezil/claude', requestCount: 0, observedAt: 7 },
            { operationId: '00000000-0000-4000-8000-000000000002', attemptId: 'a2', status: 'not_delivered', reason: 'busy' },
            { operationId: '00000000-0000-4000-8000-000000000003', attemptId: 'a3', status: 'rejected', reason: 'effort_not_per_session' },
            { operationId: '00000000-0000-4000-8000-000000000004', attemptId: 'a4', status: 'rejected', reason: 'effort_not_per_session' },
        ]);
    });

    test('controlReport: only a runtime readback is applied; unknown outcomes are uncertain, never not_delivered', () => {
        expect(controlReport(OP, { ok: true, status: 'created', sessionResource: NEW, model: 'ezil/qwen', observedAt: 1, reason: 'model_not_applied' }))
            .toEqual({ operationId: OP, status: 'applied', sessionResource: NEW, model: 'ezil/qwen', observedAt: 1, reason: 'model_not_applied' });
        expect(controlReport(OP, { ok: true, status: 'applied', model: 'ezil/qwen', observedAt: 1 }).status).toBe('uncertain');
        for (const view of [undefined, {}, { ok: true, status: 'uncertain', reason: 'create_outcome_unknown' }, { ok: false, error: 'command_in_flight' }]) {
            expect(controlReport(OP, view).status).toBe('uncertain');
        }
        expect(controlReport(OP, { ok: true, status: 'failed', reason: 'not_opened' })).toEqual({ operationId: OP, status: 'failed', reason: 'not_opened' });
        expect(controlReport(OP, { ok: true, status: 'rejected', reason: 'model_not_offered' }).reason).toBe('model_not_offered');
        expect(controlReport(OP, { ok: true, status: 'not_open' }).status).toBe('not_delivered');
        expect(controlReport(OP, { ok: false, error: 'stale_owner' }).status).toBe('not_delivered');
    });
});

test('reveal reaches the workbench only under protocol 2', async () => {
    const send = { operationId: OP, attemptId: ATTEMPT, deliverWithinMs: 60000, kind: 'send', sessionResource: S1, text: 'x', reveal: true };
    for (const protocol of [1, 2]) {
        const { client, calls } = harness([self(protocol), self(protocol), self(protocol, [send]), self(protocol)], (r) => (r.op === 'submit' ? { ok: true, status: 'busy' } : undefined));
        await client.tick(); await client.tick(); await client.tick();
        expect([protocol, calls.find((c) => c.op === 'submit')?.reveal]).toEqual([protocol, protocol === 2 ? true : undefined]);
    }
});

describe('catalog availability: only the Gateway evidence the extension read for this account', () => {
    const rowsOf = (bodies: Record<string, unknown>[]) => ((bodies[1]!.catalog as Record<string, unknown>).models as Record<string, unknown>[]);
    test('a row is marked available only when availableIds names its own model id; others are listed unmarked', async () => {
        const asked: string[][] = [];
        const { client, bodies } = harness([self(2), self(2)], undefined, async (ids) => { asked.push(ids); return new Set(['qwen']); });
        await client.tick(); await client.tick();
        expect(asked).toEqual([['claude', 'qwen']]);
        expect(rowsOf(bodies).map((m) => [m.id, m.availability ?? null])).toEqual([['ezil/claude', null], ['ezil/qwen', 'available']]);
    });

    test('another vendor\'s row is never asked about or marked, and a failing lookup marks nothing', async () => {
        const picker = [...PICKER, { id: 'copilot/gpt', label: 'GPT', vendor: 'copilot', modelId: 'qwen', configurable: true }];
        const asked: string[][] = [];
        const other = harness([self(2), self(2)], (r) => (r.op === 'models' ? { ok: true, status: 'ok', models: picker, observedAt: 1 } : undefined),
            async (ids) => { asked.push(ids); return new Set(ids); });
        await other.client.tick(); await other.client.tick();
        expect(asked).toEqual([['claude', 'qwen']]);
        expect(rowsOf(other.bodies).map((m) => [m.id, m.availability ?? null])).toEqual([['ezil/claude', 'available'], ['ezil/qwen', 'available'], ['copilot/gpt', null]]);
        const failing = harness([self(2), self(2)], undefined, async () => { throw new Error('gateway down'); });
        await failing.client.tick(); await failing.client.tick();
        expect(rowsOf(failing.bodies).every((m) => !('availability' in m))).toBe(true);
    });

    test('protocol 1: no catalog, so the Gateway is never asked', async () => {
        let asked = 0;
        const { client, bodies } = harness([self(1), self(1), self(1)], undefined, async () => { asked += 1; return new Set(['qwen']); });
        await client.tick(); await client.tick(); await client.tick();
        expect([asked, bodies.some((b) => 'catalog' in b)]).toEqual([0, false]);
    });
});
