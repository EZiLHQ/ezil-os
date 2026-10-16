import { isAwsRequiredUser, isPlacementReadEnabled, type Env } from './aws-config';
import { PlacementOwnerError, readPlacement, type PlacementExecutor } from './placement';
import type { ComputerRef } from './provider';

/** Settings observes recorded placement only. It never admits, pins or starts compute. */
export async function readComputerPlacementInfo(db: PlacementExecutor, computer: ComputerRef, env: Env = process.env) {
    const awsRequired = isAwsRequiredUser(env, computer.userId);
    if (!isPlacementReadEnabled(env)) {
        return { status: 'unavailable' as const, provider: null, region: null, state: null, fallback: false, awsRequired };
    }
    const { record } = await readPlacement(db, computer.computerId);
    if (!record) {
        return { status: 'unplaced' as const, provider: null, region: null, state: null, fallback: false, awsRequired };
    }
    if (record.ownerUserId !== computer.userId.toLowerCase()) throw new PlacementOwnerError(computer.computerId);
    return {
        status: 'placed' as const,
        provider: record.provider,
        region: record.provider === 'aws-ec2' ? record.region : null,
        state: record.state,
        // Historical placements lack a recorded cause. Never invent one or expose raw last_error.
        fallback: record.provider === 'cloudflare' && record.lastError?.startsWith('cloudflare_fallback:') === true,
        awsRequired,
    };
}
