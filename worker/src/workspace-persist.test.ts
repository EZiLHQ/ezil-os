/**
 * Package-local tests for `./workspace-persist` — the hydrate/flush logic
 * that replaced `mountBucket()`'s s3fs mount. Run with `bun test`, no Workers
 * runtime or real Sandbox/R2 bucket required — exercised against in-memory
 * fakes for the container filesystem and the R2 binding, in the same style
 * as `./workspace-seed.test.ts`.
 */

import { describe, expect, it } from 'bun:test';

import {
  computeFlushPlan,
  flushWorkspaceToR2,
  FLUSH_MANIFEST_FILENAME,
  hydrateWorkspaceFromR2,
  HYDRATE_MARKER_FILENAME,
  isIgnoredDirName,
  parseFlushManifest,
  parseHydrateMarker,
  serializeFlushManifest,
  serializeHydrateMarker,
  walkWorkspaceTree,
  WORKSPACE_FLUSH_IGNORE_DIR_NAMES,
  WORKSPACE_HEARTBEAT_FILENAME,
  type FlushContainerLike,
  type FlushFileInfoLike,
  type FlushManifest,
  type FlushR2BucketLike,
  type HydrateContainerLike,
  type HydrateR2BucketLike,
  type RelFileInfo,
} from './workspace-persist';

// ── In-memory fake container filesystem ─────────────────────────────────────
//
// Models exactly the slice of the Sandbox SDK's file RPCs
// (`mkdir`/`writeFile`/`readFile`/`listFiles`/`exists`) that `workspace-persist.ts`
// depends on. A monotonic clock stands in for real wall-clock mtimes so
// "unchanged" comparisons are deterministic across test runs.

interface FakeFileEntry {
  content: string;
  encoding: 'utf-8' | 'base64';
  mtime: number;
}

class FakeContainer implements HydrateContainerLike, FlushContainerLike {
  files = new Map<string, FakeFileEntry>();
  dirs = new Set<string>(['/workspace']);
  clock = 0;
  calls = {
    listFiles: [] as string[],
    readFile: [] as string[],
    writeFile: [] as string[],
    mkdir: [] as string[],
  };

  private registerAncestorDirs(path: string): void {
    let p = path;
    for (;;) {
      const idx = p.lastIndexOf('/');
      if (idx <= 0) return;
      p = p.slice(0, idx);
      this.dirs.add(p);
    }
  }

  /** Test-setup helper: seed a file directly (bypassing writeFile's call-tracking). */
  seedFile(path: string, content: string, encoding: 'utf-8' | 'base64' = 'utf-8'): void {
    this.clock++;
    this.files.set(path, { content, encoding, mtime: this.clock });
    this.registerAncestorDirs(path);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }) {
    this.calls.mkdir.push(path);
    this.dirs.add(path);
    this.registerAncestorDirs(path);
    return { success: true, path, recursive: true, timestamp: new Date().toISOString() };
  }

  async writeFile(path: string, content: string, options?: { encoding?: string }) {
    this.calls.writeFile.push(path);
    this.clock++;
    this.files.set(path, {
      content,
      encoding: options?.encoding === 'base64' ? 'base64' : 'utf-8',
      mtime: this.clock,
    });
    this.registerAncestorDirs(path);
    return { success: true, path, timestamp: new Date().toISOString() };
  }

  async readFile(path: string, _options?: { encoding?: string }) {
    this.calls.readFile.push(path);
    const entry = this.files.get(path);
    if (!entry) throw new Error(`ENOENT: no such file ${path}`);
    return { content: entry.content, encoding: entry.encoding };
  }

  async exists(path: string) {
    return { exists: this.files.has(path) || this.dirs.has(path) };
  }

  async listFiles(path: string, _options?: { recursive?: boolean; includeHidden?: boolean }) {
    this.calls.listFiles.push(path);
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const seen = new Map<string, FlushFileInfoLike>();

    for (const [filePath, entry] of this.files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (rest.length === 0) continue;
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        const name = rest.slice(0, slash);
        if (!seen.has(name)) seen.set(name, { name, type: 'directory', size: 0, modifiedAt: '0' });
        continue;
      }
      seen.set(rest, { name: rest, type: 'file', size: entry.content.length, modifiedAt: String(entry.mtime) });
    }
    for (const dirPath of this.dirs) {
      if (dirPath === path || !dirPath.startsWith(prefix)) continue;
      const rest = dirPath.slice(prefix.length);
      if (rest.length === 0 || rest.includes('/')) continue;
      if (!seen.has(rest)) seen.set(rest, { name: rest, type: 'directory', size: 0, modifiedAt: '0' });
    }

    return { files: [...seen.values()] };
  }
}

