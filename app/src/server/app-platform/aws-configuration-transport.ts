import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand, type S3ClientConfig } from '@aws-sdk/client-s3';
import { SFNClient, DescribeExecutionCommand, DescribeStateMachineCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { canonicalConfiguration } from './computer-configuration';
import type { ConfigurationDeliveryOptions, ConfigurationWork } from './configuration-delivery';
import { createHostControlClient } from './host-control-client';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const generation = z.number().int().min(1).max(2_147_483_647);
const scopeSchema = z.object({ computerId: uuid, computerGeneration: generation,
    providerInstanceId: z.string().regex(/^i-[a-f0-9]{17}$/), dataVolumeId: z.string().regex(/^vol-[a-f0-9]{17}$/),
    fenceToken: uuid }).strict();
const workSchema = z.object({ configurationId: uuid, scope: scopeSchema, revision: generation,
    digest: z.string().regex(/^[a-f0-9]{64}$/), configuration: z.string().max(262144) }).strict();
const settingsSchema = z.object({ region: z.literal('us-east-1'), accountId: z.string().regex(/^\d{12}$/),
    namespace: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    bucket: z.string().min(3).max(63).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
    kmsKeyArn: z.string(), stateMachineVersionArn: z.string(),
    controlDomain: z.string().max(180).regex(/^(?:[a-z][a-z0-9-]*\.)+[a-z]{2,}$/) }).strict();
type Settings = z.infer<typeof settingsSchema>;
export interface AwsConfigurationTransportOptions {
    settings: Settings;
    /** Mandatory trusted federation provider. Never fall back to environment,
     * shared profiles, instance metadata or a long-lived administrator key. */
    credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }>;
    /** Low-level SDK wire seam for local tests; not application configuration. */
    requestHandler?: S3ClientConfig['requestHandler'];
}
export class AwsConfigurationError extends Error {
    constructor(readonly code: 'aws_configuration_invalid' | 'aws_configuration_unavailable' | 'aws_configuration_conflict'
        | 'aws_configuration_expired' | 'aws_workflow_failed' | 'aws_host_binding_invalid') { super(code); }
}
type Operation = 'prepare' | 'reload';
type ObjectReference = { bucket: string; key: string; versionId: string; sha256: string; bytes: number };
const equal = (a: unknown, b: unknown) => canonicalConfiguration(a) === canonicalConfiguration(b);
const fail = (code: AwsConfigurationError['code']): never => { throw new AwsConfigurationError(code); };
const errorName = (error: unknown) => error instanceof Error ? error.name : '';
const versionSchema = z.string().min(1).max(1024).refine(value => value !== 'null');
const MAX_BYTES = 262144;
// Standard execution names are reusable after 90 days. Never create a missing
// execution from old staging, including after AWS has removed its history.
const START_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function checkedWork(input: ConfigurationWork): ConfigurationWork {
    const parsed = workSchema.safeParse(input);
    if (!parsed.success) return fail('aws_configuration_invalid');
    const work = parsed.data, bytes = Buffer.from(work.configuration);
    if (bytes.length > MAX_BYTES || createHash('sha256').update(bytes).digest('hex') !== work.digest) {
        return fail('aws_configuration_invalid');
    }
    try {
        const body = JSON.parse(work.configuration) as Record<string, unknown>;
        if (canonicalConfiguration(body) !== work.configuration || body.schemaVersion !== 1
            || body.computerId !== work.scope.computerId || body.computerGeneration !== work.scope.computerGeneration
            || body.configurationRevision !== work.revision || body.volumeId !== work.scope.dataVolumeId) {
            return fail('aws_configuration_invalid');
        }
    } catch { return fail('aws_configuration_invalid'); }
    return work;
}

/** Concrete AWS transport, intentionally not wired to a route/cron. The caller
 * must claim current database authority first. These checks do not grant roles,
 * authorize an installation, start compute, or prove a loaded configuration. */
