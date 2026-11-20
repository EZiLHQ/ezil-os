import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/server/db';
import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { isAwsComputersEnabled, type Env } from '@/server/lib/compute/aws-config';
import { PlacementOwnerError, readPlacement } from '@/server/lib/compute/placement';
import type { PreviewTokenV2Claims } from '@/server/lib/compute/preview-token-v2';

export type CloudflareBrowserTarget = { sandboxId: string; binding: string };
export type AwsBrowserTarget = { sandboxId: string; binding: string; provider: 'aws-ec2'; generation: number; leaseEpoch: number };
const COMPUTER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function resolveCloudflareBrowserTarget(
    { userId, clientId }: { userId: string; clientId: string },
    computerId: string,
    purpose: 'ezil-browser-observe-v1' | 'ezil-browser-open-url-v1',
): Promise<{ sandboxId: string; binding: string } | null> {
    try {
        const owned = await db.execute<{ owned: number }>(sql`/* browser:owned-now */
            SELECT 1 AS owned FROM public.ezil_computers
            WHERE id = ${computerId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
            LIMIT 2`);
        if (owned.length !== 1 || owned[0]?.owned !== 1) return null;

        const { record } = await readPlacement(db, computerId, userId);
        // Cloudflare uses the Worker container and migration fence to establish live readiness.
        // Cloudflare rows are written at generation 1 / epoch 0 (`pinCloudflarePlacement`); legacy rows are 0/0.
        // Any other generation or a leased epoch means a move or an AWS-style lease.
        if (!record || record.provider !== 'cloudflare' || record.leaseEpoch !== 0 || (record.generation !== 0 && record.generation !== 1)
            || (record.state !== 'STOPPED' && record.state !== 'RUNNING')) return null;

        const sandboxId = deriveGuacamoleSandboxId(userId, computerId);
        const binding = createHash('sha256').update(JSON.stringify([
            purpose, userId, clientId, computerId, sandboxId, record.updatedAt.toISOString(),
        ])).digest('hex');
        return { sandboxId, binding };
    } catch (error) {
        if (error instanceof PlacementOwnerError) return null;
        throw error;
    }
}

/** True only for a well-formed provider-qualified list (the Worker's) that names `aws-ec2:<computerId>`. */
export function awsBrowserTargetAdmitted(raw: string | undefined, computerId: string): boolean {
    if (!raw || !COMPUTER_ID.test(computerId)) return false;
    const targets = raw.split(',').map(entry => entry.trim());
    return targets.every(entry => {
        const [kind, id, extra] = entry.split(':');
        return extra === undefined && (kind === 'cloudflare' || kind === 'aws-ec2') && COMPUTER_ID.test(id ?? '');
    }) && targets.includes('aws-ec2:' + computerId);
}

/**
 * Stage-only AWS leg of the observer: an explicitly admitted computer, owned now, whose placement is
 * RUNNING on a still-current lease (`leaseUntil` after now, the same rule as aws-receipts.ts
 * `sessionLimitFor`). The binding covers provider, generation, lease epoch and the exact instance and
 * tunnel, never `updatedAt`: the owner's presence renews `leaseUntil`/`presenceAt` (placement.ts
 * `renewPlacementLease`) without moving any of them, so a renewal keeps a session and a replacement
 * or expiry refuses it.
 */
export async function resolveAwsBrowserTarget(
    { userId, clientId }: { userId: string; clientId: string },
    computerId: string,
    purpose: 'ezil-browser-observe-v1',
    env: Env = process.env,
    now: () => Date = () => new Date(),
): Promise<AwsBrowserTarget | null> {
    if (!awsBrowserTargetAdmitted(env.EZIL_DELEGATED_BROWSER_OBSERVE_AWS_TARGETS, computerId) || !isAwsComputersEnabled(env)
        || (env.EZIL_AWS_KILL_SWITCH !== undefined && env.EZIL_AWS_KILL_SWITCH !== '0')) return null;
    try {
        const owned = await db.execute<{ owned: number }>(sql`/* browser:aws-owned-now */
            SELECT 1 AS owned FROM public.ezil_computers
            WHERE id = ${computerId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
            LIMIT 2`);
        if (owned.length !== 1 || owned[0]?.owned !== 1) return null;

        const { record } = await readPlacement(db, computerId, userId);
        if (!record || record.provider !== 'aws-ec2' || record.state !== 'RUNNING'
            || !Number.isSafeInteger(record.generation) || record.generation < 1
            || !Number.isSafeInteger(record.leaseEpoch) || record.leaseEpoch < 1
            || !record.leaseUntil || record.leaseUntil.getTime() <= now().getTime()
            || !record.instanceId || !record.tunnelId) return null;

        const sandboxId = deriveGuacamoleSandboxId(userId, computerId);
        const binding = createHash('sha256').update(JSON.stringify([
            purpose, userId, clientId, computerId, sandboxId, 'aws-ec2', record.generation, record.leaseEpoch,
            record.instanceId, record.tunnelId,
        ])).digest('hex');
        return { sandboxId, binding, provider: 'aws-ec2', generation: record.generation, leaseEpoch: record.leaseEpoch };
    } catch (error) {
        if (error instanceof PlacementOwnerError) return null;
        throw error;
    }
}

/** The v2 placement claims the Worker checks for this target (EBS carries no store claim). */
export function browserTargetClaims(target: CloudflareBrowserTarget | AwsBrowserTarget):
    Pick<PreviewTokenV2Claims, 'provider' | 'store' | 'generation' | 'leaseEpoch'> {
    return 'provider' in target
        ? { provider: 'aws-ec2', store: '', generation: target.generation, leaseEpoch: target.leaseEpoch }
        : { provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0 };
}
