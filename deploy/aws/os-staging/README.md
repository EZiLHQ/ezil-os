# OS billing staging on AWS

Author-only runbook for `https://os-staging.ezil.work`: a new x86_64 t3.medium
running Amazon Linux 2023 in Mumbai (`ap-south-1`). Caddy publishes TCP 80/443;
Next listens only on the Compose network at `web:3000`. Caddy persists TLS state
in named volumes, disables its admin endpoint, and limits request bodies to 2MB.
Database and auth use the self-hosted Supabase PREVIEW stack; login uses Auth0
at `id.ezil.work`. This recipe changes no Vercel configuration or production host.

The same scripts deploy **production** with `OS_ENV=production`; unset `OS_ENV`
keeps exactly the staging flow below. See [Production](#production-os_envproduction)
and the ordered production runbook at the end of `INFRASTRUCTURE.md`.

## S9b host prerequisites and founder steps

1. Provision the staging instance, stable public IP and a non-production Name
   tag. S9b must enable IMDSv2 with **HTTP PUT response hop limit 2** so Docker
   can use instance-role credentials. No `extra_hosts` entry is required.
2. S9b installs/enables Docker, Docker Compose **>=2.30.0**, AWS CLI v2, Python 3,
   curl, gzip, tar, util-linux/flock and SSM Agent on AL2023. Compose's version
   is checked on install. Permit ingress 80/443; use SSM for administration.
3. Grant the host role Secrets Manager GetSecretValue on
   `ezil-os/billing-staging/app`, S3 GetObject on the chosen bucket's
   `os-staging/images/*`, and SSM managed-instance permissions. Grant scoped
   KMS decrypt if a customer-managed key is used. The author needs S3 PutObject,
   EC2 DescribeInstances and SSM SendCommand/GetCommandInvocation permissions.
4. Establish private host-to-PREVIEW Postgres access and HTTPS access to PREVIEW
   auth/API, Auth0, Stripe, the Worker, S3, Secrets Manager and Caddy image/ACME
   services. Match S9b's chosen bucket to any VPC endpoint policy.
5. Founder: set DNS A `os-staging.ezil.work` to the staging public IP; remove a
   stale AAAA record. In Auth0, allow callback
   `https://os-staging.ezil.work/auth/auth0/callback`, logout URL
   `https://os-staging.ezil.work/login`, and web origin
   `https://os-staging.ezil.work`. Preserve existing production allowlist entries.
6. Populate the Secrets Manager JSON with PREVIEW and Stripe test credentials.
   `AUTH0_SECRET_ID` is the Auth0 client secret value consumed by existing code,
   despite its name. Supply all required names below as nonempty JSON strings.

Required JSON key names (values deliberately omitted; `render-env.py` REQUIRED):
```text
NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY SUPABASE_DATABASE_URL AUTH0_CLIENT_ID AUTH0_SECRET_ID
STRIPE_SECRET STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET CRON_SECRET
BILLING_USAGE_HMAC_SECRET
```
Optional key names (`render-env.py` OPTIONAL; the app treats the Cloudflare
desktop pair as optional too):
```text
CLOUDFLARE_GUACAMOLE_WORKER_URL CLOUDFLARE_GUACAMOLE_HMAC_SECRET
BILLING_TAB_ENABLED PRICING_PAGE_ENABLED CHECKOUT_ENABLED BILLING_ENFORCEMENT
EZIL_AWS_COMPUTERS_ENABLED EZIL_AWS_CANARY_USER_IDS EZIL_AWS_CANARY_SINCE
EZIL_AWS_USER_MONTHLY_HOURS EZIL_AWS_GLOBAL_MONTHLY_HOURS
EZIL_AWS_USER_MONTHLY_EGRESS_GB EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB
EZIL_AWS_KILL_SWITCH EZIL_AWS_ENROLL_URL EZIL_AWS_WAKE_MODE
EZIL_AWS_LIFECYCLE_USERDATA_NONCE EZIL_AWS_BROWSER_ZONE
EZIL_AWS_IDENTITY_CERTS EZIL_AWS_PLUS_PLAN_IDS EZIL_AWS_LIFECYCLE_DEPLOYMENTS
EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET AWS_REGIONS AWS_MAX_RUNNING
BILLING_FUNDING_URL BILLING_FUNDING_HMAC_SECRET
EZIL_OS_FEEDBACK EZIL_OS_FEEDBACK_SCREENSHOTS FEEDBACK_PILOT_EMAILS FEEDBACK_ADMIN_EMAILS
EZIL_AWS_MAX_RUNNING_AP_SOUTH_1 EZIL_AWS_APP_CALLER_ROLE_ARN_AP_SOUTH_1
EZIL_AWS_MAX_RUNNING_US_EAST_1 EZIL_AWS_APP_CALLER_ROLE_ARN_US_EAST_1
```
Staging refuses production values: any value containing `db.ezil.work` or
`10.63.20.252`, and Stripe live keys (`pk_live_`, `sk_live_`, `rk_live_`).
`aws-config.ts` and `aws-clients.ts` derive the last two name families using the
uppercase region with underscores. The renderer accepts only those families
with the app's region grammar, plus the exact names above. Identity certs,
Plus plan IDs and lifecycle deployments serve adjacent modules. `AWS_REGIONS` and
`AWS_MAX_RUNNING` are also required by admission when AWS computers are enabled.

## Build, upload, install, smoke

Run from an authorized workstation, with a new TAG for each build. Export the
public build inputs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (matching runtime
`STRIPE_PUBLISHABLE_KEY`; current app code reads Stripe's runtime name).
Export `GIT_SHA` as the full source SHA, or let the script read Git HEAD.
Build only the intended checkout: the SHA does not describe uncommitted changes.
The builder needs package registries/base images and Google Fonts network access.
```bash
bash deploy/aws/os-staging/deploy.sh build TAG
# Export OS_STAGING_ARTIFACT_BUCKET and OS_STAGING_INSTANCE_ID from S9b outputs.
bash deploy/aws/os-staging/deploy.sh upload TAG
bash deploy/aws/os-staging/deploy.sh install TAG
bash deploy/aws/os-staging/deploy.sh smoke
```
Every command with an instance ID checks its Name tag and refuses `prod`
(case-insensitive) or a missing Name. Install/smoke require an instance ID.
Artifacts remain in this directory's `artifacts/`; do not commit them.
Upload uses conditional S3 writes and AES256 encryption under
`os-staging/images/TAG.*`. The checksum marker is uploaded last and covers both
the image and runtime bundle. A partial upload needs a fresh TAG.
Install downloads/verifies both, loads the image, updates `/opt/ezil-os-staging`,
renders root-owned mode-0600 env files, recreates Compose and enables timers.
SSM failure/timeouts fail locally; inspect the printed command ID before retrying.
Compose's wait confirms running containers, not application readiness.

The root Docker context copies `app/` build inputs plus only
`native/src/contract.ts` and its `surfaces.ts` dependency. The shell bundle is
already committed in `app/public/os`; no `shell/` build is needed. `deploy.sh`
copies `app/.dockerignore` next to a temporary Dockerfile as
`Dockerfile.dockerignore`, since Docker ignores app-level ignores with a root
context. It excludes env files, dependencies, build outputs and tests.
Bun 1.3.14 matches workflows; `bun run build` runs `next build --webpack`.
Runtime uses Node 22, a non-root user and `next start`; no migrations run.

Compose `format: raw` preserves `$`, quotes, hashes and backslashes. No Next
`.env` files are included: `@next/env` would need `\$`, while these values enter
`process.env` directly and must remain raw. Never source the generated files.
`cron.env` uses systemd quoting and contains only CRON_SECRET (minimum 32 chars).
Timers match Vercel UTC schedules: telemetry 03:17 daily, reap 04:08 daily,
billing sweep every minute. Persistent timers catch up once after downtime.
Each curl has a 50-second limit; cancellation does not cancel server-side work.

## Health, rollback and teardown

`/api/health` now returns `{"ok":true,"sha":...}`. Staging smoke requires HTTP 200
and prints `EZIL_GIT_SHA` from the running container via SSM (its failure message
still predates the route). Production smoke also requires the served SHA to equal
the container's.
For rollback, run `install PREVIOUS_TAG`; keep its image, runtime bundle and
checksum. This restores code/config, not prior Secrets Manager values or schema.
Failed installs may leave timers stopped; fix/reinstall or roll back promptly.
For teardown, stop/disable the three `ezil-os-staging-*.timer` units and their
services, run Compose down with `--env-file /opt/ezil-os-staging/compose.env`,
then remove this host's units, env files and optional Caddy volumes. S9b removes
the staging instance, IP, DNS and dedicated IAM/network resources. Retire only
the staging secret/artifacts when no rollback is needed; preserve PREVIEW data.

## Production (`OS_ENV=production`)

Export `OS_ENV=production` for every command. Production never reads the
`OS_STAGING_*` variables; anything other than unset, `staging` or `production` is
refused. The founder/lead order (stacks, DB access, secret, DNS, cutover) is in
`INFRASTRUCTURE.md`; this section lists what the scripts do differently.

| | staging (default) | production |
|---|---|---|
| Instance | `OS_STAGING_INSTANCE_ID`; Name must not contain `prod` | `OS_PRODUCTION_INSTANCE_ID`; must be Name `ezil-os-prod-host`, tag `ezil:env=production`, VPC `vpc-040bdd6e09e35425f`, never DB host `i-09012068d96166828` |
| Artifacts bucket | `OS_STAGING_ARTIFACT_BUCKET`, never `ezil-main-prod-*` | pinned `ezil-main-prod-artifacts-452630323510-aps1` |
| S3 prefix / local dir | `os-staging/images/` / `artifacts/` | `os/images/` / `artifacts/production/` |
| Image, Compose project | `ezil-os-staging` | `ezil-os-production` |
| Host paths | `/opt/ezil-os-staging`, `/etc/ezil-os-staging` | `/opt/ezil-os-production`, `/etc/ezil-os-production` |
| Secret | `ezil-os/billing-staging/app` | `ezil-os/production/app` |
| Caddy site | `os-staging.ezil.work` | `os-prod.ezil.work, os.ezil.work` |
| Timers | all six `ezil-os-staging-*` | `ezil-os-production-*`: telemetry-maintenance, sandbox-reap, billing-session-sweep; the AWS three only when the secret has `EZIL_AWS_COMPUTERS_ENABLED` |
| Cron target | `https://os-staging.ezil.work/api/cron/*` | `https://os-prod.ezil.work/api/cron/*` (always) |
| Smoke | `https://os-staging.ezil.work/api/health`, HTTP 200 | `https://os-prod.ezil.work/api/health` (`smoke public`: `https://os.ezil.work`, after cutover); HTTP 200 from the instance's public IP serving the container's SHA. Run without an HTTP(S) proxy |

`render-runtime.py` derives the production `compose.yaml`, `Caddyfile` and cron
units from the checked-in staging files at build time; a rename that no longer
matches exactly once, an unknown cron file, or any surviving staging reference
fails the build. The host installer refuses a host that carries the other
environment's `/var/lib/ezil-os-*` directory, and production requires
`/var/lib/ezil-os-production/bootstrap.done`.

Production build inputs are pinned: `NEXT_PUBLIC_SUPABASE_URL=https://db.ezil.work`
(baked into the client bundle; a different API hostname needs a rebuild),
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (the prod `ANON_KEY`) and a `pk_live_`
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. Build from a clean checkout of the frozen
main SHA and export it as `GIT_SHA`.
```bash
export OS_ENV=production GIT_SHA=FROZEN_MAIN_SHA
export NEXT_PUBLIC_SUPABASE_URL=https://db.ezil.work
export NEXT_PUBLIC_SUPABASE_ANON_KEY=... NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
bash deploy/aws/os-staging/deploy.sh build TAG
export OS_PRODUCTION_INSTANCE_ID=INSTANCE_ID_OUTPUT_OF_ezil-os-prod-host
bash deploy/aws/os-staging/deploy.sh upload TAG
bash deploy/aws/os-staging/deploy.sh install TAG
bash deploy/aws/os-staging/deploy.sh smoke          # os-prod.ezil.work
bash deploy/aws/os-staging/deploy.sh smoke public   # os.ezil.work, after cutover only
```

The production secret `ezil-os/production/app` uses the same key names as above.
`render-env.py production` additionally requires:
- `NEXT_PUBLIC_SUPABASE_URL` exactly `https://db.ezil.work`;
- `SUPABASE_DATABASE_URL` as
  `postgres://ROLE:PASSWORD@10.63.20.252:5432/postgres?sslmode=require`: the
  private Postgres listener (no HAProxy in production; `db-proxy.sh` stays
  staging-only) and no other query parameters (postgres.js would send them as
  startup parameters). `sslmode=require` encrypts but does not authenticate the
  self-signed server certificate. Which ROLE to use is an open DB-owner decision
  (see `INFRASTRUCTURE.md`);
- Stripe live keys: `STRIPE_PUBLISHABLE_KEY` `pk_live_`, `STRIPE_SECRET`
  `sk_live_` or `rk_live_`, plus the live `STRIPE_WEBHOOK_SECRET`;
- new `CRON_SECRET` (at least 32 characters) and `BILLING_USAGE_HMAC_SECRET`;
- no value containing a staging or preview reference (`os-staging.ezil.work`,
  `13-203-99-168.sslip.io`, `10.61.20.35`).

Paid plans are on at launch, so set the billing flags (`BILLING_TAB_ENABLED`,
`PRICING_PAGE_ENABLED`, `CHECKOUT_ENABLED`, `BILLING_ENFORCEMENT`) as the launch
decision says. Leave every `EZIL_AWS_*`, `AWS_REGIONS` and `AWS_MAX_RUNNING`
unset until production AWS computers have their own reviewed app-caller role;
the staging app-caller trusts only `ezil:env=billing-staging` principals. The
production one is the `prd` namespace's
`arn:aws:iam::452630323510:role/ezil/prd/ezil-prd-app-caller` (trust: exactly
this host's instance role with `ezil:env=production`), the only non-empty
`AppCallerRoleArn` the production host template accepts; see
`deploy/aws/mum/README.md` "Production namespace prd".

Rollback is `install PREVIOUS_TAG` with `OS_ENV=production`; keep its three
`artifacts/production/` files and S3 objects. Production teardown mirrors staging
with `ezil-os-production-*` units and `/opt/ezil-os-production/compose.env`.
