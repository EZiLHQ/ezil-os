/**
 * System-layer chunk transfers against a fake that models the container server's
 * real concurrency rule: every operation of a session runs under that session's
 * exclusive lock (FIFO); sessionless operations take no lock. Measured on the
 * shipped server (0.12.1): a default-session write waited 3018 ms behind a 3 s
 * exec, a sessionless one 14 ms.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushSystemLayer, hydrateSystemLayer, SESSIONLESS_TRANSFER, SYSTEM_TRANSFER_CONCURRENCY } from './system-persist';
import { base64ToBytes, bytesToBase64 } from './project-files';
import { chunkKey, sha256, SNAPSHOT_HEAD } from './workspace-persist';

const COMPUTER = '11111111-2222-4333-8444-555555555555';
const REAL_PREFIX = `${COMPUTER}/branches/main`;
const PREFIX = `${COMPUTER}/system`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Op = { kind: string; path?: string; sessionId: string; op?: string };

class FakeContainerServer {
  imageId: unknown = 'ezil-running:2026.10_20';
  files = new Map<string, Uint8Array>();
  log: Op[] = [];
  inFlightTransfers = 0;
  maxInFlightTransfers = 0;
  restoreSaw: Uint8Array[] | null = null;
  failWriteIndex: number | null = null;
  private locks = new Map<string, Promise<void>>();
  constructor(private latency: (op: Op) => number = () => 5) {}

  private async inSession<T>(sessionId: string | undefined, fn: () => Promise<T>): Promise<T> {
    const sid = sessionId ?? 'default';
    if (sid === SESSIONLESS_TRANSFER) return fn();
    const previous = this.locks.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(sid, previous.then(() => mine));
    await previous;
    try { return await fn(); } finally { release(); }
  }
  private async transfer<T>(op: Op, fn: () => T): Promise<T> {
    this.log.push(op);
    return this.inSession(op.sessionId, async () => {
      this.inFlightTransfers++;
      this.maxInFlightTransfers = Math.max(this.maxInFlightTransfers, this.inFlightTransfers);
      try { await sleep(this.latency(op)); return fn(); } finally { this.inFlightTransfers--; }
    });
  }
  /** A command the desktop boot runs in the default session meanwhile. */
  boot(ms: number) { return this.inSession('default', () => sleep(ms)); }

  async exists(_path: string) { return { exists: false }; }
  async mkdir(path: string, options?: { recursive?: boolean; sessionId?: string }) {
    this.log.push({ kind: 'mkdir', path, sessionId: options?.sessionId ?? 'default' });
    return this.inSession(options?.sessionId, async () => ({ success: true }));
  }
  async writeFile(path: string, content: string, options?: { encoding?: string; sessionId?: string }) {
    const sessionId = options?.sessionId ?? 'default';
    return this.transfer({ kind: 'write', path, sessionId }, () => {
      if (this.failWriteIndex !== null && path.endsWith(`/${this.failWriteIndex}`)) return { success: false };
      this.files.set(path, base64ToBytes(content));
      return { success: true };
    });
  }
  async readFile(path: string, options?: { encoding?: string; sessionId?: string }) {
    const sessionId = options?.sessionId ?? 'default';
    return this.transfer({ kind: 'read', path, sessionId }, () => ({ content: bytesToBase64(this.files.get(path)!), encoding: 'base64' }));
  }
  capture: (work: string) => Record<string, unknown> = () => ({ skipped: 'no_baseline' });
  async exec(command: string) {
    const params = JSON.parse(/ '(\{.*\})'$/s.exec(command)![1]!.replace(/'"'"'/g, "'")) as Record<string, any>;
    this.log.push({ kind: 'exec', sessionId: 'default', op: params.op });
    return this.inSession('default', async () => {
      if (params.op === 'sys-restore') {
        this.restoreSaw = (params.snapshot.chunks as unknown[]).map((_c, i) => this.files.get(`${params.work}/${i}`)!);
        return { exitCode: 0, stdout: JSON.stringify({ restored: params.snapshot.chunks.length, imageId: this.imageId }) };
      }
      if (params.op === 'sys-capture') return { exitCode: 0, stdout: JSON.stringify(this.capture(params.work)) };
      if (params.op === 'sys-hydrated') return { exitCode: 0, stdout: JSON.stringify({ hydrated: true, imageId: this.imageId }) };
      return { exitCode: 0, stdout: '{}' };
    });
  }
}

function body(bytes: Uint8Array, etag = 'etag-1') {
  return { etag, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}

async function storedLayer(count: number, { getLatency = () => 5 }: { getLatency?: (i: number) => number } = {}) {
  const generation = crypto.randomUUID();
  const chunks = Array.from({ length: count }, (_, i) => crypto.getRandomValues(new Uint8Array(4096 + i)));
  const objects = new Map<string, Uint8Array>();
  chunks.forEach((c, i) => objects.set(chunkKey(PREFIX, generation, i), c));
  const head = { version: 1, generation, format: 2, imageId: 'ezil-old-image', entries: count, sha256: await sha256(new Uint8Array([count])),
    chunks: await Promise.all(chunks.map(async c => ({ sha256: await sha256(c), size: c.length }))) };
  objects.set(`${PREFIX}/${SNAPSHOT_HEAD}`, new TextEncoder().encode(JSON.stringify(head)));
  const bucket = {
    objects,
    async list() { return { objects: [], truncated: false }; },
    async get(key: string) {
      const index = Number(key.split('/').at(-1));
      if (Number.isInteger(index)) await sleep(getLatency(index));
      const value = objects.get(key);
      return value ? body(value) : null;
    },
  };
  return { chunks, bucket, generation };
}

describe('system layer restore transfers', () => {
  test('every chunk write is sessionless, and transfers really overlap', async () => {
    const { chunks, bucket } = await storedLayer(12);
    const server = new FakeContainerServer(() => 20);
    const outcome = await hydrateSystemLayer({ container: server, bucket, realPrefix: REAL_PREFIX, log: () => {} });
    expect(outcome.ok).toBe(true);
    const writes = server.log.filter(o => o.kind === 'write');
    expect(writes).toHaveLength(12);
    expect(writes.every(o => o.sessionId === SESSIONLESS_TRANSFER)).toBe(true);
    expect(server.log.find(o => o.kind === 'mkdir')?.sessionId).toBe(SESSIONLESS_TRANSFER);
    expect(server.maxInFlightTransfers).toBe(SYSTEM_TRANSFER_CONCURRENCY);
    expect(server.restoreSaw!.map(b => [...b])).toEqual(chunks.map(c => [...c]));
  });

  test('a command holding the default session does not hold back the chunk writes', async () => {
    const { bucket } = await storedLayer(20);
    const server = new FakeContainerServer(() => 10);
    const boot = server.boot(400);
    let bootDone = false;
    void boot.then(() => { bootDone = true; });
    const writesDoneBeforeBoot: boolean[] = [];
    const write = server.writeFile.bind(server);
    server.writeFile = async (...args) => { const r = await write(...args); writesDoneBeforeBoot.push(!bootDone); return r; };
    const outcome = await hydrateSystemLayer({ container: server, bucket, realPrefix: REAL_PREFIX, log: () => {} });
    expect(outcome.ok).toBe(true);
    // All 20 writes (5 waves x ~15 ms) land while the 400 ms boot command still holds the session.
    expect(writesDoneBeforeBoot).toHaveLength(20);
    expect(writesDoneBeforeBoot.every(Boolean)).toBe(true);
  });

  test('out-of-order completion still restores each chunk at its own index', async () => {
    const { chunks, bucket } = await storedLayer(16, { getLatency: i => (16 - i) * 3 });
    const server = new FakeContainerServer(op => (Number(op.path?.split('/').at(-1)) % 5) * 4);
    const outcome = await hydrateSystemLayer({ container: server, bucket, realPrefix: REAL_PREFIX, log: () => {} });
    expect(outcome.ok).toBe(true);
    const order = server.log.filter(o => o.kind === 'write').map(o => Number(o.path!.split('/').at(-1)));
    expect(order).not.toEqual([...order].sort((a, b) => a - b));
    expect(server.restoreSaw!.map(b => [...b])).toEqual(chunks.map(c => [...c]));
  });

  for (const [name, breakIt] of [
    ['a corrupt chunk in R2', (s: Awaited<ReturnType<typeof storedLayer>>) => { s.bucket.objects.get(chunkKey(PREFIX, s.generation, 5))![0] ^= 0xff; }],
    ['a missing chunk in R2', (s: Awaited<ReturnType<typeof storedLayer>>) => { s.bucket.objects.delete(chunkKey(PREFIX, s.generation, 5)); }],
  ] as const) {
    test(`${name} fails the whole restore closed: nothing is restored`, async () => {
      const stored = await storedLayer(10);
      breakIt(stored);
      const server = new FakeContainerServer(() => 5);
      const outcome = await hydrateSystemLayer({ container: server, bucket: stored.bucket, realPrefix: REAL_PREFIX, log: () => {} });
      expect(outcome).toMatchObject({ ok: false, skippedReason: 'failed', restored: 0 });
      expect(server.log.some(o => o.op === 'sys-restore')).toBe(false);
      // Cleanup is the last operation: no transfer was still running after it.
      expect(server.log.at(-1)).toMatchObject({ kind: 'exec', op: 'sys-cleanup' });
    });
  }

  test('a refused chunk write fails the whole restore closed', async () => {
    const { bucket } = await storedLayer(10);
    const server = new FakeContainerServer(() => 5);
    server.failWriteIndex = 7;
    const outcome = await hydrateSystemLayer({ container: server, bucket, realPrefix: REAL_PREFIX, log: () => {} });
    expect(outcome).toMatchObject({ ok: false, skippedReason: 'failed' });
    expect(server.log.some(o => o.op === 'sys-restore')).toBe(false);
    expect(server.log.at(-1)).toMatchObject({ kind: 'exec', op: 'sys-cleanup' });
  });
});

describe('system layer checkpoint transfers', () => {
  test('every chunk read is sessionless and the committed chunks are byte-exact', async () => {
    const chunks = Array.from({ length: 9 }, (_, i) => crypto.getRandomValues(new Uint8Array(2048 + i)));
    const server = new FakeContainerServer(() => 10);
    const puts = new Map<string, Uint8Array>();
    const bucket = {
      async get() { return null; },
      async put(key: string, value: Uint8Array) { puts.set(key, value); return { etag: 'e' }; },
    };
    const hashes = await Promise.all(chunks.map(c => sha256(c)));
    server.capture = work => {
      chunks.forEach((c, i) => server.files.set(`${work}/${i}`, c));
      return { imageId: server.imageId, expectedGeneration: null, entries: 9, sha256: 'a'.repeat(64), chunks: chunks.map((c, i) => ({ size: c.length, sha256: hashes[i] })) };
    };
    const outcome = await flushSystemLayer({ container: server, bucket, realPrefix: REAL_PREFIX, log: () => {} });
    expect(outcome).toMatchObject({ ok: true, uploaded: 9, imageId: server.imageId });
    const reads = server.log.filter(o => o.kind === 'read');
    expect(reads).toHaveLength(9);
    expect(reads.every(o => o.sessionId === SESSIONLESS_TRANSFER)).toBe(true);
    expect(server.maxInFlightTransfers).toBe(SYSTEM_TRANSFER_CONCURRENCY);
    const generation = outcome.checkpoint!;
    chunks.forEach((c, i) => expect([...puts.get(chunkKey(PREFIX, generation, i))!]).toEqual([...c]));
  });
});

describe('system layer running image ID', () => {
  test('hydrate reports the receiving image, not the older snapshot image', async () => {
    const { bucket } = await storedLayer(1);
    const server = new FakeContainerServer();
    const outcome = await hydrateSystemLayer({ container: server, bucket, realPrefix: REAL_PREFIX, log: () => {} });
    expect(outcome).toMatchObject({ ok: true, imageId: server.imageId });
    expect(server.log.filter(o => o.kind === 'exec').map(o => o.op)).toEqual(['sys-restore', 'sys-cleanup']);
  });

  for (const legacy of [false, true]) {
    test(`hydrate reports the running image with ${legacy ? 'a discarded legacy snapshot' : 'no snapshot'}`, async () => {
      const { bucket } = await storedLayer(1);
      if (legacy) {
        const head = JSON.parse(new TextDecoder().decode(bucket.objects.get(`${PREFIX}/${SNAPSHOT_HEAD}`)));
        delete head.format;
        bucket.objects.set(`${PREFIX}/${SNAPSHOT_HEAD}`, new TextEncoder().encode(JSON.stringify(head)));
      } else {
        bucket.objects.clear();
      }
      const server = new FakeContainerServer();
      const outcome = await hydrateSystemLayer({ container: server, bucket, realPrefix: REAL_PREFIX, log: () => {} });
      expect(outcome).toMatchObject({ ok: true, imageId: server.imageId, skippedReason: legacy ? 'legacy_discarded' : 'no_snapshot' });
      expect(server.log.filter(o => o.kind === 'exec').map(o => o.op)).toEqual(['sys-hydrated', 'sys-cleanup']);
    });
  }

  test('unchanged flush reports the capturing image without using the old head image', async () => {
    const { bucket, generation } = await storedLayer(1);
    const server = new FakeContainerServer();
    const head = JSON.parse(new TextDecoder().decode(bucket.objects.get(`${PREFIX}/${SNAPSHOT_HEAD}`)));
    server.capture = () => ({ ...head, expectedGeneration: generation, imageId: server.imageId });
    const outcome = await flushSystemLayer({ container: server, bucket: {
      ...bucket, put: async () => { throw new Error('unchanged flush must not upload'); },
    }, realPrefix: REAL_PREFIX, log: () => {} });
    expect(outcome).toMatchObject({ ok: true, unchanged: true, imageId: server.imageId, uploaded: 0 });
    expect(server.log.filter(o => o.kind === 'exec').map(o => o.op)).toEqual(['sys-capture', 'sys-cleanup']);
  });

  test('already hydrated without a reported image remains unknown and adds no exec', async () => {
    const { bucket } = await storedLayer(1);
    const server = new FakeContainerServer();
    server.exists = async () => ({ exists: true });
    const outcome = await hydrateSystemLayer({ container: server, bucket, realPrefix: REAL_PREFIX, log: () => {} });
    expect(outcome).toMatchObject({ ok: true, skippedReason: 'already_restored' });
    expect(outcome.imageId).toBeUndefined();
    expect(server.log.filter(o => o.kind === 'exec').map(o => o.op)).toEqual(['sys-cleanup']);
  });
});

test('SESSIONLESS_TRANSFER is the installed Sandbox SDK\'s session-disabling token', () => {
  // An SDK bump that renames the token would silently route transfers into a session
  // literally named "__DISABLE_SESSION__": correct bytes, but serialized again.
  const dist = join(import.meta.dir, '..', 'node_modules', '@cloudflare', 'sandbox', 'dist');
  const source = readdirSync(dist).filter(f => f.endsWith('.js')).map(f => readFileSync(join(dist, f), 'utf8')).join('\n');
  expect(source).toContain(`const DISABLE_SESSION_TOKEN = ${JSON.stringify(SESSIONLESS_TRANSFER)};`);
  expect(source).toContain('if (explicitSessionId === DISABLE_SESSION_TOKEN) return { kind: "sessionless" };');
});
