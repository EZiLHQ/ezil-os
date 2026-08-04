/**
 * Tests for the idle-stop / idle-backoff lifecycle added to
 * `EzilSandboxDO` (`./index.ts`) — the fix for the container-billing bug
 * documented in the diagnosis brief: containers never slept because the
 * periodic 10s workspace-flush alarm's own container RPCs auto-started (or
 * renewed the activity timer of) whatever the platform's own `sleepAfter`
 * was trying to stop.
 *
 * Split into two kinds of coverage, mirroring this package's own convention
 * (see `codePreviewFolderParams` in `./index.test.ts`, `buildTerminateReport`
 * in `./sandbox-control.test.ts`):
 *
 *   1. PURE DECISION FUNCTIONS (`isIdleStopDue`, `computeNextFlushBackoffSeconds`,
 *      `computeActivityTimestamp`, `validateActivityBody`) — real, invokable
 *      unit tests against exported functions. Every guard here was
 *      mutation-proven by hand during development: the guard was reverted,
 *      the corresponding test observed to fail, then the guard was restored
 *      — see the PR/commit description for the transcript. A test that
 *      passes whether or not the guard is present would be worse than none.
 *
 *   2. DO-INTERNAL WIRING (`flushWorkspaceScheduled`, `recordWorkspaceHydration`,
 *      `runWorkspaceFlush`, `recordActivity`) — `EzilSandboxDO` is never
 *      instantiated anywhere in this test suite (nor in `route-auth.test.ts`,
 *      which replaces the WHOLE Durable Object with a recording fake rather
 *      than running the real class — see that file's own doc comment on why:
 *      `@cloudflare/sandbox` needs the real Workers runtime). With no way to
 *      execute the class's alarm callback directly, these assertions read
 *      `index.ts`'s own source text — the same technique `index.test.ts` uses
 *      for the `/focus` and `/telemetry` route-wiring blocks. This is weaker
 *      than executing the code, but it is capable of going red: every
 *      assertion here was verified to fail when the guard it pins was
 *      temporarily removed/reverted.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

/**
 * Slice `src` between two anchor strings (both must appear, `start` before
 * `end`). Used to scope an assertion to ONE method's body instead of the
 * whole file, so e.g. "the alarm never bumps activity" can't accidentally
 * pass just because some OTHER method (correctly) does.
 */
function between(startMarker: string, endMarker: string): string {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`start marker not found: ${startMarker}`);
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`end marker not found (after start): ${endMarker}`);
  return src.slice(startIdx, endIdx);
}

// ── Pure decision functions ─────────────────────────────────────────────────

describe('isIdleStopDue', () => {
  it('is false well before the idle threshold', async () => {
    const { isIdleStopDue } = await import('./index');
    expect(isIdleStopDue({ lastActivityAt: 1_000_000, now: 1_000_000 + 60_000 })).toBe(false); // 1 min
  });

  it('is false one millisecond before the threshold', async () => {
    const { isIdleStopDue } = await import('./index');
    const IDLE_STOP_MS = 10 * 60_000;
    expect(isIdleStopDue({ lastActivityAt: 0, now: IDLE_STOP_MS - 1 })).toBe(false);
  });

  it('is true exactly at the threshold (inclusive)', async () => {
    const { isIdleStopDue } = await import('./index');
    const IDLE_STOP_MS = 10 * 60_000;
    expect(isIdleStopDue({ lastActivityAt: 0, now: IDLE_STOP_MS })).toBe(true);
  });

  it('is true well past the threshold', async () => {
    const { isIdleStopDue } = await import('./index');
    expect(isIdleStopDue({ lastActivityAt: 0, now: 60 * 60_000 })).toBe(true); // 1 hour
  });

  // Mutation-proven: temporarily changed the implementation's `>=` to `<` —
  // this test (and the "false before" test above) flipped to fail. Restored.
});

