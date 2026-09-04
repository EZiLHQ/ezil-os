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

import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `./index.ts` pulls in `@cloudflare/sandbox`, which imports the workerd-only
// `cloudflare:workers`. Registered HERE rather than relied upon from whichever
// other test file happens to load first: this module used to import cleanly
// only because `route-auth.test.ts` had already stubbed the specifier, so
// running this file on its own — or in any smaller selection, e.g. while
// mutation-testing a single guard — failed every `await import('./index')`
// with "Cannot find package 'cloudflare:workers'". A test that can only pass
// in one particular whole-suite ordering is not a test you can bisect with.
mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

// Line endings normalised to LF. `.gitattributes` declares `* text=auto`, so a
// Windows checkout (`core.autocrlf=true`, the GitHub-hosted runner default)
// writes `index.ts` into the working tree with CRLF, and every multi-line
// marker handed to `between()` below is written with `\n`. MEASURED against a
// CRLF copy of this whole package: two assertions here threw
// "end marker not found (after start)" — `recordWorkspaceHydration bumps
// activity` and `terminateSandbox still does an explicit pre-destroy flush` —
// while the other 38 in this file passed. A checkout's line-ending policy is
// not a fact about the Worker. Inert on LF.
const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

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

// ── SIGNAL B: the container-busy probe ───────────────────────────────────────
//
// `isIdleStopDue` above answers "is anybody there". These answer the other
// half of the owner requirement — "is the box doing work" — so that a user
// who kicks off a `bun install` and then goes to read something else does not
// come back to a container that was stopped mid-build.

describe('parseLoadAvg1', () => {
  it('reads the 1-minute figure out of a real /proc/loadavg line', async () => {
    const { parseLoadAvg1 } = await import('./index');
    expect(parseLoadAvg1('0.42 0.31 0.28 1/512 1234')).toBe(0.42);
  });

  it('reads a genuinely idle 0.00 as the NUMBER zero, not as "no answer"', async () => {
    // The distinction matters: 0 authorizes a stop, `null` refuses one.
    const { parseLoadAvg1 } = await import('./index');
    expect(parseLoadAvg1('0.00 0.01 0.05 1/234 567\n')).toBe(0);
  });

  it('tolerates leading/trailing whitespace and a trailing newline', async () => {
    const { parseLoadAvg1 } = await import('./index');
    expect(parseLoadAvg1('  1.75 1.20 0.90 3/512 99  \n')).toBe(1.75);
  });

  it('reads a load above 1 on a multi-core box', async () => {
    const { parseLoadAvg1 } = await import('./index');
    expect(parseLoadAvg1('12.5 8.0 4.0 9/900 1')).toBe(12.5);
  });

  // 🔴 Every one of these must be `null`, never a number. A parser that
  // invented a `0` here would hand `containerBusyFromProbe` an authorization
  // to stop a container based on output it never actually understood.
  it('returns null for empty stdout rather than coercing it to 0', async () => {
    const { parseLoadAvg1 } = await import('./index');
    expect(parseLoadAvg1('')).toBeNull();
    expect(parseLoadAvg1('   \n')).toBeNull();
  });

  it('returns null for a non-numeric first token', async () => {
    const { parseLoadAvg1 } = await import('./index');
    expect(parseLoadAvg1('cat: /proc/loadavg: No such file or directory')).toBeNull();
  });

  it('returns null for a partially-numeric token rather than the number it starts with', async () => {
    const { parseLoadAvg1 } = await import('./index');
    expect(parseLoadAvg1('0.5abc 1 1')).toBeNull();
  });

  it('🔴 refuses an exotic numeric literal JS would happily evaluate to a stop-authorizing number', async () => {
    // This is why the strict `^\d+(\.\d+)?$` check exists and a bare
    // `Number()` is not enough. `Number('5e-3')` is 0.005 and `Number('0x0')`
    // is 0 — both BELOW the busy threshold, i.e. both an authorization to
    // stop a container, manufactured out of a byte sequence `/proc/loadavg`
    // cannot produce. Everything the plain `Number.isFinite`/`< 0` checks
    // already reject lands on the safe side by luck; these two do not, so the
    // format check is the guard that actually carries the fail-safe here.
    const { parseLoadAvg1, containerBusyFromProbe } = await import('./index');
    expect(parseLoadAvg1('5e-3 1 1')).toBeNull();
    expect(parseLoadAvg1('0x0 1 1')).toBeNull();
    expect(containerBusyFromProbe({ exitCode: 0, stdout: '5e-3 1 1' }).busy).toBe(true);
    expect(containerBusyFromProbe({ exitCode: 0, stdout: '0x0 1 1' }).busy).toBe(true);
  });

  it('returns null for a negative figure (impossible for a load average)', async () => {
    const { parseLoadAvg1 } = await import('./index');
    expect(parseLoadAvg1('-1.0 0 0')).toBeNull();
  });

  it('does not throw on null/undefined stdout', async () => {
    const { parseLoadAvg1 } = await import('./index');
    expect(parseLoadAvg1(undefined as unknown as string)).toBeNull();
    expect(parseLoadAvg1(null as unknown as string)).toBeNull();
  });
});

