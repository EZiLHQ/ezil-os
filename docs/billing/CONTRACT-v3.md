# Billing contract v3: Free, Standard, Premium (pinned 2026-10-19)

Source of truth: `app/src/server/billing/v3/contract.ts`. v2 (Standard/Compute, overage, standard-hour meters) stays in the code, dormant. Subscriptions already sold on v2 keep their v2 terms; new checkouts sell v3 only.

| | Free | Standard | Premium · Most popular |
| --- | --- | --- | --- |
| Price (before tax) | $0 | $20/month | $40/month |
| Computer | 2 vCPU · 6 GB | 2 vCPU · 8 GB | 4 vCPU · 16 GB |
| Sessions up to | 1 hour | 2 hours | 6 hours |
| Opening | standard | from a ready computer | first from a ready computer |
| Fair use (FAQ only) | about 5 h/month (older accounts keep 8 h) | about 40 h/month | about 80 h/month |

- **What users see.** The plan, its session length, its computer and how it opens, and one fair-use status: *Within fair use*, *Nearly at fair use* (from 80%), or *Paused until <date>* (at 100%). There are no hour meters.
- **Why these numbers.** Over 30 days of real usage, session minutes were p50 14, p90 77, p95 139 and p99 390. So a 1 h cap covers about 87% of sessions, 2 h about 93% and 6 h about 99%. Monthly hours were p90 7 h per computer. The fair-use limits sit well above typical use and only stop outliers. Evidence: `docs/billing/USAGE-2026-10.md`.
- **Sessions.** At the session limit the computer saves its files, then stops. A new session starts from the same files. Running processes do not survive a stop.
- **No overage.** A user who reaches fair use can upgrade, or wait until the window resets.
- **Upgrades.** Standard to Premium is charged as a prorated payment and takes effect only once that payment succeeds. Downgrades and cancellations take effect at period end.
- **Tax.** Prices are before tax. EZiL LLC can sell through Stripe Managed Payments (merchant of record) once the founder accepts its terms; the checkout is tested in sandbox.
- **Opening copy.** "Opens from a ready computer" stays in place until the measured warm p50 is under 10 s; only then can it become "fast". The word "instant" is never used.
