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
    stop: async () => void calls.stops++,
    listSchedules: async () => [],
    deleteSchedules: () => undefined,
    schedule: async (seconds: number) => void calls.scheduled.push(seconds),
  });
  return { fake, store, objects, calls, bucket };
}

const SYSTEM_OUTCOMES: Array<[string, SysCapture, boolean]> = [
  ['failed', { exitCode: 1, stdout: '' }, true],
  ['busy', { exitCode: 0, stdout: '{"skipped":"busy"}' }, true],
  ['not_restored', { exitCode: 0, stdout: '{"skipped":"not_restored"}' }, true],
  ['stale', { exitCode: 0, stdout: '{"expectedGeneration":"another-writer"}' }, true],
  ['too_large', { exitCode: 3, stdout: '' }, false],
  ['no_baseline', { exitCode: 0, stdout: '{"skipped":"no_baseline"}' }, false],
  ['no_manifest', { exitCode: 0, stdout: '{"skipped":"no_manifest"}' }, false],
];

describe('flush-blocks-stop: a final system checkpoint that saved nothing keeps the computer up', () => {
  for (const [reason, sysCapture, blocks] of SYSTEM_OUTCOMES) {
    it(`idle-stop with a ${reason} system checkpoint ${blocks ? 'reschedules instead of stopping' : 'stops'}`, async () => {
      const { fake, calls } = await makeFake({ sysCapture, idle: true });
      await (await proto()).flushWorkspaceScheduled.call(fake);
      if (blocks) {
        expect(calls.stops).toBe(0);
        expect(calls.scheduled.length).toBeGreaterThan(0);
      } else {
        expect(calls.stops).toBe(1);
      }
    });
    it(`teardown with a ${reason} system checkpoint ${blocks ? 'is refused' : 'proceeds'}`, async () => {
      const { fake } = await makeFake({ sysCapture });
      const p = await proto();
      const base = Object.getPrototypeOf(p); const original = base.destroy;
      base.destroy = async function (this: { ctx: { container: { running: boolean } } }) { this.ctx.container.running = false; };
      try {
        const report = await p.terminateSandbox.call(fake) as { ok: boolean; outcome?: string; error?: string };
        if (blocks) expect(report).toMatchObject({ ok: false, outcome: 'flush_failed', error: 'system_checkpoint_failed' });
        else expect(report.outcome).not.toBe('flush_failed');
      } finally { base.destroy = original; }
    });
  }
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
    await (await proto()).runWorkspaceFlush.call(fake, 'explicit' as never); // late Cloudflare checkpoint
    expect(objects.get(HEAD)!.etag).not.toBe(begun.head.etag);
    expect(await (await proto()).commitMigration.call(fake, { targetProvider: 'aws-ec2', expectedEtag: begun.head.etag, expectedSystemEtag: begun.systemEtag } as never))
      .toEqual({ ok: false, reason: 'head_moved' });
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
