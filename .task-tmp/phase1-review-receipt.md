# O-credits phase 1: activation-boundary fix review receipt

Base commit: 25c1274b5215. No commits, pushes, deployments, vendor calls, or database calls were made in this turn.

## Patch identity and ownership

- Previous independently reviewed patch SHA-256: `0b0e996870e0721228645f88615ef8f02c222b7050e9ad8e1f53a80ec3489200`.
- Refreshed full patch SHA-256: `907afd5113eecf60cdc907918e06a51cda5975592f58745448a0c1fc73c48697`.
- Full diff: 20 files changed, 533 insertions(+), 56 deletions(-).
- The 18 previously reviewed phase-1 source/test files are byte-for-byte unchanged (SHA-256 comparison).
- New changes are exclusively `app/src/server/billing/stripe/client.ts` and `app/src/server/billing/stripe/client.test.ts`.
- Full patch: `o-credits-phase1.patch`. This turn's delta: `o-credits-activation-fix.patch`.

## Behavior

`createCheckoutSession` checks `aiPackCheckoutEligible(pack)` immediately after resolving the pack, before any Stripe request. Unconfigured packs reject with `TRPCError`, code `PRECONDITION_FAILED`, message `pack_credits_unset`.

Both shipped packs remain `aiCredits: null`. Positive tests explicitly mock a synthetic 1234-credit policy without changing the catalog or asserting a USD conversion. Existing positive pack tests now opt in to that fixture policy.

## Validation

- Stripe-client suite: 146 passed, 0 failed, 0 skipped. This includes eight null-policy cases covering both packs, hosted/embedded checkout, and both merchant modes; every negative case asserts zero Stripe calls.
- Explicitly configured positive cases verify the checkout form and exactly one mocked Stripe request.
- TypeScript: `tsc --noEmit --incremental false --pretty false` passed, no diagnostics.
- `git diff --check` passed.
- Tests used injected fetch mocks, the existing task-local configuration, disabled caches, and unset database connection variables.
- Earlier PostgreSQL result supplied by the coordinator: all 23 previously skipped real-PostgreSQL cases passed, 26 total cases in that independent run. Those files are unchanged. Database tests were not rerun for this source-only activation fix.

## Remaining boundaries

Live pack credit policy remains unconfigured. No guessed conversion or pack activation was added. Phase-2 dispute restoration remains unresolved and awaits the frozen G5 chain contract; no restoration work or history replay was started.
