import { afterEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeSystemDirty } from './system-persist';
import { SYSTEM_SNAPSHOT_SCRIPT } from './system-snapshot-script';
import { SNAPSHOT_HEAD, type HydrateContainerLike } from './workspace-persist';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, RpcStub: class {}, env: {},
}));
afterEach(() => setSystemTime());

const START = 1_800_000_000_000;
const PERIOD = 300_000;
const PREFIX = '3f6f1c2e-9a1b-4c3d-8e5f-0123456789ab/branches/main';
const LAST_FLUSH = 'ezil:systemLastFlushAt';
const LAST_PROBE = 'ezil:systemLastDirtyProbeAt';
const LAST_START = 'ezil:systemLastCaptureStartedAt';
const BACKOFF = 'ezil:systemFlushBackoffAt';
const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const at = (elapsed: number) => setSystemTime(new Date(START + elapsed));

// All DO methods execute unchanged; only storage, scheduler and container I/O
// are fake, as in workspace-flush-loop.test.ts.
async function fixture() {
  at(0);
  const store = new Map<string, unknown>([
    ['ezil:workspaceHydrated', true],
    ['ezil:workspaceFlushContext', { prefix: PREFIX, mountPath: '/workspace' }],
    ['ezil:lastActivityAt', START], [LAST_FLUSH, START], [LAST_START, START],
  ]);
  const objects = new Map<string, Uint8Array>();
  const calls = { probes: [] as number[], captures: [] as number[], commits: [] as number[],
    scheduled: [] as number[], stops: 0, order: [] as string[] };
  const state = { content: 'base', captured: 'base', generation: null as string | null,
    probeError: false, captureMs: 0, getError: '', putError: '', tooLarge: false };
  const bucket = {
    get: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { etag: digest(Buffer.from(bytes).toString()), size: bytes.length,
        arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
    },
    put: async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes.slice());
      if (key.includes('/system/') && key.endsWith(SNAPSHOT_HEAD)) calls.commits.push(Date.now());
      return { etag: digest(Buffer.from(bytes).toString()) };
    },
    list: async () => ({ objects: [], truncated: false }), delete: async () => undefined,
  };
  const { Sandbox } = await import('./index');
  const fake = Object.assign(Object.create(Sandbox.prototype), {
    ctx: {
      storage: {
        get: async (key: string | string[]) => {
          if (key === state.getError) throw new Error('storage read failed');
          return Array.isArray(key) ? new Map(key.map(k => [k, store.get(k)])) : store.get(key);
        },
        put: async (key: string, value: unknown) => {
          if (key === state.putError) throw new Error('storage write failed');
          calls.order.push(`put:${key}`);
          store.set(key, value);
        },
        delete: async (key: string) => store.delete(key),
      },
      container: { running: true },
    },
    env: { SANDBOX_WORKSPACE_R2_BUCKET: bucket },
    listSchedules: async () => [], deleteSchedules: () => undefined,
    schedule: async (seconds: number) => { calls.scheduled.push(seconds); },
    stop: async () => { calls.stops++; },
    exec: async (command: string, options?: { timeout?: number }) => {
      if (command.includes('"op":"sys-dirty"')) {
        calls.probes.push(Date.now());
        expect(options?.timeout).toBe(60_000);
        if (state.probeError) throw new Error('container unavailable');
        return { exitCode: 0, stdout: JSON.stringify({ dirty: state.content !== state.captured }) };
      }
      if (command.includes('"op":"sys-capture"')) {
        calls.order.push('sys-capture');
        calls.captures.push(Date.now());
        if (state.tooLarge) return { exitCode: 3, stdout: '' };
        state.captured = state.content;
        setSystemTime(new Date(Date.now() + state.captureMs));
        return { exitCode: 0, stdout: JSON.stringify({ expectedGeneration: state.generation,
          sha256: digest(state.captured), entries: 1,
          chunks: [{ size: Buffer.byteLength(state.captured), sha256: digest(state.captured) }] }) };
      }
      if (command.includes('"op":"sys-hydrated"')) {
        state.generation = command.match(/"generation":"([^"]+)"/)![1]!;
      }
      if (command.includes('"op":"capture"')) return { exitCode: 0,
        stdout: JSON.stringify({ sha256: digest('hello'), entries: 0, chunks: [{ size: 5, sha256: digest('hello') }] }) };
      return { exitCode: 0, stdout: '' };
    },
    readFile: async (path: string) => ({ encoding: 'base64',
      content: Buffer.from(path.startsWith('/tmp/ezil-system-') ? state.captured : 'hello').toString('base64') }),
    exists: async () => ({ exists: false }), writeFile: async () => ({ success: true }),
    mkdir: async () => ({ success: true }), listFiles: async () => ({ files: [] }),
  });
  return { fake, store, calls, state, objects,
    cycle: () => fake.flushWorkspaceScheduled(),
    flush: (final = false) => fake.runSystemFlush(bucket, PREFIX, final),
  };
}

