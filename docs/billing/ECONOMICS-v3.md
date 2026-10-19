# Billing v3 economics: Free, Standard and Premium

Generated with exact BigInt rationals from [calculator.mjs](economics/calculator.mjs) and [rates.json](economics/rates.json). USD per month; costs and contributions are rounded only for display.

Regenerate: `node docs/billing/economics/calculator.mjs --markdown-v3 > docs/billing/ECONOMICS-v3.md`.
Validate: `node --test docs/billing/economics/calculator.test.mjs`.

## Assumptions

- [Pinned billing contract](CONTRACT-v3.md): Free $0, 5 h (legacy 8 h); Standard $20, 40 h on m6i.large, 30 GB gp3 workspace; Premium $40, 80 h on m6i.xlarge, 60 GB gp3. Workspaces are retained for the full month.
- Full fair use means every paid and Free user reaches their allowance. Typical use applies 7 h per user, capped by their allowance: paid 7 h, new Free 5 h, legacy Free 7 h. [Measured usage](USAGE-2026-10.md) reports p90 7.05 h, rounded to 7 h in this requested scenario. This is a small-sample percentile proxy, not a forecast or the mean.
- Cloudflare standard-3 costs $0.104832/h at the existing 20% CPU assumption. Each paid user supports 5 Free users, each retaining 2 GB R2 at $0.015/GB-month; the $5/month Workers base is shared by N paid subscribers. These storage/base assumptions carry over from v2.
- Each AWS host has a disposable 30 GB gp3 boot disk (the infrastructure default), prorated over 730 h to active or spare hours. Public IPv4 costs $0.005/h for both active and idle hosts. Paid compute, active boot disks and IPv4 are charged for actual running hours.
- The [pinned pool contract](../aws-computers/POOL-CONTRACT.md) specifies POOL_POLICY: Mumbai m6i.large min 1/max 4, m6i.xlarge min 0/max 2; US East min 0. The base model has one Mumbai Standard spare for 730 h and zero Premium spare hours. N = 25, 100 or 500 is the total number of paid subscribers sharing one regional pool, across both paid plans; the pool is allocated once per subscriber.
- Premium spares and Standard capacity above the minimum are on demand. Their idle hours are not measured; base results assume zero additional idle hours. `premiumSpareHours` and `extraStandardSpareHours` add aggregate idle host-hours, including boot disks and IPv4, before division by N. Adopted runtime is already in paid compute. Provisioning and retirement tails require measured extra hours.
- Card processing is 2.9% + $0.30 per monthly invoice; Billing adds 0.7%; Managed Payments (MP, merchant of record) adds 3.5%. Total fees are 3.6% + $0.30 without MP, or 7.1% + $0.30 with MP. These are assigned assumptions, not live account quotes.
- Operations reserve: $2 per paid subscriber. No credits, discounts, AI allowance, salaries, backup/replication or exceptional network costs are included. Contribution is not profit; the reserve is not a cost ceiling.
- Tax collected is not revenue. Prices and fee calculations use the pre-tax subscription subtotal; additional processing fees on collected tax, refunds, disputes, FX and international-card surcharges are not estimated.
- Rates are the checked-in snapshots, not refreshed from AWS, Stripe or Cloudflare. POOL_POLICY is specified by the pinned contract but absent from ready-pool.ts in this checkout; this model snapshots that contract pending implementation.

| Region | m6i.large / h | m6i.xlarge / h | gp3 / GB-month | Fixed pool / month | Workers base / month |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mumbai | 0.101 | 0.202 | 0.0912 | 80.1160 | 5.00 |
| US East | 0.096 | 0.192 | 0.08 | 0.0000 | 5.00 |

## Free cost and subsidy

| Free cohort | Full hours | Full direct cost / user | Typical hours | Typical direct cost / user |
| --- | ---: | ---: | ---: | ---: |
| New | 5 | 0.554160 | 5 | 0.554160 |
| Legacy | 8 | 0.868656 | 7 | 0.763824 |

Direct Free costs include compute and R2; Free has no revenue. Multiply by 5 for the subsidy per paid subscriber. Tables below use new Free users. If all five are legacy, subtract **$1.57248** from each full-use contribution or **$1.04832** from each typical-use contribution, in either region and fee mode. For a mixed cohort, multiply that reduction by the legacy fraction.

## Mumbai: contribution per paid subscriber

