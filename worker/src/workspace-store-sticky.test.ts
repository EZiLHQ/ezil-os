/**
 * Sticky per-computer workspace store (docs/AWS-COMPUTERS.md R13, plan P4a).
 *
 * The Durable Object pins its store ('r2' | 's3') once a checkpoint commits
 * there, and from then on hydrate AND the alarm loop (which has no request
 * context) use the pin, never `EZIL_WORKSPACE_STORE`. S3 -> R2 is refused, an
 * S3-pinned computer never reads R2, and a signed store claim must match.
 *
 * Same prototype-call harness as `workspace-store-wiring.test.ts`: the real
 * `Sandbox` methods run on a fake `this`; R2 is an in-memory bucket and S3 an
 * in-memory HTTP endpoint behind a stubbed `fetch` (no network).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

const FLUSH_CONTEXT_KEY = 'ezil:workspaceFlushContext';
const HYDRATED_KEY = 'ezil:workspaceHydrated';
const PIN_KEY = 'ezil:workspaceStoreKind';
const MOUNT_PATH = '/workspace';
const PREFIX = 'proj-1/branches/main';
const HEAD = `${PREFIX}/.ezil-snapshots/latest.json`;
const S3_VARS = {
  EZIL_WORKSPACE_S3_BUCKET: 'b',
  EZIL_WORKSPACE_S3_REGION: 'us-east-1',
  EZIL_WORKSPACE_S3_ACCESS_KEY_ID: 'AKID',
  EZIL_WORKSPACE_S3_SECRET_ACCESS_KEY: 'sek',
};
const S3_HOST = 'b.s3.us-east-1.amazonaws.com';

type AnyFn = (this: unknown, ...args: never[]) => Promise<unknown>;
async function proto(): Promise<Record<string, AnyFn>> {
  const mod = (await import('./index')) as unknown as { Sandbox: { prototype: Record<string, AnyFn> } };
  return mod.Sandbox.prototype;
}

/** In-memory R2 binding with conditional puts; every call is recorded. */
function memR2() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const calls: string[] = [];
  let v = 0;
  const body = (o: { bytes: Uint8Array; etag: string }) => ({ etag: o.etag, size: o.bytes.length, arrayBuffer: async () => o.bytes.slice().buffer });
  return {
    objects, calls,
    get: async (k: string) => { calls.push(`get ${k}`); const o = objects.get(k); return o ? body(o) : null; },
    head: async (k: string) => { calls.push(`head ${k}`); const o = objects.get(k); return o ? body(o) : null; },
    put: async (k: string, value: Uint8Array | string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
      calls.push(`put ${k}`);
      const cur = objects.get(k);
      if (opts?.onlyIf?.etagDoesNotMatch === '*' && cur) return null;
      if (opts?.onlyIf?.etagMatches !== undefined && cur?.etag !== opts.onlyIf.etagMatches) return null;
      const etag = `r2-${++v}`;
      objects.set(k, { bytes: typeof value === 'string' ? new TextEncoder().encode(value) : value, etag });
      return { key: k, etag };
    },
    list: async (o: { prefix: string }) => {
      calls.push(`list ${o.prefix}`);
      return { objects: [...objects.keys()].filter((k) => k.startsWith(o.prefix)).map((key) => ({ key, size: objects.get(key)!.bytes.length, etag: objects.get(key)!.etag })), truncated: false };
    },
    delete: async (keys: string[]) => { calls.push(`delete ${keys.join(',')}`); for (const k of keys) objects.delete(k); },
  };
}

