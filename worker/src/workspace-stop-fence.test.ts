/**
 * Final-stop fences, executed on the REAL `Sandbox` prototype (same harness
 * idea as `workspace-flush-loop.test.ts`):
 *
 * - Flush-blocks-stop: a FINAL system-layer checkpoint that is busy, stale or
 *   not_restored keeps the computer up exactly like `failed` (idle-stop
 *   reschedules; teardown refuses). too_large / no_baseline / no_manifest do not.
 * - C-7: a computer whose head is the terminal `migrated` marker is never
 *   checkpointed or restored on Cloudflare again, may stop, and its migration
 *   export is refused while the workspace or system layer is over the caps.
 */
import { describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { flushWorkspaceToR2, migrationFenceState } from './workspace-persist';
import { flushSystemLayer } from './system-persist';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

const COMPUTER = '22222222-2222-4222-8222-222222222222';
const PREFIX = `${COMPUTER}/branches/main`;
const HEAD = `${PREFIX}/.ezil-snapshots/latest.json`;
const FLAG = `${PREFIX}/.ezil-snapshots/migrating.json`;
const MOUNT_PATH = '/workspace';

type AnyFn = (this: unknown, ...args: never[]) => Promise<unknown>;
async function proto(): Promise<Record<string, AnyFn>> {
  return ((await import('./index')) as unknown as { Sandbox: { prototype: Record<string, AnyFn> } }).Sandbox.prototype;
}

type SysCapture = { exitCode: number; stdout: string };
async function makeFake(opts: { sysCapture?: SysCapture; wsCaptureExit?: number; storage?: Record<string, unknown>; idle?: boolean } = {}) {
  const store = new Map<string, unknown>(Object.entries({
    'ezil:workspaceHydrated': true,
    'ezil:workspaceFlushContext': { prefix: PREFIX, mountPath: MOUNT_PATH },
    'ezil:lastActivityAt': opts.idle ? Date.now() - 11 * 60_000 : Date.now(),
    ...(opts.storage ?? {}),
  }));
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let rev = 0;
  const calls = { stops: 0, scheduled: [] as number[], puts: [] as string[] };
  const bucket = {
    get: async (k: string) => { const o = objects.get(k); return o ? { etag: o.etag, size: o.bytes.length, arrayBuffer: async () => o.bytes.slice().buffer } : null; },
    put: async (k: string, v: Uint8Array | string, o?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
      const cur = objects.get(k);
      if (o?.onlyIf?.etagDoesNotMatch === '*' && cur) return null;
      if (o?.onlyIf?.etagMatches !== undefined && cur?.etag !== o.onlyIf.etagMatches) return null;
      const etag = `e${++rev}`;
      objects.set(k, { bytes: typeof v === 'string' ? new TextEncoder().encode(v) : v, etag });
      calls.puts.push(k);
      return { key: k, etag };
    },
    list: async (o: { prefix: string }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(o.prefix)).map((key) => ({ key, uploaded: new Date() })), truncated: false }),
    delete: async (keys: string[]) => { for (const k of keys) objects.delete(k); },
  };
  const fake = Object.assign(Object.create(await proto()), {
    ctx: {
      storage: {
        get: async (k: string) => store.get(k),
        put: async (k: string, v: unknown) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
      },
      container: { running: true },
    },
    env: { SANDBOX_WORKSPACE_R2_BUCKET: bucket },
    exec: async (command: string) => {
      if (command.includes('"op":"sys-capture"')) return opts.sysCapture ?? { exitCode: 0, stdout: '{"skipped":"no_baseline"}' };
      if (command.includes('"op":"capture"')) {
        if (opts.wsCaptureExit) return { exitCode: opts.wsCaptureExit, stdout: '' };
        const sha256 = createHash('sha256').update('hello').digest('hex');
        return { exitCode: 0, stdout: JSON.stringify({ sha256, entries: 1, chunks: [{ size: 5, sha256 }] }) };
      }
      if (command.startsWith('python3 ')) return { exitCode: 0, stdout: '' };
      return { exitCode: 0, stdout: '0.00 0.01 0.05 1/123 456\n' };
    },
    exists: async () => ({ exists: false }),
    readFile: async () => ({ content: Buffer.from('hello').toString('base64'), encoding: 'base64' }),
    writeFile: async () => ({ success: true }),
    mkdir: async () => ({ success: true }),
    listFiles: async () => ({ files: [] }),
    stop: async () => { calls.stops++; fake.ctx.container.running = false; },
    listSchedules: async () => [],
    deleteSchedules: () => undefined,
    schedule: async (seconds: number) => void calls.scheduled.push(seconds),
  });
  return { fake, store, objects, calls, bucket };
}