// ── In-memory fake R2 bucket(s) ──────────────────────────────────────────────

function makeFakeHydrateBucket(objects: Record<string, string> = {}): HydrateR2BucketLike & { store: Map<string, string> } {
  const store = new Map(Object.entries(objects));
  return {
    store,
    async list({ prefix, cursor, limit }) {
      const allKeys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const startIdx = cursor ? Number(cursor) : 0;
      const page = allKeys.slice(startIdx, startIdx + (limit ?? 1000));
      const truncated = startIdx + page.length < allKeys.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? String(startIdx + page.length) : undefined,
      };
    },
    async get(key) {
      const value = store.get(key);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; } };
    },
  };
}

/**
 * `FlushR2BucketLike` declares ONLY `put()` — deliberately. There is no
 * `delete` method on this fake either, which means the fake itself is proof
 * (not just documentation) that nothing in `flushWorkspaceToR2` can call
 * `bucket.delete(...)`: if it tried, `tsc` would refuse to compile this test
 * file (the fake wouldn't satisfy `FlushR2BucketLike`, and no other bucket
 * type is accepted by `flushWorkspaceToR2`'s signature).
 */
function makeFakeFlushBucket(): FlushR2BucketLike & { puts: Array<{ key: string; value: Uint8Array }> } {
  const puts: Array<{ key: string; value: Uint8Array }> = [];
  return {
    puts,
    async put(key, value) {
      puts.push({ key, value });
      return { etag: `etag-${puts.length}` };
    },
  };
}

function noopLog(): void {
  // swallow in tests that don't assert on logging
}

