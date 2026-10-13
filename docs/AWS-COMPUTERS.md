# AWS persistent computers — decision record and contracts

Status: **accepted for implementation, off by default.** Nothing here changes how existing
computers run. Cloudflare Containers, local mode (`local/`) and native macOS stay supported.
Every AWS path is gated by per-computer placement (C-2) and by configuration that defaults off.

This document pins the contracts that the parallel implementation lanes build against.
Changing a contract means changing this file first, in its own reviewed commit.

## 1. Why

Hosted computers run on Cloudflare Containers today. Their disk is rebuilt from an R2
checkpoint on every start (`docs/WORKSPACE-STORE.md`). This record adds a second hosted
provider. Each computer is an EC2 instance whose state lives on a retained, encrypted EBS
volume.

The aim is persistence of the *whole* computer:
- workspace
- HOME
- root-installed tools
- browser and editor profiles

It must also give explicit start/stop, bounded cost, and later a small bounded pool of
pre-booted hosts.

## 2. Decisions

| # | Decision |
|---|---|
| R1 | One region per deployment, configured. Zones are addressed only by **ZoneId** (for example `aps1-az1`), never by account-mapped zone names. A pilot uses one ZoneId. |
| R2 | **Stage A:** one VM per user, stopped and started in place. **Stage B:** a bounded single-use pool of running blank hosts. Stage B ships default-off and stays off until Stage A acceptance (§7). |
| R3 | **State of record = one retained encrypted gp3 data volume per computer.** It holds the desktop container's overlay upper layer (system installs), `/workspace`, HOME, and the browser and editor profiles. The host root volume is disposable: OS plus pre-pulled image. Backups are scheduled EBS snapshots. Periodic checkpoints to object storage are **off** for AWS computers. Export to S3 happens only for migration, rollback or explicit export, through short-lived per-key presigned URLs. |
| R4 | The desktop runs as one container on the host, reusing local mode's argv builder (`local/src/container/run-spec.ts`), with no privileged mode and no added capabilities. The runtime (podman `--rootfs` over a host-managed overlay, or Docker with `data-root` on the data volume) is chosen by the S1 spike's measurements. |
| R5 | **Threat model: the user may become root on their own host.** Everything the guest says is advisory: agent reports, the disk marker, load, connector state. The host holds no useful cloud credentials: no instance role, or a custom minimal one. IMDSv2 is required, with hop limit 1, instance metadata tags disabled, and container traffic to the metadata address dropped. |
| R6 | No inbound network rules, no NAT gateway, no load balancer. Outbound is open for developer-desktop parity, bounded by out-of-guest egress metering and caps. Each computer reaches the gateway only through a per-generation Cloudflare Tunnel. |
| R7 | A Step Functions lifecycle workflow owns EC2/EBS mutations. The app may only start executions of exact workflow versions and describe resources. The Cloudflare Worker holds no EC2 or IAM rights; it keeps only its existing workspace-store S3 scope, and mints presigned URLs from it. EC2 state-change events are reconciled into the database. |
| R8 | Single writer per computer, enforced by compare-and-swap on a generation number under a per-computer advisory lock. EBS single-attach is the physical fence. A reviewed migration-grammar extension adds UNIQUE indexes (required before Stage B). |
| R9 | Idle stop may be guest-initiated, but caps are not. Lease renewal comes only from gateway-observed, authenticated user presence. Hour, egress and lease limits are enforced by the control plane: warn, then flush, then stop, regardless of what the guest reports. |
| R10 | Instance types come from a closed allowlist. Pilot: one standard 2 vCPU / 8 GiB type; one 4 vCPU / 8 GiB type for benchmarks only. No burstable-credit types. |
| R11 | Volume sizes come from an allowlist or range, with capped online growth. Automation never deletes volumes or snapshots and never force-detaches. Purge is a separate operator action. |
| R12 | Hibernation is off. |
| R13 | Provider and store are chosen **per computer**. No global store flip is used to migrate a subset of computers. An unknown value fails closed. |
| R14 | No new shell provider tag. A hosted AWS computer presents as a hosted computer. |
| R15 | Browser and editor profiles live on the data volume (AWS only). Stale Chrome `Singleton*` locks are cleared only after the single-writer lease is confirmed. |

## 3. Contracts

### C-1 ComputeProvider (app)

`app/src/server/lib/compute/provider.ts` holds lifecycle members only. It contains no
hostnames, tokens, zones or buckets, following the `SandboxHost` non-goals in
`local/src/host/sandbox-host.ts`.

