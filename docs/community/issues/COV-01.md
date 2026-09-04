---
id: COV-01
title: Coverage reporting — revive the branch
labels: [ci, "good first issue", "size/M"]
prereq:
state: open
---

## The problem

The branch `code-coverage-agent/setup-code-coverage-reporting` already did the small, real
part of this work — three commits adding `@vitest/coverage-v8` to `app/package.json`,
`app/vitest.config.ts` coverage options, and `.github/workflows/github-coverage.yml` — but it
branched off long before `main`'s current shape: it is 3 commits ahead and **339 commits
behind**, and merging it as-is would delete thousands of lines `main` has added since (worker
suites, workspace/telemetry/neko tests that did not exist when the branch was cut). `main`'s
`app/vitest.config.ts` has no coverage configuration today (verified: `test.coverage` is
absent from the file). This issue is to re-derive the small idea — coverage instrumentation
and a CI report — against current `main`, not to merge the stale branch.

## Acceptance criteria

- `app/vitest.config.ts` gains a `coverage` block (provider `v8`, matching the stale branch's
  choice) without reverting any test file `main` has added since the branch was cut.
- A CI workflow (new, or a step added to an existing job) runs coverage and publishes a report
  (artifact upload at minimum; a coverage-comment/badge if straightforward) — the stale
  branch's `.github/workflows/github-coverage.yml` is a starting point, not something to copy
  verbatim, since `ci.yml` has grown a three-OS matrix since the branch was cut.
- No existing test is weakened or skipped to make a coverage number look better — `_MANDATORY`
  §6's rule applies here as much as anywhere: a skipped test is never reported as a pass, and
  neither is a low-coverage file hidden from the report.
- The stale branch itself is closed (or superseded) once this lands, with a note pointing to
  the issue/PR that replaced it.

## Where to look

- `app/vitest.config.ts` — no `coverage` key present today (verified by reading the file in
  full: 14 lines, `test.environment`/`test.include`/`resolve.alias` only).
- The `code-coverage-agent/setup-code-coverage-reporting` branch's own diff against its base
  (`git diff --stat 6e53079 4933b38`): `.github/workflows/github-coverage.yml` (new, 51 lines),
  `.gitignore` (+3), `app/bun.lock` (+99), `app/package.json` (+1 dependency),
  `app/vitest.config.ts` (+5) — the actual size of the idea, once separated from the 339 commits
  of unrelated drift.
- `.github/workflows/ci.yml` — the current `app` job this issue's coverage step should join or
  sit beside.

## How to prove it

```
cd app && bun run test -- --coverage
```
Expected: a coverage report is produced with no test file deleted or skipped relative to
`main`'s current `bun run test` output.

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr).
