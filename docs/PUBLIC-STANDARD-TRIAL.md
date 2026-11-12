# Public Standard free-month control

The public offer is controlled by metadata on the **existing Stripe Standard Product** associated with the active Price whose lookup key is `ezil_standard_monthly_v3` ($20 USD, recurring every month). In Stripe's Product catalog, select that Product in the intended TEST/LIVE mode and edit:

| Metadata key | Value | New public trial offers |
| --- | --- | --- |
| `ezil_public_standard_trial` | `true` | On |
| `ezil_public_standard_trial` | `false` | Off |

A missing key on a fully verified canonical Product preserves the existing **on** default. Prefer an explicit `true` or `false` for operator clarity. Other strings, a missing metadata object, an inactive/ambiguous/unexpanded/wrong-price catalog, or a Price/Product TEST/LIVE mismatch fail closed. This is Product metadata, not a promotion code or a Price change. Do not create a new Product, coupon, Price, or subscription to flip this switch.

The backend fetches the canonical Price with its expanded Product afresh for **summary, quote and trial checkout**. This control has **no cache (maximum policy cache age: zero)** and bypasses the ordinary ten-minute merchant Price cache. A provider failure never falls back to a previously enabled control: summaries report an unknown offer and quote/checkout report provider unavailability. No unrelated paid checkout, prices, subscription renewals or webhook funding rules change.

After this backend version is deployed, `BILLING_PUBLIC_STANDARD_TRIAL` is a legacy compatibility field and **does not override Stripe**, including an old value of `0`. An older deployed backend still uses its old policy; setting metadata alone cannot change old code. Roll out the new qualified backend before relying on the switch.

## Promoter priority and one lifetime trial

A valid server-stored promoter attribution, backed by the signed campaign registry, takes priority when both offers are on and works when the public switch is off. It does not bypass lifetime eligibility, verified identity, a previous trial/paid subscription, campaign expiry, or the normal Stripe checkout requirements. The summary's existing `trialOffer` gains optional `source: public | sponsor` and a sponsor `partnerId`, including an explicit ineligibility reason for a selected promoter on an existing paid plan.

A stored sponsored quote remains sponsored: turning its campaign off or changing its frozen configuration refuses checkout, rather than silently removing tracking. If a promoter was selected after an earlier public quote, checkout requires a fresh quote so the sponsor linkage and Stripe idempotency parameters agree. No URL or client field writes an entitlement.

Switching public metadata off withdraws unstarted public quotes at their next checkout request. Existing issued Checkout sessions and started trials retain the terms already disclosed; this switch does not cancel them or alter their renewal. A read and a Stripe mutation are not one transaction: an already authorized in-flight request is not retroactively revoked by a later metadata edit.

All trial sessions still require a card and use the stored quote's exact month end, $0 today and $20/month renewal with cancellation available. Existing quote expiry, deterministic per-quote Stripe idempotency, lifetime identity claims, webhook verification and trial-to-subscription binding remain authoritative. No new grants or wallet adjustments are part of this control.

## Validation and deployment scope

Unit tests use fake Stripe responses only: exact true/false/default, malformed/mode/price/catalog refusal, fresh reads after on/off and outages, old-environment independence, quote-to-checkout withdrawal, promoter priority and existing eligibility/idempotency regressions. Source implementation and tests do not mutate Stripe.

This changes Node backend `app/src` code. It needs a newly qualified normal release and the normal reviewed backend compatibility/release path; the old exact `1ef8…`/`6ec9…` UI-only private operator proof is not reusable. No database migration, host runtime, Worker, image-build recipe, paid price or environment-renderer change is required by this control.
