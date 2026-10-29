# Billing staging infrastructure (S9b)

Author-only templates for account **452630323510**, **ap-south-1**. No AWS calls,
network access, deployment, credential reads, DNS changes or DB changes were
performed while authoring. See `README.md` for the separate app release flow.

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
