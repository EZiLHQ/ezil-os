import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, RpcStub: class {}, env: {} }));
import { hmacSha256Hex, PREVIEW_TOKEN_PAYLOAD } from './hmac';
import { EXPORT_CONTROL_PATH, readAwsExport, verifyGatewayHeader, type AwsTunnelRecord } from './aws-origin';
import { REGISTRY_PATHS } from './aws-tunnels';
import { MIGRATING_FLAG, SNAPSHOT_HEAD, chunkKey } from './workspace-persist';
import {
  EXPORT_CHUNK_TIMEOUT_MS, EXPORT_READ_TIMEOUT_MS, IMPORT_CONFLICT_CODES, PULL_CHUNK_DEADLINE_MS, PULL_CONCURRENCY,
  PULL_TRANSFER_WINDOW_MS, REVERSE_IMPORT_HEAD_KEY, REVERSE_IMPORT_KEY, REVERSE_IMPORT_PUT_PREFIX, chunkTimeoutMs,
  parseExportHead, parseImportRequest, runReverseImport, type ExportHostAccess, type ReverseImportDeps,
} from './workspace-migration-import';

const SECRET = 'reverse-import-tests-only';
const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const NAME = `guac-${USER.replace(/-/g, '').slice(0, 16)}-${COMPUTER.replace(/-/g, '').slice(0, 16)}`;
const P = `${COMPUTER}/branches/main`, S = `${COMPUTER}/system`;
const HEAD = `${P}/${SNAPSHOT_HEAD}`, SYS = `${S}/${SNAPSHOT_HEAD}`, FLAG = `${P}/${MIGRATING_FLAG}`;
const MOVE = '3a3b3c3d-3333-4333-8333-333333333333';
const GEN = '44444444-4444-4444-8444-444444444444';
const MIB = 1024 * 1024;
const CONTROL_KEY = Buffer.alloc(32, 7).toString('base64');
const PLACEMENT = { placementGeneration: 7, leaseEpoch: 3 };
const ids = { moveId: MOVE, generation: GEN, computerId: COMPUTER };
const beginBody = { ...ids, ...PLACEMENT };
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const token = async () => { const now = Date.now(); return `t=${now},v1=${await hmacSha256Hex(SECRET, PREVIEW_TOKEN_PAYLOAD(now))}`; };
const uuid = () => crypto.randomUUID();

/** A workspace export: 1 MiB chunks and a short last one, with the §2.3 head. */
function exportOf(sizes: number[], moveId = MOVE, generation = GEN) {
  const chunks = sizes.map((size, i) => new Uint8Array(size).fill(i + 1));
  const archive = Buffer.concat(chunks);
  const head = { v: 1, moveId, generation, sha256: hex(archive), entries: 12, skipped: 2, bytes: archive.length,
    chunks: chunks.map((c, i) => ({ i, size: c.length, sha256: hex(c) })) };
  return { chunks, head };
}

function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let revision = 0;
  const writes: string[] = [];
  const faults = { put: (_key: string) => false, get: (_key: string) => false };
  /** Store latency per call, so concurrent operations really interleave at their await points. */
  const timing = { latencyMs: 0 };
  const wait = () => timing.latencyMs ? new Promise(resolve => setTimeout(resolve, timing.latencyMs)) : Promise.resolve();
  const bucket = {
    get: async (key: string) => {
      await wait();
      if (faults.get(key)) throw new Error('r2 get failed');
      const object = objects.get(key);
      return object ? { etag: object.etag, size: object.bytes.length, arrayBuffer: async () => object.bytes.slice().buffer } : null;
    },
    put: async (key: string, value: Uint8Array | string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
      await wait();
      if (faults.put(key)) throw new Error('r2 put failed');
      if (opts?.onlyIf?.etagMatches !== undefined && objects.get(key)?.etag !== opts.onlyIf.etagMatches) return null;
      if (opts?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      const etag = `e${(++revision).toString(16).padStart(8, '0')}`;
      objects.set(key, { bytes: typeof value === 'string' ? new TextEncoder().encode(value) : value.slice(), etag });
      writes.push(key);
      return { key, etag };
    },
    list: async ({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) => {
      await wait();
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + Math.min(limit, 2));
      const truncated = start + page.length < keys.length;
      return { objects: page.map(key => ({ key, size: objects.get(key)!.bytes.length, etag: objects.get(key)!.etag })), truncated,
        ...(truncated ? { cursor: String(start + page.length) } : {}) };
    },
    delete: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
  };
  const json = (key: string) => JSON.parse(new TextDecoder().decode(objects.get(key)!.bytes));
  return { objects, bucket, writes, faults, timing, json, put: (key: string, value: unknown) => bucket.put(key, encode(value)) };
}

function fakeStorage(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial));
  const api = {
    get: async (key: string) => structuredClone(map.get(key)),
    put: async (key: string, value: unknown) => { map.set(key, structuredClone(value)); },
    delete: async (keys: string | string[]) => {
      const list = typeof keys === 'string' ? [keys] : keys;
      if (list.length > 128) throw new Error('DO storage batch over 128 keys');
      let n = 0;
      for (const key of list) if (map.delete(key)) n++;
      return typeof keys === 'string' ? n > 0 : n;
    },
    list: async ({ prefix }: { prefix: string }) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort()),
  };
  return { map, api };
}

/** The host edge (§2.2), held to the gw1 contract: every request verified against the tunnel record. */
function fakeHost(record: AwsTunnelRecord) {
  const key = new Uint8Array(Buffer.from(record.controlKey, 'base64'));
  const host = {
    state: 'none' as 'none' | 'capturing' | 'ready' | 'failed',
    error: null as string | null,
    job: null as { moveId: string; generation: string } | null,
    export: exportOf([MIB, MIB, 1000]),
    /** What a POST makes the job: the host's async worker is modelled by the test moving `state`. */
    onPost: 'capturing' as 'capturing' | 'ready',
    requests: [] as Array<{ method: string; path: string }>,
    posts: [] as string[],
    answer: null as ((method: string, path: string) => Response | null) | null,
    chunkOverride: null as ((index: number) => Response | null) | null,
    inFlight: 0,
    maxInFlight: 0,
    chunkDelay: 0,
    /** The edge's clock for the gw1 skew check (a unit test's fake clock signs with its own). */
    clock: () => Date.now(),
  };
  const status = () => ({ ok: true, state: host.state, moveId: host.job?.moveId ?? null, generation: host.job?.generation ?? null,
    startedAt: host.job ? new Date().toISOString() : null, finishedAt: null, lastServedAt: null, error: host.error,
    ...(host.state === 'ready' ? { entries: host.export.head.entries, bytes: host.export.head.bytes, skipped: host.export.head.skipped } : {}) });
  const fetchFn = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    expect(url.hostname).toBe(`c-${record.sandboxId}-g${record.generation}-e${record.leaseEpoch}.ezil.work`);
    expect(url.search).toBe('');
    const verdict = await verifyGatewayHeader(headers.get('x-ezil-gw'), key,
      { computerId: record.computerId, generation: record.generation, leaseEpoch: record.leaseEpoch }, method, url.pathname, Math.floor(host.clock() / 1000));
    if (!verdict.ok) return Response.json({ ok: false, error: verdict.error }, { status: 401 });
    host.requests.push({ method, path: url.pathname });
    const override = host.answer?.(method, url.pathname);
    if (override) return override;
    const path = url.pathname.slice(EXPORT_CONTROL_PATH.length);
    if (method === 'POST') {
      const body = String(init.body);
      // The digest binds the exact bytes: no re-serialization, no canonical-JSON rule.
      expect(`/${hex(new TextEncoder().encode(body))}`).toBe(path);
      host.posts.push(body);
      const parsed = JSON.parse(body) as { v: number; moveId: string; generation: string };
      if (host.job && (host.job.moveId !== parsed.moveId || host.job.generation !== parsed.generation)) {
        return Response.json({ ok: false, error: 'export_busy' }, { status: 409 });
      }
      if (!host.job) { host.job = { moveId: parsed.moveId, generation: parsed.generation }; host.state = host.onPost; }
      return Response.json(status(), { status: 202 });
    }
    if (path === '/status') return Response.json(status());
    if (path === '/head') return host.state === 'ready' ? Response.json(host.export.head) : Response.json({ ok: false, error: 'export_not_ready' }, { status: 409 });
    const index = Number(/^\/chunk\/(\d+)$/.exec(path)?.[1]);
    const custom = host.chunkOverride?.(index);
    if (custom) return custom;
    const chunk = host.export.chunks[index];
    if (!chunk) return Response.json({ ok: false, error: 'export_chunk_missing' }, { status: 404 });
    host.inFlight++;
    host.maxInFlight = Math.max(host.maxInFlight, host.inFlight);
    if (host.chunkDelay) await new Promise(resolve => setTimeout(resolve, host.chunkDelay));
    host.inFlight--;
    return new Response(chunk, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(chunk.length) } });
  };
  return { host, fetchFn };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface FixtureOptions {
  /** The pre-move Cloudflare state at P and S: a forward-migrated computer, or one created on AWS. */
  shape?: 'migrated' | 'none';
  storage?: Record<string, unknown>;
  env?: Record<string, unknown>;
  record?: Partial<AwsTunnelRecord> | null;
}

