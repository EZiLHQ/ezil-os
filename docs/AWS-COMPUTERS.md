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
| R1 | One region per deployment, configured. Zones are addressed only by **ZoneId** (for example `aps1-az1`), never by account-mapped zone names. A pilot uses one ZoneId. Several regions mean several deployments (identity, lifecycle, AMI per region). The app orders them in `AWS_REGIONS`; a computer's region is chosen **once, at creation** (the first region with room) and is sticky: its volume lives there, every wake runs there, and a full home region refuses (`capacity_unavailable`), it never moves the computer. |
| R2 | **Stage A:** one VM per user, stopped and started in place. **Stage B:** a bounded single-use pool of running blank hosts. Stage B ships default-off and stays off until Stage A acceptance (§7). |
| R3 | **State of record = one retained encrypted gp3 data volume per computer.** It holds the desktop container's overlay upper layer (system installs), `/workspace`, HOME, and the browser and editor profiles. The host root volume is disposable: OS plus pre-pulled image. Backups are scheduled EBS snapshots. Periodic checkpoints to object storage are **off** for AWS computers. Export to S3 happens only for migration, rollback or explicit export, through short-lived per-key presigned URLs. |
| R4 | The desktop runs as one container on the host. **Decided by the S1 spike: overlay rootfs.** The image rootfs is the read-only lower layer on the disposable root volume; the upper and work directories sit on the data volume. runc runs it from a host-generated OCI spec that reuses the image's entrypoint and environment, as local mode's `run-spec.ts` does; it is not built by that argv builder. No ports are published. Docker with `data-root` on the data volume was rejected: it copies the full image (~4.5 GB) onto every user volume and cannot be rebased. Section 3a lists the host-agent rules that must hold before user traffic. |
| R5 | **Threat model: the user may become root on their own host.** Everything the guest says is advisory: agent reports, the disk marker, load, connector state. The host holds no useful cloud credentials: no instance role, or a custom minimal one. IMDSv2 is required, with hop limit 1, instance metadata tags disabled, and container traffic to the metadata address dropped. |
| R6 | No inbound network rules, no NAT gateway, no load balancer. Outbound is open for developer-desktop parity, bounded by out-of-guest egress metering and caps. Each computer reaches the gateway only through a per-generation Cloudflare Tunnel. |
| R7 | A Step Functions lifecycle workflow owns EC2/EBS mutations. The app may only start executions of exact workflow versions and describe resources. The Cloudflare Worker holds no EC2 or IAM rights; it keeps only its existing workspace-store S3 scope, and mints presigned URLs from it. EC2 state-change events are reconciled into the database. |
| R8 | Single writer per computer, enforced by compare-and-swap on a generation number under a per-computer advisory lock. EBS single-attach is the physical fence. A reviewed migration-grammar extension adds UNIQUE indexes (required before Stage B). The engine copies in sibling repositories have diverged, so the extension is ported to each one separately with shared test vectors. |
| R9 | Idle stop may be guest-initiated, but caps are not. Lease renewal comes only from gateway-observed, authenticated user presence. Hour, egress and lease limits are enforced by the control plane: warn, then flush, then stop, regardless of what the guest reports. |
| R10 | Instance types come from a closed allowlist, chosen by the computer's **tier** (2026-10-14, superseding "no burstable types"): **free** = 2 vCPU / 4 GiB (`t3a.medium`, then `t3.medium`), launched with *standard* CPU credits so it throttles to its baseline instead of billing surplus CPU; **plus** = 2 vCPU / 8 GiB (`m6i.large`). One 4 vCPU / 8 GiB type stays for benchmarks only. The app records the tier's first type at creation (`AWS_TIERS`, app `aws-config.ts`); the region deployment's allowlist must contain it or the intent is refused. |
| R11 | Volume sizes come from an allowlist or range, with capped online growth. Lifecycle automation never deletes retained volumes or force-detaches. Undeleted computers retain their data regardless of inactivity or placement retirement. Scheduled DLM backup rotation stays bounded; it does not delete the data volume. Destructive purge is held pending a separate explicit-deletion policy (§6). |
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
export type StopReason = 'idle_reap' | 'user' | 'cap' | 'lease_expired';
export interface ComputeProvider {
  readonly kind: ProviderKind;
  // opts carries sessionId, desktopMode and screen; result is the full preview result | starting | refused(reason)
  ensure(ctx: ComputeCtx, c: ComputerRef, opts: EnsureOptions): Promise<EnsureResult>;
  status(ctx: ComputeCtx, c: ComputerRef): Promise<ComputeStatus>;
  activity(ctx: ComputeCtx, c: ComputerRef, s: ActivitySignal): Promise<ActivityResult>;
  restart(ctx: ComputeCtx, c: ComputerRef): Promise<RestartResult>;
  stop(ctx: ComputeCtx, c: ComputerRef, reason: StopReason): Promise<StopResult>;
  terminate(ctx: ComputeCtx, c: ComputerRef): Promise<TerminateResult>; // aws-ec2: retire, keep volume
  persistenceStatus(ctx: ComputeCtx, c: ComputerRef): Promise<PersistenceStatus>; // added once the persistence-health change lands
}
```

- Operations return result objects, not `void`, because callers report their outcomes.
- **Cloudflare:** `stop` and `terminate` are the same call (DELETE: flush to R2, then destroy).
  `status` stays the existing unsigned GET.
- **aws-ec2:** `status` must be authenticated.

- Desktop-control calls (focus, screen, relay refresh) stay Worker endpoints. The Worker
  routes them per placement.
- The Cloudflare adapter wraps the existing module in place. File paths, router keys and
  names parsed by the SDK surface tests do not change.

### C-2 Placement and usage records (database)

Placement lives in its own table, never on `ezil_computers`, which users may update. It
must stay inside the hosted migration grammar (`docs/production-migrations.md`).

```sql
CREATE TABLE public.ezil_computer_placements (
  computer_id uuid NOT NULL, owner_user_id uuid NOT NULL, provider text NOT NULL, workspace_store text NULL,
  generation bigint NOT NULL, lease_epoch bigint NOT NULL, state text NOT NULL, region text NULL, zone_id text NULL,
  instance_id text NULL, instance_type text NULL, volume_id text NULL, fs_uuid uuid NULL,
  tunnel_id text NULL, enroll_nonce_hash text NULL, enroll_expires_at timestamptz NULL,
  lease_until timestamptz NULL, presence_at timestamptz NULL, updated_at timestamptz NOT NULL,
  reconciled_at timestamptz NULL);
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
  - Every transition is `UPDATE … WHERE computer_id = $1 AND generation = $g AND lease_epoch = $e RETURNING`.
  A user-triggered transition (open, stop, a failed start's undo) also matches `owner_user_id` = the authenticated
  caller, so another user's placement never moves. Only the lifecycle receipt path (the reconciler) transitions without
  an owner, through a separate entry point that no user-facing module may name (a source-scan test enforces this).
  - **Two counters.** `generation` is the *writer* generation: it changes only when the instance is replaced or recovered, and it matches the lifecycle tags on the instance and volume. `lease_epoch` increases on every lease (each start or claim) without retagging AWS resources.
  - A periodic duplicate check (`HAVING count(*) > 1`) alarms and closes admission.

- **Values.** `provider` ∈ {`cloudflare`, `aws-ec2`}. `workspace_store` is `r2` or `s3` for
  `cloudflare`, and `ebs` for `aws-ec2`. Any other pairing fails closed.
- **Ownership.** The owner is recorded on the placement as `owner_user_id`, set once from the
  authenticated session at creation, and never taken from `ezil_computers`. Users can update
  and insert `ezil_computers` rows (including their `id`), so that table cannot prove
  ownership. Admission and every provider operation compare the caller with
  `owner_user_id`, and per-user caps count placements by `owner_user_id`.
- **Single writer includes reconcilers.** The EC2 state-change reconciler and the usage
  observer write only through the placement module (`app/src/server/lib/compute/placement.ts`).
  A test fails if any other file names these tables.
- **Usage windows.** One row per instance run. A confirmed `running` receipt opens it, in the same
  transaction as the placement transition, dated from the lifecycle job's start (the safe direction for a
  cap); a confirmed `stopped` or `retired` receipt closes it. A replace closes the old instance's open row.
  Hours are clipped to the month in `usage.ts`.
