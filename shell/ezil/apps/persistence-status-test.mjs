import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPersistenceWatcher } from './persistence-status.js';
import { createAdmission } from '../telemetry.js';

const COMPUTER_ID = '00000000-0000-4000-8000-000000000001';
const SYSTEM_NOTICE = "Saving is paused: your home folder is over the 512 MB limit. Recent changes outside your workspace won't be kept.";
const WORKSPACE_NOTICE = 'Saving is paused: your workspace is over the 512 MB limit.';
const STOPPED_NOTICE = 'Saving has stopped on this computer. Reopen it to resume saving.';

function status(pausedReason = null, pausedLayer = pausedReason ? 'system' : null) {
  const layer = { code: 'ok', outcome: 'ok', committedAgeS: 0 };
  const paused = { code: pausedReason, outcome: 'skipped', committedAgeS: null };
  return { ok: true, status: {
    system: pausedLayer === 'system' ? paused : { ...layer },
    workspace: pausedLayer === 'workspace' ? paused : { ...layer },
    savingPaused: pausedReason !== null, pausedLayer, pausedReason,
    lastStopDiscardedUnsaved: false,
  } };
}

function fixture(fetchStatus = () => status(), emit) {
  let clock = 100000, queue = [];
  const notices = [], events = [], calls = [];
  const watcher = createPersistenceWatcher({
    fetchStatus: computerId => { calls.push({ computerId, at: clock }); return fetchStatus(computerId); },
    emit: emit ?? (event => events.push(event)), render: text => notices.push(text),
    now: () => clock,
    setTimer: (fn, ms) => { const timer = { fn, ms }; queue.push(timer); return timer; },
    clearTimer: timer => { queue = queue.filter(item => item !== timer); },
  });
  return { watcher, notices, events, calls, get queue() { return queue; },
    advance: ms => { clock += ms; },
    tick: async ms => {
      const timer = queue.shift();
      assert.ok(timer, 'a poll must be scheduled');
      clock += ms ?? timer.ms;
      await timer.fn();
    },
  };
}

test('starts immediately, is idempotent, and never polls before 60 seconds', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.equal(f.queue.length, 0);
  const first = f.watcher.start(COMPUTER_ID);
  assert.equal(f.watcher.start(COMPUTER_ID), first);
  await first;
  assert.deepEqual(f.calls, [{ computerId: COMPUTER_ID, at: 100000 }]);
  assert.equal(f.queue[0].ms, 60000);
  await f.watcher.start(COMPUTER_ID);
  await f.tick(59999);
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue[0].ms, 1);
  await f.tick();
  await f.tick();
  assert.deepEqual(f.calls.map(call => call.at), [100000, 160000, 220000]);
  assert.equal(f.queue.length, 1);
  f.watcher.stop();
});

test('measures cadence from the actual fetch when its microtask is delayed', async () => {
  const f = fixture();
  const pending = f.watcher.start(COMPUTER_ID);
  f.advance(30000);
  await pending;
  assert.equal(f.calls[0].at, 130000);
  assert.equal(f.queue[0].ms, 60000);
  await f.tick();
  assert.equal(f.calls[1].at, 190000);
  f.watcher.stop();
});

test('slow requests are serialized even when the polling interval has elapsed', async () => {
  let finish, count = 0;
  const f = fixture(() => ++count === 1 ? new Promise(resolve => { finish = resolve; }) : status());
  const first = f.watcher.start(COMPUTER_ID);
  await Promise.resolve();
  f.advance(130000);
  assert.equal(f.watcher.start(COMPUTER_ID), first);
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue.length, 0);
  finish(status());
  await first;
  assert.equal(f.queue[0].ms, 0);
  await f.tick();
  assert.deepEqual(f.calls.map(call => call.at), [100000, 230000]);
  assert.equal(f.queue[0].ms, 60000);
  f.watcher.stop();
});

test('starting hidden waits for visibility, and resume before start does not fetch', async () => {
  const f = fixture();
  await f.watcher.resume();
  assert.equal(f.calls.length, 0);
  assert.equal(f.queue.length, 0);
  f.watcher.pause();
  await f.watcher.start(COMPUTER_ID);
  f.advance(180000);
  await f.watcher.start(COMPUTER_ID);
  assert.equal(f.calls.length, 0);
  assert.equal(f.queue.length, 0);
  await f.watcher.resume();
  assert.deepEqual(f.calls, [{ computerId: COMPUTER_ID, at: 280000 }]);
  assert.equal(f.queue[0].ms, 60000);
  f.watcher.stop();
});

