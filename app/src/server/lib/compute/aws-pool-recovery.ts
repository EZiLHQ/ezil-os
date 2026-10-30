import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { buildLifecycleWork, LifecycleIntentSchema, type LifecycleIntent, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { isExecutionAbsent } from './aws-errors';
import { isPoolMode, lifecycleExecutionArn, LifecycleReceiptSchema, POOL_RELEASED, startLifecycleJob } from './aws-receipts';
import type { LifecycleExecutionReader, ReceiptDeps } from './aws-receipts';
import { assertUnopenedAdoptUsage, lockPoolClaimPlacement, readCanaryComputer, withAdmission, writeLivePoolRecovery, writePoolOpen, type Placement, type PlacementExecutor } from './placement';
import { retireRefusedPoolLease } from './ready-pool';

export const POOL_OPEN_RELEASE = 'pool_open_release';
export const POOL_OPEN_RELEASE_FAILED = 'pool_open_release_failed';
const SOURCE = 'pool_adopt_source:';
export const poolAdoptSource = (cold: LifecycleIntent): string | null => cold.previousInstanceId
    ? SOURCE + JSON.stringify({ instanceId: cold.previousInstanceId, generation: cold.previousGeneration, fenceToken: cold.previousFenceToken }) : null;
export const isPoolOpenRelease = (p: Placement): boolean => p.state === 'STOPPING'
    && [POOL_OPEN_RELEASE, 'lifecycle_start_unknown:STOPPED'].includes(p.lastError ?? '');

export async function failPoolOpenRelease(deps: ReceiptDeps, p: Placement): Promise<void> {
    await writePoolOpen(deps.db, p, 'STOPPED', { lifecycleJobId: null, lifecycleDigest: null,
        enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null, lastError: POOL_OPEN_RELEASE_FAILED });
}

/** A terminal observer refusal plus positive unchanged-resource evidence. A task
 * error, redrive, retagged volume or published claim is never safe to unwind.
 */
export async function recoverRefusedAdopt(deps: ReceiptDeps, p: Placement, intent: LifecycleIntent | null,
    e: Awaited<ReturnType<LifecycleExecutionReader['describe']>>): Promise<boolean> {
    if (!intent || intent.operation !== 'adopt' || e.status !== 'FAILED' || e.redriveCount !== 0
        || e.stateMachineAliasArn || !deps.describer?.describeVolume || !p.volumeId || !p.instanceId) return false;
    try {
        const work = buildLifecycleWork(intent);
        const arn = work.stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:computer-${intent.jobId}`);
        if (work.digest !== p.lifecycleDigest || intent.jobId !== p.lifecycleJobId || intent.computerId !== p.computerId
            || intent.targetGeneration !== p.generation || intent.leaseEpoch !== p.leaseEpoch || intent.fenceToken !== p.fenceToken
            || intent.providerInstanceId !== p.instanceId || intent.dataVolumeId !== p.volumeId
            || intent.deployment.region !== p.region || intent.deployment.zoneId !== p.zoneId
            || e.executionArn !== arn || e.stateMachineVersionArn !== work.stateMachineArn) return false;
        const ctl = JSON.parse(e.cause ?? '');
        if (e.error !== 'LifecycleUnconfirmed' || ctl.lastError?.Error !== 'none' || ctl.lastError?.Cause !== 'none'
            || ctl.throttles !== 0 || ctl.observeError?.Error !== 'LifecycleFailure') return false;
        const failure = JSON.parse(ctl.observeError.Cause);
        const code = failure.errorMessage;
        if (failure.errorType !== 'LifecycleFailure' || typeof code !== 'string' || !/^lifecycle_[a-z_]{1,60}$/.test(code)) return false;
        const d = intent.deployment;
        const host = await deps.describer.describeForEnrollment(p.region!, p.instanceId);
        const volume = await deps.describer.describeVolume(p.region!, p.volumeId);
        if (!host || host.instanceId !== p.instanceId || host.state !== 'running' || host.instanceType !== intent.instanceType
            || host.availabilityZoneId !== d.zoneId || host.rootDeviceName !== d.storage.rootDeviceName
            || host.volumes.length !== 1 || host.volumes[0]!.deviceName !== host.rootDeviceName
            || !host.volumes[0]!.deleteOnTermination || host.volumes[0]!.volumeId === p.volumeId
            || !Object.entries({ 'ezil:pool': '1', 'ezil:pool-host': intent.poolHostId!, 'ezil:namespace': d.namespace,
                'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace }).every(([k, v]) => host.tags[k] === v)
            || ['ezil:computer', 'ezil:computer-id', 'ezil:generation', 'ezil:fence', 'ezil:fence-token'].some(k => host.tags[k] !== undefined)) return false;
        if (!volume || volume.volumeId !== p.volumeId || !volume.attachments || volume.encrypted !== true
            || volume.kmsKeyId !== d.dataKeyArn || volume.zoneId !== d.zoneId
            || !Object.entries({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace,
                'ezil:computer-id': p.computerId }).every(([k, v]) => volume.tags?.[k] === v)) return false;
        const generation = Number(volume.tags?.['ezil:generation']);
        const fenceToken = volume.tags?.['ezil:fence-token'];
        if (!Number.isSafeInteger(generation) || generation < 1 || generation >= p.generation
            || !fenceToken || !/^[a-f0-9-]{36}$/.test(fenceToken) || fenceToken === p.fenceToken) return false;
        const sourceMark = p.lastError?.replace(/^lifecycle_start_unknown:UNCONFIRMED:/, '');
        const prior = sourceMark?.startsWith(SOURCE) ? JSON.parse(sourceMark.slice(SOURCE.length)) : null;
        // Legacy rows did not save a source snapshot. Their single retained attachment
        // and matching source tags supply the identity, never generation arithmetic.
        const attached = volume.state === 'in-use' && volume.attachments.length === 1 && volume.attachments[0]!.state === 'attached';
        const free = volume.state === 'available' && volume.attachments.length === 0;
        const instanceId = prior?.instanceId ?? (attached ? volume.attachments[0]!.instanceId : null);
        if ((!free && !attached) || !instanceId || instanceId === p.instanceId || !/^i-[a-f0-9]{17}$/.test(instanceId)
            || (prior && (prior.generation !== generation || prior.fenceToken !== fenceToken))
            || (attached && volume.attachments[0]!.instanceId !== instanceId)) return false;
        const source = await deps.describer.describeForEnrollment(p.region!, instanceId);
        if (source && (source.instanceId !== instanceId || !['stopped', 'terminated'].includes(source.state)
            || source.tags['ezil:managed-by'] !== 'app-computer-platform' || source.tags['ezil:stage'] !== d.namespace
            || source.tags['ezil:pool'] !== undefined || source.tags['ezil:generation'] !== String(generation)
            || !((source.tags['ezil:computer-id'] === p.computerId && source.tags['ezil:fence-token'] === fenceToken)
                || (source.tags['ezil:computer'] === p.computerId && source.tags['ezil:fence'] === fenceToken))
            || Object.entries({ 'ezil:computer-id': p.computerId, 'ezil:computer': p.computerId,
                'ezil:fence-token': fenceToken, 'ezil:fence': fenceToken }).some(([k, v]) => source.tags[k] !== undefined && source.tags[k] !== v))) return false;
        if (attached && (!source || source.state !== 'stopped' || !source.volumes.some(v => v.volumeId === p.volumeId && !v.deleteOnTermination))) return false;
        const result = await writePoolOpen(deps.db, p, 'STOPPED', { instanceId, fenceToken, lifecycleJobId: null, lifecycleDigest: null,
            enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null, leaseUntil: null, lastError: code }, generation,
        tx => retireRefusedPoolLease(tx, intent.poolHostId!, p));
        return result.ok;
    } catch { return false; }
}

const ADOPT_RECOVERY = 'pool_adopt_recover_release:';
const canonicalRecovery = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);
const hashRecovery = (s: string) => createHash('sha256').update(s).digest('hex');
const positiveRecovery = z.number().int().min(1).max(2147483647);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RecoveryContextSchema = z.object({
    sourceDocument: z.string().max(8192), sourceDigest: hashSchema, executionArn: z.string().max(300), sourceVersion: z.string().max(300),
    leaseToken: z.string().uuid(), poolGeneration: positiveRecovery,
    proof: z.object({ historyDigest: hashSchema, attachEntered: positiveRecovery, attachAcknowledged: positiveRecovery,
        terminal: positiveRecovery, claimNeverRan: z.literal(true), redriveCount: z.literal(0), status: z.literal('FAILED') }).strict(),
}).strict();
type RecoveryContext = z.infer<typeof RecoveryContextSchema>;
export type AdoptRecoveryWork = LifecycleWork & { intent: LifecycleIntent & { adoptRecoverRelease: RecoveryContext } };
type RecoveryExecution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
export type AdoptRecoveryDeps = ReceiptDeps;
const rowsRecovery = (r: unknown): Record<string, unknown>[] => Array.isArray(r) ? r : (r as { rows: Record<string, unknown>[] }).rows;
const guardRecovery = (ok: unknown): void => { if (!ok) throw new Error('adopt_recovery_guard'); };

/** Separate builder keeps the ordinary app intent schema closed. */
export function buildAdoptRecoveryWork(input: unknown): AdoptRecoveryWork {
    const { adoptRecoverRelease, ...base } = input as Record<string, unknown>;
    const c = RecoveryContextSchema.parse(adoptRecoverRelease), normal = buildLifecycleWork(LifecycleIntentSchema.parse(base)), i = normal.intent;
    const source = buildLifecycleWork(JSON.parse(c.sourceDocument)), s = source.intent;
    guardRecovery(i.operation === 'release' && !i.rebasePreparation && s.operation === 'adopt' && !s.rebasePreparation
        && s.dataVolumeId && s.poolHostId && s.jobId !== i.jobId && hashRecovery(c.sourceDocument) === c.sourceDigest
        && source.digest === c.sourceDigest && JSON.parse(source.input).document === c.sourceDocument
        && c.sourceVersion === source.stateMachineArn && source.stateMachineArn !== normal.stateMachineArn && c.executionArn === lifecycleExecutionArn(s.deployment, s.jobId)
        && ['computerId', 'targetGeneration', 'leaseEpoch', 'fenceToken', 'providerInstanceId', 'dataVolumeId', 'instanceType']
            .every(k => s[k as keyof LifecycleIntent] === i[k as keyof LifecycleIntent])
        && ['accountId', 'region', 'zoneId', 'namespace', 'subnetId', 'securityGroupId', 'launchTemplateId', 'dataKeyArn', 'storage']
            .every(k => canonicalRecovery(s.deployment[k as keyof LifecycleDeployment]) === canonicalRecovery(i.deployment[k as keyof LifecycleDeployment]))
        && c.proof.attachEntered < c.proof.attachAcknowledged && c.proof.attachAcknowledged < c.proof.terminal);
    const intent = { ...i, adoptRecoverRelease: c }, document = canonicalRecovery(intent), digest = hashRecovery(document);
    guardRecovery(Buffer.byteLength(document) <= 16384);
    return { ...normal, intent, digest, input: JSON.stringify({ schemaVersion: 1, document, digest }) };
}
export function adoptRecoveryReplay(p: Placement): AdoptRecoveryWork | null {
    if (!p.lastError?.startsWith(ADOPT_RECOVERY)) return null;
    try { return buildAdoptRecoveryWork(JSON.parse(p.lastError.slice(ADOPT_RECOVERY.length))); } catch { return null; }
}
export function matchesAdoptRecovery(p: Placement, w: LifecycleWork): boolean {
    const i = w.intent;
    return p.provider === 'aws-ec2' && p.lifecycleJobId === i.jobId && p.lifecycleDigest === w.digest
        && p.computerId === i.computerId && p.generation === i.targetGeneration && p.leaseEpoch === i.leaseEpoch
        && p.fenceToken === i.fenceToken && p.instanceId === i.providerInstanceId && p.volumeId === i.dataVolumeId
        && p.instanceType === i.instanceType && p.region === i.deployment.region && p.zoneId === i.deployment.zoneId;
}
function noEnrollment(p: Placement): boolean {
    return p.enrollNonceHash === null && p.enrollConsumedHash === null && p.enrollExpiresAt === null;
}
async function recoveryPoolRow(tx: PlacementExecutor, p: Placement, c: RecoveryContext, lock: boolean) {
    const s = buildLifecycleWork(JSON.parse(c.sourceDocument)).intent;
    const rows = rowsRecovery(await tx.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts
        WHERE id = ${s.poolHostId}::uuid ${lock ? sql`FOR UPDATE` : sql``}`));
    guardRecovery(rows.length === 1);
    const r = rows[0]!;
    guardRecovery(r.id === s.poolHostId && r.state === 'leased' && r.instance_id === p.instanceId
        && r.leased_computer_id === p.computerId && Number(r.generation) === c.poolGeneration
        && Number(r.leased_generation) === c.poolGeneration && r.lease_token === c.leaseToken
        && r.region === p.region && r.zone_id === p.zoneId && r.instance_type === p.instanceType
        && ['claim_generation', 'claim_lease_epoch', 'claim_fence', 'claim_volume_serial', 'session_ready_at'].every(k => r[k] === null));
    return r;
}
export async function authorizeAdoptRecovery(tx: PlacementExecutor, p: Placement, lock = false): Promise<boolean> {
    try {
        const w = adoptRecoveryReplay(p);
        if (p.state !== 'RECOVERING' || !w || !matchesAdoptRecovery(p, w) || !noEnrollment(p) || !isPoolMode(w.intent.deployment)) return false;
        const computer = await readCanaryComputer(tx, p.computerId);
        if (!computer || computer.deleted || computer.userId !== p.ownerUserId) return false;
        await recoveryPoolRow(tx, p, w.intent.adoptRecoverRelease, lock);
        await assertUnopenedAdoptUsage(tx, p);
        return true;
    } catch { return false; }
}