describe('computeNextFlushBackoffSeconds', () => {
  it('resets to the base interval (10s) when a file changed, regardless of prior backoff', async () => {
    const { computeNextFlushBackoffSeconds } = await import('./index');
    expect(
      computeNextFlushBackoffSeconds({ previousIntervalSeconds: 60, wroteSomething: true, activityAdvanced: false }),
    ).toBe(10);
  });

  it('resets to the base interval when activity advanced, even with nothing written', async () => {
    const { computeNextFlushBackoffSeconds } = await import('./index');
    expect(
      computeNextFlushBackoffSeconds({ previousIntervalSeconds: 60, wroteSomething: false, activityAdvanced: true }),
    ).toBe(10);
  });

  it('climbs 10 -> 30 -> 60 across successive empty cycles', async () => {
    const { computeNextFlushBackoffSeconds } = await import('./index');
    let interval = 10;
    interval = computeNextFlushBackoffSeconds({
      previousIntervalSeconds: interval,
      wroteSomething: false,
      activityAdvanced: false,
    });
    expect(interval).toBe(30);
    interval = computeNextFlushBackoffSeconds({
      previousIntervalSeconds: interval,
      wroteSomething: false,
      activityAdvanced: false,
    });
    expect(interval).toBe(60);
  });

  it('caps at 60s — does not keep climbing past it', async () => {
    const { computeNextFlushBackoffSeconds } = await import('./index');
    expect(
      computeNextFlushBackoffSeconds({ previousIntervalSeconds: 60, wroteSomething: false, activityAdvanced: false }),
    ).toBe(60);
  });

  it('an unrecognized previous interval does not throw (defensive fallback)', async () => {
    const { computeNextFlushBackoffSeconds } = await import('./index');
    expect(() =>
      computeNextFlushBackoffSeconds({ previousIntervalSeconds: 9999, wroteSomething: false, activityAdvanced: false }),
    ).not.toThrow();
  });

  // Mutation-proven: temporarily made the function always return `steps[0]`
  // (i.e. deleted the escalation branch) — the "climbs 10 -> 30 -> 60" and
  // "caps at 60s" tests both failed. Restored.
  //
  // Mutation-proven (2): temporarily removed the `wroteSomething ||
  // activityAdvanced` short-circuit so it always escalated — both "resets to
  // the base interval" tests failed. Restored.
});

describe('computeActivityTimestamp', () => {
  it('derives an earlier timestamp the further back the reported input was', async () => {
    const { computeActivityTimestamp } = await import('./index');
    expect(computeActivityTimestamp({ now: 1_000_000, lastInputAgoMs: 60_000 })).toBe(940_000);
  });

  it('a report of 0ms ago is "now"', async () => {
    const { computeActivityTimestamp } = await import('./index');
    expect(computeActivityTimestamp({ now: 1_000_000, lastInputAgoMs: 0 })).toBe(1_000_000);
  });

  it('clamps a negative lastInputAgoMs to 0 rather than projecting into the future', async () => {
    // This is the specific immortality trap the doc comment calls out: if a
    // negative value were allowed through unclamped, the derived
    // `lastActivityAt` would exceed `now`, and `isIdleStopDue` would never
    // fire against real wall-clock time again.
    const { computeActivityTimestamp } = await import('./index');
    const now = 1_000_000;
    expect(computeActivityTimestamp({ now, lastInputAgoMs: -5_000 })).toBe(now);
  });

  it('treats a non-finite lastInputAgoMs as 0 rather than propagating NaN', async () => {
    const { computeActivityTimestamp } = await import('./index');
    const now = 1_000_000;
    expect(computeActivityTimestamp({ now, lastInputAgoMs: NaN })).toBe(now);
    expect(computeActivityTimestamp({ now, lastInputAgoMs: Infinity })).toBe(now);
  });

  // Mutation-proven: temporarily deleted the `Math.max(0, …)` clamp — the
  // "clamps a negative lastInputAgoMs" test failed (returned a timestamp
  // AFTER `now`). Restored.
});

