import { S3Client, GetObjectCommand, PutObjectCommand, type S3ClientConfig } from '@aws-sdk/client-s3';
import { SFNClient, DescribeExecutionCommand, DescribeStateMachineCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { z } from 'zod';
import { canonicalConfiguration } from './computer-configuration';
import { ComputerMountWorkSchema, mountReceiptMatches, type ComputerMountWork } from './computer-mount-protocol';
import type { MountDeliveryOptions } from './computer-mount-delivery';

const settingsSchema = z.object({ region: z.literal('us-east-1'), accountId: z.string().regex(/^\d{12}$/),
    namespace: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    bucket: z.string().min(3).max(63).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
    kmsKeyArn: z.string().max(1024), stateMachineVersionArn: z.string().max(1024) }).strict();
export interface AwsComputerMountTransportOptions {
    settings: z.infer<typeof settingsSchema>;
    /** Explicit trusted federation. No default chain, local profile, IMDS or
     * administrator-key fallback is permitted in the control plane. */
    credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }>;
    /** Test-only SDK wire handler. No app configuration exposes this seam. */
    requestHandler?: S3ClientConfig['requestHandler'];
}
type ErrorCode = 'aws_mount_invalid' | 'aws_mount_unavailable' | 'aws_mount_conflict' | 'aws_mount_expired' | 'aws_mount_workflow_failed';
export class AwsComputerMountError extends Error {
    constructor(readonly code: ErrorCode) { super(code); }
}
const fail = (code: ErrorCode): never => { throw new AwsComputerMountError(code); };
const errorName = (e: unknown) => e instanceof Error ? e.name : '';
const versionSchema = z.string().min(1).max(1024).refine(v => v !== 'null');

/** S3/Standard transport only. The pinned workflow MUST reauthorize the exact
 * grant, observe the provider, provision independent root records and verify
 * the host receipt. A request cannot authorize itself. This module is not
 * scheduled/enabled and creates no computers, roles, buckets or workflows. */
