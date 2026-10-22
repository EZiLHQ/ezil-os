# Legacy preparation golden

`preparation-input.json` is the sanitized 2026-10-22 Mumbai 1.0.2 → 1.0.5
Step Functions input. Its envelope/document key order, nested structure, nulls,
workflow/template version numbers, counters, sizes and timestamps are preserved.
Account, resource and UUID identities use the existing `aws-intent.fixtures.json`
values; namespace `mum` becomes `pilot`. The source AMI uses the existing
`ami-22222222222222222` fixture value. Image digests use the existing `a…a` / `b…b`
fixture identities; the envelope SHA-256 is recomputed over the exact sanitized
document bytes. No live evidence or credentials belong in this directory.

Both `test/rebase-legacy.test.ts` and the app's `aws-rebase-legacy.test.ts` consume
this file. The app test also checks the infra consumer, because the app already
accepted legacy sources at the base revision: checking only app serialization
would not expose the original regression. Install both projects' dependencies
for this contract test. Production app code does not import infra.

`python3 test/rebase-legacy-audit.py` (from `infra/app-computers`) runs all nine
new infra tests and the new app test against base `2a69813e`, then mutation checks
the guards in temporary source copies. `--artifacts-only` instead compares the
four affected Lambda bundles with base. Neither mode changes the worktree or git.

Provider doubles verify graph/observer behavior, not live IAM or the legacy host
agent. See the root `REPORT.md` for the remaining app, IAM and compatibility gates.
