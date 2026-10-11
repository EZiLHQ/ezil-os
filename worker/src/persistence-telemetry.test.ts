import { describe, expect, it } from 'bun:test';

import {
  emptyTrackerState,
  isComputerUuid,
  loadTrackerState,
  observe,
  outcomeOf,
  PERSISTENCE_ATTR_KEYS,
  PERSISTENCE_CODES,
  PERSISTENCE_HEARTBEAT_MS,
  sizeBucket,
  statusFrom,
  type PersistenceObservation,
  type PersistenceTrackerState,
} from './persistence-telemetry';

const COMPUTER = '3f6f1c2e-9a1b-4c3d-8e5f-0123456789ab';
const T0 = Date.UTC(2026, 9, 10, 12, 41, 0);
const MIB = 1024 * 1024;

function run(obs: PersistenceObservation[], start: PersistenceTrackerState = emptyTrackerState(), stepMs = 10_000, ctx = { computerId: COMPUTER }) {
  let state = start;
  const events: ReturnType<typeof observe>['events'] = [];
  obs.forEach((o, i) => {
    const r = observe(state, o, T0 + i * stepMs, ctx);
    state = r.state;
    events.push(...r.events);
  });
  return { state, events };
}

const sysFlush = (code: string, trigger: 'interval' | 'final' = 'interval'): PersistenceObservation =>
  ({ kind: 'flush', layer: 'system', code: code as never, trigger, entries: 4321, bytes: 600 * MIB });
const wsFlush = (code: string, trigger: 'interval' | 'final' = 'interval'): PersistenceObservation =>
  ({ kind: 'flush', layer: 'workspace', code: code as never, trigger });

