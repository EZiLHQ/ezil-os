/**
 * Seam harness, lane A ↔ lane W (REVERSE-MOVE-CONTRACT §4.1-§4.5, r7 integration). The app's REAL reverse runtime
 * (`createReverseRuntime(...).worker`, which builds every import body from the row) and its REAL Worker client
 * (`migrateImport*`: path, method, JSON body, 409 reason enum, response validation) talk to the Worker's REAL import
 * module (`parseImportRequest` + `runReverseImport`, worker/src/workspace-migration-import.ts) over a fetch that does
 * what the Worker's route does (worker/src/index.ts: the same path regex, read from the source; JSON body; the answer
 * as JSON with its status). Only the Durable Object's storage, R2 and the export host are in-memory fakes, wired as
 * `Sandbox.reverseImport` wires them. A move goes begin → pull (status) → pull (chunks) → verify → commit → abort, and
 * every Worker answer is classified by the app's real §5.5 table.
 *
 * The worker module is loaded by a computed specifier, so the app's tsc never type-checks worker sources; its one
 * npm import (aws4fetch, through workspace-store-s3.ts) is mocked, so the app job needs no worker install.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('aws4fetch', () => ({ AwsClient: class {} }));

import { deriveGuacamoleSandboxId } from '../cloudflare-guacamole-provider';
import { classifyWorkerFailure, exportHeadFor } from './provider-reverse';
import { createReverseRuntime } from './provider-reverse-runtime';
import type { ComputeReverseMove } from './provider-reverse-store';
import type { PlacementDb } from './placement';

const WORKER_SRC = path.resolve(__dirname, '../../../../../worker/src');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the worker module is untyped on purpose (see header)
type Loose = any;
const loadWorker = (file: string): Promise<Loose> => import(/* @vite-ignore */ pathToFileURL(path.join(WORKER_SRC, file)).href);

