import { createHash } from 'node:crypto';
import { z } from 'zod';
import { UUID, strictJson } from './strict-json.js';
import { PreparationReferenceSchema, validateIntentLease } from './lease.js';

const uuid = UUID;
const positive = z.number().int().min(1).max(2147483647);
export { LifecycleDeploymentSchema, type LifecycleDeployment } from './deployment.js';
import { InstanceTypeSchema, LifecycleDeploymentSchema, POOL_INSTANCE_TYPES } from './deployment.js';
const instance = z.string().regex(/^i-[a-f0-9]{17}$/), volume = z.string().regex(/^vol-[a-f0-9]{17}$/);
/** Evidence is minted by the app from a complete, non-redriven failed execution.
 * The original document is retained byte-for-byte; its digest pins the old AMI. */
export const AdoptRecoverySchema = z.object({
    sourceDocument: z.string().max(8192), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    executionArn: z.string().max(300), sourceVersion: z.string().max(300),
    leaseToken: uuid, poolGeneration: positive,
    proof: z.object({ historyDigest: z.string().regex(/^[a-f0-9]{64}$/),
        attachEntered: positive, attachAcknowledged: positive, terminal: positive,
        claimNeverRan: z.literal(true), redriveCount: z.literal(0), status: z.literal('FAILED'),
    }).strict(),
}).strict();
export const LifecycleIntentSchema = z.object({
    schemaVersion: z.literal(1), jobId: uuid, computerId: uuid, revision: positive,
    operation: z.enum(['provision', 'start', 'stop', 'replace', 'retire', 'pool-provision', 'pool-retire', 'adopt', 'release']), targetGeneration: positive, fenceToken: uuid,
    poolHostId: uuid.optional(), poolGeneration: positive.optional(),
    providerInstanceId: instance.nullable(), dataVolumeId: volume.nullable(), previousGeneration: positive.nullable(),
    previousInstanceId: instance.nullable(), previousFenceToken: uuid.nullable(), deployment: LifecycleDeploymentSchema,
    // R10/R11: the computer's tier picks a type from the deployment allowlist
    // and, on provision only, a data size inside the configured range.
    instanceType: InstanceTypeSchema, dataVolumeGiB: z.number().int().min(1).max(16384).nullable(),
    // C-2/C-3: generation is the writer generation (tags); leaseEpoch rises on
    // every lease without retagging AWS resources.
    leaseEpoch: positive,
    // C-6: base64 user data carrying the one-time enrollment nonce. Required on
    // a launch, optional on a start-in-place (flagged), absent otherwise.
    userData: z.string().max(4096).regex(/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$|^(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/).nullable(),
    rebasePreparation: PreparationReferenceSchema.optional(),
    adoptRecoverRelease: AdoptRecoverySchema.optional(),
}).strict().refine(i => {
    if (i.adoptRecoverRelease && (i.operation !== 'release' || i.rebasePreparation)) return false;
    const pool = ['pool-provision', 'pool-retire', 'adopt', 'release'].includes(i.operation);
    if (pool && !POOL_INSTANCE_TYPES.some(t => t === i.instanceType)) return false;
    if (['pool-provision', 'pool-retire', 'adopt'].includes(i.operation) !== (i.poolHostId !== undefined)) return false;
    if ((['pool-provision', 'pool-retire'].includes(i.operation)) !== (i.poolGeneration !== undefined)) return false;
    if (['provision', 'replace'].includes(i.operation) !== (i.userData !== null) && i.operation !== 'start') return false;
    if (!i.deployment.instanceTypes.includes(i.instanceType)) return false;
    if ((i.operation === 'provision' || (i.operation === 'adopt' && i.dataVolumeId === null)) !== (i.dataVolumeGiB !== null)) return false;
    if (i.dataVolumeGiB !== null && (i.dataVolumeGiB < i.deployment.storage.dataMinGiB
        || i.dataVolumeGiB > i.deployment.storage.dataMaxGiB)) return false;
    if (i.operation === 'replace') return i.providerInstanceId === null && i.dataVolumeId !== null
        && i.previousGeneration !== null && i.previousGeneration < i.targetGeneration
        && i.previousInstanceId !== null && i.previousFenceToken !== null && i.previousFenceToken !== i.fenceToken;
    if (i.previousGeneration !== null || i.previousInstanceId !== null || i.previousFenceToken !== null) return false;
    if (i.operation === 'pool-provision') return i.providerInstanceId === null && i.dataVolumeId === null
        && i.computerId === i.poolHostId && i.targetGeneration === i.poolGeneration;
    if (i.operation === 'pool-retire') return i.providerInstanceId !== null && i.dataVolumeId === null
        && i.computerId === i.poolHostId && i.targetGeneration === i.poolGeneration;
    if (i.operation === 'adopt') return i.providerInstanceId !== null;
    return i.operation === 'provision' ? i.providerInstanceId === null && i.dataVolumeId === null
        : i.providerInstanceId !== null && i.dataVolumeId !== null;
});
export type LifecycleIntent = z.infer<typeof LifecycleIntentSchema>;
export interface LifecycleWork { document: string; digest: string; createdAt: Date }
export class LifecycleError extends Error {
    constructor(readonly code: 'lifecycle_invalid' | 'lifecycle_unavailable' | 'lifecycle_conflict' | 'lifecycle_unconfirmed') { super(code); }
}
export function parseLifecycleWork(work: LifecycleWork): LifecycleIntent {
    try {
        if (!work || typeof work.document !== 'string' || Buffer.byteLength(work.document) > 16384
            || !/^[a-f0-9]{64}$/.test(work.digest) || !(work.createdAt instanceof Date) || !Number.isFinite(work.createdAt.getTime())
            || createHash('sha256').update(work.document, 'utf8').digest('hex') !== work.digest) throw new Error();
        const intent = LifecycleIntentSchema.parse(strictJson(work.document, 16384));
        if (intent.adoptRecoverRelease) validateAdoptRecovery(intent);
        validateIntentLease(intent);
        if (intent.rebasePreparation && JSON.stringify(intent) !== work.document) throw new Error();
        return intent;
    } catch { throw new LifecycleError('lifecycle_invalid'); }
}

export function validateAdoptRecovery(i: LifecycleIntent): LifecycleIntent {
    const c = i.adoptRecoverRelease!;
    const source = LifecycleIntentSchema.parse(strictJson(c.sourceDocument, 8192));
    const ordered = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);
    const same = (a: unknown, b: unknown): boolean => ordered(a) === ordered(b);
    if (source.operation !== 'adopt' || source.adoptRecoverRelease || source.rebasePreparation
        || createHash('sha256').update(c.sourceDocument).digest('hex') !== c.sourceDigest
        || c.sourceVersion !== source.deployment.stateMachineVersionArn
        || c.executionArn !== c.sourceVersion.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:computer-${source.jobId}`)
        || source.jobId === i.jobId || !source.poolHostId || !source.dataVolumeId
        || !['computerId', 'targetGeneration', 'leaseEpoch', 'fenceToken', 'providerInstanceId', 'dataVolumeId', 'instanceType']
            .every(k => same(source[k as keyof LifecycleIntent], i[k as keyof LifecycleIntent]))
        || !['accountId', 'region', 'zoneId', 'namespace', 'subnetId', 'securityGroupId', 'launchTemplateId', 'dataKeyArn', 'storage']
            .every(k => same(source.deployment[k as keyof typeof source.deployment], i.deployment[k as keyof typeof i.deployment]))
        || c.proof.attachEntered >= c.proof.attachAcknowledged || c.proof.attachAcknowledged >= c.proof.terminal)
        throw new Error('lifecycle_adopt_recovery_invalid');
    return source;
}

/** Output is a provider receipt only. It never certifies mounted disk, host
 * configuration, application readiness, ownership or permission to launch. */
export const LifecycleReceiptSchema = z.object({
    schemaVersion: z.literal(1), jobId: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/),
    computerId: uuid, generation: positive, leaseEpoch: positive, fenceToken: uuid, instanceId: instance, volumeId: volume.nullable(),
    poolHostId: uuid.optional(), poolGeneration: positive.optional(),
    state: z.enum(['running', 'stopped', 'retired']),
    /** Only on a `stopped` receipt: the instance was already gone (terminated externally); the
     * retained volume was verified free and this computer's, and the next wake must REPLACE. */
    instanceLost: z.literal(true).optional(),
}).strict().refine(r => !r.instanceLost || r.state === 'stopped', { message: 'instance_lost_on_stop_only' });
export type LifecycleReceipt = z.infer<typeof LifecycleReceiptSchema>;
export function validateLifecycleReceipt(work: LifecycleWork, input: unknown): LifecycleReceipt {
    const intent = parseLifecycleWork(work), parsed = LifecycleReceiptSchema.safeParse(input);
    if (!parsed.success) throw new LifecycleError('lifecycle_conflict');
    const r = parsed.data;
    const state = ['retire', 'release', 'pool-retire'].includes(intent.operation) ? 'retired' : intent.operation === 'stop' ? 'stopped' : 'running';
    if (['pool-provision', 'pool-retire'].includes(intent.operation) ? r.volumeId !== null || r.poolHostId !== intent.poolHostId || r.poolGeneration !== intent.poolGeneration
        : r.volumeId === null || r.poolHostId !== undefined || r.poolGeneration !== undefined) throw new LifecycleError('lifecycle_conflict');
    if (r.jobId !== intent.jobId || r.digest !== work.digest || r.computerId !== intent.computerId
        || r.generation !== intent.targetGeneration || r.leaseEpoch !== intent.leaseEpoch || r.fenceToken !== intent.fenceToken || r.state !== state
        || (intent.providerInstanceId !== null && r.instanceId !== intent.providerInstanceId)
        || (intent.dataVolumeId !== null && r.volumeId !== intent.dataVolumeId)
        || r.instanceId === intent.previousInstanceId) throw new LifecycleError('lifecycle_conflict');
    return r;
}
