/**
 * The one link in the release-on-close chain that lives on neither side of it.
 *
 * Closing a desktop window now reports that presence ENDED, by reusing the
 * activity transport with a deliberately stale age (`releaseDesktop` in
 * `shell/ezil/session.js`). Nothing else about the wire changes: same route,
 * same body, same `EzilSandboxDO.recordActivity`, same idle-stop path. That is
 * the whole point — the shell gains no capability to destroy a container, and
 * an older Worker needs no change at all to honour a release.
 *
 * Which leaves exactly one thing unproven by either side's own tests:
 *
 *   the shell picks a NUMBER, and the Worker's idle rule reads a THRESHOLD,
 *   and if the first ever falls below the second the release silently becomes
 *   an ordinary heartbeat — a close that reports "I'm still here".
 *
 * `shell/ezil/apps/desktop-close-test.mjs` proves the shell sends the number.
 * `./workspace-idle.test.ts` proves each Worker-side function is correct. This
 * file composes the REAL functions from both sides, in the order the
 * production path runs them, and asserts the outcome that actually matters:
 * that a released sandbox is due to stop on the very next flush alarm.
 *
 * It imports the shell module rather than restating its constant, so lowering
 * `ACTIVITY_FRESH_MS` under the Worker's `IDLE_STOP_MS` fails HERE instead of
 * shipping a close that releases nothing.
 *
 * 🔴 What this does NOT prove: that the container actually stops. The stop is
 * additionally gated on a `/proc/loadavg` busy probe and on a successful final
 * workspace flush, neither of which exists outside a real container. See this
 * task's report.
 */

import { describe, expect, it, mock } from 'bun:test';

// Same reason as `./workspace-idle.test.ts`: `./index.ts` pulls in
// `@cloudflare/sandbox`, which imports the workerd-only `cloudflare:workers`.
// Registered here so this file can be run on its own.
mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

describe('release-on-close: the shell number and the Worker threshold must agree', () => {
  it('a release reported by the shell makes the sandbox idle-stop-due immediately', async () => {
    const { computeActivityTimestamp, isIdleStopDue, validateActivityBody } = await import('./index');
    // The REAL shell constant, from the REAL shell module.
    const { ACTIVITY_FRESH_MS } = await import('../../shell/ezil/activity-heartbeat.js');

    const now = 1_800_000_000_000;
    // 1. What `session.releaseDesktop` puts on the wire, through the route's
    //    own validator — a release must not be rejected as a bad body.
    const validated = validateActivityBody({ lastInputAgoMs: ACTIVITY_FRESH_MS });
    expect(validated).toEqual({ ok: true, lastInputAgoMs: ACTIVITY_FRESH_MS });

    // 2. What `EzilSandboxDO.recordActivity` writes to `LAST_ACTIVITY_AT_KEY`.
    const lastActivityAt = computeActivityTimestamp({
      now,
      lastInputAgoMs: (validated as { ok: true; lastInputAgoMs: number }).lastInputAgoMs,
    });

    // 3. What the next flush alarm decides, with no time having passed at all.
    expect(isIdleStopDue({ lastActivityAt, now })).toBe(true);
  });

  it('an ordinary heartbeat over the same wire still does NOT stop anything', async () => {
    const { computeActivityTimestamp, isIdleStopDue } = await import('./index');
    const { HEARTBEAT_INTERVAL_MS } = await import('../../shell/ezil/activity-heartbeat.js');

    const now = 1_800_000_000_000;
    // A user who was present one heartbeat ago is present, and the difference
    // between that and a release is ONLY the number — which is exactly why the
    // number has to be checked.
    const lastActivityAt = computeActivityTimestamp({ now, lastInputAgoMs: HEARTBEAT_INTERVAL_MS });
    expect(isIdleStopDue({ lastActivityAt, now })).toBe(false);
  });
});
