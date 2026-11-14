import { poolJobAuthority } from '@/server/lib/compute/aws-pool-dispatch';
import { authorizeAdoptRecovery } from '@/server/lib/compute/aws-pool-recovery';
import { authorizeStalledAdoptRelease } from '@/server/lib/compute/aws-pool-adopt-stall';
import { buildLifecycleWork } from '@/server/lib/compute/aws-intent';
import { isPoolReleaseRecovering, poolReleaseReplay, matchesPoolReleaseRecovery } from '@/server/lib/compute/aws-pool-release-recovery';
import { isPoolMode } from '@/server/lib/compute/aws-receipts';
import { createImageJobStore } from '@/server/lib/compute/aws-rebase-store';
import { RebaseUuid } from '@/server/lib/compute/aws-rebase-json';
import { readWorkflowRequest } from '@/server/lib/compute/aws-workflow-auth';
import { z } from 'zod';

import { db } from '@/server/db';
import { ImageJobConflictError, PlacementIntegrityError, readCanaryComputer, readLifecyclePlacement, type PlacementState } from '@/server/lib/compute/placement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Wire contract: infra/app-computers/lib/lifecycle/{contract,aws}.ts.
const AUTHORITY_PATH = '/api/internal/computers/lifecycle-authority';
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const uuid = RebaseUuid;
const AuthoritySchema = z.object({
    schemaVersion: z.literal(1),
    computerId: uuid,
    jobId: uuid,
    leaseEpoch: z.number().int().min(1).max(2147483647),
    digest: z.string().regex(HEX_SHA256),
    operation: z.enum(['pool-provision', 'pool-retire']).optional(),
    poolHostId: uuid.optional(),
    poolGeneration: z.number().int().min(1).max(2147483647).optional(),
    imageJobId: uuid.optional(),
    imageJobPhase: z.enum(['preparation', 'launch', 'recovery', 'rebind']).optional(),
}).strict().refine(a => (a.imageJobId === undefined) === (a.imageJobPhase === undefined)
    && (a.operation === undefined) === (a.poolHostId === undefined)
    && (a.operation === undefined) === (a.poolGeneration === undefined)
    && !(a.operation && a.imageJobId));

// C-3 / PLACEMENT_TRANSITIONS: only an execution still in flight may act.
const IN_FLIGHT_STATES = new Set<PlacementState>([
    'PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING', 'RETIRING',
]);
const NO_STORE = { 'cache-control': 'no-store' };
const refuse = () => Response.json({ authorized: false }, { status: 403, headers: NO_STORE });
const unavailable = () => Response.json({ error: 'authority_unavailable' }, { status: 503, headers: NO_STORE });

export async function POST(req: Request): Promise<Response> {
    // Same 32-byte hex key as Secrets Manager's authoritySecretArn AWSCURRENT.
    const secret = process.env.EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET;
    if (!secret || !HEX_SHA256.test(secret)) return unavailable();

    let input: unknown;
    try { input = await readWorkflowRequest(req, AUTHORITY_PATH, secret, Date.now()); }
    catch { return refuse(); }
    const parsed = AuthoritySchema.safeParse(input);
    if (!parsed.success) return refuse();
    const authority = parsed.data;

    try {
        if (authority.operation && authority.poolHostId && authority.poolGeneration) {
            if (!await poolJobAuthority(db, { ...authority, operation: authority.operation, poolHostId: authority.poolHostId,
                poolGeneration: authority.poolGeneration }, process.env)) return refuse();
            return Response.json({ authorized: true, ...authority }, { status: 200, headers: NO_STORE });
        }
        if (authority.imageJobId && authority.imageJobPhase) {
            if (!await createImageJobStore(db).authority({ ...authority, imageJobId: authority.imageJobId, imageJobPhase: authority.imageJobPhase })) return refuse();
            return Response.json({ authorized: true, ...authority }, { status: 200, headers: NO_STORE });
        }
        // Migration-aware: a computer moving to AWS is authorised for its hidden launch intent only,
        // and a failed migration only for the recorded retire of its unreleased boot.
        const { record } = await readLifecyclePlacement(db, authority.computerId, authority.jobId);
        if (!record || record.provider !== 'aws-ec2'
            || record.computerId !== authority.computerId
            || record.lifecycleJobId !== authority.jobId
            || record.lifecycleDigest !== authority.digest
            || record.leaseEpoch !== authority.leaseEpoch) return refuse();
        if (!IN_FLIGHT_STATES.has(record.state)) {
            if (await authorizeAdoptRecovery(db, record))
                return Response.json({ authorized: true, ...authority }, { status: 200, headers: NO_STORE });
            // A stalled pool adoption's release: the automatic recovery's only job.
            if (await authorizeStalledAdoptRelease(db, record))
                return Response.json({ authorized: true, ...authority }, { status: 200, headers: NO_STORE });
            // Only the durable live-release replay can authorize RECOVERING.
            // Deleted-computer and image recovery have separate authority.
            if (!isPoolReleaseRecovering(record)) return refuse();
            let work;
            try { work = buildLifecycleWork(poolReleaseReplay(record)!.intent); }
            catch { return refuse(); }
            if (work.intent.operation !== 'release' || !isPoolMode(work.intent.deployment)
                || !matchesPoolReleaseRecovery(record, work)) return refuse();
            const computer = await readCanaryComputer(db, authority.computerId);
            if (!computer || computer.deleted || computer.userId !== record.ownerUserId) return refuse();
        }
    } catch (error) {
        // Corrupt/duplicate placements are refused; a failed read is uncertain.
        return (error instanceof PlacementIntegrityError || error instanceof ImageJobConflictError) ? refuse() : unavailable();
    }

    // The Lambda requires exact object equality; no additional success fields.
    return Response.json({ authorized: true, ...authority }, { status: 200, headers: NO_STORE });
}
