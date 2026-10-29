# Billing staging infrastructure (S9b)

Author-only templates for account **452630323510**, **ap-south-1**. No AWS calls,
network access, deployment, credential reads, DNS changes or DB changes were
performed while authoring. See `README.md` for the separate app release flow.
Both templates take `Environment` (default `staging`, which resolves to the same
resource properties as before the parameter existed); production is the last
section.

## Founder / lead order

1. Verify the account/region and the existing preview VPC
   `vpc-0f6bc19fdfd4209aa`, public subnet `subnet-0dd4cf8f7d3d92e20`, its internet
   gateway route and DNS. Choose an existing **non-production** ArtifactBucket
   permitted by the preview S3 endpoint and the exact AppCallerRoleArn. Those
   parameters have no invented defaults. VpcId, SubnetId and InstanceType are
   parameters with the founder's verified defaults. Do not use any
   `ezil-main-prod-*` resources or host `i-09012068d96166828`.
2. Review/create the `app-host.yaml` change set, with IAM capability and stack
   tags `ezil:env=billing-staging`, `ezil:purpose=os-staging`. Leave stack
   termination protection disabled. The template creates only the disposable
   app host, its role/profile, SG and EIP. It does not install the app. Confirm
   SSM availability and `/var/lib/ezil-os-staging/bootstrap.done` before release;
   CloudFormation completion alone does not verify cloud-init success. Package
   and Compose download availability still need live validation. Bootstrap
   installs Docker, Compose 2.39.4 (checksummed), Python, AWS CLI v2 and tools.
3. Record InstanceId, PublicIp, InstanceRoleArn and AppSecurityGroupId. Obtain
   the app's private IP and network interface name on the **DB host** for the
   firewall plan. Add **only InstanceRoleArn** to the reviewed lifecycle config's
   `appCaller.ec2CallerRoleArns` array, keeping the existing OIDC provider entry.
   Redeploy that lifecycle stack through its normal owner. `bin/lifecycle.ts`
   already forwards the parsed appCaller object; the optional key is part of
   that schema and the example uses `[]` (no added trust by default). The role
   must exist before updating the trust policy; the host may be created first
   because its permission policy can reference the existing app-caller ARN.
4. Verify DbSecurityGroupId belongs to **preview i-097aa7c356e91c78f only** and
   inspect all of that SG's attachments. Review/create `db-access.yaml` with
   that SG and AppSecurityGroupId. Its only resource is TCP 5432 ingress from the
   app SG. There is no public DB CIDR or ownership of the existing DB SG/host.
5. Through SSM on the preview host, review/copy `db-proxy.sh` and run `nft-plan`.
   It refuses every action unless `/var/lib/ezil-main-preview/environment.json`
   exists, `/var/lib/ezil-main-prod` is absent, and local IPv4 is `10.61.20.35`.
   Review any firewall change with the DB owner as described below. Then run
   `start` and `status`. HAProxy binds only `10.61.20.35:5432` and connects to
   `supabase-db` on `ezil-main-preview_default`, restricted to the preview
   internal subnet `172.30.60.0/24`. It never rewrites Supabase Compose or nft.
   The first start resolves `haproxy:lts-alpine` to a digest retained in
   `/opt/os-staging-db-proxy/image.ref`. Record that digest; subsequent runs use
   it. Run `refresh` after DB container recreation; only this labeled proxy can
   be replaced, briefly interrupting its connections. Verify actual DB access
   from the app; listener/process checks alone do not establish backend health.
