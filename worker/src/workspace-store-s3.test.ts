import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AwsV4Signer } from 'aws4fetch';
import {
  S3WorkspaceStore,
  MigratingWorkspaceStore,
  resolveWorkspaceStore,
  normalizeEtag,
  r2AsWorkspaceStore,
  type WorkspaceStore,
  type WorkspaceListResult,
  type WorkspaceObjectBody,
  type WorkspacePutOptions,
} from './workspace-store-s3';
import {
  flushWorkspaceToR2,
  hydrateWorkspaceFromR2,
  HYDRATE_MARKER_FILENAME,
  SNAPSHOT_HEAD,
  serializeHydrateMarker,
  type FlushContainerLike,
} from './workspace-persist';

// ───────────────────────────── shared helpers ───────────────────────────────

const run = promisify(execFile);
const S3 = { bucket: 'ws-bucket', region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret/key', endpoint: 'https://s3.test.local' };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b);

/** Percent-encode an object key the way S3's `encoding-type=url` does. */
function s3UrlEncodeKey(key: string, plusLiteral = false): string {
  return key
    .split('/')
    .map((seg) =>
      Array.from(new TextEncoder().encode(seg))
        .map((b) => {
          const c = String.fromCharCode(b);
          if (/[A-Za-z0-9\-_.~]/.test(c)) return c;
          if (plusLiteral && c === '+') return '+';
          return '%' + b.toString(16).toUpperCase().padStart(2, '0');
        })
        .join(''),
    )
    .join('/');
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface FakeS3Options {
  /** Omit Content-Length on GET responses (exercises the "unknown size" refusal). */
  omitContentLength?: boolean;
  /** Return 409 ConditionalRequestConflict for a PUT whose key matches. */
  conflictOn?: (key: string) => boolean;
  /** Emit `+` literally (not `%2B`) in list XML keys (S3's form-style ambiguity). */
  plusLiteral?: boolean;
}

interface FakeS3 {
  fetchImpl: (req: Request) => Promise<Response>;
  objects: Map<string, { bytes: Uint8Array; etag: string }>;
  requests: Array<{ method: string; url: string; headers: Headers }>;
  version: number;
}

/** An in-process fake S3 HTTP endpoint with real conditional + listing semantics. */
function makeFakeS3(opts: FakeS3Options = {}): FakeS3 {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const requests: FakeS3['requests'] = [];
  const state = { version: 0 };

  const keyFromPath = (pathname: string): string => {
    // Path-style: /<bucket>/<encoded key...>
    const prefix = `/${S3.bucket}/`;
    const encoded = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname.replace(/^\//, '');
    return encoded.split('/').map(decodeURIComponent).join('/');
  };

  const fetchImpl = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    requests.push({ method: req.method, url: req.url, headers: new Headers(req.headers) });

    // ── ListObjectsV2 ────────────────────────────────────────────────────────
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const maxKeys = Number(url.searchParams.get('max-keys') ?? '1000');
      const token = url.searchParams.get('continuation-token');
      const all = [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const start = token ? Number(token) : 0;
      const slice = all.slice(start, start + maxKeys);
      const end = start + slice.length;
      const truncated = end < all.length;
      const contents = slice
        .map(
          ([k, v]) =>
            `<Contents><Key>${xmlEscape(s3UrlEncodeKey(k, opts.plusLiteral))}</Key><Size>${v.bytes.length}</Size><ETag>${xmlEscape(v.etag)}</ETag></Contents>`,
        )
        .join('');
      const next = truncated ? `<NextContinuationToken>${String(end)}</NextContinuationToken>` : '';
      const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`;
      return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
    }

    const key = keyFromPath(url.pathname);

    if (req.method === 'GET') {
      const obj = objects.get(key);
      if (!obj) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      const headers = new Headers({ etag: obj.etag });
      if (opts.omitContentLength) {
        // A streamed body carries no Content-Length.
        const stream = new ReadableStream({ start(c) { c.enqueue(obj.bytes); c.close(); } });
        return new Response(stream, { status: 200, headers });
      }
      // Real S3 always sends Content-Length; set it explicitly (a Response built
      // from bytes does not expose it via `headers.get` in this runtime).
      headers.set('content-length', String(obj.bytes.length));
      return new Response(obj.bytes, { status: 200, headers });
    }

    if (req.method === 'PUT') {
      if (opts.conflictOn?.(key)) {
        return new Response('<Error><Code>ConditionalRequestConflict</Code></Error>', { status: 409 });
      }
      const current = objects.get(key);
      const ifMatch = req.headers.get('if-match');
      const ifNoneMatch = req.headers.get('if-none-match');
      if (ifNoneMatch === '*' && current) {
        return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      }
      if (ifMatch != null && (!current || current.etag !== ifMatch)) {
        return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      }
      const bytes = typeof req.body === 'string' ? enc(req.body) : new Uint8Array(await req.arrayBuffer());
      const etag = `"${(++state.version).toString(16).padStart(8, '0')}"`;
      objects.set(key, { bytes, etag });
      return new Response(null, { status: 200, headers: { etag } });
    }

    return new Response('<Error><Code>MethodNotAllowed</Code></Error>', { status: 405 });
  };

  return { fetchImpl, objects, requests, get version() { return state.version; } } as FakeS3;
}

function makeStore(fake: FakeS3, extra: Partial<ConstructorParameters<typeof S3WorkspaceStore>[0]> = {}): S3WorkspaceStore {
  return new S3WorkspaceStore({ ...S3, fetchImpl: fake.fetchImpl, ...extra });
}

/** In-memory WorkspaceStore, standing in for the R2 binding in migration tests. */
class MemStore implements WorkspaceStore {
  objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  private version = 0;
  async get(key: string): Promise<WorkspaceObjectBody | null> {
    const v = this.objects.get(key);
    if (!v) return null;
    const buf = v.bytes.slice().buffer;
    return { etag: v.etag, size: v.bytes.length, arrayBuffer: async () => buf };
  }
  async put(key: string, value: Uint8Array | string, options?: WorkspacePutOptions) {
    const bytes = typeof value === 'string' ? enc(value) : value.slice();
    const prior = this.objects.get(key);
    const onlyIf = options?.onlyIf;
    if (onlyIf?.etagMatches != null && prior?.etag !== onlyIf.etagMatches) return null;
    if (onlyIf?.etagDoesNotMatch === '*' && prior) return null;
    const etag = String(++this.version);
    this.objects.set(key, { bytes, etag });
    return { key, etag };
  }
  async list(options: { prefix: string; cursor?: string; limit?: number }): Promise<WorkspaceListResult> {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(options.prefix)).sort();
    const start = Number(options.cursor ?? 0);
    const end = start + (options.limit ?? 1000);
    const slice = keys.slice(start, end);
    return {
      objects: slice.map((k) => ({ key: k, size: this.objects.get(k)!.bytes.length, etag: this.objects.get(k)!.etag })),
      truncated: end < keys.length,
      cursor: end < keys.length ? String(end) : undefined,
    };
  }
  snapshotKeys(): string {
    return JSON.stringify([...this.objects.entries()].map(([k, v]) => [k, v.etag]).sort());
  }
}

// Real container (filesystem + git + python) — same shape the checkpoint module
// expects, copied from workspace-persist.test.ts so the checkpoint flows run
// unchanged on the S3 store.
const roots: string[] = [];
const gitEnv = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function temp() { const root = await mkdtemp('/tmp/ezil-s3store-test-'); roots.push(root); return root; }
const container: FlushContainerLike = {
  async mkdir(path, opts) { await mkdir(path, { recursive: opts?.recursive ?? false }); },
  async writeFile(path, content, opts) { await writeFile(path, opts?.encoding === 'base64' ? Buffer.from(content, 'base64') : content); },
  async readFile(path, opts) { const bytes = await readFile(path); return { content: bytes.toString(opts?.encoding === 'base64' ? 'base64' : 'utf8'), encoding: opts?.encoding }; },
  async exists(path) { try { await lstat(path); return { exists: true }; } catch { return { exists: false }; } },
  async exec(command) {
    try { const r = await run('bash', ['-c', command], { env: gitEnv, maxBuffer: 1024 * 1024 }); return { ...r, exitCode: 0 }; }
    catch { return { exitCode: 1, stdout: '', stderr: 'snapshot helper failed' }; }
  },
};
const prefix = 'project/branches/main';
const log = () => {};
async function markedWorkspace() {
  const base = await temp();
  const root = `${base}/source`;
  await mkdir(root);
  await writeFile(`${root}/${HYDRATE_MARKER_FILENAME}`, serializeHydrateMarker({ version: 1, prefix, mountPath: root, hydratedAt: new Date().toISOString() }));
  return { base, root };
}
const flushTo = (root: string, bucket: WorkspaceStore) => flushWorkspaceToR2({ container, bucket: bucket as never, mountPath: root, realPrefix: prefix, hydrationComplete: true, manifest: {}, log });
const hydrateFrom = (root: string, bucket: WorkspaceStore) => hydrateWorkspaceFromR2({ bucket: bucket as never, container, mountPath: root, realPrefix: prefix, log });
const headKey = `${prefix}/${SNAPSHOT_HEAD}`;

// ───────────────────────────── unit: etag ───────────────────────────────────

describe('normalizeEtag', () => {
  it('strips weak markers and surrounding quotes, leaves bare hex', () => {
    expect(normalizeEtag('"abc123"')).toBe('abc123');
    expect(normalizeEtag('W/"abc123"')).toBe('abc123');
    expect(normalizeEtag('abc123')).toBe('abc123');
    expect(normalizeEtag('  "d4e"  ')).toBe('d4e');
  });
});

// ───────────────────────────── unit: S3WorkspaceStore ────────────────────────

describe('S3WorkspaceStore: get', () => {
  it('returns normalized etag + Content-Length size, 404 => null', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    expect(await store.get('a/b')).toBeNull();
    await store.put('a/b', enc('hello'));
    const got = await store.get('a/b');
    expect(got).not.toBeNull();
    expect(got!.size).toBe(5);
    expect(got!.etag).not.toContain('"');
    expect(dec(await got!.arrayBuffer())).toBe('hello');
  });

  it('throws (no body/cred leak) on a non-404 error status', async () => {
    const fake = makeFakeS3();
    fake.fetchImpl = async () => new Response('<Error><Code>AccessDenied</Code>SECRET</Error>', { status: 403 });
    const store = makeStore(fake);
    await expect(store.get('a/b')).rejects.toThrow('workspace store get failed (status 403)');
    try { await store.get('a/b'); } catch (e) { expect(String(e)).not.toContain('SECRET'); }
  });

  it('refuses an object with no Content-Length (caller cannot bound it)', async () => {
    const fake = makeFakeS3({ omitContentLength: true });
    const store = makeStore(fake);
    await store.put('k', enc('data'));
    await expect(store.get('k')).rejects.toThrow('missing content-length');
  });
});

describe('S3WorkspaceStore: put preconditions', () => {
  it('If-None-Match:* creates once, then returns null (412) — never retried', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    const first = await store.put('seed', enc('x'), { onlyIf: { etagDoesNotMatch: '*' } });
    expect(first).not.toBeNull();
    const second = await store.put('seed', enc('y'), { onlyIf: { etagDoesNotMatch: '*' } });
    expect(second).toBeNull();
    const puts = fake.requests.filter((r) => r.method === 'PUT');
    expect(puts.length).toBe(2); // the losing put was NOT retried
    expect(puts[1].headers.get('if-none-match')).toBe('*');
  });

  it('If-Match re-quotes the normalized etag; mismatch => null', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    const created = await store.put('h', enc('1'));
    const matched = await store.put('h', enc('2'), { onlyIf: { etagMatches: created!.etag } });
    expect(matched).not.toBeNull();
    const stale = await store.put('h', enc('3'), { onlyIf: { etagMatches: created!.etag } });
    expect(stale).toBeNull();
    const lastPut = fake.requests.filter((r) => r.method === 'PUT').at(-1)!;
    expect(lastPut.headers.get('if-match')).toBe(`"${created!.etag}"`);
  });

  it('If-Match against a missing key fails closed (null)', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    expect(await store.put('ghost', enc('x'), { onlyIf: { etagMatches: 'deadbeef' } })).toBeNull();
  });

  it('409 ConditionalRequestConflict also returns null (never retried)', async () => {
    const fake = makeFakeS3({ conflictOn: (k) => k === 'cas' });
    const store = makeStore(fake);
    expect(await store.put('cas', enc('x'), { onlyIf: { etagDoesNotMatch: '*' } })).toBeNull();
    expect(fake.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/cas')).length).toBe(1);
  });

  it('rejects an unsupported precondition rather than guessing', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    await expect(store.put('k', enc('x'), { onlyIf: { etagDoesNotMatch: 'not-a-star' } })).rejects.toThrow('unsupported precondition');
    await expect(store.put('k', enc('x'), { onlyIf: { etagMatches: 'a', etagDoesNotMatch: '*' } })).rejects.toThrow('unsupported precondition');
  });

  it('adds server-side-encryption headers when configured', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake, { sse: 'aws:kms', kmsKeyId: 'key-1' });
    await store.put('e', enc('x'));
    const put = fake.requests.filter((r) => r.method === 'PUT').at(-1)!;
    expect(put.headers.get('x-amz-server-side-encryption')).toBe('aws:kms');
    expect(put.headers.get('x-amz-server-side-encryption-aws-kms-key-id')).toBe('key-1');
  });
});

describe('S3WorkspaceStore: list (ListObjectsV2, encoding-type=url)', () => {
  it('parses keys, sizes, truncation and paginates by continuation-token', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    for (const k of ['p/a', 'p/b', 'p/c', 'q/x']) await store.put(k, enc(k));
    const page1 = await store.list({ prefix: 'p/', limit: 2 });
    expect(page1.objects.map((o) => o.key)).toEqual(['p/a', 'p/b']);
    expect(page1.truncated).toBe(true);
    expect(page1.cursor).toBeDefined();
    const page2 = await store.list({ prefix: 'p/', limit: 2, cursor: page1.cursor });
    expect(page2.objects.map((o) => o.key)).toEqual(['p/c']);
    expect(page2.truncated).toBe(false);
    expect(page2.cursor).toBeUndefined();
    expect(page1.objects[0].size).toBe('p/a'.length);
    expect(fake.requests.at(-1)!.url).toContain('encoding-type=url');
  });

  it('decodes keys with spaces, unicode and + round-trip', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    const keys = ['dir/a b.txt', 'dir/café/ρ.md', 'dir/c++/main.cpp'];
    for (const k of keys) await store.put(k, enc(k));
    const listed = (await store.list({ prefix: 'dir/' })).objects.map((o) => o.key).sort();
    expect(listed).toEqual([...keys].sort());
  });

  it("treats a literal '+' in listing XML as '+', not space", async () => {
    const fake = makeFakeS3({ plusLiteral: true });
    const store = makeStore(fake);
    await store.put('f/a+b', enc('x'));
    const listed = (await store.list({ prefix: 'f/' })).objects.map((o) => o.key);
    expect(listed).toEqual(['f/a+b']);
  });

  it('applies and strips a static keyPrefix', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake, { keyPrefix: 'workspaces/' });
    await store.put('proj/file', enc('x'));
    // Stored under the full prefix on the wire...
    expect([...fake.objects.keys()]).toEqual(['workspaces/proj/file']);
    // ...but callers only ever see the logical key.
    const listed = await store.list({ prefix: 'proj/' });
    expect(listed.objects.map((o) => o.key)).toEqual(['proj/file']);
    expect((await store.get('proj/file'))!.size).toBe(1);
  });
});

describe('S3WorkspaceStore: SigV4 signing', () => {
  it('signs every request (AWS4-HMAC-SHA256, x-amz-date, x-amz-content-sha256)', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    await store.put('signed/key', enc('x'));
    await store.get('signed/key');
    await store.list({ prefix: 'signed/' });
    expect(fake.requests.length).toBe(3);
    for (const r of fake.requests) {
      expect(r.headers.get('authorization') ?? '').toMatch(/^AWS4-HMAC-SHA256 /);
      expect(r.headers.get('x-amz-date')).toBeTruthy();
      expect(r.headers.get('x-amz-content-sha256')).toBeTruthy();
    }
  });

  it('GET sends Accept-Encoding: identity so Content-Length survives', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    await store.put('k', enc('x'));
    await store.get('k');
    const get = fake.requests.find((r) => r.method === 'GET')!;
    expect(get.headers.get('accept-encoding')).toBe('identity');
  });

  it("canonical request URI equals the wire path for keys with space/+/unicode", async () => {
    // The signature covers the exact path sent; a canonical-URI encoding
    // mismatch would 403 on real S3 even though the fake does not verify it.
    const key = 'dir/a b+c/ρ.txt';
    const wirePath = '/' + S3.bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
    const signer = new AwsV4Signer({
      url: `${S3.endpoint}${wirePath}`,
      method: 'GET',
      service: 's3',
      region: S3.region,
      accessKeyId: S3.accessKeyId,
      secretAccessKey: S3.secretAccessKey,
    });
    const canonical = await signer.canonicalString();
    const uriLine = canonical.split('\n')[1];
    expect(uriLine).toBe(wirePath);
  });
});

// ─────────────── checkpoint module runs UNCHANGED on the S3 store ─────────────

describe('checkpoint module on the S3 store (real git + fake S3)', () => {
  it('flush then hydrate round-trips a git workspace through S3', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    const { base, root } = await markedWorkspace();
    await run('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', '-C', root, 'init', '-b', 'main'], { env: gitEnv });
    await writeFile(`${root}/a.txt`, 'committed\n');
    await run('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', '-C', root, 'add', 'a.txt'], { env: gitEnv });
    await run('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', '-C', root, 'commit', '-m', 'c'], { env: gitEnv });
    await writeFile(`${root}/work.txt`, 'unstaged\n');
    expect((await flushTo(root, store)).ok).toBe(true);
    // The head and at least one chunk landed in S3.
    expect(fake.objects.has(headKey)).toBe(true);
    const target = `${base}/restored`;
    expect((await hydrateFrom(target, store)).ok).toBe(true);
    expect(await readFile(`${target}/a.txt`, 'utf8')).toBe('committed\n');
    expect(await readFile(`${target}/work.txt`, 'utf8')).toBe('unstaged\n');
  });

  it('rejects a competing publisher via the conditional head commit', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    const { root } = await markedWorkspace();
    await writeFile(`${root}/a`, 'a');
    expect((await flushTo(root, store)).ok).toBe(true);
    // Simulate another writer advancing the head between read and commit.
    const original = fake.fetchImpl;
    let armed = true;
    const spy: FakeS3 = { ...fake, fetchImpl: async (req) => {
      const r = await original(req);
      if (armed && req.method === 'GET' && new URL(req.url).pathname.endsWith(SNAPSHOT_HEAD)) {
        armed = false;
        fake.objects.set(headKey, { bytes: fake.objects.get(headKey)!.bytes, etag: '"deadbeef"' });
      }
      return r;
    } };
    await writeFile(`${root}/a`, 'b');
    expect((await flushTo(root, makeStore(spy))).ok).toBe(false);
  });

  it('fails closed on a corrupt chunk without writing a marker', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    const { base, root } = await markedWorkspace();
    await writeFile(`${root}/a`, 'a');
    expect((await flushTo(root, store)).ok).toBe(true);
    const chunk = [...fake.objects.keys()].find((k) => /\/\d+$/.test(k) && k.includes('.ezil-snapshots'))!;
    fake.objects.get(chunk)!.bytes[0] ^= 1;
    const target = `${base}/target`;
    expect((await hydrateFrom(target, store)).ok).toBe(false);
    expect((await container.exists(`${target}/${HYDRATE_MARKER_FILENAME}`)).exists).toBe(false);
  });

  it('imports legacy loose files written directly to S3', async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    const base = await temp();
    await store.put(`${prefix}/src/a.txt`, enc('legacy'));
    const target = `${base}/legacy`;
    expect((await hydrateFrom(target, store)).ok).toBe(true);
    expect(await readFile(`${target}/src/a.txt`, 'utf8')).toBe('legacy');
  });
});

// ───────────────────────────── migration (R2 → S3) ───────────────────────────

describe('migration: R2 committed checkpoint → S3', () => {
  it('copies the R2 checkpoint forward, flushes to S3, leaves R2 untouched', async () => {
    const fake = makeFakeS3();
    const s3 = makeStore(fake);
    const r2 = new MemStore();
    // 1. Build a committed checkpoint in R2 (pure R2 flow).
    const { base, root } = await markedWorkspace();
    await writeFile(`${root}/app.txt`, 'original R2 content\n');
    expect((await flushTo(root, r2)).ok).toBe(true);
    expect(r2.objects.has(headKey)).toBe(true);
    const r2Before = r2.snapshotKeys();

    // 2. Hydrate through the migrating store (S3 empty). Reads R2, copy-forward to S3.
    const migrate1 = new MigratingWorkspaceStore(s3, r2);
    const target = `${base}/migrated`;
    expect((await hydrateFrom(target, migrate1)).ok).toBe(true);
    expect(await readFile(`${target}/app.txt`, 'utf8')).toBe('original R2 content\n');
    expect(fake.objects.has(headKey)).toBe(true); // copy-forward populated S3

    // 3. First flush through a FRESH migrating store (routing re-probed) -> S3.
    const migrate2 = new MigratingWorkspaceStore(s3, r2);
    expect((await flushTo(target, migrate2)).ok).toBe(true);

    // 4. A later hydrate reads from S3; R2 was never written.
    const migrate3 = new MigratingWorkspaceStore(s3, r2);
    const target2 = `${base}/from-s3`;
    expect((await hydrateFrom(target2, migrate3)).ok).toBe(true);
    expect(await readFile(`${target2}/app.txt`, 'utf8')).toBe('original R2 content\n');
    expect(r2.snapshotKeys()).toBe(r2Before); // R2 untouched by the whole migration
  });

  it('composes through resolveWorkspaceStore (adapter + path-style endpoint) end to end', async () => {
    // Exercises the PRODUCTION path: resolveWorkspaceStore -> r2AsWorkspaceStore
    // -> MigratingWorkspaceStore -> S3WorkspaceStore(endpoint=path-style), not a
    // hand-built migrating store.
    const fake = makeFakeS3();
    const r2 = new MemStore();
    const { base, root } = await markedWorkspace();
    await writeFile(`${root}/app.txt`, 'prod content\n');
    expect((await flushTo(root, r2)).ok).toBe(true);
    const r2Before = r2.snapshotKeys();
    const resolve = () => {
      const res = resolveWorkspaceStore(
        {
          EZIL_WORKSPACE_STORE: 's3',
          EZIL_WORKSPACE_S3_BUCKET: S3.bucket,
          EZIL_WORKSPACE_S3_REGION: S3.region,
          EZIL_WORKSPACE_S3_ACCESS_KEY_ID: S3.accessKeyId,
          EZIL_WORKSPACE_S3_SECRET_ACCESS_KEY: S3.secretAccessKey,
          EZIL_WORKSPACE_S3_ENDPOINT: S3.endpoint,
          SANDBOX_WORKSPACE_R2_BUCKET: r2 as never,
        },
        { fetchImpl: fake.fetchImpl },
      );
      if (!res.ok || res.kind !== 's3') throw new Error('expected an s3 store');
      return res.store;
    };
    const target = `${base}/prod-migrated`;
    expect((await hydrateFrom(target, resolve())).ok).toBe(true);
    expect(await readFile(`${target}/app.txt`, 'utf8')).toBe('prod content\n');
    expect((await flushTo(target, resolve())).ok).toBe(true);
    const target2 = `${base}/prod-from-s3`;
    expect((await hydrateFrom(target2, resolve())).ok).toBe(true);
    expect(await readFile(`${target2}/app.txt`, 'utf8')).toBe('prod content\n');
    expect(r2.snapshotKeys()).toBe(r2Before);
  });

  it('migrates even after the user edits the workspace post-hydrate', async () => {
    const fake = makeFakeS3();
    const s3 = makeStore(fake);
    const r2 = new MemStore();
    const { base, root } = await markedWorkspace();
    await writeFile(`${root}/f`, 'v1');
    expect((await flushTo(root, r2)).ok).toBe(true);
    const target = `${base}/m`;
    expect((await hydrateFrom(target, new MigratingWorkspaceStore(s3, r2))).ok).toBe(true);
    await writeFile(`${target}/f`, 'v2 edited');
    expect((await flushTo(target, new MigratingWorkspaceStore(s3, r2))).ok).toBe(true);
    const target2 = `${base}/m2`;
    expect((await hydrateFrom(target2, new MigratingWorkspaceStore(s3, r2))).ok).toBe(true);
    expect(await readFile(`${target2}/f`, 'utf8')).toBe('v2 edited');
  });
});

describe('migration: R2 legacy loose files → S3', () => {
  it('imports loose R2 files, first flush writes a full S3 snapshot, R2 untouched', async () => {
    const fake = makeFakeS3();
    const s3 = makeStore(fake);
    const r2 = new MemStore();
    await r2.put(`${prefix}/src/index.ts`, enc('export const x = 1;\n'));
    await r2.put(`${prefix}/README.md`, enc('# project\n'));
    const r2Before = r2.snapshotKeys();

    const { base } = await markedWorkspace();
    const target = `${base}/legacy-migrated`;
    expect((await hydrateFrom(target, new MigratingWorkspaceStore(s3, r2))).ok).toBe(true);
    expect(await readFile(`${target}/src/index.ts`, 'utf8')).toBe('export const x = 1;\n');

    // First flush writes a fresh full snapshot to S3 (no R2 head existed).
    expect((await flushTo(target, new MigratingWorkspaceStore(s3, r2))).ok).toBe(true);
    expect(fake.objects.has(headKey)).toBe(true);

    const target2 = `${base}/from-s3`;
    expect((await hydrateFrom(target2, new MigratingWorkspaceStore(s3, r2))).ok).toBe(true);
    expect(await readFile(`${target2}/README.md`, 'utf8')).toBe('# project\n');
    expect(r2.snapshotKeys()).toBe(r2Before);
  });
});

describe('migration: read routing', () => {
  it('reads S3 once S3 holds the head, never falling back to a stale R2', async () => {
    const fake = makeFakeS3();
    const s3 = makeStore(fake);
    const r2 = new MemStore();
    // S3 already has a committed checkpoint; R2 holds DIFFERENT (stale) content.
    const { base, root } = await markedWorkspace();
    await writeFile(`${root}/f`, 'S3 version');
    expect((await flushTo(root, s3)).ok).toBe(true);
    await r2.put(`${prefix}/f`, enc('stale R2 version'));
    const target = `${base}/r`;
    expect((await hydrateFrom(target, new MigratingWorkspaceStore(s3, r2))).ok).toBe(true);
    expect(await readFile(`${target}/f`, 'utf8')).toBe('S3 version');
  });

  it('r2AsWorkspaceStore normalizes etags from the binding', async () => {
    const r2 = new MemStore();
    await r2.put('k', enc('x'));
    const adapted = r2AsWorkspaceStore({
      get: async (key) => { const o = await r2.get(key); return o ? { etag: `"${o.etag}"`, size: o.size, arrayBuffer: () => o.arrayBuffer() } : null; },
      put: async (key, v, o) => r2.put(key, v, o),
      list: async (o) => r2.list(o),
    });
    expect((await adapted.get('k'))!.etag).toBe((await r2.get('k'))!.etag); // quotes stripped
  });
});

// ───────────────────────────── selection (fail closed) ───────────────────────

describe('resolveWorkspaceStore: fail-closed selection', () => {
  const s3Env = {
    EZIL_WORKSPACE_STORE: 's3',
    EZIL_WORKSPACE_S3_BUCKET: 'b',
    EZIL_WORKSPACE_S3_REGION: 'us-east-1',
    EZIL_WORKSPACE_S3_ACCESS_KEY_ID: 'AKID',
    EZIL_WORKSPACE_S3_SECRET_ACCESS_KEY: 'sek',
  };
  const fakeR2 = () => new MemStore();

  it('unset or r2 selects the R2 binding (existing behavior)', () => {
    const r2 = fakeR2();
    for (const store of [undefined, 'r2', 'R2', ' r2 ']) {
      const res = resolveWorkspaceStore({ EZIL_WORKSPACE_STORE: store, SANDBOX_WORKSPACE_R2_BUCKET: r2 });
      expect(res.ok).toBe(true);
      expect(res.ok && res.kind).toBe('r2');
      expect(res.ok && res.kind === 'r2' && res.store).toBe(r2);
    }
  });

  it('s3 with R2 present builds a migrating store', () => {
    const res = resolveWorkspaceStore({ ...s3Env, SANDBOX_WORKSPACE_R2_BUCKET: fakeR2() });
    expect(res.ok).toBe(true);
    expect(res.ok && res.kind).toBe('s3');
    expect(res.ok && res.kind === 's3' && res.store).toBeInstanceOf(MigratingWorkspaceStore);
  });

  it('s3 without R2 builds a plain S3 store', () => {
    const res = resolveWorkspaceStore({ ...s3Env });
    expect(res.ok).toBe(true);
    expect(res.ok && res.kind === 's3' && res.store).toBeInstanceOf(S3WorkspaceStore);
  });

  it('s3 missing ANY required var fails closed (never R2)', () => {
    for (const drop of ['EZIL_WORKSPACE_S3_BUCKET', 'EZIL_WORKSPACE_S3_REGION', 'EZIL_WORKSPACE_S3_ACCESS_KEY_ID', 'EZIL_WORKSPACE_S3_SECRET_ACCESS_KEY'] as const) {
      const env: Record<string, unknown> = { ...s3Env, SANDBOX_WORKSPACE_R2_BUCKET: fakeR2() };
      delete env[drop];
      const res = resolveWorkspaceStore(env as never);
      expect(res.ok).toBe(false);
      expect(!res.ok && res.detail).toBe('workspace_store_misconfigured');
    }
  });

  it('a blank required var is treated as missing', () => {
    const res = resolveWorkspaceStore({ ...s3Env, EZIL_WORKSPACE_S3_BUCKET: '   ', SANDBOX_WORKSPACE_R2_BUCKET: fakeR2() });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.detail).toBe('workspace_store_misconfigured');
  });

  it('an unknown store value fails closed (never silently R2 or S3)', () => {
    const res = resolveWorkspaceStore({ EZIL_WORKSPACE_STORE: 'gcs', SANDBOX_WORKSPACE_R2_BUCKET: fakeR2() });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.detail).toBe('workspace_store_misconfigured');
  });

  it('an invalid SSE value fails closed', () => {
    const res = resolveWorkspaceStore({ ...s3Env, EZIL_WORKSPACE_S3_SSE: 'rot13' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.detail).toBe('workspace_store_misconfigured');
  });
});
