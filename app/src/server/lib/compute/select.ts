/**
 * Resolve a computer's persisted provider without moving its data.
 * Existing pins always win. New starts require placement reads and a safe
 * creation cutoff; AWS is preferred within the configured rollout gates.
 * The founder must use AWS for new computers, while other builders can be
 * pinned to Cloudflare only for explicit capacity/usage/kill-switch refusals.
 * Legacy non-start reads retain the flag-off adapter for non-required users.
 */

import { precheckAdmission, type AdmissionRefusal } from './admission';
import { invalidRequiredUserConfig, isAwsRequiredUser, isCloudflareDevAccount, isPlacementReadEnabled, type Env } from './aws-config';
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
     * A pre-cutoff computer or allowed admission fallback is PINNED to Cloudflare first
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
    if (!isPlacementReadEnabled(env)) {
        if (isAwsRequiredUser(env, computer.userId)) throw new AwsRequiredError(computer.computerId, 'placement_reads_disabled');
        // A start without a durable pin can later open an empty disk after rollout.
        if (options.pinCloudflare) throw new AwsPlacementRefusedError('placement_reads_disabled');
        return cloudflareComputeProvider;
    }
    let placement = await readPlacement(db, computer.computerId);
    // Every provider operation is the recorded owner's only (C-2): `computer.userId` is the
    // authenticated session user; a re-keyed or re-inserted ezil_computers row changes nothing.
    assertPlacementOwner(placement, computer);
    const deps = isPlacementDb(db) ? { ...aws, db, env: () => env } : undefined;
    if (!placement.record) {
        if (options.pinCloudflare && invalidRequiredUserConfig(env)) {
            throw new AwsPlacementRefusedError('aws_required_config_invalid');
        }
        // No row and in the canary cohort: the aws-ec2 provider, whose ensure() admits and provisions it.
        const canary = await awsCanaryDecision(db, computer, env);
        if (canary.aws) return providerForPlacement({ provider: 'aws-ec2' }, env, deps);
        // aws-config.ts `CLOUDFLARE_DEV_ACCOUNT_ID`: the one dev account may start its own
        // computer on Cloudflare when AWS did not take it. The canary may have refused before
        // reading the row, so the computer itself is checked first.
        const devAccount = options.pinCloudflare === true && isCloudflareDevAccount(computer.userId);
        if (devAccount) await assertOwnLiveComputer(db, computer);
        if (options.pinCloudflare && canary.reason !== 'created_before_since' && isAwsRequiredUser(env, computer.userId)) {
            // An AWS-required account (aws-config.ts `awsRequiredUserIds`) never has a new
            // computer silently pinned to Cloudflare: nothing is written, nothing starts, and
            // the caller gets the reason the canary or admission refused.
            console.info('[compute.placement] aws_required_refused', { computerId: computer.computerId.toLowerCase(), canary: canary.reason });
            throw new AwsRequiredError(computer.computerId.toLowerCase(), canary.reason);
        }
        if (options.pinCloudflare && !devAccount && canary.reason !== 'created_before_since' && !canary.fallbackAllowed) {
            throw new AwsPlacementRefusedError(canary.reason);
        }
        if (options.pinCloudflare && !isPlacementDb(db)) throw new AwsPlacementRefusedError('placement_writer_unavailable');
        if (options.pinCloudflare && isPlacementDb(db)) {
            const pin = await pinCloudflare(db, computer,
                canary.fallbackAllowed ? canary.reason : devAccount ? `dev_account:${canary.reason}` : undefined);
            placement = pin.placement;
            assertPlacementOwner(placement, computer);
            // The one moment a computer's provider becomes permanent: say why the canary did
            // not claim it. No user id; the computer id is what an operator looks up.
            // Only the request whose insert created the row logs it: a concurrent loser only re-read
            // the winner's row (which may even be another provider's), so it has nothing to explain.
            if (pin.created) console.info('[compute.placement] pinned', { computerId: computer.computerId.toLowerCase(), provider: placement.provider, canary: canary.reason });
        }
    }
    return providerForPlacement(placement, env, deps);
}

