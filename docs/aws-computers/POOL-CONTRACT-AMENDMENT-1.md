# Warm pool contract v1, amendment 1 (2026-10-23)

This amends `POOL-CONTRACT.md`; everything not changed here still applies.

Founder direction, 2026-10-23: paid AWS computers must open **instantly** from a warm EC2 pool. Taking a host immediately boots a replacement. Pool size scales up and down with Standard and Premium customers and their actual usage, bounded by cost. A cold boot, measured at 210–250 s on 1.0.6 staging, is a fallback only.

## P1. One pool host class
- Standard and Premium both adopt an `m6i.large` (2 vCPU / 8 GB) pool host.
- Premium larger sizes (xlarge / 2xlarge) are a resize: a cold path with a restart. No pool for them in v1.
- `POOL_POLICY` (in code, no new env vars):
  - ap-south-1 `m6i.large`: `minSpares=1`, `maxSpares=4`;
  - every other class/region: 0.
- Infra pool intents keep rejecting 2xlarge. The app and IAM allowlists for **pool** operations are exactly the infra set.

## P2. Demand-sized target, replacing the original target rule
Per `(region, zoneId, instanceType)`, each pass computes:
```
recent  = ceil(opens15m * bootMinutes / 15)          # opens = distinct successful paid opens (pool or cold), not polls/retries
base    = ceil(0.04 * activeStandard + 0.10 * activePremium)   # effective paid subscribers whose computer class maps here
target  = clamp(minSpares, maxSpares, max(recent, base) + minSpares)
target  = 0 if EZIL_AWS_KILL_SWITCH == "1"            # the kill switch drains the pool
target  = min(target, floor((regionVcpuCap - vcpuInUseIncludingSpares) / vcpuPerHost) + currentSpares)
```
- `bootMinutes` is the measured p90 pool boot-to-ready time over the last 24 h, defaulting to 4 when unknown.
- `booting` and `ready` hosts both count as spares.
- **Scale up:** at most 2 provisions per pass, globally per invocation.
- **Scale down:** retire `ready` spares above target that have been idle (no lease) for more than 30 min, newest first, at most 2 per pass. When the kill switch is on, also retire immediately, ignoring the 30-min rule.
- **Failures:** `booting` for more than 10 min moves to `failed` and is retired.
- Overlapping passes are excluded by an advisory lock.
- Every pass logs `{target, recent, base, spares, provisioned, retired}`.

## P3. Billing
- The tenant epoch starts when the claim completes: the user disk is mounted and the session is ready on the adopted host.
- Spare idle time and boot time are platform overhead. They are recorded, never billed.

## P4. Session end with pool mode on
- Every AWS session end issues **`release`**: user stop, lease/cap expiry, billing stop, guest shutdown. This applies to adopted hosts and cold-fallback hosts alike.
- `release` is a normal shutdown with flush, then stopped, then detach without force, then terminate. The volume is kept.
- At rest, a paid computer's volume is therefore `available`, so any reopen can adopt.
- Adopted hosts never enter start-in-place.
- With pool mode off, the existing `replace`/`start` behavior is unchanged.

## P5. Retiring unclaimed spares
New lifecycle intent **`pool-retire`**: `{region, zoneId, poolHostId, poolGeneration, instanceId}`.
- It terminates a pool-tagged, root-only host that was never claimed: `ezil:pool=1`, no data volume attached, no `ezil:computer` tag.
- IAM: TerminateInstances is conditioned on `aws:ResourceTag/ezil:pool=1`, plus the namespace and the type allowlist.
- It refuses any host carrying `ezil:computer` or any non-root attachment.

## P6. Claim, enrollment and the desktop
- **Claim response:**
  - payload `{computerId, generation, leaseEpoch, fence, volumeSerial, enrollNonce}`;
  - `enrollNonce` is a one-time nonce bound to the computer epoch, reusing the existing enroll-nonce mechanism and freshness;
  - it is returned only after the adopt execution has SUCCEEDED and the volume is attached.
- **On claim, the host:**
  1. refuses a fence or epoch mismatch;
  2. mounts the volume by EBS serial;
  3. runs the existing computer-epoch enrollment with `enrollNonce`;
  4. restarts the desktop once, with the user's home on that disk and the relay config, so the first user session is never restarted under the user (fixes FIRSTOPEN).
- **Pool ready** = enrolled as a pool host less than 10 min ago, desktop stack pre-started (image loaded, containers warm), editor health OK.
- **Target:** claim to the user's session ready in 30 s or less (p90).

## P7. Priority
- `leasePoolHost` orders by `pool_priority DESC, ready_at ASC`, where Premium = 2 and Standard = 1.
- There is no request queue in v1. Priority is best effort among simultaneous lease transactions.
- After every lease, the replenish planner runs immediately, in the same request after commit.

## P8. Pinned app interfaces
Lanes code against these signatures. The app-data lane implements them in `ready-pool.ts`.
```ts
export type PoolClass = { region: string; zoneId: string; instanceType: 'm6i.large' };
export type PoolHostState = 'booting' | 'ready' | 'leased' | 'retiring' | 'retired' | 'failed';
export interface PoolHostRow { poolHostId: string; poolGeneration: number; region: string; zoneId: string; instanceType: string;
  instanceId: string | null; state: PoolHostState; readyAt: Date | null; enrolledAt: Date | null; leasedComputerId: string | null;
  leasedAt: Date | null; claimGeneration: number | null; claimLeaseEpoch: number | null; claimFence: string | null; claimVolumeSerial: string | null; }
export function leasePoolHost(tx: PlacementExecutor, c: PoolClass, computerId: string, priority: 1 | 2, now: Date): Promise<PoolHostRow | null>;
export function recordPoolEnrollment(db: PlacementExecutor, poolHostId: string, instanceId: string, now: Date): Promise<PoolHostRow>;
export function recordPoolReady(db: PlacementExecutor, poolHostId: string, health: { editorOk: boolean }, now: Date): Promise<PoolHostRow>;
export function publishPoolClaim(db: PlacementExecutor, poolHostId: string, claim: { computerId: string; generation: number; leaseEpoch: number; fence: string; volumeSerial: string }, now: Date): Promise<PoolHostRow>;
export function readPoolClaim(db: PlacementExecutor, poolHostId: string, instanceId: string): Promise<PoolHostRow | null>;  // null until a claim is published
export function markPoolHost(db: PlacementExecutor, poolHostId: string, from: PoolHostState[], to: PoolHostState, now: Date): Promise<PoolHostRow | null>;
export interface PoolDemand { opens15m: number; activeStandard: number; activePremium: number; bootMinutes: number | null;
  spares: number; vcpuInUse: number; regionVcpuCap: number; killSwitch: boolean; idleReady: { poolHostId: string; readyAt: Date }[]; booting: { poolHostId: string; createdAt: Date }[] }
export function planPool(c: PoolClass, d: PoolDemand, now: Date): { target: number; provision: number; retire: string[]; fail: string[] };
export function readPoolDemand(db: PlacementExecutor, c: PoolClass, now: Date): Promise<PoolDemand>;
export const POOL_POLICY: Record<string, { minSpares: number; maxSpares: number }>;  // key `${region}:${instanceType}`
```

## P9. Schema
- Additive SQL `docs/aws-computers/sql/0003_pool_hosts_v2.sql.txt` adds the P8 columns, states and indexes. It must be idempotent, with RLS unchanged and service-only access.
- It is registered in `app/scripts/billing-staging-schema.mjs`. The staging applier is the existing schema path.
- It is never applied to production.
