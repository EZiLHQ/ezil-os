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
  // misconfigured — it proceeds into hydration (which then fails on this bare
  // fake's I/O, a DIFFERENT detail, proving we got past the selection guard).
  it('positive control: a valid s3 env passes the selection guard', async () => {
    const { fake } = await makeFake({ EZIL_WORKSPACE_STORE: 's3', ...S3_VARS });
    const result = (await (await proto()).hydrateWorkspace.call(fake, { mountPath: MOUNT_PATH, prefix: PREFIX } as never)) as { mounted: boolean; detail?: string };
    expect(result.detail).not.toBe('workspace_store_misconfigured');
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