/** Only complete provider history can authorize an acknowledged, unclaimed adopt. */
export function proveFailedAdoptHistory(e: RecoveryExecution, w: LifecycleWork, events: HistoryEvent[]): RecoveryContext['proof'] {
    guardRecovery(e.status === 'FAILED' && e.error === 'LifecycleUnconfirmed' && e.redriveCount === 0 && !e.stateMachineAliasArn
        && e.executionArn === lifecycleExecutionArn(w.intent.deployment, w.intent.jobId) && e.stateMachineVersionArn === w.stateMachineArn
        && e.input === w.input && events.length > 4 && events[0]?.type === 'ExecutionStarted'
        && events[0].executionStartedEventDetails?.input === w.input && events.at(-1)?.type === 'ExecutionFailed');
    for (const [index, event] of events.entries()) {
        guardRecovery(event.id === index + 1 && (index === 0 || (Number.isInteger(event.previousEventId) && event.previousEventId! < event.id!))
            && event.type !== 'ExecutionRedriven' && event.stateEnteredEventDetails?.name !== 'claimInstance'
            && !Object.values(event).some(v => v && typeof v === 'object' && ('inputDetails' in v && (v.inputDetails as { truncated?: boolean })?.truncated
                || 'outputDetails' in v && (v.outputDetails as { truncated?: boolean })?.truncated)));
    }
    const enters = events.filter(v => v.type === 'TaskStateEntered' && v.stateEnteredEventDetails?.name === 'attachVolume');
    guardRecovery(enters.length === 1);
    const entered = enters[0]!;
    const scheduled = events.find(v => v.type === 'TaskScheduled' && v.previousEventId === entered.id);
    const details = scheduled?.taskScheduledEventDetails;
    guardRecovery(details?.resource === 'attachVolume' && details.resourceType === 'aws-sdk:ec2');
    const parameters = JSON.parse(details!.parameters!);
    guardRecovery(parameters.InstanceId === w.intent.providerInstanceId && parameters.VolumeId === w.intent.dataVolumeId && parameters.Device === '/dev/sdf');
    const started = events.find(v => v.type === 'TaskStarted' && v.previousEventId === scheduled?.id);
    const ack = events.find(v => v.type === 'TaskSucceeded' && v.previousEventId === started?.id);
    guardRecovery(started && ack && ack.taskSucceededEventDetails?.resource === 'attachVolume'
        && ack.taskSucceededEventDetails.resourceType === 'aws-sdk:ec2');
    return { historyDigest: hashRecovery(canonicalRecovery(events)), attachEntered: entered.id!, attachAcknowledged: ack!.id!,
        terminal: events.at(-1)!.id!, claimNeverRan: true, redriveCount: 0, status: 'FAILED' };
}
async function adoptResourceEvidence(deps: ReceiptDeps, p: Placement, s: LifecycleIntent, released = false): Promise<void> {
    const d = s.deployment;
    guardRecovery(deps.describer?.describeVolume);
    const v = await deps.describer!.describeVolume!(p.region!, p.volumeId!);
    guardRecovery(v && v.volumeId === p.volumeId && v.encrypted === true && v.kmsKeyId === d.dataKeyArn && v.zoneId === d.zoneId
        && Object.entries({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace, 'ezil:computer-id': p.computerId,
            'ezil:generation': String(p.generation), 'ezil:fence-token': p.fenceToken! }).every(([k, value]) => v.tags?.[k] === value)
        && Object.entries({ 'ezil:computer': p.computerId, 'ezil:fence': p.fenceToken! }).every(([k, value]) => v.tags?.[k] === undefined || v.tags[k] === value));
    if (released) {
        const releasedHost = await deps.describer!.describeForEnrollment(p.region!, p.instanceId!);
        guardRecovery(releasedHost && releasedHost.instanceId === p.instanceId && releasedHost.state === 'terminated');
        guardRecovery(v!.state === 'available' && v!.attachments?.length === 0);
        return;
    }
    guardRecovery(v!.state === 'in-use' && v!.attachments?.length === 1
        && v!.attachments[0]!.instanceId === p.instanceId && v!.attachments[0]!.state === 'attached');
    const h = await deps.describer!.describeForEnrollment(p.region!, p.instanceId!);
    guardRecovery(h && h.instanceId === p.instanceId && (h.state === 'running' || h.state === 'stopped') && h.imageId === d.amiId && h.instanceType === p.instanceType
        && h.availabilityZoneId === d.zoneId && h.rootDeviceName === (d.storage.rootDeviceName ?? '/dev/sda1')
        && Object.entries({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace, 'ezil:namespace': d.namespace,
            'ezil:pool': '1', 'ezil:pool-host': s.poolHostId!, 'aws:ec2launchtemplate:id': d.launchTemplateId }).every(([k, value]) => h.tags[k] === value)
        && ['ezil:computer', 'ezil:computer-id', 'ezil:generation', 'ezil:fence', 'ezil:fence-token'].every(k => h.tags[k] === undefined)
        && h.volumes.length === 2 && h.volumes.filter(v => v.deviceName === h.rootDeviceName && v.volumeId !== p.volumeId && v.deleteOnTermination).length === 1
        && h.volumes.filter(v => v.deviceName === '/dev/sdf' && v.volumeId === p.volumeId && !v.deleteOnTermination).length === 1);
}
/** Lock order matches admission/claim writers. EC2 and history preflight is read
 * before locking; identity, nonce and lease are revalidated in the same CAS. */