describe('system dirty flush cycles', () => {
  for (const step of [10_000, 60_000]) {
    it(`commits a change within 90 seconds with ${step / 1000}s cycles`, async () => {
      const f = await fixture();
      at(1);
      f.state.content = 'installed tool';
      for (let elapsed = step; elapsed <= 90_000; elapsed += step) {
        at(elapsed);
        await f.cycle();
      }
      expect(f.calls.captures).toHaveLength(1);
      expect(f.calls.commits).toHaveLength(1);
      expect(f.calls.commits[0]! - (START + 1)).toBeLessThanOrEqual(90_000);
      expect(f.calls.stops).toBe(0);
      expect(f.calls.scheduled.length).toBeGreaterThan(0);
    });
  }

  it('clean probes add no captures, and periodic capture still runs at five minutes', async () => {
    const f = await fixture();
    for (let elapsed = 15_000; elapsed < PERIOD; elapsed += 15_000) {
      at(elapsed);
      await f.cycle();
    }
    expect(f.calls.probes).toHaveLength(19);
    expect(f.calls.captures).toHaveLength(0);
    at(PERIOD);
    await f.cycle();
    expect(f.calls.captures).toEqual([START + PERIOD]);
    expect(f.calls.probes).toHaveLength(19);
  });

  it('probes at most every 15 seconds and waits 20 seconds between capture starts', async () => {
    const f = await fixture();
    f.state.content = 'dirty';
    for (const elapsed of [0, 14_999, 15_000, 20_000, 29_999]) {
      at(elapsed);
      await f.flush();
    }
    expect(f.calls.probes).toEqual([START, START + 15_000]);
    expect(f.calls.captures).toHaveLength(0);
    at(30_000);
    await f.flush();
    expect(f.calls.captures).toEqual([START + 30_000]);
    expect(f.store.get(LAST_PROBE)).toBe(START + 30_000);
    expect(f.store.get(LAST_START)).toBe(START + 30_000);
    expect(f.calls.order.indexOf(`put:${LAST_START}`)).toBeLessThan(f.calls.order.indexOf('sys-capture'));
  });

  it('B2 backoff blocks dirty and periodic captures until expiry', async () => {
    const f = await fixture();
    f.state.content = 'dirty';
    f.store.set(BACKOFF, START + 10_000);
    for (const elapsed of [20_000, 60_000, PERIOD]) {
      at(elapsed);
      await f.cycle();
    }
    expect(f.calls.probes.length).toBeGreaterThan(0);
    expect(f.calls.captures).toHaveLength(0);
    at(PERIOD + 10_000);
    await f.cycle();
    expect(f.calls.captures).toHaveLength(1);
    expect(f.store.has(BACKOFF)).toBe(false);
  });

  it('a dirty capture refusal establishes B2 backoff', async () => {
    const f = await fixture();
    f.state.content = 'dirty';
    f.state.tooLarge = true;
    at(20_000);
    await f.cycle();
    expect(f.store.get(BACKOFF)).toBe(START + 20_000);
    at(60_000);
    await f.cycle();
    expect(f.calls.captures).toHaveLength(1);
    expect(f.calls.scheduled).toHaveLength(2);
  });

  it('probe errors stay unknown and fall back to the five-minute capture', async () => {
    const f = await fixture();
    f.state.content = 'dirty';
    f.state.probeError = true;
    for (const elapsed of [20_000, 60_000, 120_000, 299_999]) {
      at(elapsed);
      await f.cycle();
    }
    expect(f.calls.captures).toHaveLength(0);
    at(PERIOD);
    await f.cycle();
    expect(f.calls.captures).toEqual([START + PERIOD]);
    expect(f.calls.scheduled).toHaveLength(5);
    expect(f.calls.stops).toBe(0);
  });

  it('final capture bypasses dirty throttles and B2 backoff', async () => {
    const f = await fixture();
    f.store.set(BACKOFF, START);
    f.store.set(LAST_PROBE, START);
    expect(await f.flush(true)).toMatchObject({ ok: true });
    expect(f.calls.probes).toHaveLength(0);
    expect(f.calls.captures).toEqual([START]);
  });

  it('uses capture start, not completion, for the minimum gap', async () => {
    const f = await fixture();
    f.state.captureMs = 30_000;
    await f.flush(true);
    expect(f.store.get(LAST_START)).toBe(START);
    expect(f.store.get(LAST_FLUSH)).toBe(START + 30_000);
    f.state.content = 'changed during or after capture';
    f.state.captureMs = 0;
    await f.flush();
    expect(f.calls.captures).toEqual([START, START + 30_000]);
  });

  for (const field of ['getError', 'putError'] as const) {
    it(`${field}: dirty bookkeeping failure does not throw or stop the flush loop`, async () => {
      const f = await fixture();
      f.state[field] = LAST_PROBE;
      f.state.content = 'dirty';
      at(20_000);
      await expect(f.cycle()).resolves.toBeUndefined();
      expect(f.calls.scheduled).toHaveLength(1);
      expect(f.calls.stops).toBe(0);
    });
  }
});