test('hidden tabs cancel polls and stale callbacks; returning overdue polls once immediately', async () => {
  const f = fixture();
  await f.watcher.start(COMPUTER_ID);
  const callback = f.queue[0].fn;
  f.watcher.pause();
  f.watcher.pause();
  assert.equal(f.queue.length, 0);
  f.advance(180000);
  await callback();
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue.length, 0);
  const resumed = f.watcher.resume();
  assert.equal(f.watcher.resume(), resumed);
  await resumed;
  await f.watcher.resume();
  assert.deepEqual(f.calls.map(call => call.at), [100000, 280000]);
  assert.equal(f.queue.length, 1);
  assert.equal(f.queue[0].ms, 60000);
  await f.tick();
  assert.deepEqual(f.calls.map(call => call.at), [100000, 280000, 340000]);
  f.watcher.stop();
});

test('short and repeated visibility changes preserve the 60-second minimum', async () => {
  const f = fixture();
  await f.watcher.start(COMPUTER_ID);
  f.advance(10000);
  f.watcher.pause();
  f.advance(20000);
  await f.watcher.resume();
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue.length, 1);
  assert.equal(f.queue[0].ms, 30000);
  f.watcher.pause();
  assert.equal(f.queue.length, 0);
  f.advance(29999);
  await f.watcher.resume();
  await f.watcher.resume();
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue.length, 1);
  assert.equal(f.queue[0].ms, 1);
  await f.tick();
  assert.deepEqual(f.calls.map(call => call.at), [100000, 160000]);
  assert.equal(f.queue[0].ms, 60000);
  f.watcher.stop();
});

test('hiding before a fetch microtask prevents both initial and scheduled requests', async () => {
  for (const alreadyStarted of [false, true]) {
    const f = fixture();
    if (alreadyStarted) await f.watcher.start(COMPUTER_ID);
    const pending = alreadyStarted ? f.tick() : f.watcher.start(COMPUTER_ID);
    f.watcher.pause();
    await pending;
    assert.equal(f.calls.length, alreadyStarted ? 1 : 0);
    assert.equal(f.queue.length, 0);
    await f.watcher.resume();
    assert.equal(f.calls.length, alreadyStarted ? 2 : 1);
    assert.equal(f.queue[0].ms, 60000);
    f.watcher.stop();
  }
});

test('a request settling while hidden never rearms, including on failure', async () => {
  for (const fails of [false, true]) {
    let finish, count = 0;
    const f = fixture(() => ++count === 1 ? new Promise((resolve, reject) => {
      finish = () => fails ? reject(new Error('offline')) : resolve(status());
    }) : status());
    const pending = f.watcher.start(COMPUTER_ID);
    await Promise.resolve();
    f.watcher.pause();
    f.advance(130000);
    finish();
    await pending;
    assert.equal(f.calls.length, 1);
    assert.equal(f.queue.length, 0);
    await f.watcher.resume();
    assert.deepEqual(f.calls.map(call => call.at), [100000, 230000]);
    assert.equal(f.queue[0].ms, 60000);
    f.watcher.stop();
  }
});

test('returning during an overdue in-flight request keeps polls serialized', async () => {
  let finish, count = 0;
  const f = fixture(() => ++count === 1 ? new Promise(resolve => { finish = resolve; }) : status());
  const pending = f.watcher.start(COMPUTER_ID);
  await Promise.resolve();
  f.watcher.pause();
  f.advance(130000);
  assert.equal(f.watcher.resume(), pending);
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue.length, 0);
  finish(status());
  await pending;
  assert.equal(f.queue[0].ms, 0);
  await f.tick();
  assert.deepEqual(f.calls.map(call => call.at), [100000, 230000]);
  assert.equal(f.queue[0].ms, 60000);
  f.watcher.stop();
});

test('a paused and disposed watcher cannot be resumed', async () => {
  const f = fixture();
  await f.watcher.start(COMPUTER_ID);
  f.watcher.pause();
  f.watcher.stop();
  f.advance(180000);
  await f.watcher.resume();
  await f.watcher.start(COMPUTER_ID);
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue.length, 0);
});

