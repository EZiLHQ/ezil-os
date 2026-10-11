/**
 * The persistence signal inside the real Durable Object methods
 * (docs/PERSISTENCE-SIGNAL-CONTRACT.md), plus B2 — the failed-capture
 * backoff — and the signed `GET /sandbox/:name/persistence` route.
 *
 * Same harness discipline as `workspace-flush-loop.test.ts`: the fake inherits
 * from `EzilSandboxDO.prototype`, only the SDK's I/O is shadowed, so every
 * method this package wrote runs for real.
 */
import { describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));
import { hmacSha256Hex, PREVIEW_TOKEN_PAYLOAD } from './hmac';
import { emptyTrackerState, observe, PERSISTENCE_HEARTBEAT_MS, type PersistenceObservation } from './persistence-telemetry';
import { SYSTEM_MANIFEST_PATH } from './system-persist';

const HYDRATED_KEY = 'ezil:workspaceHydrated';
const FLUSH_CONTEXT_KEY = 'ezil:workspaceFlushContext';
const LAST_ACTIVITY_AT_KEY = 'ezil:lastActivityAt';
const BACKOFF_AT_KEY = 'ezil:systemFlushBackoffAt';
const COMPUTER_ID_KEY = 'ezil:persistenceComputerId';
const TRACKER_KEY = 'ezil:persistenceTracker';
const COMPUTER = '3f6f1c2e-9a1b-4c3d-8e5f-0123456789ab';
const PREFIX = `${COMPUTER}/branches/main`;
const IDLE_STOP_MS = 10 * 60_000;

type SysCapture = 'too_large' | 'stale' | 'not_restored' | 'ok' | 'unchanged';
interface Opts {
  sysCapture?: SysCapture;
  systemPutThrows?: boolean;
  stopThrows?: boolean;
  telemetryPutThrows?: boolean;
  telemetryPutGate?: Promise<void>;
  trackerPutGate?: Promise<void>;
  systemReadThrows?: boolean;
  backoffDeleteThrows?: boolean;
  noTelemetryBucket?: boolean;
  storage?: Record<string, unknown>;
}
interface Spooled { key: string; events: Array<Record<string, unknown>> }

type AnyFn = (this: unknown, ...args: never[]) => Promise<unknown>;
async function proto(): Promise<Record<string, AnyFn>> {
  return ((await import('./index')) as unknown as { Sandbox: { prototype: Record<string, AnyFn> } }).Sandbox.prototype;
}

