/**
 * Target resolver for the computer-tools receiver (contract §3.2). An addressable target is
 * an owned-now Cloudflare computer: `provider='cloudflare'`, `leaseEpoch=0`, generation 0 or
 * 1, state STOPPED or RUNNING. Anything else — not owned, deleted, AWS-EC2, leased, moved, or
 * in a transitional state — resolves to null and becomes 404 `computer_not_found`. The binding
 * hash is re-resolved after the Worker replies; a change (a move/restart between resolve and
 * reply) is drift → 503 `computer_unavailable`.
 *
 * Own module: `app/src/server/browser-observe/*` is not edited. The placement read rules match
 * `resolveCloudflareBrowserTarget`, with purpose `ezil-computer-tools-v1`.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { db } from '@/server/db';
import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { PlacementOwnerError, readPlacement } from '@/server/lib/compute/placement';

import { COMPUTER_TOOLS_TARGET_PURPOSE } from './contract';

export interface ComputerToolsTarget {
    sandboxId: string;
    binding: string;
}

export async function resolveComputerToolsTarget(
    { userId, clientId }: { userId: string; clientId: string },
    computerId: string,
): Promise<ComputerToolsTarget | null> {
    try {
        const owned = await db.execute<{ owned: number }>(sql`/* computer-tools:owned-now */
            SELECT 1 AS owned FROM public.ezil_computers
            WHERE id = ${computerId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
            LIMIT 2`);
        if (owned.length !== 1 || owned[0]?.owned !== 1) return null;

        const { record } = await readPlacement(db, computerId, userId);
        // Cloudflare rows are generation 1 / epoch 0 (`pinCloudflarePlacement`); legacy rows are 0/0. Any other
        // generation, a leased epoch, AWS-EC2, or a transitional state means this slice cannot address it.
        if (!record || record.provider !== 'cloudflare' || record.leaseEpoch !== 0
            || (record.generation !== 0 && record.generation !== 1)
            || (record.state !== 'STOPPED' && record.state !== 'RUNNING')) return null;

        const sandboxId = deriveGuacamoleSandboxId(userId, computerId);
        const binding = createHash('sha256').update(JSON.stringify([
            COMPUTER_TOOLS_TARGET_PURPOSE, userId, clientId, computerId, sandboxId, record.updatedAt.toISOString(),
        ])).digest('hex');
        return { sandboxId, binding };
    } catch (error) {
        if (error instanceof PlacementOwnerError) return null;
        throw error;
    }
}