test('renders the exact notice for every paused reason and layer, or null', async () => {
  for (const [reason, layer, text] of [
    ['too_large', 'system', SYSTEM_NOTICE],
    ['too_large', 'workspace', WORKSPACE_NOTICE],
    ['stale', 'system', STOPPED_NOTICE],
    ['not_restored', 'system', STOPPED_NOTICE],
    [null, null, null],
  ]) {
    const f = fixture(() => status(reason, layer));
    await f.watcher.start(COMPUTER_ID);
    assert.deepEqual(f.notices, [text]);
    f.watcher.stop();
  }
});

const seen = code => ({ eventClass: 'persistence', source: 'shell', site: 'persist.shell_seen', code,
  outcome: code === 'ok' ? 'ok' : 'skipped', computerId: COMPUTER_ID });

test('emits the first observation once, then only reason changes, including recovery, and updates text on a layer change', async () => {
  let current = status();
  const f = fixture(() => current);
  await f.watcher.start(COMPUTER_ID);
  await f.tick();
  assert.deepEqual(f.events, [seen('ok')]);
  f.events.length = 0;
  for (const [reason, layer] of [
    ['too_large', 'system'], ['too_large', 'system'], ['too_large', 'workspace'],
    ['stale', 'system'], ['stale', 'system'], ['not_restored', 'system'],
    [null, null], [null, null],
  ]) {
    current = status(reason, layer);
    await f.tick();
  }
  assert.deepEqual(f.notices, [null, null, SYSTEM_NOTICE, SYSTEM_NOTICE, WORKSPACE_NOTICE,
    STOPPED_NOTICE, STOPPED_NOTICE, STOPPED_NOTICE, null, null]);
  assert.deepEqual(f.events, ['too_large', 'stale', 'not_restored', 'ok'].map(seen));
  // Repeated changes are real observations, not duplicate events to throttle.
  for (let i = 0; i < 4; i++) {
    current = status('too_large'); await f.tick();
    current = status(); await f.tick();
  }
  assert.equal(f.events.length, 12);
  f.watcher.stop();
});

test('fetch failures are swallowed, preserve the last state, and keep polling', async () => {
  let fetch = () => status('too_large');
  const f = fixture(() => fetch());
  await f.watcher.start(COMPUTER_ID);
  for (const fail of [
    () => { throw new Error('offline'); },
    () => Promise.reject(new Error('timeout')),
    () => ({ ok: false, error: 'unavailable' }),
    () => null,
    () => ({ ok: true }),
    () => ({ ok: true, status: {} }),
  ]) {
    fetch = fail;
    await assert.doesNotReject(() => f.tick());
    assert.deepEqual(f.notices, [SYSTEM_NOTICE]);
    assert.equal(f.events.length, 1);
    assert.equal(f.queue[0].ms, 60000);
  }
  fetch = () => status('too_large'); await f.tick();
  assert.equal(f.events.length, 1);
  fetch = () => status(); await f.tick();
  assert.equal(f.notices.at(-1), null);
  assert.deepEqual(f.events.map(event => event.code), ['too_large', 'ok']);
  f.watcher.stop();
});

test('an initial failure shows and emits nothing; the first real observation emits once', async () => {
  let current = { ok: false, error: 'unavailable' };
  const f = fixture(() => current);
  await f.watcher.start(COMPUTER_ID);
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.events, []);
  current = status();
  await f.tick();
  await f.tick();
  assert.deepEqual(f.notices, [null, null]);
  assert.deepEqual(f.events, [seen('ok')]);
  f.watcher.stop();
});

test('a window reopened after saving recovered clears the pause an earlier window reported', async () => {
  // Review r4245675566: window A reports too_large and closes; saving recovers;
  // window B's first healthy poll must report `ok`, or the computer stays flagged.
  const emitted = [];
  const a = fixture(() => status('too_large'), event => emitted.push(event));
  await a.watcher.start(COMPUTER_ID);
  a.watcher.stop();
  const b = fixture(() => status(), event => emitted.push(event));
  await b.watcher.start(COMPUTER_ID);
  await b.tick();
  b.watcher.stop();
  assert.deepEqual(emitted, [seen('too_large'), seen('ok')]);
});