export function createAwsConfigurationTransport(options: AwsConfigurationTransportOptions):
    Pick<ConfigurationDeliveryOptions, 'advancePreparation' | 'requestReload' | 'resolveHost'> & { destroy(): void } {
    const parsed = settingsSchema.safeParse(options.settings);
    if (!parsed.success || typeof options.credentials !== 'function') return fail('aws_configuration_invalid');
    const settings = parsed.data;
    const arnPrefix = `arn:aws:states:${settings.region}:${settings.accountId}`;
    const machine = new RegExp(`^${arnPrefix}:stateMachine:([A-Za-z0-9_-]{1,80}):([1-9][0-9]*)$`)
        .exec(settings.stateMachineVersionArn);
    if (!machine || !new RegExp(`^arn:aws:kms:${settings.region}:${settings.accountId}:key/[a-f0-9-]{36}$`)
        .test(settings.kmsKeyArn)) return fail('aws_configuration_invalid');
    const stateMachineArn = `${arnPrefix}:stateMachine:${machine[1]}`;
    const credentials = async () => {
        const value = await options.credentials();
        if (!value || !/^ASIA[A-Z0-9]{16}$/.test(value.accessKeyId) || !value.secretAccessKey || !value.sessionToken
            || !(value.expiration instanceof Date) || !(value.expiration.getTime() > Date.now() + 30000)) {
            return fail('aws_configuration_invalid');
        }
        return { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey,
            sessionToken: value.sessionToken, expiration: value.expiration };
    };
    const clientOptions = { region: settings.region, credentials, maxAttempts: 1,
        requestHandler: options.requestHandler ?? { connectionTimeout: 2000, requestTimeout: 7000, throwOnRequestTimeout: true } };
    // Explicit endpoints prevent process-level endpoint overrides sending signed
    // configuration or credentials to a different service. No automatic retries.
    const s3 = new S3Client({ ...clientOptions, endpoint: 'https://s3.us-east-1.amazonaws.com',
        forcePathStyle: true, followRegionRedirects: false });
    const sfn = new SFNClient({ ...clientOptions, endpoint: 'https://states.us-east-1.amazonaws.com' });
    const secrets = new SecretsManagerClient({ ...clientOptions, endpoint: 'https://secretsmanager.us-east-1.amazonaws.com' });

    async function bounded<T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel = () => {};
        try {
            if (signal.aborted) return fail('aws_configuration_unavailable');
            const interrupted = new Promise<never>((_resolve, reject) => {
                cancel = () => { reject(new AwsConfigurationError('aws_configuration_unavailable')); controller.abort(); };
                signal.addEventListener('abort', cancel, { once: true });
                timer = setTimeout(cancel, 8000);
            });
            return await Promise.race([interrupted, action(controller.signal)]);
        } catch (error) {
            if (error instanceof AwsConfigurationError) throw error;
            // No provider messages, response bodies, paths or secret causes.
            return fail('aws_configuration_unavailable');
        } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
    }

    async function stage(work: ConfigurationWork, signal: AbortSignal) {
        const key = `${settings.namespace}/computers/${work.scope.computerId}/generations/${work.scope.computerGeneration}/configurations/${work.configurationId}.json`;
        const input = { Bucket: settings.bucket, Key: key, ExpectedBucketOwner: settings.accountId };
        const bytes = Buffer.from(work.configuration), checksum = Buffer.from(work.digest, 'hex').toString('base64');
        const read = async () => {
            const value = await s3.send(new GetObjectCommand({ ...input, ChecksumMode: 'ENABLED' }), { abortSignal: signal });
            const body = value.Body;
            if (!body || !('destroy' in body) || !('iterator' in body)) {
                if (body && 'destroy' in body && typeof body.destroy === 'function') body.destroy();
                else if (body && 'cancel' in body) await body.cancel();
                return fail('aws_configuration_conflict');
            }
            const interrupt = () => body.destroy(new Error('configuration_read_aborted'));
            signal.addEventListener('abort', interrupt, { once: true });
            try {
                if (signal.aborted) return fail('aws_configuration_unavailable');
                if (!versionSchema.safeParse(value.VersionId).success || value.ContentLength !== bytes.length
                    || value.ContentType !== 'application/json' || value.ServerSideEncryption !== 'aws:kms'
                    || value.SSEKMSKeyId !== settings.kmsKeyArn || value.ChecksumSHA256 !== checksum
                    || !value.LastModified || !Number.isFinite(value.LastModified.getTime())) return fail('aws_configuration_conflict');
                let length = 0; const chunks: Buffer[] = [];
                for await (const chunk of body) {
                    const part = Buffer.from(chunk); length += part.length;
                    if (length > bytes.length) return fail('aws_configuration_conflict');
                    chunks.push(part);
                }
                if (!Buffer.concat(chunks).equals(bytes)) return fail('aws_configuration_conflict');
                return { reference: { bucket: settings.bucket, key, versionId: value.VersionId!,
                    sha256: work.digest, bytes: bytes.length } satisfies ObjectReference, createdAt: value.LastModified.getTime() };
            } finally { signal.removeEventListener('abort', interrupt); body.destroy(); }
        };
        try { return await read(); }
        catch (error) { if (errorName(error) !== 'NoSuchKey') throw error; }
        try {
            await s3.send(new PutObjectCommand({ ...input, Body: bytes, ContentLength: bytes.length,
                ContentType: 'application/json', IfNoneMatch: '*', ChecksumSHA256: checksum,
                ServerSideEncryption: 'aws:kms', SSEKMSKeyId: settings.kmsKeyArn }), { abortSignal: signal });
        } catch (error) {
            if (signal.aborted) throw error;
            // A concurrent put or lost response may already have committed the
            // object. Read it once; never overwrite it or invent a new key.
        }
        return read();
    }

    async function advance(input: ConfigurationWork, operation: Operation, signal: AbortSignal) {
        const work = checkedWork(input);
        const staged = await stage(work, signal);
        const name = `configuration-${operation}-${work.configurationId}`;
        const executionArn = `${arnPrefix}:execution:${machine![1]}:${name}`;
        const request = { schemaVersion: 1, operation, configurationId: work.configurationId, scope: work.scope,
            revision: work.revision, digest: work.digest, object: staged.reference };
        const serialized = canonicalConfiguration(request);
        const descriptor = { computerId: work.scope.computerId, computerGeneration: work.scope.computerGeneration,
            configurationRevision: work.revision, configurationDigest: work.digest };
        const describe = async () => {
            try {
                return await sfn.send(new DescribeExecutionCommand({ executionArn }), { abortSignal: signal });
            } catch (error) { if (errorName(error) === 'ExecutionDoesNotExist') return null; throw error; }
        };
        let execution = await describe();
        if (!execution) {
            if (Date.now() - staged.createdAt > START_WINDOW_MS || staged.createdAt > Date.now() + 60000) {
                return fail('aws_configuration_expired');
            }
            const definition = await sfn.send(new DescribeStateMachineCommand({
                stateMachineArn: settings.stateMachineVersionArn, includedData: 'METADATA_ONLY',
            }), { abortSignal: signal });
            if (definition.stateMachineArn !== settings.stateMachineVersionArn || definition.type !== 'STANDARD'
                || definition.status !== 'ACTIVE') return fail('aws_configuration_conflict');
            try {
                const started = await sfn.send(new StartExecutionCommand({ stateMachineArn: settings.stateMachineVersionArn,
                    name, input: serialized }), { abortSignal: signal });
                if (started.executionArn !== executionArn) return fail('aws_configuration_conflict');
                // Submission, including idempotent RUNNING acceptance, cannot
                // certify preparation. Observe on a later delivery poll.
                return { state: 'pending' as const };
            } catch (error) {
                if (error instanceof AwsConfigurationError || signal.aborted) throw error;
                execution = await describe();
                if (!execution) throw error;
            }
        }
        if (execution.executionArn !== executionArn || execution.stateMachineArn !== stateMachineArn
            || execution.stateMachineVersionArn !== settings.stateMachineVersionArn || execution.stateMachineAliasArn
            || execution.name !== name || execution.input !== serialized || execution.redriveCount !== 0) {
            return fail('aws_configuration_conflict');
        }
        if (execution.status === 'RUNNING') return { state: 'pending' as const };
        if (execution.status !== 'SUCCEEDED') return fail('aws_workflow_failed');
        let output: unknown;
        try {
            if (!execution.output || Buffer.byteLength(execution.output) > 4096) return fail('aws_configuration_conflict');
            output = JSON.parse(execution.output);
        } catch { return fail('aws_configuration_conflict'); }
        if (!equal(output, { schemaVersion: 1, operation, configurationId: work.configurationId, scope: work.scope, descriptor })) {
            return fail('aws_configuration_conflict');
        }
        return { state: 'prepared' as const, descriptor };
    }

    return {
        advancePreparation: (work, signal) => bounded(signal, inner => advance(work, 'prepare', inner)),
        requestReload: (work, signal) => bounded(signal, async inner => { await advance(work, 'reload', inner); }),
        resolveHost: (scope, signal) => bounded(signal, async inner => {
            if (!scopeSchema.safeParse(scope).success) return fail('aws_host_binding_invalid');
            const name = `${settings.namespace}/computers/${scope.computerId}/generations/${scope.computerGeneration}/control`;
            const value = await secrets.send(new GetSecretValueCommand({ SecretId: name, VersionStage: 'AWSCURRENT' }), { abortSignal: inner });
            const prefix = `arn:aws:secretsmanager:${settings.region}:${settings.accountId}:secret:${name}-`;
            if (value.Name !== name || !value.ARN?.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(value.ARN.slice(prefix.length))
                || !value.VersionStages?.includes('AWSCURRENT') || value.SecretBinary || !value.SecretString
                || Buffer.byteLength(value.SecretString) > 4096) return fail('aws_host_binding_invalid');
            let json: unknown;
            try { json = JSON.parse(value.SecretString); } catch { return fail('aws_host_binding_invalid'); }
            const binding = z.object({ schemaVersion: z.literal(1), scope: scopeSchema, origin: z.string(),
                keyHex: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(json);
            const origin = `https://c-${scope.computerId}-g${scope.computerGeneration}.${settings.controlDomain}`;
            if (!binding.success || !equal(binding.data.scope, scope) || binding.data.origin !== origin) return fail('aws_host_binding_invalid');
            return createHostControlClient({ ...scope, origin, secret: Buffer.from(binding.data.keyHex, 'hex') });
        }),
        destroy() { s3.destroy(); sfn.destroy(); secrets.destroy(); },
    };
}