describe('containerBusyFromProbe: 🔴 every way of not knowing is BUSY', () => {
  const THRESHOLD = 0.5; // must match CONTAINER_BUSY_LOAD1 in ./index.ts

  it('a quiet container (bench A: no session attached, load 0.00) is NOT busy — the stop may proceed', async () => {
    const { containerBusyFromProbe } = await import('./index');
    const verdict = containerBusyFromProbe({ exitCode: 0, stdout: '0.00 0.01 0.05 1/234 567' });
    expect(verdict.busy).toBe(false);
    expect(verdict.load1).toBe(0);
  });

  it('🔴 an ABANDONED but still-streaming session (bench B ceiling, 0.3055) is NOT busy — it must still stop', async () => {
    // This is the "tab merely left open" case from the billing brief and the
    // single largest slice of the bill: nobody is there, but Neko is still
    // software-encoding 1920x1080 vp8 at a quarter of a core. A threshold
    // that read this as "working" would veto exactly the stops that matter.
    const { containerBusyFromProbe } = await import('./index');
    expect(containerBusyFromProbe({ exitCode: 0, stdout: '0.3055 0.28 0.20 2/400 9' }).busy).toBe(false);
  });

  it('🔴 a container mid-build (bench C floor, 0.8054) IS busy — the stop is refused', async () => {
    const { containerBusyFromProbe } = await import('./index');
    const verdict = containerBusyFromProbe({ exitCode: 0, stdout: '0.8054 0.60 0.40 5/512 1' });
    expect(verdict.busy).toBe(true);
    expect(verdict.load1).toBe(0.8054);
  });

  it('a container deep in a parallel build (load 1.8 on 2 vCPU) IS busy', async () => {
    const { containerBusyFromProbe } = await import('./index');
    const verdict = containerBusyFromProbe({ exitCode: 0, stdout: '1.80 1.40 0.90 5/512 1' });
    expect(verdict.busy).toBe(true);
    expect(verdict.load1).toBe(1.8);
  });

  it('exactly at the threshold counts as busy (inclusive)', async () => {
    const { containerBusyFromProbe } = await import('./index');
    expect(containerBusyFromProbe({ exitCode: 0, stdout: `${THRESHOLD} 0 0` }).busy).toBe(true);
  });

  it('just below the threshold is not busy', async () => {
    const { containerBusyFromProbe } = await import('./index');
    expect(containerBusyFromProbe({ exitCode: 0, stdout: '0.49 0 0' }).busy).toBe(false);
  });

  it('🔴 a probe that THREW (null) is busy — a probe that cannot answer never authorizes a stop', async () => {
    const { containerBusyFromProbe } = await import('./index');
    const verdict = containerBusyFromProbe(null);
    expect(verdict.busy).toBe(true);
    expect(verdict.load1).toBeNull();
    expect(verdict.reason).toBe('probe_threw');
  });

  it('🔴 a non-zero exit code is busy, even with plausible-looking stdout', async () => {
    const { containerBusyFromProbe } = await import('./index');
    // A shell that failed but still echoed something must not be believed.
    const verdict = containerBusyFromProbe({ exitCode: 1, stdout: '0.00 0.00 0.00 1/1 1' });
    expect(verdict.busy).toBe(true);
    expect(verdict.load1).toBeNull();
  });

  it('🔴 unparseable stdout is busy', async () => {
    const { containerBusyFromProbe } = await import('./index');
    expect(containerBusyFromProbe({ exitCode: 0, stdout: 'cat: /proc/loadavg: Permission denied' }).busy).toBe(true);
    expect(containerBusyFromProbe({ exitCode: 0, stdout: '' }).busy).toBe(true);
  });

  it('reports the observed figure so an operator can tell "quiet" from "never answered"', async () => {
    const { containerBusyFromProbe } = await import('./index');
    expect(containerBusyFromProbe({ exitCode: 0, stdout: '0.03 0 0' }).load1).toBe(0.03);
    expect(containerBusyFromProbe({ exitCode: 0, stdout: 'nonsense' }).load1).toBeNull();
  });
});