export function createAwsComputerMountTransport(o: AwsComputerMountTransportOptions):
    Pick<MountDeliveryOptions, 'advanceMount'> & { destroy(): void } {
    const parsed = settingsSchema.safeParse(o.settings);
    if (!parsed.success || typeof o.credentials !== 'function') return fail('aws_mount_invalid');
    const s = parsed.data, prefix = `arn:aws:states:${s.region}:${s.accountId}`;
    const machine = new RegExp(`^${prefix}:stateMachine:([A-Za-z0-9_-]{1,80}):([1-9][0-9]*)$`).exec(s.stateMachineVersionArn);
    if (!machine || !new RegExp(`^arn:aws:kms:${s.region}:${s.accountId}:key/[a-f0-9-]{36}$`).test(s.kmsKeyArn)) return fail('aws_mount_invalid');
    const machineArn = `${prefix}:stateMachine:${machine[1]}`;
    const credentials = async () => {
        const c = await o.credentials();
        if (!c || !/^ASIA[A-Z0-9]{16}$/.test(c.accessKeyId) || !c.secretAccessKey || !c.sessionToken
            || !(c.expiration instanceof Date) || !(c.expiration.getTime() > Date.now() + 30000)) return fail('aws_mount_invalid');
        return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, expiration: c.expiration };
    };
    const common = { region: s.region, credentials, maxAttempts: 1,
        requestHandler: o.requestHandler ?? { connectionTimeout: 2000, requestTimeout: 7000, throwOnRequestTimeout: true } };
    const s3 = new S3Client({ ...common, endpoint: 'https://s3.us-east-1.amazonaws.com', forcePathStyle: true, followRegionRedirects: false });
    const sfn = new SFNClient({ ...common, endpoint: 'https://states.us-east-1.amazonaws.com' });
    const alive = (work: ComputerMountWork, signal: AbortSignal) => {
        if (signal.aborted) return fail('aws_mount_unavailable');
        const now = Date.now() / 1000;
        if (work.authorization.issuedAt > now || work.authorization.expiresAt <= now) return fail('aws_mount_expired');
    };

    async function stage(work: ComputerMountWork, signal: AbortSignal) {
        const a = work.authorization;
        const key = `${s.namespace}/computers/${a.scope.computerId}/generations/${a.scope.computerGeneration}/data-mounts/${a.authorizationId}.json`;
        const request = { Bucket: s.bucket, Key: key, ExpectedBucketOwner: s.accountId };
        const bytes = Buffer.from(canonicalConfiguration(work.plan)), checksum = Buffer.from(a.digest, 'hex').toString('base64');
        const read = async () => {
            alive(work, signal);
            const value = await s3.send(new GetObjectCommand({ ...request, ChecksumMode: 'ENABLED' }), { abortSignal: signal });
            const body = value.Body;
            if (!body || !('destroy' in body)) {
                if (body && 'cancel' in body) await body.cancel();
                return fail('aws_mount_conflict');
            }
            const abort = () => body.destroy(new Error('mount_read_cancelled'));
            signal.addEventListener('abort', abort, { once: true });
            try {
                alive(work, signal);
                if (!versionSchema.safeParse(value.VersionId).success || value.ContentLength !== bytes.length
                    || value.ContentType !== 'application/json' || value.ServerSideEncryption !== 'aws:kms'
                    || value.SSEKMSKeyId !== s.kmsKeyArn || value.ChecksumSHA256 !== checksum) return fail('aws_mount_conflict');
                let length = 0; const chunks: Buffer[] = [];
                for await (const chunk of body) {
                    alive(work, signal);
                    const part = Buffer.from(chunk); length += part.length;
                    if (length > bytes.length) return fail('aws_mount_conflict');
                    chunks.push(part);
                }
                if (!Buffer.concat(chunks).equals(bytes)) return fail('aws_mount_conflict');
                return { bucket: s.bucket, key, versionId: value.VersionId!, sha256: a.digest, bytes: bytes.length };
            } finally { signal.removeEventListener('abort', abort); body.destroy(); }
        };
        try { return await read(); } catch (e) { if (errorName(e) !== 'NoSuchKey') throw e; }
        alive(work, signal);
        try {
            await s3.send(new PutObjectCommand({ ...request, Body: bytes, ContentLength: bytes.length, ContentType: 'application/json',
                IfNoneMatch: '*', ChecksumSHA256: checksum, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: s.kmsKeyArn }), { abortSignal: signal });
        } catch {
            // A lost response or racing writer may have committed. Read once,
            // verify the exact content/version, never overwrite or choose a new key.
            alive(work, signal);
        }
        return read();
    }

    async function advance(input: ComputerMountWork, signal: AbortSignal) {
        const result = ComputerMountWorkSchema.safeParse(input);
        if (!result.success) return fail('aws_mount_invalid');
        const work = result.data, a = work.authorization;
        if (Buffer.byteLength(canonicalConfiguration(work)) > 16384 || work.deployment.accountId !== s.accountId
            || work.deployment.region !== s.region || work.deployment.namespace !== s.namespace) {
            return fail('aws_mount_invalid');
        }
        alive(work, signal);
        const object = await stage(work, signal), name = `mount-${a.authorizationId}`;
        const executionArn = `${prefix}:execution:${machine![1]}:${name}`;
        // Contains identifiers/authority references, never credentials. The
        // controller independently authorizes it; root files are not self-issued.
        const serialized = canonicalConfiguration({ schemaVersion: 1, work, object });
        const describe = async () => {
            alive(work, signal);
            try { return await sfn.send(new DescribeExecutionCommand({ executionArn }), { abortSignal: signal }); }
            catch (e) { if (errorName(e) === 'ExecutionDoesNotExist') return null; throw e; }
        };
        let execution = await describe();
        if (!execution) {
            alive(work, signal);
            const definition = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: s.stateMachineVersionArn,
                includedData: 'METADATA_ONLY' }), { abortSignal: signal });
            if (definition.stateMachineArn !== s.stateMachineVersionArn || definition.type !== 'STANDARD' || definition.status !== 'ACTIVE') {
                return fail('aws_mount_conflict');
            }
            alive(work, signal);
            try {
                const started = await sfn.send(new StartExecutionCommand({ stateMachineArn: s.stateMachineVersionArn, name, input: serialized }),
                    { abortSignal: signal });
                if (started.executionArn !== executionArn) return fail('aws_mount_conflict');
                alive(work, signal);
                return { state: 'pending' as const };
            } catch (e) {
                if (e instanceof AwsComputerMountError || signal.aborted) throw e;
                execution = await describe();
                if (!execution) throw e;
            }
        }
        alive(work, signal);
        if (execution.executionArn !== executionArn || execution.stateMachineArn !== machineArn
            || execution.stateMachineVersionArn !== s.stateMachineVersionArn || execution.stateMachineAliasArn
            || execution.name !== name || execution.input !== serialized || execution.redriveCount !== 0
            || !execution.startDate || !Number.isFinite(execution.startDate.getTime())
            || execution.startDate.getTime() < a.issuedAt * 1000 || execution.startDate.getTime() >= a.expiresAt * 1000) {
            return fail('aws_mount_conflict');
        }
        if (execution.status === 'RUNNING') return { state: 'pending' as const };
        if (execution.status !== 'SUCCEEDED') return fail('aws_mount_workflow_failed');
        let receipt: unknown;
        try {
            if (!execution.output || Buffer.byteLength(execution.output) > 4096) return fail('aws_mount_conflict');
            receipt = JSON.parse(execution.output);
        } catch { return fail('aws_mount_conflict'); }
        if (!mountReceiptMatches(work, receipt)) return fail('aws_mount_conflict');
        return { state: 'mounted' as const, receipt };
    }

    return {
        advanceMount: async (input, signal) => {
            const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
            let cancel = () => {};
            try {
                if (signal.aborted) return fail('aws_mount_unavailable');
                const interrupted = new Promise<never>((_resolve, reject) => {
                    cancel = () => { reject(new AwsComputerMountError('aws_mount_unavailable')); controller.abort(); };
                    signal.addEventListener('abort', cancel, { once: true }); timer = setTimeout(cancel, 8000);
                });
                return await Promise.race([interrupted, advance(input, controller.signal)]);
            } catch (e) { if (e instanceof AwsComputerMountError) throw e; return fail('aws_mount_unavailable'); }
            finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
        },
        destroy() { s3.destroy(); sfn.destroy(); },
    };
}