- **Egress is not measured yet.** No writer fills `egress_bytes` (it is always NULL), so the monthly egress
  caps do not bind: they are configured and validated, but every egress total is 0. Only the hour caps are
  enforced. The out-of-guest measurement (CloudWatch `NetworkOut`) is open work.
- **Registration.** The SQL is kept as `docs/aws-computers/sql/*.sql.txt` until the founder
  rehearses it and registers it in the migration manifest with observed digests. An
  unregistered `.sql` file anywhere in the repository fails `validate`.

### C-3 Lifecycle states

- Main path: `PROVISIONING → STOPPED → LEASED → STARTING → MOUNTING → RUNNING → DRAINING → STOPPING → STOPPED`.
- First boot: `PROVISIONING → RUNNING`. The infra provision launches and boots the instance, so the user's first open
  goes straight in, and the receipt lands RUNNING. `PROVISIONING → STOPPED` stays for a provision that ends stopped.
- Failure path: `UNCONFIRMED → RECOVERING → STOPPED`.
- Retirement: `RUNNING | STOPPED → RETIRING → RETIRED`. Retained-data purge is held (§6). ONE `computer.delete` is enough: a
  RUNNING or STOPPED computer gets the lifecycle `retire` job (a running instance is stopped gracefully first, then
  terminated; the data volume is kept), and once that job — or an already-recorded stop — is on the placement the
  row is soft-deleted. The sandbox-reap cron's AWS job (`runAwsBackgroundReconcile`; it runs concurrently with the
  Cloudflare reap under its own 60-second budget, so an AWS outage never delays or disables the Cloudflare billing
  backstop; past the budget the pass stops before its next placement and reports `aws_reconcile_timeout`) then applies receipts for
  every placement whose computer is soft-deleted or gone, starts the retire of one that reached STOPPED, and fences
  the tunnel before RETIRED. Booting states refuse the delete. A computer with no
  placement deletes at once. A refused retire `StartExecution` returns to the state it came from and the delete is
  refused. The purge itself is a separate operator action (§6).
  - A deleted computer whose stop or retire then FAILS (UNCONFIRMED), or whose recovery was interrupted
    (RECOVERING), is recovered by the same background pass: it re-checks that the computer is deleted or gone,
    confirms EC2 still knows the instance, then `UNCONFIRMED → RECOVERING → RETIRING` with a new retire job (the
    retire resolves any instance state). A refused start returns it to UNCONFIRMED (`retire_start_failed`) for the
    next pass. A LIVE computer's UNCONFIRMED placement is never touched by this path. The pass rotates
    (`reconciled_at`), so stuck rows never starve others.
  - An UNCONFIRMED or RECOVERING placement is settled for a delete (`settleUnconfirmedAwsPlacement`: the owner's
    own `computer.delete`, and the background pass above for a deleted computer), never released while an instance
    could still run. A placement that recorded NO instance and NO volume (a provision that failed before any id was
    recorded) is released only when an EC2 tag search (`ezil:computer-id`, instances not terminated, volumes not
    deleted, read in full) finds nothing. A recorded instance that EC2 no longer has (or shows terminated) is settled
    by its retained volume: gone too → released; `available` → retired (the retire job accepts an absent source);
    `in-use`/`error` → `stuck` for an operator. Otherwise `UNCONFIRMED → RECOVERING → RETIRING` with a recorded
    retire job, and the delete proceeds as `retiring`. A RELEASE is one reconciler-only compare-and-swap
    (`UNCONFIRMED | RECOVERING → RETIRED`, `last_error = released_no_resources`, usage row closed, tunnel fenced),
    then PURGE_ELIGIBLE at once: nothing is retained, so the user's AWS-computer allowance is freed.