/** The real route table and the real Sandbox DO prototype over fake storage, R2, tunnel registry and host. */
async function fixture(options: FixtureOptions = {}) {
  const mod = await import('./index');
  const r2 = fakeBucket();
  const store = fakeStorage(options.storage ?? {});
  const record: AwsTunnelRecord = { computerId: COMPUTER, sandboxId: NAME, generation: 7, leaseEpoch: 3, instanceId: 'i-0abc',
    region: 'test-region-1', publicIp: '192.0.2.10', tunnelId: 't-1', dnsRecordId: 'd-1', hostname: 'h', controlKey: CONTROL_KEY,
    createdAt: 0, originVerified: false, ...(options.record ?? {}) };
  const { host, fetchFn } = fakeHost(record);
  /** Every outbound request of the Worker, before the fake host checks it (a store or desktop call would land here too). */
  const fetches: Array<{ method: string; url: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetches.push({ method: init?.method ?? 'GET', url: String(input) });
    return fetchFn(String(input), init);
  }) as typeof fetch;
  const registryPaths: string[] = [];
  const registry = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    registryPaths.push(path);
    if (path !== REGISTRY_PATHS.get) return Response.json({ ok: false }, { status: 404 });
    return Response.json({ record: options.record === null ? null : { ...record, sandboxId: name === NAME ? record.sandboxId : name } });
  } }) };
  let previousSystem: Record<string, unknown> | null = null;
  if ((options.shape ?? 'migrated') === 'migrated') {
    // A computer this Worker moved to AWS: migrated v2 markers over its last Cloudflare heads.
    const previous = { version: 1, generation: uuid(), chunkGeneration: uuid(), sha256: 'a'.repeat(64), entries: 3, chunks: [{ size: 10, sha256: 'b'.repeat(64) }] };
    previousSystem = { version: 1, generation: uuid(), chunkGeneration: uuid(), sha256: 'c'.repeat(64), entries: 2,
      chunks: [{ size: 20, sha256: 'd'.repeat(64) }], format: 2, imageId: 'test-image', replay: { apt: ['test-package'], npm: [] } };
    const marker = (snapshot: Record<string, unknown>) => ({ version: 2, kind: 'migrated', targetProvider: 'aws-ec2', migratedAt: '2026-10-22T10:00:00.000Z',
      exported: { generation: snapshot.generation, chunkGeneration: snapshot.chunkGeneration, sha256: snapshot.sha256, entries: snapshot.entries },
      exportedEtag: 'e-old', previous: snapshot });
    await r2.put(HEAD, marker(previous));
    await r2.put(SYS, marker(previousSystem));
    await r2.put(FLAG, { startedAt: '2026-10-22T10:00:00.000Z', headEtag: 'e-old', systemHeadEtag: null });
  }
  const env = { SANDBOX_WORKSPACE_R2_BUCKET: r2.bucket, AWS_ROUTING_ENABLED: 'on', AWS_ORIGIN_ZONE: 'ezil.work',
    AWS_ORIGIN_ZONE_ALLOWLIST: 'ezil.work', AWS_TUNNELS: registry, ...(options.env ?? {}) };
  const execs: string[] = [];
  const fake = Object.assign(Object.create(mod.Sandbox.prototype), {
    ctx: { storage: store.api, container: { running: false } },
    env,
    exec: async (command: string) => { execs.push(command); return { exitCode: 0, stdout: '' }; },
    exists: async () => ({ exists: false }),
    writeFile: async () => ({ success: true }), mkdir: async () => ({ success: true }), listFiles: async () => ({ files: [] }),
    readFile: async () => ({ content: '', encoding: 'utf-8' }), schedule: async () => {}, getSchedules: async () => [],
  });
  const workerEnv = { SANDBOX_HMAC_SECRET: SECRET, Sandbox: { idFromName: (name: string) => name, get: () => fake } };
  const request = async (op: string, body: unknown, opts: { name?: string; signed?: boolean; raw?: string } = {}) =>
    mod.default.fetch(new Request(`https://worker.example/sandbox/${opts.name ?? NAME}/migrate/import/${op}`, {
      method: 'POST', headers: opts.signed === false ? {} : { authorization: `Bearer ${await token()}` },
      body: opts.raw ?? JSON.stringify(body),
    }), workerEnv as never);
  const call = async (op: string, body: unknown, opts?: { name?: string; signed?: boolean; raw?: string }) => {
    const response = await request(op, body, opts);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const begin = () => call('begin', beginBody);
  const pull = (from = 0, count = 64) => call('pull', { ...beginBody, from, count });
  const verify = () => call('commit', { ...ids, sha256: host.export.head.sha256, chunkCount: host.export.head.chunks.length, verifyOnly: true });
  const commit = () => call('commit', { ...ids, sha256: host.export.head.sha256, chunkCount: host.export.head.chunks.length, verifyOnly: false });
  const abort = () => call('abort', ids);
  /** begin → host ready → every chunk pulled. */
  const copied = async () => {
    expect((await begin()).status).toBe(200);
    host.state = 'ready';
    expect((await pull()).body.next).toBeNull();
  };
  return { mod, r2, store, host, fake, env, record, registryPaths, fetches, request, call, begin, pull, verify, commit, abort, copied,
    previousSystem: () => previousSystem, execs };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const importKeys = (map: Map<string, unknown>) => [...map.keys()].filter(key => key.startsWith(REVERSE_IMPORT_KEY));
/** Fake S3 settings: enough for `resolveWorkspaceStore` to build a real S3 (or migrating) store, which v1 must refuse. */
const S3_ENV = { EZIL_WORKSPACE_S3_BUCKET: 'test-bucket', EZIL_WORKSPACE_S3_REGION: 'test-region-1',
  EZIL_WORKSPACE_S3_ACCESS_KEY_ID: 'test-access-key', EZIL_WORKSPACE_S3_SECRET_ACCESS_KEY: 'test-secret-key' };
/** This move's `ezil:reverseImport`, as begin writes it (seeded directly where a test needs no export). */
const ownState = (extra: Record<string, unknown> = {}) => ({ ...ids, ...PLACEMENT, store: 'r2', prefix: P, headKind: 'none',
  migratedEtag: null, systemMigratedEtag: null, startedAt: new Date().toISOString(), ...extra });

/**
 * One write log across R2 and Durable Object storage, in call order: an R2-only log cannot see a
 * DO write that lands ahead of the flag. DO keys outside `ezil:` are the Sandbox SDK's own
 * settings (`sleepAfter`, `sandboxName`, …), which every open of the DO writes before any route
 * runs: they are not the import's writes.
 */
function writeLog(f: Fixture): string[] {
  const log: string[] = [];
  const bucket = f.r2.bucket as Record<string, any>;
  const storage = f.store.api as Record<string, any>;
  for (const [target, name, method] of [[bucket, 'r2', 'put'], [bucket, 'r2-delete', 'delete'], [storage, 'do', 'put'], [storage, 'do-delete', 'delete']] as const) {
    const original = target[method];
    target[method] = (key: string | string[], ...rest: unknown[]) => {
      if (name.startsWith('r2') || String(key).startsWith('ezil:')) log.push(`${name} ${key}`);
      return original(key, ...rest);
    };
  }
  return log;
}

describe('reverse import: routing and request checks (§4.1)', () => {
  it('requires the signed control envelope', async () => {
    const f = await fixture();
    const r = await f.request('begin', beginBody, { signed: false });
    expect(r.status).toBe(401);
    expect(f.r2.writes).toHaveLength(3);
  });

  it('refuses a malformed body with 400 invalid_body before opening the computer', async () => {
    const f = await fixture();
    const bad: Array<[string, unknown]> = [
      ['begin', { ...beginBody, moveId: MOVE.toUpperCase() }],
      ['begin', { ...beginBody, computerId: uuid() }],
      ['begin', { ...beginBody, leaseEpoch: 0 }],
      ['begin', { ...beginBody, placementGeneration: 1.5 }],
      ['pull', { ...beginBody, from: 512, count: 1 }],
      ['pull', { ...beginBody, from: 0, count: 65 }],
      ['pull', { ...beginBody, from: -1, count: 1 }],
      ['commit', { ...ids, sha256: 'A'.repeat(64), chunkCount: 1, verifyOnly: true }],
      ['commit', { ...ids, sha256: 'a'.repeat(64), chunkCount: 0, verifyOnly: true }],
      ['commit', { ...ids, sha256: 'a'.repeat(64), chunkCount: 1 }],
      ['abort', [ids]],
    ];
    for (const [op, body] of bad) expect(await f.call(op, body)).toEqual({ status: 400, body: { ok: false, error: 'invalid_body' } });
    expect(await f.call('abort', null, { raw: '{' })).toEqual({ status: 400, body: { ok: false, error: 'invalid_body' } });
    expect(importKeys(f.store.map)).toEqual([]);
  });

  it('binds the body to the name: the computer id\'s first 16 alphanumerics must be the name\'s scope', () => {
    expect(parseImportRequest('abort', ids, NAME)).toEqual({ op: 'abort', ...ids });
    expect(parseImportRequest('abort', ids, `guac-${'f'.repeat(16)}-${'0'.repeat(16)}`)).toBeNull();
    expect(parseImportRequest('abort', { ...ids, computerId: uuid() }, NAME)).toBeNull();
    expect(parseImportRequest('export', ids, NAME)).toBeNull();
  });

  it('does not answer other import paths or methods', async () => {
    const f = await fixture();
    const mod = f.mod;
    for (const [method, op] of [['GET', 'begin'], ['POST', 'status'], ['POST', 'begin/x']] as const) {
      const r = await mod.default.fetch(new Request(`https://worker.example/sandbox/${NAME}/migrate/import/${op}`, {
        method, headers: { authorization: `Bearer ${await token()}` }, ...(method === 'POST' ? { body: '{}' } : {}),
      }), { SANDBOX_HMAC_SECRET: SECRET, Sandbox: { idFromName: () => NAME, get: () => f.fake } } as never);
      expect(r.status).not.toBe(200);
    }
  });

  it('every code an import answer can carry survives the Worker\'s public error filter', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const list = /const PUBLIC_ERROR_CODES = \[([\s\S]*?)\] as const;/.exec(source)![1]!;
    const codes = new Set([...list.matchAll(/'([^']+)'/g)].map(m => m[1]));
    const emitted = [...IMPORT_CONFLICT_CODES, 'export_unreachable', 'store_unavailable', 'invalid_body', 'migration_failed',
      // The host's own §2.4 vocabulary, echoed in `export.error`.
      'workspace_too_large', 'workspace_missing', 'capture_failed', 'desktop_stop_failed', 'staging_space_low'];
    expect(emitted.filter(code => !codes.has(code))).toEqual([]);
  });
});

describe('reverse import: begin (§4.2)', () => {
  it('a computer created on AWS: no head, the flag and key are written, the host is asked once with the exact signed bytes', async () => {
    const f = await fixture({ shape: 'none' });
    const before = Date.now();
    const r = await f.begin();
    expect(r).toEqual({ status: 200, body: { ok: true, headKind: 'none', export: expect.objectContaining({ ok: true, state: 'capturing', moveId: MOVE, generation: GEN, error: null }) } });
    const flag = f.r2.json(FLAG);
    expect(flag.reverse).toEqual({ moveId: MOVE, generation: GEN });
    expect(Date.parse(flag.startedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(f.store.map.get(REVERSE_IMPORT_KEY)).toEqual({ ...ids, ...PLACEMENT, store: 'r2', prefix: P, headKind: 'none',
      migratedEtag: null, systemMigratedEtag: null, startedAt: expect.any(String) });
    expect(f.host.posts).toEqual([`{"v":1,"moveId":"${MOVE}","generation":"${GEN}"}`]);
    // 🔴 The no-push pin: the only tunnel call is the record lookup.
    expect(new Set(f.registryPaths)).toEqual(new Set([REGISTRY_PATHS.get]));
  });

  it('a forward-migrated computer: records both migrated etags for the commit CAS', async () => {
    const f = await fixture();
    const r = await f.begin();
    expect(r.body.headKind).toBe('migrated');
    const state = f.store.map.get(REVERSE_IMPORT_KEY) as Record<string, unknown>;
    expect(state.migratedEtag).toBe(f.r2.objects.get(HEAD)!.etag);
    expect(state.systemMigratedEtag).toBe(f.r2.objects.get(SYS)!.etag);
  });

  it('is idempotent for the same move: rewrites the flag once and re-asks the host', async () => {
    const f = await fixture();
    await f.begin();
    await f.r2.put(FLAG, { startedAt: '2001-01-01T00:00:00.000Z', reverse: { moveId: MOVE, generation: GEN } });
    const writes = f.r2.writes.length;
    const again = await f.begin();
    expect(again.status).toBe(200);
    expect(f.r2.writes.slice(writes)).toEqual([FLAG]);
    expect(Date.parse(f.r2.json(FLAG).startedAt)).toBeGreaterThan(Date.parse('2026-01-01'));
    expect(f.host.posts).toHaveLength(2);
  });

  it('another move is import_busy; the same move at another binding is export_host_mismatch', async () => {
    const f = await fixture();
    await f.begin();
    const state = f.store.map.get(REVERSE_IMPORT_KEY);
    expect(await f.call('begin', { ...beginBody, moveId: uuid() })).toEqual({ status: 409, body: { ok: false, error: 'import_busy' } });
    // §4.2 step 3 keys on {moveId, generation}; the host is only ever the export boot's (§4.1).
    expect(await f.call('begin', { ...beginBody, leaseEpoch: 4 })).toEqual({ status: 409, body: { ok: false, error: 'export_host_mismatch' } });
    expect(f.host.posts).toHaveLength(1);
    expect(f.store.map.get(REVERSE_IMPORT_KEY)).toEqual(state);
  });

  it('🔴 a begin or pull at another binding never reaches a host, even one whose tunnel record carries that binding', async () => {
    // The export boot was 7/3 and its abort never landed. The hold's next open replaced the host
    // at 9/5 with the user's desktop running: an export POST there would stop it (§2.5 step 3).
    const state = ownState();
    const f = await fixture({ shape: 'none', record: { generation: 9, leaseEpoch: 5 }, storage: { [REVERSE_IMPORT_KEY]: state } });
    const late = { ...beginBody, placementGeneration: 9, leaseEpoch: 5 };
    for (const [op, body] of [['begin', late], ['pull', { ...late, from: 0, count: 64 }], ['pull', { ...late, from: 0, count: 0 }]] as const) {
      expect(await f.call(op, body)).toEqual({ status: 409, body: { ok: false, error: 'export_host_mismatch' } });
    }
    expect(f.fetches).toEqual([]);
    expect(f.host.requests).toEqual([]);
    expect(f.r2.writes).toEqual([]);
    expect(f.store.map.get(REVERSE_IMPORT_KEY)).toEqual(state);
    // Positive control: the export boot's own binding reaches the export boot's host.
    const own = await fixture({ shape: 'none', storage: { [REVERSE_IMPORT_KEY]: ownState() } });
    expect((await own.begin()).status).toBe(200);
    expect(own.host.posts).toHaveLength(1);
  });

  it('begin\'s check and fence run in the start queue: a container start in flight lands first, then container_running', async () => {
    const f = await fixture({ shape: 'none' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // A Cloudflare start already queued in the DO: its container is up once it is released.
    const starting = f.fake.withMigrationStart(async () => { await gate; f.fake.ctx.container.running = true; });
    const begun = f.begin();
    // Long enough for a begin that skipped the queue to publish its fence and ask the host.
    await new Promise(resolve => setTimeout(resolve, 100));
    release();
    await starting;
    expect(await begun).toEqual({ status: 409, body: { ok: false, error: 'container_running' } });
    expect(f.r2.writes).toEqual([]);
    expect(importKeys(f.store.map)).toEqual([]);
    expect(f.host.posts).toEqual([]);
  });

  it('a running Cloudflare container is container_running, before anything is written', async () => {
    const f = await fixture();
    f.fake.ctx.container.running = true;
    const writes = f.r2.writes.length;
    expect(await f.begin()).toEqual({ status: 409, body: { ok: false, error: 'container_running' } });
    expect(f.r2.writes.length).toBe(writes);
    expect(f.host.posts).toEqual([]);
  });

  const headCases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>, string]> = [
    ['an ordinary v1 head (Cloudflare wrote since)', f => f.r2.put(HEAD, { version: 1, generation: uuid(), sha256: 'a'.repeat(64), entries: 1, chunks: [{ size: 1, sha256: 'b'.repeat(64) }] }), 'head_moved'],
    ['this move\'s own committed head', f => f.r2.put(HEAD, { version: 1, generation: GEN, chunkGeneration: GEN, sha256: 'a'.repeat(64), entries: 1, chunks: [{ size: 1, sha256: 'b'.repeat(64) }] }), 'already_imported'],
    ['a marker for another target', async f => { const m = f.r2.json(HEAD); await f.r2.put(HEAD, { ...m, targetProvider: 'cloudflare' }); }, 'head_invalid'],
    ['an unparseable head', f => f.r2.bucket.put(HEAD, new TextEncoder().encode('{not json')), 'head_unreadable'],
    ['an invalid v2 marker', async f => { const m = f.r2.json(HEAD); await f.r2.put(HEAD, { ...m, exported: { ...m.exported, sha256: 'x' } }); }, 'head_unreadable'],
    ['a v1 system head', f => f.r2.put(SYS, { version: 1, generation: uuid(), sha256: 'a'.repeat(64), entries: 1, chunks: [{ size: 1, sha256: 'b'.repeat(64) }] }), 'system_head_moved'],
    // Refused before any write: accepted, the commit would meet it after the head CAS (`flip_stuck`).
    ['an unparseable system head', f => f.r2.bucket.put(SYS, new TextEncoder().encode('{not json')), 'head_unreadable'],
  ];
  for (const [name, arrange, code] of headCases) {
    it(`refuses ${name}: ${code}, with no flag and no key`, async () => {
      const f = await fixture();
      await arrange(f);
      const flagBefore = f.r2.objects.get(FLAG)!.etag;
      expect(await f.begin()).toEqual({ status: 409, body: { ok: false, error: code } });
      expect(f.r2.objects.get(FLAG)!.etag).toBe(flagBefore);
      expect(importKeys(f.store.map)).toEqual([]);
      expect(f.host.posts).toEqual([]);
    });
  }

  it('v1 is R2-only: an S3 store that resolves (env or pin), an unresolvable one, or no R2 store, is store_unsupported', async () => {
    for (const options of [
      // These resolve for real: the migrating store over R2, and a pinned pure S3 store.
      { env: { EZIL_WORKSPACE_STORE: 's3', ...S3_ENV } },
      { env: S3_ENV, storage: { 'ezil:workspaceStoreKind': 's3' } },
      // These do not resolve at all.
      { env: { EZIL_WORKSPACE_STORE: 's3' } },
      { storage: { 'ezil:workspaceStoreKind': 's3' } },
      { env: { SANDBOX_WORKSPACE_R2_BUCKET: undefined } },
    ] as FixtureOptions[]) {
      const f = await fixture({ shape: 'none', ...options });
      expect(await f.begin()).toEqual({ status: 409, body: { ok: false, error: 'store_unsupported' } });
      expect(importKeys(f.store.map)).toEqual([]);
      expect(f.r2.writes).toEqual([]);
      // Neither the S3 store nor the host was ever called.
      expect(f.fetches).toEqual([]);
    }
  });

  it('a resolved non-R2 store is never used by any op: store_unsupported with no store call', async () => {
    const calls: string[] = [];
    const recording = { get: async () => { calls.push('get'); return null; }, put: async () => { calls.push('put'); return { etag: 'x' }; },
      list: async () => { calls.push('list'); return { objects: [], truncated: false }; }, delete: async () => { calls.push('delete'); } };
    const store = fakeStorage({ [REVERSE_IMPORT_KEY]: ownState({ verified: { sha256: 'a'.repeat(64), chunkCount: 1 } }) });
    const deps: ReverseImportDeps = {
      sandboxName: NAME, storage: store.api as never, selectStore: async () => ({ kind: 's3', bucket: recording }),
      prefixOverride: undefined, flushContext: async () => undefined, containerRunning: () => false, withStartQueue: op => op(),
      adoptImportedWorkspace: async () => { calls.push('adopt'); }, host: null, now: Date.now,
    };
    const commitBody = { ...ids, sha256: 'a'.repeat(64), chunkCount: 1 };
    for (const [op, body] of [['begin', beginBody], ['pull', { ...beginBody, from: 0, count: 1 }], ['commit', { ...commitBody, verifyOnly: true }],
      ['commit', { ...commitBody, verifyOnly: false }], ['abort', ids]] as const) {
      expect(await runReverseImport(parseImportRequest(op, body, NAME)!, deps)).toEqual({ status: 409, body: { ok: false, error: 'store_unsupported' } });
    }
    expect(calls).toEqual([]);
    expect(store.map.has(REVERSE_IMPORT_KEY)).toBe(true);
  });

  it('never imports under a deployment-wide prefix, even one equal to P', async () => {
    for (const value of ['/fixed', '', `/${P}`]) {
      const f = await fixture({ env: { SANDBOX_WORKSPACE_S3_PREFIX: value } });
      const writes = f.r2.writes.length;
      for (const op of [f.begin, f.pull, f.verify, f.commit]) {
        expect(await op()).toEqual({ status: 409, body: { ok: false, error: 'prefix_mismatch' } });
      }
      // No key of this move: nothing was written, so the abort is idempotent (§4.5).
      expect(await f.abort()).toEqual({ status: 200, body: { ok: true } });
      expect(f.r2.writes.length).toBe(writes);
      expect(f.fetches).toEqual([]);
    }
  });

  it('a flush context for another prefix is prefix_mismatch; a fresh-provision placeholder is not compared', async () => {
    const other = await fixture({ storage: { 'ezil:workspaceFlushContext': { prefix: `${uuid()}/branches/main`, mountPath: '/workspace' } } });
    expect((await other.begin()).body.error).toBe('prefix_mismatch');
    const placeholder = await fixture({ shape: 'none', storage: { 'ezil:workspaceFlushContext': { prefix: `${NAME}/branches/main`, mountPath: '/workspace', freshProvision: true } } });
    expect((await placeholder.begin()).status).toBe(200);
  });

  it('the host: export_busy, export_invalid or a 400 is export_refused; any other answer (another 409, a 503, none) is export_unreachable', async () => {
    const cases: Array<[(f: Awaited<ReturnType<typeof fixture>>) => void, number, string]> = [
      [f => { f.host.job = { moveId: uuid(), generation: uuid() }; }, 409, 'export_refused'],
      [f => { f.host.answer = () => Response.json({ ok: false, error: 'export_body_invalid' }, { status: 400 }); }, 409, 'export_refused'],
      // r7 (§4.2 step 7, lead decision): the edge answers 409 export_invalid only for a refusal the
      // agent itself sent (lane H's AGENT_REFUSALS), which a retry on the same host cannot clear.
      [f => { f.host.answer = () => Response.json({ ok: false, error: 'export_invalid' }, { status: 409 }); }, 409, 'export_refused'],
      // Any other 409 (a raw agent error the edge relays) is still retried.
      [f => { f.host.answer = () => Response.json({ ok: false, error: 'replayed' }, { status: 409 }); }, 503, 'export_unreachable'],
      [f => { f.host.answer = () => Response.json({ ok: false, error: 'agent_unavailable' }, { status: 503 }); }, 503, 'export_unreachable'],
      [f => { f.host.answer = () => { throw new Error('tunnel down'); }; }, 503, 'export_unreachable'],
      [f => { f.host.answer = () => Response.json({ ok: true, state: 'bogus' }, { status: 202 }); }, 503, 'export_unreachable'],
    ];
    for (const [arrange, status, error] of cases) {
      const f = await fixture();
      arrange(f);
      expect(await f.begin()).toEqual({ status, body: { ok: false, error } });
      // The fence stays up: the app re-sends begin (idempotent).
      expect(f.store.map.has(REVERSE_IMPORT_KEY)).toBe(true);
    }
  });

  it('only the export boot\'s host is asked: another epoch or no record is export_host_mismatch; AWS routing off is export_unreachable', async () => {
    for (const record of [{ leaseEpoch: 4 }, { generation: 8 }, { computerId: uuid() }, null]) {
      const f = await fixture({ record });
      expect(await f.begin()).toEqual({ status: 409, body: { ok: false, error: 'export_host_mismatch' } });
      expect(f.host.requests).toEqual([]);
    }
    const off = await fixture({ env: { AWS_ROUTING_ENABLED: undefined } });
    expect(await off.begin()).toEqual({ status: 503, body: { ok: false, error: 'export_unreachable' } });
    expect(off.registryPaths).toEqual([]);
  });

  it('a store read failure is a 503, never a 409', async () => {
    const f = await fixture();
    f.r2.faults.get = key => key === HEAD;
    expect(await f.begin()).toEqual({ status: 503, body: { ok: false, error: 'store_unavailable' } });
  });

  it('T0 (h): the key fences container starts on a computer with no flush context', async () => {
    const f = await fixture({ shape: 'none' });
    expect(f.store.map.has('ezil:workspaceFlushContext')).toBe(false);
    await f.begin();
    await expect(f.fake.start()).rejects.toThrow('migrating');
    const fetched = await f.fake.containerFetch('http://127.0.0.1:8181/');
    expect(fetched.status).toBe(409);
    await f.abort();
    expect(await f.fake.migrationStartBlocked()).toBe(false);
  });
});

describe('reverse import: pull (§4.3)', () => {
  it('before begin, import_not_started; another move, import_mismatch', async () => {
    const f = await fixture();
    expect(await f.pull()).toEqual({ status: 409, body: { ok: false, error: 'import_not_started' } });
    await f.begin();
    expect((await f.call('pull', { ...beginBody, moveId: uuid(), from: 0, count: 1 })).body.error).toBe('import_mismatch');
    // The ids pick the import (§4.3 step 1); a binding the tunnel record does not carry asks no host.
    const requests = f.host.requests.length;
    expect((await f.call('pull', { ...beginBody, leaseEpoch: 9, from: 0, count: 1 })).body.error).toBe('export_host_mismatch');
    expect(f.host.requests.length).toBe(requests);
  });

  it('capturing is not ready; a host that lost the job is asked again', async () => {
    const f = await fixture();
    await f.begin();
    expect(await f.pull(0, 64)).toEqual({ status: 200, body: { ok: true, export: expect.objectContaining({ state: 'capturing' }), head: null, stored: [], next: 0 } });
    f.host.job = null; f.host.state = 'none';
    const lost = await f.pull(5, 1);
    expect(lost).toEqual({ status: 200, body: { ok: true, export: expect.objectContaining({ state: 'capturing', moveId: MOVE }), head: null, stored: [], next: 5 } });
    expect(f.host.posts).toHaveLength(2);
  });

  for (const [hostError, code] of [['workspace_too_large', 'workspace_too_large'], ['workspace_missing', 'export_workspace_missing'],
    ['capture_failed', 'export_capture_failed'], ['desktop_stop_failed', 'export_desktop_stop_failed'], ['staging_space_low', 'export_staging_space']]) {
    it(`a failed export (${hostError}) is a top-level 409 ${code}`, async () => {
      const f = await fixture();
      await f.begin();
      f.host.state = 'failed'; f.host.error = hostError;
      expect(await f.pull()).toEqual({ status: 409, body: { ok: false, error: code } });
    });
  }

  it('ready: stores the head once, copies every chunk hash-checked, and reports stored indices idempotently', async () => {
    const f = await fixture();
    await f.begin();
    f.host.state = 'ready';
    const first = await f.pull(0, 2);
    expect(first.status).toBe(200);
    expect(first.body.head).toEqual(f.host.export.head);
    expect(first.body.stored).toEqual([0, 1]);
    expect(first.body.next).toBe(2);
    for (const i of [0, 1]) {
      const object = f.r2.objects.get(chunkKey(P, GEN, i))!;
      expect(hex(object.bytes)).toBe(f.host.export.head.chunks[i]!.sha256);
      expect(f.store.map.get(`${REVERSE_IMPORT_PUT_PREFIX}${i}`)).toEqual({ etag: object.etag, size: object.bytes.length, sha256: f.host.export.head.chunks[i]!.sha256 });
    }
    expect(f.store.map.get(REVERSE_IMPORT_HEAD_KEY)).toEqual(f.host.export.head);
    const chunkGets = () => f.host.requests.filter(r => r.path.includes('/chunk/')).length;
    const gets = chunkGets();
    const again = await f.pull(0, 64);
    expect(again.body.stored).toEqual([0, 1, 2]);
    expect(again.body.next).toBeNull();
    expect(chunkGets()).toBe(gets + 1);
    expect(f.host.requests.filter(r => r.path.endsWith('/head'))).toHaveLength(1);
    // A status poll on a complete copy.
    expect((await f.pull(0, 0)).body).toEqual({ ok: true, export: expect.objectContaining({ state: 'ready', entries: 12, bytes: f.host.export.head.bytes, skipped: 2 }),
      head: f.host.export.head, stored: [], next: null });
  });

  it('every pull rewrites the flag\'s startedAt before anything else', async () => {
    const f = await fixture();
    await f.begin();
    await f.r2.put(FLAG, { startedAt: '2001-01-01T00:00:00.000Z', reverse: { moveId: MOVE, generation: GEN } });
    await f.pull(0, 0);
    expect(Date.parse(f.r2.json(FLAG).startedAt)).toBeGreaterThan(Date.parse('2026-01-01'));
  });

  it('wrong bytes or a wrong length is chunk_mismatch, and nothing is recorded for that chunk', async () => {
    for (const bad of [
      () => new Response(new Uint8Array(MIB).fill(9), { headers: { 'content-length': String(MIB) } }),
      () => new Response(new Uint8Array(MIB - 1).fill(1), { headers: { 'content-length': String(MIB - 1) } }),
    ]) {
      const f = await fixture();
      await f.begin();
      f.host.state = 'ready';
      f.host.chunkOverride = index => index === 0 ? bad() : null;
      expect(await f.pull(0, 1)).toEqual({ status: 409, body: { ok: false, error: 'chunk_mismatch' } });
      expect(f.store.map.has(`${REVERSE_IMPORT_PUT_PREFIX}0`)).toBe(false);
      expect(f.r2.objects.has(chunkKey(P, GEN, 0))).toBe(false);
    }
  });

  it('right bytes under a missing or wrong Content-Length are chunk_mismatch (§4.3 step 4 checks the header itself)', async () => {
    const cases: Array<[string, (bytes: Uint8Array) => Response, string | null]> = [
      ['no Content-Length', bytes => new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } })), null],
      ['a short Content-Length', bytes => new Response(bytes, { headers: { 'content-length': String(bytes.length - 1) } }), String(MIB - 1)],
    ];
    for (const [, respond, header] of cases) {
      const f = await fixture();
      await f.begin();
      f.host.state = 'ready';
      const seen: Array<string | null> = [];
      f.host.chunkOverride = index => {
        const response = respond(f.host.export.chunks[index]!);
        seen.push(response.headers.get('content-length'));
        return response;
      };
      expect(await f.pull(0, 1)).toEqual({ status: 409, body: { ok: false, error: 'chunk_mismatch' } });
      // Not vacuous: the runtime sent the header this case means to send.
      expect(seen).toEqual([header]);
      expect(f.store.map.has(`${REVERSE_IMPORT_PUT_PREFIX}0`)).toBe(false);
      expect(f.r2.objects.has(chunkKey(P, GEN, 0))).toBe(false);
    }
  });

  it('a chunk the host cannot serve is export_unreachable; an R2 put failure is a 503: nothing landed', async () => {
    const f = await fixture();
    await f.begin();
    f.host.state = 'ready';
    f.host.chunkOverride = () => Response.json({ ok: false, error: 'export_chunk_missing' }, { status: 404 });
    expect(await f.pull(0, 1)).toEqual({ status: 503, body: { ok: false, error: 'export_unreachable' } });
    expect(await f.pull(0, 64)).toEqual({ status: 503, body: { ok: false, error: 'export_unreachable' } });
    f.host.chunkOverride = null;
    f.r2.faults.put = key => key.startsWith(`${P}/.ezil-snapshots/${GEN}/`);
    expect(await f.pull(0, 1)).toEqual({ status: 503, body: { ok: false, error: 'store_unavailable' } });
    expect(await f.pull(0, 64)).toEqual({ status: 503, body: { ok: false, error: 'store_unavailable' } });
    expect(importKeys(f.store.map).filter(key => key.startsWith(REVERSE_IMPORT_PUT_PREFIX))).toEqual([]);
  });

  it('one transient chunk failure keeps the pull\'s progress: 200 with what landed, next at the missing chunk', async () => {
    const faults: Array<[string, (f: Fixture) => void]> = [
      ['the host', f => { f.host.chunkOverride = index => index === 1 ? Response.json({ ok: false, error: 'agent_unavailable' }, { status: 503 }) : null; }],
      ['the tunnel', f => { f.host.chunkOverride = index => { if (index === 1) throw new Error('tunnel reset'); return null; }; }],
      ['an R2 put', f => { f.r2.faults.put = key => key === chunkKey(P, GEN, 1); }],
      ['a DO put', f => {
        const put = f.store.api.put;
        f.store.api.put = async (key: string, value: unknown) => {
          if (key === `${REVERSE_IMPORT_PUT_PREFIX}1`) throw new Error('storage blip');
          return put(key, value);
        };
      }],
    ];
    for (const [, arrange] of faults) {
      const f = await fixture();
      await f.begin();
      f.host.state = 'ready';
      const put = f.store.api.put;
      arrange(f);
      expect(await f.pull(0, 64)).toEqual({ status: 200, body: { ok: true, export: expect.objectContaining({ state: 'ready' }),
        head: f.host.export.head, stored: [0, 2], next: 1 } });
      expect(f.store.map.has(`${REVERSE_IMPORT_PUT_PREFIX}1`)).toBe(false);
      // The fault clears: the next pull starts at `next` and the copy completes.
      f.host.chunkOverride = null;
      f.r2.faults.put = () => false;
      f.store.api.put = put;
      expect((await f.pull(1, 64)).body).toMatchObject({ ok: true, stored: [1, 2], next: null });
      expect((await f.verify()).status).toBe(200);
    }
  });

  it('a failure starts no new transfer: the ones in flight finish and are reported', async () => {
    const f = await fixture();
    await f.begin();
    f.host.export = exportOf([...Array.from({ length: 9 }, () => MIB), 5]);
    f.host.state = 'ready';
    f.host.chunkDelay = 5;
    f.host.chunkOverride = index => index === 0 ? Response.json({ ok: false, error: 'agent_unavailable' }, { status: 503 }) : null;
    const r = await f.pull(0, 64);
    expect(r.body).toMatchObject({ ok: true, stored: [1, 2, 3], next: 0 });
    // The four that were in flight together, in whatever order they reached the host; none after.
    expect(f.host.requests.filter(req => req.path.includes('/chunk/')).map(req => Number(req.path.split('/').at(-1))).sort()).toEqual([0, 1, 2, 3]);
  });

  it('a mismatched chunk wins over a transient failure and over the chunks that landed', async () => {
    const f = await fixture();
    await f.begin();
    f.host.state = 'ready';
    f.host.chunkOverride = index => index === 0 ? Response.json({ ok: false, error: 'agent_unavailable' }, { status: 503 })
      : index === 1 ? new Response(new Uint8Array(MIB).fill(9), { headers: { 'content-length': String(MIB) } }) : null;
    expect(await f.pull(0, 64)).toEqual({ status: 409, body: { ok: false, error: 'chunk_mismatch' } });
    expect(f.store.map.has(`${REVERSE_IMPORT_PUT_PREFIX}1`)).toBe(false);
    expect(f.r2.objects.has(chunkKey(P, GEN, 1))).toBe(false);
  });

  for (const [name, mutate] of [
    ['another move', (h: Record<string, unknown>) => ({ ...h, moveId: uuid() })],
    ['another generation', (h: Record<string, unknown>) => ({ ...h, generation: uuid() })],
    ['bytes that are not the sum', (h: Record<string, unknown>) => ({ ...h, bytes: 1 })],
    ['a short middle chunk', (h: any) => ({ ...h, chunks: h.chunks.map((c: any, i: number) => i === 0 ? { ...c, size: 5 } : c) })],
    ['out-of-order indices', (h: any) => ({ ...h, chunks: [...h.chunks].reverse() })],
    ['v 2', (h: Record<string, unknown>) => ({ ...h, v: 2 })],
  ] as const) {
    it(`an export head with ${name} is export_head_invalid`, async () => {
      const f = await fixture();
      await f.begin();
      f.host.state = 'ready';
      f.host.export = { ...f.host.export, head: mutate(f.host.export.head as never) as never };
      expect(await f.pull()).toEqual({ status: 409, body: { ok: false, error: 'export_head_invalid' } });
      expect(f.store.map.has(REVERSE_IMPORT_HEAD_KEY)).toBe(false);
    });
  }
});

