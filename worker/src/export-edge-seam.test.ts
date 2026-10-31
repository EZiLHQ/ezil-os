// Seam harness, lane W ↔ lane H (REVERSE-MOVE-CONTRACT §2.2-§2.4, §4.2-§4.4; r7 integration).
//
// The Worker's REAL export client (aws-origin.ts startAwsExport/readAwsExport: gw1 signing, the exact POST
// bytes and their path digest, accept-encoding identity) and its REAL import module (begin, pull, verify)
// against the host's REAL edge on a loopback socket, in front of a REAL agent on its unix socket
// (infra/host-agent/test/export_edge_seam_server.py; only the capture container is replaced, and the
// agent's real staging writes the head and chunks). Needs python3 (present on every CI runner image this
// job uses); the driver removes its own temp dir.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { readAwsExport, startAwsExport, type AwsTunnelRecord } from './aws-origin';
import { chunkKey } from './workspace-persist';
import { parseExportHead, parseExportStatus, parseImportRequest, runReverseImport, type ReverseImportDeps } from './workspace-migration-import';

const MIB = 1024 * 1024;
const SIZES = [MIB, MIB, 1000];
const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const NAME = `guac-${USER.replace(/-/g, '').slice(0, 16)}-${COMPUTER.replace(/-/g, '').slice(0, 16)}`;
const P = `${COMPUTER}/branches/main`;
const KEY = Buffer.alloc(32, 9).toString('base64');
const GEN = 6, EPOCH = 11;
const DRIVER = path.resolve(import.meta.dir, '../../infra/host-agent/test/export_edge_seam_server.py');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const record = (over: Partial<AwsTunnelRecord> = {}): AwsTunnelRecord => ({ computerId: COMPUTER, sandboxId: NAME, generation: GEN, leaseEpoch: EPOCH,
  instanceId: 'i-0abc', region: 'test-region-1', publicIp: '192.0.2.1', tunnelId: 't', dnsRecordId: 'd', hostname: 'h', controlKey: KEY,
  createdAt: 0, originVerified: false, ...over });

interface Host { child: ChildProcess; port: number; requests: string[] }
async function startHost(): Promise<Host> {
  const child = spawn('python3', ['-B', DRIVER, JSON.stringify({ key: KEY, computerId: COMPUTER, generation: GEN, leaseEpoch: EPOCH, sizes: SIZES })],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  const line = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once('line', resolve);
    child.once('exit', code => reject(new Error(`the edge driver exited (${code}) before listening`)));
  });
  return { child, port: (JSON.parse(line) as { port: number }).port, requests: [] };
}
function stopHost(host: Host | undefined) {
  if (!host) return;
  host.child.stdin?.end();
  if (host.child.exitCode === null) setTimeout(() => { if (host.child.exitCode === null) host.child.kill(); }, 2000).unref();
}
/** The Worker's fetch, aimed at the loopback edge (the tunnel's job); the request is otherwise untouched. */
const toEdge = (host: Host) => async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  expect(url.protocol).toBe('https:');
  host.requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  return fetch(`http://127.0.0.1:${host.port}${url.pathname}${url.search}`, init);
};
const now = () => Math.floor(Date.now() / 1000);

describe('seam W ↔ H: the Worker\'s export client and pull against the host\'s real edge and agent', () => {
  let host: Host;
  beforeAll(async () => { host = await startHost(); });
  afterAll(() => stopHost(host));

  it('§2.2-§2.4: the signed POST is 202 with a status the Worker parses; head, chunks and Content-Length agree', async () => {
    const moveId = crypto.randomUUID(), generation = crypto.randomUUID();
    const post = await startAwsExport(record(), 'ezil.work', moveId, generation, toEdge(host), now(), 10_000);
    expect(post.status).toBe(202);
    const posted = parseExportStatus(await post.json());
    expect(posted).toMatchObject({ state: 'ready', moveId, generation });
    // Idempotent for the same ids (§2.2); another move is export_busy.
    expect((await startAwsExport(record(), 'ezil.work', moveId, generation, toEdge(host), now(), 10_000)).status).toBe(202);
    const busy = await startAwsExport(record(), 'ezil.work', crypto.randomUUID(), generation, toEdge(host), now(), 10_000);
    expect([busy.status, await busy.json()]).toEqual([409, { ok: false, error: 'export_busy' }]);
    const status = await readAwsExport(record(), 'ezil.work', 'status', toEdge(host), now(), 6_000);
    expect(parseExportStatus(await status.json())).toMatchObject({ state: 'ready', entries: 4, skipped: 1, bytes: SIZES.reduce((a, b) => a + b) });
    const head = parseExportHead(await (await readAwsExport(record(), 'ezil.work', 'head', toEdge(host), now(), 6_000)).json(), { moveId, generation });
    expect(head).not.toBeNull();
    expect(head!.chunks.map(c => c.size)).toEqual(SIZES);
    const whole = createHash('sha256');
    for (const c of head!.chunks) {
      const r = await readAwsExport(record(), 'ezil.work', { chunk: c.i }, toEdge(host), now(), 12_000);
      expect([r.status, r.headers.get('content-length')]).toEqual([200, String(c.size)]);
      const bytes = new Uint8Array(await r.arrayBuffer());
      expect([bytes.length, sha(bytes)]).toEqual([c.size, c.sha256]);
      whole.update(bytes);
    }
    expect(whole.digest('hex')).toBe(head!.sha256);
    const beyond = await readAwsExport(record(), 'ezil.work', { chunk: SIZES.length }, toEdge(host), now(), 6_000);
    expect([beyond.status, await beyond.json()]).toEqual([400, { ok: false, error: 'bad_chunk_index' }]);
    // The gw1 binding is real: another key or another epoch is 401 at the edge.
    for (const bad of [record({ controlKey: Buffer.alloc(32, 1).toString('base64') }), record({ leaseEpoch: EPOCH + 1 })]) {
      const r = await readAwsExport(bad, 'ezil.work', 'status', toEdge(host), now(), 6_000);
      expect(r.status).toBe(401);
    }
  });
});