describe('CONTAINER_BUSY_LOAD1', () => {
  it('is 0.50 — the geometric mean of two MEASURED bands, not a round guess', () => {
    expect(src).toContain('const CONTAINER_BUSY_LOAD1 = 0.5;');
  });

  it('sits between the two measured bands it has to tell apart', () => {
    // Bench B (abandoned but still streaming) never exceeded 0.3055; bench C
    // (one busy thread) never dropped below 0.8054. If someone retunes the
    // constant, this fails unless they land inside that gap.
    const match = /const CONTAINER_BUSY_LOAD1 = ([\d.]+);/.exec(src);
    expect(match).not.toBeNull();
    const threshold = Number(match![1]);
    expect(threshold).toBeGreaterThan(0.3055); // an abandoned session must still stop
    expect(threshold).toBeLessThan(0.8054); // a working container must not
  });

  it('documents the measurement it came from, so the number is auditable', () => {
    // A threshold with no recorded provenance is a guess that will be
    // "tidied" by the next reader. These pin the facts that justify it.
    expect(src).toContain('MEASURED, not guessed');
    expect(src).toContain('instance_type = "standard-3"');
    // The measured band that decides the number, and the reason it exists.
    expect(src).toContain('WebRTC SESSION ATTACHED');
  });

  it('probes the 1-minute average, whose window matches the 60s reschedule cap', () => {
    expect(src).toContain(`const LOADAVG_PROBE_COMMAND = 'cat /proc/loadavg';`);
  });
});