async function makeFake(opts: Opts = {}) {
  const store = new Map<string, unknown>(Object.entries(opts.storage ?? {}));
  const calls = { stops: 0, sysCaptures: 0, scheduled: 0, trackerPuts: 0, io: [] as string[] };
  const spooled: Spooled[] = [];
  const background: Promise<unknown>[] = [];
  const files = new Map<string, string>();
  const sha256 = createHash('sha256').update('hello').digest('hex');
  const generation = '11111111-2222-4333-8444-555555555555';
  const env: Record<string, unknown> = {
    SANDBOX_WORKSPACE_R2_BUCKET: {
      get: async (key: string) => {
        if (!key.startsWith(`${COMPUTER}/system/`)) return null;
        if (opts.systemReadThrows) throw new Error('system R2 unavailable');
        if (opts.sysCapture !== 'unchanged') return null;
        const body = new TextEncoder().encode(JSON.stringify({ version: 1, generation, sha256,
          entries: 0, chunks: [{ size: 5, sha256 }] }));
        return { etag: 'e', size: body.length, arrayBuffer: async () => body.buffer };
      },
      put: async (key: string) => {
        calls.io.push(`r2:${key}`);
        if (opts.systemPutThrows && key.startsWith(`${COMPUTER}/system/`)) throw new Error('system R2 unavailable');
        return { etag: 'e' };
      },
      list: async () => ({ objects: [], truncated: false }), delete: async () => undefined,
    },
  };
  if (!opts.noTelemetryBucket) {
    env.TELEMETRY_R2_BUCKET = {
      put: async (key: string, body: string) => {
        const batch = body.split('\n').map((l) => JSON.parse(l));
        calls.io.push(...batch.map((e) => `telemetry:${e.site}`));
        if (opts.telemetryPutGate) await opts.telemetryPutGate;
        if (opts.telemetryPutThrows) throw new Error('r2 down');
        spooled.push({ key, events: batch });
      },
    };
  }
  const fake = Object.assign(Object.create(await proto()) as object, {
    ctx: {
      storage: {
        get: async (key: string | string[]) => {
          calls.io.push(`get:${key}`);
          return Array.isArray(key) ? new Map(key.filter((k) => store.has(k)).map((k) => [k, store.get(k)])) : store.get(key);
        },
        put: async (key: string, value: unknown) => {
          calls.io.push(`put:${key}`);
          if (key === TRACKER_KEY) {
            calls.trackerPuts++;
            if (opts.trackerPutGate) await opts.trackerPutGate;
          }
          store.set(key, value);
        },
        delete: async (key: string) => {
          calls.io.push(`delete:${key}`);
          if (key === BACKOFF_AT_KEY && opts.backoffDeleteThrows) throw new Error('storage unavailable');
          return store.delete(key);
        },
      },
      container: { running: true },
      waitUntil: (promise: Promise<unknown>) => { background.push(promise); },
    },
    env,
    listSchedules: async () => [],
    deleteSchedules: () => undefined,
    schedule: async () => void calls.scheduled++,
    stop: async () => {
      calls.io.push('stop');
      calls.stops++;
      if (opts.stopThrows) throw new Error('stop failed');
    },
    destroy: async () => undefined,
    exec: async (command: string) => {
      if (command.startsWith('bash /usr/local/bin/editor-state.sh capture ')) return { exitCode: 0, stdout: '' };
      if (command.startsWith('python3 ')) {
        if (command.includes('"op":"sys-capture"')) {
          calls.sysCaptures++;
          if (opts.sysCapture === 'too_large') return { exitCode: 3, stdout: '', stderr: 'system snapshot too large' };
          if (opts.sysCapture === 'stale') return { exitCode: 0, stdout: JSON.stringify({ expectedGeneration: 'other-writer' }) };
          if (opts.sysCapture === 'not_restored') return { exitCode: 0, stdout: JSON.stringify({ skipped: 'not_restored' }) };
          if (opts.sysCapture === 'ok' || opts.sysCapture === 'unchanged') return { exitCode: 0,
            stdout: JSON.stringify({ sha256, entries: 0, chunks: [{ size: 5, sha256 }],
              ...(opts.sysCapture === 'unchanged' ? { expectedGeneration: generation } : {}) }) };
          return { exitCode: 0, stdout: JSON.stringify({ skipped: 'no_baseline' }) };
        }
        if (command.includes('"op":"capture"')) {
          return { exitCode: 0, stdout: JSON.stringify({ sha256, entries: 0, chunks: [{ size: 5, sha256 }] }) };
        }
        if (command.includes('"op":"sys-hydrated"')) files.set(SYSTEM_MANIFEST_PATH, '{}');
        return { exitCode: 0, stdout: '' };
      }
      return { exitCode: 0, stdout: '0.00 0.01 0.05 1/123 456\n' };
    },
    exists: async (path: string) => ({ exists: files.has(path) }),
    readFile: async (path: string) => files.has(path) ? { content: files.get(path)!, encoding: 'utf-8' }
      : { content: Buffer.from('hello').toString('base64'), encoding: 'base64' },
    writeFile: async (path: string, content: string) => { files.set(path, content); return { success: true }; },
    mkdir: async () => ({ success: true }),
    listFiles: async () => ({ files: [] }),
  });
  return { fake, store, calls, spooled, background };
}

