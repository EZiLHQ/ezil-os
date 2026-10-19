/**
 * Choose the `ComputeProvider` for one computer (docs/AWS-COMPUTERS.md C-1,
 * R13: provider is chosen PER COMPUTER, never by a global flip).
 *
 * Two entry points:
 *
 * - `selectComputeProvider(computer)` — synchronous, Cloudflare, no database.
 *   Every existing lifecycle caller uses it, unchanged.
 * - `resolveComputeProvider(db, computer)` — placement-aware. 🔴 With
 *   placement reads off (`EZIL_COMPUTE_PLACEMENT_READS` and
 *   `EZIL_AWS_COMPUTERS_ENABLED` both unset) it returns the Cloudflare adapter
 *   WITHOUT reading the database: the placement table does not exist in
 *   production until the founder registers it (docs/aws-computers/sql), and a
 *   read would fail every Cloudflare computer. With reads on it reads the
 *   placement (no row → Cloudflare) and fails closed on a duplicate or unknown
 *   value. A missing table is NOT treated as "no row". An aws-ec2 row resolves
 *   to the aws-ec2 provider even with the AWS flag off, which REFUSES
 *   (`aws_disabled`) — it never falls back to Cloudflare. Reads are one-way:
 *   see `isPlacementReadEnabled`. A placement whose `owner_user_id` is not
 *   the caller throws `PlacementOwnerError` (→ NOT_FOUND).
 *
 * Callers move from the first to the second in the caller-wiring PR (P3),
 * after the SQL is applied; that PR also narrows the callers to
 * `ComputeProvider`'s result types.
 */

import { precheckAdmission } from './admission';
import { awsCanaryConfig, inAwsCanary, isAwsComputersEnabled, isPlacementReadEnabled, type Env } from './aws-config';
import { awsEc2StubProvider, createAwsEc2Provider, createAwsEc2StubProvider, type AwsProviderDeps } from './aws-ec2';
import { cloudflareComputeProvider, type CloudflareComputeProvider } from './cloudflare';
import { createPlacement, PlacementIntegrityError, PlacementOwnerError, readCanaryComputer, readPlacement, type PlacementDb, type PlacementExecutor, type ResolvedPlacement } from './placement';
import type { ComputeProvider, ComputerRef } from './provider';
import { plusPlanIds, tierForEntitlement, type EntitlementRecord } from './tier';

export function selectComputeProvider(computer: ComputerRef): CloudflareComputeProvider {
    void computer; // Placement-aware callers use `resolveComputeProvider`.
    return cloudflareComputeProvider;
}

/**
 * Placement → adapter. Exhaustive: an unknown provider is a type error here and a fail-closed read upstream.
 * With a transactional database the aws-ec2 adapter is the real provider (`aws` supplies its
 * lifecycle starter, tier source and enrollment issuer; without them it refuses before any write).
 * Without one it is the stub. Either way, with the AWS flag off it REFUSES (aws_disabled); never Cloudflare.
 */
export function providerForPlacement(
    placement: Pick<ResolvedPlacement, 'provider'>,
    env?: Env,
    aws?: AwsProviderDeps,
): ComputeProvider {
    switch (placement.provider) {
        case 'cloudflare':
            return cloudflareComputeProvider;
        case 'aws-ec2':
            if (aws) return createAwsEc2Provider({ ...aws, env: aws.env ?? (env ? () => env : undefined) });
            return env ? createAwsEc2StubProvider(() => env) : awsEc2StubProvider;
        default: {
            const unknown: never = placement.provider;
            throw new Error(`unknown provider: ${String(unknown)}`);
        }
    }
}

function isPlacementDb(db: PlacementExecutor): db is PlacementDb {
    return typeof (db as Partial<PlacementDb>).transaction === 'function';
}

export interface ResolveOptions {
    /** Resolved once by the caller and shared with the AWS provision path. */
    entitlement?: EntitlementRecord | null;
    /**
     * The caller is about to START a sandbox (open, app/code preview, desktop restart).
     * A no-row computer neither billing nor the canary claims is PINNED to Cloudflare first
     * (`pinCloudflare`), so it can never later be reassigned to AWS. Reads and stops
     * never pin: a computer that never ran stays eligible.
     */
    pinCloudflare?: boolean;
}