describe('system dirty probe helper', () => {
  for (const [stdout, expected] of [
    ['{"dirty":true}', true], ['{"dirty":false}', false], ['{"dirty":"yes"}', null],
    ['{}', null], ['null', null], ['invalid JSON', null],
  ] as const) {
    it(`parses ${stdout} as ${expected}`, async () => {
      const container = { exec: async (command: string, options?: { timeout?: number }) => {
        expect(command).toContain('"op":"sys-dirty"');
        expect(options?.timeout).toBe(60_000);
        return { exitCode: 0, stdout };
      } } as HydrateContainerLike;
      expect(await probeSystemDirty(container)).toBe(expected);
    });
  }
  it('returns unknown for nonzero exits and rejected RPCs', async () => {
    for (const exec of [async () => ({ exitCode: 1, stdout: '{"dirty":true}' }),
      async () => { throw new Error('timeout'); }]) {
      expect(await probeSystemDirty({ exec } as HydrateContainerLike)).toBeNull();
    }
  });
});

const run = promisify(execFile);
// Execute the actual codec with all filesystem roots redirected into a Python
// TemporaryDirectory. Never walk the host's /root, /etc or installed tools.
async function python(scenario: string, op = 'sys-dirty') {
  const setup = String.raw`
import tempfile
test_dir = tempfile.TemporaryDirectory(prefix='ezil-system-dirty-test-')
test_root = test_dir.name
ROOTS = [test_root + '/root']
os.mkdir(ROOTS[0])
STATE = test_root + '/state'
os.mkdir(STATE)
CAPTURE_STARTED = STATE + '/capture-started'
BASELINE = STATE + '/baseline'
HYDRATED = STATE + '/hydrated'
MANIFEST = STATE + '/manifest.json'
BASELINE_MISSING = STATE + '/baseline-missing.json'
IMAGE_MANIFEST = STATE + '/image.tsv'
EXCLUDE = [ROOTS[0] + '/excluded', STATE]
OLD = 1700000000000000000
def stamp(path, ns=OLD): os.utime(path, ns=(ns, ns), follow_symlinks=False)
def marker():
    with open(CAPTURE_STARTED, 'w'): pass
    stamp(CAPTURE_STARTED)
def settle():
    for d, dirs, files in os.walk(ROOTS[0]):
        for n in dirs + files: stamp(os.path.join(d, n))
        stamp(d)
work = test_root + '/work'
`;
  const insertion = '\ntry:\n    op = p[\'op\']';
  expect(SYSTEM_SNAPSHOT_SCRIPT).toContain(insertion);
  const script = SYSTEM_SNAPSHOT_SCRIPT.replace(insertion, `\n${setup}\n${scenario}\n${insertion}`);
  const result = await run('python3', ['-I', '-c', script,
    JSON.stringify({ op, work: '/tmp/ezil-system-test' })], { env: { PATH: '/usr/bin:/bin' } });
  return JSON.parse(result.stdout);
}