const MIB = 1024 * 1024;
const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const NAME = deriveGuacamoleSandboxId(USER, COMPUTER);
const P = `${COMPUTER}/branches/main`;
const hex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** The Worker route's own path regex, read from index.ts so a drift on either side fails here. */
function workerImportRoute(): RegExp {
    const index = readFileSync(path.join(WORKER_SRC, 'index.ts'), 'utf8');
    const literal = /const importMatch = path\.match\((\/\^.*?\$\/)\);/.exec(index)?.[1];
    if (!literal) throw new Error('the Worker import route regex is not where this harness reads it');
    return new RegExp(literal.slice(1, -1).replace(/\\\//g, '/'));
}

function r2() {
    const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
    let n = 0;
    const bucket = {
        get: async (key: string) => {
            const o = objects.get(key);
            return o ? { etag: o.etag, size: o.bytes.length, arrayBuffer: async () => o.bytes.slice().buffer } : null;
        },
        put: async (key: string, value: Uint8Array | string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
            if (opts?.onlyIf?.etagMatches !== undefined && objects.get(key)?.etag !== opts.onlyIf.etagMatches) return null;
            if (opts?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
            const etag = `e${++n}`;
            objects.set(key, { bytes: typeof value === 'string' ? new TextEncoder().encode(value) : value.slice(), etag });
            return { key, etag };
        },
        list: async ({ prefix }: { prefix: string }) => ({ truncated: false,
            objects: [...objects.keys()].filter(k => k.startsWith(prefix)).sort().map(key => ({ key, size: objects.get(key)!.bytes.length, etag: objects.get(key)!.etag })) }),
        delete: async (keys: string | string[]) => { for (const k of typeof keys === 'string' ? [keys] : keys) objects.delete(k); },
    };
    return { objects, bucket };
}

function doStorage() {
    const map = new Map<string, unknown>();
    return { map, api: {
        get: async (k: string) => structuredClone(map.get(k)),
        put: async (k: string, v: unknown) => { map.set(k, structuredClone(v)); },
        delete: async (keys: string | string[]) => { let d = 0; for (const k of typeof keys === 'string' ? [keys] : keys) if (map.delete(k)) d++; return typeof keys === 'string' ? d > 0 : d; },
        list: async ({ prefix }: { prefix: string }) => new Map([...map].filter(([k]) => k.startsWith(prefix)).sort()),
    } };
}

describe('seam A ↔ W: the app\'s import client and runtime against the Worker\'s import routes (§4.1-§4.5)', () => {
    let W: Loose, origin: Loose;
    beforeAll(async () => {
        W = await loadWorker('workspace-migration-import.ts');
        origin = await loadWorker('aws-origin.ts');
    });
    beforeEach(() => {
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.example');
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'seam-test-secret');
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

    function world() {
        const route = workerImportRoute();
        const store = doStorage(), bucket = r2();
        const placementGeneration = 9, leaseEpoch = 4;
        const controlKey = Buffer.alloc(32, 5).toString('base64');
        const record = { computerId: COMPUTER, sandboxId: NAME, generation: placementGeneration, leaseEpoch, controlKey, instanceId: 'i-0abc',
            region: 'test-region-1', publicIp: '192.0.2.1', tunnelId: 't', dnsRecordId: 'd', hostname: 'h', createdAt: 0, originVerified: false };
        const chunks = [MIB, MIB, 1000].map((size, i) => new Uint8Array(size).fill(i + 7));
        const head = { sha256: hex(Buffer.concat(chunks)), entries: 5, skipped: 1, bytes: chunks.reduce((s, c) => s + c.length, 0),
            chunks: chunks.map((c, i) => ({ i, size: c.length, sha256: hex(c) })) };
        const host = { state: 'none' as string, job: null as null | { moveId: string; generation: string }, posts: [] as string[], unsigned: 0 };
        const status = () => ({ ok: true, state: host.state, moveId: host.job?.moveId ?? null, generation: host.job?.generation ?? null,
            startedAt: host.job ? new Date().toISOString() : null, finishedAt: null, lastServedAt: null, error: null,
            ...(host.state === 'ready' ? { entries: head.entries, bytes: head.bytes, skipped: head.skipped } : {}) });
        const hostFetch = async (input: string, init: RequestInit = {}) => {
            const url = new URL(input), method = init.method ?? 'GET';
            const verdict = await origin.verifyGatewayHeader(new Headers(init.headers).get('x-ezil-gw'), new Uint8Array(Buffer.from(controlKey, 'base64')),
                { computerId: COMPUTER, generation: placementGeneration, leaseEpoch }, method, url.pathname, Math.floor(Date.now() / 1000));
            if (!verdict.ok) { host.unsigned++; return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 }); }
            const p = url.pathname.slice(origin.EXPORT_CONTROL_PATH.length);
            if (method === 'POST') {
                const body = String(init.body);
                host.posts.push(body);
                const b = JSON.parse(body);
                if (!host.job) { host.job = { moveId: b.moveId, generation: b.generation }; host.state = 'capturing'; }
                return Response.json(status(), { status: 202 });
            }
            if (p === '/status') return Response.json(status());
            if (p === '/head') return Response.json({ v: 1, moveId: host.job!.moveId, generation: host.job!.generation, ...head });
            const i = Number(/^\/chunk\/(\d+)$/.exec(p)?.[1]);
            return new Response(chunks[i], { headers: { 'content-type': 'application/octet-stream', 'content-length': String(chunks[i]!.length) } });
        };
        const adopted: string[] = [];
        const calls: Array<{ op: string; body: Record<string, unknown>; auth: string | null; status: number }> = [];
        // What worker/src/index.ts does for POST /sandbox/<name>/migrate/import/<op>, then Sandbox.reverseImport's deps.
        vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://worker.example');
            const m = url.pathname.match(route);
            if (!m || init.method !== 'POST') return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
            const name = decodeURIComponent(m[1]!);
            const body = JSON.parse(String(init.body));
            const parsed = W.parseImportRequest(m[2], body, name);
            if (!parsed) return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 });
            const answer = await W.runReverseImport(parsed, {
                sandboxName: name, storage: store.api, selectStore: async () => ({ kind: 'r2', bucket: bucket.bucket }),
                prefixOverride: undefined, flushContext: async () => undefined, containerRunning: () => false,
                withStartQueue: (op: () => Promise<unknown>) => op(), adoptImportedWorkspace: async (prefix: string) => { adopted.push(prefix); },
                host: { zone: 'ezil.work', lookup: async () => record, fetch: hostFetch }, now: Date.now,
            }, Date.now());
            calls.push({ op: m[2]!, body, auth: new Headers(init.headers).get('authorization'), status: answer.status });
            return Response.json(answer.body, { status: answer.status });
        });
        const move: ComputeReverseMove = {
            id: randomUUID(), userId: USER, computerId: COMPUTER, startedBy: 'user', state: 'exporting', generation: randomUUID(),
            exportBoot: { placementGeneration, leaseEpoch, region: 'test-region-1', volumeId: 'vol-0123456789abcdef0', jobId: null,
                instanceId: 'i-0abc', fsUuid: null, claimedAt: new Date().toISOString() },
            exportHead: null, importProgress: null, bytesTotal: null, skipped: null, awsVolumeId: null, awsFsUuid: null, awsSnapshotId: null,
            retainUntil: null, attempts: 0, lastError: null, stateEnteredAt: 'x', commitSentAt: null, createdAt: 'x', updatedAt: 'x',
            ages: { created: 0, stateEntered: 0, commitSent: null, lastChunk: null },
        };
        const worker = createReverseRuntime({} as PlacementDb).worker;
        return { worker, move, host, head, bucket, store, adopted, calls, ready: () => { host.state = 'ready'; } };
    }

    it('a whole move: every app body parses on the Worker, every Worker answer validates in the app, the head round-trips', async () => {
        const w = world();
        const begin = await w.worker.begin(w.move);
        expect(begin).toEqual({ ok: true, data: { ok: true, headKind: 'none', export: expect.objectContaining({ state: 'capturing' }) } });
        expect(w.host.posts).toEqual([JSON.stringify({ v: 1, moveId: w.move.id, generation: w.move.generation })]);
        expect(await w.worker.pull(w.move, 0, 0)).toEqual({ ok: true, data: { ok: true, export: expect.objectContaining({ state: 'capturing' }),
            head: null, stored: [], next: 0 } });
        w.ready();
        const status = await w.worker.pull(w.move, 0, 0);
        expect(status.ok && status.data.export.state).toBe('ready');
        // §2.3 the head the Worker forwards is the one the app's own validator accepts for this row.
        const head = exportHeadFor(w.move, status.ok ? status.data.head : null);
        expect(head).toEqual({ generation: w.move.generation, ...w.head });
        const m = { ...w.move, state: 'copying' as const, exportHead: head };
        expect(await w.worker.pull(m, 0, 64)).toEqual({ ok: true, data: { ok: true, export: expect.objectContaining({ state: 'ready' }),
            head: expect.anything(), stored: [0, 1, 2], next: null } });
        expect(await w.worker.verify({ ...m, state: 'checking' })).toEqual({ ok: true, data: { ok: true, verified: true } });
        expect(await w.worker.commit({ ...m, state: 'flipping' })).toEqual({ ok: true, data: { ok: true, committed: true, store: 'r2' } });
        expect(w.adopted).toEqual([P]);
        expect(JSON.parse(new TextDecoder().decode(w.bucket.objects.get(`${P}/.ezil-snapshots/latest.json`)!.bytes)))
            .toMatchObject({ version: 1, generation: m.generation, chunkGeneration: m.generation, sha256: w.head.sha256 });
        // A retried commit after success is the same 200 (§4.4), and abort is then already_imported → operator (§5.5).
        expect(await w.worker.commit({ ...m, state: 'flipping' })).toEqual({ ok: true, data: { ok: true, committed: true, store: 'r2' } });
        const abort = await w.worker.abort(m);
        expect(abort).toEqual({ ok: false, error: 'conflict', reason: 'already_imported' });
        expect(classifyWorkerFailure('abort', abort as never)).toEqual({ kind: 'fail', failure: 'operator', code: 'already_imported' });
        // Every call went to the Worker route signed, with the four ops' bodies the Worker accepted.
        expect(w.calls.map(c => [c.op, c.status])).toEqual([['begin', 200], ['pull', 200], ['pull', 200], ['pull', 200], ['commit', 200],
            ['commit', 200], ['commit', 200], ['abort', 409]]);
        expect(w.calls.every(c => c.auth?.startsWith('Bearer '))).toBe(true);
        expect(w.host.unsigned).toBe(0);
    });

    it('the bodies carry exactly the contract\'s keys; the Worker refuses a body the app would never send (invalid_body)', async () => {
        const w = world();
        await w.worker.begin(w.move);
        await w.worker.abort(w.move);
        const keys = Object.fromEntries(w.calls.map(c => [c.op, Object.keys(c.body).sort()]));
        expect(keys).toEqual({
            begin: ['computerId', 'generation', 'leaseEpoch', 'moveId', 'placementGeneration'],
            abort: ['computerId', 'generation', 'moveId'],
        });
        // Control: the Worker's parser really checks — another computer's id under this name is refused.
        expect(W.parseImportRequest('begin', { ...w.calls[0]!.body, computerId: randomUUID() }, NAME)).toBeNull();
    });

    it('Worker refusals reach the app as its closed reasons and its §5.5 classes', async () => {
        const w = world();
        expect(await w.worker.begin(w.move)).toMatchObject({ ok: true });
        // Another move on the same computer while this key is held (§4.2 step 3): import_busy, reopen_final.
        const other = { ...w.move, id: randomUUID(), generation: randomUUID() };
        const busy = await w.worker.begin(other);
        expect(busy).toEqual({ ok: false, error: 'conflict', reason: 'import_busy' });
        expect(classifyWorkerFailure('begin', busy as never)).toEqual({ kind: 'fail', failure: 'reopen_final', code: 'import_busy' });
        // A pull for a move the Worker never began (§4.3 step 1): import_mismatch (the key is another move's).
        const pull = await w.worker.pull(other, 0, 0);
        expect(pull).toEqual({ ok: false, error: 'conflict', reason: 'import_mismatch' });
        expect(classifyWorkerFailure('pull', pull as never)).toEqual({ kind: 'fail', failure: 'reopen_final', code: 'import_mismatch' });
        // A verify before every chunk landed (§4.4): not_verified → reopen import_corrupt.
        const verify = await w.worker.verify({ ...w.move, exportHead: { generation: w.move.generation, ...w.head } });
        expect(verify).toEqual({ ok: false, error: 'conflict', reason: 'not_verified' });
        expect(classifyWorkerFailure('verify', verify as never)).toEqual({ kind: 'fail', failure: 'reopen', code: 'import_corrupt' });
    });
});
