import { describe, expect, it } from 'bun:test';

import {
  emptyTrackerState,
  isComputerUuid,
  loadTrackerState,
  markEmitted,
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

/** Existing emission-rule cases model a successful spool after each observation. */
function observeAndSpool(...args: Parameters<typeof observe>): ReturnType<typeof observe> {
  const result = observe(...args);
  return { events: result.events, state: markEmitted(result.state, result.events, args[2]) };
}

function run(obs: PersistenceObservation[], start: PersistenceTrackerState = emptyTrackerState(), stepMs = 10_000, ctx = { computerId: COMPUTER }) {
  let state = start;
  const events: ReturnType<typeof observe>['events'] = [];
  obs.forEach((o, i) => {
    const r = observeAndSpool(state, o, T0 + i * stepMs, ctx);
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
  for (const layer of ['system', 'workspace'] as const) {
    it(`${layer}: repeated opens preserve the real restore and suppress identical flushes`, () => {
      const restore: PersistenceObservation = { kind: 'restore', layer, code: 'failed', trigger: 'open' };
      const already: PersistenceObservation = { ...restore, code: 'already_restored' };
      const restored = observeAndSpool(emptyTrackerState(), restore, T0).state;
      const reopen = observeAndSpool(restored, already, T0 + 1);
      expect(reopen.state).toBe(restored);
      expect(reopen.events).toHaveLength(0);
      const flush: PersistenceObservation = { kind: 'flush', layer, code: 'too_large', trigger: 'interval' };
      const { state, events } = run([restore, flush, already, flush, already, flush]);
      expect(events.map((e) => `${e.site}:${e.code}`)).toEqual([
        `persist.${layer}.restore:failed`, `persist.${layer}.flush:too_large`,
      ]);
      expect(state[layer].consecutiveFailures).toBe(4);
      expect(observeAndSpool(state, { ...restore, code: 'ok' }, T0 + 60_000).events).toHaveLength(1);
    });
  }

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
    let state = observeAndSpool(emptyTrackerState(), sysFlush('ok'), T0).state;
    expect(observeAndSpool(state, { kind: 'heartbeat', running: true }, T0 + PERSISTENCE_HEARTBEAT_MS - 1).events).toHaveLength(0);
    expect(observeAndSpool(state, { kind: 'heartbeat', running: false }, T0 + PERSISTENCE_HEARTBEAT_MS).events).toHaveLength(0);
    const hb = observeAndSpool(state, { kind: 'heartbeat', running: true }, T0 + PERSISTENCE_HEARTBEAT_MS);
    expect(hb.events).toHaveLength(1);
    expect(hb.events[0]).toMatchObject({ site: 'persist.heartbeat', code: 'ok', attrs: { trigger: 'heartbeat', system_age_s: 900 } });
    state = hb.state;
    // The heartbeat itself resets the clock.
    expect(observeAndSpool(state, { kind: 'heartbeat', running: true }, T0 + PERSISTENCE_HEARTBEAT_MS + 60_000).events).toHaveLength(0);
  });

  it('a frozen computer still heartbeats with its blocking code while suppressed', () => {
    let state = emptyTrackerState();
    let count = 0;
    for (let t = 0; t <= 60 * 60_000; t += 10_000) {
      const a = observeAndSpool(state, sysFlush('too_large'), T0 + t);
      const b = observeAndSpool(a.state, { kind: 'heartbeat', running: true }, T0 + t);
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
    const state = observeAndSpool(emptyTrackerState(), sysFlush('ok'), T0).state;
    const before = structuredClone(state);
    for (const obs of [
      { kind: 'heartbeat', running: false }, { kind: 'heartbeat', running: true },
      sysFlush('busy'), wsFlush('deferred'),
    ] as PersistenceObservation[]) {
      const result = observeAndSpool(state, obs, T0 + 1);
      expect(result.state).toBe(state);
      expect(result.events).toHaveLength(0);
    }
    expect(state).toEqual(before);
  });

  it('returns the same state for an identical successful restore or a flush at the same time', () => {
    const restore: PersistenceObservation = { kind: 'restore', layer: 'system', code: 'ok', trigger: 'open' };
    const restored = observeAndSpool(emptyTrackerState(), restore, T0).state;
    expect(observeAndSpool(restored, restore, T0 + 10_000).state).toBe(restored);
    const flushed = observeAndSpool(restored, sysFlush('ok'), T0).state;
    expect(observeAndSpool(flushed, sysFlush('ok'), T0).state).toBe(flushed);
  });

  it('still updates commit times and failure counts when an event is suppressed, without mutating prior state', () => {
    for (const code of ['ok', 'failed']) {
      const prev = observeAndSpool(emptyTrackerState(), sysFlush(code), T0).state;
      const before = structuredClone(prev);
      const result = observeAndSpool(prev, sysFlush(code), T0 + 10_000);
      expect(result.events).toHaveLength(0);
      expect(result.state).not.toBe(prev);
      expect(prev).toEqual(before);
      if (code === 'ok') expect(result.state.system.lastOkCommitAt).toBe(T0 + 10_000);
      else expect(result.state.system.consecutiveFailures).toBe(2);
    }
  });

  it('stop events advance the emission clock only after acknowledgement', () => {
    const obs: PersistenceObservation = { kind: 'stop', trigger: 'idle_stop' };
    const prev = observeAndSpool(emptyTrackerState(), obs, T0).state;
    const repeat = observe(prev, obs, T0);
    expect(repeat.events).toHaveLength(1);
    expect(repeat.state.lastEventAt).toBe(T0);
    expect(repeat.state.pending).toEqual(repeat.events);
    const later = observeAndSpool(prev, obs, T0 + 1);
    expect(later.state).not.toBe(prev);
    expect(later.state.lastEventAt).toBe(T0 + 1);
    expect(prev.lastEventAt).toBe(T0);
  });
});

describe('confirmed spool markers', () => {
  it('updates status immediately, retries failures, and suppresses only after acknowledgement', () => {
    const first = observe(emptyTrackerState(), sysFlush('too_large'), T0);
    expect(statusFrom(first.state, T0)).toMatchObject({ savingPaused: true, pausedReason: 'too_large' });
    expect(first.state.lastEventAt).toBeNull();
    expect(first.state.emitted.system).toBeNull();
    let state = loadTrackerState(structuredClone(first.state));
    for (let i = 1; i <= 30; i++) {
      const retry = observe(state, sysFlush('too_large'), T0 + i);
      expect(retry.events).toHaveLength(1);
      expect(retry.state.pending).toEqual(retry.events);
      expect(retry.state.lastEventAt).toBeNull();
      state = retry.state;
    }
    const confirmed = markEmitted(state, state.pending, T0 + 31);
    expect(confirmed.pending).toHaveLength(0);
    expect(confirmed.lastEventAt).toBe(T0 + 31);
    expect(observe(confirmed, sysFlush('too_large'), T0 + 32).events).toHaveLength(0);
    expect(confirmed.system.consecutiveFailures).toBe(31);
  });

  it('keeps only the newest pending batch and preserves live status when an older write completes', () => {
    const healthy = observeAndSpool(emptyTrackerState(), sysFlush('ok'), T0).state;
    const failed = observe(healthy, sysFlush('failed'), T0 + 1);
    const recovered = observe(failed.state, sysFlush('ok'), T0 + 2);
    expect(recovered.events.map((event) => event.code)).toEqual(['ok']);
    expect(recovered.state.pending).toHaveLength(1);
    const oldWrite = markEmitted(recovered.state, failed.events, T0 + 3);
    expect(oldWrite.system.code).toBe('ok');
    expect(oldWrite.system.lastOkCommitAt).toBe(T0 + 2);
    expect(oldWrite.emitted.system?.code).toBe('failed');
    expect(oldWrite.pending).toEqual(recovered.events);
    expect(markEmitted(oldWrite, recovered.events, T0 + 4).pending).toHaveLength(0);
  });

  it('acknowledges only the emitted layer and coalesces identical in-flight repeats', () => {
    const first = observe(emptyTrackerState(), sysFlush('failed'), T0);
    const repeat = observe(first.state, sysFlush('failed'), T0 + 1);
    const confirmed = markEmitted(repeat.state, first.events, T0 + 2);
    expect(confirmed.pending).toHaveLength(0);
    expect(confirmed.system.consecutiveFailures).toBe(2);
    const workspace = observe(first.state, wsFlush('too_large'), T0 + 1);
    const otherLayer = markEmitted(workspace.state, first.events, T0 + 2);
    expect(otherLayer.pending).toEqual(workspace.events);
    expect(otherLayer.emitted.workspace).toBeNull();
    expect(otherLayer.workspace.code).toBe('too_large');
  });

  it('retries a pending transition on a heartbeat without replacing it or advancing the clock', () => {
    const first = observe(emptyTrackerState(), sysFlush('failed'), T0);
    const retry = observe(first.state, { kind: 'heartbeat', running: true }, T0 + PERSISTENCE_HEARTBEAT_MS);
    expect(retry.events).toEqual(first.events);
    expect(retry.state.lastEventAt).toBeNull();
    const heartbeat = observe(emptyTrackerState(), { kind: 'heartbeat', running: true }, T0);
    expect(observe(heartbeat.state, { kind: 'heartbeat', running: true }, T0 + 1).events).toEqual(heartbeat.events);
  });

  it('retains legacy operational status without trusting its pre-spool deduplication state', () => {
    const { emitted, pending, ...legacy } = observeAndSpool(emptyTrackerState(), sysFlush('failed'), T0).state;
    const loaded = loadTrackerState(legacy);
    expect(loaded.system).toEqual(legacy.system);
    expect(loaded.lastEventAt).toBeNull();
    expect(observe(loaded, sysFlush('failed'), T0 + 1).events).toHaveLength(1);
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