// The codec is POSIX-only (fcntl, lstat ns) and needs python3, as in workspace-persist.test.ts.
const NO_POSIX_HOST = process.platform === 'win32';
describe.skipIf(NO_POSIX_HOST)('system dirty Python codec', () => {
  it('missing marker is dirty; equal nanosecond mtimes are clean', async () => {
    expect(await python('settle()')).toEqual({ dirty: true });
    expect(await python('marker()\nsettle()')).toEqual({ dirty: false });
  });

  for (const kind of ['file', 'directory', 'symlink']) {
    it(`finds a ${kind} just one nanosecond newer using lstat`, async () => {
      expect(await python(`
marker()
path = ROOTS[0] + '/entry'
${kind === 'file' ? "open(path, 'w').close()" : kind === 'directory' ? 'os.mkdir(path)' : "os.symlink('/missing-target', path)"}
settle()
stamp(path, OLD + 1)
`)).toEqual({ dirty: true });
    });
  }

  it('detects deletions from the root directory mtime', async () => {
    expect(await python(`
marker()
path = ROOTS[0] + '/deleted'
open(path, 'w').close()
settle()
os.unlink(path)
`)).toEqual({ dirty: true });
  });

  it('prunes excluded directories and ignores excluded names', async () => {
    expect(await python(`
marker()
os.mkdir(ROOTS[0] + '/excluded')
open(ROOTS[0] + '/excluded/new', 'w').close()
open(ROOTS[0] + '/.uuid', 'w').close()
stamp(ROOTS[0])
original_walk = os.walk
def checked_walk(root):
    for row in original_walk(root):
        assert '/excluded' not in row[0], 'walked excluded tree'
        yield row
os.walk = checked_walk
`)).toEqual({ dirty: false });
  });

  for (const project of ['locked', 'unlocked', 'hidden']) {
    it(`${project} HOME project honors the shared regenerable-tree predicate`, async () => {
      expect(await python(`
marker()
original_project_directory = regenerable_project_directory
def mapped_project_directory(path):
    directory = original_project_directory(path[len(test_root):])
    return test_root + directory if directory is not None else None
regenerable_project_directory = mapped_project_directory
project = ROOTS[0] + '/${project === 'hidden' ? '.tool' : 'project'}'
os.makedirs(project + '/node_modules')
os.mkdir(project + '/.next')
open(project + '/package.json', 'w').close()
${project === 'unlocked' ? '' : "open(project + '/package-lock.json', 'w').close()"}
open(project + '/node_modules/dependency', 'w').close()
open(project + '/.next/build', 'w').close()
settle()
stamp(project + '/node_modules', OLD + 1)
stamp(project + '/node_modules/dependency', OLD + 1)
stamp(project + '/.next', OLD + 1)
stamp(project + '/.next/build', OLD + 1)
`)).toEqual({ dirty: project !== 'locked' });
    });
  }

  it('stops at the first hit without walking, and never follows symlink targets', async () => {
    expect(await python(`
marker()
stamp(ROOTS[0], OLD + 1)
def forbidden_walk(root): raise AssertionError('walked after first hit')
os.walk = forbidden_walk
`)).toEqual({ dirty: true });
    expect(await python(`
marker()
target = test_root + '/target'
os.mkdir(target)
open(target + '/new', 'w').close()
os.symlink(target, ROOTS[0] + '/link')
settle()
`)).toEqual({ dirty: false });
  });

  it('tolerates paths vanishing between walk and lstat', async () => {
    expect(await python(`
marker()
settle()
ROOTS.append(test_root + '/vanished-root')
def vanished_walk(root): yield (root, ['vanished-dir'], ['vanished-file'])
os.walk = vanished_walk
`)).toEqual({ dirty: false });
  });

  it('capture touches the marker before walking, keeping concurrent changes dirty', async () => {
    expect(await python(`
marker()
settle()
for path in (HYDRATED, BASELINE, IMAGE_MANIFEST): open(path, 'w').close()
hold_package_locks = lambda block: []
order = []
original_utime = os.utime
def tracked_utime(path, *args, **kwargs):
    if path == CAPTURE_STARTED + '.pending': order.append('touch')
    return original_utime(path, *args, **kwargs)
os.utime = tracked_utime
def checked_inventory(since, image):
    order.append('walk')
    assert order == ['touch', 'walk'], order
    started = os.lstat(CAPTURE_STARTED + '.pending').st_mtime_ns
    assert started > OLD
    assert os.lstat(CAPTURE_STARTED).st_mtime_ns == OLD  # baseline unchanged until committed
    path = ROOTS[0] + '/during-capture'
    open(path, 'w').close()
    stamp(path, started + 1)
    stamp(ROOTS[0], started)
    return {}
inventory = checked_inventory
replay_lists = lambda: {}
image_id = lambda: 'test'
original_capture = capture
def checked_capture(path, mark_started=True):
    result = original_capture(path, mark_started=mark_started)
    assert system_dirty() is True
    return {'order': order, 'dirty': True}
capture = checked_capture
`, 'sys-capture')).toEqual({ order: ['touch', 'walk'], dirty: true });
  });

  it('a busy capture preserves the old marker and dirty state', async () => {
    expect(await python(`
marker()
settle()
stamp(ROOTS[0], OLD + 1)
for path in (HYDRATED, BASELINE, IMAGE_MANIFEST): open(path, 'w').close()
hold_package_locks = lambda block: None
original_capture = capture
def checked_capture(path, mark_started=True):
    result = original_capture(path, mark_started=mark_started)
    assert os.lstat(CAPTURE_STARTED).st_mtime_ns == OLD
    assert system_dirty() is True
    return result
capture = checked_capture
`, 'sys-capture')).toEqual({ skipped: 'busy' });
  });

  it('capture retries preserve the first marker so concurrent changes stay dirty', async () => {
    const result = await python(`
marker()
settle()
for path in (HYDRATED, BASELINE, IMAGE_MANIFEST): open(path, 'w').close()
hold_package_locks = lambda block: []
starts = []
def retry_inventory(since, image):
    starts.append(os.lstat(CAPTURE_STARTED + '.pending').st_mtime_ns)
    if len(starts) == 1:
        path = ROOTS[0] + '/during-first-walk'
        open(path, 'w').close()
        stamp(path, starts[0] + 1)
        stamp(ROOTS[0], starts[0])
        raise AssertionError('system changed during capture')
    assert starts[0] == starts[1]
    return {}
inventory = retry_inventory
replay_lists = lambda: {'dirty': system_dirty(), 'attempts': len(starts)}
image_id = lambda: 'test'
`, 'sys-capture');
    expect(result.replay).toEqual({ dirty: true, attempts: 2 });
  });
  it('an uncommitted capture leaves its changes dirty; sys-committed promotes the baseline', async () => {
    expect(await python(`
marker()
settle()
stamp(ROOTS[0], OLD + 5)
open(CAPTURE_STARTED + '.pending', 'w').close()
stamp(CAPTURE_STARTED + '.pending', OLD + 10)
before = system_dirty()
`, 'sys-dirty')).toEqual({ dirty: true });
    expect(await python(`
marker()
settle()
stamp(ROOTS[0], OLD + 5)
open(CAPTURE_STARTED + '.pending', 'w').close()
stamp(CAPTURE_STARTED + '.pending', OLD + 10)
`, 'sys-committed')).toEqual({ committed: true });
  });
});
