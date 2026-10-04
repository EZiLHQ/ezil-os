/**
 * Wiring tests for the store selection at the three index.ts entry points
 * (`hydrateWorkspace`, `runWorkspaceFlush`, and — covered indirectly — the
 * `ensureWorkspaceMount` gate). The store-level guards are unit-tested in
 * `workspace-store-s3.test.ts`; these prove the DO methods actually CALL
 * `resolveWorkspaceStore` and FAIL CLOSED, rather than silently using R2.
 *
 * Uses the same prototype-call harness as `workspace-flush-loop.test.ts`:
 * `index.ts`'s `Sandbox` (= `EzilSandboxDO`) methods run for real on a fake
 * `this`, with only the SDK's I/O surface shadowed.
 */
import { describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';

// Must be registered before `./index.ts` is imported (see route-auth.test.ts).
mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

const FLUSH_CONTEXT_KEY = 'ezil:workspaceFlushContext';
const HYDRATED_KEY = 'ezil:workspaceHydrated';
const MOUNT_PATH = '/workspace';
const PREFIX = 'proj-1/branches/main';

type AnyFn = (this: unknown, ...args: never[]) => Promise<unknown>;
async function proto(): Promise<Record<string, AnyFn>> {
  const mod = (await import('./index')) as unknown as { Sandbox: { prototype: Record<string, AnyFn> } };
  return mod.Sandbox.prototype;
}

interface FakeEnv {
  SANDBOX_WORKSPACE_R2_BUCKET?: unknown;
  [k: string]: unknown;
}

async function makeFake(env: FakeEnv, storage: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(storage));
  const r2Puts: string[] = [];
  const r2Bucket = {
    get: async () => null,
    put: async (key: string) => { r2Puts.push(key); return { key, etag: 'etag-1' }; },
    list: async () => ({ objects: [], truncated: false }),
  };
  // INHERIT from the real DO prototype so private methods
  // (withWorkspacePersistence, runWorkspaceFlush, containerIsRunning, ...) run.
  const fake = Object.assign(Object.create(await proto()), {
    ctx: {
      storage: {
        get: async (k: string) => store.get(k),
        put: async (k: string, v: unknown) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
      },
      container: { running: true },
    },
    env: { SANDBOX_WORKSPACE_R2_BUCKET: r2Bucket, ...env },
    // Container I/O surface — used only if a flush actually proceeds (the
    // positive control). A real capture returns a one-chunk snapshot.
    exec: async (command: string) => {
      if (command.startsWith('python3 ') && command.includes('"op":"capture"')) {
        const sha256 = createHash('sha256').update('hello').digest('hex');
        return { exitCode: 0, stdout: JSON.stringify({ sha256, entries: 1, chunks: [{ size: 5, sha256 }] }) };
      }
      return { exitCode: 0, stdout: '' };
    },
    exists: async () => ({ exists: false }),
    readFile: async () => ({ content: Buffer.from('hello').toString('base64'), encoding: 'base64' }),
    writeFile: async () => ({ success: true }),
    listFiles: async () => ({ files: [] }),
  });
  return { fake, r2Puts, store };
}

const S3_VARS = {
  EZIL_WORKSPACE_S3_BUCKET: 'b',
  EZIL_WORKSPACE_S3_REGION: 'us-east-1',
  EZIL_WORKSPACE_S3_ACCESS_KEY_ID: 'AKID',
  EZIL_WORKSPACE_S3_SECRET_ACCESS_KEY: 'sek',
};

