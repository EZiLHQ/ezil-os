/**
 * EXECUTED (not grepped) tests for the periodic workspace-flush loop's
 * lifecycle — the fix for a defect that PRODUCTION MEASUREMENT found and a
 * fully green test suite did not.
 *
 * ## What was measured
 *
 * `wrangler tail` against a live Worker version captured a complete container
 * boot (`container_start`, `workspace_hydrate`, `desktop_ready_wait`,
 * `desktop_port_expose` all present, so the tail was genuinely attached).
 * EVERY `workspace_flush` line read `trigger=explicit`; not one read
 * `trigger=alarm`; not one `load1=` probe ever ran. The periodic flush loop
 * was dead. Consequences, worst first:
 *
 *   1. 🔴 No periodic workspace flush at all — the workspace only persisted on
 *      an explicit flush. `docs/PLATFORM-NOTES.md` §8: containers have NO
 *      guaranteed lifetime and hosts restart without notice even mid-session,
 *      so persistence has to be continuous and eager. This was live data-loss
 *      exposure.
 *   2. The idle-stop that cuts the container bill never ran either — a
 *      just-deployed fix, completely inert.
 *
 * ## Why the old suite could not see it
 *
 * Every assertion about this loop was a source-text grep (see
 * `workspace-idle.test.ts`'s module doc: "`EzilSandboxDO` is never
 * instantiated"). Greps can pin the shape of a decision; they cannot notice
 * that the decision is never REACHED. The loop-start gate read a boolean in DO
 * storage that had gone permanently out of sync with the scheduler, and no
 * amount of reading the source of the code below that gate could show it.
 *
 * So this file executes the real methods. `EzilSandboxDO` still cannot be
 * CONSTRUCTED under `bun test` (its base class wants the Workers runtime), but
 * it does not need to be: with `cloudflare:workers` stubbed the same way
 * `route-auth.test.ts` stubs it, the class object exists, and every method
 * under test reaches its collaborators through `this`. Calling
 * `Sandbox.prototype.<method>.call(fake, ...)` therefore runs the GENUINE
 * production body — the real ordering, the real guards, the real
 * `flushWorkspaceToR2` — against a recording fake. "The guard was never
 * reached" becomes an assertion instead of an inference.
 *
 * ## Mutation evidence
 *
 * Every guard below was mutation-proved by machine, not by hand: each mutation
 * was applied to `index.ts`, `bun test src/workspace-flush-loop.test.ts
 * src/workspace-idle.test.ts` was run, the failures recorded, and the source
 * restored (verified by md5). All fifteen went RED.
 *
 *   M1  the pre-fix gate restored verbatim (sticky flag read, legacy key not
 *       deleted)                          -> 5 red, incl. the headline regression
 *   M2  `workspaceFlushLoopIsAlive` loses its staleness component  -> 4 red
 *   M3  ...loses its `Number.isFinite` guard                       -> 1 red
 *   M4  an unanswerable `listSchedules` reports ALIVE              -> 1 red
 *   M5  the restart path stops clearing stale schedule debris      -> 1 red
 *   M6  the legacy flag is no longer deleted on hydrate            -> 1 red
 *   M7  `runWorkspaceFlush` lets a thrown container RPC escape     -> 2 red
 *   M8  the survival wrapper stops re-arming the loop              -> 1 red
 *   M9  the terminate tombstone check is removed                   -> 2 red
 *   M10 the `containerIsRunning()` gate is removed                 -> 3 red
 *   M11 the idle stop no longer requires `outcome.ok`              -> 3 red
 *   M12 the idle branch flushes with `trigger='explicit'`          -> 7 red
 *   M13 the idle stop writes `WORKSPACE_TERMINATED_KEY`            -> 2 red
 *   M14 SIGNAL B (the busy probe's verdict) is ignored             -> 6 red
 *   M15 `cancelWorkspaceFlushLoop` stops dropping the schedule row -> 1 red
 *
 * M3 is worth singling out: its FIRST form passed both ways. `NaN` and a
 * non-numeric string already fall out of the `>` comparison on their own, so
 * the `Number.isFinite` guard looked redundant until the case that actually
 * needs it — `Infinity`, which compares greater than everything — was added.
 * A test that passes with and without the guard is worse than no test, and
 * this file contains one fewer of those than it did an hour ago.
 */

import { describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';

// Must be registered before `./index.ts` is imported — see `route-auth.test.ts`.
mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

// ── DO storage keys, spelled out on purpose ──────────────────────────────────
// These are the on-the-wire storage keys, not imports: hard-coding them means a
// rename that would strand a live sandbox's state shows up here as a failure.
const HYDRATED_KEY = 'ezil:workspaceHydrated';
const FLUSH_CONTEXT_KEY = 'ezil:workspaceFlushContext';
const TERMINATED_KEY = 'ezil:workspaceTerminated';
const LAST_ACTIVITY_AT_KEY = 'ezil:lastActivityAt';
const BACKOFF_SECONDS_KEY = 'ezil:workspaceFlushBackoffSeconds';
/** The boolean whose staleness caused the incident. Nothing may read it any more. */
const LEGACY_LOOP_STARTED_KEY = 'ezil:workspaceFlushLoopStarted';

const FLUSH_CALLBACK = 'flushWorkspaceScheduled';
const IDLE_STOP_MS = 10 * 60_000;
const MOUNT_PATH = '/workspace';
const PREFIX = 'proj-1/branches/main';

interface ScheduleRow {
  taskId: string;
  callback: string;
  /** UNIX SECONDS, exactly as `@cloudflare/containers` stores it. */
  time: number;
}

interface FakeOptions {
  /** Rows `listSchedules(name)` should report as already pending. */
  pending?: ScheduleRow[];
  /** Make `listSchedules` reject, to test the "cannot answer" direction. */
  listSchedulesThrows?: boolean;
  /** `ctx.container.running`. */
  running?: boolean;
  /** `/proc/loadavg` line the busy probe should observe. */
  loadavg?: string;
  /** Make the busy probe's `exec` reject. */
  execThrows?: boolean;
  /** Files the container reports under the mount path. */
  files?: Array<{ name: string; size: number; modifiedAt: string }>;
  /** Make `listFiles` reject — i.e. a container that went away mid-cycle. */
  listFilesThrows?: boolean;
  /** Make the R2 `put` reject, so the flush reports a real failure. */
  bucketPutThrows?: boolean;
  editorCaptureFails?: boolean;
  physicalWorkspaceMissing?: boolean;
  /** Seed values for DO storage. */
  storage?: Record<string, unknown>;
}

interface FakeDO {
  ctx: { storage: Map<string, unknown>; container: { running: boolean } };
  calls: {
    scheduled: Array<{ seconds: number; callback: string }>;
    deleteSchedules: string[];
    listSchedules: string[];
    stops: number;
    destroys: number;
    execs: string[];
    r2Puts: string[];
  };
}

/**
 * Build a recording stand-in for the Durable Object.
 *
 * 🔴 The object INHERITS FROM `EzilSandboxDO.prototype`, and only the SDK's own
 * I/O surface is shadowed by own properties (`schedule`, `listSchedules`,
 * `deleteSchedules`, `exec`, `stop`, `destroy`, and the file RPCs). Every
 * method this package actually wrote — `recordWorkspaceHydration`,
 * `flushWorkspaceScheduled`, `runScheduledFlushCycle`, `runWorkspaceFlush`,
 * `workspaceFlushLoopAlive`, `containerIsRunning`, `probeContainerBusy`,
 * `nextFlushRescheduleSeconds` — runs for real. If a production method were
 * missing from the prototype the call would throw rather than quietly no-op,
 * which is the property that makes these assertions worth anything.
 */
async function makeFake(opts: FakeOptions = {}): Promise<FakeDO & Record<string, unknown>> {
  const store = new Map<string, unknown>(Object.entries(opts.storage ?? {}));
  const calls: FakeDO['calls'] = {
    scheduled: [],
    deleteSchedules: [],
    listSchedules: [],
    stops: 0,
    destroys: 0,
    execs: [],
    r2Puts: [],
  };
  let pending = [...(opts.pending ?? [])];
  const files = opts.files ?? [];

  const fake = Object.assign(Object.create(await loadPrototype()) as object, {
    ctx: {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => void store.set(key, value),
        delete: async (key: string) => void store.delete(key),
      },
      container: { running: opts.running ?? true },
    },
    env: {
      SANDBOX_WORKSPACE_R2_BUCKET: {
        get: async () => null,
        put: async (key: string) => {
          if (opts.bucketPutThrows) throw new Error('r2 unavailable');
          calls.r2Puts.push(key);
          return { etag: "test-etag" };
        },
      },
    },

    // ── scheduler surface (the SDK's, faked) ──
    listSchedules: async (name: string) => {
      calls.listSchedules.push(name);
      if (opts.listSchedulesThrows) throw new Error('sql unavailable');
      return pending.filter((row) => row.callback === name);
    },
    deleteSchedules: (name: string) => {
      calls.deleteSchedules.push(name);
      pending = pending.filter((row) => row.callback !== name);
    },
    schedule: async (seconds: number, callback: string) => {
      calls.scheduled.push({ seconds, callback });
      pending.push({ taskId: `t${calls.scheduled.length}`, callback, time: Math.floor(Date.now() / 1000 + seconds) });
    },

    // ── container surface ──
    stop: async () => void calls.stops++,
    destroy: async () => void calls.destroys++,
    exec: async (command: string) => {
      calls.execs.push(command);
      if (command.startsWith('bash /usr/local/bin/editor-state.sh capture ')) {
        return { exitCode: opts.editorCaptureFails ? 1 : 0, stdout: '' };
      }
      if (command.startsWith('python3 ')) {
        if (command.includes('"op":"check"') && opts.physicalWorkspaceMissing) {
          return { exitCode: 4, stdout: '' };
        }
        if (command.includes('"op":"capture"')) {
          if (opts.listFilesThrows) throw new Error('container RPC failed: connection reset');
          const sha256 = createHash('sha256').update('hello').digest('hex');
          return { exitCode: 0, stdout: JSON.stringify({ sha256, entries: files.length, chunks: [{ size: 5, sha256 }] }) };
        }
        return { exitCode: 0, stdout: '' };
      }
      if (opts.execThrows) throw new Error('container gone');
      return { exitCode: 0, stdout: opts.loadavg ?? '0.00 0.01 0.05 1/123 456\n' };
    },
    exists: async () => ({ exists: false }),
    readFile: async () => ({ content: Buffer.from('hello').toString('base64'), encoding: 'base64' }),
    writeFile: async () => ({ success: true }),
    listFiles: async () => {
      if (opts.listFilesThrows) throw new Error('container RPC failed: connection reset');
      return { files: files.map((f) => ({ ...f, type: 'file' as const })) };
    },
  });

  // Expose the raw map for assertions without widening the surface the
  // production code sees.
  return Object.assign(fake, { calls, __store: store }) as unknown as FakeDO & Record<string, unknown>;
}