describe('persistence event shape (contract §1-§2)', () => {
  it('is a worker persistence event with the real computer UUID and only allow-listed attrs', () => {
    const { events } = run([sysFlush('too_large')]);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({ eventClass: 'persistence', source: 'worker', site: 'persist.system.flush', code: 'too_large',
      outcome: 'skipped', computerId: COMPUTER });
    expect(e.detail).toBeUndefined();
    expect(e.eventId).toMatch(/^[0-9a-f-]{36}$/);
    for (const key of Object.keys(e.attrs ?? {})) expect(PERSISTENCE_ATTR_KEYS as readonly string[]).toContain(key);
    expect(Object.keys(e.attrs ?? {}).length).toBeLessThanOrEqual(8);
    expect(e.attrs).toMatchObject({ entries: 4321, size_bucket: 'over_cap', trigger: 'interval', consecutive_failures: 1,
      system_age_s: -1, workspace_age_s: -1 });
    // No string attr is free text: every string value is one of the closed enums.
    const enums = new Set(['lt_64m', 'lt_256m', 'lt_512m', 'over_cap', 'interval', 'final', 'readiness', 'idle_stop', 'teardown', 'open', 'heartbeat']);
    for (const v of Object.values(e.attrs ?? {})) if (typeof v === 'string') expect(enums.has(v)).toBe(true);
  });

  it('every contract code satisfies the app code regex', () => {
    for (const c of PERSISTENCE_CODES) expect(c).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it('never stamps a non-UUID computerId (sandboxId, empty, garbage)', () => {
    for (const bad of ['guac-abcdef0123456789-fedcba9876543210', '', 'not-a-uuid', 42, undefined]) {
      const { events } = run([sysFlush('failed')], emptyTrackerState(), 10_000, { computerId: bad as never });
      expect(events[0]!.computerId).toBeUndefined();
    }
    expect(isComputerUuid(COMPUTER)).toBe(true);
    expect(isComputerUuid(COMPUTER.toUpperCase())).toBe(true);
  });

  it('maps outcomes: ok-like, refusals, errors', () => {
    expect(outcomeOf('ok')).toBe('ok');
    expect(outcomeOf('unchanged')).toBe('ok');
    expect(outcomeOf('no_snapshot')).toBe('ok');
    expect(outcomeOf('too_large')).toBe('skipped');
    expect(outcomeOf('stale')).toBe('skipped');
    expect(outcomeOf('failed')).toBe('error');
    expect(outcomeOf('workspace_checkpoint_failed')).toBe('error');
  });

  it('size buckets', () => {
    expect(sizeBucket(undefined)).toBeUndefined();
    expect(sizeBucket(-1)).toBeUndefined();
    expect(sizeBucket(0)).toBe('lt_64m');
    expect(sizeBucket(64 * MIB - 1)).toBe('lt_64m');
    expect(sizeBucket(64 * MIB)).toBe('lt_256m');
    expect(sizeBucket(256 * MIB)).toBe('lt_512m');
    expect(sizeBucket(512 * MIB - 1)).toBe('lt_512m');
    expect(sizeBucket(512 * MIB)).toBe('over_cap');
  });
});

describe('emission rule (contract §3)', () => {
  it('suppresses the failed-capture loop: 30 identical too_large captures -> ONE event', () => {
    const { events, state } = run(Array.from({ length: 30 }, () => sysFlush('too_large')));
    expect(events).toHaveLength(1);
    expect(state.system.consecutiveFailures).toBe(30);
  });

  it('emits on each transition: ok -> too_large -> ok', () => {
    const { events } = run([sysFlush('ok'), sysFlush('ok'), sysFlush('too_large'), sysFlush('too_large'), sysFlush('ok')]);
    expect(events.map((e) => e.code)).toEqual(['ok', 'too_large', 'ok']);
  });

  it('ok and unchanged are one state (a workspace alternating upload/unchanged is not a transition stream)', () => {
    const { events } = run([wsFlush('ok'), wsFlush('unchanged'), wsFlush('ok'), wsFlush('unchanged')]);
    expect(events).toHaveLength(1);
  });

  it('deferred and busy are transient: never emitted, never counted, never change state', () => {
    const { events, state } = run([wsFlush('ok'), wsFlush('deferred'), sysFlush('busy'), wsFlush('ok')]);
    expect(events).toHaveLength(1);
    expect(state.workspace.consecutiveFailures).toBe(0);
    expect(state.system.code).toBeNull();
  });

  it('a restore after flushes is a transition (new container), and the next flush is one too', () => {
    const { events } = run([
      sysFlush('ok'),
      { kind: 'restore', layer: 'system', code: 'ok', trigger: 'open', entries: 12 },
      sysFlush('ok'),
    ]);
    expect(events.map((e) => e.site)).toEqual(['persist.system.flush', 'persist.system.restore', 'persist.system.flush']);
  });

  it('stop and open_blocked are always emitted', () => {
    const { events } = run([
      { kind: 'open_blocked', code: 'workspace_checkpoint_failed' },
      { kind: 'open_blocked', code: 'workspace_checkpoint_failed' },
      { kind: 'stop', trigger: 'idle_stop' },
      { kind: 'stop', trigger: 'idle_stop' },
    ]);
    expect(events.map((e) => e.site)).toEqual(['persist.open_blocked', 'persist.open_blocked', 'persist.stop', 'persist.stop']);
    expect(events[0]!.outcome).toBe('error');
  });

  it('stop marks discarded_unsaved when either layer last saved with a data-losing code', () => {
    const clean = run([sysFlush('ok', 'final'), wsFlush('unchanged'), { kind: 'stop', trigger: 'idle_stop' }]);
    const stopClean = clean.events.at(-1)!;
    expect(stopClean).toMatchObject({ site: 'persist.stop', code: 'ok', attrs: { discarded_unsaved: false, trigger: 'idle_stop' } });
    const lost = run([sysFlush('too_large', 'final'), wsFlush('ok'), { kind: 'stop', trigger: 'idle_stop' }]);
    expect(lost.events.at(-1)).toMatchObject({ site: 'persist.stop', code: 'too_large', attrs: { discarded_unsaved: true } });
    expect(lost.state.lastStopDiscardedUnsaved).toBe(true);
  });

  for (const layer of ['system', 'workspace'] as const) {
    it(`only the five data-losing final outcomes mark ${layer} discarded_unsaved`, () => {
      const losing = new Set(['too_large', 'stale', 'not_restored', 'failed', 'flush_threw']);
      for (const code of PERSISTENCE_CODES) {
        const { state, events } = run([
          sysFlush('no_baseline', 'final'), wsFlush('no_baseline', 'final'),
          { kind: 'flush', layer, code, trigger: 'final' },
          { kind: 'stop', trigger: 'teardown' },
        ]);
        expect(events.at(-1)!.attrs!.discarded_unsaved).toBe(losing.has(code));
        expect(state.lastStopDiscardedUnsaved).toBe(losing.has(code));
      }
    });
  }

  it('a later successful final outcome clears an earlier loss and the previous stop flag', () => {
    const { state, events } = run([
      sysFlush('failed', 'final'), wsFlush('too_large', 'final'), { kind: 'stop', trigger: 'teardown' },
      sysFlush('ok', 'final'), wsFlush('unchanged', 'final'), { kind: 'stop', trigger: 'idle_stop' },
    ]);
    expect(events.at(-1)!.attrs!.discarded_unsaved).toBe(false);
    expect(state.lastStopDiscardedUnsaved).toBe(false);
  });

  it('heartbeat: none before 15 min of silence, one at 15 min, none when not running', () => {
    let state = observe(emptyTrackerState(), sysFlush('ok'), T0).state;
    expect(observe(state, { kind: 'heartbeat', running: true }, T0 + PERSISTENCE_HEARTBEAT_MS - 1).events).toHaveLength(0);
    expect(observe(state, { kind: 'heartbeat', running: false }, T0 + PERSISTENCE_HEARTBEAT_MS).events).toHaveLength(0);
    const hb = observe(state, { kind: 'heartbeat', running: true }, T0 + PERSISTENCE_HEARTBEAT_MS);
    expect(hb.events).toHaveLength(1);
    expect(hb.events[0]).toMatchObject({ site: 'persist.heartbeat', code: 'ok', attrs: { trigger: 'heartbeat', system_age_s: 900 } });
    state = hb.state;
    // The heartbeat itself resets the clock.
    expect(observe(state, { kind: 'heartbeat', running: true }, T0 + PERSISTENCE_HEARTBEAT_MS + 60_000).events).toHaveLength(0);
  });

  it('a frozen computer still heartbeats with its blocking code while suppressed', () => {
    let state = emptyTrackerState();
    let count = 0;
    for (let t = 0; t <= 60 * 60_000; t += 10_000) {
      const a = observe(state, sysFlush('too_large'), T0 + t);
      const b = observe(a.state, { kind: 'heartbeat', running: true }, T0 + t);
      state = b.state;
      count += a.events.length + b.events.length;
      for (const e of b.events) expect(e.code).toBe('too_large');
    }
    // 1 transition + one heartbeat per 15 min over an hour of 10 s cycles.
    expect(count).toBe(5);
  });
});

describe('tracker identity', () => {
  it('returns the same state for suppressed heartbeats and transient observations', () => {
    const state = observe(emptyTrackerState(), sysFlush('ok'), T0).state;
    const before = structuredClone(state);
    for (const obs of [
      { kind: 'heartbeat', running: false }, { kind: 'heartbeat', running: true },
      sysFlush('busy'), wsFlush('deferred'),
    ] as PersistenceObservation[]) {
      const result = observe(state, obs, T0 + 1);
      expect(result.state).toBe(state);
      expect(result.events).toHaveLength(0);
    }
    expect(state).toEqual(before);
  });

  it('returns the same state for an identical successful restore or a flush at the same time', () => {
    const restore: PersistenceObservation = { kind: 'restore', layer: 'system', code: 'ok', trigger: 'open' };
    const restored = observe(emptyTrackerState(), restore, T0).state;
    expect(observe(restored, restore, T0 + 10_000).state).toBe(restored);
    const flushed = observe(restored, sysFlush('ok'), T0).state;
    expect(observe(flushed, sysFlush('ok'), T0).state).toBe(flushed);
  });

  it('still updates commit times and failure counts when an event is suppressed, without mutating prior state', () => {
    for (const code of ['ok', 'failed']) {
      const prev = observe(emptyTrackerState(), sysFlush(code), T0).state;
      const before = structuredClone(prev);
      const result = observe(prev, sysFlush(code), T0 + 10_000);
      expect(result.events).toHaveLength(0);
      expect(result.state).not.toBe(prev);
      expect(prev).toEqual(before);
      if (code === 'ok') expect(result.state.system.lastOkCommitAt).toBe(T0 + 10_000);
      else expect(result.state.system.consecutiveFailures).toBe(2);
    }
  });

  it('emitting an event only changes state when its stored timestamp or stop flag changes', () => {
    const obs: PersistenceObservation = { kind: 'stop', trigger: 'idle_stop' };
    const prev = observe(emptyTrackerState(), obs, T0).state;
    const repeat = observe(prev, obs, T0);
    expect(repeat.events).toHaveLength(1);
    expect(repeat.state).toBe(prev);
    const later = observe(prev, obs, T0 + 1);
    expect(later.state).not.toBe(prev);
    expect(later.state.lastEventAt).toBe(T0 + 1);
    expect(prev.lastEventAt).toBe(T0);
  });
});

describe('status (contract §5)', () => {
  it('pauses on system too_large / stale / not_restored, system wins over workspace', () => {
    for (const code of ['too_large', 'stale', 'not_restored'] as const) {
      const s = statusFrom(run([sysFlush(code), wsFlush('too_large')]).state, T0 + 60_000);
      expect(s).toMatchObject({ savingPaused: true, pausedLayer: 'system', pausedReason: code });
    }
    const ws = statusFrom(run([sysFlush('ok'), wsFlush('too_large')]).state, T0 + 60_000);
    expect(ws).toMatchObject({ savingPaused: true, pausedLayer: 'workspace', pausedReason: 'too_large' });
  });

  it('not paused on failed (retried) or ok; committed ages; never-seen layers are unknown/null', () => {
    const s = statusFrom(run([sysFlush('ok'), sysFlush('failed')]).state, T0 + 70_000);
    expect(s).toMatchObject({ savingPaused: false, pausedLayer: null, pausedReason: null });
    expect(s.system).toEqual({ code: 'failed', outcome: 'error', committedAgeS: 70 });
    expect(s.workspace).toEqual({ code: 'unknown', outcome: 'skipped', committedAgeS: null });
  });

  it('loadTrackerState tolerates garbage', () => {
    expect(loadTrackerState(undefined)).toEqual(emptyTrackerState());
    expect(loadTrackerState({ v: 2 })).toEqual(emptyTrackerState());
    expect(loadTrackerState('x')).toEqual(emptyTrackerState());
  });
});
