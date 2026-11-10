# OS operator reader parity — 4 November 2026

Author implementation for RF1–RF7, based on `ac63da1c49b164eac736ded6c0e290c3368a957e`. Independent review and release approval remain separate. No staging license, provider call, hosted database write, key activation or deployment was performed.

## Source semantics refinement (58d78935 / 93ed)

AMEND: the v1 formats, fields, product refs, signed-request bytes and refusal vocabulary stay unchanged.

- Assign is immediate. An explicit start within the existing ±300-second tolerance accepts sender clock skew and is stored/returned as the server's current time. Other starts are refused. Applied-command replay returns its original stored result.
- `ends_at` is a validity limit; `ended_at` records terminal closure. A non-null stored closure never grants access again. Replacing a naturally lapsed assignment closes it at its own end only when that end has actually passed. An unstarted live row is refused rather than closed at a future validity end.
- Select the current recognized Stripe subscription before considering delinquent rows; retain the existing end/start/subscription-ID tie break. Its paid, plan-ending or live grace standing owns precedence and the paid-subscription conflict. A missing/reversed receipt cannot bypass that conflict with an operator assignment.
- `effective_access.active` additionally requires the compute funding used by the entitlement reader. An unfunded current Stripe period, a refunded-to-zero period, or a renewal still awaiting its receipt reports `none`; the separate Stripe status/product facts remain visible. Grace without a receipt uses the existing grace funding rule; any actual period receipt/reversal wins.
- SQL pool eligibility and migration discovery use the same source-selection, standing, grace cutoff, period-isolated funding and machine mapping. Existing funded trialing facts are evaluated like the TypeScript resolver; this does not create or offer a trial.
- Removing or rotating command sender keys changes transport authorization only. Stored licenses remain effective until their own validity/closure says otherwise. Missing keys still return 503 before source reads; unknown signatures still return 401.
- Operator Premium machine selection resolves product access. Stripe mutation helpers continue to resolve Stripe subscriptions only. Operator-effective access hides/refuses Stripe subscription management, including the portal when a historical customer remains; invoice history is retained.

The command still writes only the operator assignment and its audit/idempotency event. It creates no Stripe subscription, payment, invoice, compute receipt or AI grant. Standard/Premium keep the existing unmetered paid policy and six-hour session limit; Free policy is unchanged. Migration discovery merely returns eligible candidates; the existing reconciler/admission path controls any later provision.

## Focused evidence

The new offline PostgreSQL suite `app/src/server/entitlements/operator/operator-reader-parity.pglite.test.ts` enters through the real signed HTTP handler, then the production transaction/store, released 0019 migration, source view, compute state, entitlement reader, admission, pool SQL and migration SQL. Synthetic identities and subscription/receipt facts are confined to an in-memory PGlite database. PGlite has one connection, so injected dependency reads join that same local transaction; this suite does not establish concurrent PostgreSQL advisory-lock behavior.

The two billing-router regressions exercise the real tRPC machine/portal entry points. Tests use the public RFC 8032 fixture key; no deployed credential is loaded.

On exact ac63 production source, the same final new tests fail in all 15 cases. On the correction, the directly affected run has 727 passing tests across 12 suites; 8 server-PostgreSQL-only cases are skipped. That run includes existing signature/identity/idempotency, unmetered paid policy, Free fallback, summary, migration and placement-writer checks. The 7,908-test baseline and mutation campaign were not repeated. Final typecheck succeeds. Changed-file lint has no errors; remaining warnings predate this correction.

To run the focused offline regressions using an already installed PGlite ESM entry:

```sh
EZIL_PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node node_modules/vitest/vitest.mjs run src/server/entitlements/operator/operator-reader-parity.pglite.test.ts src/server/api/routers/billing.test.ts --maxWorkers=1 -t 'RF[1-7]|operator Premium can|operator-effective access'
```

The author run used PGlite 0.5.8, `TMPDIR` under `/data`, one test worker and a Node preload that throws on fetch and net/TLS/HTTP connection attempts. Each worktree has its own dependency-root/cache directory; installed package payloads are read through symlinks without peer-cache writes. No UI source or committed browser bundle changed, so the prior browser bundle evidence remains applicable.

Local evidence logs, network guard and hashes are under `/data/openclaw/tmp/os-operator-parity-20261104`; the final author report supplies the sealed commit and evidence manifest. The original owner worktree remains clean at ac63.

## Rollback

Revert the single parity-correction commit to return to ac63 behavior. No schema/data rollback, provider cleanup or credential change is needed for this local implementation. Reverting restores the reviewed reader inconsistencies, so release remains held until independent review accepts a concrete correction.