const SYSTEM_OUTCOMES: Array<[string, SysCapture, 'stops' | 'bounded']> = [
  ['stale', { exitCode: 0, stdout: '{"expectedGeneration":"another-writer"}' }, 'stops'],
  ['not_restored', { exitCode: 0, stdout: '{"skipped":"not_restored"}' }, 'stops'],
  ['too_large', { exitCode: 3, stdout: '' }, 'stops'],
  ['no_baseline', { exitCode: 0, stdout: '{"skipped":"no_baseline"}' }, 'stops'],
  ['no_manifest', { exitCode: 0, stdout: '{"skipped":"no_manifest"}' }, 'stops'],
  ['busy', { exitCode: 0, stdout: '{"skipped":"busy"}' }, 'bounded'],
  ['failed', { exitCode: 1, stdout: '' }, 'bounded'],
];
const UNSAVED = new Set(['stale', 'not_restored', 'busy', 'failed']);

async function idleCycle(fake: unknown) { await (await proto()).flushWorkspaceScheduled.call(fake); }
async function teardown(fake: unknown) {
  const p = await proto();
  const base = Object.getPrototypeOf(p); const original = base.destroy;
  base.destroy = async function (this: { ctx: { container: { running: boolean } } }) { this.ctx.container.running = false; };
  try { return await p.terminateSandbox.call(fake) as { ok: boolean; outcome?: string; error?: string; systemChangesNotSaved?: string; retryAfterSeconds?: number }; }
  finally { base.destroy = original; }
}