test('telemetry admits every persistence state change past MAX_PER_KEY; other classes keep the per-key cap', () => {
  // Review r4241774146: after three `ok` recoveries in one page life the fourth was dropped.
  const admit = createAdmission();
  const admitted = [];
  for (let i = 0; i < 4; i++) for (const code of ['too_large', 'ok']) admitted.push(admit(seen(code)));
  assert.deepEqual(admitted, Array(8).fill(true));
  const crash = { eventClass: 'crash', site: 'ezil-os:x', code: 'y' };
  assert.deepEqual([1, 2, 3, 4].map(() => admit(crash)), [true, true, true, false]);
  const boot = { eventClass: 'boot_summary', site: 'ezil-os:trace#code', code: 'ok' };
  assert.equal(Array.from({ length: 13 }, () => admit(boot)).filter(Boolean).length, 12);
});

test('identical persistence repeats (one per window open) share a bounded page cap; a change always passes', () => {
  const admit = createAdmission();
  const other = '00000000-0000-4000-8000-000000000002';
  assert.equal(admit(seen('ok')), true);
  const repeats = Array.from({ length: 30 }, () => admit(seen('ok')));
  assert.equal(repeats.filter(Boolean).length, 20);
  assert.equal(admit(seen('ok')), false);
  assert.equal(admit(seen('too_large')), true, 'a change passes after the repeat cap');
  assert.equal(admit(seen('ok')), true);
  assert.equal(Array.from({ length: 25 }, () => admit(seen('ok'))).filter(Boolean).length, 0, 'repeat cap spent');
  assert.equal(admit({ ...seen('ok'), computerId: other }), true, 'another computer\'s first observation is a change, not a repeat');
});

test('capture() routes every armed event through the admission before buffering', () => {
  const source = readFileSync(new URL('../telemetry.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export function capture ('), source.indexOf('if ( buffer.length >= MAX_BUFFER )'));
  assert.match(body, /if \( ! admit\(\{ eventClass, site, code, computerId: input\.computerId \}\) \) return;/);
  assert.ok(body.indexOf('isArmed()') < body.indexOf('admit('), 'the local mirror still records unadmitted events');
});

test('stale pause clears through the real telemetry admission after three earlier healthy windows', async () => {
  const admit = createAdmission();
  const admitted = [];
  const emit = event => { if (admit(event)) admitted.push(event.code); };
  for (let i = 0; i < 3; i++) {
    const w = fixture(() => status(), emit);
    await w.watcher.start(COMPUTER_ID);
    w.watcher.stop();
  }
  let current = status('too_large');
  const last = fixture(() => current, emit);
  await last.watcher.start(COMPUTER_ID);
  current = status();
  await last.tick();
  last.watcher.stop();
  assert.deepEqual(admitted, ['ok', 'ok', 'ok', 'too_large', 'ok']);
});

test('telemetry errors cannot prevent rendering or the next poll', async () => {
  const f = fixture(() => status('too_large'), () => { throw new Error('telemetry unavailable'); });
  await assert.doesNotReject(() => f.watcher.start(COMPUTER_ID));
  assert.deepEqual(f.notices, [SYSTEM_NOTICE]);
  await f.tick();
  assert.equal(f.calls.length, 2);
  f.watcher.stop();
});

test('stop clears the timer and makes even an already queued callback harmless', async () => {
  const f = fixture();
  await f.watcher.start(COMPUTER_ID);
  const callback = f.queue[0].fn;
  f.watcher.stop();
  f.watcher.stop();
  assert.equal(f.queue.length, 0);
  f.advance(60000);
  await callback();
  await f.watcher.start(COMPUTER_ID);
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue.length, 0);
});

test('a disposed watcher ignores a delayed response and never rearms', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.watcher.start(COMPUTER_ID);
  await Promise.resolve();
  f.watcher.stop();
  finish(status('too_large'));
  await pending;
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.events, []);
  assert.equal(f.queue.length, 0);
});

test('closing before the first microtask prevents the initial fetch', async () => {
  const f = fixture();
  const pending = f.watcher.start(COMPUTER_ID);
  f.watcher.stop();
  await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.queue.length, 0);
});
