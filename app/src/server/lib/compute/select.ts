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
 *   see `isPlacementReadEnabled`.
 *
 * Callers move from the first to the second in the caller-wiring PR (P3),
 * after the SQL is applied; that PR also narrows the callers to
 * `ComputeProvider`'s result types.
 */

import { isPlacementReadEnabled, type Env } from './aws-config';
import { awsEc2StubProvider, createAwsEc2StubProvider } from './aws-ec2';
import { cloudflareComputeProvider, type CloudflareComputeProvider } from './cloudflare';
import { readPlacement, type PlacementExecutor, type ResolvedPlacement } from './placement';
import type { ComputeProvider, ComputerRef } from './provider';

export function selectComputeProvider(computer: ComputerRef): CloudflareComputeProvider {
    void computer; // Placement-aware callers use `resolveComputeProvider`.
    return cloudflareComputeProvider;
}

/** Placement → adapter. Exhaustive: an unknown provider is a type error here and a fail-closed read upstream. */
export function providerForPlacement(placement: Pick<ResolvedPlacement, 'provider'>, env?: Env): ComputeProvider {
    switch (placement.provider) {
        case 'cloudflare':
            return cloudflareComputeProvider;
        case 'aws-ec2':
            // With the AWS flag off this provider REFUSES (aws_disabled); never Cloudflare.
            return env ? createAwsEc2StubProvider(() => env) : awsEc2StubProvider;
        default: {
            const unknown: never = placement.provider;
            throw new Error(`unknown provider: ${String(unknown)}`);
        }
    }
}

export async function resolveComputeProvider(
    db: PlacementExecutor,
    computer: ComputerRef,
    env: Env = process.env,
): Promise<ComputeProvider> {
    if (!isPlacementReadEnabled(env)) return cloudflareComputeProvider;
    return providerForPlacement(await readPlacement(db, computer.computerId), env);
}
