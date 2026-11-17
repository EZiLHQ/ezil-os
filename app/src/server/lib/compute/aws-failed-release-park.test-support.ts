import { vi } from 'vitest';
import { D, failedReleaseSetup, NOW } from './aws-failed-release.test-support';
import { reconcileParkedStop, reserveParkedStop, type ParkDeps, type ParkFailedReleaseRequest } from './aws-failed-release-park';
import { lifecycleExecutionArn } from './aws-receipts';

/** A refusal as the server answers it: an explicit code and no job or digest. */
export const refused = (error: string) => ({ outcome: 'refused', error, parkJobId: null, parkDigest: null });
export const SNAP = 'snap-0123456789abcdef0';
export const STOP_JOB = '9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b';
export const HOST_STOPPED = new Date('2026-10-25T15:20:00Z');
export const SNAP_AT = new Date('2026-10-25T15:30:00Z');
/** The state 400's phase A/B leaves behind: the failed release's UNCONFIRMED row, the host gracefully STOPPED with the data volume
 * attached (carrying a stale legacy `ezil:fence` alias), and a fresh COMPLETED snapshot started after the stop. */
export function parkSetup() {
    const s = failedReleaseSetup();
    const i = s.original.intent;
    Object.assign(s.host, { state: 'stopped', stateTransitionAt: HOST_STOPPED, volumes: [
        { deviceName: '/dev/sda1', volumeId: 'vol-0aaaaaaaaaaaaaaaa', deleteOnTermination: true },
        { deviceName: '/dev/sdf', volumeId: i.dataVolumeId!, deleteOnTermination: false }] as never });
    Object.assign(s.volume, { state: 'in-use', attachments: [{ instanceId: i.providerInstanceId!, state: 'attached' }],
        tags: { ...s.volume.tags, 'ezil:computer': i.computerId, 'ezil:fence': 'stale-legacy-fence' } });
    const snapshot = { snapshotId: SNAP, ownerId: '123456789012', volumeId: i.dataVolumeId!, volumeGiB: 50, state: 'completed',
        encrypted: true, kmsKeyId: D.dataKeyArn, startedAt: SNAP_AT, tags: {} };
    const describeSnapshot = vi.fn(async () => snapshot as typeof snapshot | null);
    const deps = { ...s.deps, describer: { ...s.deps.describer, describeSnapshot },
        tunnels: { createTunnel: vi.fn(), deleteTunnel: vi.fn(async () => ({ ok: true })) } } as unknown as ParkDeps;
    const request: ParkFailedReleaseRequest = { schemaVersion: 1, operation: 'park-failed-release', computerId: i.computerId,
        expectedJobId: i.jobId, parkJobId: STOP_JOB, releaseExecutionArn: s.failed.executionArn!, snapshotId: SNAP };
    const deployments = { [D.region]: D };
    const reserve = (req: ParkFailedReleaseRequest = request, d: ParkDeps = deps) => reserveParkedStop(d, deployments, req);
    const settle = async () => reconcileParkedStop(deps, await s.current(), D);
    const finishStop = (over: Record<string, unknown> = {}) => {
        const work = s.starts.at(-1)!;
        const execution = s.executions.get(lifecycleExecutionArn(work.intent.deployment, work.intent.jobId))!;
        Object.assign(execution, { status: 'SUCCEEDED', stopDate: NOW, output: JSON.stringify({ schemaVersion: 1, jobId: work.intent.jobId, digest: work.digest,
            computerId: i.computerId, generation: 1, leaseEpoch: 1, fenceToken: i.fenceToken, instanceId: i.providerInstanceId, volumeId: i.dataVolumeId,
            state: 'stopped', ...over }) });
        return execution;
    };
    const hostTags = s.host.tags as Record<string, string>; // the fixture's tag map, mutable for the tests
    return { ...s, i, deps, snapshot, describeSnapshot, request, reserve, settle, finishStop, hostTags };
}
export type Setup = ReturnType<typeof parkSetup>;