describe('seam W ↔ H: the Worker\'s real import (begin, pull, verify) against the host\'s real edge', () => {
  let host: Host;
  beforeAll(async () => { host = await startHost(); });
  afterAll(() => stopHost(host));

  it('begin POSTs the export, pull stores every chunk the edge streams (Content-Length and sha checked), verify passes', async () => {
    const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
    let n = 0;
    const bucket = {
      get: async (key: string) => { const o = objects.get(key); return o ? { etag: o.etag, size: o.bytes.length, arrayBuffer: async () => o.bytes.slice().buffer } : null; },
      put: async (key: string, value: Uint8Array | string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
        if (opts?.onlyIf?.etagMatches !== undefined && objects.get(key)?.etag !== opts.onlyIf.etagMatches) return null;
        if (opts?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
        const etag = `e${++n}`;
        objects.set(key, { bytes: typeof value === 'string' ? new TextEncoder().encode(value) : value.slice(), etag });
        return { key, etag };
      },
      list: async ({ prefix }: { prefix: string }) => ({ truncated: false, objects: [...objects.keys()].filter(k => k.startsWith(prefix)).sort()
        .map(key => ({ key, size: objects.get(key)!.bytes.length, etag: objects.get(key)!.etag })) }),
      delete: async (keys: string | string[]) => { for (const k of typeof keys === 'string' ? [keys] : keys) objects.delete(k); },
    };
    const kv = new Map<string, unknown>();
    const deps: ReverseImportDeps = {
      sandboxName: NAME,
      storage: {
        get: async (k: string) => structuredClone(kv.get(k)), put: async (k: string, v: unknown) => { kv.set(k, structuredClone(v)); },
        delete: async (keys: string | string[]) => { let d = 0; for (const k of typeof keys === 'string' ? [keys] : keys) if (kv.delete(k)) d++; return typeof keys === 'string' ? d > 0 : d; },
        list: async ({ prefix }: { prefix: string }) => new Map([...kv].filter(([k]) => k.startsWith(prefix)).sort()),
      } as unknown as ReverseImportDeps['storage'],
      selectStore: async () => ({ kind: 'r2', bucket: bucket as unknown as NonNullable<Awaited<ReturnType<ReverseImportDeps['selectStore']>>>['bucket'] }),
      prefixOverride: undefined, flushContext: async () => undefined, containerRunning: () => false,
      withStartQueue: op => op(), adoptImportedWorkspace: async () => {},
      host: { zone: 'ezil.work', lookup: async () => record(), fetch: toEdge(host) as never }, now: Date.now,
    };
    const moveId = crypto.randomUUID(), generation = crypto.randomUUID();
    const ids = { moveId, generation, computerId: COMPUTER };
    const run = (op: string, body: Record<string, unknown>) => runReverseImport(parseImportRequest(op, body, NAME)!, deps);
    const begin = await run('begin', { ...ids, placementGeneration: GEN, leaseEpoch: EPOCH });
    expect(begin).toMatchObject({ status: 200, body: { ok: true, headKind: 'none', export: { state: 'ready' } } });
    const first = await run('pull', { ...ids, placementGeneration: GEN, leaseEpoch: EPOCH, from: 0, count: 0 });
    expect(first.status).toBe(200);
    const head = first.body.head as { sha256: string; chunks: Array<{ size: number; sha256: string }> };
    expect(head.chunks.map(c => c.size)).toEqual(SIZES);
    const pulled = await run('pull', { ...ids, placementGeneration: GEN, leaseEpoch: EPOCH, from: 0, count: 64 });
    expect(pulled).toMatchObject({ status: 200, body: { ok: true, stored: [0, 1, 2], next: null } });
    for (const [i, c] of head.chunks.entries()) {
      const stored = objects.get(chunkKey(P, generation, i))!.bytes;
      expect([stored.length, sha(stored)]).toEqual([c.size, c.sha256]);
    }
    expect(await run('commit', { ...ids, sha256: head.sha256, chunkCount: head.chunks.length, verifyOnly: true }))
      .toEqual({ status: 200, body: { ok: true, verified: true } });
    expect(host.requests.filter(r => r.startsWith('POST'))).toHaveLength(1);
    expect(host.requests.filter(r => r.includes('/chunk/'))).toHaveLength(SIZES.length);
  });
});
