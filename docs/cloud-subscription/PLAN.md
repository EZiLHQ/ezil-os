# EZiL OS cloud subscription — implementation plan v1 (2026-10-08)

Request `os-cloud-subscription-fast-20261008-2003-v1` · Notion 3f37021e-76d7-81a5-adec-e3079da780a5 ·
lead: native Claude session df67cf1f (claude-opus-5-5). Contract: [`CONTRACT.md`](CONTRACT.md) (frozen v1).

## 1. Current state (verified 2026-10-08 ~14:45Z)

| item | value |
|---|---|
| OS `origin/main` | `e652970` (#192). Local checkout is on `fix/stale-preview-editor-state-release` with untracked `landing/`, belonging to another session. Left untouched. |
| Gateway `origin/main` | `c60ac94` (#20/#21). Migrations go up to `0010_project_keys`. `0011` is claimed by the `admission-0011-20261008` worktree, so this work numbers its SQL `0012` and renumbers at merge time. |
| Works `origin/main` | `129073bb`. Its only Cashfree product is the Builder purchase (INR 2000, `builder-purchase-*`). There is no subscription product yet. |
| Computer runtime | **Cloudflare Containers** via Sandbox SDK Durable Objects (`worker/wrangler.toml`). Shape is custom 2 vCPU / 6 GiB / 16 GB. `max_instances` is 20 in prod and 5 in staging. Workspace is persisted as an R2 atomic checkpoint (#179). |
| AWS | Auth VERIFIED: account 452630323510, `root` login session, us-east-1. Holds **CI only**: the `ezil-ci-runner` m7i.xlarge, DynamoDB `ezil-ci-staging`, and WorkScore CodeBuild/CFN. No computer runtime, ASG or S3 bucket. EC2 on-demand standard quota is 64 vCPU. |
| AI money | Gateway `ezil_ai`: integer microcredits, 1 credit = INR 0.10, debit = USD × inr_per_usd × markup. Reserve/settle carries request-id idempotency. HMAC entitlement hook `/v1/integrations/entitlements`. 402 `insufficient_credits` / `no_entitlement` and 429 `rate_limited` already exist. |
| OS chat | OS↔gateway chat lives only on unmerged branches `feature/ai-gateway-os` and `feat/ai-gateway-os-20260930` (22 commits, another session's). Main has no chat surface. |
| Preview data | **No isolated preview DB exists.** Supabase `btgq` "EZiL-preview" is live prod, and gateway staging uses the prod Hyperdrive. All tests in this work run on PGlite or local mocks. No hosted writes. |

## 2. Alternatives and recommendation (faster opening)

| option | fits the current runtime? | expected effect | cost | verdict |
|---|---|---|---|---|
| **A. Bounded ready pool of pre-booted Cloudflare containers, single use, leased atomically** | yes, same DO/container classes | Removes cold container boot (~11 s container `ready` p50 in the 2026-08-19 spool) from the claim path. What remains is claim, R2 hydrate and attach. | each ready slot holds memory and disk (see §4) | **recommended** |
| B. EC2 ASG warm pool (stopped/hibernated) | no: computers are not EC2. It would mean a new control plane, network relay and storage | warm start ~tens of seconds (EC2 resume), plus a new relay path | EBS for stopped instances, plus engineering | alternative for the post-launch `aws-ec2` provider only. Dry-run IaC only. |
| C. Cloudflare container snapshots (20 GB max, 30 d retention) | partially | could cut boot work for a stopped computer | snapshot storage | follow-up investigation. Not in this PR. |
| D. Do nothing; trim fixed poll intervals (~4 s of 1 s ticks, per PERFORMANCE-BASELINE §1.4) | yes | a few seconds on every open | none | complementary, separate PR |

## 3. Latency baseline and targets

- **Historical baseline** (PERFORMANCE-BASELINE.md, live prod 2026-08-19, old 0.5-vCPU shape):
  - cold `desktop_ready` p50 8.9 s, p90 19.0 s, max 28.4 s (n=39)
  - container `ready` p50 10.9 s, p90 13.6 s (n=37)
  - That shape and boot path have since changed (#179/#181), so this is **not** a current baseline.
- **Current baseline:** NOT YET MEASURED. Measuring it means live opens, limited by the per-IP gate (~12 sessions/day) and the agent spend kill-switch. Wave 3 runs a preflighted sample of n ≥ 10 cold, warm and reconnect opens, broken out per stage (request, allocation, boot, browser, relay, VS Code). It will report n beside p50/p95.
- **Target (hypothesis, not a promise):** a pooled claim reaches desktop+IDE ready at p50 ≤ 4 s and p95 ≤ 8 s. Proof needs the pool live in staging, which requires a bounded apply (§7). No "instant" claim ships without before/after samples.

## 4. Unit economics (Cloudflare Containers pricing page, last updated 2026-10-05)

Rates per second: vCPU $0.000020 (billed on **active** CPU), memory $0.0000025/GiB, disk $0.00000007/GB (memory and disk billed while **provisioned**). Workers Paid is $5/mo and includes 375 vCPU-min, 25 GiB-h and 200 GB-h. Egress is $0.025/GB in NA/EU (1 TB included) and $0.04/GB elsewhere.

| shape | floor $/h (0 % CPU) | at 25 % CPU | at 100 % CPU |
|---|---|---|---|
| standard 2/6/16 | 0.058 | 0.094 | 0.202 |
| performance 4/12/20 | 0.113 | 0.185 | 0.401 |

- **Pool slot always ready** (standard): floor 720 h × $0.058 = **~$42/month per slot**, more with idle CPU. A performance slot is about $81/month.
- **Subscriber at USD 20** with the full USD 20 as AI credit (founder requirement, kept): at full redemption AI cost is about $20 (v2 has no markup). These remain **unfunded**:
  - compute, e.g. 60 h/month standard is $5.6 (25 % CPU) to $12.1 (100 %); 60 h performance is $11–24
  - desktop-stream egress, about 0.9 GB/h, roughly $2 per 60 h outside NA/EU
  - Cashfree fees and taxes. Rates not verified here; the founder must supply them.
- **Proposal, needs founder decision.** Nothing here is published:
  1. Standard compute included up to a **bounded monthly hour cap** (config `INCLUDED_COMPUTE_HOURS`, proposal 40 h), recorded as an explicit subsidy line.
  2. The performance shape costs a **separate configurable hourly charge** from the purchased balance, or a separate add-on. No default price is set in code.
  3. Pool target starts at 1 standard slot (`POOL_MAX_TOTAL=2`), costing about $42–60/month, plus refill churn.
- **Legacy policy compatibility.** The older 1000-credit / INR / 1.25-multiplier mapping stays on wallet v1. Moving an account to v2 needs a versioned conversion policy (rate source, rounding, date), which is founder-owned. The code ships v2 off and no conversion.
- **Open commercial decisions:** billing period (monthly is a proposal), included-credit expiry vs rollover, spend order, compute hour cap, performance pricing, refund and cancellation proration, Cashfree subscription vs one-off orders.

## 5. Workstreams, ownership, dependency order

Shared seams (contract) were done by the lead before fan-out. Every worktree branches from the integration branch head after the contract commit.

| id | engine/model | repo · worktree | owned paths | why this engine |
|---|---|---|---|---|
| `osub-pool` | Azure Codex gpt-6-astra-code | OS · `.fastmode/osub-pool` | `app/drizzle/0003_*`, `app/drizzle/meta/*`, `app/src/server/lib/pool/**`, `app/src/server/api/routers/compute*.ts`, `worker/wrangler.toml` (performance class block), `worker/src/pool*.ts` | well-specified backend plus tests |
| `osub-wallet` | Azure Codex gpt-6-astra-code | Gateway · `.fastmode/osub-wallet` | `migrations/0012_*.sql`, `src/funding.ts`, `src/wallet.ts`, additive routes in `src/app.ts`/`src/config.ts`, `test/funding*.test.ts`, `test/wallet*.test.ts` | well-specified SQL/API |
| `osub-chat` | Azure Codex gpt-6-astra-code | OS · `.fastmode/osub-chat` | `shell/ezil/ui/Billing/**`, `shell/ezil/ui/Settings/tabs/computers.js` (shape picker section), `shell/src/i18n/translations/en.js` (append keys) | UI on a pinned contract |
| `osub-qa` | Azure Codex gpt-6-sol | Gateway · `.fastmode/osub-qa` | `test/osub-adversarial/**` only, written from CONTRACT.md alone | independent of the implementers |
| lead | Claude Opus 5.5 | both integration branches | `docs/cloud-subscription/**`, merges, final suite, PR | integration judgment |

Order:
1. Wave 1 runs all four in parallel. Pool and chat touch disjoint paths; wallet and QA are disjoint.
2. Wave 2 is OS pool adversarial QA (a Claude or Codex validator) plus fixes.
3. Wave 3 is the measured baseline and staging dry-run, gated by §7.

## 6. Test and release sequence

1. Workers: suites green in their worktrees, JSON receipts.
2. Lead: review diffs, merge into the integration branches in dependency order (wallet → qa; pool → chat), and run the full gateway and OS suites.
3. Draft PRs: `EZiLHQ/ezil-ai-gateway` `feat/usd-subscription-wallet` and `EZiLHQ/ezil-os` `feat/os-cloud-subscription`. Not merged.
4. Activation, each step needing founder approval:
   1. Decide the §4 commercial terms.
   2. Provision an isolated preview DB.
   3. Apply 0012 there and replay the webhook tests.
   4. Wire a Works subscription product (Cashfree) to `/v1/integrations/funding`.
   5. Staging deploy with `POOL_TARGET_STANDARD=1`, `POOL_MAX_TOTAL=2`, performance `max_instances=2`.
   6. Measure.
   7. Production flag flip.

## 7. Paid infrastructure gate and rollback

- No live pool before: target 1, max 2, budget ≤ $60/month for pool slots, plus a kill path.
- **Rollback:** set `POOL_TARGET_*=0` and `POOL_MAX_TOTAL=0`. The reaper destroys ready slots within one TTL. Set `WALLET_V2_ENABLED=false`; legacy wallet behaviour is unchanged.
- The migrations are additive. Their down path is in the PR.
- AWS: nothing to apply. The EC2 warm-pool alternative stays a document only.
- Root credentials must not be used for any apply.
