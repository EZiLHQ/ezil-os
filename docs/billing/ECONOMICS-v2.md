# Billing v2 economics: contribution and sensitivities

This file is generated from `docs/billing/economics/calculator.mjs` (exact rational arithmetic) and `rates.json`, which records where every rate came from.
- Regenerate the tables with `node docs/billing/economics/calculator.mjs --markdown`.
- The coordinator's published figures are pinned in `calculator.test.mjs` (`node --test`).

These are **contribution estimates, not profit**. They exclude salaries, tax (tax collected is never revenue), backup and replication, exceptional network, and any AI cost unless the AI column says otherwise. The operations reserve is an assumption, not a guaranteed ceiling.

## Model (defaults in `DEFAULT_MODEL`)
- Each paid subscriber uses their whole allowance: Standard 60 h at 2 vCPU; Compute 125 h at 8 vCPU (= 500 standard-hours).
- Storage: a 60 GB gp3 workspace volume per paid user, plus a 30 GB boot disk pro-rated to runtime hours.
- Warm pool: 100 subscribers share 2 warm spares (2 vCPU of the same instance family) running 730 h, each with a 30 GB boot disk and a public IPv4. Public IPv4 is $0.005/h for active and warm hosts.
- Cloudflare: Workers Paid base of $5/month shared. Each paid user carries 5 Free users at 2 h each on Cloudflare standard-3 at 20% CPU ($0.104832/h), plus 2 GB of R2 at $0.015/GB-month.
- Payment and Billing fee placeholder: 5.1% + $0.30 per invoice.
- Operations and network reserve: $3 per paid user.
- No credits, Spot instances or Savings Plans are assumed.
- T4g "full CPU" includes surplus credits at $0.04/vCPU-h, which comes to $0.1008/h in Mumbai. A restart does not remove credit cost.

## Results (USD per paid subscriber per month)
| Plan | Scenario | Revenue | Cost | Contribution | with $3 AI gate | with legacy 8 h Free |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| standard | T4g Mumbai (baseline CPU) | 20.00 | 15.0350 | **4.9650** | 1.9650 | 1.8200 |
| standard | T4g Mumbai (full CPU, surplus credits) | 20.00 | 18.3950 | **1.6050** | -1.3950 | -1.5400 |
| standard | M7g Mumbai | 20.00 | 16.0421 | **3.9579** | 0.9579 | 0.8129 |
| standard | M7g US East | 20.00 | 17.0739 | **2.9261** | -0.0739 | -0.2189 |
| standard | M6i Mumbai (current x86) | 20.00 | 19.2275 | **0.7725** | -2.2275 | -2.3725 |
| standard | M6i US East (current x86) | 20.00 | 18.1482 | **1.8518** | -1.1482 | -1.2931 |
| compute | M7g Mumbai 8 vCPU | 100.00 | 46.3552 | **53.6448** | 50.6448 | 50.4998 |
| compute | M7g US East 8 vCPU | 100.00 | 57.5966 | **42.4034** | 39.4034 | 39.2584 |
| compute | M6i Mumbai 8 vCPU (current x86) | 100.00 | 68.3161 | **31.6839** | 28.6839 | 28.5389 |
| compute | M6i US East 8 vCPU (current x86) | 100.00 | 65.0069 | **34.9931** | 31.9931 | 31.8482 |

| Idle warm pool (2 spares, 0 users) | Monthly |
| --- | ---: |
| T4g Mumbai | 83.180 |
| M7g Mumbai | 102.890 |
| M6i Mumbai | 165.232 |
| M6i US East | 157.260 |

| Overage: compute cost per extra standard-hour (8 vCPU ÷ 4) | Cost | Retail | Gross margin before fees/network/storage |
| --- | ---: | ---: | ---: |
| M7g Mumbai | 0.058325 | 0.25 | 0.191675 |
| M7g US East | 0.081600 | 0.25 | 0.168400 |
| M6i Mumbai | 0.101000 | 0.25 | 0.149000 |
| M6i US East | 0.096000 | 0.25 | 0.154000 |

## What the numbers say
- **Standard ($20) is thin on every path and fails on today's x86 path.**
  - On the shipped x86 type (M6i Mumbai) a fully used Standard plan contributes **$0.77**.
  - It goes **negative** when the existing $3 AI gate is turned on or when Free users keep their legacy 8 h.
  - M7g (ARM) makes it about $3.96, but ARM is **not** selectable until the arm64 image, host, supervisor, editor and browser suite passes.
  - T4g's $4.97 holds only at baseline CPU. Sustained load drops it to $1.61.
  - **Do not bundle more AI into Standard.** Launch Standard only with a decided compute family, or accept a thin or negative margin at full use. (Full use is the worst case; typical use is lower and unmeasured.)
- **Compute ($100) has room:** $31.68–$53.64 at full use, depending on family and region. Each extra standard-hour costs $0.058–$0.101 to run against $0.25 retail. Overage fees (5.1% + $0.30 per overage invoice) and network/storage still come out of that difference.
- **The warm pool is fixed overhead.** Two idle spares cost $83–$165 a month before any user. At low subscriber counts the per-user share is much larger than the 100-subscriber model shows. A US warm reserve and cross-region replication are additional line items, not modelled here.
- **Legacy 8 h Free** costs about $3.145 more per paid user than the 2 h model (5 users × 6 h × $0.104832).

## Guardrails this implies (built into contract v2)
- One active computer per subscription; global vCPU admission; a bounded warm reserve.
- Prepaid subscription plus bounded postpaid exposure: overage is opt-in, with a default cap of $25 and a platform ceiling of $100.
- Orphaned or stopped resources are capped and reconciled.
- Per-user cost metrics.
- The existing $250 / 600-instance-hour AWS pilot ceiling is a **ceiling to re-verify** against live budgets, never fresh allowance. This task's real-AWS tests are capped at $10 of additional spend, with verified cleanup.
