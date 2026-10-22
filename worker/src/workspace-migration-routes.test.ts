import { describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, RpcStub: class {}, env: {} }));
import { hmacSha256Hex, PREVIEW_TOKEN_PAYLOAD, TOKEN_MAX_AGE_MS } from './hmac';
import { readHead, WorkspaceMigratedError, SNAPSHOT_HEAD, MIGRATING_FLAG, chunkKey } from './workspace-persist';
import { r2AsWorkspaceStore } from './workspace-store-s3';
import { exportedChunk } from './workspace-migration-export';

const NAME = 'guac-abcdef0123456789-fedcba9876543210';
const PREFIX = '22222222-2222-4222-8222-222222222222/branches/main';
const SYSTEM = '22222222-2222-4222-8222-222222222222/system';
const HEAD = `${PREFIX}/${SNAPSHOT_HEAD}`, SYS = `${SYSTEM}/${SNAPSHOT_HEAD}`, FLAG = `${PREFIX}/${MIGRATING_FLAG}`;
const SECRET = 'migration-tests-only';
const bytes = new TextEncoder().encode('hello');
const sha = createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const token = async (secret = SECRET, now = Date.now()) => `t=${now},v1=${await hmacSha256Hex(secret, PREVIEW_TOKEN_PAYLOAD(now))}`;

async function fixture(system = false) {
  const mod = await import('./index');
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const storage = new Map<string, unknown>(Object.entries({
    'ezil:workspaceHydrated': true, 'ezil:workspaceTooLarge': false, 'ezil:systemTooLarge': false,
    'ezil:workspaceFlushContext': { prefix: PREFIX, mountPath: '/workspace' },
  }));
  let revision = 0, opened = 0, chunkBuffers = 0;
  const names: string[] = [];
  const bucket = {
    get: async (key: string) => {
      const object = objects.get(key);
      if (!object) return null;
      const isChunk = /\/[0-9]+$/.test(key);
      return { etag: object.etag, size: object.bytes.length,
        ...(isChunk ? { body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(object.bytes); c.close(); } }) } : {}),
        arrayBuffer: async () => { if (isChunk) chunkBuffers++; return object.bytes.slice().buffer; } };
    },
    put: async (key: string, value: Uint8Array | string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
      if (opts?.onlyIf?.etagMatches !== undefined && objects.get(key)?.etag !== opts.onlyIf.etagMatches) return null;
      if (opts?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      const etag = `revision-${++revision}`;
      objects.set(key, { bytes: typeof value === 'string' ? new TextEncoder().encode(value) : value, etag });
      return { key, etag };
    },
    delete: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
    list: async () => ({ objects: [], truncated: false }),
  };
  const fake = Object.assign(Object.create(mod.Sandbox.prototype), {
    ctx: { storage: { get: async (key: string) => storage.get(key), put: async (key: string, value: unknown) => { storage.set(key, value); },
      delete: async (key: string) => storage.delete(key) }, container: { running: true } },
    env: { SANDBOX_WORKSPACE_R2_BUCKET: bucket },
    exec: async (command: string) => ({ exitCode: 0, stdout: command.includes('"op":"capture"')
      ? JSON.stringify({ sha256: sha, entries: 1, chunks: [{ size: 5, sha256: sha }] })
      : command.includes('"op":"sys-capture"') ? '{"skipped":"no_baseline"}' : '' }),
    exists: async () => ({ exists: false }), readFile: async () => ({ content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }),
    writeFile: async () => ({ success: true }), mkdir: async () => ({ success: true }), listFiles: async () => ({ files: [] }),
    schedule: async () => {},
  });
  expect((await fake.runWorkspaceFlush('explicit')).ok).toBe(true);
  if (system) {
    const chunks = [new TextEncoder().encode('synthetic system delta'), new TextEncoder().encode('synthetic tool state')];
    const generation = crypto.randomUUID(), chunkGeneration = crypto.randomUUID();
    await bucket.put(SYS, encode({ version: 1, generation, chunkGeneration, entries: 2,
      sha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
      chunks: chunks.map(chunk => ({ size: chunk.length, sha256: createHash('sha256').update(chunk).digest('hex') })),
      format: 2, imageId: 'test-image', replay: { apt: ['test-package'], npm: [] } }));
    for (const [index, chunk] of chunks.entries()) await bucket.put(chunkKey(SYSTEM, chunkGeneration, index), chunk);
  }
  const env = { SANDBOX_HMAC_SECRET: SECRET, Sandbox: {
    idFromName: (name: string) => { opened++; names.push(name); return name; }, get: () => fake,
  } };
  const request = async (path: string, body?: unknown, signed: string | null = 'auto', raw?: string) => {
    const method = path.startsWith('export/') ? 'GET' : 'POST';
    return mod.default.fetch(new Request(`https://worker.example/sandbox/${NAME}/migrate/${path}`, {
      method, headers: signed === null ? {} : { authorization: `Bearer ${signed === 'auto' ? await token() : signed}` },
      ...(method === 'POST' && (body !== undefined || raw !== undefined) ? { body: raw ?? JSON.stringify(body) } : {}),
    }), env as never);
  };
  const json = (key = HEAD) => JSON.parse(new TextDecoder().decode(objects.get(key)!.bytes));
  const begin = async () => { const r = await request('begin'); expect(r.status).toBe(200); return await r.json() as any; };
  const commit = (begun: any) => request('commit', { targetProvider: 'aws-ec2', expectedEtag: begun.etag, expectedSystemEtag: begun.systemEtag });
  return { objects, storage, bucket, fake, request, json, begin, commit, opened: () => opened, names, chunkBuffers: () => chunkBuffers };
}

