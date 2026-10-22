import { billingComputeMeter } from '@/server/billing/v2/compute-meter';
import { ImageJobConflictError } from '@/server/lib/compute/placement';
import { db } from '@/server/db';
import { sharedAwsSdkCollaborators } from '@/server/lib/compute/aws-clients';
import { createImageJobStore } from '@/server/lib/compute/aws-rebase-store';
import { handleImageRebase, ImageRebaseRequestSchema } from '@/server/lib/compute/aws-rebase-orchestrator';
import { imageDesktopHealthy } from '@/server/lib/compute/aws-rebase-health';
import { readWorkflowRequest } from '@/server/lib/compute/aws-workflow-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const PATH = '/api/internal/computers/image-rebase';
const headers = { 'cache-control': 'no-store' };
export async function POST(req: Request): Promise<Response> {
    const secret = process.env.EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET;
    if (!secret || !/^[a-f0-9]{64}$/.test(secret)) return Response.json({ error: 'authority_unavailable' }, { status: 503, headers });
    let input;
    try { input = ImageRebaseRequestSchema.parse(await readWorkflowRequest(req, PATH, secret, Date.now())); }
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