| Plan | N | Full, without MP | Full, with MP | Typical, without MP | Typical, with MP |
| --- | ---: | ---: | ---: | ---: | ---: |
| Standard | 25 | 3.6786 | 2.9786 | 7.3003 | 6.6003 |
| Standard | 100 | 6.2321 | 5.5321 | 9.8538 | 9.1538 |
| Standard | 500 | 6.9131 | 6.2131 | 10.5347 | 9.8347 |
| Premium | 25 | 7.7527 | 6.3527 | 23.1373 | 21.7373 |
| Premium | 100 | 10.3062 | 8.9062 | 25.6908 | 24.2908 |
| Premium | 500 | 10.9871 | 9.5871 | 26.3717 | 24.9717 |

## US East: contribution per paid subscriber

| Plan | N | Full, without MP | Full, with MP | Typical, without MP | Typical, with MP |
| --- | ---: | ---: | ---: | ---: | ---: |
| Standard | 25 | 7.4377 | 6.7377 | 10.8792 | 10.1792 |
| Standard | 100 | 7.5877 | 6.8877 | 11.0292 | 10.3292 |
| Standard | 500 | 7.6277 | 6.9277 | 11.0692 | 10.3692 |
| Premium | 25 | 12.4662 | 11.0662 | 27.0872 | 25.6872 |
| Premium | 100 | 12.6162 | 11.2162 | 27.2372 | 25.8372 |
| Premium | 500 | 12.6562 | 11.2562 | 27.2772 | 25.8772 |

## Hand-check: Mumbai, N = 100, full fair use, with MP

| Monthly line per subscriber | Standard | Premium |
| --- | ---: | ---: |
| Revenue before tax | 20.000000 | 40.000000 |
| Fees (card + Billing + MP) | 1.720000 | 3.140000 |
| Paid compute | 4.040000 | 16.160000 |
| Workspace gp3 | 2.736000 | 5.472000 |
| Active boot gp3 | 0.149918 | 0.299836 |
| Active IPv4 | 0.200000 | 0.400000 |
| Shared warm compute | 0.737300 | 0.737300 |
| Shared warm boot gp3 | 0.027360 | 0.027360 |
| Shared warm IPv4 | 0.036500 | 0.036500 |
| Shared Workers base | 0.050000 | 0.050000 |
| Five Free users: compute | 2.620800 | 2.620800 |
| Five Free users: R2 | 0.150000 | 0.150000 |
| Operations reserve | 2.000000 | 2.000000 |
| Total cost | 14.467878 | 31.093796 |
| Contribution | **5.532122** | **8.906204** |

Hand-check equations: Mumbai fixed pool = 730 × (0.101 + 0.005) + 30 × 0.0912 = $80.116/month. New Free compute subsidy = 5 × 5 × 0.104832 = $2.6208. Standard fees = 20 × 0.071 + 0.30 = $1.72; Premium fees = 40 × 0.071 + 0.30 = $3.14. Standard active boot disk = 30 × 0.0912 × 40 / 730; Premium doubles those hours. Sum the exact lines before rounding.

## On-demand spares and US East comparison

The US East table follows its zero-minimum policy. For an equal warm-service comparison, add one US East m6i.large spare for 730 h: $76.130/month including boot disk and IPv4. Subtract the following from every US East contribution (both plans, both usage scenarios, both fee modes):

| N | One US East spare: contribution reduction |
| ---: | ---: |
| 25 | 3.045200 |
| 100 | 0.761300 |
| 500 | 0.152260 |

Each additional **idle host-hour** adds the following total pool cost, divided by N paid subscribers. This includes prorated boot gp3 and IPv4; no workspace disk is attached to an idle spare.

| Region | Standard spare / h | Premium spare / h |
| --- | ---: | ---: |
| Mumbai | 0.10974795 | 0.21074795 |
| US East | 0.10428767 | 0.20028767 |

As an upper idle-capacity sensitivity, holding Mumbai at its policy maxima (4 Standard + 2 Premium spares, all 730 h) adds $548.040/month. At N=100, full use with MP contributes $0.0517 Standard / $3.4258 Premium. This is a stress case, not measured demand.

## What this means

- At N=100 in Mumbai, full fair use with MP contributes **$5.5321 Standard / $8.9062 Premium**, passing the exact **contribution ≥ $1** rule for both plans. With five legacy Free users, those become $3.9596 / $7.3337.
- The requested 7 h scenario gives **$9.1538 / $24.2908** with MP at N=100 in Mumbai. Validate this against paid usage after launch; 7 h is not an allowance or a guaranteed average.
- MP reduces contribution by $0.70 on Standard and $1.40 on Premium. The pool costs more per subscriber at small N; on-demand idle hours and the legacy Free mix can consume the remaining margin. The no-loss check covers the stated base assumptions, not unbounded spare demand or excluded costs.
- US East has lower compute/storage rates and no fixed spare under the pinned policy. Use the one-spare adjustment for a comparable warm-service budget. Reconcile pool implementation and measured idle hours before treating these estimates as an operating budget.