describe('runWorkspaceFlush store wiring', () => {
  const flush = async (env: FakeEnv) => {
    const { fake, r2Puts } = await makeFake(env, {
      [FLUSH_CONTEXT_KEY]: { mountPath: MOUNT_PATH, prefix: PREFIX },
      [HYDRATED_KEY]: true,
    });
    const outcome = (await (await proto()).runWorkspaceFlush.call(fake, 'alarm' as never)) as { ok: boolean };
    return { outcome, r2Puts };
  };

  it('fails closed on a misconfigured s3 store and NEVER writes to R2', async () => {
    // store='s3' but no S3 vars -> misconfigured.
    const { outcome, r2Puts } = await flush({ EZIL_WORKSPACE_STORE: 's3' });
    expect(outcome.ok).toBe(false);
    expect(r2Puts).toEqual([]); // the R2 binding was never touched
  });

  it('positive control: the default r2 store does reach the R2 binding', async () => {
    const { outcome, r2Puts } = await flush({});
    expect(outcome.ok).toBe(true);
    expect(r2Puts.length).toBeGreaterThan(0); // proves the misconfig test's 0 puts is meaningful
  });
});

describe('hydrateWorkspace store wiring', () => {
  it('fails closed with workspace_store_misconfigured on a bad s3 store', async () => {
    const { fake } = await makeFake({ EZIL_WORKSPACE_STORE: 's3' });
    const result = (await (await proto()).hydrateWorkspace.call(fake, { mountPath: MOUNT_PATH, prefix: PREFIX } as never)) as { mounted: boolean; detail?: string };
    expect(result.mounted).toBe(false);
    expect(result.detail).toBe('workspace_store_misconfigured');
  });

  it('an unknown store value also fails closed', async () => {
    const { fake } = await makeFake({ EZIL_WORKSPACE_STORE: 'gcs' });
    const result = (await (await proto()).hydrateWorkspace.call(fake, { mountPath: MOUNT_PATH, prefix: PREFIX } as never)) as { mounted: boolean; detail?: string };
    expect(result.mounted).toBe(false);
    expect(result.detail).toBe('workspace_store_misconfigured');
  });

  // Positive control: a well-formed s3 env does NOT short-circuit as
  // misconfigured — it proceeds into hydration and actually REACHES the S3 store.
  // globalThis.fetch is stubbed (this test must not touch real AWS / the
  // network); the recorder proves the S3 host was contacted.
  it('positive control: a valid s3 env reaches the S3 store (no real network)', async () => {
    const hosts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      hosts.push(url.host);
      if (url.searchParams.get('list-type') === '2') {
        return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
      }
      return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    }) as typeof fetch;
    try {
      const { fake } = await makeFake({ EZIL_WORKSPACE_STORE: 's3', ...S3_VARS });
      const result = (await (await proto()).hydrateWorkspace.call(fake, { mountPath: MOUNT_PATH, prefix: PREFIX } as never)) as { mounted: boolean; detail?: string };
      expect(result.detail).not.toBe('workspace_store_misconfigured');
      expect(hosts.some((h) => h === 'b.s3.us-east-1.amazonaws.com')).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('ensureWorkspaceMount store gate', () => {
  const loadMount = async () =>
    (await import('./index')).ensureWorkspaceMount as unknown as (
      s: unknown,
      e: unknown,
      p: unknown,
    ) => Promise<{ mounted: boolean; detail?: string }>;
  const r2ish = { get: async () => null, put: async () => ({}), list: async () => ({ objects: [], truncated: false }) };
  const fakeSandbox = () => {
    const calls = { hydrate: [] as Array<{ mountPath: string; prefix: string }>, mount: 0 };
    return {
      calls,
      hydrateWorkspace: async (p: { mountPath: string; prefix: string }) => { calls.hydrate.push(p); return { mounted: true, mountPath: p.mountPath }; },
      mountBucket: async () => { calls.mount++; },
      exec: async () => ({ exitCode: 0, stdout: '' }),
    };
  };

  it('store=s3 takes the hydrate persist path, never the s3fs mount', async () => {
    const ensureWorkspaceMount = await loadMount();
    const sandbox = fakeSandbox();
    await ensureWorkspaceMount(
      sandbox as never,
      { EZIL_WORKSPACE_STORE: 's3', ...S3_VARS, SANDBOX_WORKSPACE_R2_BUCKET: r2ish } as never,
      { projectId: 'p1', branch: 'main' } as never,
    );
    expect(sandbox.calls.hydrate.length).toBe(1);
    expect(sandbox.calls.mount).toBe(0); // s3fs (PLATFORM-NOTES §1) never used
    expect(sandbox.calls.hydrate[0].prefix).toBe('/p1/branches/main');
  });

  it('store=s3 keeps SANDBOX_WORKSPACE_S3_PREFIX so migration reads the same key', async () => {
    // Guards the prefix-parity fix: a different prefix would make the migrating
    // store find no R2 data and seed over the workspace.
    const ensureWorkspaceMount = await loadMount();
    const sandbox = fakeSandbox();
    await ensureWorkspaceMount(
      sandbox as never,
      { EZIL_WORKSPACE_STORE: 's3', ...S3_VARS, SANDBOX_WORKSPACE_S3_PREFIX: '/fixed/scope', SANDBOX_WORKSPACE_R2_BUCKET: r2ish } as never,
      { projectId: 'p1', branch: 'main' } as never,
    );
    expect(sandbox.calls.hydrate[0].prefix).toBe('/fixed/scope');
  });

  it('store=s3 with NO R2 binding still takes the persist path (not s3fs, not unconfigured)', async () => {
    // Without the s3 gate this env resolves to no mount config at all
    // (workspace_bucket_not_configured) or the s3fs fallback — this proves the
    // gate routes a pure-S3 deployment to hydrate.
    const ensureWorkspaceMount = await loadMount();
    const sandbox = fakeSandbox();
    const res = await ensureWorkspaceMount(
      sandbox as never,
      { EZIL_WORKSPACE_STORE: 's3', ...S3_VARS } as never, // no R2 binding, no legacy mount vars
      { projectId: 'p1', branch: 'main' } as never,
    );
    expect(res.mounted).toBe(true);
    expect(sandbox.calls.hydrate.length).toBe(1);
    expect(sandbox.calls.mount).toBe(0);
    expect(res.detail).not.toBe('workspace_bucket_not_configured');
  });

  it('a misconfigured store fails closed and mounts nothing', async () => {
    const ensureWorkspaceMount = await loadMount();
    const sandbox = fakeSandbox();
    const res = await ensureWorkspaceMount(
      sandbox as never,
      { EZIL_WORKSPACE_STORE: 's3' } as never, // no S3 vars
      { projectId: 'p1', branch: 'main' } as never,
    );
    expect(res.mounted).toBe(false);
    expect(res.detail).toBe('workspace_store_misconfigured');
    expect(sandbox.calls.hydrate.length).toBe(0);
    expect(sandbox.calls.mount).toBe(0);
  });
});

// Every open hydrates first; on an already-hydrated container that used to run
// a ~3 s checkpoint even when one had just succeeded (production 2026-10-04).
describe('hydrateWorkspace on an already-hydrated container', () => {
  it('reuses a fresh checkpoint instead of running another, and checkpoints again once it is stale', async () => {
    const { fake, store } = await makeFake({}, {
      [FLUSH_CONTEXT_KEY]: { mountPath: MOUNT_PATH, prefix: PREFIX },
      [HYDRATED_KEY]: true,
    });
    const marker = JSON.stringify({ version: 1, prefix: PREFIX, mountPath: MOUNT_PATH, hydratedAt: new Date().toISOString() });
    const captures: string[] = [];
    const exec = (fake as { exec: (c: string) => Promise<unknown> }).exec;
    Object.assign(fake, {
      exists: async () => ({ exists: true }),                  // marker (and system manifest) present
      readFile: async (path: string) => path.endsWith('.ezil-hydrated.json')
        ? { content: marker, encoding: 'utf-8' }
        : { content: Buffer.from('hello').toString('base64'), encoding: 'base64' },
      exec: async (c: string) => { if (c.includes('"op":"capture"')) captures.push(c); return exec(c); },
      // The flush loop's scheduler (the SDK's), as no-ops.
      listSchedules: async () => [], deleteSchedules: () => undefined, schedule: async () => undefined,
    });
    const hydrate = async () => (await (await proto()).hydrateWorkspace.call(fake, { mountPath: MOUNT_PATH, prefix: PREFIX } as never)) as { mounted: boolean; detail?: string };

    expect(await hydrate()).toMatchObject({ mounted: true, detail: 'already_hydrated' });
    expect(captures.length).toBe(1);                            // no fresh checkpoint yet: one runs
    store.set('ezil:lastActivityAt', 1);
    expect(await hydrate()).toMatchObject({ mounted: true, detail: 'already_hydrated' });
    expect(captures.length).toBe(1);                            // fresh: reused
    expect(store.get('ezil:lastActivityAt')).toBeGreaterThan(1); // the open still counts as activity
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11_000;
      expect((await hydrate()).mounted).toBe(true);
    } finally {
      Date.now = realNow;
    }
    expect(captures.length).toBe(2);                            // stale: checkpoints again
  });
});

// Staging 2026-10-04 07:36Z: an image rollout replaced the container, a restart
// started the desktop on it un-hydrated, startup wrote into /workspace, and every
// open after that answered 503 `workspace_unmarked_nonempty`. A restart must
// hydrate first, and must not start a desktop over a workspace it cannot restore.
describe('restartDesktopStack hydrates before it starts a desktop', () => {
  const restart = async (fake: unknown) => (await (await proto()).restartDesktopStack.call(fake,
    'ezil.work' as never, 'guac-x' as never, 'neko' as never, 'neko' as never)) as { ok: boolean; outcome: string; error?: string };

  it('🔴 a container that cannot be hydrated (unmarked, non-empty) is refused before any desktop process is touched', async () => {
    const { fake } = await makeFake({}, { [FLUSH_CONTEXT_KEY]: { mountPath: MOUNT_PATH, prefix: PREFIX } });
    const calls: string[] = [];
    Object.assign(fake, {
      getExposedPorts: async () => [],
      exists: async () => ({ exists: true }),
      readFile: async () => { throw new Error('ENOENT'); },
      listFiles: async () => ({ files: [{ name: 'written-by-startup', type: 'file' }] }),
      listProcesses: async () => { calls.push('listProcesses'); return []; },
      startProcess: async () => { calls.push('startProcess'); return { id: 'p' }; },
      listSchedules: async () => [], deleteSchedules: () => undefined, schedule: async () => undefined,
    });
    (fake as { exists: (p: string) => Promise<{ exists: boolean }> }).exists = async (p: string) => ({ exists: !p.endsWith('.ezil-hydrated.json') });
    const report = await restart(fake);
    expect(report).toMatchObject({ ok: false, outcome: 'boot_failed' });
    expect(report.error).toContain('workspace_unmarked_nonempty');
    expect(calls).toEqual([]);
  });

  it('a hydrated container goes straight on to the desktop launcher', async () => {
    const { fake } = await makeFake({}, { [FLUSH_CONTEXT_KEY]: { mountPath: MOUNT_PATH, prefix: PREFIX }, [HYDRATED_KEY]: true });
    const marker = JSON.stringify({ version: 1, prefix: PREFIX, mountPath: MOUNT_PATH, hydratedAt: new Date().toISOString() });
    const calls: string[] = [];
    Object.assign(fake, {
      getExposedPorts: async () => [],
      exists: async () => ({ exists: true }),
      readFile: async (path: string) => path.endsWith('.ezil-hydrated.json')
        ? { content: marker, encoding: 'utf-8' } : { content: Buffer.from('hello').toString('base64'), encoding: 'base64' },
      listProcesses: async () => { calls.push('listProcesses'); throw new Error('stop here: the launcher step was reached'); },
      listSchedules: async () => [], deleteSchedules: () => undefined, schedule: async () => undefined,
    });
    await restart(fake).catch(() => undefined);
    expect(calls).toEqual(['listProcesses']);
  });
});