- Lost instance: a RUNNING row whose instance EC2 no longer has, or shows `shutting-down`/`terminated` (an external
  terminate, an EC2 failure), gets no receipt ever. The same looks (`status`, `ensure`, the fleet pass) describe its
  data volume (`DescribeVolumes`), fence the epoch's tunnel, then in ONE reconciler-only compare-and-swap close the
  usage row and move RUNNING → STOPPED with `last_error = instance_lost`, after which the next open is always a
  REPLACE onto that volume (start mode included). A missing volume lands UNCONFIRMED
  `instance_lost_volume_missing` instead. An unknown describe or a failed fence changes nothing until the next look.
- Shell stop (`POST /api/shell/stop`, `terminate` with `confirm`): an AWS stop is asynchronous, so the route waits
  (bounded, 200 s inside its 300 s) for the stop's receipt and answers `destroyed` only once the placement is
  STOPPED, `not_running` when it already was, and the shell's "not yet" (`still_running`) at the deadline. The UI's
  own `terminate` stays fire-and-forget.
- Lease renewal is monotonic: `presence_at`/`lease_until` are written as `GREATEST(current, new)`, so racing renewals
  (two tabs, an open and a heartbeat) can never shorten a lease.
- Guest-initiated idle stop (R9): the host stops its own instance with no lifecycle job. `status`, `ensure` and
  `terminate` read the instance's EC2 state (the app caller's region-scoped `DescribeInstances`); a RUNNING row
  whose instance is stopping or stopped gets the ORDINARY lifecycle `stop`, which the helper confirms at once, so
  the receipt path fences the tunnel, closes the usage row and lands STOPPED. A capacity refusal runs the same
  check across the fleet (`reconcileAwsFleet`, bounded), so idle-stopped rows cannot exhaust running capacity.
  The EC2 observation never writes STOPPED itself. The fleet pass ROTATES: it claims the least recently
  reconciled rows (never-reconciled first) and stamps `reconciled_at` (bookkeeping only; no CAS reads it,
  `updated_at` is untouched; `FOR UPDATE SKIP LOCKED`), so successive passes cover every row instead of the
  oldest `FLEET_RECONCILE_LIMIT` forever.
- Session limits (R9, `aws-receipts.ts` `enforceSessionLimits`): a RUNNING computer whose `lease_until` has passed
  (`lease_expired`; no lease at all counts as lapsed), or whose owner (`user_hours_cap`) or the whole fleet
  (`global_hours_cap`) reached the month's hour cap, gets the ORDINARY lifecycle `stop` (OS shutdown, so the host
  flushes like any stop) with the reason in `last_error`. Checked on every `status` and `ensure`, on every activity
  heartbeat, and by the fleet pass (sandbox-reap cron, capacity refusals). Admission refuses the next wake with the
  same cap codes.
- Lease: set at provision and at every wake (`leaseSeconds`, 1 h). Renewed ONLY from the authenticated owner's
  presence: the shell's activity heartbeat (`reportActivity`, sent each minute while the desktop tab is visible and
  focused, never on stale presence) and an explicit open (`ensure`). Renewal is an owner-guarded same-state CAS
  (`renewPlacementLease`) that moves `presence_at` and `lease_until`, never shortens a lease, and writes only once
  half of it is used. A status poll is not presence and renews nothing.
- **Open (not enforced in real time yet):** a tab left open but unattended stops heartbeating, so its lease lapses,
  but nothing reaches the app until the next status/ensure or the daily cron; the host's own idle stop does not
  fire either, because the open WebSocket keeps gateway presence (GW-3) alive. Closing that needs the deadline on
  the host: the app pushes `lease_until` through the GW-5 control relay on each renewal (a `lease` command signed
  with `controlKey`, like `stop`/`fence`), and the agent stops itself, flushing, once it passes. No warning is shown
  before a stop yet.