/** A startup cannot establish a safe provider; callers surface this as a precondition failure. */
export class AwsPlacementRefusedError extends Error {
    constructor(readonly reason: string) {
        super(`compute_placement_refused:${reason}`);
        this.name = 'AwsPlacementRefusedError';
    }
}

/** A new computer of an AWS-required account that AWS did not admit. `reason` is the canary/admission refusal. */
export class AwsRequiredError extends Error {
    constructor(readonly computerId: string, readonly reason: string) {
        super(`aws_required:${reason}`);
        this.name = 'AwsRequiredError';
    }
}

/** Only the dev account's own, live computer may take the Cloudflare start. */
async function assertOwnLiveComputer(db: PlacementExecutor, computer: ComputerRef): Promise<void> {
    const row = await readCanaryComputer(db, computer.computerId);
    const refusal = row === null ? 'computer_missing'
        : row.deleted ? 'computer_deleted'
            : row.userId !== computer.userId.toLowerCase() ? 'owner_mismatch' : null;
    if (refusal) throw new AwsPlacementRefusedError(refusal);
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
async function pinCloudflare(db: PlacementDb, computer: ComputerRef, fallbackReason?: string): Promise<{ placement: ResolvedPlacement; created: boolean }> {
    const created = await createPlacement(db, {
        computerId: computer.computerId, ownerUserId: computer.userId, provider: 'cloudflare', state: 'STOPPED',
        fields: fallbackReason ? { lastError: `cloudflare_fallback:${fallbackReason}` } : undefined,
    });
    if (created.ok) return { placement: { provider: 'cloudflare', store: created.placement.store, record: created.placement }, created: true };
    const existing = await readPlacement(db, computer.computerId);
    if (!existing.record) throw new PlacementIntegrityError('invalid_row', computer.computerId.toLowerCase());
    return { placement: existing, created: false };
}

/**
 * A computer with no placement row joins AWS only when AWS is on, its user is in
 * `EZIL_AWS_CANARY_USER_IDS` (unset means all builders), and its live row is the caller's and was created at or
 * after `EZIL_AWS_CANARY_SINCE` (aws-config.ts `awsCanaryConfig`). The computer row is
 * read only once the cheap checks pass, so other users cost no query. A failed read throws.
 * `reason` names the first failed condition (placement-explain.ts), or the admission refusal.
 */
async function awsCanaryDecision(db: PlacementExecutor, computer: ComputerRef, env: Env): Promise<{ aws: boolean; reason: string; fallbackAllowed?: boolean }> {
    const userId = computer.userId.toLowerCase();
    const cohort = explainAwsCanaryCohort({ env, userId });
    if (cohort) return { aws: false, reason: cohort.reason };
    const row = await readCanaryComputer(db, computer.computerId);
    const explained = explainAwsCanary({ env, userId, computer: row });
    if (!explained.eligible) return { aws: false, reason: explained.reason };
    // Admission is checked again by ensure under its lock. Only explicit capacity,
    // usage and kill-switch refusals may pin a new builder to Cloudflare.
    const admission = await precheckAdmission(db, { userId, computerId: computer.computerId, env });
    return admission.admit ? { aws: true, reason: 'admitted' } : {
        aws: false,
        reason: `admission_refused:${admission.reason}`,
        // Check ALL reasons: a kill switch must never mask a duplicate/ownership failure.
        fallbackAllowed: admission.reasons.length > 0 && admission.reasons.every((reason) => CLOUDFLARE_FALLBACK_REFUSALS.has(reason)),
    };
}

/** Explicit admission refusals only. Config, ownership and integrity errors never fall back. */
const CLOUDFLARE_FALLBACK_REFUSALS: ReadonlySet<AdmissionRefusal> = new Set([
    'kill_switch', 'max_running', 'user_has_aws_computer', 'user_hours_cap',
    'global_hours_cap', 'user_egress_cap', 'global_egress_cap', 'region_capacity',
]);
