/**
 * Choose the `ComputeProvider` for one computer (docs/AWS-COMPUTERS.md C-1,
 * R13: provider is chosen PER COMPUTER, never by a global flip).
 *
 * Two entry points:
 *
 * - `selectComputeProvider(computer)` — synchronous, Cloudflare, no database.
 *   Every existing lifecycle caller uses it, unchanged.
 * - `resolveComputeProvider(db, computer)` — placement-aware. 🔴 With
 *   `EZIL_AWS_COMPUTERS_ENABLED` unset it returns the Cloudflare adapter
 *   WITHOUT reading the database: `ezil_computer_placements` does not exist in
 *   production until the founder registers it (docs/aws-computers/sql), and a
 *   read would fail every Cloudflare computer. With the flag on it reads the
 *   placement (no row → Cloudflare) and fails closed on a duplicate or unknown
 *   value. A missing table is NOT treated as "no row".
 *
 * Callers move from the first to the second in the caller-wiring PR (P3),
 * after the SQL is applied; that PR also narrows the callers to
 * `ComputeProvider`'s result types.
 */

import { isAwsComputersEnabled, type Env } from './aws-config';
import { awsEc2StubProvider } from './aws-ec2';
import { cloudflareComputeProvider, type CloudflareComputeProvider } from './cloudflare';
import { readPlacement, type PlacementExecutor, type ResolvedPlacement } from './placement';
import type { ComputeProvider, ComputerRef } from './provider';

export function selectComputeProvider(computer: ComputerRef): CloudflareComputeProvider {
    void computer; // Placement-aware callers use `resolveComputeProvider`.
    return cloudflareComputeProvider;
}

/** Placement → adapter. Exhaustive: an unknown provider is a type error here and a fail-closed read upstream. */
export function providerForPlacement(placement: Pick<ResolvedPlacement, 'provider'>): ComputeProvider {
    switch (placement.provider) {
        case 'cloudflare':
            return cloudflareComputeProvider;
        case 'aws-ec2':
            return awsEc2StubProvider;
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
    if (!isAwsComputersEnabled(env)) return cloudflareComputeProvider;
    return providerForPlacement(await readPlacement(db, computer.computerId));
}