describe('final system checkpoint stop policy: permanent outcomes never block, retryable ones are bounded', () => {
  for (const [reason, sysCapture, policy] of SYSTEM_OUTCOMES) {
    if (policy === 'stops') {
      it(`idle-stop with a PERMANENT ${reason} system checkpoint stops (every time)`, async () => {
        const { fake, calls, store } = await makeFake({ sysCapture, idle: true });
        await idleCycle(fake);
        expect(calls.stops).toBe(1);
        expect(store.has('ezil:systemChangesNotSaved')).toBe(UNSAVED.has(reason));
        if (UNSAVED.has(reason)) expect(store.get('ezil:systemChangesNotSaved')).toMatchObject({ reason });
      });
      it(`teardown with a ${reason} system checkpoint proceeds${UNSAVED.has(reason) ? ' and reports the changes not saved' : ''}`, async () => {
        const { fake } = await makeFake({ sysCapture });
        const report = await teardown(fake);
        expect(report.outcome).not.toBe('flush_failed');
        if (UNSAVED.has(reason)) expect(report.systemChangesNotSaved).toBe(reason);
        else expect(report.systemChangesNotSaved).toBeUndefined();
      });
    } else {
      it(`idle-stop with a ${reason} system checkpoint blocks with backoff, then stops after 3 retries`, async () => {
        const { fake, calls, store } = await makeFake({ sysCapture, idle: true });
        for (const expected of [60, 180, 300]) {
          await idleCycle(fake);
          expect(calls.stops).toBe(0);
          expect(calls.scheduled.at(-1)).toBe(expected);
          store.set('ezil:lastActivityAt', Date.now() - 11 * 60_000); // still idle
        }
        await idleCycle(fake); // the 3rd retry: bound reached
        expect(calls.stops).toBe(1);
        expect(store.get('ezil:systemChangesNotSaved')).toMatchObject({ reason });
        expect(store.has('ezil:systemFinalRetry')).toBe(false);
      });
      it(`idle-stop with a ${reason} system checkpoint stops once 15 minutes passed since the first, even before 3 retries`, async () => {
        const { fake, calls, store } = await makeFake({ sysCapture, idle: true });
        await idleCycle(fake);
        expect(calls.stops).toBe(0);
        store.set('ezil:systemFinalRetry', { firstAt: Date.now() - 15 * 60_000, attempts: 1 });
        await idleCycle(fake);
        expect(calls.stops).toBe(1);
      });
      it(`teardown (user or reaper) with a ${reason} system checkpoint is refused, bounded, then proceeds`, async () => {
        const { fake } = await makeFake({ sysCapture });
        for (let i = 0; i < 3; i++) {
          const refused = await teardown(fake);
          expect(refused).toMatchObject({ ok: false, outcome: 'flush_failed', error: 'system_checkpoint_failed' });
          expect(refused.retryAfterSeconds).toBeGreaterThan(0);
        }
        const done = await teardown(fake);
        expect(done.outcome).not.toBe('flush_failed');
        expect(done.systemChangesNotSaved).toBe(reason);
      });
    }
  }

  it('a clean final checkpoint clears both the bounded wait and the not-saved signal', async () => {
    const { fake, store } = await makeFake({ idle: true, storage: {
      'ezil:systemFinalRetry': { firstAt: Date.now(), attempts: 2 },
      'ezil:systemChangesNotSaved': { reason: 'busy', at: 1 } } });
    await idleCycle(fake);
    expect(store.has('ezil:systemFinalRetry')).toBe(false);
    expect(store.has('ezil:systemChangesNotSaved')).toBe(false);
    expect(await (await proto()).persistenceHealth.call(fake)).toEqual({ systemChangesNotSaved: null });
  });

  it('busy + stale-presence heartbeats before every idle cycle: still stops after the bound', async () => {
    const { fake, calls, store } = await makeFake({ sysCapture: { exitCode: 0, stdout: '{"skipped":"busy"}' }, idle: true });
    const p = await proto();
    for (let i = 0; i < 3; i++) {
      // The shell reports presence up to 30 min old; idle-stop is due at 10.
      await p.recordActivity.call(fake, (25 * 60_000) as never);
      await idleCycle(fake);
      expect(calls.stops).toBe(0);
    }
    await p.recordActivity.call(fake, (25 * 60_000) as never);
    await idleCycle(fake);
    expect(calls.stops).toBe(1);
    expect(store.get('ezil:systemChangesNotSaved')).toMatchObject({ reason: 'busy' });
  });

  it('genuine activity resets the bounded wait, so the next idle period starts afresh', async () => {
    const { fake, store } = await makeFake({ storage: { 'ezil:systemFinalRetry': { firstAt: Date.now() - 60_000, attempts: 3 } } });
    await (await proto()).runWorkspaceFlush.call(fake, 'explicit' as never); // teardown's own flush is NOT presence
    expect(store.has('ezil:systemFinalRetry')).toBe(true);
    await (await proto()).recordActivity.call(fake, 0 as never); // a real input heartbeat is
    expect(store.has('ezil:systemFinalRetry')).toBe(false);
  });
});

async function migrate(objects: Map<string, { bytes: Uint8Array; etag: string }>, bucket: { put: (k: string, v: string, o?: unknown) => Promise<unknown> }) {
  const { writeMigratedHead } = await import('./workspace-persist');
  const etag = objects.get(HEAD)!.etag;
  expect((await writeMigratedHead({ bucket: bucket as never, realPrefix: PREFIX, targetProvider: 'aws-ec2', expectedEtag: etag })).ok).toBe(true);
}

