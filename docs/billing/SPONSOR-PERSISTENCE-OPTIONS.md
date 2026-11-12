# Sponsor attribution: persistence options (for root's decision; nothing applied)

Sponsor is an alternative entry to the SAME one-month Standard trial: the existing `claimTrialQuote` ledger, checkout, webhook and eligibility stay the only
authority. Free100 starter credits are Gateway grants, not billing paid grants, so they never make a person `paid_before` or `trial_used`. An existing eligible
Free user may claim; only an account the server creates through the sponsor path gets `signed_up_at`, so they are not counted as new signups.

## Can existing server-owned JSON carry it without DDL? Inspected at 32d26a25
| Store | Verdict |
|---|---|
| `auth.users.raw_app_meta_data` (Admin API only, not user-editable) | Usable for a creation hint and a readable signup marker. Cannot freeze a campaign per quote, cannot dedupe, and a deleted account loses its count. Never financial authority. |
| Stripe subscription/session metadata (server-written) | Durable for STARTED trials and the webhook can verify it against the row. Cannot record a quote that never reached Stripe or a signup. |
| `ezil_billing_trials` | No JSON column: no place for campaign or config hash. |
| `ezil_billing_outbox.payload`, `ezil_billing_events`, computers `metadata`, telemetry `attrs`, feedback `diagnostics` | Wrong purpose (credit delivery, webhook receipts, machine, telemetry, feedback). Not used. |
| Registry / signed campaign config | Config only (is the campaign real and current); holds no per-person state. |

## Result
A no-DDL variant is feasible only in degraded form: signup from `app_metadata` (lost on deletion), started-trial counts from Stripe metadata, and NO
per-quote freeze or race-proof one-campaign-per-person rule. It cannot give the durable, deduplicated, deletion-surviving counts requested. The proposal
therefore stays the two service-only tables in `app/migrations/sponsor/0001_sponsor_attribution.sql` (attribution per pseudonymous account; trial linkage
per trial), tested on a disposable bounded Postgres 17 fixture.

## Journal dependency (flagged, not bypassed)
The journal in H ends at 0021; pending MCP 0022-0025 are unapplied. A new ordered migration placed ahead of them could make Drizzle skip older entries
later. The sponsor SQL is therefore outside `drizzle/` and the journal, with its own read-only preflight and a future exact-file runner. It must not be
renumbered into the journal until root decides the 0022-0025 order.
