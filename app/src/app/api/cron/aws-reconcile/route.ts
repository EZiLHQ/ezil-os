import { env } from '@/env';
import { defaultAwsCollaborators } from '@/server/api/routers/compute-dispatch';
import { db } from '@/server/db';
import { isAwsComputersEnabled } from '@/server/lib/compute/aws-config';
import { createPoolDeps } from '@/server/lib/compute/aws-pool-runtime';
import { runAwsBackgroundReconcile } from '@/server/lib/compute/aws-receipts';
import type { PlacementDb } from '@/server/lib/compute/placement';

/**
 * `GET /api/cron/aws-reconcile`: the EXISTING full AWS background reconcile
 * (`runAwsBackgroundReconcile`: deleted computers, then `reconcileAwsFleet`, which notices
 * guest idle stops and lapsed leases), on the staging minute timer. Before this, only the
 * daily sandbox-reap and interactive calls ran it, so an idle-stopped computer stayed
 * RUNNING/leased in placement and pool accounting until the next full pass
 * (team/ROOT-IDLE-DOWNSCALE-REVIEW-118.md). This route adds no new behaviour: the same
 * function, its own per-pass bounds (FLEET_RECONCILE_LIMIT / RETIRE_RECONCILE_LIMIT, with
 * SKIP LOCKED claims) and its own AWS kill switch. aws-stop-settle is unchanged.
 */
export const maxDuration = 50;

export async function GET(req: Request): Promise<Response> {
    if (!env.CRON_SECRET || req.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`) {
        return new Response(null, { status: 404 });
    }
    // AWS off: answer like runAwsBackgroundReconcile does, without building any collaborator.
    if (!isAwsComputersEnabled(process.env)) {
        return Response.json({ ok: true, skipped: 'aws_disabled' }, { headers: { 'cache-control': 'no-store' } });
    }
    const placementDb = db as unknown as PlacementDb;
    const result = await runAwsBackgroundReconcile(process.env, {
        db: placementDb, ...defaultAwsCollaborators(process.env), pool: createPoolDeps(placementDb, process.env),
        // Inside the 50 s timer budget; unclaimed rows rotate to the next minute's pass.
        signal: AbortSignal.timeout(40_000),
    });
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
}