```ts
export type ProviderKind = 'cloudflare' | 'aws-ec2';
export interface ComputeProvider {
  readonly kind: ProviderKind;
  ensure(ctx: ComputeCtx, c: ComputerRef): Promise<EnsureResult>;   // ready | starting | refused(reason)
  status(ctx: ComputeCtx, c: ComputerRef): Promise<ComputeStatus>;  // authenticated
  activity(ctx: ComputeCtx, c: ComputerRef, s: ActivitySignal): Promise<void>;
  restart(ctx: ComputeCtx, c: ComputerRef): Promise<void>;
  stop(ctx: ComputeCtx, c: ComputerRef, reason: StopReason): Promise<void>;
  terminate(ctx: ComputeCtx, c: ComputerRef): Promise<void>;        // aws-ec2: retire, keep volume
  persistenceStatus(ctx: ComputeCtx, c: ComputerRef): Promise<PersistenceStatus>;
}
```

- Desktop-control calls (focus, screen, relay refresh) stay Worker endpoints. The Worker
  routes them per placement.
- The Cloudflare adapter wraps the existing module in place. File paths, router keys and
  names parsed by the SDK surface tests do not change.

### C-2 Placement and usage records (database)

Placement lives in its own table, never on `ezil_computers`, which users may update. It
must stay inside the hosted migration grammar (`docs/production-migrations.md`).

```sql
CREATE TABLE public.ezil_computer_placements (
  computer_id uuid NOT NULL, provider text NOT NULL, workspace_store text NULL,
  generation bigint NOT NULL, state text NOT NULL, region text NULL, zone_id text NULL,
  instance_id text NULL, instance_type text NULL, volume_id text NULL, fs_uuid uuid NULL,
  tunnel_id text NULL, enroll_nonce_hash text NULL, enroll_expires_at timestamptz NULL,
  lease_until timestamptz NULL, presence_at timestamptz NULL, updated_at timestamptz NOT NULL);
CREATE INDEX ezil_computer_placements_computer_idx ON public.ezil_computer_placements (computer_id);
REVOKE ALL ON TABLE public.ezil_computer_placements FROM public, anon, authenticated;
ALTER TABLE public.ezil_computer_placements ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.ezil_compute_usage (
  computer_id uuid NOT NULL, user_id uuid NOT NULL, instance_id text NOT NULL,
  instance_type text NOT NULL, started_at timestamptz NOT NULL, stopped_at timestamptz NULL,
  egress_bytes bigint NULL, observed_by text NOT NULL, updated_at timestamptz NOT NULL);
CREATE INDEX ezil_compute_usage_computer_idx ON public.ezil_compute_usage (computer_id);
REVOKE ALL ON TABLE public.ezil_compute_usage FROM public, anon, authenticated;
ALTER TABLE public.ezil_compute_usage ENABLE ROW LEVEL SECURITY;
```

- **Reading.** No row means `cloudflare` plus `r2`. More than one row, or any unknown enum
  value, fails closed.
- **Writing.** Every write goes through one module.
  - Creation takes `pg_advisory_xact_lock` on the computer.
  - Every transition is `UPDATE … WHERE computer_id = $1 AND generation = $expected RETURNING`.
  - A periodic duplicate check (`HAVING count(*) > 1`) alarms and closes admission.

### C-3 Lifecycle states

- Main path: `PROVISIONING → STOPPED → LEASED → STARTING → MOUNTING → RUNNING → DRAINING → STOPPING → STOPPED`.
- Failure path: `UNCONFIRMED → RECOVERING → STOPPED`.
- Retirement: `RETIRING → RETIRED → PURGE_ELIGIBLE`. The purge itself is a separate operator action (§6).
- Stage B slots: `WARMING → READY → CLAIMED → terminated`.

**Leasing and admission**
- `LEASED` reserves `generation + 1`.
- Admission runs in the same transaction, under one global advisory lock. All of these must hold:
  - running-class count < `AWS_MAX_RUNNING`
  - one AWS computer per user
  - per-user and global monthly instance-hours under their caps
  - per-user and global monthly egress under their caps
- Refusals carry a machine-readable reason.

**Errors**
- Capacity and quota errors fail fast.
- Throttling errors retry.
- Every error is recorded on `UNCONFIRMED`.

### C-4 Disk marker (bug fence only)

`/srv/ezil-data/.ezil-marker.json` holds:
`{computerId, volumeId, fsUuid, generation, lowerImageDigest}`.

- The host agent mounts by filesystem UUID.
- It refuses to mount on any mismatch, or if `generation` is not below the lease generation.
- It writes the new generation, and fsyncs, before starting the desktop.

A root user can rewrite this file, so it catches bugs, not attacks. The security fences are:
- EBS single-attach
- generation compare-and-swap
- tunnel deletion
- the terminal migration head (C-7)

### C-5 Gateway token v2 and routing

Today's preview HMAC signs a constant (`${ts}.POST./sandbox/preview.`), so it binds nothing.

**v2 token**
- Signs `ts, method, path, sandboxId, computerId, userId, provider, store, generation` plus a
  digest of the body.
- v1 is accepted only during a time-boxed rollout window, then removed.

**Routing an `aws-ec2` computer**
- The origin hostname is derived from signed fields:
  `c-<sandboxId>-g<generation>.<AWS_ORIGIN_ZONE>`.
