/**
 * Every backgrounded subshell in `start-neko.sh` must close fd 9.
 *
 * ── THE PRODUCTION FAILURE THIS EXISTS TO PREVENT ───────────────────────────
 * The boot mutex takes its lock with `exec 9>"$NEKO_BOOT_LOCK"` and holds it
 * for the life of the script. A `flock` is released only when EVERY file
 * descriptor referring to it is closed, and a backgrounded subshell inherits
 * its parent's open descriptors — so every `supervise_app` supervisor, the
 * cpu-diag loop and `monitor_apps` each kept fd 9 open. Supervisors are
 * `setsid`-detached and outlive a SIGTERM aimed at the launcher.
 *
 * The consequence was that the troubleshoot restart could not restart a
 * RUNNING desktop. After the stack was torn down, the old supervisors were
 * still holding the boot lock; the replacement boot's `flock -w` timed out,
 * took the documented "another boot is already in progress" path, and exited 0
 * without starting anything. Measured against the live Worker:
 *
 *     phase=restart event=start detail=mode=neko
 *     phase=container_start event=end status=ok phase_ms=60   <- process spawned
 *     phase=desktop_ready_wait event=start                    <- and then nothing
 *     ...183s later: outcome=boot_failed
 *
 * It failed selectively, in the most misleading way available: a restart with
 * nothing running succeeded in 13s (`outcome: started`), because there were no
 * survivors holding the lock. The troubleshoot button worked right up until
 * there was something to troubleshoot.
 *
 * ── WHY THIS IS A SOURCE TEST ───────────────────────────────────────────────
 * The obvious runtime test — boot, SIGKILL the launcher, boot again — does not
 * isolate this. A SIGKILL leaves the stub applications alive and holding their
 * ports, so the second boot fails to bind for a reason that has nothing to do
 * with the lock, and the test would pass or fail for the wrong cause. What is
 * cheaply and exactly checkable is the property itself: a `&` subshell that
 * has not closed fd 9.
 *
 * The claim is narrow and stated narrowly, in the same spirit as
 * `container-fetch-no-signal.test.ts`: it catches the literal shape that
 * shipped — `) &` without `9>&-` — and cannot catch a descriptor leaked some
 * other way.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, '../scripts/start-neko.sh'), 'utf8');

describe('start-neko.sh: the boot mutex must not leak into background jobs', () => {
  it('takes its lock on fd 9 — if this changes, every rule below is about the wrong number', () => {
    expect(SRC).toContain('exec 9>"$NEKO_BOOT_LOCK"');
  });

  it('🔴 every background job closes fd 9', () => {
    // The rule is simple because the mechanism is: ANY `&` job inherits the
    // parent's descriptors, so any of them can pin the lock. Linear scan, no
    // regex backtracking — the first version of this check was a nested
    // quantifier that timed out at 5s rather than answering.
    const offenders: string[] = [];
    SRC.split('\n').forEach((line, i) => {
      const code = line.replace(/#.*$/, '').trimEnd();
      if (!code.endsWith('&')) return;          // not a background job
      if (code.endsWith('&&')) return;          // an `and`, not a background job
      if (code.endsWith('>&')) return;          // a redirection fragment
      if (code.includes('9>&-')) return;        // closes it — the whole point
      offenders.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
    });
    expect(offenders).toEqual([]);
  });

  it('🔴 a background job mid-line — `( job & ) || true` — closes fd 9 too', () => {
    // The end-of-line rule above misses `&` followed by more shell: the boot's
    // dependency restore was launched as `( … & ) || true`, kept fd 9, and so a
    // troubleshoot restart during a long npm/pnpm restore could not take the lock
    // (PR195 review r4242108528). Any `&` that is not part of `&&`, `>&`, `<&` or
    // `&>` is a background operator; its line must close fd 9.
    const offenders: string[] = [];
    SRC.split('\n').forEach((line, i) => {
      // Arithmetic `$(( a & b ))` is a bitwise and, not a job.
      const code = line.replace(/#.*$/, '').replace(/\$\(\([^)]*\)\)/g, '');
      for (let j = 0; j < code.length; j++) {
        if (code[j] !== '&') continue;
        const before = code[j - 1] ?? '';
        const after = code[j + 1] ?? '';
        if (after === '&' || before === '&' || before === '>' || before === '<' || after === '>') continue;
        if (!code.includes('9>&-')) offenders.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
        break;
      }
    });
    expect(offenders).toEqual([]);
  });

  it('the three known background jobs are all still covered', () => {
    // A zero-match regex above would pass vacuously. These are the jobs that
    // existed when the defect was found; if one is renamed away, this goes red
    // and someone has to look rather than inherit a silent green.
    const closes = SRC.match(/9>&-/g) ?? [];
    expect(closes.length).toBeGreaterThanOrEqual(3);
    expect(SRC).toContain('monitor_apps 9>&-');
  });
});
