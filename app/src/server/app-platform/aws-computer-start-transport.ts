import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, type S3ClientConfig } from '@aws-sdk/client-s3';
import { SFNClient, DescribeExecutionCommand, DescribeStateMachineCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { z } from 'zod';
import { canonicalConfiguration } from './computer-configuration';
import { ComputerStartWorkSchema, startReceiptMatches, type ComputerStartWork } from './computer-start-protocol';
import type { ComputerStartDeliveryOptions } from './computer-start-delivery';

const settingsSchema = z.object({ region: z.literal('us-east-1'), accountId: z.string().regex(/^[0-9]{12}$/),
    namespace: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), bucket: z.string().min(3).max(63).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
    kmsKeyArn: z.string().max(1024), stateMachineVersionArn: z.string().max(1024) }).strict();
export interface AwsComputerStartTransportOptions {
    settings: z.infer<typeof settingsSchema>;
    /** Explicit trusted federation; no environment/profile/IMDS fallback. */
    credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }>;
    /** Local SDK wire fixture only; never deployment or manifest input. */
    requestHandler?: S3ClientConfig['requestHandler'];
}
type Code = 'aws_start_invalid' | 'aws_start_unavailable' | 'aws_start_expired' | 'aws_start_conflict' | 'aws_start_workflow_failed';
export class AwsComputerStartError extends Error { constructor(readonly code: Code) { super(code); } }
const fail = (code: Code): never => { throw new AwsComputerStartError(code); };
const named = (e: unknown, name: string) => e instanceof Error && e.name === name;

/** Reads existing configuration and submits/observes one Standard execution.
 * The approved workflow must authenticate current authority, verify EC2/EBS,
 * install the exact protected startup record and observe the host receipt.
 * This adapter never creates configuration, keys, roles, machines or disks. */