describe('C-7 on the Durable Object', () => {
  it('after the migrated head, an alarm flush is refused, the head is untouched, and idle-stop may stop', async () => {
    const { fake, objects, bucket, calls } = await makeFake({ idle: true });
    expect(((await (await proto()).runWorkspaceFlush.call(fake, 'alarm' as never)) as { ok: boolean }).ok).toBe(true);
    await migrate(objects, bucket);
    const marker = new TextDecoder().decode(objects.get(HEAD)!.bytes);
    const late = (await (await proto()).runWorkspaceFlush.call(fake, 'alarm' as never)) as { ok: boolean; skippedReason?: string };
    expect(late).toMatchObject({ ok: false, skippedReason: 'migrated' });
    expect(new TextDecoder().decode(objects.get(HEAD)!.bytes)).toBe(marker);
    calls.stops = 0;
    await (await proto()).flushWorkspaceScheduled.call(fake);
    expect(calls.stops).toBe(1);
    expect(new TextDecoder().decode(objects.get(HEAD)!.bytes)).toBe(marker);
  });

  it('a migrated computer is never restored on Cloudflare', async () => {
    const { fake, objects, bucket } = await makeFake();
    await (await proto()).runWorkspaceFlush.call(fake, 'alarm' as never);
    await migrate(objects, bucket);
    const res = await (await proto()).hydrateWorkspace.call(fake, { mountPath: MOUNT_PATH, prefix: `/${PREFIX}` } as never);
    expect(res).toEqual({ mounted: false, detail: 'workspace_migrated' });
  });

  it('export: refused for an oversized workspace (the committed head would be stale), never truncated', async () => {
    const { fake, objects, store } = await makeFake();
    await (await proto()).runWorkspaceFlush.call(fake, 'alarm' as never);
    expect(objects.has(HEAD)).toBe(true);
    const { fake: big } = await makeFake({ wsCaptureExit: 3 });
    Object.assign(big, { env: (fake as { env: unknown }).env });
    expect(await (await proto()).beginMigrationExport.call(big)).toEqual({ ok: false, reason: 'workspace_too_large' });
    expect(objects.has(FLAG)).toBe(false);
    // The flag persists: a stopped container (no final flush possible) is refused too.
    store.set('ezil:workspaceTooLarge', true);
    (fake as { ctx: { container: { running: boolean } } }).ctx.container.running = false;
    expect(await (await proto()).beginMigrationExport.call(fake)).toEqual({ ok: false, reason: 'workspace_too_large' });
    expect(objects.has(FLAG)).toBe(false);
  });

  it('export: a stopped computer whose size was never recorded is refused, not trusted', async () => {
    const { fake, objects } = await makeFake();
    await (await proto()).runWorkspaceFlush.call(fake, 'alarm' as never);
    const { fake: legacy, store } = await makeFake();
    Object.assign(legacy, { env: (fake as { env: unknown }).env });
    (legacy as { ctx: { container: { running: boolean } } }).ctx.container.running = false;
    expect(store.has('ezil:workspaceTooLarge')).toBe(false);
    expect(await (await proto()).beginMigrationExport.call(legacy)).toEqual({ ok: false, reason: 'workspace_size_unknown' });
    expect(objects.has(FLAG)).toBe(false);
    // Workspace size known, but a system head exists whose size was never recorded.
    store.set('ezil:workspaceTooLarge', false);
    objects.set(`${COMPUTER}/system/.ezil-snapshots/latest.json`, objects.get(HEAD)!);
    expect(await (await proto()).beginMigrationExport.call(legacy)).toEqual({ ok: false, reason: 'system_size_unknown' });
    store.set('ezil:systemTooLarge', false);
    expect(await (await proto()).beginMigrationExport.call(legacy)).toMatchObject({ ok: true });
  });

  it('export: refused for an oversized system delta', async () => {
    const { fake, objects } = await makeFake({ sysCapture: { exitCode: 3, stdout: '' } });
    expect(await (await proto()).beginMigrationExport.call(fake)).toEqual({ ok: false, reason: 'system_too_large' });
    expect(objects.has(FLAG)).toBe(false);
  });

  it('export: a clean computer raises the flag, returns the head, and commit makes it terminal', async () => {
    const { fake, objects } = await makeFake();
    const begun = (await (await proto()).beginMigrationExport.call(fake)) as { ok: boolean; head: { etag: string; generation: string }; systemEtag: string | null };
    expect(begun.ok).toBe(true);
    expect(objects.has(FLAG)).toBe(true);
    expect(begun.head.etag).toBe(objects.get(HEAD)!.etag);
    const done = await (await proto()).commitMigration.call(fake, { targetProvider: 'aws-ec2', expectedEtag: begun.head.etag, expectedSystemEtag: begun.systemEtag } as never);
    expect(done).toMatchObject({ ok: true });
    expect(new TextDecoder().decode(objects.get(HEAD)!.bytes)).toContain('"kind":"migrated"');
  });

  it('export: commit is refused when a checkpoint landed after the export read the head', async () => {
    const { fake, objects } = await makeFake();
    const begun = (await (await proto()).beginMigrationExport.call(fake)) as { head: { etag: string }; systemEtag: string | null };
    (fake as { lastOkCheckpoint: unknown }).lastOkCheckpoint = null;
    fake.ctx.container.running = true; // simulate a new start after expiry
    const flag = objects.get(FLAG)!;
    flag.bytes = new TextEncoder().encode(JSON.stringify({ startedAt: new Date(Date.now() - 41 * 60_000).toISOString() }));
    await (await proto()).runWorkspaceFlush.call(fake, 'explicit' as never); // late checkpoint after fence expiry
    expect(objects.get(HEAD)!.etag).not.toBe(begun.head.etag);
    expect(await (await proto()).commitMigration.call(fake, { targetProvider: 'aws-ec2', expectedEtag: begun.head.etag, expectedSystemEtag: begun.systemEtag } as never))
      .toEqual({ ok: false, reason: 'head_moved' });
  });
});

