import { billingComputeMeter } from '@/server/billing/v2/compute-meter';
import { ImageJobConflictError } from '@/server/lib/compute/placement';
import { db } from '@/server/db';
import { sharedAwsSdkCollaborators } from '@/server/lib/compute/aws-clients';
import { createImageJobStore } from '@/server/lib/compute/aws-rebase-store';
import { handleImageRebase, ImageRebaseRequestSchema } from '@/server/lib/compute/aws-rebase-orchestrator';
import { imageDesktopHealthy } from '@/server/lib/compute/aws-rebase-health';
import { readWorkflowRequest } from '@/server/lib/compute/aws-workflow-auth';
import { readLifecycleDeployments } from '@/server/lib/compute/aws-intent';
import { workerTunnelClientFromEnv } from '@/server/lib/compute/aws-enroll';
import { ReconcileReplacementRequestSchema, reconcileReplacementWithHistoricalSource } from '@/server/lib/compute/aws-historical-source';
import { ReconcileReleaseRequestSchema, reconcileFailedRelease } from '@/server/lib/compute/aws-pool-release-recovery';
import { createPoolDeps } from '@/server/lib/compute/aws-pool-runtime';
import type { PlacementDb } from '@/server/lib/compute/placement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const PATH = '/api/internal/computers/image-rebase';
const headers = { 'cache-control': 'no-store' };
export async function POST(req: Request): Promise<Response> {
    const secret = process.env.EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET;
    if (!secret || !/^[a-f0-9]{64}$/.test(secret)) return Response.json({ error: 'authority_unavailable' }, { status: 503, headers });
    let raw: unknown;
    try { raw = await readWorkflowRequest(req, PATH, secret, Date.now()); }
    catch { return Response.json({ authorized: false }, { status: 403, headers }); }
    if ((raw as { operation?: unknown } | null)?.operation === 'reconcile-replacement') return reconcileReplacement(raw);
    if ((raw as { operation?: unknown } | null)?.operation === 'reconcile-release') return reconcileRelease(raw);
    let input;
    try { input = ImageRebaseRequestSchema.parse(raw); }
    catch { return Response.json({ authorized: false }, { status: 403, headers }); }
    try {
        const { starter, executions, describer } = sharedAwsSdkCollaborators();
        if (!starter || !executions || !describer?.describeSnapshot) return Response.json({ error: 'image_rebase_unavailable' }, { status: 503, headers });
        const result = await handleImageRebase({ store: createImageJobStore(db), env: process.env, now: () => new Date(), starter, executions, meter: billingComputeMeter(),
            describer: { describeSnapshot: describer.describeSnapshot.bind(describer), describeVolume: describer.describeVolume.bind(describer),
                describeForEnrollment: describer.describeForEnrollment.bind(describer) }, desktopHealthy: p => imageDesktopHealthy(p, process.env) }, input);
        return Response.json(result.body, { status: result.status, headers });
    } catch (error) {
        return Response.json({ error: error instanceof ImageJobConflictError ? 'image_job_conflict' : 'image_rebase_unavailable' },
            { status: error instanceof ImageJobConflictError ? 409 : 503, headers });
    }
}

/** Failed-replacement reconciliation from an operator hint: read-only AWS readers, no starter, normal CAS. */
async function reconcileReplacement(raw: unknown): Promise<Response> {
    let input;
    try { input = ReconcileReplacementRequestSchema.parse(raw); }
    catch { return Response.json({ authorized: false }, { status: 403, headers }); }
    try {
        const regions = (process.env.AWS_REGIONS ?? '').split(',').map(r => r.trim()).filter(Boolean);
        const configs = readLifecycleDeployments(process.env, regions);
        const { executions, describer } = sharedAwsSdkCollaborators(), tunnels = workerTunnelClientFromEnv(process.env);
        if (!configs.ok || !executions?.history || !describer?.describeVolume || !describer.describeReplacementWriters || !tunnels)
            return Response.json({ error: 'reconcile_unavailable' }, { status: 503, headers });
        const outcome = await reconcileReplacementWithHistoricalSource({ db, executions, describer, tunnels }, configs.deployments, input);
        return Response.json({ schemaVersion: 1, computerId: input.computerId, jobId: input.expectedJobId, outcome }, { status: 200, headers });
    } catch (error) {
        return Response.json({ error: error instanceof ImageJobConflictError ? 'image_job_conflict' : 'reconcile_unavailable' },
            { status: error instanceof ImageJobConflictError ? 409 : 503, headers });
    }
}


/** Failed-release recovery for the placement's expected job: the ordinary pool release recovery (normal reservation CAS,
 * release replay, retired-receipt settlement), never replacement, image or delete recovery. */
async function reconcileRelease(raw: unknown): Promise<Response> {
    let input;
    try { input = ReconcileReleaseRequestSchema.parse(raw); }
    catch { return Response.json({ authorized: false }, { status: 403, headers }); }
    try {
        const regions = (process.env.AWS_REGIONS ?? '').split(',').map(r => r.trim()).filter(Boolean);
        const configs = readLifecycleDeployments(process.env, regions);
        const { starter, executions, describer } = sharedAwsSdkCollaborators(), tunnels = workerTunnelClientFromEnv(process.env);
        if (!configs.ok || !starter || !executions?.history || !describer?.describeVolume || !tunnels)
            return Response.json({ error: 'reconcile_unavailable' }, { status: 503, headers });
        const placementDb = db as unknown as PlacementDb;
        const { outcome, error } = await reconcileFailedRelease({ db: placementDb, starter, executions, describer, tunnels,
            meter: billingComputeMeter(), pool: createPoolDeps(placementDb, process.env) }, configs.deployments, input);
        return Response.json({ schemaVersion: 1, computerId: input.computerId, jobId: input.expectedJobId, outcome, error }, { status: 200, headers });
    } catch (error) {
        return Response.json({ error: error instanceof ImageJobConflictError ? 'image_job_conflict' : 'reconcile_unavailable' },
            { status: error instanceof ImageJobConflictError ? 409 : 503, headers });
    }
}