async function saveAdoptRecovery(deps: ReceiptDeps, p: Placement, w: AdoptRecoveryWork, complete: boolean): Promise<boolean> {
    return withAdmission(deps.db, async tx => {
        const current = await lockPoolClaimPlacement(tx, p.computerId);
        guardRecovery(current && current.state === p.state && current.updatedAt.getTime() === p.updatedAt.getTime()
            && current.lifecycleJobId === p.lifecycleJobId && current.lifecycleDigest === p.lifecycleDigest
            && current.generation === p.generation && current.leaseEpoch === p.leaseEpoch && current.instanceId === p.instanceId
            && current.volumeId === p.volumeId && current.fenceToken === p.fenceToken && noEnrollment(current));
        const row = await recoveryPoolRow(tx, current!, w.intent.adoptRecoverRelease, true);
        await assertUnopenedAdoptUsage(tx, current!);
        const scoped = { execute: tx.execute.bind(tx), transaction: <T>(fn: (tx: PlacementExecutor) => Promise<T>) => fn(tx) };
        const r = await writeLivePoolRecovery(scoped, current!, complete ? 'STOPPED' : 'RECOVERING', complete
            ? { lifecycleJobId: null, lifecycleDigest: null, lastError: POOL_RELEASED, leaseUntil: null }
            : { lifecycleJobId: w.intent.jobId, lifecycleDigest: w.digest, lastError: ADOPT_RECOVERY + JSON.stringify(w.intent) }, undefined, complete ? 'unopened-adopt' : undefined);
        guardRecovery(r.ok);
        if (complete) {
            const changed = rowsRecovery(await tx.execute(sql`UPDATE public.ezil_compute_pool_hosts SET state = 'retired', updated_at = now()
                WHERE id = ${row.id}::uuid AND lease_token = ${w.intent.adoptRecoverRelease.leaseToken}::uuid AND state = 'leased' RETURNING id`));
            guardRecovery(changed.length === 1);
        }
        return true;
    });
}
export async function reconcileAdoptRecovery(deps: AdoptRecoveryDeps, p: Placement, d: LifecycleDeployment): Promise<boolean> {
    const marked = p.lastError?.startsWith(ADOPT_RECOVERY) ?? false;
    if (!['UNCONFIRMED', 'RECOVERING'].includes(p.state) || p.provider !== 'aws-ec2' || !isPoolMode(d)) return false;
    if (p.state === 'RECOVERING' && !marked) return false;
    let handled = marked;
    try {
        guardRecovery(deps.executions && p.lifecycleJobId && p.lifecycleDigest && p.region && p.instanceId && p.volumeId && noEnrollment(p));
        const saved = adoptRecoveryReplay(p);
        if (marked) guardRecovery(saved && matchesAdoptRecovery(p, saved));
        // One durable attempt per version. A failed attempt is a permanent hold,
        // including on newer versions: never discard its source or partial progress.
        if (saved && p.state === 'UNCONFIRMED') return true;
        let e: RecoveryExecution;
        try { e = await deps.executions!.describe(p.region!, lifecycleExecutionArn(saved?.intent.deployment ?? d, p.lifecycleJobId!)); }
        catch (error) {
            if (saved && p.state === 'RECOVERING' && isExecutionAbsent(error) && deps.starter) {
                guardRecovery(await authorizeAdoptRecovery(deps.db, p));
                await startLifecycleJob(deps.starter, p.region!, saved, deps.sleep); return true;
            }
            throw error;
        }
        if (saved) {
            guardRecovery(e.input === saved.input && e.executionArn === lifecycleExecutionArn(saved.intent.deployment, saved.intent.jobId)
                && e.stateMachineVersionArn === saved.stateMachineArn && !e.stateMachineAliasArn && e.redriveCount === 0);
            if (e.status === 'RUNNING') return true;
            if (e.status === 'SUCCEEDED' && p.state === 'RECOVERING') {
                const r = LifecycleReceiptSchema.parse(JSON.parse(e.output ?? ''));
                guardRecovery(r.jobId === p.lifecycleJobId && r.digest === p.lifecycleDigest && r.computerId === p.computerId
                    && r.generation === p.generation && r.leaseEpoch === p.leaseEpoch && r.fenceToken === p.fenceToken
                    && r.instanceId === p.instanceId && r.volumeId === p.volumeId && r.state === 'retired' && !r.instanceLost);
                await adoptResourceEvidence(deps, p, buildLifecycleWork(JSON.parse(saved.intent.adoptRecoverRelease.sourceDocument)).intent, true);
                await saveAdoptRecovery(deps, p, saved, true); return true;
            }
            // Never mint a fresh attempt from a recovery execution (including on
            // another release). An operator must establish a new source proof.
            if (['FAILED', 'TIMED_OUT', 'ABORTED'].includes(e.status) && p.state === 'RECOVERING')
                await writeLivePoolRecovery(deps.db, p, 'UNCONFIRMED', {});
            return true;
        }
        const envelope = JSON.parse(e.input ?? ''), original = buildLifecycleWork(JSON.parse(envelope.document));
        if (original.intent.operation !== 'adopt') return false;
        if (!deps.executions?.history) return false;
        handled = true;
        guardRecovery(p.state === 'UNCONFIRMED' && matchesAdoptRecovery(p, original) && e.input === original.input && deps.starter);
        const proof = proveFailedAdoptHistory(e, original, await deps.executions!.history!(p.region!, e.executionArn!));
        const s = original.intent;
        await adoptResourceEvidence(deps, p, s);
        const found = rowsRecovery(await deps.db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts WHERE id = ${s.poolHostId}::uuid`));
        guardRecovery(found.length === 1);
        const c: RecoveryContext = { sourceDocument: envelope.document, sourceDigest: original.digest, executionArn: e.executionArn!,
            sourceVersion: original.stateMachineArn, leaseToken: String(found[0]!.lease_token), poolGeneration: Number(found[0]!.generation), proof };
        const { poolHostId: ignored, ...base } = s;
        const w = buildAdoptRecoveryWork({ ...base, operation: 'release', jobId: randomUUID(), deployment: d, adoptRecoverRelease: c });
        await saveAdoptRecovery(deps, p, w, false);
        await startLifecycleJob(deps.starter!, p.region!, w, deps.sleep);
        return true;
    } catch (error) {
        console.warn('adopt-recovery guard', { reason: error instanceof Error && error.message === 'adopt_recovery_guard'
            ? 'adopt_recovery_guard' : 'adopt_recovery_error' });
        return handled;
    }
}
