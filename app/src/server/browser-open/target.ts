import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/server/db';
import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { PlacementOwnerError, readPlacement } from '@/server/lib/compute/placement';

export async function resolveCloudflareBrowserTarget(
    { userId, clientId }: { userId: string; clientId: string },
    computerId: string,
): Promise<{ sandboxId: string; binding: string } | null> {
    try {
        const owned = await db.execute<{ owned: number }>(sql`/* browser:owned-now */
            SELECT 1 AS owned FROM public.ezil_computers
            WHERE id = ${computerId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
            LIMIT 2`);
        if (owned.length !== 1 || owned[0]?.owned !== 1) return null;

        const { record } = await readPlacement(db, computerId, userId);
        // Cloudflare uses the Worker container and migration fence to establish live readiness.
        if (!record || record.provider !== 'cloudflare' || record.generation !== 0 || record.leaseEpoch !== 0
            || (record.state !== 'STOPPED' && record.state !== 'RUNNING')) return null;

        const sandboxId = deriveGuacamoleSandboxId(userId, computerId);
        const binding = createHash('sha256').update(JSON.stringify([
            'ezil-browser-prod-canary-v1', userId, clientId, computerId, sandboxId, record.updatedAt.toISOString(),
        ])).digest('hex');
        return { sandboxId, binding };
    } catch (error) {
        if (error instanceof PlacementOwnerError) return null;
        throw error;
    }
}
