# Free starting AI credits

New normal Free starter receipts now contain **10 AI credits**, advertised through the existing catalog/summary offer. The amount changes; the grant identity and protocol do not:

- Entitlement: `ezil-os:v1:free-once:<userId>`
- Event: `ezil-os:v1:free-once:<userId>:grant`
- Policy version: `1`; normal one-year expiry from the first receipt remains unchanged.

This applies when the account's first normal starter receipt is created after this version is deployed, including an existing account that has never had that receipt. It is not a wallet migration or a deduction. Existing pending or delivered100-credit receipts keep their original amount, expiry and event payload. The summary/desktop/sign-in inserts use `ON CONFLICT DO NOTHING`, and delivery reads the stored receipt, so a retry sends the original100 rather than regenerating10 under an already-used event ID. No new policy/event version is created that could grant again.

Balances, fractional settlement, purchased credits, already-issued credits, Standard200/Premium1000 period grants and the existing Standard trial grant are unchanged. Existing accounts can still show100 or a larger actual balance; the current starter catalog label is not a balance numerator or denominator. Gateway failures still show truthful pending/unknown state, never an assumed10 balance.

Regression coverage exercises new10 creation at summary/open/sign-in and through the installed PostgreSQL serializer, unchanged event identity, repeated/concurrent sign-ins, existing100 enqueue deduplication, stored100 delivery and existing100 balance/grant labels. The server-produced browser fixture retains its historical100-credit accounts while its catalog label reflects10.

No database migration, live Gateway funding action, manual grant, wallet deduction, secret or provider mutation is part of this change. Storage enforcement and model-tier policy are separate changes.