- The zone comes from a Worker-side allowlist, never from the request.
- The Worker attaches a gateway access credential and a generation-bound HMAC, which the
  host verifies.
- Unknown values fail closed. The existing zone guard still runs first.
- WebSocket upgrades are proxied.

Cloudflare routing stays byte-identical, proven by regression tests.

### C-6 Host enrollment (replay-resistant)

An AWS instance identity document is **replayable**: anyone holding one copy can send it
again. On its own it is never sufficient. Enrollment binds the live instance, the
generation and a one-time nonce.

1. **Issue.** When the control plane leases generation N for instance I, it creates a random
   one-time nonce. It stores only the nonce's hash and expiry, of at most 10 minutes, on the
   placement. The plaintext nonce goes to the host through launch user data for that
   generation.
   - User data is readable on that host, and only there.
   - For a pool claim, the nonce goes through the workflow that performs the claim.
2. **Present.** The host posts `{computerId, generation, nonce, identityDocument, signature}`
   to the app enrollment endpoint.
3. **Verify.** The app refuses unless every check passes:
   - the signature verifies against the region's published AWS certificate
   - `instanceId` and ZoneId equal the placement
   - `generation` equals the placement generation, and the state is `STARTING` or `MOUNTING`
   - the nonce hash matches and has not expired
   - a **live** describe call shows instance I `running` in that ZoneId, with the data volume
     attached to it
4. **Consume.** The nonce is cleared by compare-and-swap, so it works once. A second
   enrollment for the same generation is refused.
5. **Tunnel.** Only then does the app ask the Worker to create the per-generation tunnel. The
   Worker alone holds the Cloudflare API token. The tunnel token is returned once.
   - After the connector connects, the Worker checks that the connector's origin address
     equals the instance's public address. On mismatch it deletes the tunnel and fences the
     generation.
6. **Fence.** A new generation, a stop or a retire deletes the previous tunnel and its
   connections.

A user who replays their own computer's material can reach only their own computer.

### C-7 Migration fence and export rules

- The Cloudflare checkpoint protocol gains a terminal `migrated` head, written by
  compare-and-swap. Every later Cloudflare flush refuses to replace it.
- Garbage collection is suspended for the migrating prefix during export.
- Oversized workspaces or system deltas, beyond the checkpoint caps, are **refused**, never
  truncated.

**Rollback from AWS to Cloudflare is refused when it would lose data.** That covers:
- state beyond the checkpoint caps
- files outside the system-delta roots, such as service data under `/var/lib`
- browser profiles

The operator sees the exact list. AWS-only state is never silently dropped.

## 4. Caps and cost controls

| Control | Value / rule |
|---|---|
| Running computers | `AWS_MAX_RUNNING`; pilot value 2 |
| Computers per user | 1 |
| Instance-hours | monthly aggregate cap, including idle running and pool hours; per-user cap |
| Egress | monthly GB caps per user and aggregate, measured outside the guest (CloudWatch `NetworkOut`) |
| Storage | volume size allowlist; growth capped |
| Kill switch | admission off → recovery workflow disabled → graceful stop of every instance → deny-start policy attached; no volume deleted |

Budget alarms are alerts, not enforcement. Cost figures in public documents describe
*method* only; operators compute their own from their region's price list.

## 5. Identity

- **Deploys** run through a federated CI role with environment approval, a custom
  CloudFormation execution policy and a permission boundary. The boundary sets:
  - region lock
  - an IAM path prefix
  - no users or access keys
  - no boundary removal
  - no volume or snapshot deletion
- **The app** uses a federated role with execution-start on exact workflow versions only.
- **Purge** is an operator role behind MFA, outside the boundary, and audited.
- The account root user is never used for deploys.

## 6. Retention, cancellation, rollback

- **Cancellation** stops compute immediately. Encrypted volumes and snapshots stay
  recoverable for **14 days**, with residual storage cost disclosed. After that a computer
  becomes `PURGE_ELIGIBLE`.
- **Purge tooling** ships as eligibility listing plus dry-run only.
- **Rollback window** is 14 days after migration. The rules in C-7 apply.

## 7. Acceptance before enabling

**Stage A canary.** Staging evidence is required:
- live access-denied proofs for cross-computer attach, disallowed type, unencrypted volume
  and retagging
- metadata unreachable from containers
- ≥ 20 lifecycle cycles with unchanged volume IDs
- ≥ 5 byte-identical Cloudflare→AWS→Cloudflare round trips, including a late-flush injection
- tunnel-fence and kill-switch drills
- measured egress per active hour
- the hosted continuity suite against an AWS computer
- the benchmark in `docs/PERFORMANCE-BASELINE.md` style, measured from India

**Stage B** requires all of the following:
- 4 clean weeks of Stage A
- the UNIQUE grammar extension
- capacity and a budget that fits the measured cost
- a live concurrent-claim proof

**Latency claims.** "1–2 s ready" may be claimed only for reconnecting to an already-running
computer, and only when measured p95 ≤ 2.0 s with a confidence bound.