const active = (extra: Record<string, unknown> = {}) => ({
  [HYDRATED_KEY]: true,
  [FLUSH_CONTEXT_KEY]: { prefix: PREFIX, mountPath: '/workspace' },
  [LAST_ACTIVITY_AT_KEY]: Date.now(),
  ...extra,
});

async function call(fake: unknown, name: string, ...args: unknown[]) {
  return ((await proto())[name] as unknown as (...a: unknown[]) => Promise<unknown>).call(fake, ...args);
}
const events = (s: Spooled[]) => s.flatMap((b) => b.events);

describe('B2: persistent refusals back off, transient failures retry next cycle', () => {
  for (const sysCapture of ['ok', 'unchanged'] as const) {
    for (const final of [false, true]) {
      it(`${sysCapture} clears an old refusal after a successful ${final ? 'final' : 'interval'} capture`, async () => {
        const { fake, store, calls } = await makeFake({ sysCapture,
          storage: active({ [BACKOFF_AT_KEY]: Date.now() - (final ? 0 : 5 * 60_000) }) });
        expect(await call(fake, 'runSystemFlush', fake.env.SANDBOX_WORKSPACE_R2_BUCKET, PREFIX, final))
          .toMatchObject({ ok: true, ...(sysCapture === 'unchanged' ? { unchanged: true } : {}) });
        expect(calls.sysCaptures).toBe(1);
        expect(store.has(BACKOFF_AT_KEY)).toBe(false);
        expect(calls.io).toContain(`delete:${BACKOFF_AT_KEY}`);
      });
    }
  }

  it('a backoff deletion failure does not turn a successful capture into a failed checkpoint', async () => {
    const { fake } = await makeFake({ sysCapture: 'ok', backoffDeleteThrows: true,
      storage: active({ [BACKOFF_AT_KEY]: Date.now() }) });
    expect(await call(fake, 'runSystemFlush', fake.env.SANDBOX_WORKSPACE_R2_BUCKET, PREFIX, true)).toMatchObject({ ok: true });
  });

  it('too_large: 6 alarm cycles -> ONE sys-capture, ONE persistence event', async () => {
    const { fake, calls, spooled, store } = await makeFake({ sysCapture: 'too_large', storage: active({ [COMPUTER_ID_KEY]: COMPUTER }) });
    for (let i = 0; i < 6; i++) await call(fake, 'flushWorkspaceScheduled');
    expect(calls.sysCaptures).toBe(1);
    expect(typeof store.get(BACKOFF_AT_KEY)).toBe('number');
    const sys = events(spooled).filter((e) => e.site === 'persist.system.flush');
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({ eventClass: 'persistence', code: 'too_large', outcome: 'skipped', computerId: COMPUTER,
      attrs: { trigger: 'interval', size_bucket: 'over_cap' } });
    expect(calls.stops).toBe(0);
  });

  for (const sysCapture of ['stale', 'not_restored'] as const) {
    it(`${sysCapture} backs off the same way`, async () => {
      const { fake, calls, store } = await makeFake({ sysCapture, storage: active() });
      for (let i = 0; i < 4; i++) await call(fake, 'flushWorkspaceScheduled');
      expect(calls.sysCaptures).toBe(1);
      expect(typeof store.get(BACKOFF_AT_KEY)).toBe('number');
    });
  }

  it('an R2 failure retries on the next interval and can recover immediately', async () => {
    const opts: Opts = { sysCapture: 'ok', systemPutThrows: true, storage: active() };
    const { fake, calls, spooled, store } = await makeFake(opts);
    for (let i = 0; i < 2; i++) await call(fake, 'flushWorkspaceScheduled');
    expect(calls.sysCaptures).toBe(2);
    expect(store.has(BACKOFF_AT_KEY)).toBe(false);
    opts.systemPutThrows = false;
    await call(fake, 'flushWorkspaceScheduled');
    expect(calls.sysCaptures).toBe(3);
    expect(events(spooled).filter((e) => e.site === 'persist.system.flush').map((e) => e.code)).toEqual(['failed', 'ok']);
  });

  it('a failed FINAL capture ignores backoff and still refuses idle-stop', async () => {
    const { fake, calls, spooled, store } = await makeFake({ sysCapture: 'ok', systemPutThrows: true,
      storage: active({ [BACKOFF_AT_KEY]: Date.now(), [LAST_ACTIVITY_AT_KEY]: Date.now() - IDLE_STOP_MS - 60_000 }) });
    const backoffAt = store.get(BACKOFF_AT_KEY);
    await call(fake, 'flushWorkspaceScheduled');
    expect(calls.sysCaptures).toBe(1);
    expect(calls.stops).toBe(0);
    expect(calls.scheduled).toBe(1);
    expect(store.get(BACKOFF_AT_KEY)).toBe(backoffAt);
    expect(events(spooled).some((e) => e.site === 'persist.stop')).toBe(false);
  });

  it('a FINAL capture ignores the backoff (idle-stop still captures), and idle-stop still stops on too_large', async () => {
    const { fake, calls, spooled } = await makeFake({ sysCapture: 'too_large', storage: active({ [COMPUTER_ID_KEY]: COMPUTER }) });
    await call(fake, 'flushWorkspaceScheduled');
    expect(calls.sysCaptures).toBe(1);
    // Go idle: the next alarm takes the idle-stop branch with a FINAL flush.
    (fake as { ctx: { storage: { put: (k: string, v: unknown) => Promise<void> } } }).ctx.storage.put(LAST_ACTIVITY_AT_KEY, Date.now() - IDLE_STOP_MS - 60_000);
    await call(fake, 'flushWorkspaceScheduled');
    expect(calls.sysCaptures).toBe(2);
    expect(calls.stops).toBe(1);
    const stop = events(spooled).filter((e) => e.site === 'persist.stop');
    expect(stop).toHaveLength(1);
    expect(stop[0]).toMatchObject({ code: 'too_large', computerId: COMPUTER, attrs: { discarded_unsaved: true, trigger: 'idle_stop' } });
  });
});