function collectLogs(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

// ── Ignore list ──────────────────────────────────────────────────────────────

describe('WORKSPACE_FLUSH_IGNORE_DIR_NAMES / isIgnoredDirName', () => {
  it('contains exactly the required five names', () => {
    expect([...WORKSPACE_FLUSH_IGNORE_DIR_NAMES].sort()).toEqual(
      ['.git', '.next', '.turbo', 'dist', 'node_modules'].sort(),
    );
  });

  it('matches ignored names and rejects everything else', () => {
    for (const name of WORKSPACE_FLUSH_IGNORE_DIR_NAMES) {
      expect(isIgnoredDirName(name)).toBe(true);
    }
    expect(isIgnoredDirName('src')).toBe(false);
    expect(isIgnoredDirName('node_modules_backup')).toBe(false); // exact-name match only, not a prefix match
  });
});

// ── hydrateWorkspaceFromR2 ────────────────────────────────────────────────────

describe('hydrateWorkspaceFromR2', () => {
  it('first hydrate populates /workspace from every R2 object under the prefix', async () => {
    const bucket = makeFakeHydrateBucket({
      'proj1/branches/main/package.json': '{"name":"demo"}',
      'proj1/branches/main/src/index.ts': 'export const x = 1;',
    });
    const container = new FakeContainer();

    const outcome = await hydrateWorkspaceFromR2({
      bucket,
      container,
      realPrefix: 'proj1/branches/main',
      mountPath: '/workspace',
      log: noopLog,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.filesWritten).toBe(2);
    expect(outcome.filesFailed).toBe(0);
    expect(outcome.emptyPrefix).toBe(false);

    const pkg = await container.readFile('/workspace/package.json');
    expect(Buffer.from(pkg.content, 'base64').toString('utf-8')).toBe('{"name":"demo"}');
    const idx = await container.readFile('/workspace/src/index.ts');
    expect(Buffer.from(idx.content, 'base64').toString('utf-8')).toBe('export const x = 1;');
    // mkdir was called for the nested file's parent directory.
    expect(container.calls.mkdir).toContain('/workspace/src');
  });

  it('paginates through bucket.list() across multiple pages (truncated + cursor)', async () => {
    const objects: Record<string, string> = {};
    for (let i = 0; i < 5; i++) objects[`proj1/branches/main/file${i}.txt`] = `content-${i}`;
    const bucket = makeFakeHydrateBucket(objects);
    const container = new FakeContainer();

    const outcome = await hydrateWorkspaceFromR2({
      bucket,
      container,
      realPrefix: 'proj1/branches/main',
      mountPath: '/workspace',
      log: noopLog,
      pageSize: 2, // forces 3 pages for 5 objects
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.filesWritten).toBe(5);
    for (let i = 0; i < 5; i++) {
      const read = await container.readFile(`/workspace/file${i}.txt`);
      expect(Buffer.from(read.content, 'base64').toString('utf-8')).toBe(`content-${i}`);
    }
  });

  it('skips the seed sentinel and the heartbeat object — never writes them locally', async () => {
    const bucket = makeFakeHydrateBucket({
      'proj1/branches/main/.ezil-seeded': '{"seededAt":"2020-01-01"}',
      'proj1/branches/main/.ezil-heartbeat': '2020-01-01T00:00:00.000Z',
      'proj1/branches/main/real-file.txt': 'hello',
    });
    const container = new FakeContainer();

    const outcome = await hydrateWorkspaceFromR2({
      bucket,
      container,
      realPrefix: 'proj1/branches/main',
      mountPath: '/workspace',
      log: noopLog,
    });

    expect(outcome.filesWritten).toBe(1);
    expect(outcome.emptyPrefix).toBe(false); // the real file makes it non-empty
    expect(container.files.has('/workspace/.ezil-seeded')).toBe(false);
    expect(container.files.has('/workspace/.ezil-heartbeat')).toBe(false);
    expect(container.files.has('/workspace/real-file.txt')).toBe(true);
  });

  it('reports emptyPrefix:true and writes nothing when the prefix has no real objects', async () => {
    const bucket = makeFakeHydrateBucket({});
    const container = new FakeContainer();

    const outcome = await hydrateWorkspaceFromR2({
      bucket,
      container,
      realPrefix: 'proj1/branches/main',
      mountPath: '/workspace',
      log: noopLog,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.emptyPrefix).toBe(true);
    expect(outcome.filesWritten).toBe(0);
  });

  it('a prefix containing ONLY the sentinel/heartbeat still reports emptyPrefix:true', async () => {
    const bucket = makeFakeHydrateBucket({
      'proj1/branches/main/.ezil-seeded': '{}',
      'proj1/branches/main/.ezil-heartbeat': '2020-01-01T00:00:00.000Z',
    });
    const container = new FakeContainer();

    const outcome = await hydrateWorkspaceFromR2({
      bucket,
      container,
      realPrefix: 'proj1/branches/main',
      mountPath: '/workspace',
      log: noopLog,
    });

    expect(outcome.emptyPrefix).toBe(true);
    expect(outcome.filesWritten).toBe(0);
  });

  it('continues past a single corrupt/failing object instead of aborting the whole pass', async () => {
    const bucket = makeFakeHydrateBucket({
      'proj1/branches/main/good.txt': 'fine',
      'proj1/branches/main/bad.txt': 'also fine content, but get() will throw for this key',
    });
    const realGet = bucket.get.bind(bucket);
    bucket.get = async (key: string) => {
      if (key.endsWith('bad.txt')) throw new Error('simulated R2 get failure');
      return realGet(key);
    };
    const container = new FakeContainer();
    const { log, lines } = collectLogs();

    const outcome = await hydrateWorkspaceFromR2({
      bucket,
      container,
      realPrefix: 'proj1/branches/main',
      mountPath: '/workspace',
      log,
    });

    expect(outcome.ok).toBe(false); // filesFailed > 0
    expect(outcome.filesWritten).toBe(1);
    expect(outcome.filesFailed).toBe(1);
    expect(await container.exists('/workspace/good.txt')).toEqual({ exists: true });
    expect(lines.some((l) => l.includes('bad.txt'))).toBe(true); // failure logged loudly, not swallowed
  });

  it('SECURITY: refuses outright when given an empty realPrefix, never lists/reads the whole bucket', async () => {
    const bucket = makeFakeHydrateBucket({ 'someone-elses-project/secret.txt': 'do not touch' });
    let listCalled = false;
    bucket.list = async (...args) => {
      listCalled = true;
      return { objects: [], truncated: false };
    };
    const container = new FakeContainer();
    const { log, lines } = collectLogs();

    const outcome = await hydrateWorkspaceFromR2({
      bucket,
      container,
      realPrefix: '', // the hazard: an empty/defaulted prefix
      mountPath: '/workspace',
      log,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.listOk).toBe(false);
    expect(listCalled).toBe(false); // never even attempted bucket.list()
    expect(lines.some((l) => l.toLowerCase().includes('refus'))).toBe(true);
  });
});

// ── walkWorkspaceTree ─────────────────────────────────────────────────────────

describe('walkWorkspaceTree', () => {
  it('never descends into an ignored directory — proves the throughput property, not just after-the-fact filtering', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/src/app.ts', 'app');
    container.seedFile('/workspace/node_modules/some-pkg/index.js', 'huge tree, should never be walked');
    container.seedFile('/workspace/.git/HEAD', 'ref: refs/heads/main');
    container.seedFile('/workspace/.next/cache/x.bin', 'cache');
    container.seedFile('/workspace/dist/bundle.js', 'bundled');
    container.seedFile('/workspace/.turbo/cookies.json', '{}');

    const result = await walkWorkspaceTree(container, '/workspace');

    expect(result.files.map((f) => f.relPath).sort()).toEqual(['src/app.ts']);
    expect(result.skippedIgnoredDirs).toBe(5);
    // The critical assertion: `listFiles` was NEVER called on any path under
    // an ignored directory — the SDK never even enumerated node_modules/etc.
    for (const call of container.calls.listFiles) {
      for (const ignored of WORKSPACE_FLUSH_IGNORE_DIR_NAMES) {
        expect(call.includes(`/${ignored}/`) || call.endsWith(`/${ignored}`)).toBe(false);
      }
    }
  });

  it('excludes the reserved hydrate-marker and flush-manifest filenames', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/real.txt', 'content');
    container.seedFile(`/workspace/${HYDRATE_MARKER_FILENAME}`, '{}');
    container.seedFile(`/workspace/${FLUSH_MANIFEST_FILENAME}`, '{}');

    const result = await walkWorkspaceTree(container, '/workspace');

    expect(result.files.map((f) => f.relPath)).toEqual(['real.txt']);
  });

  it('skips symlink/other entry types (no well-defined read-and-recreate semantics)', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/real.txt', 'content');
    // Inject a synthetic symlink entry directly via listFiles override.
    const realListFiles = container.listFiles.bind(container);
    container.listFiles = async (path, opts) => {
      const base = await realListFiles(path, opts);
      if (path === '/workspace') {
        return { files: [...base.files, { name: 'link', type: 'symlink' as const, size: 0, modifiedAt: '0' }] };
      }
      return base;
    };

    const result = await walkWorkspaceTree(container, '/workspace');
    expect(result.files.map((f) => f.relPath)).toEqual(['real.txt']);
    expect(result.skippedUnsupported).toBe(1);
  });
});

// ── computeFlushPlan ──────────────────────────────────────────────────────────

describe('computeFlushPlan', () => {
  it('treats a file absent from the manifest as changed', () => {
    const files: RelFileInfo[] = [{ relPath: 'a.txt', size: 5, modifiedAt: '1' }];
    const plan = computeFlushPlan(files, {});
    expect(plan.changed).toEqual(files);
    expect(plan.unchangedCount).toBe(0);
  });

  it('treats a file with identical size+modifiedAt as unchanged', () => {
    const files: RelFileInfo[] = [{ relPath: 'a.txt', size: 5, modifiedAt: '1' }];
    const manifest: FlushManifest = { 'a.txt': { size: 5, modifiedAt: '1' } };
    const plan = computeFlushPlan(files, manifest);
    expect(plan.changed).toEqual([]);
    expect(plan.unchangedCount).toBe(1);
  });

  it('treats a size OR modifiedAt mismatch as changed', () => {
    const manifest: FlushManifest = { 'a.txt': { size: 5, modifiedAt: '1' } };
    expect(computeFlushPlan([{ relPath: 'a.txt', size: 6, modifiedAt: '1' }], manifest).changed).toHaveLength(1);
    expect(computeFlushPlan([{ relPath: 'a.txt', size: 5, modifiedAt: '2' }], manifest).changed).toHaveLength(1);
  });
});

// ── flushWorkspaceToR2 ────────────────────────────────────────────────────────

describe('flushWorkspaceToR2', () => {
  it('uploads only changed files, skipping unchanged ones per the manifest', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/unchanged.txt', 'same as last time');
    container.seedFile('/workspace/changed.txt', 'new content');
    const bucket = makeFakeFlushBucket();

    // Pre-populate a manifest as if `unchanged.txt` was already flushed with
    // its CURRENT size/mtime, and `changed.txt` was flushed with a DIFFERENT
    // (stale) size/mtime.
    const unchangedInfo = (await walkWorkspaceTree(container, '/workspace')).files.find((f) => f.relPath === 'unchanged.txt')!;
    const manifest: FlushManifest = {
      'unchanged.txt': { size: unchangedInfo.size, modifiedAt: unchangedInfo.modifiedAt },
      'changed.txt': { size: 999999, modifiedAt: '0' },
    };

    const outcome = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: 'proj1/branches/main',
      manifest,
      hydrationComplete: true,
      log: noopLog,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.uploaded).toEqual(['changed.txt']);
    expect(outcome.skippedUnchanged).toBe(1);
    // Only the changed file (plus the unconditional heartbeat) was put to R2.
    const nonHeartbeatPuts = bucket.puts.filter((p) => !p.key.endsWith(WORKSPACE_HEARTBEAT_FILENAME));
    expect(nonHeartbeatPuts.map((p) => p.key)).toEqual(['proj1/branches/main/changed.txt']);
  });

  it('an unchanged file is never re-uploaded across two consecutive flush cycles', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/stable.txt', 'never changes');
    const bucket = makeFakeFlushBucket();

    const first = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: 'proj1/branches/main',
      manifest: {},
      hydrationComplete: true,
      log: noopLog,
    });
    expect(first.uploaded).toEqual(['stable.txt']);

    const second = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: 'proj1/branches/main',
      manifest: first.manifest, // carried forward, as EzilSandboxDO does via the on-disk manifest cache
      hydrationComplete: true,
      log: noopLog,
    });

    expect(second.uploaded).toEqual([]);
    expect(second.skippedUnchanged).toBe(1);
    const fileUploadsTotal = bucket.puts.filter((p) => p.key.endsWith('stable.txt')).length;
    expect(fileUploadsTotal).toBe(1); // uploaded exactly once across both cycles
  });

  it('excludes the ignore-list directories from what gets uploaded', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/src/index.ts', 'real code');
    container.seedFile('/workspace/node_modules/pkg/index.js', 'must never be uploaded');
    container.seedFile('/workspace/.git/HEAD', 'must never be uploaded');
    const bucket = makeFakeFlushBucket();

    const outcome = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: 'proj1/branches/main',
      manifest: {},
      hydrationComplete: true,
      log: noopLog,
    });

    expect(outcome.uploaded).toEqual(['src/index.ts']);
    expect(outcome.skippedIgnored).toBeGreaterThan(0);
    expect(bucket.puts.some((p) => p.key.includes('node_modules'))).toBe(false);
    expect(bucket.puts.some((p) => p.key.includes('.git'))).toBe(false);
  });

  it('is skipped entirely when hydration is not recorded complete — touches neither the container nor R2', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/would-be-uploaded.txt', 'content');
    const bucket = makeFakeFlushBucket();

    const outcome = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: 'proj1/branches/main',
      manifest: {},
      hydrationComplete: false,
      log: noopLog,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.skippedReason).toBe('hydration_incomplete');
    expect(outcome.uploaded).toEqual([]);
    expect(outcome.heartbeatWritten).toBe(false);
    expect(bucket.puts).toEqual([]);
    expect(container.calls.listFiles).toEqual([]);
    expect(container.calls.readFile).toEqual([]);
  });

  it('SECURITY: refuses outright when given an empty realPrefix — never writes to the bucket root', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/file.txt', 'content');
    const bucket = makeFakeFlushBucket();

    const outcome = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: '', // the hazard
      manifest: {},
      hydrationComplete: true,
      log: noopLog,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.skippedReason).toBe('empty_prefix');
    expect(bucket.puts).toEqual([]); // never even attempted a put
  });

  it('NEVER DELETES: a manifest referencing files no longer present locally (partially-hydrated/cleaned disk) causes no error and no reference to those keys', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/still-here.txt', 'present');
    const bucket = makeFakeFlushBucket();

    // Simulate stale bookkeeping: the manifest remembers a file that is no
    // longer on local disk at all (e.g. this container generation only
    // finished hydrating a SUBSET of a much larger previous flush's state).
    const manifest: FlushManifest = {
      'still-here.txt': { size: 999, modifiedAt: '0' }, // stale entry -> re-uploaded (changed)
      'long-gone.txt': { size: 42, modifiedAt: '5' }, // no longer present locally at all
    };

    const outcome = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: 'proj1/branches/main',
      manifest,
      hydrationComplete: true,
      log: noopLog,
    });

    expect(outcome.ok).toBe(true);
    // `bucket` (the ENTIRE R2 surface this function is given) has no
    // `delete` method — there is structurally nothing to call to remove
    // `long-gone.txt` from R2, and this assertion proves the function never
    // even references that key: only `still-here.txt` was put.
    expect(bucket.puts.map((p) => p.key)).toEqual(
      expect.arrayContaining(['proj1/branches/main/still-here.txt']),
    );
    expect(bucket.puts.some((p) => p.key.includes('long-gone.txt'))).toBe(false);
    // The stale manifest entry is silently dropped going forward (harmless
    // cache cleanup — it never touched R2).
    expect(outcome.manifest['long-gone.txt']).toBeUndefined();
    // `bucket` has no delete-shaped method for TypeScript to even let us call —
    // this line only compiles because `FlushR2BucketLike` truly has none:
    expect(typeof (bucket as unknown as Record<string, unknown>)['delete']).toBe('undefined');
  });

  it('writes the unconditional heartbeat object every successful cycle, even when zero files changed', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/stable.txt', 'unchanging');
    const bucket = makeFakeFlushBucket();
    const info = (await walkWorkspaceTree(container, '/workspace')).files[0];
    const manifest: FlushManifest = { 'stable.txt': { size: info.size, modifiedAt: info.modifiedAt } };

    const outcome = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: 'proj1/branches/main',
      manifest,
      hydrationComplete: true,
      log: noopLog,
    });

    expect(outcome.uploaded).toEqual([]); // nothing real changed
    expect(outcome.heartbeatWritten).toBe(true);
    expect(bucket.puts.map((p) => p.key)).toEqual(['proj1/branches/main/' + WORKSPACE_HEARTBEAT_FILENAME]);
  });

  it('does not write the heartbeat when skipped for hydration-incomplete or empty-prefix', async () => {
    const container = new FakeContainer();
    const bucket = makeFakeFlushBucket();

    const incomplete = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: 'proj1/branches/main',
      manifest: {},
      hydrationComplete: false,
      log: noopLog,
    });
    expect(incomplete.heartbeatWritten).toBe(false);

    const emptyPrefix = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: '',
      manifest: {},
      hydrationComplete: true,
      log: noopLog,
    });
    expect(emptyPrefix.heartbeatWritten).toBe(false);
    expect(bucket.puts).toEqual([]);
  });

  it('binary content (base64-encoded reads) round-trips byte-for-byte through flush', async () => {
    const container = new FakeContainer();
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253, 128]);
    container.seedFile('/workspace/image.bin', Buffer.from(bytes).toString('base64'), 'base64');
    const bucket = makeFakeFlushBucket();

    const outcome = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: 'proj1/branches/main',
      manifest: {},
      hydrationComplete: true,
      log: noopLog,
    });

    expect(outcome.uploaded).toEqual(['image.bin']);
    const put = bucket.puts.find((p) => p.key.endsWith('image.bin'))!;
    expect([...put.value]).toEqual([...bytes]);
  });

  it('a per-file upload failure is reported and NOT marked as synced in the manifest (so it retries next cycle)', async () => {
    const container = new FakeContainer();
    container.seedFile('/workspace/ok.txt', 'fine');
    container.seedFile('/workspace/boom.txt', 'will fail to read');
    const realReadFile = container.readFile.bind(container);
    container.readFile = async (path, opts) => {
      if (path.endsWith('boom.txt')) throw new Error('simulated read failure');
      return realReadFile(path, opts);
    };
    const bucket = makeFakeFlushBucket();
    const { log, lines } = collectLogs();

    const outcome = await flushWorkspaceToR2({
      container,
      bucket,
      mountPath: '/workspace',
      realPrefix: 'proj1/branches/main',
      manifest: {},
      hydrationComplete: true,
      log,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.uploaded).toEqual(['ok.txt']);
    expect(outcome.failed).toEqual([{ relPath: 'boom.txt', error: 'simulated read failure' }]);
    expect(outcome.manifest['boom.txt']).toBeUndefined();
    expect(lines.some((l) => l.includes('boom.txt'))).toBe(true);
  });
});

