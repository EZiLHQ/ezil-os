# Workspace store on AWS S3

Computers run on Cloudflare Containers. Their `/workspace` checkpoints are written by `worker/src/workspace-persist.ts` through the S3 store adapter, which is turned on with `EZIL_WORKSPACE_STORE=s3`. This folder provisions the AWS side.

## Before enabling it for any user

1. **Checkpoint garbage collection.** Every changed checkpoint uploads a full snapshot, and superseded generations are never deleted (`workspace-checkpoint.container.test.ts` pins this finding). Without GC, storage and PUT volume grow on every flush of an active workspace. Versioning makes this worse, because it keeps every overwritten head.
2. **Migration.** An existing computer must hydrate from R2 once, and then its first flush writes to S3. This is the read-through migrating store on `feat/persistent-compute-s3-adapter`. The switch is one-way: switching back to R2 after S3 writes would serve a stale workspace.
3. **Staging first.** Run `worker/src/workspace-checkpoint.container.test.ts` with `EZIL_CHECKPOINT_STORE=s3` against the staging bucket. Then run the recovery mission (Notion 3eb7021e…f42ca §5) on staging.

## Provision (founder, scoped admin identity — not the root user)

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws cloudformation deploy --region us-east-1 \
  --stack-name ezil-os-workspace-store-staging \
  --template-file infra/workspace-store/workspace-store.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides BucketName=ezil-os-workspaces-staging-$ACCOUNT KeyPrefix=workspaces/ \
      BudgetEmail=contact@ezil.work MonthlyBudgetUsd=50
```

The template creates:
- a private bucket with Block Public Access, owner-enforced ownership, SSE-S3 encryption, versioning, and a policy that refuses non-TLS requests;
- lifecycle rules that expire noncurrent versions after 30 days and abort incomplete multipart uploads;
- an IAM user, `/ezil/ezil-os-workspace-store-<region>`, that can only Get and Put objects and List the bucket under `workspaces/`, with no Delete;
- an S3 budget alarm.

## Give the Worker its credentials (never commit, never echo)

Create one access key for the IAM user in the console (IAM → Users → the user → Security credentials). Paste it straight into Wrangler secrets:

```bash
cd worker
wrangler secret put EZIL_WORKSPACE_S3_ACCESS_KEY_ID --env staging
wrangler secret put EZIL_WORKSPACE_S3_SECRET_ACCESS_KEY --env staging
```

Then set the non-secret vars for `[env.staging.vars]`:
- `EZIL_WORKSPACE_STORE=s3`
- `EZIL_WORKSPACE_S3_BUCKET=<bucket>`
- `EZIL_WORKSPACE_S3_REGION=us-east-1`
- `EZIL_WORKSPACE_S3_KEY_PREFIX=workspaces/`

If any of these is missing, the Worker fails closed with `workspace_store_misconfigured`. It never falls back to R2 on its own.

## Cost model (us-east-1 list prices; verify before relying on them)

| Item | Price | Notes |
|---|---|---|
| Storage | about $0.023 per GB-month | Grows without bound until GC lands; see above. |
| PUT | about $0.005 per 1,000 | One per 1 MiB chunk on each changed flush, plus one head put. |
| GET | about $0.0004 per 1,000 | Hydrate, plus the head read on every flush. |
| **Egress to Cloudflare** | about $0.09 per GB | Every hydrate downloads the whole snapshot. R2 egress is free. |

Example: a 100 MB workspace costs about $0.009 in egress per cold start. With 5 cold starts a day for each of 100 users, that is about $135/month in egress alone.
