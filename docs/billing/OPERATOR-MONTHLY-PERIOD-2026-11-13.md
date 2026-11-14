# Operator plans: one source-defined calendar month (2026-11-13)

Business policy change for operator-assigned EZiL OS plans (`standard_monthly_v3`, `premium_monthly_v3`).
It supersedes the earlier explicit-end-date / until-revoked contract for operator assignment.

## Policy

- The Gateway controls product **access** only. Stripe billing stays separate: an operator command never creates,
  changes or cancels a Stripe subscription. A paid Stripe plan or an open checkout still refuses an operator grant
  that would give more (`paid_subscription_conflict`).
- **Assign** starts at the source server's now and runs one calendar month: `addCalendarMonthUtc` in
  `app/src/server/billing/v3/trial.ts` (same UTC time of day, whole seconds, clamped to the last day of a shorter
  month, e.g. 31 Jan 20:00 → 28 Feb 20:00). The source computes and stores that end.
- **Change** of product keeps the current period end. A change carrying any validity is refused.
- **No auto-renew** and no renew action. Re-assigning after the period ended starts a new month.
- **Remove / expiry** recomputes effective access to a valid Stripe plan, otherwise Free. Files are preserved.
- `until_revoked` is refused. Scheduled or back-dated starts outside the 5 min clock tolerance are refused.

## Frozen v1 wire

The signed `ezil.admin-entitlement-command.v1` body, parser and signature are unchanged. A well-formed
`validity.ends_at` is a **non-authoritative hint**: it is not compared with the source-computed end and never
determines the stored end, so it can neither shorten nor extend access. This is deliberate. A comparison refused
valid commands whose sender start fell either side of midnight before a month-end clamp, and refused a retry of an
unstored command delivered more than 5 min after it was signed.

Stored results are idempotent. Replaying a `command_id` returns its stored result, both an applied result and a refusal
receipt, unchanged, whenever the replay arrives.

## Operator UI

The Gateway console must offer no arbitrary date input and must display the end that the source reads back after the command.

## Evidence

`app/src/server/entitlements/operator/service.test.ts`: forged, past and skewed hints ignored; cross-midnight
clamps (30/31 Jan, 28/29 Jan, 30/31 Mar); an unstored first attempt retried after 6 min; stored replays across a month
boundary; stored refusal replay. Restoring the removed comparison fails 7 of these cases.

No schema, data, cloud or customer change.