describe('reverse import: commit (§4.4)', () => {
  it('verifyOnly: proves every chunk with one listing and records verified', async () => {
    const f = await fixture();
    await f.copied();
    expect(await f.verify()).toEqual({ status: 200, body: { ok: true, verified: true } });
    expect((f.store.map.get(REVERSE_IMPORT_KEY) as any).verified).toEqual({ sha256: f.host.export.head.sha256, chunkCount: 3 });
  });

  it('verifyOnly: a missing chunk object, a changed etag, a missing record or another sha is not_verified', async () => {
    const arrange: Array<(f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown> | void> = [
      f => { f.r2.objects.delete(chunkKey(P, GEN, 1)); },
      f => f.r2.bucket.put(chunkKey(P, GEN, 2), f.host.export.chunks[2]!),
      f => { f.store.map.delete(`${REVERSE_IMPORT_PUT_PREFIX}0`); },
    ];
    for (const step of arrange) {
      const f = await fixture();
      await f.copied();
      await step(f);
      expect(await f.verify()).toEqual({ status: 409, body: { ok: false, error: 'not_verified' } });
      expect((f.store.map.get(REVERSE_IMPORT_KEY) as any).verified).toBeUndefined();
    }
    const f = await fixture();
    await f.copied();
    expect((await f.call('commit', { ...ids, sha256: 'f'.repeat(64), chunkCount: 3, verifyOnly: true })).body.error).toBe('not_verified');
    expect((await f.call('commit', { ...ids, sha256: f.host.export.head.sha256, chunkCount: 2, verifyOnly: true })).body.error).toBe('not_verified');
    expect((await f.call('commit', { ...ids, moveId: uuid(), sha256: f.host.export.head.sha256, chunkCount: 3, verifyOnly: true })).body.error).toBe('import_mismatch');
    const none = await fixture();
    expect((await none.verify()).body.error).toBe('import_not_started');
  });

  it('commits a forward-migrated computer: the v1 head at P, the system head reverted, the next open re-armed', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    expect(await f.commit()).toEqual({ status: 200, body: { ok: true, committed: true, store: 'r2' } });
    const head = f.r2.json(HEAD);
    expect(head).toEqual({ version: 1, generation: GEN, chunkGeneration: GEN, sha256: f.host.export.head.sha256, entries: 12,
      chunks: f.host.export.head.chunks.map(({ size, sha256 }) => ({ size, sha256 })) });
    expect(f.r2.json(SYS)).toEqual(f.previousSystem());
    expect(f.r2.objects.has(FLAG)).toBe(false);
    expect(importKeys(f.store.map)).toEqual([]);
    expect(f.store.map.get('ezil:workspaceFlushContext')).toEqual({ prefix: P, mountPath: '/workspace' });
    expect(f.store.map.get('ezil:workspaceTooLarge')).toBe(false);
    expect(f.store.map.get('ezil:systemTooLarge')).toBe(false);
    expect(f.store.map.get('ezil:workspaceHydrated')).toBe(false);
    expect(f.store.map.get('ezil:workspaceStoreKind')).toBe('r2');
    expect(await f.fake.migrationStartBlocked()).toBe(false);
  });

  it('the first Cloudflare open after the commit hydrates the imported head: no workspace_migrated, no migrating', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    await f.commit();
    const result = await f.fake.hydrateWorkspace({ mountPath: '/workspace', prefix: `/${P}` });
    expect(result.detail).not.toBe('workspace_migrated');
    expect(result.detail).not.toBe('migrating');
    const restore = f.execs.find(command => command.includes('"op":"restore"'));
    expect(restore).toContain(`"generation":"${GEN}"`);
  });

  it('commits a computer created on AWS and replaces a fresh-provision placeholder (and its fence)', async () => {
    const placeholder = `${NAME}/branches/main`;
    const f = await fixture({ shape: 'none', storage: { 'ezil:workspaceFlushContext': { prefix: placeholder, mountPath: '/workspace', freshProvision: true } } });
    await f.r2.put(`${placeholder}/${MIGRATING_FLAG}`, { startedAt: new Date().toISOString(), freshProvision: true });
    await f.copied();
    await f.verify();
    expect((await f.commit()).status).toBe(200);
    expect(f.r2.json(HEAD).generation).toBe(GEN);
    expect(f.r2.objects.has(SYS)).toBe(false);
    expect(f.r2.objects.has(`${placeholder}/${MIGRATING_FLAG}`)).toBe(false);
    expect(f.store.map.get('ezil:workspaceFlushContext')).toEqual({ prefix: P, mountPath: '/workspace' });
  });

  it('a retry after a lost answer is the same 200 and writes nothing (the flag stays down)', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    await f.commit();
    const writes = f.r2.writes.length;
    expect(await f.commit()).toEqual({ status: 200, body: { ok: true, committed: true, store: 'r2' } });
    expect(f.r2.writes.length).toBe(writes);
    expect(f.r2.objects.has(FLAG)).toBe(false);
  });

  it('without verify (or with no import at all) it is not_verified and writes no head', async () => {
    const f = await fixture();
    await f.copied();
    const head = f.r2.objects.get(HEAD)!.etag;
    expect(await f.commit()).toEqual({ status: 409, body: { ok: false, error: 'not_verified' } });
    expect(f.r2.objects.get(HEAD)!.etag).toBe(head);
    const none = await fixture();
    expect((await none.commit()).body.error).toBe('not_verified');
  });

  it('a head that moved loses the CAS: head_moved, committing cleared, and abort then cleans up', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    await f.r2.put(HEAD, { version: 1, generation: uuid(), sha256: 'a'.repeat(64), entries: 1, chunks: [{ size: 1, sha256: 'b'.repeat(64) }] });
    expect(await f.commit()).toEqual({ status: 409, body: { ok: false, error: 'head_moved' } });
    expect((f.store.map.get(REVERSE_IMPORT_KEY) as any).committing).toBeUndefined();
    expect(await f.abort()).toEqual({ status: 200, body: { ok: true } });
    expect(importKeys(f.store.map)).toEqual([]);
  });

  it('a computer created on AWS: a head that appeared at P since begin loses the create-only CAS (head_moved)', async () => {
    const f = await fixture({ shape: 'none' });
    await f.copied();
    await f.verify();
    // 🔴 §4.2: a Cloudflare head is never overwritten, also where begin saw none.
    const cloudflare = { version: 1, generation: uuid(), sha256: 'a'.repeat(64), entries: 1, chunks: [{ size: 1, sha256: 'b'.repeat(64) }] };
    await f.r2.put(HEAD, cloudflare);
    const etag = f.r2.objects.get(HEAD)!.etag;
    expect(await f.commit()).toEqual({ status: 409, body: { ok: false, error: 'head_moved' } });
    expect(f.r2.objects.get(HEAD)!.etag).toBe(etag);
    expect(f.r2.json(HEAD)).toEqual(cloudflare);
    expect((f.store.map.get(REVERSE_IMPORT_KEY) as any).committing).toBeUndefined();
  });

  it('a v1 system head where begin saw none is system_head_moved after the workspace head committed', async () => {
    const f = await fixture({ shape: 'none' });
    await f.copied();
    await f.verify();
    expect((f.store.map.get(REVERSE_IMPORT_KEY) as any).systemMigratedEtag).toBeNull();
    await f.r2.put(SYS, { version: 1, generation: uuid(), sha256: 'a'.repeat(64), entries: 1, chunks: [{ size: 1, sha256: 'b'.repeat(64) }] });
    expect(await f.commit()).toEqual({ status: 409, body: { ok: false, error: 'system_head_moved' } });
    expect(f.r2.json(HEAD).generation).toBe(GEN);
    expect((f.store.map.get(REVERSE_IMPORT_KEY) as any).committing).toBe(true);
    expect((await f.commit()).body.error).toBe('system_head_moved');
  });

  it('step 3 records the generation it puts back BEFORE the put: a crash between the two completes on retry', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    const put = f.store.api.put;
    let failed = false;
    // Die on the record: with the record after the put, the put would have landed by now and
    // every retry would read a v1 system head it cannot recognise (`system_head_moved`).
    f.store.api.put = async (key: string, value: unknown) => {
      if (key === REVERSE_IMPORT_KEY && (value as { systemRevertGeneration?: string }).systemRevertGeneration && !failed) {
        failed = true;
        throw new Error('storage blip');
      }
      return put(key, value);
    };
    expect(await f.commit()).toEqual({ status: 503, body: { ok: false, error: 'store_unavailable' } });
    expect(failed).toBe(true);
    expect(f.r2.json(HEAD).generation).toBe(GEN);
    expect(await f.commit()).toEqual({ status: 200, body: { ok: true, committed: true, store: 'r2' } });
    expect(f.r2.json(SYS)).toEqual(f.previousSystem());
    expect(importKeys(f.store.map)).toEqual([]);
  });

  it('a moved system head is system_head_moved after the workspace head committed; committing holds abort off', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    const marker = f.r2.json(SYS);
    await f.r2.put(SYS, marker); // same content, new etag
    expect(await f.commit()).toEqual({ status: 409, body: { ok: false, error: 'system_head_moved' } });
    expect(f.r2.json(HEAD).generation).toBe(GEN);
    expect((f.store.map.get(REVERSE_IMPORT_KEY) as any).committing).toBe(true);
    expect(await f.abort()).toEqual({ status: 409, body: { ok: false, error: 'commit_in_progress' } });
    // Still refused on retry (the app keeps retrying the same commit until flip_stuck).
    expect((await f.commit()).body.error).toBe('system_head_moved');
  });

  it('step 3 is idempotent: a commit that died after reverting the system head completes on retry', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    // Die in step 4, after the revert landed.
    const put = f.store.api.put;
    f.store.api.put = async (key: string, value: unknown) => {
      if (key === 'ezil:workspaceFlushContext') throw new Error('storage blip');
      return put(key, value);
    };
    expect(await f.commit()).toEqual({ status: 503, body: { ok: false, error: 'store_unavailable' } });
    expect(f.r2.json(SYS)).toEqual(f.previousSystem());
    expect(f.r2.objects.has(FLAG)).toBe(true);
    f.store.api.put = put;
    // The retry is a commit too: it rewrites the flag's startedAt first (§4.1), then lowers it.
    await f.r2.put(FLAG, { startedAt: '2001-01-01T00:00:00.000Z', reverse: { moveId: MOVE, generation: GEN } });
    const log = writeLog(f);
    const flagPut = f.r2.bucket.put;
    let rewritten: string | undefined;
    f.r2.bucket.put = async (key: string, value: Uint8Array | string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
      if (key === FLAG) rewritten = JSON.parse(typeof value === 'string' ? value : new TextDecoder().decode(value)).startedAt;
      return flagPut(key, value, opts);
    };
    expect(await f.commit()).toEqual({ status: 200, body: { ok: true, committed: true, store: 'r2' } });
    expect(log[0]).toBe(`r2 ${FLAG}`);
    expect(log).toContain(`r2-delete ${FLAG}`);
    expect(Date.parse(rewritten!)).toBeGreaterThan(Date.parse('2026-01-01'));
    expect(f.r2.json(SYS)).toEqual(f.previousSystem());
    expect(f.r2.objects.has(FLAG)).toBe(false);
    expect(importKeys(f.store.map)).toEqual([]);
  });

  it('a v1 system head that is not the one this commit put back stays system_head_moved', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    const put = f.store.api.put;
    f.store.api.put = async (key: string, value: unknown) => {
      if (key === 'ezil:workspaceFlushContext') throw new Error('storage blip');
      return put(key, value);
    };
    await f.commit();
    f.store.api.put = put;
    await f.r2.put(SYS, { ...f.previousSystem(), generation: uuid() });
    expect((await f.commit()).body.error).toBe('system_head_moved');
  });

  it('a legacy system marker without `previous` is deleted', async () => {
    const f = await fixture();
    const marker = f.r2.json(SYS);
    delete marker.previous;
    await f.r2.put(SYS, marker);
    await f.copied();
    await f.verify();
    expect((await f.commit()).status).toBe(200);
    expect(f.r2.objects.has(SYS)).toBe(false);
  });
});