describe('stop observations follow the container operation', () => {
  it('idle-stop has no storage or R2 operation between the final activity check and stop', async () => {
    const { fake, calls, spooled } = await makeFake({ sysCapture: 'too_large',
      storage: active({ [LAST_ACTIVITY_AT_KEY]: Date.now() - IDLE_STOP_MS - 60_000 }) });
    await call(fake, 'flushWorkspaceScheduled');
    const recheck = calls.io.lastIndexOf('get:ezil:lastOpenedAt');
    expect(recheck).toBeGreaterThan(-1);
    expect(calls.io[recheck + 1]).toBe('stop');
    expect(calls.io.indexOf('telemetry:persist.stop')).toBeGreaterThan(calls.io.indexOf('stop'));
    expect(events(spooled).filter((e) => e.site === 'persist.stop')).toHaveLength(1);
  });

  it('a failed idle-stop reschedules without claiming the container was discarded', async () => {
    const { fake, calls, spooled } = await makeFake({ stopThrows: true,
      storage: active({ [LAST_ACTIVITY_AT_KEY]: Date.now() - IDLE_STOP_MS - 60_000 }) });
    await call(fake, 'flushWorkspaceScheduled');
    expect(calls.stops).toBe(1);
    expect(calls.scheduled).toBe(1);
    expect(events(spooled).filter((e) => e.site === 'persist.stop')).toHaveLength(0);
  });

  for (const retainPreviewAuthorization of [false, true]) {
    for (const telemetryPutThrows of [false, true]) {
      it(`teardown observes after SDK ${retainPreviewAuthorization ? 'stop' : 'destroy'} (telemetry throws: ${telemetryPutThrows})`, async () => {
        const { fake, calls, spooled } = await makeFake({ telemetryPutThrows, storage: active() });
        const base = Object.getPrototypeOf(await proto());
        const method = retainPreviewAuthorization ? 'stop' : 'destroy';
        const original = base[method];
        base[method] = async () => {
          calls.io.push('sdk-stop');
          fake.ctx.container.running = false;
        };
        try {
          expect(await call(fake, 'terminateSandboxWithCheckpoint', retainPreviewAuthorization)).toMatchObject({ ok: true, terminated: true });
          expect(calls.io.indexOf('telemetry:persist.stop')).toBeGreaterThan(calls.io.indexOf('sdk-stop'));
          if (!telemetryPutThrows) expect(events(spooled).at(-1)).toMatchObject({
            site: 'persist.stop', attrs: { trigger: 'teardown', discarded_unsaved: false },
          });
        } finally { base[method] = original; }
      });
    }
  }
});