describe('C-7: commitMigration is recoverable (never a split migration)', () => {
  const SYS = `${COMPUTER}/system/.ezil-snapshots/latest.json`;
  const text = (objects: Map<string, { bytes: Uint8Array }>, k: string) => new TextDecoder().decode(objects.get(k)!.bytes);
  async function withSystemHead() {
    const f = await makeFake();
    await (await proto()).runWorkspaceFlush.call(f.fake, 'alarm' as never);
    f.objects.set(SYS, { ...f.objects.get(HEAD)!, etag: 'sys1' });
    return { ...f, wsEtag: f.objects.get(HEAD)!.etag };
  }
  const commit = async (fake: unknown, p: Record<string, unknown>) => (await proto()).commitMigration.call(fake, p as never);

  it('a system fence that fails after the workspace marker committed is not ok, and the retry completes it', async () => {
    const { fake, objects, bucket, wsEtag } = await withSystemHead();
    const realPut = bucket.put;
    let failOnce = true;
    bucket.put = (async (k: string, v: Uint8Array | string, o?: never) => {
      if (k === SYS && failOnce) { failOnce = false; throw new Error('r2 transient'); }
      return realPut(k, v, o);
    }) as typeof bucket.put;
    const params = { targetProvider: 'aws-ec2', expectedEtag: wsEtag, expectedSystemEtag: 'sys1' };
    expect(await commit(fake, params)).toEqual({ ok: false, reason: 'system_fence_failed' });
    expect(text(objects, HEAD)).toContain('"kind":"migrated"');
    expect(text(objects, SYS)).not.toContain('"kind":"migrated"');
    // Same parameters again: its own workspace marker is recognised, the system head is fenced.
    expect(await commit(fake, params)).toEqual({ ok: true, systemFenced: true });
    expect(text(objects, SYS)).toContain('"kind":"migrated"');
    // ...and once more is still ok (idempotent), while a different target is refused.
    expect(await commit(fake, params)).toEqual({ ok: true, systemFenced: true });
    expect(await commit(fake, { ...params, targetProvider: 'cloudflare' })).toMatchObject({ ok: false, reason: 'already_migrated' });
  });

  it('a system head that moved since the export is refused before anything is written', async () => {
    const { fake, objects, wsEtag } = await withSystemHead();
    objects.set(SYS, { ...objects.get(SYS)!, etag: 'sys2' });
    const before = text(objects, HEAD);
    expect(await commit(fake, { targetProvider: 'aws-ec2', expectedEtag: wsEtag, expectedSystemEtag: 'sys1' }))
      .toEqual({ ok: false, reason: 'system_head_moved' });
    expect(text(objects, HEAD)).toBe(before);
    expect(objects.get(HEAD)!.etag).toBe(wsEtag);
  });

  it('a workspace head migrated by ANOTHER export is still already_migrated', async () => {
    const { fake, objects, bucket } = await withSystemHead();
    await migrate(objects, bucket);
    expect(await commit(fake, { targetProvider: 'aws-ec2', expectedEtag: 'some-other-etag', expectedSystemEtag: 'sys1' }))
      .toEqual({ ok: false, reason: 'already_migrated' });
  });
});

