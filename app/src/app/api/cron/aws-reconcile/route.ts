import { env } from '@/env';
import { defaultAwsCollaborators, imageRebaseDependencies, imageUpdateTier } from '@/server/api/routers/compute-dispatch';
import { db } from '@/server/db';
import { advanceAutomaticImageRebase, listAutomaticImageRebaseCandidates, loadAutomaticImageRebase } from '@/server/lib/compute/aws-auto-image-rebase';
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
 * (team/ROOT-IDLE-DOWNSCALE-REVIEW-118.md). Use the same fleet reconcile bounds and AWS kill switch.
 * An independent bounded pass advances image updates that an authenticated open already reserved.
 * Root ROOT-IDLE-POLICY-118 option (b) holds for every fleet caller: `reconcileAwsFleet` never stops a running guest
 * solely for a lapsed technical lease (caps and guest-stop settlement still run; ROOT-FLEET-LEASE-INCIDENT-118).
 */
export const maxDuration = 50;
const IMAGE_UPDATES_PER_TICK = 4;
const IMAGE_UPDATES_TO_CHECK = 16;

async function reconcileImageUpdates(placementDb: PlacementDb, aws: ReturnType<typeof defaultAwsCollaborators>, signal: AbortSignal) {
    const deps = imageRebaseDependencies(placementDb, process.env, aws);
    if (!deps) return null;
    try {
        const candidates = await listAutomaticImageRebaseCandidates(placementDb, IMAGE_UPDATES_TO_CHECK);
        if (!candidates.length) return null;
        const [{ getBillingDeps }, { gateComputerStart }] = await Promise.all([
            import('@/server/billing/deps'),
            import('@/server/billing/v2/compute-access'),
        ]);
        const billing = getBillingDeps();
        const admitted = await Promise.allSettled(candidates.map(async candidate => {
            if (signal.aborted) return;
            const plan = await loadAutomaticImageRebase(deps, { id: candidate.computerId, userId: candidate.ownerUserId });
            if (!plan || !plan.phase || plan.phase === 'blocked' || plan.authority.jobId !== candidate.jobId || signal.aborted) return;
            const gate = await gateComputerStart({ deps: billing, userId: candidate.ownerUserId, computerId: candidate.computerId,
                kind: 'aws-ec2', instanceType: plan.instanceType, now: billing.now() });
            if (!gate.allowed || await imageUpdateTier(candidate.ownerUserId, plan, process.env) !== 'ready' || signal.aborted) return;
            return plan;
        }));
        const plans = admitted.flatMap(outcome => outcome.status === 'fulfilled' && outcome.value ? [outcome.value] : [])
            .slice(0, IMAGE_UPDATES_PER_TICK);
        const outcomes = signal.aborted ? [] : await Promise.allSettled(plans.map(plan => advanceAutomaticImageRebase(deps, plan)));
        const errors = [...admitted, ...outcomes].filter(result => result.status === 'rejected').length;
        if (errors) console.error('[aws-reconcile] automatic image update failed', { errors });
        return { checked: candidates.length, errors };
    } catch {
        console.error('[aws-reconcile] automatic image updates unavailable');
        return null;
    }
}

export async function GET(req: Request): Promise<Response> {
    if (!env.CRON_SECRET || req.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`) {
        return new Response(null, { status: 404 });
    }
    // AWS off: answer like runAwsBackgroundReconcile does, without building any collaborator.
    if (!isAwsComputersEnabled(process.env)) {
        return Response.json({ ok: true, skipped: 'aws_disabled' }, { headers: { 'cache-control': 'no-store' } });
    }
    const placementDb = db as unknown as PlacementDb;
    const aws = defaultAwsCollaborators(process.env), signal = AbortSignal.timeout(40_000);
    const [result, imageUpdates] = await Promise.all([
        runAwsBackgroundReconcile(process.env, { db: placementDb, ...aws, pool: createPoolDeps(placementDb, process.env), signal }),
        reconcileImageUpdates(placementDb, aws, signal),
    ]);
    return Response.json(imageUpdates ? { ...result, imageUpdates } : result, { headers: { 'cache-control': 'no-store' } });
}