describe('DO tracker writes only on real state changes', () => {
  it('already_restored observations do no I/O and leave the last outcome intact', async () => {
    const initial = observe(emptyTrackerState(), { kind: 'flush', layer: 'system', code: 'too_large', trigger: 'interval' }, Date.now()).state;
    const { fake, store, calls, background } = await makeFake({ storage: { [TRACKER_KEY]: initial } });
    for (const layer of ['system', 'workspace']) {
      await call(fake, 'observePersistence', { kind: 'restore', layer, code: 'already_restored', trigger: 'open' });
    }
    expect(store.get(TRACKER_KEY)).toBe(initial);
    expect(calls.io).toEqual([]);
    expect(background).toEqual([]);
  });

  it('skips no-op observations but stores suppressed counter changes and due heartbeats', async () => {
    const restore: PersistenceObservation = { kind: 'restore', layer: 'system', code: 'ok', trigger: 'open' };
    const initial = observe(emptyTrackerState(), restore, Date.now()).state;
    const { fake, calls, store, spooled } = await makeFake({ storage: { [TRACKER_KEY]: initial } });
    for (const obs of [restore, { kind: 'heartbeat', running: true }, { kind: 'heartbeat', running: false },
      { kind: 'flush', layer: 'system', code: 'busy', trigger: 'interval' },
      { kind: 'flush', layer: 'workspace', code: 'deferred', trigger: 'interval' }]) {
      await call(fake, 'observePersistence', obs);
    }
    expect(calls.trackerPuts).toBe(0);
    expect(store.get(TRACKER_KEY)).toBe(initial);
    expect(spooled).toHaveLength(0);
    const failure = { kind: 'flush', layer: 'system', code: 'failed', trigger: 'interval' };
    await call(fake, 'observePersistence', failure);
    await call(fake, 'observePersistence', failure);
    expect(calls.trackerPuts).toBe(2);
    expect(store.get(TRACKER_KEY)).toMatchObject({ system: { consecutiveFailures: 2 } });
    expect(events(spooled)).toHaveLength(1);
    const current = store.get(TRACKER_KEY) as typeof initial;
    store.set(TRACKER_KEY, { ...current, lastEventAt: Date.now() - PERSISTENCE_HEARTBEAT_MS });
    await call(fake, 'observePersistence', { kind: 'heartbeat', running: true });
    expect(calls.trackerPuts).toBe(3);
    expect(events(spooled).at(-1)!.site).toBe('persist.heartbeat');
  });
});