6. Independently record the preview PostgreSQL system ID via the verified
   preview host's local DB using `SELECT system_identifier FROM pg_control_system()`.
   Never discover the expected ID from the unverified tunnel itself. Use SSM
   port forwarding on **i-097aa7c356e91c78f**, remote `127.0.0.1:5432`, local
   `15432`. Supply the URL via `BILLING_STAGING_DATABASE_URL` using approved
   secret handling. `aws-preview` accepts only `127.0.0.1:15432`,
   `localhost:15432`, or `10.61.20.35:5432`, with explicit ports. Example commands
   below use a non-secret system-ID placeholder; replace it with the recorded
   digits. The DB role needs permission to call `pg_control_system()`.

   ```bash
   node app/scripts/billing-staging-schema.mjs plan --target aws-preview --expect-system-id VERIFIED_DIGITS
   node app/scripts/billing-staging-schema.mjs apply --yes --target aws-preview --expect-system-id VERIFIED_DIGITS
   # Baseline only after separately verifying that this file's schema exists:
   node app/scripts/billing-staging-schema.mjs baseline app/drizzle/0006_compute_migrations.sql --yes --target aws-preview --expect-system-id VERIFIED_DIGITS
   # Once on os-staging: 0002_image_rebase is now in the list but was applied out of band by
   # rebase_release.py. Its SQL is not re-runnable, so after verifying public.ezil_computer_image_jobs
   # exists, baseline it before the next apply (production applies it instead):
   node app/scripts/billing-staging-schema.mjs baseline docs/aws-computers/sql/0002_image_rebase.sql.txt --yes --target aws-preview --expect-system-id VERIFIED_DIGITS
   ```

   The initial system-ID query precedes log creation and all mode operations.
   Each later psql session repeats the pin before SQL. IDs compare as strings
   (no floating-point loss). Mismatch/failure stops without exposing psql output.
   URL query routing overrides and inherited PG routing variables are refused or
   stripped. Protected production/Website refs remain forbidden. The legacy
   default target `ezil-os-awstest` and its offline plan remain available.
   Preview transport defaults to `sslmode=disable`: the SSM tunnel encrypts
   workstation transport, and direct proxy traffic is private VPC TCP. Explicit
   `sslmode` can be supplied if the backend supports it; HAProxy adds no TLS.
7. Configure DNS A `os-staging.ezil.work` to PublicIp, remove stale AAAA, set the
   Auth0 staging callbacks, and populate `ezil-os/billing-staging/app` through
   the approved secret workflow. Use preview Supabase API
   `https://13-203-99-168.sslip.io`, the preview private DB URL and Stripe test
   values. Follow `README.md` to build/upload/install and perform HTTPS/auth,
   billing and app-caller smoke checks. No migration is run by bootstrap.

## Firewall review

The named `ezil-db-aws/preview` checkout is empty. Sources read were its CONTRACT.md
and the adjacent `ezil-db-aws.worktrees/preview-20261017/preview/runtime/NETWORK.md`
and `preview-network.nft`, plus the newer `studio-m1` copy. Both define
`inet ezil_preview` input/forward hooks; the newer copy also restricts internal
bridge peer edges in `bridge ezil_preview_l2`.

The checked-in input guard has policy accept, source checks for the two Docker
bridges and container-to-host drops. It does **not** drop ordinary EC2-interface
input or host-output traffic. Consequently a host-network proxy does not require
an internal bridge exception. Do not widen that bridge allowlist. Review the
live rules for any additional host-input drop. `db-proxy.sh nft-plan` prints a
review-only input rule scoped to the external EC2 interface, app private IP /32,
DB private IP and TCP 5432. Substitute the reviewed interface/IP and insert it
before the relevant drop in its owning chain if needed. An accept in one base
chain cannot override a drop in another. The helper never invokes nft.

The DB owner must persist approved exceptions in the preview guard source and
its hash/fingerprint workflow; Docker startup reapplies that policy and can
remove an ad hoc rule. Record handles/comments for precise removal. Never flush
rulesets, change production tables or remove the preview guard. Test both the
intended app path and denial from other sources; the dedicated SG is mandatory.

## IAM, tags and teardown

The EC2 role has AmazonSSMManagedInstanceCore plus exactly three inline grants:
GetObject on `<ArtifactBucket>/os-staging/images/*`, GetSecretValue on this
account/region's `ezil-os/billing-staging/app-*` ARN prefix (including the AWS ARN
suffix for secret name `app`), and AssumeRole on AppCallerRoleArn. No bucket
listing/write, secret write, ECR or extra KMS grants. Use AWS-managed encryption;
a customer-managed secret key would need separately reviewed decrypt access.

Optional app-caller trust lists exact role principals and requires
`aws:PrincipalTag/ezil:env=billing-staging`. Wildcards, account-root principals,
STS session ARNs and duplicates are rejected. The existing caller permissions
and OIDC trust are unchanged. EC2 role tags supply the principal tag condition.

All taggable resources and the root volume receive both requested tags.
CloudFormation InstanceProfile, EIPAssociation and SecurityGroupIngress have no
Tags property; tag their stacks for attribution. No custom tagging resource or
extra IAM permissions were added. Every template resource has Delete deletion
and replacement policies; root disk deletes on termination. EIP/instance remain
billed until teardown. Deleting/replacing the host loses local app/TLS state.