describe('reverse import: abort (§4.5)', () => {
  it('deletes this move\'s chunks, its flag and its keys; idempotent with no key; never touches the host', async () => {
    const f = await fixture();
    await f.copied();
    const requests = f.host.requests.length;
    expect(await f.abort()).toEqual({ status: 200, body: { ok: true } });
    expect([...f.r2.objects.keys()].filter(key => key.includes(`/.ezil-snapshots/${GEN}/`))).toEqual([]);
    expect(f.r2.objects.has(FLAG)).toBe(false);
    expect(importKeys(f.store.map)).toEqual([]);
    expect(await f.abort()).toEqual({ status: 200, body: { ok: true } });
    expect(f.host.requests.length).toBe(requests);
  });

  it('keeps a flag and keys that are not this move\'s', async () => {
    const f = await fixture();
    await f.begin();
    const other = { ...ids, moveId: uuid(), generation: uuid() };
    expect(await f.call('abort', other)).toEqual({ status: 200, body: { ok: true } });
    expect(f.r2.json(FLAG).reverse).toEqual({ moveId: MOVE, generation: GEN });
    expect(f.store.map.has(REVERSE_IMPORT_KEY)).toBe(true);
  });

  it('after the commit it is already_imported', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    await f.commit();
    expect(await f.abort()).toEqual({ status: 409, body: { ok: false, error: 'already_imported' } });
  });

  it('a stale key set from a crashed abort never lends its chunk records to the next move', async () => {
    const f = await fixture();
    await f.copied();
    f.store.map.delete(REVERSE_IMPORT_KEY); // the main key went, its records did not
    expect(await f.begin()).toMatchObject({ status: 200 });
    expect(importKeys(f.store.map)).toEqual([REVERSE_IMPORT_KEY]);
  });

  // The gate refusals begin answers before any write (§4.1), each as its own computer state.
  const refusingGates: Array<[string, FixtureOptions, string]> = [
    ['an S3 store that resolves', { env: { EZIL_WORKSPACE_STORE: 's3', ...S3_ENV } }, 'store_unsupported'],
    ['a flush context for another prefix', { storage: { 'ezil:workspaceFlushContext': { prefix: `${uuid()}/branches/main`, mountPath: '/workspace' } } }, 'prefix_mismatch'],
    ['a deployment-wide prefix', { env: { SANDBOX_WORKSPACE_S3_PREFIX: '/fixed' } }, 'prefix_mismatch'],
  ];
  for (const [name, options, code] of refusingGates) {
    it(`after begin refused ${code} (${name}), the compensating abort is a 200 with no I/O`, async () => {
      const f = await fixture({ shape: 'none', ...options });
      expect(await f.begin()).toEqual({ status: 409, body: { ok: false, error: code } });
      // §4.5: no key of this move → 200. A 409 here has no §5.5 abort row: `abort_unconfirmed`.
      expect(await f.abort()).toEqual({ status: 200, body: { ok: true } });
      expect(f.r2.writes).toEqual([]);
      expect(importKeys(f.store.map)).toEqual([]);
      expect(f.fetches).toEqual([]);
    });

    it(`with this move's key behind that gate (${name}), abort stays ${code}: its writes cannot be cleaned through it`, async () => {
      const f = await fixture({ shape: 'none', ...options, storage: { ...(options.storage ?? {}), [REVERSE_IMPORT_KEY]: ownState() } });
      expect(await f.abort()).toEqual({ status: 409, body: { ok: false, error: code } });
      expect(f.store.map.has(REVERSE_IMPORT_KEY)).toBe(true);
      // Another move's abort behind the same gate is idempotent.
      expect(await f.call('abort', { ...ids, moveId: uuid(), generation: uuid() })).toEqual({ status: 200, body: { ok: true } });
      expect(f.store.map.has(REVERSE_IMPORT_KEY)).toBe(true);
      // §4.5's first rule comes before the gate: once committing, the head CAS may have landed.
      f.store.map.set(REVERSE_IMPORT_KEY, ownState({ committing: true }));
      for (const body of [ids, { ...ids, moveId: uuid(), generation: uuid() }]) {
        expect(await f.call('abort', body)).toEqual({ status: 409, body: { ok: false, error: 'commit_in_progress' } });
      }
    });
  }

  it('a begin that died between its flag and its key: abort (no key) still lowers this move\'s flag', async () => {
    const f = await fixture();
    const put = f.store.api.put;
    f.store.api.put = async (key: string, value: unknown) => {
      if (key === REVERSE_IMPORT_KEY) throw new Error('storage blip');
      return put(key, value);
    };
    expect(await f.begin()).toEqual({ status: 503, body: { ok: false, error: 'store_unavailable' } });
    expect(f.r2.json(FLAG).reverse).toEqual({ moveId: MOVE, generation: GEN });
    expect(f.store.map.has(REVERSE_IMPORT_KEY)).toBe(false);
    expect(f.host.posts).toEqual([]);
    f.store.api.put = put;
    expect(await f.abort()).toEqual({ status: 200, body: { ok: true } });
    expect(f.r2.objects.has(FLAG)).toBe(false);
  });

  it('a flag whose body cannot be read is a 503, never "not this move\'s": the flag and the keys stay for the retry', async () => {
    const f = await fixture();
    await f.begin();
    const get = f.r2.bucket.get;
    f.r2.bucket.get = async (key: string) => {
      const object = await get(key);
      return key === FLAG && object ? { ...object, arrayBuffer: async () => { throw new Error('r2 body read failed'); } } : object;
    };
    expect(await f.abort()).toEqual({ status: 503, body: { ok: false, error: 'store_unavailable' } });
    expect(f.r2.objects.has(FLAG)).toBe(true);
    expect(f.store.map.has(REVERSE_IMPORT_KEY)).toBe(true);
    f.r2.bucket.get = get;
    expect(await f.abort()).toEqual({ status: 200, body: { ok: true } });
    expect(f.r2.objects.has(FLAG)).toBe(false);
    expect(importKeys(f.store.map)).toEqual([]);
  });
});