describe('R2 spool runs off the critical path', () => {
  for (const telemetryPutThrows of [false, true]) {
    it(`awaits tracker storage, but returns before R2 settles (R2 rejects: ${telemetryPutThrows})`, async () => {
      let releaseTracker!: () => void;
      let releaseR2!: () => void;
      const trackerPutGate = new Promise<void>((resolve) => { releaseTracker = resolve; });
      const telemetryPutGate = new Promise<void>((resolve) => { releaseR2 = resolve; });
      const { fake, store, calls, spooled, background } = await makeFake({ telemetryPutThrows, trackerPutGate, telemetryPutGate,
        storage: { [COMPUTER_ID_KEY]: COMPUTER } });
      let completed = false;
      const operation = call(fake, 'observePersistence', { kind: 'restore', layer: 'system', code: 'ok', trigger: 'open' })
        .then(() => { completed = true; });
      try {
        await Bun.sleep(0);
        expect(calls.trackerPuts).toBe(1);
        expect(completed).toBe(false);
        expect(background).toHaveLength(0);
        releaseTracker();
        await Bun.sleep(0);
        expect(completed).toBe(true);
        expect(store.get(TRACKER_KEY)).toMatchObject({ system: { code: 'ok' } });
        expect(calls.io.filter((io) => io.startsWith('get:'))).toEqual([`get:${TRACKER_KEY},${COMPUTER_ID_KEY}`]);
        expect(background).toHaveLength(1);
        expect(spooled).toHaveLength(0);
      } finally {
        releaseTracker();
        releaseR2();
        await operation;
      }
      await expect(Promise.all(background)).resolves.toEqual([undefined]);
      expect(spooled).toHaveLength(telemetryPutThrows ? 0 : 1);
      if (!telemetryPutThrows) expect(events(spooled)[0]).toMatchObject({ computerId: COMPUTER });
    });
  }
});

describe('attribution', () => {
  it('no stored computer -> events carry no computerId', async () => {
    const { fake, spooled } = await makeFake({ sysCapture: 'too_large', storage: active() });
    await call(fake, 'flushWorkspaceScheduled');
    expect(events(spooled).length).toBeGreaterThan(0);
    for (const e of events(spooled)) expect(e.computerId).toBeUndefined();
  });

  it('setPersistenceComputerId keeps only a UUID (never a sandboxId)', async () => {
    const { fake, store } = await makeFake();
    await call(fake, 'setPersistenceComputerId', 'guac-abcdef0123456789-fedcba9876543210');
    expect(store.has(COMPUTER_ID_KEY)).toBe(false);
    await call(fake, 'setPersistenceComputerId', COMPUTER.toUpperCase());
    expect(store.get(COMPUTER_ID_KEY)).toBe(COMPUTER);
  });
});

describe('telemetry never changes persistence behaviour', () => {
  for (const variant of ['telemetryPutThrows', 'noTelemetryBucket'] as const) {
    it(`${variant}: idle-stop still stops, flush outcome unchanged`, async () => {
      const { fake, calls } = await makeFake({ sysCapture: 'ok', [variant]: true,
        storage: active({ [LAST_ACTIVITY_AT_KEY]: Date.now() - IDLE_STOP_MS - 60_000 }) });
      await call(fake, 'flushWorkspaceScheduled');
      expect(calls.stops).toBe(1);
      const outcome = await call(fake, 'runWorkspaceFlush', 'explicit') as { ok: boolean };
      expect(outcome.ok).toBe(true);
    });
  }
});

describe('open_blocked and status', () => {
  it('records each blocked open, and the status reflects a paused system layer', async () => {
    const { fake, spooled } = await makeFake({ sysCapture: 'too_large', storage: active({ [COMPUTER_ID_KEY]: COMPUTER }) });
    await call(fake, 'recordPersistenceOpenBlocked', 'workspace_checkpoint_failed');
    await call(fake, 'recordPersistenceOpenBlocked', 'workspace_checkpoint_failed');
    expect(events(spooled).filter((e) => e.site === 'persist.open_blocked')).toHaveLength(2);
    await call(fake, 'flushWorkspaceScheduled');
    const status = await call(fake, 'persistenceStatus') as Record<string, unknown>;
    expect(status).toMatchObject({ savingPaused: true, pausedLayer: 'system', pausedReason: 'too_large',
      workspace: { code: 'ok', outcome: 'ok' } });
  });
});

