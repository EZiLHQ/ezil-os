# Billing contract v3: Free, Standard, Premium (pinned 2026-10-19, prices and Premium machine choice per founder 2026-10-20)

Source of truth: `app/src/server/billing/v3/contract.ts`. v2 (Standard/Compute, overage, standard-hour meters) stays in the code, dormant. Subscriptions already sold on v2 keep their v2 terms; new checkouts sell v3 only.

| | Free | Standard | Premium |
| --- | --- | --- | --- |
| Price (before tax) | $0 | $20/month | $100/month |
| Computer | 2 vCPU · 6 GB (Cloudflare) | 2 vCPU · 8 GB (AWS Mumbai) | choose 2, 4 or 8 vCPU · 8, 16 or 32 GB (AWS Mumbai) |
| Sessions up to | 1 hour | 2 hours | 6 hours |
| Fair use (FAQ only) | about 5 standard-hours/month (older accounts keep 8 h) | about 40 standard-hours/month | about 500 standard-hours/month |
| Launch | on open | at payment | at payment |

- **Standard-hours.** One standard-hour is one hour on 2 vCPU. Premium's bigger computers use time faster: 4 vCPU uses 2 per hour, 8 vCPU uses 4 per hour. So 500 standard-hours is 500, 250 or 125 hours at 2, 4 or 8 vCPU.
- **What users see.** The plan, its session length, its computer, and one fair-use status: *Within fair use*, *Nearly at fair use* (from 80%), or *Paused until <date>* (at 100%). There are no hour meters.
- **Why these numbers.** Over 30 days of real usage, session minutes were p50 14, p90 77, p95 139 and p99 390. So a 1 h cap covers about 87% of sessions, 2 h about 93% and 6 h about 99%. Monthly hours were p90 7 h per computer. The fair-use limits sit well above typical use and only stop outliers. Evidence: `docs/billing/USAGE-2026-10.md`.
- **Sessions.** At the session limit the computer saves its files, then stops. A new session starts from the same files. Running processes do not survive a stop.
- **No overage.** A user who reaches fair use can upgrade, or wait until the window resets.
- **Upgrades.** Standard to Premium is charged as a prorated payment and takes effect only once that payment succeeds. Downgrades and cancellations take effect at period end.
- **Tax.** Prices are before tax. EZiL LLC can sell through Stripe Managed Payments (merchant of record) once the founder accepts its terms; the checkout is tested in sandbox.
- **Opening copy.** No plan promises how fast it opens until the ready pool is wired and the per-tier startup report shows a measured warm p50 under 10 s. The word "instant" is never used.
- **Machine choice.** x86 machines (m6i) first. ARM (Graviton) appears only after the image, host and full desktop suite pass on a real Mumbai ARM host.
- **Launch at payment.** A paid plan's AWS computer is prepared as soon as the signed `invoice.paid` webhook arrives, never from a checkout redirect.
