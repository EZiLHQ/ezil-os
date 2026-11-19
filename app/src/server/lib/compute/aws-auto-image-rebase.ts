import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import { readAwsAdmissionConfig, readAwsEnrollUrl, type Env } from './aws-config';
import { LIFECYCLE_DEPLOYMENTS_ENV } from './aws-intent';
import { parseRebaseJson, RebaseUuid } from './aws-rebase-json';
import { handleImageRebase, type AutomaticImageRebaseAuthority, type ImageRebaseDeps } from './aws-rebase-orchestrator';
import { rebaseReleaseCandidates } from './aws-rebase-release';
import type { ImageJob } from './aws-rebase-store';
import { ImageJobConflictError, type PlacementExecutor } from './placement';

const AUTO_IMAGE_REBASE_ENV = 'EZIL_AWS_AUTO_IMAGE_REBASE';
const AUTOMATIC_JOB_PREFIX = 'e241ae01';
const AUTOMATIC_JOB_RANGE_END = 'e241ae02-0000-0000-0000-000000000000';
const AUTOMATIC_OPERATIONS = {
    reserved: 'prepare',
    fencing: 'prepare',
    snapshot_pending: 'verify',
    snapshot_ready: 'launch',
    launch_pending: 'launch',
    verifying: 'verify',
} as const;
type AutomaticPhase = keyof typeof AUTOMATIC_OPERATIONS;
type ComputerOwner = { id: string; userId: string };
type PlanningDeps = Pick<ImageRebaseDeps, 'store' | 'env'>;
type ExpectedSource = AutomaticImageRebaseAuthority['expectedSource'];

export interface AutomaticImageRebasePlan {
    computerId: string;
    instanceType: string;
    authority: AutomaticImageRebaseAuthority;
    phase: AutomaticPhase | 'blocked' | null;
}

export type AutomaticImageRebaseCandidate = Pick<ImageJob, 'jobId' | 'computerId' | 'ownerUserId'>;

function automaticPhase(phase: ImageJob['phase']): phase is AutomaticPhase {
    return Object.hasOwn(AUTOMATIC_OPERATIONS, phase);
}