describe('GET /sandbox/:name/persistence', () => {
  const secret = 'persistence-route-test-only';
  const name = 'guac-abcdef0123456789-fedcba9876543210';
  const token = async (key = secret, t = Date.now()) => `t=${t},v1=${await hmacSha256Hex(key, PREVIEW_TOKEN_PAYLOAD(t))}`;
  async function fixture() {
    const mod = await import('./index');
    let opened = '';
    let reads = 0;
    const env = { SANDBOX_HMAC_SECRET: secret, Sandbox: {
      idFromName: (v: string) => { opened = v; return v; },
      get: () => ({ persistenceStatus: async () => { reads++; return { savingPaused: false }; } }),
    } };
    return { fetch: (r: Request) => mod.default.fetch(r, env as never), opened: () => opened, reads: () => reads };
  }
  it('401 unsigned / wrong key, never touching the computer', async () => {
    for (const signed of ['', await token('wrong')]) {
      const f = await fixture();
      const res = await f.fetch(new Request(`https://w.example/sandbox/${name}/persistence`, { headers: { Authorization: `Bearer ${signed}` } }));
      expect(res.status).toBe(401);
      expect(f.opened()).toBe('');
      expect(f.reads()).toBe(0);
    }
  });
  it('signed read returns the status', async () => {
    const f = await fixture();
    const res = await f.fetch(new Request(`https://w.example/sandbox/${name}/persistence`, { headers: { Authorization: `Bearer ${await token()}` } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: { savingPaused: false } });
    expect(f.reads()).toBe(1);
  });
});

describe('restore observations (hydrateWorkspace)', () => {
  it('records a workspace restore and a system restore event for the computer', async () => {
    const { fake, spooled } = await makeFake({ sysCapture: 'ok', storage: { [COMPUTER_ID_KEY]: COMPUTER, [LAST_ACTIVITY_AT_KEY]: Date.now() } });
    expect(await call(fake, 'hydrateWorkspace', { mountPath: '/workspace', prefix: PREFIX })).toMatchObject({ mounted: true });
    const sites = events(spooled).map((e) => `${e.site}:${e.code}`);
    expect(sites).toContain('persist.workspace.restore:ok');
    expect(sites).toContain('persist.system.restore:no_snapshot');
    for (const e of events(spooled)) expect(e.computerId).toBe(COMPUTER);
  });

  it('repeated preview hydrations preserve real restores and flush suppression, and retain current-container backoff', async () => {
    const { fake, spooled, store } = await makeFake({ storage: { [COMPUTER_ID_KEY]: COMPUTER } });
    const params = { mountPath: '/workspace', prefix: PREFIX };
    expect(await call(fake, 'hydrateWorkspace', params)).toMatchObject({ mounted: true });
    const firstEvents = events(spooled);
    const backoffAt = Date.now();
    store.set(BACKOFF_AT_KEY, backoffAt);
    for (let i = 0; i < 3; i++) {
      expect(await call(fake, 'hydrateWorkspace', params)).toMatchObject({ mounted: true, detail: 'already_hydrated' });
      await call(fake, 'runWorkspaceFlush', 'explicit');
    }
    expect(events(spooled)).toEqual(firstEvents);
    expect(store.get(BACKOFF_AT_KEY)).toBe(backoffAt);
  });

  for (const systemReadThrows of [false, true]) {
    it(`fresh system hydration clears old-container backoff (restore fails: ${systemReadThrows})`, async () => {
      const { fake, store, calls, spooled } = await makeFake({ systemReadThrows,
        storage: { [BACKOFF_AT_KEY]: Date.now() } });
      expect(await call(fake, 'hydrateWorkspace', { mountPath: '/workspace', prefix: PREFIX })).toMatchObject({ mounted: true });
      expect(store.has(BACKOFF_AT_KEY)).toBe(false);
      expect(calls.io).toContain(`delete:${BACKOFF_AT_KEY}`);
      expect(events(spooled).find((e) => e.site === 'persist.system.restore')?.code).toBe(systemReadThrows ? 'failed' : 'no_snapshot');
    });
  }

  it('a backoff deletion failure does not block hydration', async () => {
    const { fake } = await makeFake({ backoffDeleteThrows: true, storage: { [BACKOFF_AT_KEY]: Date.now() } });
    expect(await call(fake, 'hydrateWorkspace', { mountPath: '/workspace', prefix: PREFIX })).toMatchObject({ mounted: true });
  });
});