- Stage B slots: `WARMING → READY → CLAIMED → terminated`.

**Lifecycle authority (app)**
- The workflow calls `POST /api/internal/computers/lifecycle-authority` before each mutation. Set
  `EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET` to the same 64 lowercase hex characters as the Secrets Manager
  `authoritySecretArn` secret's `AWSCURRENT` value. The app decodes it as a 32-byte HMAC-SHA256 key, verifies
  the signed request bytes and Unix timestamp (±300 seconds), and requires the AWS placement's current job,
  digest and lease epoch to match in `PROVISIONING`, `LEASED`, `STARTING`, `MOUNTING`, `DRAINING`, `STOPPING`
  or `RETIRING`. A match returns 200 with `{authorized:true, ...authorityFields}`; refusal returns 403.
  A missing/malformed secret or unavailable placement read returns 503 (uncertain, never authorized).

**Leasing and admission**
- `LEASED` reserves `lease_epoch + 1`. A replace or recovery also reserves `generation + 1`.
- An AWS placement is created at `lease_epoch` 1, because the provision is the computer's first lease. Its intent carries
  epoch 1 and the host writes disk-marker epoch 1, so the first wake leases 2. A row created at 0 would lease 1 on its
  first wake, the C-4 guard would refuse it (the marker epoch is not below it), and the computer could never wake.
  Cloudflare rows never lease and start at 0.
- Admission runs in the same transaction, under one global advisory lock. All of these must hold:
  - running-class count < `AWS_MAX_RUNNING`
  - one AWS computer per user
  - per-user and global monthly instance-hours under their caps
  - per-user and global monthly egress under their caps
- Refusals carry a machine-readable reason.
- Holding the admission lock is not enough to write. An admitted decision mints a single-use ticket bound to this
  transaction, computer, user and kind (create or lease), and only after that computer's counters were read under the
  lock. AWS creation and leasing refuse without it. Only the admission module mints tickets (a repository scan test).

**Wake mode (`EZIL_AWS_WAKE_MODE`, app)**
- `replace` (default): a STOPPED computer wakes as a NEW instance of its recorded type on the retained data volume. The
  lease reserves `generation + 1` and `lease_epoch + 1`, and a new fence token. The intent hands the stopped writer's
  instance, generation and fence on as `previous*`; the helper stops and terminates it, never the volume. The launch
  user data carries this boot's enrollment nonce (C-6), so no attribute write is needed. The disposable root boots fresh
  from the AMI; user state lives on the data volume (overlay upper, HOME).
- `start`: the same instance starts in place (epoch + 1 only). Its nonce must be written into user data while stopped,
  which the lifecycle deployment allows only with `features.userDataNonce` after the staging proof. The app refuses
  `start` (`aws_config_invalid`) unless the operator also sets `EZIL_AWS_LIFECYCLE_USERDATA_NONCE=1`, because a started
  host without a fresh nonce could never enroll.
- Every boot's job id, intent digest, fence token and enrollment nonce hash are written by the SAME compare-and-swap that
  admits the boot (the creation insert or the lease). The intent is built first: the CAS moves generation and epoch by
  exactly one, so nothing about it depends on the write. Starts and stops of a generation carry that generation's
  recorded fence token: the instance and volume are tagged with it, and the helper refuses any other.
- A refused `StartExecution` after a start-in-place lease returns the row to STOPPED (only the epoch moved). After a
  replace lease it goes to UNCONFIRMED: the generation already moved, so recovery decides.
- Only an ANSWERED refusal is a refusal (a 4xx, a named service refusal, or a failure before sending). A
  `StartExecution` that gets no answer (5xx, timeout, connection lost) may have started the execution, so it is
  retried a bounded number of times (the execution name `computer-<jobId>` and its digest-fixed input make the retry
  idempotent). If no attempt is answered the placement KEEPS its in-flight state and recorded job (the authority
  endpoint still authorizes it), marked `lifecycle_start_unknown:<undo state>`. The receipt path follows the
  execution if Step Functions knows it; once it is still unknown after a 5-minute settle window the start is known
  never to have happened: a stop or retire (no secret in its input) is rebuilt, digest-checked and started again under
  the same name, and a provision or wake (whose input carries the never-stored enrollment nonce) moves to the undo
  state a refusal would have left (`lifecycle_start_failed`). This covers provision, wake, stop and retire, from the
  provider and from the reconciler.
- An answered THROTTLE (400 `ThrottlingException`/`RequestLimitExceeded`, 429, a throttled OIDC credential fetch) is
  definite (nothing ran) but transient: it gets the same bounded retries, never the refusal undo. If every attempt is
  throttled the job stays recorded as above (`lifecycle_start_unknown:<undo>`), so a mandatory lease or hour-cap
  stop is re-started by the settle path rather than dropped. Only a definite, non-retryable answer (access,
  validation, capacity) is a refusal.

**Errors**
- Capacity and quota errors fail fast.
- Throttling errors retry.
- Every error is recorded on `UNCONFIRMED`.

**Receipts (app, `aws-receipts.ts`; the reconciler path)**
- Only the placement's CURRENT job is read (`DescribeExecution` on `computer-<jobId>` under the region's machine). Its
  success output must match that job, digest, generation, lease epoch, fence, data volume and the expected state
  (`running` for a boot, `stopped` for a stop); anything else goes UNCONFIRMED (`receipt_conflict` / `receipt_invalid`)
  and keeps the job for recovery.
