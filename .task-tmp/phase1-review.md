# O-API Phase 1 review

Implemented in the task RAM worktree; no commit, push, deployment, installs, live Stripe/DB records, agents, or external reporting.

## Change

Canonical exact microcredit strings and safe fractional numeric credits, independent partial balance/usage/limits availability, global and member pause projection, allowlisted recent requests, and validated effective policy/counters/ceilings. Existing Supabase authentication selects the current user; no identity-token bridge or privileged funding credential fallback. New protected billing.aiUsage({limit:1..50,before?}) and billing.aiLimits() queries are read-only. The summary preserves the existing free enqueue helper byte-for-byte. New view types are local; frozen contract, compute, role, pool, gate, processor, outbox, store, ports, config and deps files are unchanged.

OS Billing renders exact balances, holds, commitments, limits, recent requests, pause causes and unknowns. Canceled/stale view loads cannot overwrite a newer view. Server request cancellation propagates through the tRPC resolver signal to all Gateway reads. Settled rows have no active hold; charged credits exclude uncollected costs. The recent request page is not a billing-period total.

## Files

- `app/src/server/api/routers/billing.ts`
- `app/src/server/billing/ai-balance.test.ts`
- `app/src/server/billing/ai-balance.ts`
- `app/src/server/billing/ai-limits.test.ts`
- `app/src/server/billing/ai-limits.ts`
- `app/src/server/billing/ai-read.ts`
- `app/src/server/billing/ai-summary.test.ts`
- `app/src/server/billing/ai-usage.test.ts`
- `app/src/server/billing/ai-usage.ts`
- `shell/ezil/ui/Settings/billing-format.js`
- `shell/ezil/ui/Settings/billing-test.mjs`
- `shell/ezil/ui/Settings/billing-v3-fixtures.mjs`
- `shell/ezil/ui/Settings/tabs/billing.js`

13 product files; 633 insertions, 61 deletions. The companion UI files are in Settings/, beside tabs/ in the actual checkout.

Complete patch (including new files): `o-api-phase1.patch`.

## Final verification

- Sanctioned app runner: typecheck passed; lint 0 errors / 18 warnings; 208 test files passed, 13 skipped; 6,991 tests passed, 384 skipped, 0 failures.
- Owned AI suites: balance 68, summary/C6 17, usage 6, limits 4 — all 95 passed.
- Sanctioned shell runner: one selected Billing suite passed, no selected suite skipped; 22 groups, 206 whole-pane copy/accessibility audits, 0 window errors.
- `git diff --check` passed. Ownership audit passed. Free enqueue helper is byte-for-byte unchanged.

App runner ignores filters and ran the full app package. A RAM-only npx launcher uses the installed TypeScript/Vitest executables, disables incremental TypeScript output and Vitest caching, and cannot download packages. It does not filter or skip tests. Dependency symlinks were read only; shell's existing dependency directory was linked into this task worktree. The shell suite bundles edited source in memory and uses copied icons under .task-tmp/os-assets. `--no-check` deliberately omits the tracked bundle drift gate because generated app/public/os assets are outside this lane. No browser suite or live integration was run.

Commands from this worktree:

```bash
env -u BILLING_TEST_DATABASE_URL -u EZIL_PG_TEST_URL -u STRIPE_E2E_SECRET -u STRIPE_E2E_WEBHOOK_SECRET STRIPE_E2E=0 PATH="$PWD/.task-tmp/bin:$PATH" npm_config_offline=true npm_config_yes=false npm_config_cache="$PWD/.task-tmp/npm-cache" TMPDIR="$PWD/.task-tmp" XDG_CACHE_HOME="$PWD/.task-tmp" VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 bash tools/test.sh app

env TMPDIR="$PWD/.task-tmp" EZIL_SHELL_OUT_DIR="$PWD/.task-tmp/os-assets" bash tools/test.sh shell --no-check --only billing-test

git diff --check
```

Skipped app suites (not passes):

```text
 ↓ src/server/lib/compute/ready-pool.pg.test.ts (153 tests | 153 skipped)
 ↓ src/server/billing/v2/sandbox.e2e.test.ts (12 tests | 12 skipped)
 ↓ src/server/billing/processor-v2.pg.test.ts (16 tests | 16 skipped)
 ↓ src/server/lib/compute/rebase.pg.test.ts (15 tests | 15 skipped)
 ↓ src/server/billing/store.test.ts (11 tests | 11 skipped)
 ↓ src/server/billing/v2/qa/overage.pg.qa.test.ts (34 tests | 34 skipped)
 ↓ src/server/billing/v2/qa/grants.pg.qa.test.ts (42 tests | 42 skipped)
 ↓ src/server/lib/compute/placement.pg.test.ts (12 tests | 12 skipped)
 ↓ src/server/billing/v2/qa/findings.pg.qa.test.ts (8 tests | 8 skipped)
 ↓ src/server/billing/ai-credit-outbox.pg.test.ts (9 tests | 9 skipped)
 ↓ src/server/billing/stripe-live.e2e.test.ts (5 tests | 5 skipped)
 ↓ src/server/billing/v2/qa/epochs.pg.qa.test.ts (8 tests | 8 skipped)
 ↓ src/server/lib/compute/provider-migrate.pg.test.ts (5 tests | 5 skipped)
```

## Remaining integration

Lead must regenerate/check the tracked shell bundle before deployment and freeze the additive local AI view types in shared contract documentation. REST entitlement/team routes remain absent; Universe needs the later proper delegation/access-token contract, not Auth0 ID-token forwarding. Team 25 commercial policy and benefits remain unimplemented. VS Code is outside this lane. No live Gateway or production integration was claimed by these mocked/unit/DOM checks.