function storeOf(fake: unknown): Map<string, unknown> {
  return (fake as { __store: Map<string, unknown> }).__store;
}

type AnyFn = (this: unknown, ...args: never[]) => Promise<unknown>;

async function loadPrototype(): Promise<Record<string, AnyFn>> {
  const mod = (await import('./index')) as unknown as { Sandbox: { prototype: Record<string, AnyFn> } };
  return mod.Sandbox.prototype;
}

async function hydrate(fake: unknown, hydrated = true): Promise<void> {
  const proto = await loadPrototype();
  await (proto.recordWorkspaceHydration as (this: unknown, p: unknown) => Promise<void>).call(fake, {
    prefix: PREFIX,
    mountPath: MOUNT_PATH,
    hydrated,
  });
}

async function runAlarmCycle(fake: unknown): Promise<void> {
  const proto = await loadPrototype();
  await (proto.flushWorkspaceScheduled as (this: unknown) => Promise<void>).call(fake);
}

/** Storage a sandbox has once it has hydrated at least once. */
function hydratedStorage(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [HYDRATED_KEY]: true,
    [FLUSH_CONTEXT_KEY]: { prefix: PREFIX, mountPath: MOUNT_PATH },
    [LAST_ACTIVITY_AT_KEY]: Date.now(),
    ...extra,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 🔴 THE REGRESSION: the exact production scenario
// ════════════════════════════════════════════════════════════════════════════

describe('🔴 REGRESSION: a boot restarts the flush loop whenever nothing is actually pending', () => {
  it('restarts the loop even though the legacy "already started" flag says true', async () => {
    // The measured production state, reproduced exactly: DO storage carries
    // `ezil:workspaceFlushLoopStarted === true` from an earlier container
    // generation, and NO schedule row is pending because that generation's
    // loop died. Under the old gate this boot returned early and the sandbox
    // never flushed periodically again — for the rest of its existence.
    const fake = await makeFake({ storage: { [LEGACY_LOOP_STARTED_KEY]: true }, pending: [] });

    await hydrate(fake);

    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });

  it('restarts the loop when the pending row is real but hopelessly past due (a row nobody will run is not a loop)', async () => {
    const fake = await makeFake({
      storage: { [LEGACY_LOOP_STARTED_KEY]: true },
      pending: [{ taskId: 'stale', callback: FLUSH_CALLBACK, time: Math.floor(Date.now() / 1000) - 3600 }],
    });

    await hydrate(fake);

    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
    // And the debris is cleared first, so the restart leaves exactly one loop.
    expect(fake.calls.deleteSchedules).toEqual([FLUSH_CALLBACK]);
  });

  it('does NOT double-schedule when a healthy cycle really is pending', async () => {
    const fake = await makeFake({
      pending: [{ taskId: 'live', callback: FLUSH_CALLBACK, time: Math.floor(Date.now() / 1000) + 8 }],
    });

    await hydrate(fake);

    expect(fake.calls.scheduled).toEqual([]);
    expect(fake.calls.deleteSchedules).toEqual([]);
  });

  it('reads liveness from the scheduler, not from storage — the legacy flag is deleted, never consulted', async () => {
    const fake = await makeFake({ storage: { [LEGACY_LOOP_STARTED_KEY]: true } });

    await hydrate(fake);

    expect(fake.calls.listSchedules).toEqual([FLUSH_CALLBACK]);
    expect(storeOf(fake).has(LEGACY_LOOP_STARTED_KEY)).toBe(false);
  });

  it('starts the loop when a schedule row exists for some OTHER callback', async () => {
    const fake = await makeFake({
      pending: [{ taskId: 'other', callback: 'someOtherCallback', time: Math.floor(Date.now() / 1000) + 30 }],
    });

    await hydrate(fake);

    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });

  it('starts the loop when the scheduler cannot be asked at all (an unanswerable probe never disables persistence)', async () => {
    const fake = await makeFake({ listSchedulesThrows: true, storage: { [LEGACY_LOOP_STARTED_KEY]: true } });

    await hydrate(fake);

    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });

  it('a failed hydrate still starts nothing (flushing an unhydrated workspace is the delete hazard)', async () => {
    const fake = await makeFake();

    await hydrate(fake, false);

    expect(fake.calls.scheduled).toEqual([]);
  });

  it('the restart resets the backoff ladder so a new generation starts at the 10s cadence', async () => {
    const fake = await makeFake({ storage: { [BACKOFF_SECONDS_KEY]: 60 } });

    await hydrate(fake);

    expect(storeOf(fake).has(BACKOFF_SECONDS_KEY)).toBe(false);
    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The pure liveness decision
// ════════════════════════════════════════════════════════════════════════════

describe('workspaceFlushLoopIsAlive', () => {
  const nowMs = 1_800_000_000_000;
  const sec = (msFromNow: number) => Math.floor((nowMs + msFromNow) / 1000);

  it('is false with no pending schedules at all', async () => {
    const { workspaceFlushLoopIsAlive } = await import('./index');
    expect(workspaceFlushLoopIsAlive({ pendingSchedules: [], nowMs })).toBe(false);
  });

  it('is true for a schedule due in the future', async () => {
    const { workspaceFlushLoopIsAlive } = await import('./index');
    expect(workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: sec(10_000) }], nowMs })).toBe(true);
  });

  it('is true for a schedule slightly past due — alarm delivery is not instantaneous', async () => {
    const { workspaceFlushLoopIsAlive } = await import('./index');
    expect(workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: sec(-30_000) }], nowMs })).toBe(true);
  });

  it('is true just inside the 5-minute staleness horizon', async () => {
    const { workspaceFlushLoopIsAlive } = await import('./index');
    expect(workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: sec(-5 * 60_000 + 1_000) }], nowMs })).toBe(true);
  });

  it('is false at and beyond the 5-minute staleness horizon', async () => {
    const { workspaceFlushLoopIsAlive } = await import('./index');
    expect(workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: sec(-5 * 60_000) }], nowMs })).toBe(false);
    expect(workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: sec(-60 * 60_000) }], nowMs })).toBe(false);
  });

  it('stays below IDLE_STOP_MS, so it can never resurrect a loop the idle path just retired', async () => {
    const { workspaceFlushLoopIsAlive } = await import('./index');
    // A row exactly IDLE_STOP_MS old must already read as dead.
    expect(workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: sec(-IDLE_STOP_MS) }], nowMs })).toBe(false);
  });

  it('treats a row with a non-finite time as debris, not as a live loop', async () => {
    const { workspaceFlushLoopIsAlive } = await import('./index');
    expect(workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: Number.NaN }], nowMs })).toBe(false);
    expect(
      workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: 'soon' as unknown as number }], nowMs }),
    ).toBe(false);
    // 🔴 Infinity is the case the explicit `Number.isFinite` guard exists for,
    // and the only one: NaN and a non-numeric string both fall out of the
    // comparison as `false` on their own, but `Infinity * 1000 > anything` is
    // TRUE. Without the guard a single corrupt row would read as a live loop
    // forever and no boot would ever restart persistence again — the exact
    // shape of the bug this whole change exists to end.
    expect(workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: Number.POSITIVE_INFINITY }], nowMs })).toBe(false);
    expect(workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: Number.NEGATIVE_INFINITY }], nowMs })).toBe(false);
  });

  it('one live row among stale ones is enough', async () => {
    const { workspaceFlushLoopIsAlive } = await import('./index');
    expect(
      workspaceFlushLoopIsAlive({ pendingSchedules: [{ time: sec(-3_600_000) }, { time: sec(5_000) }], nowMs }),
    ).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The alarm cycle must survive its own failures
// ════════════════════════════════════════════════════════════════════════════

describe('flushWorkspaceScheduled: the loop survives a failing cycle', () => {
  it('🔴 a container RPC that THROWS mid-flush still reschedules (the SDK deletes the row and never re-arms it for us)', async () => {
    const fake = await makeFake({ running: true, listFilesThrows: true, storage: hydratedStorage() });

    await runAlarmCycle(fake);

    // 30s, not 10s, and that difference is the point: 30 is the backoff
    // ladder's second rung, reachable ONLY from the normal end of the cycle
    // (`nextFlushRescheduleSeconds` on an outcome that wrote nothing). A 10
    // here would mean the throw escaped to the survival wrapper instead of
    // being converted into a failed outcome — i.e. the same assertion passing
    // for the wrong reason.
    expect(fake.calls.scheduled).toEqual([{ seconds: 30, callback: FLUSH_CALLBACK }]);
  });

  it('🔴 a throw from the very first storage read still reschedules — this one IS the survival wrapper', async () => {
    const fake = await makeFake({ storage: hydratedStorage() });
    (fake as unknown as { ctx: { storage: { get: () => Promise<never> } } }).ctx.storage.get = async () => {
      throw new Error('storage unavailable');
    };

    await runAlarmCycle(fake);

    // Nothing downstream ran, so the base interval here can only have come
    // from the wrapper's `catch`.
    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
    expect(fake.calls.r2Puts).toEqual([]);
  });

  it('a flush that throws is reported as a FAILED outcome, never as a successful one', async () => {
    const proto = await loadPrototype();
    const fake = await makeFake({ listFilesThrows: true, storage: hydratedStorage() });
    const outcome = (await (proto.flushWorkspaceNow as (this: unknown) => Promise<unknown>).call(fake)) as {
      ok: boolean;
      skippedReason?: string;
      uploaded: string[];
      failed: unknown[];
    };

    expect(outcome.ok).toBe(false);
    expect(outcome.failed.length).toBe(1);
    expect(outcome.uploaded).toEqual([]);
  });

  it('a healthy cycle flushes and reschedules', async () => {
    const fake = await makeFake({
      storage: hydratedStorage(),
      files: [{ name: 'a.ts', size: 5, modifiedAt: '2026-08-01T00:00:00.000Z' }],
    });

    await runAlarmCycle(fake);

    expect(fake.calls.r2Puts).toContain(`${PREFIX}/.ezil-snapshots/latest.json`);
    // A cycle that actually wrote something stays on the base cadence.
    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Invariants that predate this fix and must survive it — now EXECUTED
// ════════════════════════════════════════════════════════════════════════════

describe('preserved invariant: a terminated sandbox is never resurrected', () => {
  it('a tombstoned sandbox neither flushes, nor stops, nor reschedules', async () => {
    const fake = await makeFake({ running: true, storage: hydratedStorage({ [TERMINATED_KEY]: true }) });

    await runAlarmCycle(fake);

    expect(fake.calls.r2Puts).toEqual([]);
    expect(fake.calls.execs).toEqual([]);
    expect(fake.calls.scheduled).toEqual([]);
    expect(fake.calls.stops).toBe(0);
  });

  it('the tombstone is checked BEFORE the container is consulted — a tombstoned sandbox is refused even while running', async () => {
    const fake = await makeFake({
      running: true,
      storage: hydratedStorage({ [TERMINATED_KEY]: true, [LAST_ACTIVITY_AT_KEY]: Date.now() - 2 * IDLE_STOP_MS }),
      files: [{ name: 'a.ts', size: 5, modifiedAt: '2026-08-01T00:00:00.000Z' }],
    });

    await runAlarmCycle(fake);

    // Idle by a mile and running — every downstream branch would have done
    // something. None of them ran.
    expect(fake.calls.execs).toEqual([]);
    expect(fake.calls.r2Puts).toEqual([]);
    expect(fake.calls.stops).toBe(0);
  });

  it('terminateSandbox\'s cancel path tombstones AND drops the pending schedule row', async () => {
    const proto = await loadPrototype();
    const fake = await makeFake({ pending: [{ taskId: 'live', callback: FLUSH_CALLBACK, time: Math.floor(Date.now() / 1000) + 5 }] });

    await (proto.cancelWorkspaceFlushLoop as (this: unknown) => Promise<void>).call(fake);

    expect(storeOf(fake).get(TERMINATED_KEY)).toBe(true);
    expect(fake.calls.deleteSchedules).toEqual([FLUSH_CALLBACK]);
    // And with the row gone, liveness now reads dead — which is exactly what
    // makes "no reschedule" a sufficient stop signal.
    expect(await (fake as unknown as { listSchedules: (n: string) => Promise<unknown[]> }).listSchedules(FLUSH_CALLBACK)).toEqual([]);
  });
});

describe('preserved invariant: never touch a container that is not running', () => {
  it('a stopped container is neither flushed, nor probed, nor rescheduled', async () => {
    const fake = await makeFake({
      running: false,
      storage: hydratedStorage({ [LAST_ACTIVITY_AT_KEY]: Date.now() - 2 * IDLE_STOP_MS }),
      files: [{ name: 'a.ts', size: 5, modifiedAt: '2026-08-01T00:00:00.000Z' }],
    });

    await runAlarmCycle(fake);

    expect(fake.calls.r2Puts).toEqual([]);
    expect(fake.calls.execs).toEqual([]);
    expect(fake.calls.stops).toBe(0);
    expect(fake.calls.scheduled).toEqual([]);
  });

  it('the loop restarts on the next boot after a stopped-container cycle retired it', async () => {
    const fake = await makeFake({ running: false, storage: hydratedStorage() });
    await runAlarmCycle(fake);
    expect(fake.calls.scheduled).toEqual([]);

    // The SDK deletes the row it just ran; the fake's `pending` is already
    // empty here, which is the same observable state. A boot must recover.
    fake.ctx.container.running = true;
    await hydrate(fake);

    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });
});

describe('preserved invariant: the alarm never bumps LAST_ACTIVITY_AT_KEY', () => {
  it('a full alarm cycle leaves the activity timestamp untouched', async () => {
    const activityAt = Date.now() - 3 * 60_000;
    const fake = await makeFake({
      storage: hydratedStorage({ [LAST_ACTIVITY_AT_KEY]: activityAt }),
      files: [{ name: 'a.ts', size: 5, modifiedAt: '2026-08-01T00:00:00.000Z' }],
    });

    await runAlarmCycle(fake);

    expect(fake.calls.r2Puts.length).toBeGreaterThan(0); // it really did flush
    expect(storeOf(fake).get(LAST_ACTIVITY_AT_KEY)).toBe(activityAt);
  });

  it('the idle-stop cycle does not bump it either — an idle stop must not look like activity', async () => {
    const activityAt = Date.now() - 2 * IDLE_STOP_MS;
    const fake = await makeFake({ storage: hydratedStorage({ [LAST_ACTIVITY_AT_KEY]: activityAt }) });

    await runAlarmCycle(fake);

    expect(fake.calls.stops).toBe(1); // it really did take the idle path
    expect(storeOf(fake).get(LAST_ACTIVITY_AT_KEY)).toBe(activityAt);
  });

  it('an EXPLICIT flush does bump it (the trigger split is real, not decorative)', async () => {
    const proto = await loadPrototype();
    const activityAt = Date.now() - 3 * 60_000;
    const fake = await makeFake({ storage: hydratedStorage({ [LAST_ACTIVITY_AT_KEY]: activityAt }) });

    await (proto.flushWorkspaceNow as (this: unknown) => Promise<unknown>).call(fake);

    expect(storeOf(fake).get(LAST_ACTIVITY_AT_KEY)).not.toBe(activityAt);
  });
});

describe('preserved invariant: final flush before stop, and stop only if it worked', () => {
  const idleStorage = () => hydratedStorage({ [LAST_ACTIVITY_AT_KEY]: Date.now() - 2 * IDLE_STOP_MS });

  it('captures editor settings before snapshot creation and refuses stop when capture fails', async () => {
    const fake = await makeFake({ storage: idleStorage(), editorCaptureFails: true });
    await runAlarmCycle(fake);
    expect(fake.calls.execs.some(c => c.startsWith('bash /usr/local/bin/editor-state.sh capture '))).toBe(true);
    expect(fake.calls.execs.some(c => c.startsWith('python3 ') && c.includes('"op":"capture"'))).toBe(false);
    expect(fake.calls.r2Puts).toEqual([]);
    expect(fake.calls.stops).toBe(0);
    expect(fake.calls.scheduled.length).toBeGreaterThan(0);

    const ok = await makeFake({ storage: idleStorage() });
    await runAlarmCycle(ok);
    const editor = ok.calls.execs.findIndex(c => c.startsWith('bash /usr/local/bin/editor-state.sh capture '));
    const snapshot = ok.calls.execs.findIndex(c => c.startsWith('python3 ') && c.includes('"op":"capture"'));
    expect(editor).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(editor);
    expect(ok.calls.stops).toBe(1);
  });

  it('an idle, quiet container is flushed and THEN stopped', async () => {
    const fake = await makeFake({
      storage: idleStorage(),
      files: [{ name: 'a.ts', size: 5, modifiedAt: '2026-08-01T00:00:00.000Z' }],
    });

    await runAlarmCycle(fake);

    expect(fake.calls.r2Puts).toContain(`${PREFIX}/.ezil-snapshots/latest.json`);
    expect(fake.calls.stops).toBe(1);
    expect(fake.calls.destroys).toBe(0);
    expect(fake.calls.scheduled).toEqual([]); // retired, not rescheduled
  });

  it('🔴 a FAILED final flush does NOT stop the container — it retries at the base interval', async () => {
    const fake = await makeFake({
      storage: idleStorage(),
      files: [{ name: 'a.ts', size: 5, modifiedAt: '2026-08-01T00:00:00.000Z' }],
      bucketPutThrows: true,
    });

    await runAlarmCycle(fake);

    expect(fake.calls.stops).toBe(0);
    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });

  it('🔴 a final flush that THROWS does not stop the container either', async () => {
    const fake = await makeFake({ storage: idleStorage(), listFilesThrows: true });

    await runAlarmCycle(fake);

    // The busy probe having run proves the idle branch really was taken, so
    // the surviving reschedule below is the idle-retry path rather than the
    // wrapper swallowing an early throw.
    expect(fake.calls.execs.filter(c => !c.startsWith('python3 ') && !c.startsWith('bash /usr/local/bin/editor-state.sh')).length).toBe(1);
    expect(fake.calls.stops).toBe(0);
    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });

  it('a BUSY container is not stopped, not flushed, and is re-asked at the base interval', async () => {
    const fake = await makeFake({ storage: idleStorage(), loadavg: '3.50 2.10 1.00 4/123 456\n' });

    await runAlarmCycle(fake);

    expect(fake.calls.stops).toBe(0);
    expect(fake.calls.r2Puts).toEqual([]);
    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
    expect(storeOf(fake).get(BACKOFF_SECONDS_KEY)).toBe(10);
  });

  it('a busy probe that cannot answer counts as BUSY — nothing is stopped on a guess', async () => {
    const fake = await makeFake({ storage: idleStorage(), execThrows: true });

    await runAlarmCycle(fake);

    expect(fake.calls.stops).toBe(0);
    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });
});

describe('preserved invariant: idle-stop is NOT termination', () => {
  it('an idle stop never writes the terminate tombstone, and the next boot restarts the loop normally', async () => {
    const fake = await makeFake({ storage: hydratedStorage({ [LAST_ACTIVITY_AT_KEY]: Date.now() - 2 * IDLE_STOP_MS }) });

    await runAlarmCycle(fake);
    expect(fake.calls.stops).toBe(1);
    expect(storeOf(fake).has(TERMINATED_KEY)).toBe(false);

    // The next `/sandbox/preview` boots this sandbox like any other cold start.
    fake.ctx.container.running = true;
    await hydrate(fake);

    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });

  it('a hydrate clears an existing tombstone (a re-created sandbox must not stay disabled forever)', async () => {
    const fake = await makeFake({ storage: { [TERMINATED_KEY]: true } });

    await hydrate(fake);

    expect(storeOf(fake).has(TERMINATED_KEY)).toBe(false);
    expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
  });
});

describe('explicit termination requires a confirmed checkpoint', () => {
  it('checks physical hydration before editor capture and never commits an empty replacement', async () => {
    const fake = await makeFake({ storage: hydratedStorage(), physicalWorkspaceMissing: true, editorCaptureFails: true });
    const proto = await loadPrototype();
    const result = await proto.runWorkspaceFlush.call(fake, 'explicit' as never) as { skippedReason?: string };
    expect(result.skippedReason).toBe('container_not_hydrated');
    expect(fake.calls.execs.some(c => c.startsWith('bash /usr/local/bin/editor-state.sh'))).toBe(false);
    expect(fake.calls.r2Puts).toEqual([]);
    expect(storeOf(fake).get(HYDRATED_KEY)).toBe(false);
  });
  it('does not wake stopped containers for Code or screen requests, including queued traffic', async () => {
    const fake = await makeFake({ running: true });
    const proto = await loadPrototype();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = proto.withRuntimeMutation as (this: unknown, op: () => Promise<unknown>) => Promise<unknown>;
    const stop = lock.call(fake, async () => { await gate; fake.ctx.container.running = false; });
    const forward = proto.runningContainerFetch as (this: unknown, url: string) => Promise<Response>;
    const pending = forward.call(fake, 'http://127.0.0.1:8181/api/login');
    release(); await stop;
    expect((await pending).status).toBe(409);
    const request = new Request('http://127.0.0.1:8443/', {
      headers: { 'x-ezil-running-code': '1', 'cf-container-target-port': '8443', upgrade: 'websocket' },
    });
    expect((await (proto.fetch as (this: unknown, request: Request) => Promise<Response>).call(fake, request)).status).toBe(409);
    expect(fake.calls.execs).toEqual([]);
  });
  for (const options of [
    { bucketPutThrows: true, storage: hydratedStorage() },
    { listFilesThrows: true, storage: hydratedStorage() },
    { storage: {} },
    { storage: hydratedStorage({ [HYDRATED_KEY]: false }) },
  ]) {
    it(`refuses failed or unavailable persistence: ${JSON.stringify(Object.keys(options))}`, async () => {
      const fake = await makeFake(options);
      const proto = await loadPrototype();
      const result = await proto.terminateSandbox.call(fake) as { ok: boolean; outcome: string; terminated: boolean };
      expect(result).toMatchObject({ ok: false, outcome: 'flush_failed', terminated: false });
      expect(fake.calls.destroys).toBe(0);
      expect(fake.calls.deleteSchedules).toEqual([]);
      expect(storeOf(fake).has(TERMINATED_KEY)).toBe(false);
    });
  }
  it('bare destroy uses the same refusal instead of bypassing the final flush', async () => {
    const fake = await makeFake({ bucketPutThrows: true, storage: hydratedStorage() });
    const proto = await loadPrototype();
    await expect(proto.destroy.call(fake)).rejects.toThrow('workspace_checkpoint_failed');
    expect(storeOf(fake).has(TERMINATED_KEY)).toBe(false);
  });
  it('serializes persistence operations, including after a failed operation', async () => {
    const fake = await makeFake(); const proto = await loadPrototype();
    const events: string[] = []; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = proto.withWorkspacePersistence as (this: unknown, op: () => Promise<unknown>) => Promise<unknown>;
    const first = lock.call(fake, async () => { events.push('first'); await gate; throw new Error('expected'); });
    const second = lock.call(fake, async () => { events.push('second'); });
    await Promise.resolve(); await Promise.resolve(); expect(events).toEqual(['first']);
    release(); await expect(first).rejects.toThrow('expected'); await second;
    expect(events).toEqual(['first', 'second']);
  });
  it('destroys only after a successful checkpoint and observes the stopped container', async () => {
    const fake = await makeFake({ storage: hydratedStorage() }); const proto = await loadPrototype();
    const base = Object.getPrototypeOf(proto); const original = base.destroy;
    base.destroy = async function(this: typeof fake) {
      expect(this.calls.r2Puts).toContain(`${PREFIX}/.ezil-snapshots/latest.json`);
      this.calls.destroys++; this.ctx.container.running = false;
    };
    try {
      expect(await proto.terminateSandbox.call(fake)).toMatchObject({ ok: true, terminated: true, outcome: 'destroyed' });
      expect(fake.calls.destroys).toBe(1); expect(storeOf(fake).get(TERMINATED_KEY)).toBe(true);
    } finally { base.destroy = original; }
  });
});

it('keeps the desktop alive when user activity arrives during the final idle checkpoint', async () => {
  const fake = await makeFake({ storage: hydratedStorage({ [LAST_ACTIVITY_AT_KEY]: Date.now() - 2 * IDLE_STOP_MS }) });
  const original = fake.exec as (command: string) => Promise<unknown>;
  fake.exec = async (command: string) => {
    const result = await original(command);
    if (command.includes('"op":"confirm"')) storeOf(fake).set(LAST_ACTIVITY_AT_KEY, Date.now());
    return result;
  };
  await runAlarmCycle(fake);
  expect(fake.calls.stops).toBe(0);
  expect(fake.calls.scheduled).toEqual([{ seconds: 10, callback: FLUSH_CALLBACK }]);
});

// Production 2026-10-04: every open ran two ~3 s checkpoints, serialized on the
// DO, while the shell re-asked every 1.5 s per window — ~30 previews in 3
// minutes at 30-62 s each, until "Try again". Opens now share ONE readiness
// checkpoint and reuse one that just succeeded; the alarm loop never reuses.
describe('readiness checkpoint coalescing (open path only)', () => {
  const captures = (fake: FakeDO) => fake.calls.execs.filter((c) => c.includes('"op":"capture"')).length;
  const flushNow = async (fake: unknown) => {
    const proto = await loadPrototype();
    return (await (proto.flushWorkspaceNow as (this: unknown) => Promise<unknown>).call(fake)) as { ok: boolean };
  };

  it('concurrent opens share one checkpoint, and every one of them is answered ok', async () => {
    const fake = await makeFake({ running: true, storage: hydratedStorage() });
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => flushNow(fake)));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(captures(fake)).toBe(1);
  });

  it('an open right after a successful checkpoint reuses it, and still counts as activity', async () => {
    const fake = await makeFake({ running: true, storage: hydratedStorage() });
    expect((await flushNow(fake)).ok).toBe(true);
    storeOf(fake).set(LAST_ACTIVITY_AT_KEY, 1);
    expect((await flushNow(fake)).ok).toBe(true);
    expect(captures(fake)).toBe(1);
    expect(storeOf(fake).get(LAST_ACTIVITY_AT_KEY)).toBeGreaterThan(1);
  });

  it('a checkpoint older than the reuse window is not reused', async () => {
    const fake = await makeFake({ running: true, storage: hydratedStorage() });
    expect((await flushNow(fake)).ok).toBe(true);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11_000;
      expect((await flushNow(fake)).ok).toBe(true);
    } finally {
      Date.now = realNow;
    }
    expect(captures(fake)).toBe(2);
  });

  it('🔴 a stopped container never reuses a checkpoint (the open fails as before)', async () => {
    const fake = await makeFake({ running: true, storage: hydratedStorage() });
    expect((await flushNow(fake)).ok).toBe(true);
    fake.ctx.container.running = false;
    expect((await flushNow(fake)).ok).toBe(false);
  });

  it('🔴 a failed checkpoint is never reused', async () => {
    const fake = await makeFake({ running: true, listFilesThrows: true, storage: hydratedStorage() });
    expect((await flushNow(fake)).ok).toBe(false);
    expect((await flushNow(fake)).ok).toBe(false);
    expect(captures(fake)).toBe(2);
  });

  it('the alarm loop still checkpoints right after an open (persistence cadence unchanged)', async () => {
    const fake = await makeFake({ running: true, storage: hydratedStorage({ [LAST_ACTIVITY_AT_KEY]: Date.now() }) });
    expect((await flushNow(fake)).ok).toBe(true);
    await runAlarmCycle(fake);
    expect(captures(fake)).toBe(2);
  });
});

// Production 2026-10-04 05:59Z: windows were opened at 05:59:34 and, in the same
// second, the desktop window's close-release reported "presence ended 30 min
// ago" over them; the next alarm stopped the computer under the just-opened
// windows, which then showed 410 STALE_PREVIEW_URL. A release ends presence; it
// must never erase an open the server itself observed.
describe('a close-release cannot stop a computer that was just opened', () => {
  const recordActivity = async (fake: unknown, agoMs: number) => {
    const proto = await loadPrototype();
    await (proto.recordActivity as (this: unknown, a: number) => Promise<void>).call(fake, agoMs);
  };

  it('🔴 open, then a 30-minute release in the same second, then the alarm: the computer keeps running', async () => {
    const fake = await makeFake({ running: true, storage: hydratedStorage({ [LAST_ACTIVITY_AT_KEY]: Date.now() - 2 * IDLE_STOP_MS }) });
    await hydrate(fake);                        // a window opens (preview → hydrate): a server-observed open
    await recordActivity(fake, 30 * 60_000);    // releaseDesktop() from the window that just closed
    await runAlarmCycle(fake);
    expect(fake.calls.stops).toBe(0);
    expect(fake.calls.scheduled.at(-1)?.callback).toBe(FLUSH_CALLBACK); // and the alarm rescheduled the loop
  });

  it('a release with no recent open still stops the computer on the next alarm (billing intent unchanged)', async () => {
    const fake = await makeFake({ running: true, storage: hydratedStorage({ 'ezil:lastOpenedAt': Date.now() - 2 * IDLE_STOP_MS }) });
    await recordActivity(fake, 30 * 60_000);
    await runAlarmCycle(fake);
    expect(fake.calls.stops).toBe(1);
  });

  it('an open older than the idle window does not keep a released computer alive', async () => {
    const fake = await makeFake({ running: true, storage: hydratedStorage({ 'ezil:lastOpenedAt': Date.now() - IDLE_STOP_MS - 1_000 }) });
    await recordActivity(fake, 30 * 60_000);
    await runAlarmCycle(fake);
    expect(fake.calls.stops).toBe(1);
  });
});