describe('probeContainerBusy: the I/O half fails safe', () => {
  const method = between(
    'private async probeContainerBusy(): Promise<{ busy: boolean; detail: string }> {',
    '\n  /**\n   * Tombstone this sandbox',
  );

  it('starts from `null` (= BUSY) and only overwrites it on a completed exec', () => {
    // The initializer is the fail-safe: if `this.exec` throws, `probe` is
    // still `null` when it reaches `containerBusyFromProbe`.
    expect(method).toContain('let probe: { exitCode: number; stdout: string } | null = null;');
    expect(method).toContain('await this.exec(LOADAVG_PROBE_COMMAND');
    expect(method).toContain('containerBusyFromProbe(probe)');
    // Mutation-proven: changed the initializer to
    // `{ exitCode: 0, stdout: '0 0 0' }` — this assertion failed, and it is
    // the exact mutation that would make a thrown probe authorize a stop.
  });

  it('swallows the exec error rather than letting it escape (an alarm crash would strand the loop)', () => {
    expect(method).toContain('} catch (err) {');
    expect(method).toContain('busy_probe_failed');
  });
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
  // `flushWorkspaceScheduled` is now a thin survival wrapper (it re-arms the
  // loop when the cycle THROWS — see `workspace-flush-loop.test.ts`, which
  // executes that behaviour rather than reading it); the ordered decision
  // logic these assertions pin lives in `runScheduledFlushCycle`.
  const method = between('private async runScheduledFlushCycle(): Promise<void> {', '\n  /**\n   * DO-storage plumbing');

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
    expect(notRunningBranch).not.toContain('runWorkspaceFlush');
    expect(notRunningBranch).not.toContain('this.schedule(');
    // Mutation-proven: temporarily added a `this.runWorkspaceFlush('alarm')`
    // call inside this branch — the assertion failed. Restored.
    //
    // The branch used to also write `WORKSPACE_FLUSH_LOOP_STARTED_KEY, false`
    // here. That key is gone (see `LEGACY_WORKSPACE_FLUSH_LOOP_STARTED_KEY` in
    // `index.ts`): "no reschedule" IS the stopped state now, because liveness
    // is read back out of the scheduler's own rows. `workspace-flush-loop.test.ts`
    // executes that end-to-end instead of grepping for it.
  });

  it('reads LAST_ACTIVITY_AT_KEY and applies isIdleStopDue before deciding to flush-and-stop', () => {
    expect(method).toContain('LAST_ACTIVITY_AT_KEY');
    expect(method).toContain('isIdleStopDue(');
  });

  // ── 🔴 SIGNAL B wiring: "no work" is checked before anything is stopped ────

  it('probes the container for work BEFORE the final flush and BEFORE the stop', () => {
    const idleBranch = between(
      'if (isIdleStopDue({ lastActivityAt, now })) {',
      "const outcome = await this.runWorkspaceFlush('alarm');\n    const nextIntervalSeconds",
    );
    const probeIdx = idleBranch.indexOf('await this.probeContainerBusy()');
    const flushIdx = idleBranch.indexOf("await this.runWorkspaceFlush('alarm')");
    const stopIdx = idleBranch.indexOf('await this.stop()');
    expect(probeIdx).toBeGreaterThan(-1);
    expect(flushIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeLessThan(flushIdx);
    expect(probeIdx).toBeLessThan(stopIdx);
    // Mutation-proven: moved the probe to AFTER `runWorkspaceFlush` — this
    // assertion failed. Restored.
  });

  it('🔴 a BUSY container returns without stopping, without flushing, and without destroying', () => {
    // Scope to the busy branch alone, so this cannot pass just because the
    // (correct) not-busy path further down does the right thing.
    const busyBranch = between('if (busy.busy) {', "// Trigger stays `'alarm'`");
    expect(busyBranch).not.toContain('this.stop()');
    expect(busyBranch).not.toContain('destroy()');
    expect(busyBranch).not.toContain('runWorkspaceFlush');
    expect(busyBranch).toContain('return;');
    // Mutation-proven: deleted the `if (busy.busy) { ... return; }` block
    // entirely — this whole test threw on its missing start marker, and the
    // "probes before the flush" test above went red too. Restored.
  });

  it('a BUSY container resets to the BASE interval and re-asks next cycle, rather than backing off', () => {
    const busyBranch = between('if (busy.busy) {', "// Trigger stays `'alarm'`");
    expect(busyBranch).toContain('await this.schedule(WORKSPACE_FLUSH_INTERVAL_SECONDS, WORKSPACE_FLUSH_CALLBACK)');
    // Persisted too, or `nextFlushRescheduleSeconds` would resume the ladder
    // from the stale rung the moment the container goes quiet again.
    expect(busyBranch).toContain('WORKSPACE_FLUSH_BACKOFF_SECONDS_KEY, WORKSPACE_FLUSH_INTERVAL_SECONDS');
    // Mutation-proven: changed the reschedule to
    // `this.nextFlushRescheduleSeconds(...)` — this assertion failed.
  });

  it('a BUSY container is NOT marked as a stopped loop (the alarm must keep running to re-ask)', () => {
    const busyBranch = between('if (busy.busy) {', "// Trigger stays `'alarm'`");
    // With liveness derived from the scheduler, "the loop is still running" is
    // now expressed by the reschedule itself, so THAT is what this pins. A
    // busy container that failed to reschedule would silently stop being
    // re-checked and never idle-stop at all — the pre-fix bug wearing a new
    // hat. Executed (not grepped) in `workspace-flush-loop.test.ts`.
    expect(busyBranch).toContain('await this.schedule(WORKSPACE_FLUSH_INTERVAL_SECONDS, WORKSPACE_FLUSH_CALLBACK)');
  });

  it('a BUSY container is not tombstoned either — busy is not termination', () => {
    const busyBranch = between('if (busy.busy) {', "// Trigger stays `'alarm'`");
    expect(busyBranch).not.toContain('storage.put(WORKSPACE_TERMINATED_KEY');
  });

  it('the busy probe runs only AFTER the containerIsRunning() gate (never resurrects a stopped box)', () => {
    const notRunningIdx = method.indexOf('containerIsRunning()');
    const probeIdx = method.indexOf('probeContainerBusy()');
    expect(notRunningIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(-1);
    expect(notRunningIdx).toBeLessThan(probeIdx);
    // The probe is an `exec`, and per the SDK a container RPC AUTO-STARTS a
    // stopped container — the exact resurrection this method's step 2 exists
    // to prevent. Mutation-proven: hoisted the probe above the
    // `containerIsRunning()` block — this assertion failed. Restored.
  });

  it('the observed load figure is logged on BOTH the busy and the stop path', () => {
    // Without this an operator cannot distinguish "genuinely quiet" from
    // "/proc/loadavg is reporting the host, so we answer BUSY forever and
    // silently never idle-stop again" — see CONTAINER_BUSY_LOAD1's
    // "Retuning it".
    const idleBranch = between(
      'if (isIdleStopDue({ lastActivityAt, now })) {',
      "const outcome = await this.runWorkspaceFlush('alarm');\n    const nextIntervalSeconds",
    );
    expect(idleBranch).toContain('idle_but_busy,${busy.detail}');
    expect(idleBranch).toContain('idle_stop,${busy.detail}');
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