const routes = ['begin', 'commit', 'abort', 'reopen', 'export/head', 'export/chunk/0',
  'export/system/head', 'export/system/chunk/0'];
const systemRoutes = ['export/system/head', 'export/system/chunk/0'];
async function expectError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ ok: false, error });
}

describe('system migration export', () => {
  it('exports the complete system head and streams every chunk with matching sha256', async () => {
    const f = await fixture(true), begun = await f.begin(), previous = f.json(SYS);
    expect(f.json(FLAG).systemHeadEtag).toBe(begun.systemEtag);
    expect(begun.systemEtag).not.toBe(begun.etag);
    const head = await f.request('export/system/head');
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(`"${begun.systemEtag}"`);
    expect(head.headers.get('cache-control')).toBe('no-store');
    expect(await head.json()).toEqual(previous);
    const before = [...f.objects], buffers = f.chunkBuffers(), all = createHash('sha256');
    for (const [index, expected] of previous.chunks.entries()) {
      const response = await f.request(`export/system/chunk/${index}?generation=${previous.generation}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(response.headers.get('content-length')).toBe(String(expected.size));
      expect(response.headers.get('x-ezil-chunk-sha256')).toBe(expected.sha256);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.sha256);
      all.update(bytes);
    }
    expect(all.digest('hex')).toBe(previous.sha256);
    expect(f.chunkBuffers()).toBe(buffers);
    expect([...f.objects]).toEqual(before);
  });

  it('refuses both exports before begin and after abort', async () => {
    const f = await fixture(true);
    for (const route of systemRoutes) await expectError(await f.request(route), 409, 'migration_not_started');
    await f.begin();
    expect((await f.request('export/system/head')).status).toBe(200);
    expect((await f.request('abort')).status).toBe(200);
    for (const route of systemRoutes) await expectError(await f.request(route), 409, 'migration_not_started');
  });

  it('exports the previous system head after commit without flags, then refuses after reopen', async () => {
    const f = await fixture(true), begun = await f.begin(), previous = f.json(SYS);
    expect((await f.commit(begun)).status).toBe(200);
    expect(f.json(SYS).previous).toEqual(previous);
    f.objects.delete(FLAG);
    f.objects.delete(`${SYSTEM}/${MIGRATING_FLAG}`);
    const head = await f.request('export/system/head');
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(`"${f.objects.get(SYS)!.etag}"`);
    expect(await head.json()).toEqual(previous);
    for (const [index, chunk] of previous.chunks.entries()) {
      const response = await f.request(`export/system/chunk/${index}`);
      expect(response.status).toBe(200);
      expect(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')).toBe(chunk.sha256);
    }
    expect((await f.request('reopen', { expectedMigratedEtag: f.objects.get(HEAD)!.etag })).status).toBe(200);
    expect(f.json(SYS)).toEqual(previous);
    for (const route of [...systemRoutes, 'export/head', 'export/chunk/0']) {
      await expectError(await f.request(route), 409, 'migration_not_started');
    }
  });

  it('returns no_system_snapshot when no system head exists', async () => {
    const f = await fixture();
    await expectError(await f.request('export/system/head'), 404, 'no_system_snapshot');
    const begun = await f.begin();
    expect(begun.systemEtag).toBeNull();
    for (const route of systemRoutes) await expectError(await f.request(route), 404, 'no_system_snapshot');
    expect((await f.request('export/head')).status).toBe(200);
  });

  it('returns no_system_snapshot for a workspace without a computer system prefix', async () => {
    const f = await fixture();
    f.storage.set('ezil:workspaceFlushContext', { prefix: 'legacy/branches/main', mountPath: '/workspace' });
    const reads: string[] = [];
    f.bucket.get = async key => { reads.push(key); return null; };
    await expectError(await f.request('export/system/head'), 404, 'no_system_snapshot');
    expect(reads).toEqual([]);
  });

  it('refuses out-of-range indices and malformed indices before dispatch', async () => {
    const f = await fixture(true); await f.begin();
    await expectError(await f.request('export/system/chunk/2'), 400, 'invalid_chunk_index');
    const opened = f.opened();
    for (const index of ['-1', '1.5', 'NaN', '9007199254740992', '00']) {
      await expectError(await f.request(`export/system/chunk/${index}`), 400, 'invalid_chunk_index');
    }
    expect(f.opened()).toBe(opened);
    // The shared helper independently guards callers that bypass URL parsing.
    for (const index of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1, 2]) {
      await expect(exportedChunk(f.bucket, SYSTEM, index, undefined, PREFIX)).rejects.toMatchObject({ reason: 'invalid_chunk_index', status: 400 });
    }
  });

  it('refuses the workspace generation and any other system generation', async () => {
    const f = await fixture(true), begun = await f.begin();
    for (const generation of [begun.generation, crypto.randomUUID()]) {
      await expectError(await f.request(`export/system/chunk/0?generation=${generation}`), 409, 'generation_mismatch');
    }
  });

  it('refuses missing and wrong-size system chunks', async () => {
    const f = await fixture(true); await f.begin();
    const key = chunkKey(SYSTEM, f.json(SYS).chunkGeneration, 0);
    f.objects.delete(key);
    await expectError(await f.request('export/system/chunk/0'), 409, 'chunk_unavailable');
    await f.bucket.put(key, 'bad');
    await expectError(await f.request('export/system/chunk/0'), 409, 'chunk_unavailable');
  });

  it('refuses a system head that moved since begin', async () => {
    const f = await fixture(true); await f.begin();
    await f.bucket.put(SYS, encode(f.json(SYS)));
    for (const route of systemRoutes) await expectError(await f.request(route), 409, 'head_moved');
    expect((await f.request('export/head')).status).toBe(200);
  });

  it('refuses a system snapshot first created after begin', async () => {
    const f = await fixture(); await f.begin();
    await f.bucket.put(SYS, encode(f.json()));
    await expectError(await f.request('export/system/head'), 409, 'head_moved');
  });

  it('refuses a flag that does not pin the system head', async () => {
    const f = await fixture(true); await f.begin();
    const flag = f.json(FLAG); delete flag.systemHeadEtag;
    await f.bucket.put(FLAG, encode(flag));
    for (const route of systemRoutes) await expectError(await f.request(route), 409, 'head_moved');
  });

  for (const field of ['generation', 'chunkGeneration']) it(`detects a system ${field} change during chunk storage I/O`, async () => {
    const f = await fixture(true); await f.begin();
    const get = f.bucket.get;
    f.bucket.get = async key => {
      const object = await get(key);
      if (key === chunkKey(SYSTEM, f.json(SYS).chunkGeneration, 0)) {
        await f.bucket.put(SYS, encode({ ...f.json(SYS), [field]: crypto.randomUUID() }));
        await f.bucket.put(FLAG, encode({ ...f.json(FLAG), systemHeadEtag: f.objects.get(SYS)!.etag }));
      }
      return object;
    };
    await expectError(await f.request('export/system/chunk/0'), 409, 'generation_mismatch');
  });

  it('rechecks the migration flag after reading a system chunk', async () => {
    const f = await fixture(true); await f.begin();
    const get = f.bucket.get;
    f.bucket.get = async key => {
      const object = await get(key);
      if (key === chunkKey(SYSTEM, f.json(SYS).chunkGeneration, 0)) f.objects.delete(FLAG);
      return object;
    };
    await expectError(await f.request('export/system/chunk/0'), 409, 'migration_not_started');
  });

  it('refuses legacy system markers without the previous snapshot', async () => {
    const f = await fixture(true); await f.commit(await f.begin());
    const marker = f.json(SYS); delete marker.previous;
    await f.bucket.put(SYS, encode(marker));
    for (const route of systemRoutes) await expectError(await f.request(route), 409, 'previous_head_missing');
  });

  it('refuses missing context and unavailable storage', async () => {
    const f = await fixture(true), context = f.storage.get('ezil:workspaceFlushContext');
    f.storage.delete('ezil:workspaceFlushContext');
    for (const route of systemRoutes) await expectError(await f.request(route), 409, 'no_context');
    f.storage.set('ezil:workspaceFlushContext', context);
    f.fake.selectWorkspaceStore = async () => ({ ok: false });
    for (const route of systemRoutes) await expectError(await f.request(route), 503, 'store_unavailable');
  });

  for (const source of ['head', 'flag', 'chunk']) it(`sanitizes system ${source} storage failures`, async () => {
    const f = await fixture(true); await f.begin();
    const key = source === 'head' ? SYS : source === 'flag' ? FLAG : chunkKey(SYSTEM, f.json(SYS).chunkGeneration, 0);
    const get = f.bucket.get;
    f.bucket.get = async k => { if (k === key) throw new Error('/synthetic/private/path: synthetic file contents'); return get(k); };
    await expectError(await f.request(source === 'chunk' ? systemRoutes[1] : systemRoutes[0]), 503, 'export_failed');
  });

  for (const key of [SYS, FLAG]) it(`sanitizes malformed system export ${key === SYS ? 'head' : 'flag'} data`, async () => {
    const f = await fixture(true); await f.begin();
    await f.bucket.put(key, '/synthetic/private/path: synthetic file contents');
    for (const route of systemRoutes) await expectError(await f.request(route), 503, 'export_failed');
  });
});

describe('migration route authentication', () => {
  for (const route of routes) {
    it(`${route} refuses absent, bad and expired signatures before DO dispatch`, async () => {
      const f = await fixture();
      for (const signed of [null, await token('wrong-secret'), await token(SECRET, Date.now() - TOKEN_MAX_AGE_MS - 1000)]) {
        expect((await f.request(route, {}, signed)).status).toBe(401);
      }
      expect(f.opened()).toBe(0);
    });
  }
  it('validates commit and reopen JSON before opening the DO', async () => {
    const f = await fixture();
    for (const route of ['commit', 'reopen']) for (const raw of ['null', '[]', '{', '{}']) {
      expect((await f.request(route, undefined, 'auto', raw)).status).toBe(400);
    }
    for (const body of [
      { targetProvider: 'other', expectedEtag: 'x', expectedSystemEtag: null },
      { targetProvider: 'aws-ec2', expectedEtag: '', expectedSystemEtag: null },
      { targetProvider: 'aws-ec2', expectedEtag: 'x' },
      { targetProvider: 'aws-ec2', expectedEtag: 'x', expectedSystemEtag: 42 },
      { expectedMigratedEtag: 42 }, { expectedMigratedEtag: '' }, { expectedMigratedEtag: 'x'.repeat(257) },
    ]) expect((await f.request('targetProvider' in body ? 'commit' : 'reopen', body)).status).toBe(400);
    expect(f.opened()).toBe(0);
  });
});

describe('signed migration lifecycle and guards', () => {
  for (const system of [false, true]) it(`exports, fences and reopens a workspace (system=${system})`, async () => {
    const f = await fixture(system);
    const begun = await f.begin();
    const previous = f.json(), systemPrevious = system ? f.json(SYS) : null;
    expect(begun).toEqual({ etag: f.objects.get(HEAD)!.etag, systemEtag: system ? f.objects.get(SYS)!.etag : null,
      generation: previous.generation, chunkCount: 1, totalBytes: 5, sha256: sha });
    expect(await (await f.request('export/head')).json()).toEqual(previous);
    const buffersBeforeExport = f.chunkBuffers();
    const chunk = await f.request(`export/chunk/0?generation=${begun.generation}`);
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get('content-length')).toBe('5');
    expect(chunk.headers.get('x-ezil-chunk-sha256')).toBe(previous.chunks[0].sha256);
    expect(createHash('sha256').update(Buffer.from(await chunk.arrayBuffer())).digest('hex')).toBe(previous.sha256);
    expect(f.chunkBuffers()).toBe(buffersBeforeExport);
    expect((await f.commit(begun)).status).toBe(200);
    expect(f.json().previous).toEqual(previous);
    await expect(readHead(f.bucket, PREFIX)).rejects.toBeInstanceOf(WorkspaceMigratedError);
    expect(await f.fake.runWorkspaceFlush('explicit')).toMatchObject({ ok: false, skippedReason: 'migrated' });
    // Migrated snapshots remain exportable even without the in-progress flag.
    f.objects.delete(FLAG);
    const exported = await f.request('export/head');
    expect(await exported.json()).toEqual(previous);
    expect((await f.request('export/chunk/0')).status).toBe(200);
    const expectedMigratedEtag = exported.headers.get('etag')!.replace(/^"|"$/g, '');
    await f.bucket.put(FLAG, '{}');
    if (system) await f.bucket.put(`${SYSTEM}/${MIGRATING_FLAG}`, '{}');
    expect((await f.request('reopen', { expectedMigratedEtag })).status).toBe(200);
    expect(f.json()).toEqual(previous);
    if (system) expect(f.json(SYS)).toEqual(systemPrevious);
    expect(f.objects.has(FLAG)).toBe(false);
    expect(f.objects.has(`${SYSTEM}/${MIGRATING_FLAG}`)).toBe(false);
    expect(await f.fake.runWorkspaceFlush('explicit')).toMatchObject({ ok: true });
    expect(f.names.every(name => name === NAME)).toBe(true);
  });

  it('refuses export before begin and after abort', async () => {
    const f = await fixture();
    for (const route of ['export/head', 'export/chunk/0']) expect((await f.request(route)).status).toBe(409);
    await f.begin();
    expect(f.objects.has(FLAG)).toBe(true);
    expect((await f.request('abort')).status).toBe(200);
    expect(f.objects.has(FLAG)).toBe(false);
    expect((await f.request('export/head')).status).toBe(409);
  });
  it('refuses out-of-range and malformed chunk indices', async () => {
    const f = await fixture(); await f.begin();
    for (const index of ['1', '-1', '1.5', 'NaN', '9007199254740992', '00']) {
      expect((await f.request(`export/chunk/${index}`)).status).toBe(400);
    }
  });
  it('refuses a chunk request for a different generation', async () => {
    const f = await fixture(); await f.begin();
    expect((await f.request(`export/chunk/0?generation=${crypto.randomUUID()}`)).status).toBe(409);
  });
  it('refuses a missing or wrong-size chunk', async () => {
    const f = await fixture(); await f.begin();
    const s = f.json(), key = chunkKey(PREFIX, s.chunkGeneration ?? s.generation, 0);
    f.objects.delete(key);
    expect((await f.request('export/chunk/0')).status).toBe(409);
    await f.bucket.put(key, 'bad');
    expect((await f.request('export/chunk/0')).status).toBe(409);
  });
  it('refuses an export whose head moved after begin', async () => {
    const f = await fixture(); await f.begin();
    await f.bucket.put(HEAD, encode(f.json()));
    for (const route of ['export/head', 'export/chunk/0']) expect((await f.request(route)).status).toBe(409);
  });
  it('detects a generation change while fetching a chunk', async () => {
    const f = await fixture(); await f.begin();
    const get = f.bucket.get;
    f.bucket.get = async key => {
      const result = await get(key);
      if (/\/0$/.test(key)) {
        await f.bucket.put(HEAD, encode({ ...f.json(), generation: crypto.randomUUID() }));
        await f.bucket.put(FLAG, encode({ headEtag: f.objects.get(HEAD)!.etag }));
      }
      return result;
    };
    expect((await f.request('export/chunk/0')).status).toBe(409);
  });
  it('wrong rollback etag changes neither head nor flag; ordinary heads cannot reopen', async () => {
    const f = await fixture(true);
    expect((await f.request('reopen', { expectedMigratedEtag: f.objects.get(HEAD)!.etag })).status).toBe(409);
    await f.commit(await f.begin());
    const before = [...f.objects];
    expect((await f.request('reopen', { expectedMigratedEtag: 'wrong' })).status).toBe(409);
    expect([...f.objects]).toEqual(before);
  });
  for (const key of [HEAD, SYS]) it(`rollback CAS protects ${key === HEAD ? 'workspace' : 'system'} against a racing writer`, async () => {
    const f = await fixture(true); await f.commit(await f.begin());
    const etag = f.objects.get(HEAD)!.etag;
    const put = f.bucket.put;
    f.bucket.put = async (k, value, opts) => {
      if (k === key && opts?.onlyIf?.etagMatches) f.objects.set(k, { ...f.objects.get(k)!, etag: 'racing-writer' });
      return put(k, value, opts);
    };
    expect((await f.request('reopen', { expectedMigratedEtag: etag })).status).toBe(409);
    expect(f.objects.get(key)!.etag).toBe('racing-writer');
    expect(f.json().kind).toBe('migrated');
    expect(f.objects.has(FLAG)).toBe(true);
  });
  it('a failed system restore leaves the workspace fenced and a retry completes', async () => {
    const f = await fixture(true); await f.commit(await f.begin());
    const expectedMigratedEtag = f.objects.get(HEAD)!.etag, put = f.bucket.put;
    f.bucket.put = async (key, value, opts) => { if (key === SYS) throw new Error('/secret/path'); return put(key, value, opts); };
    const failed = await f.request('reopen', { expectedMigratedEtag });
    expect(failed.status).toBe(409); expect(await failed.text()).not.toContain('/secret/path');
    expect(f.json().kind).toBe('migrated'); expect(f.objects.has(FLAG)).toBe(true);
    f.bucket.put = put;
    expect((await f.request('reopen', { expectedMigratedEtag })).status).toBe(200);
  });
  it('legacy migrated heads without previous refuse export and rollback', async () => {
    const f = await fixture(); await f.commit(await f.begin());
    const marker = f.json(); delete marker.previous;
    await f.bucket.put(HEAD, encode(marker));
    expect((await f.request('export/head')).status).toBe(409);
    expect((await f.request('reopen', { expectedMigratedEtag: f.objects.get(HEAD)!.etag })).status).toBe(409);
  });
  it('rejects inconsistent previous snapshot metadata without leaking paths', async () => {
    const f = await fixture(); await f.commit(await f.begin());
    const marker = f.json(); marker.previous.generation = crypto.randomUUID();
    await f.bucket.put(HEAD, encode(marker));
    expect((await f.request('export/head')).status).toBe(503);
    expect((await f.request('reopen', { expectedMigratedEtag: f.objects.get(HEAD)!.etag })).status).toBe(409);
  });
  it('refuses missing context, unavailable storage and missing heads', async () => {
    const f = await fixture(); await f.begin();
    const context = f.storage.get('ezil:workspaceFlushContext');
    f.storage.delete('ezil:workspaceFlushContext');
    expect((await f.request('export/head')).status).toBe(409);
    expect((await f.request('reopen', { expectedMigratedEtag: 'x' })).status).toBe(409);
    f.storage.set('ezil:workspaceFlushContext', context);
    const select = f.fake.selectWorkspaceStore;
    f.fake.selectWorkspaceStore = async () => ({ ok: false });
    expect((await f.request('export/head')).status).toBe(503);
    expect((await f.request('reopen', { expectedMigratedEtag: 'x' })).status).toBe(409);
    f.fake.selectWorkspaceStore = select;
    f.objects.delete(HEAD);
    expect((await f.request('export/head')).status).toBe(409);
    expect((await f.request('reopen', { expectedMigratedEtag: 'x' })).status).toBe(409);
  });
  it('refuses a legacy system marker before restoring the workspace', async () => {
    const f = await fixture(true); await f.commit(await f.begin());
    const marker = f.json(SYS); delete marker.previous;
    await f.bucket.put(SYS, encode(marker));
    const before = [...f.objects];
    expect((await f.request('reopen', { expectedMigratedEtag: f.objects.get(HEAD)!.etag })).status).toBe(409);
    expect([...f.objects]).toEqual(before);
  });
  it('leaves an ordinary system snapshot intact during workspace rollback', async () => {
    const f = await fixture(); await f.commit(await f.begin());
    const ordinary = f.json().previous;
    await f.bucket.put(SYS, encode(ordinary));
    const before = f.objects.get(SYS);
    expect((await f.request('reopen', { expectedMigratedEtag: f.objects.get(HEAD)!.etag })).status).toBe(200);
    expect(f.objects.get(SYS)).toEqual(before);
  });
  it('the cloudflare migration target uses the same commit fence', async () => {
    const f = await fixture(); const begun = await f.begin();
    expect((await f.request('commit', { targetProvider: 'cloudflare', expectedEtag: begun.etag, expectedSystemEtag: null })).status).toBe(200);
    expect(f.json().targetProvider).toBe('cloudflare');
  });
  it('sanitizes unexpected DO failures', async () => {
    const f = await fixture();
    f.fake.beginMigrationExport = async () => { throw new Error('/private/credentials'); };
    const response = await f.request('begin');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'migration_failed' });
  });
  it('the R2 adapter preserves streaming bytes without arrayBuffer', async () => {
    const f = await fixture();
    const s = f.json();
    const object = await r2AsWorkspaceStore(f.bucket).get(chunkKey(PREFIX, s.chunkGeneration ?? s.generation, 0));
    expect(await new Response(object!.body).text()).toBe('hello');
    expect(f.chunkBuffers()).toBe(0);
  });
});