describe('reverse import: a full-size key set (DO deletes take at most 128 keys)', () => {
  /** A 300-chunk import's DO keys, seeded as metadata (no bytes move): 302 keys in all. */
  function seeded(n = 300) {
    const sha = 'e'.repeat(64);
    const chunks = Array.from({ length: n }, (_, i) => ({ i, size: MIB, sha256: hex(new Uint8Array([i & 0xff, i >> 8])) }));
    const head = { v: 1, moveId: MOVE, generation: GEN, sha256: sha, entries: 40, skipped: 0, bytes: n * MIB, chunks };
    const storage: Record<string, unknown> = {
      [REVERSE_IMPORT_KEY]: ownState({ verified: { sha256: sha, chunkCount: n } }),
      [REVERSE_IMPORT_HEAD_KEY]: head,
      ...Object.fromEntries(chunks.map(c => [`${REVERSE_IMPORT_PUT_PREFIX}${c.i}`, { etag: `e-${c.i}`, size: MIB, sha256: c.sha256 }])),
    };
    return { storage, sha, n };
  }

  it('commit clears every key in batches, the main key last', async () => {
    const { storage, sha, n } = seeded();
    const f = await fixture({ shape: 'none', storage });
    expect(importKeys(f.store.map)).toHaveLength(n + 2);
    const log = writeLog(f);
    expect(await f.call('commit', { ...ids, sha256: sha, chunkCount: n, verifyOnly: false })).toEqual({ status: 200, body: { ok: true, committed: true, store: 'r2' } });
    expect(f.r2.json(HEAD).chunks).toHaveLength(n);
    expect(importKeys(f.store.map)).toEqual([]);
    const deletes = log.filter(entry => entry.startsWith('do-delete '));
    expect(deletes.length).toBeGreaterThanOrEqual(3);
    expect(deletes.at(-1)).toBe(`do-delete ${REVERSE_IMPORT_KEY}`);
  });

  it('abort clears every key in batches', async () => {
    const { storage } = seeded();
    const f = await fixture({ shape: 'none', storage });
    expect(await f.abort()).toEqual({ status: 200, body: { ok: true } });
    expect(importKeys(f.store.map)).toEqual([]);
  });
});

