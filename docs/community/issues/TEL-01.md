---
id: TEL-01
title: The telemetry drain outage has no drill
labels: [worker, docs, "size/M"]
prereq:
state: open
---

## The problem

`docs/RUNBOOK.md` § "OPEN OUTAGE: the R2 telemetry spool has never once been drained" records
a real, weeks-long incident: `app/vercel.json` declared three crons where the plan permits
two, so `telemetry-drain` silently stopped firing after 2026-08-09 while the R2 spool
(`ezil-telemetry-spool`) kept accumulating — 173 objects / 467 kB by the time it was found. The
fix folded the drain into the cron that is proven to fire
(`app/src/server/telemetry/maintenance-handler.ts`) and separated `drainFailures`
(`app/src/server/telemetry/spool-drain.ts:114`) from "the spool was simply empty" — but nothing
runs periodically to prove the drain still works. A second silent cron misconfiguration, or any
other cause of a stalled drain, would look identical to a quiet day until someone happens to
read the RUNBOOK again. There is no drill.

## Acceptance criteria

- A recurring, automated check (not a person remembering to look) asserts the telemetry drain
  actually ran recently and moved objects when the spool was non-empty — using the existing
  `SpoolDrainResult.drainFailures` signal (`app/src/server/telemetry/spool-drain.ts:114`),
  which the incident's own postmortem identifies as "always a fault, never a normal state"
  when non-zero.
- The check distinguishes "the spool was empty" from "the drain could not run" — the exact
  ambiguity that hid the original incident for ~16 days.
- A synthetic test (or a scheduled job) can deliberately break the drain's invocation path
  (e.g. simulate the cron not firing) and prove the check catches it — mutation-proved, not
  just code-reviewed.
- `docs/RUNBOOK.md`'s "OPEN OUTAGE" section is updated to reference the new drill once it
  exists, so a future reader is pointed at an automated check instead of a narrative account.

## Where to look

- `docs/RUNBOOK.md` § "OPEN OUTAGE: the R2 telemetry spool has never once been drained" — the
  full incident account, including the exact root cause (three declared crons, two permitted)
  and the fix already committed.
- `app/src/server/telemetry/spool-drain.ts:77` (`DEFAULT_DRAIN_BUDGET_MS`), `:114`
  (`drainFailures` on `SpoolDrainResult`), `:140` (`runTelemetrySpoolDrain`) — the drain engine
  and its fault signal.
- `app/src/server/telemetry/maintenance-handler.ts:72` (`handleTelemetryMaintenance`) — where
  the drain now runs, tail of the cron proven to fire; no alerting exists here today.
- `docs/telemetry.md` — "The R2 spool has never been drained," corroborating the same incident
  from the data side (84 live rows, all `source='shell'`, zero `worker`/`container` rows before
  the fix).

## How to prove it

Simulate a stalled drain (e.g. force `drainFailures` to increment, or point the maintenance
handler at an unreachable Worker) and show the new drill surfaces it — then restore and show it
goes quiet. State both runs' output in the PR.

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../CONTRIBUTING.md#how-to-send-a-pull-request).
