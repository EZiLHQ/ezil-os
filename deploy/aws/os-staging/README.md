# OS billing staging on AWS

Author-only runbook for `https://os-staging.ezil.work`: a new x86_64 t3.medium
running Amazon Linux 2023 in Mumbai (`ap-south-1`). Caddy publishes TCP 80/443;
Next listens only on the Compose network at `web:3000`. Caddy persists TLS state
in named volumes, disables its admin endpoint, and limits request bodies to 2MB.
Database and auth use the self-hosted Supabase PREVIEW stack; login uses Auth0
at `id.ezil.work`. This recipe changes no Vercel configuration or production host.

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

Required JSON key names (values deliberately omitted):
```text
NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY SUPABASE_DATABASE_URL AUTH0_CLIENT_ID AUTH0_SECRET_ID
STRIPE_SECRET STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET CRON_SECRET
CLOUDFLARE_GUACAMOLE_WORKER_URL CLOUDFLARE_GUACAMOLE_HMAC_SECRET
BILLING_USAGE_HMAC_SECRET
```
Optional key names:
```text
BILLING_TAB_ENABLED PRICING_PAGE_ENABLED CHECKOUT_ENABLED BILLING_ENFORCEMENT
EZIL_AWS_COMPUTERS_ENABLED EZIL_AWS_CANARY_USER_IDS EZIL_AWS_CANARY_SINCE
EZIL_AWS_USER_MONTHLY_HOURS EZIL_AWS_GLOBAL_MONTHLY_HOURS
EZIL_AWS_USER_MONTHLY_EGRESS_GB EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB
EZIL_AWS_KILL_SWITCH EZIL_AWS_ENROLL_URL EZIL_AWS_WAKE_MODE
EZIL_AWS_LIFECYCLE_USERDATA_NONCE EZIL_AWS_BROWSER_ZONE
EZIL_AWS_IDENTITY_CERTS EZIL_AWS_PLUS_PLAN_IDS EZIL_AWS_LIFECYCLE_DEPLOYMENTS
AWS_REGIONS AWS_MAX_RUNNING
EZIL_AWS_MAX_RUNNING_AP_SOUTH_1 EZIL_AWS_APP_CALLER_ROLE_ARN_AP_SOUTH_1
EZIL_AWS_MAX_RUNNING_US_EAST_1 EZIL_AWS_APP_CALLER_ROLE_ARN_US_EAST_1
```
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

## Known gap, rollback and teardown

This checkout has **no `/api/health` or version route**. Smoke deliberately fails
the requested health probe and still prints `EZIL_GIT_SHA` from the running
container via SSM. An app owner must add a health route before smoke can pass.
For rollback, run `install PREVIOUS_TAG`; keep its image, runtime bundle and
checksum. This restores code/config, not prior Secrets Manager values or schema.
Failed installs may leave timers stopped; fix/reinstall or roll back promptly.
For teardown, stop/disable the three `ezil-os-staging-*.timer` units and their
services, run Compose down with `--env-file /opt/ezil-os-staging/compose.env`,
then remove this host's units, env files and optional Caddy volumes. S9b removes
the staging instance, IP, DNS and dedicated IAM/network resources. Retire only
the staging secret/artifacts when no rollback is needed; preserve PREVIEW data.