- A boot is RUNNING only when BOTH the provider receipt arrived AND its host enrolled (nonce consumed): STARTING →
  MOUNTING on the receipt, MOUNTING → RUNNING once enrolled; a provision goes PROVISIONING → RUNNING once both hold.
- A stop receipt lands STOPPED and fences that generation's tunnel (GW-1 DELETE).
- A failed execution goes UNCONFIRMED with `last_error`: `capacity:<code>:<type>` for `LifecycleRefused` + a capacity code,
  else `failed:<error>`. A capacity-refused computer answers `capacity_unavailable` and never moves region. Retrying the
  tier's next type (t3a.medium → t3.medium) needs infra recovery to prove nothing launched and to keep the volume's
  previous-generation tags (LIFECYCLE.md); `nextInstanceTypeAfterCapacity` exists but is not wired.

### C-4 Disk marker (bug fence only)

`/srv/ezil-data/.ezil-marker.json` holds:
`{computerId, volumeId, fsUuid, generation, leaseEpoch, lowerImageDigest}`.

- The host agent mounts by filesystem UUID.
- It refuses to mount on any mismatch, if `generation` is above the lease's writer generation, or if `leaseEpoch` is not below the lease epoch.
- It writes the new epoch (and generation), and fsyncs, before starting the desktop.

A root user can rewrite this file, so it catches bugs, not attacks. The security fences are:
- EBS single-attach
- generation compare-and-swap
- tunnel deletion
- the terminal migration head (C-7)

### C-5 Gateway token v2 and routing

Today's preview HMAC signs a constant (`${ts}.POST./sandbox/preview.`), so it binds nothing.

**v2 token**
- Signs `ts, method, path, sandboxId, computerId, userId, provider, store, generation, leaseEpoch` plus a
  digest of the body.
- v1 is accepted only during a time-boxed rollout window, then removed.

**v2 rollout (implemented on `feat/worker-token-v2-store`, P4a/P4b)**
- Wire: header `x-ezil-auth: v2.<base64url claims>.<hex hmac>`, never in the body (the body
  is digested). Payload: `v2|ts|METHOD|path|sandboxId|computerId|userId|provider|store|generation|leaseEpoch|sha256hex(body)`.
  Shared vectors: `worker/src/preview-token-v2.vectors.json`.
- `path` is the URL pathname only. A v2 request with **any query string is refused**
  (`hmac_v2_query_not_allowed`): the query is not signed.
- **Replay:** there is no nonce (C-5 does not require one). A captured token can be replayed
  for the same method, path and body within the 5-minute TTL.
- An empty `store` claim means "no claim"; the Cloudflare adapter always sends `''`, because
  the app has no per-computer store record and the Worker refuses a claim that differs from
  the computer's sticky store.
- v2 has no unsigned local-dev mode: no secret means `hmac_secret_not_configured`.
- `GET /health` advertises `previewTokenVersions` (`["v1","v2"]`, or `["v2"]` once v1 is
  retired). An old Worker omits the field.

**Rollout order**
1. Deploy the Worker (P4a). Confirm `GET /health` lists `"v2"`.
2. Only then set the app's `EZIL_PREVIEW_TOKEN_V2=1`. If the Worker is rolled back below P4a
   while the flag is on, every v2 call is refused (401); unset the flag first.
3. **Do NOT set `EZIL_PREVIEW_TOKEN_V1_UNTIL`** until every v1 minter is migrated. Today these
   still mint v1 (`t=…,v1=…`):
   - app: focus, screen and relay-refresh calls in `cloudflare-guacamole-provider.ts`, and the
     telemetry-drain and telemetry-maintenance crons (`app/src/app/api/cron/*`,
     `app/src/server/telemetry/spool-drain-transport.ts`);
   - `worker/scripts/*` (`reap-idle-sandboxes.mjs`, `pull-neko-log.mjs`,
     `twen-live-validate.mjs`, `run-workspace-isolation-mission.ts`);
   - `e2e/hosted-continuity.mjs`.
   After the cutoff these all get `hmac_v1_token_retired`. An unparseable cutoff value
   refuses v1 (fail closed). The cutoff never affects the `/preview-bootstrap` token or the
   `ezil_preview` cookie.

**Open PR #166 (fail closed without a secret) — verified two-line resolution, not merged here**
- Add `SANDBOX_ALLOW_INSECURE_LOCAL_AUTH?: string` to `Env`.
- In `authorizeSigned`, call `verifyPreviewToken(legacyToken, resolvePreviewSecrets(env), allowInsecureLocalAuth(env))`.
  Every signed route already goes through `authorizeSigned`, so this is the only v1 call site;
  #166's per-route edits collapse into it. v2 already fails closed.

**Routing an `aws-ec2` computer**
- The origin hostname is derived from signed fields:
  `c-<sandboxId>-g<generation>-e<leaseEpoch>.<AWS_ORIGIN_ZONE>`.
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
   placement. The plaintext nonce goes to the host through **instance user data written
   by the lifecycle workflow for that epoch**:
   - on a launch, as launch user data;
   - on a start-in-place, by `ModifyInstanceAttribute` while the instance is stopped. The
     lifecycle role may call it **only** for the `userData` attribute, and every other
     attribute stays denied.
   - User data is readable on that host, and only there.
   - For a pool claim, the nonce goes through the workflow that performs the claim.