describe('C-7: the Durable Object fences the SYSTEM prefix GC with the workspace prefix\'s migrating flag', () => {
  for (const flagged of [false, true]) {
    it(flagged ? 'flag raised: system garbage is kept' : 'positive control: no flag, system garbage is deleted', async () => {
      const { fake, objects } = await makeFake();
      const sp = `${COMPUTER}/system`;
      const sha = createHash('sha256').update('hello').digest('hex');
      const g1 = crypto.randomUUID(), g0 = crypto.randomUUID();
      const enc = (v: string) => new TextEncoder().encode(v);
      objects.set(`${sp}/.ezil-snapshots/latest.json`, { bytes: enc(JSON.stringify({ version: 1, generation: g1, sha256: sha, entries: 1, chunks: [{ size: 5, sha256: sha }] })), etag: 'h1' });
      objects.set(`${sp}/.ezil-snapshots/${g1}/0`, { bytes: enc('hello'), etag: 'c1' });
      objects.set(`${sp}/.ezil-snapshots/${g0}/0`, { bytes: enc('stale'), etag: 'c0' });
      if (flagged) objects.set(FLAG, { bytes: enc('{}'), etag: 'f' });
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 3 * 3_600_000; // past the GC grace window and interval
        await (await proto()).collectSnapshotGarbage.call(fake, (fake as { env: { SANDBOX_WORKSPACE_R2_BUCKET: never } }).env.SANDBOX_WORKSPACE_R2_BUCKET, PREFIX as never);
      } finally { Date.now = realNow; }
      expect(objects.has(`${sp}/.ezil-snapshots/${g0}/0`)).toBe(flagged);
      expect(objects.has(`${sp}/.ezil-snapshots/${g1}/0`)).toBe(true);
    });
  }
});


