# Free starting AI credits

New Free starter receipts contain **10 AI credits** (1 credit = USD 0.10, so USD 1), one time per account, advertised through the existing catalog/summary offer (`CATALOG_V3.free_v3.aiCredits`). The amount changes; the grant identity and protocol do not:

- Entitlement: `ezil-os:v1:free-once:<userId>`
- Event: `ezil-os:v1:free-once:<userId>:grant`
- Policy version: `1`; the one-year expiry from the first receipt is unchanged.

This applies when an account's first Free starter receipt is created after this version is deployed, including an existing account that has never had one. It is not a wallet migration or a deduction. A receipt that already exists (pending or delivered, 100 credits) keeps its amount, outbox payload, event identity, expiry and replay behaviour: the enqueue is insert-if-absent on the unchanged event key, and delivery sends the stored payload, never the current default.

Balances, fractional settlement, purchased credits, already-issued credits, the Standard 200 / Premium 1000 period grants and the Standard trial grant are unchanged. Existing accounts can still show 100 or a larger actual balance. The legacy `FREE_PLAN.aiTrialMicro` meter is a separate, older figure and is not changed here.

Regression coverage: `ai-balance.test.ts` (new 10 receipt, existing 100 receipt not overwritten and no second identity under concurrent summaries), `ai-enrollment.test.ts` and `ai-enrollment-driver.test.ts` (new sign-in receipt payload and the bound jsonb serializer), `v3/catalog.test.ts` and `ai-summary.test.ts` (offer), and the unchanged pending-100 receipt cases in `v3/summary.test.ts`, `api/routers/billing.test.ts` and `billing/processor.test.ts`.

No database migration, backfill, live Gateway funding action, manual grant, wallet deduction, secret or provider mutation is part of this change. Storage enforcement and model-tier policy are separate changes.