describe('reverse import: pull throughput bounds (unit, fake clock)', () => {
  async function unit(chunks: number, opts: { tick?: number } = {}) {
    const f = await fixture();
    const { chunks: data, head } = exportOf([...Array.from({ length: chunks - 1 }, () => MIB), 7]);
    f.host.export = { chunks: data, head };
    let clock = Date.now();
    const record = f.record;
    const host: ExportHostAccess = { zone: 'ezil.work', lookup: async () => record,
      fetch: async (input, init) => { clock += opts.tick ?? 0; return globalThis.fetch(input, init); } };
    const deps: ReverseImportDeps = {
      sandboxName: NAME, storage: f.store.api as never,
      selectStore: async () => ({ kind: 'r2', bucket: f.r2.bucket as never }), prefixOverride: undefined,
      flushContext: async () => undefined, containerRunning: () => false, withStartQueue: op => op(),
      adoptImportedWorkspace: async () => {}, host, now: () => clock,
    };
    f.host.clock = () => clock;
    const run = (body: Record<string, unknown>, startedAt = clock) => runReverseImport(parseImportRequest(String(body.op), body, NAME)!, deps, startedAt);
    expect((await run({ op: 'begin', ...beginBody })).status).toBe(200);
    f.host.state = 'ready';
    return { f, run, advance: (ms: number) => { clock += ms; }, now: () => clock };
  }

  it('keeps at most 4 chunk transfers in flight', async () => {
    const { f, run } = await unit(10);
    f.host.chunkDelay = 5;
    const r = await run({ op: 'pull', ...beginBody, from: 0, count: 10 });
    expect(r.body.stored).toEqual([...Array(10).keys()]);
    // The contract's number, not the module's constant: a changed constant must fail here.
    expect(f.host.maxInFlight).toBe(4);
    expect(PULL_CONCURRENCY).toBe(4);
  });

  it('starts no new transfer after 20 s of wall time counted from the request\'s arrival', async () => {
    // Each host request moves the clock 2 s: the status read, the head read, then chunks.
    const { run, now } = await unit(20, { tick: 2_000 });
    const arrival = now() - 5_000; // it waited 5 s in the Durable Object's queue
    const r = await run({ op: 'pull', ...beginBody, from: 0, count: 20 }, arrival);
    expect(r.status).toBe(200);
    const stored = r.body.stored as number[];
    // 9 s gone before the first chunk (5 s queued, the status and head reads): transfers start
    // at 9, 11, … 19 s, plus at most the 3 other workers that passed the check together.
    expect(stored.length).toBeGreaterThanOrEqual(6);
    expect(stored.length).toBeLessThanOrEqual(9);
    expect(r.body.next).toBe(stored.length);
    expect(PULL_TRANSFER_WINDOW_MS).toBe(20_000);
  });

  it('a chunk GET gets the time left to 32 s after arrival, never less than 12 s: none runs past 32 s', () => {
    expect(EXPORT_CHUNK_TIMEOUT_MS).toBe(12_000);
    expect(PULL_CHUNK_DEADLINE_MS).toBe(32_000);
    const arrival = 1_000_000;
    for (const offset of [0, 4_000, 9_000, 19_999, PULL_TRANSFER_WINDOW_MS]) {
      const timeout = chunkTimeoutMs(arrival, arrival + offset);
      expect(timeout).toBeGreaterThanOrEqual(12_000);
      expect(offset + timeout).toBeLessThanOrEqual(32_000);
    }
    // An early transfer on a slow host is not cut at 12 s with its three siblings.
    expect(chunkTimeoutMs(arrival, arrival + 9_000)).toBe(23_000);
  });

  it('the pull hands each chunk GET that timeout', async () => {
    // Each host request moves the clock 2 s: the chunks start 4 s after arrival (status, head).
    const { run, now } = await unit(4, { tick: 2_000 });
    const timeout = spyOn(AbortSignal, 'timeout');
    try {
      const r = await run({ op: 'pull', ...beginBody, from: 0, count: 4 }, now());
      expect(r.body.stored).toEqual([0, 1, 2, 3]);
      const ms = timeout.mock.calls.map(([value]) => value as number);
      expect(ms.filter(value => value === EXPORT_READ_TIMEOUT_MS)).toHaveLength(2);
      expect(ms.filter(value => value !== EXPORT_READ_TIMEOUT_MS)).toEqual(Array(4).fill(PULL_CHUNK_DEADLINE_MS - 4_000));
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('reverse import: one queue per Durable Object (§4.1)', () => {
  it('a pull that waited behind another op counts the wait against its 20 s window', async () => {
    const f = await fixture();
    await f.begin();
    f.host.state = 'ready';
    const base = Date.now();
    let offset = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => base + offset);
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const hostFetch = globalThis.fetch;
      let held = false;
      // The first op's first host read hangs until released: the second op waits in the queue.
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!held) { held = true; await gate; }
        return hostFetch(input, init);
      }) as typeof fetch;
      const first = f.fake.reverseImport(parseImportRequest('pull', { ...beginBody, from: 0, count: 0 }, NAME), NAME);
      const second = f.fake.reverseImport(parseImportRequest('pull', { ...beginBody, from: 0, count: 3 }, NAME), NAME);
      offset = 25_000;
      release();
      expect((await first).status).toBe(200);
      expect((await second).body).toMatchObject({ ok: true, stored: [], next: 0 });
      expect(f.host.requests.filter(r => r.path.includes('/chunk/'))).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it('commit and abort never interleave: an abort queued behind a commit sees the committed head', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    f.r2.timing.latencyMs = 2;
    const commit = f.commit();
    const abort = f.abort();
    expect((await commit).status).toBe(200);
    expect(await abort).toEqual({ status: 409, body: { ok: false, error: 'already_imported' } });
    expect(f.r2.json(HEAD).generation).toBe(GEN);
  });
});

describe('reverse import: write order (§4.1 flag first, §4.4 step 1)', () => {
  it('the flag is the first write of every begin, pull, verify and commit (R2 and DO storage together)', async () => {
    const f = await fixture();
    const log = writeLog(f);
    const firstWrite = async (run: () => Promise<{ status: number }>) => {
      log.length = 0;
      expect((await run()).status).toBe(200);
      return log[0];
    };
    expect(await firstWrite(f.begin)).toBe(`r2 ${FLAG}`);
    expect(log).toContain(`do ${REVERSE_IMPORT_KEY}`);
    expect(await firstWrite(f.begin)).toBe(`r2 ${FLAG}`);
    f.host.state = 'ready';
    expect(await firstWrite(() => f.pull(0, 2))).toBe(`r2 ${FLAG}`);
    expect(log).toContain(`do ${REVERSE_IMPORT_HEAD_KEY}`);
    expect(await firstWrite(() => f.pull(2, 1))).toBe(`r2 ${FLAG}`);
    expect(await firstWrite(f.verify)).toBe(`r2 ${FLAG}`);
    expect(await firstWrite(f.commit)).toBe(`r2 ${FLAG}`);
    // Step 1 before step 2: `committing` is persisted before the head CAS.
    expect(log.indexOf(`do ${REVERSE_IMPORT_KEY}`)).toBeLessThan(log.indexOf(`r2 ${HEAD}`));
  });

  it('the DO key already says committing when the head CAS reaches the store', async () => {
    const f = await fixture();
    await f.copied();
    await f.verify();
    const put = f.r2.bucket.put;
    const seen: unknown[] = [];
    f.r2.bucket.put = async (key: string, value: Uint8Array | string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
      if (key === HEAD) seen.push((f.store.map.get(REVERSE_IMPORT_KEY) as Record<string, unknown> | undefined)?.committing);
      return put(key, value, opts);
    };
    expect((await f.commit()).status).toBe(200);
    expect(seen).toEqual([true]);
  });
});

describe('reverse import: the no-push pin (§4.1 [r6])', () => {
  const banned = /^(ensureAwsDesktop|restartPush|awsRestartPush|pushAwsDesktopConfig)/;
  const identifiersOf = (node: ts.Node) => {
    const names = new Set<string>();
    const visit = (n: ts.Node) => { if (ts.isIdentifier(n)) names.add(n.text); ts.forEachChild(n, visit); };
    visit(node);
    return names;
  };

  it('the import module never imports the desktop-config or restart paths', () => {
    const path = new URL('./workspace-migration-import.ts', import.meta.url);
    const source = ts.createSourceFile('m.ts', readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, true);
    const imports = source.statements.filter(ts.isImportDeclaration).map(s => (s.moduleSpecifier as ts.StringLiteral).text);
    expect(imports.filter(m => ['./aws-ice', './aws-restart', './aws-tunnels'].includes(m))).toEqual([]);
    expect([...identifiersOf(source)].filter(name => banned.test(name))).toEqual([]);
  });

  it('the Durable Object\'s reverseImport, which builds the host access, uses only the tunnel lookup', () => {
    const source = ts.createSourceFile('index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ESNext, true);
    const methods: ts.MethodDeclaration[] = [];
    const find = (node: ts.Node) => {
      if (ts.isMethodDeclaration(node) && node.body && ts.isIdentifier(node.name) && node.name.text === 'reverseImport') methods.push(node);
      ts.forEachChild(node, find);
    };
    find(source);
    expect(methods).toHaveLength(1);
    const names = identifiersOf(methods[0]!);
    // Positive control: this is the method that reaches the host.
    expect(names.has('lookupAwsTunnel')).toBe(true);
    expect([...names].filter(name => banned.test(name) || name === 'lookupAwsTunnelForBrowser')).toEqual([]);
  });

  it('a whole move calls nothing but the export routes on the export boot\'s host, and only looks the tunnel up', async () => {
    const f = await fixture();
    await f.begin();
    await f.pull(0, 0);
    f.host.state = 'ready';
    expect((await f.pull()).body.next).toBeNull();
    await f.verify();
    expect((await f.commit()).status).toBe(200);
    await f.call('abort', { ...ids, moveId: uuid(), generation: uuid() });
    expect(f.fetches.length).toBeGreaterThan(5);
    const host = `c-${NAME}-g${PLACEMENT.placementGeneration}-e${PLACEMENT.leaseEpoch}.ezil.work`;
    expect(f.fetches.filter(({ url }) => new URL(url).hostname !== host || !new URL(url).pathname.startsWith(`${EXPORT_CONTROL_PATH}/`))).toEqual([]);
    expect(f.host.requests.filter(({ path }) => !path.startsWith(`${EXPORT_CONTROL_PATH}/`))).toEqual([]);
    expect(new Set(f.registryPaths)).toEqual(new Set([REGISTRY_PATHS.get]));
  });
});

// r7 integration: the four guards the lane's own tests left unpinned (verifier mutants W20, W21, W22,
// W24), ported from the verifier's probe. Each drives the real module with the smallest fake it needs.
describe('reverse import: guards the verifier found unpinned (W20, W21, W22, W24)', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  function kv(initial: Record<string, unknown>) {
    const map = new Map<string, unknown>(Object.entries(initial));
    return { map, api: {
      get: async (k: string) => structuredClone(map.get(k)),
      put: async (k: string, v: unknown) => { map.set(k, structuredClone(v)); },
      delete: async (keys: string[]) => { let n = 0; for (const k of keys) if (map.delete(k)) n++; return n; },
      list: async ({ prefix }: { prefix: string }) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
    } };
  }
  const bareDeps = (over: Record<string, unknown>) => ({ sandboxName: NAME, prefixOverride: undefined, flushContext: async () => undefined,
    containerRunning: () => false, withStartQueue: (op: () => Promise<unknown>) => op(), adoptImportedWorkspace: async () => {},
    host: null, now: Date.now, ...over }) as unknown as ReverseImportDeps;

  it('W24 (§2.3, §4.3 step 3): a head whose middle chunk is short but whose bytes add up is refused', () => {
    const head = { v: 1, moveId: MOVE, generation: GEN, sha256: sha('a'), entries: 1, skipped: 0, bytes: 5 + MIB,
      chunks: [{ i: 0, size: 5, sha256: sha('b') }, { i: 1, size: MIB, sha256: sha('c') }] };
    expect(parseExportHead(head, { moveId: MOVE, generation: GEN })).toBeNull();
    // Control: the same chunks in the legal order are accepted.
    expect(parseExportHead({ ...head, chunks: [{ i: 0, size: MIB, sha256: sha('c') }, { i: 1, size: 5, sha256: sha('b') }] },
      { moveId: MOVE, generation: GEN })).not.toBeNull();
  });

  it('W20 (§4.1): a freshProvision context for another prefix is compared (prefix_mismatch), never taken as the placeholder', async () => {
    const st = kv({});
    const bucket = { get: async () => null, put: async () => ({ etag: 'x' }), list: async () => ({ objects: [], truncated: false }), delete: async () => {} };
    const d = bareDeps({ storage: st.api, selectStore: async () => ({ kind: 'r2', bucket }),
      flushContext: async () => ({ prefix: '99999999-9999-4999-8999-999999999999/branches/main', freshProvision: true }) });
    const r = await runReverseImport(parseImportRequest('begin', beginBody, NAME)!, d);
    expect(r).toEqual({ status: 409, body: { ok: false, error: 'prefix_mismatch' } });
    expect(st.map.size).toBe(0);
  });

  it('W21 (§4.4 step 3): a system save landing between step 3\'s read and its put loses the CAS (system_head_moved)', async () => {
    const previous = { version: 1, generation: '55555555-5555-4555-8555-555555555555', chunkGeneration: '66666666-6666-4666-8666-666666666666',
      sha256: sha('p'), entries: 2, chunks: [{ size: 20, sha256: sha('q') }] };
    const marker = { version: 2, kind: 'migrated', targetProvider: 'aws-ec2', migratedAt: '2026-10-22T10:00:00.000Z',
      exported: { generation: previous.generation, chunkGeneration: previous.chunkGeneration, sha256: previous.sha256, entries: 2 }, previous };
    const own = { version: 1, generation: GEN, chunkGeneration: GEN, sha256: sha('o'), entries: 1, chunks: [{ size: 7, sha256: sha('r') }] };
    const objects = new Map<string, { body: string; etag: string }>([[HEAD, { body: JSON.stringify(own), etag: 'w1' }],
      [SYS, { body: JSON.stringify(marker), etag: 'E1' }]]);
    const bucket = {
      get: async (k: string) => {
        const o = objects.get(k);
        if (!o) return null;
        // A concurrent system save lands right after this read.
        if (k === SYS) objects.set(SYS, { body: JSON.stringify({ ...own, generation: '77777777-7777-4777-8777-777777777777' }), etag: 'E2' });
        return { etag: o.etag, size: o.body.length, arrayBuffer: async () => new TextEncoder().encode(o.body).buffer };
      },
      put: async (k: string, v: Uint8Array, opts?: { onlyIf?: { etagMatches?: string } }) => {
        if (opts?.onlyIf?.etagMatches !== undefined && objects.get(k)?.etag !== opts.onlyIf.etagMatches) return null;
        objects.set(k, { body: new TextDecoder().decode(v), etag: 'E3' });
        return { etag: 'E3' };
      },
      list: async () => ({ objects: [], truncated: false }), delete: async (keys: string[]) => { for (const k of keys) objects.delete(k); },
    };
    const st = kv({ [REVERSE_IMPORT_KEY]: { ...ids, ...PLACEMENT, store: 'r2', prefix: P, headKind: 'migrated',
      migratedEtag: 'w0', systemMigratedEtag: 'E1', startedAt: new Date().toISOString(), committing: true } });
    const d = bareDeps({ storage: st.api, selectStore: async () => ({ kind: 'r2', bucket }) });
    const r = await runReverseImport(parseImportRequest('commit', { ...ids, sha256: own.sha256, chunkCount: 1, verifyOnly: false }, NAME)!, d);
    expect(r).toEqual({ status: 409, body: { ok: false, error: 'system_head_moved' } });
    expect(objects.get(SYS)!.etag).toBe('E2');
  });

  it('W22: every export GET asks the edge for identity encoding, so the chunk Content-Length stays checkable', async () => {
    const seen: Array<string | null> = [];
    const record = { computerId: COMPUTER, sandboxId: NAME, generation: 7, leaseEpoch: 3, controlKey: CONTROL_KEY } as unknown as AwsTunnelRecord;
    const fetchFn = async (_u: string, init?: RequestInit) => { seen.push(new Headers(init?.headers).get('accept-encoding')); return new Response('{}'); };
    for (const read of ['status', 'head', { chunk: 0 }] as const) {
      await readAwsExport(record, 'ezil.work', read, fetchFn as never, Math.floor(Date.now() / 1000), 1000);
    }
    expect(seen).toEqual(['identity', 'identity', 'identity']);
  });
});