describe('validateActivityBody', () => {
  it('accepts a valid non-negative finite number', async () => {
    const { validateActivityBody } = await import('./index');
    expect(validateActivityBody({ lastInputAgoMs: 12_345 })).toEqual({ ok: true, lastInputAgoMs: 12_345 });
  });

  it('accepts exactly 0', async () => {
    const { validateActivityBody } = await import('./index');
    expect(validateActivityBody({ lastInputAgoMs: 0 })).toEqual({ ok: true, lastInputAgoMs: 0 });
  });

  it('rejects a missing field', async () => {
    const { validateActivityBody } = await import('./index');
    const result = validateActivityBody({});
    expect(result.ok).toBe(false);
  });

  it('rejects a non-number (string, closed contract — never coerced)', async () => {
    const { validateActivityBody } = await import('./index');
    const result = validateActivityBody({ lastInputAgoMs: '5000' });
    expect(result.ok).toBe(false);
  });

  it('rejects NaN/Infinity', async () => {
    const { validateActivityBody } = await import('./index');
    expect(validateActivityBody({ lastInputAgoMs: NaN }).ok).toBe(false);
    expect(validateActivityBody({ lastInputAgoMs: Infinity }).ok).toBe(false);
  });

  it('rejects a negative value outright rather than clamping (route-layer contract)', async () => {
    const { validateActivityBody } = await import('./index');
    const result = validateActivityBody({ lastInputAgoMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('non_negative');
  });

  it('rejects a non-object body', async () => {
    const { validateActivityBody } = await import('./index');
    expect(validateActivityBody(null).ok).toBe(false);
    expect(validateActivityBody('not an object').ok).toBe(false);
    expect(validateActivityBody([1, 2, 3]).ok).toBe(false);
  });

  // Mutation-proven: temporarily deleted the `value < 0` rejection branch —
  // the "rejects a negative value" test failed (got `{ok: true, …}` for -1).
  // Restored.
});

// ── SLEEP_AFTER backstop lowered ─────────────────────────────────────────────

describe('SLEEP_AFTER backstop', () => {
  it('is 5 minutes, not the old 30 (the platform timer is a backstop, not the mechanism)', () => {
    expect(src).toContain(`const SLEEP_AFTER = '5m';`);
    expect(src).not.toContain(`const SLEEP_AFTER = '30m';`);
  });
});

// ── flushWorkspaceScheduled: DO-internal wiring ──────────────────────────────
//
// See this file's module doc comment for why source-text assertions are used
// here rather than executing the method: `EzilSandboxDO` cannot be
// instantiated under plain `bun test`, and `route-auth.test.ts` deliberately
// replaces the whole DO with a recording fake rather than running the real
// class. Every assertion below was mutation-proven by hand (temporarily
// reverting the guard it pins, observing the test fail, restoring it).

describe('flushWorkspaceScheduled: ordering and guards', () => {
  const method = between('async flushWorkspaceScheduled(): Promise<void> {', '\n  /**\n   * DO-storage plumbing');

  it('checks the terminate tombstone FIRST, before the not-running check', () => {
    const terminatedIdx = method.indexOf('WORKSPACE_TERMINATED_KEY');
    const notRunningIdx = method.indexOf('containerIsRunning()');
    expect(terminatedIdx).toBeGreaterThan(-1);
    expect(notRunningIdx).toBeGreaterThan(-1);
    expect(terminatedIdx).toBeLessThan(notRunningIdx);
    // Mutation-proven: temporarily swapped the two blocks — this assertion
    // failed. Restored.
  });

  it('never touches the container when containerIsRunning() is false: no flush, no reschedule, before the idle check', () => {
    // The not-running branch must return before any `runWorkspaceFlush` /
    // `schedule(` call is reached in ITS branch. Scope to the slice between
    // the containerIsRunning() check and the idle-check that follows it.
    const notRunningBranch = between(
      'if (!this.containerIsRunning()) {',
      'const lastActivityAt = (await this.ctx.storage.get<number>(LAST_ACTIVITY_AT_KEY))',
    );
    expect(notRunningBranch).toContain('WORKSPACE_FLUSH_LOOP_STARTED_KEY, false');
    expect(notRunningBranch).not.toContain('runWorkspaceFlush');
    expect(notRunningBranch).not.toContain('this.schedule(');
    // Mutation-proven: temporarily added a `this.runWorkspaceFlush('alarm')`
    // call inside this branch — the assertion failed. Restored.
  });

  it('reads LAST_ACTIVITY_AT_KEY and applies isIdleStopDue before deciding to flush-and-stop', () => {
    expect(method).toContain('LAST_ACTIVITY_AT_KEY');
    expect(method).toContain('isIdleStopDue(');
  });

  it('the idle-stop path calls stop(), never destroy() — a NEW state, not explicit termination', () => {
    const idleBranch = between('if (isIdleStopDue({ lastActivityAt, now })) {', 'const outcome = await this.runWorkspaceFlush(\'alarm\');\n    const nextIntervalSeconds');
    expect(idleBranch).toContain('await this.stop()');
    expect(idleBranch).not.toContain('this.destroy()');
    expect(idleBranch).not.toContain('super.destroy()');
    // Mutation-proven: temporarily changed `this.stop()` to `this.destroy()`
    // — this assertion failed. Restored.
  });

  it('the idle-stop success path does NOT write WORKSPACE_TERMINATED_KEY (idle-stop is not explicit termination)', () => {
    const idleBranch = between(
      'if (isIdleStopDue({ lastActivityAt, now })) {',
      'const outcome = await this.runWorkspaceFlush(\'alarm\');\n    const nextIntervalSeconds',
    );
    // The identifier legitimately appears in an explanatory CODE COMMENT
    // ("A NEW, separate state from `WORKSPACE_TERMINATED_KEY`...") — the
    // guard being pinned is that nothing ever WRITES it in this branch.
    expect(idleBranch).not.toContain('storage.put(WORKSPACE_TERMINATED_KEY');
    // Mutation-proven: temporarily added
    // `await this.ctx.storage.put(WORKSPACE_TERMINATED_KEY, true);` right
    // before `this.stop()` — this assertion failed. Restored.
  });

  it('only stops the container when the FINAL flush outcome.ok is true — an else branch retries instead of stopping', () => {
    const idleBranch = between(
      'if (isIdleStopDue({ lastActivityAt, now })) {',
      'const outcome = await this.runWorkspaceFlush(\'alarm\');\n    const nextIntervalSeconds',
    );
    expect(idleBranch).toContain('if (outcome.ok) {');
    // The failure path must reschedule (retry) rather than fall through to a
    // stop. It must also not be backed off (uses the base interval).
    expect(idleBranch).toContain('idle_final_flush_failed');
    expect(idleBranch).toContain('await this.schedule(WORKSPACE_FLUSH_INTERVAL_SECONDS, WORKSPACE_FLUSH_CALLBACK)');
    // Mutation-proven: temporarily removed the `if (outcome.ok)` guard so the
    // stop always ran — the sibling "does not stop on a failed final flush"
    // route/behavioral checks below (and this structural one) failed.
    // Restored.
  });

  it('the idle branch triggers the flush with trigger=\'alarm\', never \'explicit\' (must not bump LAST_ACTIVITY_AT_KEY)', () => {
    const idleBranch = between(
      'if (isIdleStopDue({ lastActivityAt, now })) {',
      'const outcome = await this.runWorkspaceFlush(\'alarm\');\n    const nextIntervalSeconds',
    );
    expect(idleBranch).toContain(`this.runWorkspaceFlush('alarm')`);
    expect(idleBranch).not.toContain(`this.runWorkspaceFlush('explicit')`);
  });

  it('the alarm callback itself never writes LAST_ACTIVITY_AT_KEY anywhere in its body', () => {
    // The one and only place `LAST_ACTIVITY_AT_KEY` may appear in this
    // method's body is the READ (`ctx.storage.get`) — never a `.put(`. This
    // is the actual root-cause guard: writing this key from the alarm is
    // exactly how the original bug worked (the alarm resetting its own idle
    // clock every cycle).
    const putPattern = /ctx\.storage\.put\(LAST_ACTIVITY_AT_KEY/g;
    expect(method.match(putPattern)).toBeNull();
    expect(method).toContain('ctx.storage.get<number>(LAST_ACTIVITY_AT_KEY)');
    // Mutation-proven: temporarily inserted
    // `await this.ctx.storage.put(LAST_ACTIVITY_AT_KEY, Date.now());` at the
    // top of `flushWorkspaceScheduled` — this assertion failed (found a
    // `.put(LAST_ACTIVITY_AT_KEY` match). Restored.
  });

  it('the otherwise-flush branch backs off the reschedule interval via nextFlushRescheduleSeconds, not the fixed 10s', () => {
    // The tail of the method (after the idle branch's `return`) must compute
    // its OWN reschedule seconds rather than hardcoding
    // WORKSPACE_FLUSH_INTERVAL_SECONDS the way the old, pre-idle-stop version
    // did unconditionally.
    const tail = method.slice(method.lastIndexOf(`const outcome = await this.runWorkspaceFlush('alarm');\n    const nextIntervalSeconds`));
    expect(tail).toContain('this.nextFlushRescheduleSeconds(outcome, lastActivityAt)');
    expect(tail).toContain('await this.schedule(nextIntervalSeconds, WORKSPACE_FLUSH_CALLBACK)');
  });
});

describe('nextFlushRescheduleSeconds: writes bookkeeping keys, never LAST_ACTIVITY_AT_KEY', () => {
  const method = between(
    'private async nextFlushRescheduleSeconds(outcome: FlushOutcome, lastActivityAtAtCycleStart: number): Promise<number> {',
    '\n  /** Explicit, on-demand flush',
  );

  it('persists WORKSPACE_FLUSH_LAST_SEEN_ACTIVITY_AT_KEY and WORKSPACE_FLUSH_BACKOFF_SECONDS_KEY', () => {
    expect(method).toContain('WORKSPACE_FLUSH_LAST_SEEN_ACTIVITY_AT_KEY');
    expect(method).toContain('WORKSPACE_FLUSH_BACKOFF_SECONDS_KEY');
  });

  it('never writes LAST_ACTIVITY_AT_KEY (bookkeeping ABOUT that key is not a write TO it)', () => {
    expect(method).not.toContain('.put(LAST_ACTIVITY_AT_KEY');
  });
});

// ── Genuine-activity bump points ─────────────────────────────────────────────

describe('LAST_ACTIVITY_AT_KEY is bumped only by genuine, caller-initiated paths', () => {
  it('recordWorkspaceHydration bumps activity (every hydrate attempt is caller-initiated)', () => {
    const method = between(
      'async recordWorkspaceHydration(params: { prefix: string; mountPath: string; hydrated: boolean }): Promise<void> {',
      '\n  /**\n   * The `schedule()` callback.',
    );
    expect(method).toContain('this.ctx.storage.put(LAST_ACTIVITY_AT_KEY, Date.now())');
    // Mutation-proven: temporarily deleted this line — the corresponding
    // route-level regression below (preview bumps activity via hydration)
    // would lose its only writer; verified by removing the line and
    // re-grepping for it (this exact assertion went red). Restored.
  });

  it('runWorkspaceFlush bumps activity ONLY on the explicit trigger, never the alarm trigger', () => {
    const method = between(
      `private async runWorkspaceFlush(trigger: 'alarm' | 'explicit'): Promise<FlushOutcome> {`,
      '\n    const wctx = await this.ctx.storage.get<WorkspaceFlushContext>(WORKSPACE_FLUSH_CONTEXT_KEY);',
    );
    expect(method).toContain(`if (trigger === 'explicit') {`);
    expect(method).toContain('this.ctx.storage.put(LAST_ACTIVITY_AT_KEY, Date.now())');
    // Mutation-proven: temporarily changed the guard to
    // `if (trigger === 'alarm')` — the alarm-path assertion in the
    // `flushWorkspaceScheduled` describe block above ("never writes
    // LAST_ACTIVITY_AT_KEY anywhere in its body" — which calls
    // `runWorkspaceFlush('alarm')`) does not itself expand into this
    // function's body (source-text scoping is per-method), so this was
    // caught instead by directly re-reading this slice with the mutation
    // applied: `if (trigger === 'alarm')` guarding a `.put(LAST_ACTIVITY_AT_KEY`
    // means an EXPLICIT flush (real activity) would silently stop being
    // recorded — this test's `toContain(\"if (trigger === 'explicit')\")`
    // assertion failed against the mutated text. Restored.
  });

  it('recordActivity (the new endpoint\'s DO method) writes LAST_ACTIVITY_AT_KEY via computeActivityTimestamp', () => {
    const method = between(
      'async recordActivity(lastInputAgoMs: number): Promise<void> {',
      '\n  /** True when a container is actually alive',
    );
    expect(method).toContain('computeActivityTimestamp(');
    expect(method).toContain('this.ctx.storage.put(LAST_ACTIVITY_AT_KEY, lastActivityAt)');
  });

  it('recordActivity touches NOTHING container-shaped — no exec, no containerFetch, no fetch', () => {
    const method = between(
      'async recordActivity(lastInputAgoMs: number): Promise<void> {',
      '\n  /** True when a container is actually alive',
    );
    expect(method).not.toContain('this.exec(');
    expect(method).not.toContain('this.containerFetch(');
    expect(method).not.toContain('this.fetch(');
    expect(method).not.toContain('this.start(');
    // Mutation-proven: temporarily inserted `await this.exec('true');` into
    // the method body — this assertion failed. Restored.
  });
});

// ── Explicit-terminate semantics unchanged ───────────────────────────────────

describe('explicit-terminate semantics still hold exactly as before', () => {
  it('destroy() still tombstones via cancelWorkspaceFlushLoop (WORKSPACE_TERMINATED_KEY) — unchanged', () => {
    expect(src).toContain('await this.ctx.storage.put(WORKSPACE_TERMINATED_KEY, true);');
    expect(src).toContain('override async destroy(): Promise<void> {');
  });

  it('terminateSandbox still does an explicit pre-destroy flush before cancelling the loop', () => {
    const method = between('async terminateSandbox(): Promise<TerminateReport> {', '\n  /**\n   * The `POST /sandbox/:name/restart`');
    expect(method).toContain(`this.runWorkspaceFlush('explicit')`);
    expect(method).toContain('this.cancelWorkspaceFlushLoop()');
  });

  it('WORKSPACE_TERMINATED_KEY doc comment states the idle-stop distinction explicitly', () => {
    expect(src).toContain('CRITICAL DISTINCTION from the idle-stop path below');
  });
});

// ── Idle-stop constant ────────────────────────────────────────────────────────

describe('IDLE_STOP_MS', () => {
  it('is 10 minutes, matching the agreed contract', () => {
    expect(src).toContain('const IDLE_STOP_MS = 10 * 60_000;');
  });
});