export async function resolveComputeProvider(
    db: PlacementExecutor,
    computer: ComputerRef,
    env: Env = process.env,
    aws: Omit<AwsProviderDeps, 'db' | 'env'> = {},
    options: ResolveOptions = {},
): Promise<ComputeProvider> {
    if (!isPlacementReadEnabled(env)) return cloudflareComputeProvider;
    let placement = await readPlacement(db, computer.computerId);
    // Every provider operation is the recorded owner's only (C-2): `computer.userId` is the
    // authenticated session user; a re-keyed or re-inserted ezil_computers row changes nothing.
    assertPlacementOwner(placement, computer);
    const entitlement = options.entitlement !== undefined ? options.entitlement : aws.entitlement;
    const deps = isPlacementDb(db) ? { ...aws, entitlement, db, env: () => env } : undefined;
    if (!placement.record) {
        // Paid placement bypasses the canary's graceful capacity fallback. ensure()
        // admits the entitled size or refuses; it never pins a paid computer to R2.
        if (isAwsComputersEnabled(env) && entitlement?.source === 'billing_v2'
            && tierForEntitlement(entitlement, plusPlanIds(env)) !== 'free') {
            return providerForPlacement({ provider: 'aws-ec2' }, env, deps);
        }
        // No row and in the canary cohort: the aws-ec2 provider, whose ensure() admits and provisions it.
        if (await isAwsCanary(db, computer, env)) return providerForPlacement({ provider: 'aws-ec2' }, env, deps);
        if (options.pinCloudflare && isPlacementDb(db)) {
            placement = await pinCloudflare(db, computer);
            assertPlacementOwner(placement, computer);
        }
    }
    return providerForPlacement(placement, env, deps);
}

function assertPlacementOwner(placement: ResolvedPlacement, computer: ComputerRef): void {
    if (placement.record && placement.record.ownerUserId !== computer.userId.toLowerCase()) {
        throw new PlacementOwnerError(placement.record.computerId);
    }
}

/**
 * 🔴 A computer that runs on Cloudflare keeps its workspace in R2. Without a row it has
 * no recorded provider, so enabling the canary (or adding its user) later would send it
 * to AWS and an EMPTY EBS volume — the R2 workspace would look lost. The first sandbox
 * start therefore records a `cloudflare` row, through the single writer under the
 * per-computer lock, BEFORE the sandbox starts. Its state is not tracked (Cloudflare's
 * lifecycle lives in the Worker); STOPPED keeps it out of every running-class count.
 * A concurrent writer's row wins (`placement_exists` → re-read), whatever its provider.
 */
async function pinCloudflare(db: PlacementDb, computer: ComputerRef): Promise<ResolvedPlacement> {
    const created = await createPlacement(db, {
        computerId: computer.computerId, ownerUserId: computer.userId, provider: 'cloudflare', state: 'STOPPED',
    });
    if (created.ok) return { provider: 'cloudflare', store: created.placement.store, record: created.placement };
    const existing = await readPlacement(db, computer.computerId);
    if (!existing.record) throw new PlacementIntegrityError('invalid_row', computer.computerId.toLowerCase());
    return existing;
}

/**
 * A computer with no placement row joins AWS only when AWS is on, its user is in
 * `EZIL_AWS_CANARY_USER_IDS`, and its live row is the caller's and was created at or
 * after `EZIL_AWS_CANARY_SINCE` (aws-config.ts `awsCanaryConfig`). The computer row is
 * read only once the cheap checks pass, so other users cost no query. A failed read throws.
 */
async function isAwsCanary(db: PlacementExecutor, computer: ComputerRef, env: Env): Promise<boolean> {
    if (!isAwsComputersEnabled(env)) return false;
    const canary = awsCanaryConfig(env);
    const userId = computer.userId.toLowerCase();
    if (!canary || !inAwsCanary(canary, userId)) return false;
    const row = await readCanaryComputer(db, computer.computerId);
    if (row === null || row.deleted || row.userId !== userId || row.createdAt.getTime() < canary.since.getTime()) return false;
    // Graceful fallback: AWS only when admission would admit it now (capacity, one AWS
    // computer per user, monthly caps, kill switch). Otherwise it stays Cloudflare and is
    // pinned there on its first sandbox start, so no one gets a computer that cannot start.
    return (await precheckAdmission(db, { userId, computerId: computer.computerId, env })).admit;
}