describe('fresh migration export fence', () => {
  async function begun() {
    const f = await makeFake();
    const result = await f.fake.beginMigrationExport();
    expect(result.ok).toBe(true);
    return f;
  }
  async function start(fake: any, method = 'start') {
    const base = Object.getPrototypeOf(await proto()), original = base[method];
    let starts = 0;
    base[method] = async () => { starts++; };
    try { await fake[method](); return starts; }
    finally { base[method] = original; }
  }
  const flush = (f: Awaited<ReturnType<typeof makeFake>>) => flushWorkspaceToR2({
    container: f.fake, bucket: f.bucket, mountPath: MOUNT_PATH, realPrefix: PREFIX,
    hydrationComplete: true, manifest: {}, log: () => {},
  });
  it('fresh flag skips workspace and system writers without touching the container or head', async () => {
    const f = await begun(), before = [...f.objects];
    f.fake.exec = async () => { throw new Error('container touched'); };
    expect(await flush(f)).toMatchObject({ ok: false, skippedReason: 'migrating' });
    expect(await flushSystemLayer({ container: f.fake, bucket: f.bucket, realPrefix: PREFIX, log: () => {} }))
      .toMatchObject({ ok: false, skippedReason: 'migrating' });
    expect([...f.objects]).toEqual(before);
  });
  it('fresh flag refuses explicit starts, implicit wakes, hydrate, desktop launch and restart', async () => {
    const f = await begun();
    for (const method of ['start', 'startAndWaitForPorts']) await expect(start(f.fake, method)).rejects.toThrow('migrating');
    const response = await f.fake.containerFetch('http://localhost/');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'migrating' });
    expect(await f.fake.hydrateWorkspace({ mountPath: MOUNT_PATH, prefix: PREFIX })).toEqual({ mounted: false, detail: 'migrating' });
    await expect(f.fake.startAiDesktop('example.invalid', 'sandbox', 'desktop', {})).rejects.toThrow('migrating');
    expect(await f.fake.restartDesktopStack('example.invalid', 'sandbox', 'neko', 'neko')).toMatchObject({ ok: false, error: 'migrating' });
  });
  for (const flag of [JSON.stringify({ startedAt: new Date(Date.now() - 41 * 60_000).toISOString() }),
    '{', '{}', '{"startedAt":"not-a-date"}', 'null']) {
    it(`stale or invalid flag allows workspace/system flush and both starts: ${flag}`, async () => {
      const f = await begun();
      await f.bucket.put(FLAG, flag);
      expect(await migrationFenceState(f.bucket, PREFIX, () => {})).toBe('stale');
      expect((await flush(f)).ok).toBe(true);
      const exec = f.fake.exec;
      f.fake.exec = async (command: string) => command.includes('"op":"sys-capture"')
        ? exec(command.replaceAll('sys-capture', 'capture')) : exec(command);
      expect((await flushSystemLayer({ container: f.fake, bucket: f.bucket, realPrefix: PREFIX, log: () => {} })).ok).toBe(true);
      for (const method of ['start', 'startAndWaitForPorts']) expect(await start(f.fake, method)).toBe(1);
    });
  }
  it('abort deletes the flag and permits a normal flush and both starts', async () => {
    const f = await begun();
    expect(await f.fake.abortMigrationExport()).toEqual({ ok: true });
    expect(f.objects.has(FLAG)).toBe(false);
    expect((await flush(f)).ok).toBe(true);
    for (const method of ['start', 'startAndWaitForPorts']) expect(await start(f.fake, method)).toBe(1);
  });
  it('begin stops the container only after writing the pinned flag', async () => {
    const f = await makeFake();
    f.fake.stop = async () => {
      f.calls.stops++;
      const flag = JSON.parse(new TextDecoder().decode(f.objects.get(FLAG)!.bytes));
      expect(flag.headEtag).toBe(f.objects.get(HEAD)!.etag);
      f.fake.ctx.container.running = false;
    };
    expect((await f.fake.beginMigrationExport()).ok).toBe(true);
    expect(f.calls.stops).toBe(1);
    expect(f.fake.ctx.container.running).toBe(false);
    expect(await f.fake.flushWorkspaceNow()).toMatchObject({ skippedReason: 'migrating' });
  });
  it('reopen clears the fence and permits normal starts and a flush', async () => {
    const f = await begun();
    expect((await f.fake.commitMigration({ targetProvider: 'aws-ec2', expectedEtag: f.objects.get(HEAD)!.etag, expectedSystemEtag: null })).ok).toBe(true);
    expect(await f.fake.reopenMigration({ expectedMigratedEtag: f.objects.get(HEAD)!.etag })).toEqual({ ok: true });
    expect(f.objects.has(FLAG)).toBe(false);
    for (const method of ['start', 'startAndWaitForPorts']) expect(await start(f.fake, method)).toBe(1);
    expect((await flush(f)).ok).toBe(true);
  });
  it('the fence expires at exactly forty minutes', async () => {
    const f = await makeFake();
    await f.bucket.put(FLAG, JSON.stringify({ startedAt: new Date(Date.now() - 39 * 60_000).toISOString() }));
    expect(await migrationFenceState(f.bucket, PREFIX, () => {})).toBe('fresh');
    await f.bucket.put(FLAG, JSON.stringify({ startedAt: new Date(Date.now() - 40 * 60_000).toISOString() }));
    expect(await migrationFenceState(f.bucket, PREFIX, () => {})).toBe('stale');
  });
  it('a stop that leaves the runtime running is a stop failure and removes the flag', async () => {
    const f = await makeFake();
    f.fake.stop = async () => {};
    f.fake.ctx.container.monitor = async () => {};
    expect(await f.fake.beginMigrationExport()).toEqual({ ok: false, reason: 'stop_failed' });
    expect(f.objects.has(FLAG)).toBe(false);
  });
  it('stop failure removes the flag and permits start and flush again', async () => {
    const f = await makeFake();
    f.fake.stop = async () => { throw new Error('synthetic stop failure'); };
    expect(await f.fake.beginMigrationExport()).toEqual({ ok: false, reason: 'stop_failed' });
    expect(f.objects.has(FLAG)).toBe(false);
    expect((await flush(f)).ok).toBe(true);
    expect(await start(f.fake)).toBe(1);
  });
});