/** In-memory S3 endpoint behind `globalThis.fetch`. */
const s3 = { objects: new Map<string, { bytes: Uint8Array; etag: string }>(), requests: [] as string[], v: 0 };
const realFetch = globalThis.fetch;
beforeEach(() => {
  s3.objects.clear(); s3.requests.length = 0;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    if (url.host !== S3_HOST) throw new Error(`unexpected network: ${url.host}`);
    s3.requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...s3.objects.entries()].filter(([k]) => k.startsWith(prefix))
        .map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.bytes.length}</Size><ETag>${o.etag}</ETag></Contents>`).join('');
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, { status: 200 });
    }
    const key = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent).join('/');
    const cur = s3.objects.get(key);
    if (req.method === 'GET') {
      if (!cur) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      return new Response(cur.bytes, { status: 200, headers: { etag: cur.etag, 'content-length': String(cur.bytes.length) } });
    }
    if (req.method === 'PUT') {
      if (req.headers.get('if-none-match') === '*' && cur) return new Response('', { status: 412 });
      const ifMatch = req.headers.get('if-match');
      if (ifMatch !== null && cur?.etag !== ifMatch) return new Response('', { status: 412 });
      const etag = `"${(++s3.v).toString(16).padStart(8, '0')}"`;
      s3.objects.set(key, { bytes: new Uint8Array(await req.arrayBuffer()), etag });
      return new Response(null, { status: 200, headers: { etag } });
    }
    return new Response('', { status: 405 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

async function makeFake(env: Record<string, unknown>, storage: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(storage));
  const r2 = memR2();
  const captures: string[] = [];
  const fake = Object.assign(Object.create(await proto()), {
    ctx: {
      storage: {
        get: async (k: string) => store.get(k),
        put: async (k: string, v: unknown) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
      },
      container: { running: true },
    },
    env: { SANDBOX_WORKSPACE_R2_BUCKET: r2, ...env },
    exec: async (command: string) => {
      if (command.startsWith('python3 ') && command.includes('"op":"capture"')) {
        captures.push(command);
        const sha256 = createHash('sha256').update('hello').digest('hex');
        return { exitCode: 0, stdout: JSON.stringify({ sha256, entries: 1, chunks: [{ size: 5, sha256 }] }) };
      }
      return { exitCode: 0, stdout: '' };
    },
    exists: async () => ({ exists: false }),
    readFile: async () => ({ content: Buffer.from('hello').toString('base64'), encoding: 'base64' }),
    writeFile: async () => ({ success: true }),
    mkdir: async () => ({ success: true }),
    listFiles: async () => ({ files: [] }),
    listSchedules: async () => [], deleteSchedules: () => undefined, schedule: async () => undefined,
  });
  return { fake, store, r2, captures };
}

const flush = async (fake: unknown) =>
  (await (await proto()).runWorkspaceFlush.call(fake, 'alarm' as never)) as { ok: boolean; checkpoint?: string };
const hydrate = async (fake: unknown, expectedStore?: string) =>
  (await (await proto()).hydrateWorkspace.call(fake, { mountPath: MOUNT_PATH, prefix: `/${PREFIX}`,
    ...(expectedStore ? { expectedStore } : {}) } as never)) as { mounted: boolean; detail?: string };
const flushCtx = { [FLUSH_CONTEXT_KEY]: { mountPath: MOUNT_PATH, prefix: PREFIX }, [HYDRATED_KEY]: true };
const r2Writes = (r2: { calls: string[] }) => r2.calls.filter((c) => c.startsWith('put '));
const r2Reads = (r2: { calls: string[] }) => r2.calls.filter((c) => !c.startsWith('put '));

describe('the pin is written when a checkpoint commits', () => {
  it('legacy (unpinned) computer on R2: the first committed alarm flush pins r2', async () => {
    const { fake, store, r2 } = await makeFake({}, flushCtx);
    expect((await flush(fake)).ok).toBe(true);
    expect(r2.objects.has(HEAD)).toBe(true);
    expect(store.get(PIN_KEY)).toBe('r2');
  });

  it('legacy computer on S3 (env): the committed flush pins s3', async () => {
    const { fake, store, r2 } = await makeFake({ EZIL_WORKSPACE_STORE: 's3', ...S3_VARS }, flushCtx);
    expect((await flush(fake)).ok).toBe(true);
    expect(s3.objects.has(HEAD)).toBe(true);
    expect(r2Writes(r2)).toEqual([]);
    expect(store.get(PIN_KEY)).toBe('s3');
  });

  it('an R2 hydrate that mounts pins r2 even when its checkpoint cannot commit (oversized)', async () => {
    const { fake, store } = await makeFake({}, {});
    const marker = JSON.stringify({ version: 1, prefix: PREFIX, mountPath: MOUNT_PATH, hydratedAt: new Date().toISOString() });
    Object.assign(fake, {
      exists: async () => ({ exists: true }),
      readFile: async (path: string) => path.endsWith('.ezil-hydrated.json')
        ? { content: marker, encoding: 'utf-8' } : { content: Buffer.from('hello').toString('base64'), encoding: 'base64' },
      exec: async (c: string) => (c.includes('"op":"capture"') ? { exitCode: 3, stdout: '' } : { exitCode: 0, stdout: '' }),
    });
    store.set(FLUSH_CONTEXT_KEY, { mountPath: MOUNT_PATH, prefix: PREFIX });
    store.set(HYDRATED_KEY, true);
    expect(await hydrate(fake)).toMatchObject({ mounted: true, detail: 'workspace_too_large_unsaved' });
    expect(store.get(PIN_KEY)).toBe('r2');
  });

  it('an S3 hydrate whose checkpoint cannot commit pins nothing (its head is not in S3 yet)', async () => {
    const { fake, store } = await makeFake({ EZIL_WORKSPACE_STORE: 's3', ...S3_VARS }, {});
    const marker = JSON.stringify({ version: 1, prefix: PREFIX, mountPath: MOUNT_PATH, hydratedAt: new Date().toISOString() });
    Object.assign(fake, {
      exists: async () => ({ exists: true }),
      readFile: async (path: string) => path.endsWith('.ezil-hydrated.json')
        ? { content: marker, encoding: 'utf-8' } : { content: Buffer.from('hello').toString('base64'), encoding: 'base64' },
      exec: async (c: string) => (c.includes('"op":"capture"') ? { exitCode: 3, stdout: '' } : { exitCode: 0, stdout: '' }),
    });
    store.set(FLUSH_CONTEXT_KEY, { mountPath: MOUNT_PATH, prefix: PREFIX });
    store.set(HYDRATED_KEY, true);
    expect(await hydrate(fake)).toMatchObject({ mounted: true, detail: 'workspace_too_large_unsaved' });
    expect(store.has(PIN_KEY)).toBe(false);
  });

  it('a failed flush pins nothing', async () => {
    const { fake, store } = await makeFake({ EZIL_WORKSPACE_STORE: 's3', ...S3_VARS }, flushCtx);
    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect((await flush(fake)).ok).toBe(false);
    expect(store.has(PIN_KEY)).toBe(false);
  });
});

describe('the alarm loop uses the pin, never env', () => {
  it('pinned r2 + env flipped to s3: flushes to R2 and never contacts S3', async () => {
    const { fake, store, r2 } = await makeFake({ EZIL_WORKSPACE_STORE: 's3', ...S3_VARS }, { ...flushCtx, [PIN_KEY]: 'r2' });
    expect((await flush(fake)).ok).toBe(true);
    expect(r2.objects.has(HEAD)).toBe(true);
    expect(s3.requests).toEqual([]);
    expect(store.get(PIN_KEY)).toBe('r2');
  });

  it('pinned s3 + env back to r2: flushes to S3 and never touches R2 (no downgrade)', async () => {
    const { fake, store, r2 } = await makeFake({ ...S3_VARS }, { ...flushCtx, [PIN_KEY]: 's3' });
    expect((await flush(fake)).ok).toBe(true);
    expect(s3.objects.has(HEAD)).toBe(true);
    expect(r2.calls).toEqual([]);
    expect(store.get(PIN_KEY)).toBe('s3');
  });

  it('pinned s3 without S3 credentials fails closed, and still never falls back to R2', async () => {
    const { fake, r2 } = await makeFake({}, { ...flushCtx, [PIN_KEY]: 's3' });
    expect((await flush(fake)).ok).toBe(false);
    expect(r2.calls).toEqual([]);
  });

  it('an unreadable pin fails closed for flush and hydrate', async () => {
    const { fake, r2 } = await makeFake({}, { ...flushCtx, [PIN_KEY]: 'gcs' });
    expect((await flush(fake)).ok).toBe(false);
    expect(await hydrate(fake)).toEqual({ mounted: false, detail: 'workspace_store_pin_invalid' });
    expect(r2.calls).toEqual([]);
  });
});

describe('hydrate: an S3-headed computer never reads R2', () => {
  it('pinned s3 with the S3 head missing is refused, even though R2 holds a head', async () => {
    const { fake, r2, captures } = await makeFake({ ...S3_VARS }, { [PIN_KEY]: 's3' });
    await r2.put(HEAD, '{"stale":"r2 head"}');
    r2.calls.length = 0;
    expect(await hydrate(fake)).toEqual({ mounted: false, detail: 'workspace_store_head_missing' });
    expect(r2.calls).toEqual([]);
    expect(captures).toEqual([]);
  });

  it('env s3 without a pin keeps the migrating read-through (today\'s behaviour)', async () => {
    // Positive control for the rule above: the unpinned path still consults R2.
    const { fake, r2 } = await makeFake({ EZIL_WORKSPACE_STORE: 's3', ...S3_VARS });
    await hydrate(fake);
    expect(r2Reads(r2).length).toBeGreaterThan(0);
  });
});

describe('a signed store claim must match the computer\'s store', () => {
  it('pinned s3, claim r2: refused as a downgrade, nothing read', async () => {
    const { fake, r2 } = await makeFake({ ...S3_VARS }, { [PIN_KEY]: 's3' });
    expect(await hydrate(fake, 'r2')).toEqual({ mounted: false, detail: 'workspace_store_downgrade_refused' });
    expect(r2.calls).toEqual([]);
    expect(s3.requests).toEqual([]);
  });

  it('pinned r2, claim s3: refused', async () => {
    const { fake, r2, store } = await makeFake({ EZIL_WORKSPACE_STORE: 's3', ...S3_VARS }, { [PIN_KEY]: 'r2' });
    expect(await hydrate(fake, 's3')).toEqual({ mounted: false, detail: 'workspace_store_claim_mismatch' });
    expect(r2.calls).toEqual([]);
    expect(s3.requests).toEqual([]);
    expect(store.get(PIN_KEY)).toBe('r2');
  });

  it('unpinned: the claim must match the env choice', async () => {
    const { fake, r2 } = await makeFake({}, {});
    expect(await hydrate(fake, 's3')).toEqual({ mounted: false, detail: 'workspace_store_claim_mismatch' });
    expect(r2.calls).toEqual([]);
  });

  it('an unknown claim value is refused', async () => {
    const { fake, r2 } = await makeFake({}, { [PIN_KEY]: 'r2' });
    expect(await hydrate(fake, 'gcs')).toEqual({ mounted: false, detail: 'workspace_store_claim_mismatch' });
    expect(r2.calls).toEqual([]);
  });

  it('a matching claim proceeds (positive control)', async () => {
    const { fake, r2 } = await makeFake({}, { [PIN_KEY]: 'r2' });
    const res = await hydrate(fake, 'r2');
    expect(res.detail).not.toMatch(/workspace_store_/);
    expect(r2.calls.length).toBeGreaterThan(0);
  });
});

describe('ensureWorkspaceMount: a store claim cannot be honoured by the s3fs fallback', () => {
  const s3fsEnv = {
    SANDBOX_WORKSPACE_S3_ENDPOINT: 'http://127.0.0.1:9', SANDBOX_WORKSPACE_S3_BUCKET: 'b',
    SANDBOX_WORKSPACE_S3_ACCESS_KEY_ID: 'k', SANDBOX_WORKSPACE_S3_SECRET_ACCESS_KEY: 's',
  };
  const sandbox = () => {
    const calls = { mount: 0, hydrate: 0 };
    return { calls, mountBucket: async () => { calls.mount++; }, hydrateWorkspace: async () => { calls.hydrate++; return { mounted: true }; },
      exec: async () => ({ exitCode: 0, stdout: '' }) };
  };
  const mount = async () => (await import('./index')).ensureWorkspaceMount as unknown as
    (s: unknown, e: unknown, p: unknown, o?: unknown) => Promise<{ mounted: boolean; detail?: string }>;

  it('refuses a claimed store instead of mounting something else', async () => {
    const sb = sandbox();
    const res = await (await mount())(sb, s3fsEnv, { projectId: 'p1', branch: 'main' }, { expectedStore: 's3' });
    expect(res).toEqual({ mounted: false, detail: 'workspace_store_claim_mismatch' });
    expect(sb.calls.mount).toBe(0);
  });

  it('positive control: without a claim the local-dev s3fs mount is unchanged', async () => {
    const sb = sandbox();
    await (await mount())(sb, s3fsEnv, { projectId: 'p1', branch: 'main' });
    expect(sb.calls.mount).toBeGreaterThan(0);
  });
});
