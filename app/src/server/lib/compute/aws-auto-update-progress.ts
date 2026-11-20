import type { ImageRebaseResponse } from './aws-rebase-orchestrator';
import type { ImageJobPhase } from './aws-rebase-store';

const SAVING = { percent: 20, stage: 'saving_files' } as const;
const STARTING = { percent: 40, stage: 'starting_computer' } as const;
const CHECKING = { percent: 60, stage: 'checking_computer' } as const;
const OPENING = { percent: 80, stage: 'opening_code' } as const;
type UpdateMilestone = typeof SAVING | typeof STARTING | typeof CHECKING | typeof OPENING;

const MILESTONES: Partial<Record<ImageJobPhase, UpdateMilestone>> = {
    reserved: SAVING,
    fencing: SAVING,
    snapshot_pending: SAVING,
    snapshot_ready: STARTING,
    launch_pending: STARTING,
    verifying: CHECKING,
    succeeded: OPENING,
};

export type AutomaticImageUpdateWait = { milestone?: UpdateMilestone };

/**
 * Count five ordered checkpoints: reserved job, verified snapshot, verified
 * launch, verified computer, and ready Code. The last belongs to the Code
 * handoff. A pending response only reports milestones proved by the job.
 */
export function automaticImageUpdateWait(result: ImageRebaseResponse): AutomaticImageUpdateWait | null {
    const { body } = result;
    if (body.jobId === null || !(body.eligible || (result.status === 202 && body.failureCode === 'desktop_unhealthy'))) {
        return null;
    }
    const milestone = body.phase === null ? undefined : MILESTONES[body.phase];
    return milestone ? { milestone } : {};
}