2. **Present.** The host posts `{computerId, generation, nonce, identityDocument, signature}`
   to the app enrollment endpoint.
3. **Verify.** The app refuses unless every check passes:
   - the signature verifies against the region's published AWS certificate
   - `instanceId` and ZoneId equal the placement
   - `generation` and `leaseEpoch` equal the placement's, and the state is `STARTING` or `MOUNTING`
   - the nonce hash matches and has not expired
   - a **live** describe call shows instance I `running` in that ZoneId, with the data volume
     attached to it
4. **Consume.** The nonce is cleared by compare-and-swap, so it works once. A second
   enrollment for the same epoch is refused.
5. **Tunnel.** Only then does the app ask the Worker to create the per-generation tunnel. The
   Worker alone holds the Cloudflare API token. The tunnel is per epoch, and its token is returned once.
   - After the connector connects, the Worker checks that the connector's origin address
     equals the instance's public address. On mismatch it deletes the tunnel and fences the
     generation.
6. **Fence.** A new epoch, a stop or a retire deletes the previous tunnel and its
   connections.

A user who replays their own computer's material can reach only their own computer.

**App implementation (`app/src/server/lib/compute/aws-enroll.ts`, route `POST /api/compute/aws/enroll`)**
- Issue: every provision and wake writes `sha256(nonce)` and a 10-minute deadline in the same compare-and-swap that admits
  the boot; the plaintext goes only into that launch's user data (the host lease JSON of `lease.py`, plus `enrollUrl`).
- Signature: CMS/PKCS7 (IMDS `/pkcs7`, RSA or DSA, SHA-256 or SHA-1, with or without signed attributes) verified against
  the region's AWS certificate from `EZIL_AWS_IDENTITY_CERTS` only; embedded certificates are ignored.
- Live describe (injected): the instance is `running`, in the placement's ZoneId, carries the CURRENT generation's tags
  (computer id, generation, fence token, namespace), has a public address, and holds the data volume (provision: the one
  retained, non-root volume tagged for the computer, which is then recorded). An old-generation instance fails on its fence.
- Consume: one CAS on generation, epoch, state, provider, nonce hash and an unexpired deadline clears the nonce and
  records the verified instance and volume. Then `controlKey` (32 bytes) and GW-1 `POST /internal/aws/tunnels`.
- Not wired yet: the EC2 describe needs the app's AWS caller (Vercel OIDC) and `@aws-sdk/client-ec2`. Until then
  `awsEnrollmentDescriber()` returns null and the endpoint answers 503 `enroll_unavailable`, consuming nothing.
- Host gap: `lease.py` requires `volumeId` in the user data, but a provision's volume does not exist when its intent is
  built. The app omits it on a provision (`provision: true`); the host must resolve the single attached data volume in
  that case (host-agent follow-up).


### C-7 Migration fence and export rules

- The Cloudflare checkpoint protocol gains a terminal `migrated` head, written by
  compare-and-swap. Every later Cloudflare flush refuses to replace it.
- Garbage collection is suspended for the migrating prefix during export.
- Oversized workspaces or system deltas, beyond the checkpoint caps, are **refused**, never
  truncated.

**Final-stop policy for the Cloudflare system layer** (`classifyFinalSystemCheckpoint`, worker)
- `stale` and `not_restored` are permanent for that container: idle-stop and teardown (user,
  reaper, computer delete) proceed on the last committed layer and record
  `systemChangesNotSaved` (teardown report, `persistenceHealth()` RPC, boot log).
- `busy` and `failed` block for at most 3 retries (1, 3, 5 min) or 15 minutes from the first
  result, whichever comes first; then the stop proceeds and records the same signal.

**Rollback from AWS to Cloudflare is refused when it would lose data.** That covers:
- state beyond the checkpoint caps
- files outside the system-delta roots, such as service data under `/var/lib`
- browser profiles

The operator sees the exact list. AWS-only state is never silently dropped.

### 3a. Host-agent safety rules (must hold before any user runs on a host)

The guest's root user controls every byte of the data volume. The host agent treats the
volume as hostile input.

1. **Host operations on volume content.** Rebase, clearing `/tmp` and `/run`, and the
   Chrome `Singleton*` cleanup must either run inside the container, or use no-follow,
   type-checked, `openat`-relative operations (`O_NOFOLLOW`, `S_ISREG`). A symlink or device
   node in the upper must never redirect a host write.
2. **Mount options.** The data volume, and every bind from it, is mounted `nosuid,nodev`
   (and `noexec` where the layout allows).
3. **Container confinement.**
   - A seccomp profile that blocks nested user namespaces and mount.
   - An AppArmor profile.
   - `noNewPrivileges`.
   - A pids limit.
   - Read-only `hosts`, `hostname` and `resolv.conf` binds.
   - Separate tmpfs for `/tmp` and `/run`.
4. **User namespaces.** Decide on them before the first user. Adding id-shifting later
   means rewriting every existing upper.
5. **Rebase.** User files whose paths collide with new image files under `/usr/local` or
   `/opt` are moved aside, never deleted. Every rebase rule has a test that fails without
   it.
6. **Tests.** Assert where the upper is mounted from (the data device), and that the marker
   guard is durable (fsync).
