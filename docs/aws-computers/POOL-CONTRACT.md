# Warm pool contract v1 (pinned 2026-10-19, lead only)

Purpose: a paid computer opens by **adopting a pre-booted, clean host** instead of
cold-booting one. The measured disk attach is about 2 s; a cold boot is about 12 s
to guest init, plus desktop start.

This one file binds three lanes: L4a infra (`infra/app-computers`), L4b host agent
(`infra/host-agent`) and L4c app (`app/src/server/lib/compute`). The existing
`ready-pool.ts` (lease with `FOR UPDATE SKIP LOCKED`), `replenishPlan` and
`docs/aws-computers/sql/0002_ready_pool.sql.txt` are the starting point; extend
them, don't fork them.

## Invariants
1. **Pool hosts are single-use.** A host serves one computer epoch, then it is
   retired. It never returns to the pool, so no tenant residue is possible.
2. **A pool host boots with no user data.** It has only the AMI root disk. The user
   disk is attached at adopt time, and the host mounts it **by EBS volume serial**,
   never by device name. (Nitro may name the root disk `nvme1n1` after a restart.)
3. **Zone match.** A volume only attaches in its own zone, so spares live in the
   zones where placements' volumes live. v1 uses one zone per region
   (ap-south-1: `aps1-az1`).
4. **Fences.** Adopt bumps the computer generation, then the lease epoch. The host
   tag carries `ezil:fence` = the new fence token. The host refuses a
   non-increasing epoch. EBS single-attach is the physical fence.
5. **Spend bound.** Spares count toward the region vCPU cap and the
   `EZIL_AWS_KILL_SWITCH`. When the kill switch is on, the pool target is 0.

## States (`ezil_compute_pool_hosts.state`)
`booting → ready → leased → retiring → retired`, plus `failed`.
- `ready` requires all three: `health_ok`, `editor_ready_at`, and an enrollment
  less than 10 minutes old.
- A host stuck in `booting` for more than 10 minutes moves to `failed` and is
  retired.

## Lifecycle intents (new operations, same intent v1 envelope, same authority checks)
- **`pool-provision`** `{region, zoneId, instanceType, poolHostId, poolGeneration}`
  - RunInstances from the pinned launch template and AMI, with no data volume.
  - Tags: `ezil:pool=1`, `ezil:pool-host=<id>`, `ezil:namespace`.
  - User-data lease: `{kind:"pool", poolHostId, poolGeneration}`.
  - Uses the intent-derived idempotent ClientToken.
- **`adopt`** `{computerId, generation, leaseEpoch, poolHostId, instanceId, volumeId | createVolume:{sizeGiB}}`
  - Verifies the instance is a running, pool-tagged host in the same zone, and
    that the volume is `available`.
  - Creates the volume if needed (encrypted gp3, `DeleteOnTermination=false`).
  - AttachVolume at `/dev/sdf`.
  - Retags the instance: `ezil:computer`, `ezil:generation`, `ezil:fence`, and
    removes `ezil:pool`.
  - Never force-detaches.
- **`release`** `{computerId, generation, instanceId}`
  - Normal OS shutdown with flush, then waits for stopped.
  - Detaches the data volume without force, then terminates the instance.
  - The volume is kept.
- Controller IAM adds AttachVolume, CreateTags and DeleteTags. These are
  conditioned on `aws:ResourceTag/ezil:pool=1` (adopt) or
  `ezil:computer=<id>` (release), with `ec2:InstanceType` kept in the allowlist.

## Host agent (pool mode)
- **Boot.** When the user-data lease has `kind:"pool"`, enroll as a pool host:
  `POST /api/compute/aws/pool/enroll` with the instance identity document plus
  PKCS7. The app verifies it with `EZIL_AWS_IDENTITY_CERTS`, exactly like the
  existing enroll.
- **Report readiness.** Start the desktop stack without user data. Report
  `POST /api/compute/aws/pool/ready` `{poolHostId, health}` once the editor is up.
- **Claim.** Poll `GET /api/compute/aws/pool/claim` every 1 s, authenticated by the
  identity document. The response is
  `{computerId, generation, leaseEpoch, fence, volumeSerial}` or 204.
  - On a claim: wait for the volume serial, mount it, run the existing
    computer-epoch enrollment, and switch the desktop session to the user's home
    on that disk.
- **Before enrolling, refuse** if the fence doesn't match the instance tag, or if
  the epoch doesn't increase.

## App
- **`leasePoolHost`** is the existing function. It is ordered by
  `pool_priority desc, ready_at asc`, and Premium (priority 2) leases ahead of
  Standard (1).
- **Open a paid computer.**
  - If a ready host exists in the volume's zone: lease it, then `adopt`, then
    answer the claim. Otherwise use the existing cold `provision` / `replace`.
  - The first epoch opens at the host's verified ready time; provisioning
    overhead is recorded separately.
- **Session end** (sweeper or user stop) issues `release`.
- **`/api/cron/pool-replenish`** (`CRON_SECRET`, every minute):
  - **target** = `clamp(minSpares, maxSpares, ceil(startsLast15m × bootMinutes / 15) + minSpares)` per `(region, zone, instanceType)`;
  - **scale up** at most 2 boots per pass;
  - **scale down**: retire ready spares above target that have been idle more than 30 minutes, newest first;
  - **bounds**: the region vCPU cap and the kill switch.
- **Policy constants** live in code (`POOL_POLICY` in `ready-pool.ts`). There are
  no new env vars:
  - ap-south-1 `m6i.large`: min 1, max 4;
  - ap-south-1 `m6i.xlarge`: min 0, max 2 (Premium; boots on demand);
  - us-east-1: min 0.

## Tests
- **Offline:**
  - lease race (N concurrent callers, exactly one winner);
  - priority order;
  - replenish and drain math;
  - adopt and release state machine in the ASL interpreter;
  - host agent: claim / fence / serial-mount unit tests.
- **Real (lead):** the test matrix T2–T7 in the plan on the `mum` deployment.