function automaticJobId(computer: ComputerOwner, source: ExpectedSource): string {
    // The reservation schema requires a v4-shaped ID. Only this preparation job uses a stable ID;
    // the launch ID and fence token still use the orchestrator's random ID generator.
    const id = createHash('sha256').update(JSON.stringify([
        'ezil:automatic-image-rebase:v1', computer.userId, computer.id,
        source.sourceGeneration, source.sourceLeaseEpoch, source.fromDigest, source.toDigest,
    ])).digest().subarray(0, 16);
    id[6] = (id[6]! & 0x0f) | 0x40;
    id[8] = (id[8]! & 0x3f) | 0x80;
    const hex = id.toString('hex');
    return `${AUTOMATIC_JOB_PREFIX}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function compatibleTarget(env: Env, region: string, sourceDigest: string) {
    try {
        const map = parseRebaseJson(env[LIFECYCLE_DEPLOYMENTS_ENV] ?? '{}', 65536) as Record<string, unknown> | null;
        const { target, sources } = rebaseReleaseCandidates(map?.[region], sourceDigest);
        if (target.region !== region || target.previousLowerImageDigest !== sourceDigest) return null;
        return sources.some(source => source.accountId === target.accountId && source.region === region
            && source.namespace === target.namespace && source.lowerImageRef.split('@')[0] === target.lowerImageRef.split('@')[0]) ? target : null;
    } catch {
        return null;
    }
}

/** Read the authoritative placement and reservation for a server-authenticated open. No provider calls or job writes. */
export async function loadAutomaticImageRebase(deps: PlanningDeps, computer: ComputerOwner): Promise<AutomaticImageRebasePlan | null> {
    if (!RebaseUuid.safeParse(computer.id).success || !RebaseUuid.safeParse(computer.userId).success) return null;
    const admission = readAwsAdmissionConfig(deps.env);
    if (!admission.enabled || admission.killSwitch || !readAwsEnrollUrl(deps.env)) return null;

    let inspected: Awaited<ReturnType<PlanningDeps['store']['inspect']>>;
    try {
        inspected = await deps.store.inspect(computer.id);
    } catch (error) {
        if (error instanceof ImageJobConflictError) return null;
        throw error;
    }
    const { placement, job } = inspected;
    if (!placement || placement.ownerUserId !== computer.userId || placement.computerId !== computer.id
        || placement.provider !== 'aws-ec2' || placement.store !== 'ebs' || !placement.region || !placement.instanceType
        || !admission.regions.some(region => region.name === placement.region)) return null;

    if (job) {
        const { jobId, ownerUserId, sourceGeneration, sourceLeaseEpoch, fromDigest, toDigest } = job;
        if (ownerUserId !== computer.userId || job.computerId !== computer.id || job.parentJobId) return null;
        const expectedSource = { sourceGeneration, sourceLeaseEpoch, fromDigest, toDigest };
        if (automaticJobId(computer, expectedSource) !== jobId) return null;
        const target = compatibleTarget(deps.env, placement.region, fromDigest);
        const phase = automaticPhase(job.phase) && !job.recoveryDocument && !job.failureCode
            && isDeepStrictEqual(target, job.targetRelease) ? job.phase : 'blocked';
        return { computerId: computer.id, instanceType: placement.instanceType, authority: { jobId, ownerUserId, expectedSource }, phase };
    }

    if (deps.env[AUTO_IMAGE_REBASE_ENV] !== '1' || placement.state !== 'STOPPED' || placement.lifecycleJobId
        || !placement.lowerDigestObservedAt || !placement.instanceId || !placement.volumeId || !placement.fsUuid
        || !placement.fenceToken || !placement.zoneId || !placement.lowerImageDigest) return null;

    const fromDigest = placement.lowerImageDigest;
    const target = compatibleTarget(deps.env, placement.region, fromDigest);
    if (!target) return null;
    const expectedSource: ExpectedSource = {
        sourceGeneration: placement.generation,
        sourceLeaseEpoch: placement.leaseEpoch,
        fromDigest,
        toDigest: target.lowerImageDigest,
    };
    const jobId = automaticJobId(computer, expectedSource);
    return {
        computerId: computer.id,
        instanceType: placement.instanceType,
        authority: { jobId, ownerUserId: computer.userId, expectedSource },
        phase: null,
    };
}

/** Recheck the billed placement and advance at most one ordinary image-rebase operation. */
export async function advanceAutomaticImageRebase(deps: ImageRebaseDeps, plan: AutomaticImageRebasePlan): Promise<'pending' | 'ready' | 'blocked'> {
    const computer = { id: plan.computerId, userId: plan.authority.ownerUserId };
    const current = await loadAutomaticImageRebase(deps, computer);
    if (!current || current.instanceType !== plan.instanceType || current.authority.jobId !== plan.authority.jobId
        || plan.phase === 'blocked' || current.phase === 'blocked' || (plan.phase !== null && current.phase === null)) return 'blocked';
    const response = await handleImageRebase(deps, {
        schemaVersion: 1,
        computerId: computer.id,
        operation: current.phase ? AUTOMATIC_OPERATIONS[current.phase] : 'prepare',
        jobId: current.phase ? current.authority.jobId : null,
    }, current.authority);

    if (response.body.failureCode === 'image_job_conflict') {
        // Another open can win the reservation or phase CAS while this request is observing AWS.
        const latest = await loadAutomaticImageRebase(deps, computer);
        return latest?.authority.jobId === current.authority.jobId && latest.phase !== null && latest.phase !== 'blocked' ? 'pending' : 'blocked';
    }
    if (response.body.jobId !== current.authority.jobId || !response.body.phase) return 'blocked';
    if (response.body.phase === 'succeeded' && response.body.eligible) return 'ready';
    if (automaticPhase(response.body.phase) && (response.body.eligible || response.body.failureCode === 'desktop_unhealthy')) return 'pending';
    return 'blocked';
}

/** Find a bounded set of existing reservations. Every candidate must pass the normal owned exact-ID read before advancing. */
export async function listAutomaticImageRebaseCandidates(db: PlacementExecutor, limit: number): Promise<AutomaticImageRebaseCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    const phases = Object.keys(AUTOMATIC_OPERATIONS).map(phase => sql`${phase}`);
    const result = await db.execute(sql`SELECT job_id::text AS "jobId", computer_id::text AS "computerId", owner_user_id::text AS "ownerUserId"
        FROM public.ezil_computer_image_jobs
        WHERE job_id >= ${`${AUTOMATIC_JOB_PREFIX}-0000-0000-0000-000000000000`}::uuid
          AND job_id < ${AUTOMATIC_JOB_RANGE_END}::uuid AND phase IN (${sql.join(phases, sql`, `)})
        ORDER BY updated_at, job_id LIMIT ${Math.min(limit, 20)}`) as AutomaticImageRebaseCandidate[] | { rows: AutomaticImageRebaseCandidate[] };
    return Array.isArray(result) ? result : result.rows;
}
