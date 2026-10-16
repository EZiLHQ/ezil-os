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
import { isAwsRequiredUser, isPlacementReadEnabled, type Env } from './aws-config';
import { awsEc2StubProvider, createAwsEc2Provider, createAwsEc2StubProvider, type AwsProviderDeps } from './aws-ec2';
import { cloudflareComputeProvider, type CloudflareComputeProvider } from './cloudflare';
import { explainAwsCanary, explainAwsCanaryCohort } from './placement-explain';
import { createPlacement, PlacementIntegrityError, PlacementOwnerError, readCanaryComputer, readPlacement, type PlacementDb, type PlacementExecutor, type ResolvedPlacement } from './placement';
import type { ComputeProvider, ComputerRef } from './provider';

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
    /**
     * The caller is about to START a sandbox (open, app/code preview, desktop restart).
     * A no-row computer the canary does not claim is then PINNED to Cloudflare first
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
    const deps = isPlacementDb(db) ? { ...aws, db, env: () => env } : undefined;
    if (!placement.record) {
        // No row and in the canary cohort: the aws-ec2 provider, whose ensure() admits and provisions it.
        const canary = await awsCanaryDecision(db, computer, env);
        if (canary.aws) return providerForPlacement({ provider: 'aws-ec2' }, env, deps);
        if (options.pinCloudflare && canary.reason !== 'created_before_since' && isAwsRequiredUser(env, computer.userId)) {
            // An AWS-required account (aws-config.ts `awsRequiredUserIds`) never has a new
            // computer silently pinned to Cloudflare: nothing is written, nothing starts, and
            // the caller gets the reason the canary or admission refused.
            console.info('[compute.placement] aws_required_refused', { computerId: computer.computerId.toLowerCase(), canary: canary.reason });
            throw new AwsRequiredError(computer.computerId.toLowerCase(), canary.reason);
        }
        if (options.pinCloudflare && isPlacementDb(db)) {
            placement = await pinCloudflare(db, computer);
            assertPlacementOwner(placement, computer);
            // The one moment a computer's provider becomes permanent: say why the canary did
            // not claim it. No user id; the computer id is what an operator looks up.
            console.info('[compute.placement] pinned', { computerId: computer.computerId.toLowerCase(), provider: placement.provider, canary: canary.reason });
        }
    }
    return providerForPlacement(placement, env, deps);
}

/** A new computer of an AWS-required account that AWS did not admit. `reason` is the canary/admission refusal. */
export class AwsRequiredError extends Error {
    constructor(readonly computerId: string, readonly reason: string) {
        super(`aws_required:${reason}`);
        this.name = 'AwsRequiredError';
    }
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
 * `reason` names the first failed condition (placement-explain.ts), or the admission refusal.
 */
async function awsCanaryDecision(db: PlacementExecutor, computer: ComputerRef, env: Env): Promise<{ aws: boolean; reason: string }> {
    const userId = computer.userId.toLowerCase();
    const cohort = explainAwsCanaryCohort({ env, userId });
    if (cohort) return { aws: false, reason: cohort.reason };
    const row = await readCanaryComputer(db, computer.computerId);
    const explained = explainAwsCanary({ env, userId, computer: row });
    if (!explained.eligible) return { aws: false, reason: explained.reason };
    // Graceful fallback: AWS only when admission would admit it now (capacity, one AWS
    // computer per user, monthly caps, kill switch). Otherwise it stays Cloudflare and is
    // pinned there on its first sandbox start, so no one gets a computer that cannot start.
    const admission = await precheckAdmission(db, { userId, computerId: computer.computerId, env });
    return admission.admit ? { aws: true, reason: 'admitted' } : { aws: false, reason: `admission_refused:${admission.reason}` };
}