Teardown order: stop the staging app and cron clients; remove the EC2 ARN from
app-caller trust; run proxy `remove` **on the verified preview host**; remove only
any reviewed firewall exception; delete the DB ingress stack; withdraw staging
DNS and delete the app-host stack (including EIP, root disk, role/profile/SG).
No shared DB, VPC, subnet, Supabase containers, artifacts or secrets are deleted.

Updating an existing staging stack to the `Environment` version changes no
resource property, but CloudFormation re-resolves the `AmazonLinuxAmi` SSM
parameter on every update: if AL2023 has a newer AMI, the change set replaces the
instance. There is no need to update the staging stacks; if you do, review the
change set first.

## Production order (`Environment=production`, `OS_ENV=production`)

Nothing here has been executed. Account **452630323510**, **ap-south-1**. The
production database host `i-09012068d96166828` already serves Universe, Works and
the Gateway: these steps never touch it, its volumes or the SG's other rules.

**Blockers to clear first**
- `https://db.ezil.work` had no certificate on 443 and GoTrue `SITE_URL` was
  still the sslip.io name (read-only probe, 2026-10-29). The build bakes
  `NEXT_PUBLIC_SUPABASE_URL=https://db.ezil.work` and both `deploy.sh` and
  `render-env.py` enforce it, so the DB owner must serve that hostname first.
- App code: `https://os-prod.ezil.work` is not in `OWNED_APP_ORIGINS`
  (`app/src/utils/forwarded.ts`); until it is, Auth0 sign-in on the smoke
  hostname redirects to the canonical origin.
- Schema `apply --target aws-production` must be allowed by the reviewed
  `app/scripts/billing-staging-schema.mjs` change; run it (SSM port forward to
  `i-09012068d96166828`, `--expect-system-id 7698288507300208674`) before install.
- Backups (wal-g archiving, fresh snapshots) are the DB owner's maintenance
  window and come before the schema.

**C. Host**
1. Create `ezil-os-prod-host` from `app-host.yaml` through a reviewed change set:
   ```bash
   aws cloudformation create-change-set --region ap-south-1 --change-set-type CREATE \
     --stack-name ezil-os-prod-host --change-set-name create \
     --template-body file://deploy/aws/os-staging/app-host.yaml --capabilities CAPABILITY_IAM \
     --parameters ParameterKey=Environment,ParameterValue=production \
       ParameterKey=VpcId,ParameterValue=vpc-040bdd6e09e35425f \
       ParameterKey=SubnetId,ParameterValue=subnet-0e7c19ed848d0fcea \
       ParameterKey=InstanceType,ParameterValue=t3.medium \
       ParameterKey=ArtifactBucket,ParameterValue=ezil-main-prod-artifacts-452630323510-aps1 \
     --tags Key=ezil:env,Value=production Key=ezil:purpose,Value=os
   ```
   AppCallerRoleArn keeps its default `''`. The template's Rules refuse
   production with any other VPC, subnet or bucket, or a non-empty
   AppCallerRoleArn, and refuse staging with any of these prod values. Review, execute, then record `InstanceId` (`OS_PRODUCTION_INSTANCE_ID`),
   `PublicIp` and `AppSecurityGroupId`. Do **not** add `InstanceRoleArn` to the
   staging app-caller trust. Termination protection stays off, as for staging.
