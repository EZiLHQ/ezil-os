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

import { isPlacementReadEnabled, type Env } from './aws-config';
import { awsEc2StubProvider, createAwsEc2Provider, createAwsEc2StubProvider, type AwsProviderDeps } from './aws-ec2';
import { cloudflareComputeProvider, type CloudflareComputeProvider } from './cloudflare';
import { PlacementOwnerError, readPlacement, type PlacementDb, type PlacementExecutor, type ResolvedPlacement } from './placement';
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

export async function resolveComputeProvider(
    db: PlacementExecutor,
    computer: ComputerRef,
    env: Env = process.env,
    aws: Omit<AwsProviderDeps, 'db' | 'env'> = {},
): Promise<ComputeProvider> {
    if (!isPlacementReadEnabled(env)) return cloudflareComputeProvider;
    const placement = await readPlacement(db, computer.computerId);
    // Every provider operation is the recorded owner's only (C-2): `computer.userId` is the
    // authenticated session user; a re-keyed or re-inserted ezil_computers row changes nothing.
    if (placement.record && placement.record.ownerUserId !== computer.userId.toLowerCase()) {
        throw new PlacementOwnerError(placement.record.computerId);
    }
    return providerForPlacement(placement, env, isPlacementDb(db) ? { ...aws, db, env: () => env } : undefined);
}