7. **Overlay `nodev`.** The merged overlay mount is itself `nodev`. Otherwise a device node
   the guest created in the upper is usable through the merged path on the host.
8. **Rebase failure.** Any non-zero rebase exit restores the pre-rebase snapshot. The rebase
   tolerates a planted `/.ezil-rebase-preserved` and very deep trees without aborting part
   way.
9. **Profiles.** Profiles mount `noexec`. Re-test code-server extensions that ship native
   binaries, and relax this only for the extensions directory if needed.
10. **Seccomp and AppArmor.** The spike's denylist seccomp profile and docker-default
    AppArmor are placeholders. Production uses an allowlist profile and a dedicated AppArmor
    profile.

## 4. Caps and cost controls

| Control | Value / rule |
|---|---|
| Placement reads | `EZIL_COMPUTE_PLACEMENT_READS=1` turns on per-computer placement reads. It is **one-way**: once on (or once AWS has been enabled) it must never be turned off, or computers on EBS would start on Cloudflare. Absent means no placement statements at all |
| AWS enable | `EZIL_AWS_COMPUTERS_ENABLED=1` gates AWS admission and the AWS provider, and implies placement reads. Absent means an `aws-ec2` computer refuses (`aws_disabled`); it never falls back to Cloudflare |
| AWS preference and cohort | With AWS enabled, an unset `EZIL_AWS_CANARY_USER_IDS` means all new builders; an explicit comma-separated UUID list or `*` remains an intentional rollout gate. `EZIL_AWS_CANARY_SINCE` must be a valid timestamp with a zone. Existing pins always win. Unplaced pre-cutoff computers stay Cloudflare to protect possible old data; post-cutoff computers prefer AWS. Missing/invalid config or placement reads/writer refuse startup rather than creating an unsafe unpinned computer. No hosted flags are changed by the local implementation. |
| Founder requirement | `1ae9b1fd-880b-42ac-aebe-433b3c0ba11f` is always AWS-required for new computers. `EZIL_AWS_REQUIRED_USER_IDS` adds requirements but cannot remove the founder. Malformed additions refuse unplaced starts. Existing Cloudflare pins retain their data and provider; migration is separate. |
| Builder fallback | Only explicit admission refusals for capacity, one-AWS-computer limit, hour/egress caps or kill switch permit Cloudflare fallback. Every simultaneous refusal must be allowed; config, database, ownership and integrity failures never fall back. New fallback pins record their cause in existing placement metadata. A race won by another placement reuses that winner; it does not overwrite the pin. |
| Settings provider | Authenticated `computer.computePlacement({id})` checks the live computer owner and recorded placement owner; it returns actual provider, region, state, fallback flag and AWS requirement. No admission/start/pin occurs. Missing placement is Unplaced; disabled reads/errors are unavailable. Historical CF pins are labeled Existing placement, not assigned an invented fallback cause. |
| Browser zone | `EZIL_AWS_BROWSER_ZONE`: the zone the Worker serves AWS browser hosts on (`aws-<port>-<sandboxId>-aws.<zone>`, e.g. `ezil.org`); lower-case DNS name, at least two labels, no trailing dot. Enrollment returns it with the routable sandbox id (`guac-<user>-<computer>`) and the host's edge trusts `x-forwarded-host` only for those hosts. Unset or malformed: enrollment answers 503 `enroll_unavailable` before the nonce is touched. It is also the ONLY zone the app's AWS preview handoff accepts (never derived from the Worker's host name: staging `api-desktop-staging.ezil.work` → `ezil.work`, production `api-desktop.ezil.org` → `ezil.org`), and the frame confirmation accepts AWS hosts on it; unset or malformed, every AWS preview answers `aws_preview_unavailable` |
| Running computers | `AWS_MAX_RUNNING`; pilot value 2 (all regions together) |
| Running per region | `EZIL_AWS_MAX_RUNNING_<REGION>` (e.g. `_AP_SOUTH_1`) for each region in `AWS_REGIONS`; required, no default. Set it from the region's **verified** Running On-Demand Standard vCPU quota minus every other workload in that quota, divided by 2 vCPU. Admission counts running-class rows per region under the admission lock. A region with no rows counts 0, and a running row without a region counts against every region |
| Region deployments | `EZIL_AWS_LIFECYCLE_DEPLOYMENTS`: JSON keyed by region, each the lifecycle stack's deployment record (`stateMachineVersionArn` pinned to a version). A configured region without one disables AWS |
| Computers per user | 1 |
| Instance-hours | monthly aggregate cap, including idle running and pool hours; per-user cap |
| Egress | monthly GB caps per user and aggregate, to be measured outside the guest (CloudWatch `NetworkOut`). **Not enforced yet:** nothing writes `egress_bytes`, so these caps never bind (C-2) |
| Storage | volume size allowlist; growth capped |
| Cap configuration | `EZIL_AWS_{USER,GLOBAL}_MONTHLY_HOURS`, `EZIL_AWS_{USER,GLOBAL}_MONTHLY_EGRESS_GB`; strict integers, no defaults, malformed or absent disables admission. Pilot: global hours 600 |
| Kill switch | `EZIL_AWS_KILL_SWITCH=1`: admission off → recovery workflow disabled → graceful stop of every instance → deny-start policy attached; no volume deleted |

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
  It holds no AWS keys (details below).
- **Purge** is an operator role behind MFA, outside the boundary, and audited.
- The account root user is never used for deploys.

### App caller (Vercel OIDC, no stored keys)

The app calls AWS only through `app/src/server/lib/compute/aws-clients.ts`:

- **Token.** Every call uses the Vercel OIDC token of the current request. The
  token is read in this order:
  1. the request context's `x-vercel-oidc-token`;
  2. else the file in `VERCEL_OIDC_TOKEN_FILE`;
  3. else `VERCEL_OIDC_TOKEN`.

  The token is never cached. Vercel function tokens for preview/production last
  two hours.
- **Exchange.** The token goes to STS `AssumeRoleWithWebIdentity` on the region's
  app-caller role (`EZIL_AWS_APP_CALLER_ROLE_ARN_<REGION>`). The resulting
  credentials are cached until 5 minutes before they expire.
- **No ambient credentials.** Every SDK client gets an explicit credentials
  function. The default chain (env keys, shared files, instance metadata) is
  never used. A missing token is `aws_caller_unavailable`.
- **Gating.** With `EZIL_AWS_COMPUTERS_ENABLED` off, nothing is built. With it
  on, every region in `AWS_REGIONS` must have its own role, or no client is
  built at all:
  - `ensure`/`stop` then refuse before any write (`aws_lifecycle_unconfigured`);
  - enrollment answers 503.
- **What the role can do** (`infra/app-computers/lib/app-caller.ts`, exact-spec
  tested):
  - `states:StartExecution` on the stack's exact lifecycle version ARN(s) in its
    region;
  - `states:DescribeExecution` on `execution:<machine>:computer-*` only;
  - `ec2:DescribeInstances`, `DescribeVolumes` and `DescribeAvailabilityZones`
    with `aws:RequestedRegion` = that region.
- **Calls are pinned.** A call is refused before it is sent if its ARN names
  another region, or an account other than the caller role's.
- **Errors** map to these codes:

  | Code | Retryable | Meaning |
  |---|---|---|
  | `aws_throttled` | yes | throttling |
  | `aws_capacity` | no | capacity or quota |
  | `aws_config` | no | denied, wrong ARN or setting |
  | `aws_caller_unavailable` | no | caller unavailable |
  | `aws_error` | no | anything else |

  AWS messages are never carried.
- **Trust.** It comes from Vercel's documented token shape: issuer
  `oidc.vercel.com/<team>` (team issuer mode), audience `https://vercel.com/<team>`,
  subject `owner:<team>:project:<project>:environment:production`.
  - Each role trusts ONE exact subject.
  - `development` tokens are refused.
  - Preview never gets the production role, because preview shares the
    production database.

**Founder setup per region** (CI cannot do this: the boundary denies identity-provider writes):
1. Vercel project → Settings → Security → Secure backend access with OIDC federation → enable it, issuer mode **Team**.
2. AWS IAM → Identity providers → add OpenID Connect:
   - provider URL `https://oidc.vercel.com/<team-slug>`
   - audience `https://vercel.com/<team-slug>`

   This is done once per account.
3. Lifecycle config `appCaller`: `enabled: true`, plus a `vercel` provider with that
   provider ARN and the production subject. Deploy the lifecycle stack, then copy
   its `AppCaller/RoleArn` output.
4. Vercel production env:
   - `EZIL_AWS_APP_CALLER_ROLE_ARN_<REGION>` = that ARN, for every region in `AWS_REGIONS`;
   - the matching `EZIL_AWS_LIFECYCLE_DEPLOYMENTS`.

## 6. Retention, cancellation, rollback

- **Undeleted computers retain data.** Inactivity, compute stop, subscription cancellation,
  failed provisioning and placement `RETIRED` state do not authorize purging retained data.
  Cancellation may stop compute; it does not mean the computer was explicitly deleted.
- **Deletion policy is held.** The former 14-day retirement/cancellation eligibility rule
  is removed. `retention.ts` returns no purge candidates, including in dry runs, until
  explicit deletion evidence and a separate post-deletion policy are approved. No purge
  executor is introduced. Releasing a placement proved to have no retained resources
  remains distinct from purging retained data.
- **Storage costs remain bounded and visible.** Existing volume-size, admission and budget
  controls remain; retained disks incur storage charges. DLM may rotate older backups
  under its existing schedule while the computer's data volume remains intact.
- **Migration is deferred.** Existing Cloudflare computers stay pinned and accessible.
  Any future Cloudflare/AWS cutover must verify a complete export before swapping,
  fence concurrent writers and preserve new AWS writes on rollback (C-7). A stop that
  reports `systemChangesNotSaved` cannot serve as a successful migration checkpoint.
- **Local software rollback** retains placement reads, provider pins and data volumes.
  An image change needs a verified snapshot and compatible rebase; never format a
  retained volume or reopen a stale provider copy as a rollback shortcut.

## 7. Acceptance before enabling

**Stage A canary.** Staging evidence is required:
- live access-denied proofs for disallowed type, unencrypted volume, IMDSv1 and retagging
- cross-computer attach: **workflow refusal plus authority callback**, shown live. IAM cannot
  tie a volume's computer to an instance's computer for a shared workflow role, so this is a
  code fence backed by EBS single-attach, not an IAM denial
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