2. Create `ezil-os-prod-db-access` from `db-access.yaml` the same way with
   `Environment=production`, `DbSecurityGroupId=sg-0f3151c94e0ed4ee6`,
   `AppSecurityGroupId=<step 1 output>` and the same two stack tags. Its only
   resource is TCP 5432 from the app SG ("OS production app to private
   PostgreSQL"); deleting the stack removes only that rule. No proxy is needed:
   the private listener `10.63.20.252:5432` already exists, and `db-proxy.sh`
   stays staging-only.
3. Through SSM on the new instance, confirm
   `/var/lib/ezil-os-production/bootstrap.done` exists and
   `timeout 5 bash -c '</dev/tcp/10.63.20.252/5432'` succeeds.

**D. Secret and Auth0**
4. The founder creates `ezil-os/production/app` (no customer-managed KMS key)
   with the key names and production shapes in `README.md` ("Production"):
   `aws secretsmanager create-secret --region ap-south-1 --name ezil-os/production/app
   --secret-string file://PRIVATE_FILE --tags Key=ezil:env,Value=production Key=ezil:purpose,Value=os`,
   then shred `PRIVATE_FILE`. `SUPABASE_DATABASE_URL` is
   `postgres://ROLE:PASSWORD@10.63.20.252:5432/postgres?sslmode=require`
   (postgres.js 3.4.9 turns `sslmode=require` into TLS without certificate
   verification and would forward any other query key as a startup parameter,
   so the renderer refuses other keys). **ROLE is an open DB-owner decision:** a
   dedicated role like Universe's `ezil_universe_app` needs explicit grants on
   the OS tables and on what the Auth0 bridge reads in `auth.*`; no step here
   creates it.
5. In Auth0 (`id.ezil.work`), add callbacks
   `https://os.ezil.work/auth/auth0/callback` and
   `https://os-prod.ezil.work/auth/auth0/callback`, logout URLs
   `https://os.ezil.work/login` and `https://os-prod.ezil.work/login`, and web
   origins `https://os.ezil.work` and `https://os-prod.ezil.work`. Keep the
   staging entries.

**E. Build, upload, install** (`README.md`, "Production")
6. From a clean checkout of the frozen main SHA:
   `OS_ENV=production deploy.sh build TAG`, then `upload TAG`, then `install TAG`.
   Upload needs `s3:PutObject` on `ezil-main-prod-artifacts-452630323510-aps1/os/images/*`
   from the workstation; confirm the bucket policy allows it from outside the VPC
   endpoint. Install enables only the three non-AWS timers and prints which.

**F. Smoke on the private hostname**
7. Add a DNS-only A record `os-prod.ezil.work` to `PublicIp`. Caddy obtains its
   certificate; it keeps retrying `os.ezil.work` until cutover (expected log noise).
8. `OS_ENV=production deploy.sh smoke` must pass: HTTP 200, the connection's
   remote IP equals the instance's public IP from `describe-instances`, and the
   served SHA equals the container's. Run it without an HTTP(S) proxy. Then check by hand: Auth0 sign-in and sign-out, one new
   `auth.users` row, `/os` loads and Settings renders, and
   `systemctl list-timers 'ezil-os-production-*'` shows three timers whose last
   runs succeeded (`journalctl -u ezil-os-production-billing-session-sweep`).

**G. Cutover**
9. Finish the main push to Vercel first (`preview.yml` live-checks
   `os.ezil.work`) and record the Vercel deployment ID as the rollback target.
10. Lower the `os.ezil.work` TTL to 60 s, then replace the CNAME
    `570c89d9a01c497d.vercel-dns-017.com` with a DNS-only A record to `PublicIp`
    (and no AAAA record). Caddy has been failing ACME for `os.ezil.work` until
    now and backs off between retries, so restart it over SSM to retry at once:
    `cd /opt/ezil-os-production && docker compose --env-file compose.env restart caddy`.
    Expect a short TLS gap while it obtains the certificate.
11. `OS_ENV=production deploy.sh smoke public` passes only when `os.ezil.work`
    is answered from this instance's public IP with its SHA; Vercel serving the
    same frozen SHA still fails it.
12. Cron deliberately stays on `https://os-prod.ezil.work` (the read-only runbook
    suggested moving it to `os.ezil.work`): Caddy serves both names, so nothing
    changes at cutover and the production `CRON_SECRET` never reaches Vercel.
    Keep the `os-prod.ezil.work` record after cutover.
13. Redirecting `os.ezil.org` to `os.ezil.work` is a separate Cloudflare approval.

**H. Rollback**
14. Restore the Vercel CNAME. On the host, `OS_ENV=production deploy.sh install
    PREVIOUS_TAG` for an earlier AWS build. The schema is forward-only and
    additive; the first real user write on the AWS host is the point of no return.

**Teardown** (before any user data only): stop and disable the
`ezil-os-production-*` timers, Compose down with
`--env-file /opt/ezil-os-production/compose.env`, delete `ezil-os-prod-db-access`,
remove the `os-prod.ezil.work` record, delete `ezil-os-prod-host`. Keep the
secret and `os/images/` objects until no rollback needs them. The DB host, its
SG, VPC, subnet, endpoint and buckets are shared and never deleted here.