export function createAwsComputerStartTransport(o: AwsComputerStartTransportOptions):
    Pick<ComputerStartDeliveryOptions, 'advanceStart'> & { destroy(): void } {
    const parsed = settingsSchema.safeParse(o.settings);
    if (!parsed.success || typeof o.credentials !== 'function') return fail('aws_start_invalid');
    const s = Object.freeze(parsed.data), prefix = `arn:aws:states:${s.region}:${s.accountId}`;
    const machine = new RegExp(`^${prefix}:stateMachine:([A-Za-z0-9_-]{1,80}):([1-9][0-9]*)$`).exec(s.stateMachineVersionArn);
    if (!machine || !new RegExp(`^arn:aws:kms:${s.region}:${s.accountId}:key/[a-f0-9-]{36}$`).test(s.kmsKeyArn)) return fail('aws_start_invalid');
    const machineArn = `${prefix}:stateMachine:${machine[1]}`;
    const credentials = async () => {
        const c = await o.credentials();
        if (!c || !/^ASIA[A-Z0-9]{16}$/.test(c.accessKeyId) || !c.secretAccessKey || !c.sessionToken
            || !(c.expiration instanceof Date) || !(c.expiration.getTime() > Date.now() + 30000)) return fail('aws_start_invalid');
        return c;
    };
    const common = { region: s.region, credentials, maxAttempts: 1,
        requestHandler: o.requestHandler ?? { connectionTimeout: 2000, requestTimeout: 7000, throwOnRequestTimeout: true } };
    const s3 = new S3Client({ ...common, endpoint: 'https://s3.us-east-1.amazonaws.com', forcePathStyle: true, followRegionRedirects: false });
    const sfn = new SFNClient({ ...common, endpoint: 'https://states.us-east-1.amazonaws.com' });
    const alive = (w: ComputerStartWork, signal: AbortSignal) => {
        if (signal.aborted) return fail('aws_start_unavailable');
        if (w.issuedAt > Date.now()/1000 || w.expiresAt <= Date.now()/1000) return fail('aws_start_expired');
    };
    async function configuration(w: ComputerStartWork, signal: AbortSignal) {
        const c = w.configuration, key = `${s.namespace}/computers/${w.scope.computerId}/generations/${w.scope.computerGeneration}/configurations/${c.configurationId}.json`;
        const value = await s3.send(new GetObjectCommand({ Bucket: s.bucket, Key: key, ExpectedBucketOwner: s.accountId,
            ChecksumMode: 'ENABLED' }), { abortSignal: signal });
        const body = value.Body;
        if (!body || !('destroy' in body)) { if (body && 'cancel' in body) await body.cancel(); return fail('aws_start_conflict'); }
        const cancel = () => body.destroy(new Error('start_configuration_aborted'));
        signal.addEventListener('abort', cancel, { once: true });
        try {
            alive(w, signal);
            if (!value.VersionId || value.VersionId === 'null' || value.VersionId.length > 1024 || value.ContentLength !== c.bytes
                || value.ContentType !== 'application/json' || value.ServerSideEncryption !== 'aws:kms' || value.SSEKMSKeyId !== s.kmsKeyArn
                || value.ChecksumSHA256 !== Buffer.from(c.digest, 'hex').toString('base64')) return fail('aws_start_conflict');
            let size = 0; const hash = createHash('sha256');
            for await (const chunk of body) {
                alive(w, signal); const bytes = Buffer.from(chunk); size += bytes.length;
                if (size > c.bytes) return fail('aws_start_conflict'); hash.update(bytes);
            }
            if (size !== c.bytes || hash.digest('hex') !== c.digest) return fail('aws_start_conflict');
            return { schemaVersion: 1, operation: 'prepare', configurationId: c.configurationId, scope: w.scope, revision: c.revision,
                digest: c.digest, object: { bucket: s.bucket, key, versionId: value.VersionId, sha256: c.digest, bytes: c.bytes } };
        } finally { signal.removeEventListener('abort', cancel); body.destroy(); }
    }
    async function advance(input: ComputerStartWork, signal: AbortSignal) {
        const parsed = ComputerStartWorkSchema.safeParse(input); if (!parsed.success) return fail('aws_start_invalid');
        const w = parsed.data;
        if (Buffer.byteLength(canonicalConfiguration(w)) > 16384 || w.deployment.accountId !== s.accountId
            || w.deployment.region !== s.region || w.deployment.namespace !== s.namespace) return fail('aws_start_invalid');
        alive(w, signal);
        const prepared = await configuration(w, signal), name = `start-${w.authorizationId}`;
        const executionArn = `${prefix}:execution:${machine![1]}:${name}`;
        const serialized = canonicalConfiguration({ schemaVersion: 1, work: w, configuration: prepared });
        const describe = async () => {
            alive(w, signal);
            try { return await sfn.send(new DescribeExecutionCommand({ executionArn }), { abortSignal: signal }); }
            catch (e) { if (named(e, 'ExecutionDoesNotExist')) return null; throw e; }
        };
        let execution = await describe();
        if (!execution) {
            const definition = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: s.stateMachineVersionArn,
                includedData: 'METADATA_ONLY' }), { abortSignal: signal });
            if (definition.stateMachineArn !== s.stateMachineVersionArn || definition.type !== 'STANDARD' || definition.status !== 'ACTIVE') {
                return fail('aws_start_conflict');
            }
            alive(w, signal);
            try {
                const result = await sfn.send(new StartExecutionCommand({ stateMachineArn: s.stateMachineVersionArn, name, input: serialized }), { abortSignal: signal });
                if (result.executionArn !== executionArn) return fail('aws_start_conflict');
                alive(w, signal); return { state: 'pending' as const };
            } catch (e) {
                if (e instanceof AwsComputerStartError || signal.aborted) throw e;
                execution = await describe(); if (!execution) throw e;
            }
        }
        alive(w, signal);
        if (execution.executionArn !== executionArn || execution.stateMachineArn !== machineArn
            || execution.stateMachineVersionArn !== s.stateMachineVersionArn || execution.stateMachineAliasArn || execution.name !== name
            || execution.input !== serialized || execution.redriveCount !== 0 || !execution.startDate
            || !Number.isFinite(execution.startDate.getTime()) || execution.startDate.getTime() < w.issuedAt*1000
            || execution.startDate.getTime() >= w.expiresAt*1000) return fail('aws_start_conflict');
        if (execution.status === 'RUNNING') return { state: 'pending' as const };
        if (execution.status !== 'SUCCEEDED') return fail('aws_start_workflow_failed');
        let receipt: unknown;
        try {
            if (!execution.output || Buffer.byteLength(execution.output) > 4096) return fail('aws_start_conflict');
            receipt = JSON.parse(execution.output);
        } catch { return fail('aws_start_conflict'); }
        if (!startReceiptMatches(w, receipt)) return fail('aws_start_conflict');
        return { state: 'started' as const, receipt };
    }
    return Object.freeze({ advanceStart: async (work: ComputerStartWork, signal: AbortSignal) => {
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, cancel = () => {};
        try {
            const aborted = new Promise<never>((_resolve, reject) => {
                cancel = () => { reject(new AwsComputerStartError('aws_start_unavailable')); controller.abort(); };
                signal.addEventListener('abort', cancel, { once: true }); timer = setTimeout(cancel, 12000);
            });
            if (signal.aborted) { cancel(); return await aborted; }
            const result = await Promise.race([aborted, advance(work, controller.signal)]);
            if (controller.signal.aborted) return fail('aws_start_unavailable');
            return result;
        } catch (e) { if (e instanceof AwsComputerStartError) throw e; return fail('aws_start_unavailable'); }
        finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
    }, destroy() { s3.destroy(); sfn.destroy(); } });
}