// ── Hydrate-marker / flush-manifest (de)serialization ────────────────────────

describe('hydrate marker + flush manifest (de)serialization', () => {
  it('round-trips a hydrate marker', () => {
    const marker = { prefix: 'proj1/branches/main', mountPath: '/workspace', hydratedAt: '2020-01-01T00:00:00.000Z' };
    expect(parseHydrateMarker(serializeHydrateMarker(marker))).toEqual(marker);
  });

  it('rejects a malformed/corrupt marker rather than throwing', () => {
    expect(parseHydrateMarker('not json')).toBeNull();
    expect(parseHydrateMarker('{"prefix":"x"}')).toBeNull(); // missing required fields
  });

  it('round-trips a flush manifest', () => {
    const manifest: FlushManifest = { 'a.txt': { size: 1, modifiedAt: '1' }, 'b/c.txt': { size: 2, modifiedAt: '2' } };
    expect(parseFlushManifest(serializeFlushManifest(manifest))).toEqual(manifest);
  });

  it('degrades to an empty manifest on corrupt/malformed input rather than throwing', () => {
    expect(parseFlushManifest('not json')).toEqual({});
    expect(parseFlushManifest('[]')).toEqual({});
    expect(parseFlushManifest('{"a.txt":{"size":"not a number"}}')).toEqual({});
  });
});
