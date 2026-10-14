/**
 * The app's real AWS clients (docs/AWS-COMPUTERS.md §5, app caller).
 *
 * - `LifecycleStarter`          → Step Functions `StartExecution` (exact version ARN)
 * - `LifecycleExecutionReader`  → Step Functions `DescribeExecution`
 * - `Ec2EnrollmentDescriber`    → EC2 `DescribeInstances` / `DescribeVolumes`
 *
 * 🔴 CREDENTIALS. There are NO long-lived AWS keys. The app runs on Vercel, and
 * every call is made with short-lived credentials from
 * `AssumeRoleWithWebIdentity` on the region's app-caller role, using the Vercel
 * OIDC token of the CURRENT request (`x-vercel-oidc-token` in the request
 * context, else `VERCEL_OIDC_TOKEN_FILE`, else `VERCEL_OIDC_TOKEN`; Vercel
 * docs, "OIDC Federation Reference"). Every client is built with an explicit
 * credentials function, so the SDK's default chain (env keys, shared files,
 * instance metadata) is never consulted. A missing token is
 * `aws_caller_unavailable`; there is no fallback of any kind.
 *
 * 🔴 REGIONS. A computer lives in its placement's region; every call names
 * that region, and an ARN from another region (or another account than the
 * caller role's) is refused before anything is sent.
 *
 * Nothing here is constructed while `EZIL_AWS_COMPUTERS_ENABLED` is off.
 */

import { readFileSync } from 'node:fs';

import { DescribeAvailabilityZonesCommand, DescribeInstancesCommand, DescribeVolumesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import { AWS_REGION_PATTERN, isAwsComputersEnabled, readAwsRegions, type Env } from './aws-config';
import type { Ec2EnrollmentDescriber, Ec2EnrollmentView } from './aws-enroll';
import type { LifecycleStarter } from './aws-ec2';
import type { LifecycleExecutionReader } from './aws-receipts';

// ── Errors ───────────────────────────────────────────────────────────────

export type AwsClientErrorCode =
    | 'aws_caller_unavailable' // no OIDC token, or STS refused/returned no credentials
    | 'aws_throttled' // retry later
    | 'aws_capacity' // a capacity or quota refusal
    | 'aws_config' // access denied, wrong ARN/region/account, missing role setting
    | 'aws_error'; // anything else

/** A machine-readable AWS failure. `awsName` is the SDK exception name, when there was one. */
export class AwsClientError extends Error {
    constructor(
        readonly code: AwsClientErrorCode,
        readonly retryable: boolean,
        readonly awsName?: string,
    ) {
        super(awsName ? `${code}:${awsName}` : code);
        this.name = 'AwsClientError';
    }
}

const THROTTLED = new Set([
    'ThrottlingException', 'Throttling', 'TooManyRequestsException', 'RequestLimitExceeded', 'RequestThrottled',
    'RequestThrottledException', 'SlowDown', 'ServiceUnavailable', 'ServiceUnavailableException', 'InternalFailure',
    'InternalServerError', 'InternalError', 'IDPCommunicationError',
]);
const CAPACITY = new Set([
    'InsufficientInstanceCapacity', 'VcpuLimitExceeded', 'InstanceLimitExceeded', 'InsufficientVolumeCapacity',
    'VolumeLimitExceeded', 'MaxIOPSLimitExceeded', 'ExecutionLimitExceeded', 'ServiceQuotaExceededException',
]);
const CONFIG = new Set([
    'AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'UnrecognizedClientException', 'AuthFailure',
    'InvalidClientTokenId', 'StateMachineDoesNotExist', 'StateMachineDeleting', 'InvalidArn', 'InvalidName',
    'InvalidExecutionInput', 'InvalidParameterValue', 'InvalidParameterCombination', 'MalformedPolicyDocument',
    'ExecutionDoesNotExist',
]);
const CALLER = new Set(['InvalidIdentityToken', 'IDPRejectedClaim', 'ExpiredTokenException', 'ExpiredToken', 'PackedPolicyTooLarge', 'RegionDisabledException']);

/** Any thrown value → an `AwsClientError`. Never echoes AWS messages (they can name resources). */
export function toAwsClientError(error: unknown): AwsClientError {
    if (error instanceof AwsClientError) return error;
    const e = (error ?? {}) as { name?: unknown; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
    const name = typeof e.name === 'string' && /^[A-Za-z0-9.]{1,80}$/.test(e.name) ? e.name : undefined;
    if (name && CAPACITY.has(name)) return new AwsClientError('aws_capacity', false, name);
    if (name && CALLER.has(name)) return new AwsClientError('aws_caller_unavailable', false, name);
    if (name && CONFIG.has(name)) return new AwsClientError('aws_config', false, name);
    const status = e.$metadata?.httpStatusCode;
    if ((name && THROTTLED.has(name)) || e.$retryable || status === 429 || (typeof status === 'number' && status >= 500)) {
        return new AwsClientError('aws_throttled', true, name);
    }
    return new AwsClientError('aws_error', false, name);
}

const nameOf = (error: unknown): string | undefined => {
    const n = (error as { name?: unknown } | null)?.name;
    return typeof n === 'string' ? n : undefined;
};

// ── Vercel OIDC token ────────────────────────────────────────────────────

/** Where Vercel's runtime keeps the current request (same symbol as `@vercel/oidc` `getContext`). */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const TOKEN_HEADER = 'x-vercel-oidc-token';

/**
 * The Vercel OIDC token for THIS call, read fresh every time (Vercel: "Don't
 * cache the returned token"): the request context's `x-vercel-oidc-token`
 * header, else the file in `VERCEL_OIDC_TOKEN_FILE` (an unreadable or empty
 * file is an error, never a fallback to the variable), else
 * `VERCEL_OIDC_TOKEN`. null when there is none.
 */
export function readVercelOidcToken(env: Env = process.env, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
    const context = (globalThis as Record<symbol, { get?: () => { headers?: Record<string, unknown> } | undefined } | undefined>)[REQUEST_CONTEXT];
    const header = context?.get?.()?.headers?.[TOKEN_HEADER];
    if (typeof header === 'string' && header.trim()) return header.trim();
    const file = env.VERCEL_OIDC_TOKEN_FILE?.trim();
    if (file) {
        let token: string;
        try {
            token = readFile(file).trim();
        } catch {
            throw new AwsClientError('aws_caller_unavailable', false, 'OidcTokenFileUnreadable');
        }
        if (!token) throw new AwsClientError('aws_caller_unavailable', false, 'OidcTokenFileEmpty');
        return token;
    }
    const token = env.VERCEL_OIDC_TOKEN?.trim();
    return token ? token : null;
}

// ── Caller credentials (AssumeRoleWithWebIdentity) ───────────────────────

/** `us-east-1` → `EZIL_AWS_APP_CALLER_ROLE_ARN_US_EAST_1`: the region's app-caller role (infra app-caller.ts output). */
export function appCallerRoleEnv(region: string): string {
    return `EZIL_AWS_APP_CALLER_ROLE_ARN_${region.toUpperCase().replace(/-/g, '_')}`;
}

const ROLE_ARN = /^arn:aws:iam::(\d{12}):role\/(?:[A-Za-z0-9+=,.@_-]{1,64}\/)*[A-Za-z0-9+=,.@_-]{1,64}$/;

export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: Date;
}
export interface Sender {
    send(command: unknown): Promise<unknown>;
}

/** Credentials are refreshed this long before they expire. */
export const CREDENTIAL_MARGIN_MS = 5 * 60_000;
/** Session length asked of STS (the role's default maximum is one hour). */
export const CALLER_SESSION_SECONDS = 3600;

/**
 * A credentials function for the SDK: STS `AssumeRoleWithWebIdentity` with the
 * current OIDC token, cached until `expiration - CREDENTIAL_MARGIN_MS`. A
 * missing token or a refusal is `aws_caller_unavailable`; nothing else is ever
 * tried.
 */
export function webIdentityCredentials(opts: {
    roleArn: string;
    region: string;
    token: () => string | null;
    sts: Sender;
    now?: () => Date;
}): () => Promise<AwsCredentials> {
    if (!ROLE_ARN.test(opts.roleArn)) throw new AwsClientError('aws_config', false, 'AppCallerRoleArnInvalid');
    const now = opts.now ?? (() => new Date());
    let cached: AwsCredentials | null = null;
    let pending: Promise<AwsCredentials> | null = null;
    const assume = async (): Promise<AwsCredentials> => {
        const token = opts.token();
        if (!token) throw new AwsClientError('aws_caller_unavailable', false, 'OidcTokenMissing');
        let out: { Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date } };
        try {
            out = (await opts.sts.send(
                new AssumeRoleWithWebIdentityCommand({
                    RoleArn: opts.roleArn,
                    RoleSessionName: `ezil-app-${opts.region}`,
                    WebIdentityToken: token,
                    DurationSeconds: CALLER_SESSION_SECONDS,
                }),
            )) as typeof out;
        } catch (error) {
            const mapped = toAwsClientError(error);
            // A refusal of the token or role is the caller being unavailable; throttling stays retryable.
            throw mapped.code === 'aws_throttled' ? mapped : new AwsClientError('aws_caller_unavailable', false, mapped.awsName);
        }
        const c = out.Credentials;
        if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !(c.Expiration instanceof Date)) {
            throw new AwsClientError('aws_caller_unavailable', false, 'StsCredentialsIncomplete');
        }
        return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
    };
    return async () => {
        if (cached && cached.expiration.getTime() - CREDENTIAL_MARGIN_MS > now().getTime()) return cached;
        pending ??= assume().finally(() => {
            pending = null;
        });
        cached = await pending;
        return cached;
    };
}

/** STS never signs `AssumeRoleWithWebIdentity`; this guarantees it could not use ambient credentials if it tried. */
const NO_AMBIENT_CREDENTIALS = async (): Promise<never> => {
    throw new AwsClientError('aws_caller_unavailable', false, 'AmbientCredentialsRefused');
};

// ── ARN pinning ─────────────────────────────────────────────────────────

const VERSION_ARN = /^arn:aws:states:([a-z0-9-]+):(\d{12}):stateMachine:([A-Za-z0-9_-]{1,80}):([1-9][0-9]*)$/;
const EXECUTION_ARN = /^arn:aws:states:([a-z0-9-]+):(\d{12}):execution:([A-Za-z0-9_-]{1,80}):(computer-[0-9a-f-]{36})$/;
const EXECUTION_NAME = /^computer-[0-9a-f-]{36}$/;
const INSTANCE_ID = /^i-[a-f0-9]{8,17}$/;

function assertRegion(region: string): void {
    if (!AWS_REGION_PATTERN.test(region)) throw new AwsClientError('aws_config', false, 'RegionInvalid');
}

// ── Step Functions ───────────────────────────────────────────────────────

/** A region's client plus the account its caller role lives in (ARNs from any other account are refused). */
export interface RegionalClient {
    client: Sender;
    account: string;
}

/**
 * `StartExecution` on the exact lifecycle VERSION ARN, in `region`, under the
 * caller role's account. `ExecutionAlreadyExists` is success: the execution
 * name is `computer-<jobId>`, and a job's input is fixed by its digest.
 */
export function createSfnLifecycleStarter(sfnFor: (region: string) => RegionalClient): LifecycleStarter {
    return {
        async start(region, work) {
            assertRegion(region);
            const m = VERSION_ARN.exec(work.stateMachineArn);
            if (!m) throw new AwsClientError('aws_config', false, 'StateMachineVersionArnRequired');
            const { client, account } = sfnFor(region);
            if (m[1] !== region) throw new AwsClientError('aws_config', false, 'StateMachineRegionMismatch');
            if (m[2] !== account) throw new AwsClientError('aws_config', false, 'StateMachineAccountMismatch');
            if (!EXECUTION_NAME.test(work.name) || typeof work.input !== 'string') throw new AwsClientError('aws_config', false, 'ExecutionInvalid');
            try {
                await client.send(new StartExecutionCommand({ stateMachineArn: work.stateMachineArn, name: work.name, input: work.input }));
            } catch (error) {
                if (nameOf(error) === 'ExecutionAlreadyExists') return;
                throw toAwsClientError(error);
            }
        },
    };
}

/** `DescribeExecution` of one computer job, in `region`, under the caller role's account. */
export function createSfnExecutionReader(sfnFor: (region: string) => RegionalClient): LifecycleExecutionReader {
    return {
        async describe(region, executionArn) {
            assertRegion(region);
            const m = EXECUTION_ARN.exec(executionArn);
            if (!m) throw new AwsClientError('aws_config', false, 'ExecutionArnInvalid');
            const { client, account } = sfnFor(region);
            if (m[1] !== region) throw new AwsClientError('aws_config', false, 'ExecutionRegionMismatch');
            if (m[2] !== account) throw new AwsClientError('aws_config', false, 'ExecutionAccountMismatch');
            let out: { status?: string; output?: string; error?: string; cause?: string };
            try {
                out = (await client.send(new DescribeExecutionCommand({ executionArn }))) as typeof out;
            } catch (error) {
                throw toAwsClientError(error);
            }
            if (typeof out.status !== 'string') throw new AwsClientError('aws_error', false, 'DescribeExecutionNoStatus');
            return { status: out.status, output: out.output ?? null, error: out.error ?? null, cause: out.cause ?? null };
        },
    };
}

// ── EC2 (enrollment's live check) ────────────────────────────────────────

type Ec2Tag = { Key?: string; Value?: string };
const tagMap = (tags: readonly Ec2Tag[] | undefined): Record<string, string> =>
    Object.fromEntries((tags ?? []).filter((t) => typeof t.Key === 'string').map((t) => [t.Key!, t.Value ?? '']));

/**
 * The read-only describe C-6 step 3 needs, in `region`. null when EC2 has no
 * such instance. The ZoneId comes from the instance's placement (or, for an
 * SDK response without it, `DescribeAvailabilityZones` for that zone name).
 */
export function createEc2EnrollmentDescriber(ec2For: (region: string) => RegionalClient): Ec2EnrollmentDescriber {
    return {
        async describeForEnrollment(region, instanceId) {
            assertRegion(region);
            if (!INSTANCE_ID.test(instanceId)) return null;
            const { client } = ec2For(region);
            type Instance = {
                InstanceId?: string;
                State?: { Name?: string };
                Placement?: { AvailabilityZone?: string; AvailabilityZoneId?: string };
                PublicIpAddress?: string;
                Tags?: Ec2Tag[];
                BlockDeviceMappings?: { Ebs?: { VolumeId?: string; DeleteOnTermination?: boolean } }[];
            };
            let instances: Instance[];
            try {
                const out = (await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))) as { Reservations?: { Instances?: Instance[] }[] };
                instances = (out.Reservations ?? []).flatMap((r) => r.Instances ?? []);
            } catch (error) {
                const n = nameOf(error);
                if (n === 'InvalidInstanceID.NotFound' || n === 'InvalidInstanceID.Malformed') return null;
                throw toAwsClientError(error);
            }
            if (instances.length === 0) return null;
            if (instances.length !== 1 || instances[0]!.InstanceId !== instanceId) throw new AwsClientError('aws_error', false, 'DescribeInstancesAmbiguous');
            const inst = instances[0]!;
            const az = inst.Placement?.AvailabilityZone;
            if (!az) throw new AwsClientError('aws_error', false, 'InstanceZoneMissing');
            let zoneId = inst.Placement?.AvailabilityZoneId;
            try {
                if (!zoneId) {
                    const zones = (await client.send(new DescribeAvailabilityZonesCommand({ ZoneNames: [az] }))) as {
                        AvailabilityZones?: { ZoneName?: string; ZoneId?: string }[];
                    };
                    zoneId = zones.AvailabilityZones?.find((z) => z.ZoneName === az)?.ZoneId;
                }
            } catch (error) {
                throw toAwsClientError(error);
            }
            if (!zoneId) throw new AwsClientError('aws_error', false, 'InstanceZoneIdMissing');
            const mappings = (inst.BlockDeviceMappings ?? []).filter((b) => typeof b.Ebs?.VolumeId === 'string');
            const volumeIds = mappings.map((b) => b.Ebs!.VolumeId!);
            let volumeTags = new Map<string, Record<string, string>>();
            if (volumeIds.length > 0) {
                try {
                    const out = (await client.send(new DescribeVolumesCommand({ VolumeIds: volumeIds }))) as { Volumes?: { VolumeId?: string; Tags?: Ec2Tag[] }[] };
                    volumeTags = new Map((out.Volumes ?? []).filter((v) => typeof v.VolumeId === 'string').map((v) => [v.VolumeId!, tagMap(v.Tags)]));
                } catch (error) {
                    throw toAwsClientError(error);
                }
                // Every attached volume must be described: a partial answer is not evidence.
                if (volumeIds.some((id) => !volumeTags.has(id))) throw new AwsClientError('aws_error', false, 'DescribeVolumesIncomplete');
            }
            const view: Ec2EnrollmentView = {
                instanceId,
                state: inst.State?.Name ?? 'unknown',
                availabilityZone: az,
                availabilityZoneId: zoneId,
                publicIp: inst.PublicIpAddress ?? null,
                tags: tagMap(inst.Tags),
                volumes: mappings.map((b) => ({
                    volumeId: b.Ebs!.VolumeId!,
                    // Only an explicit `false` is false: an unknown flag never passes as "kept on terminate".
                    deleteOnTermination: b.Ebs!.DeleteOnTermination !== false,
                    tags: volumeTags.get(b.Ebs!.VolumeId!) ?? {},
                })),
            };
            return view;
        },
    };
}

// ── Wiring from the environment ──────────────────────────────────────────

export interface AwsSdkFactories {
    /** Defaults to the Vercel OIDC token of the current request. */
    token?: () => string | null;
    sts?: (region: string) => Sender;
    sfn?: (region: string, credentials: () => Promise<AwsCredentials>) => Sender;
    ec2?: (region: string, credentials: () => Promise<AwsCredentials>) => Sender;
    now?: () => Date;
    /** Test seam: replaces the HTTP layer of the DEFAULT SDK clients (credentials, signing and serialization stay real). */
    requestHandler?: unknown;
}

export interface AwsSdkCollaborators {
    starter?: LifecycleStarter;
    executions?: LifecycleExecutionReader;
    describer?: Ec2EnrollmentDescriber;
}

/**
 * The SDK-backed collaborators for `env`. With the AWS flag off, or no valid
 * region list, nothing is built and `{}` is returned (the provider then
 * refuses `aws_lifecycle_unconfigured`; enrollment answers 503). Clients are
 * built lazily, per region, on first use; a region with no caller role is
 * `aws_config` at that call, never another region's role.
 */
export function createAwsSdkCollaborators(env: Env, f: AwsSdkFactories = {}): AwsSdkCollaborators {
    if (!isAwsComputersEnabled(env)) return {};
    const regions = readAwsRegions(env);
    if (!regions.ok) return {};
    const configured = new Set(regions.regions.map((r) => r.name));
    const token = f.token ?? (() => readVercelOidcToken(env));
    // `requestHandler` is spread only when a test supplies it; production uses the SDK's own HTTP handler.
    const http = f.requestHandler ? { requestHandler: f.requestHandler as never } : {};
    const stsFor = f.sts ?? ((region: string) => new STSClient({ region, credentials: NO_AMBIENT_CREDENTIALS, maxAttempts: 2, ...http }));
    const sfnFactory =
        f.sfn ?? ((region: string, credentials: () => Promise<AwsCredentials>) => new SFNClient({ region, credentials, maxAttempts: 3, ...http }));
    const ec2Factory =
        f.ec2 ?? ((region: string, credentials: () => Promise<AwsCredentials>) => new EC2Client({ region, credentials, maxAttempts: 3, ...http }));
    const credentialsByRegion = new Map<string, { account: string; credentials: () => Promise<AwsCredentials> }>();
    const caller = (region: string) => {
        assertRegion(region);
        if (!configured.has(region)) throw new AwsClientError('aws_config', false, 'RegionNotConfigured');
        let c = credentialsByRegion.get(region);
        if (!c) {
            const roleArn = env[appCallerRoleEnv(region)]?.trim() ?? '';
            const m = ROLE_ARN.exec(roleArn);
            if (!m) throw new AwsClientError('aws_config', false, 'AppCallerRoleUnset');
            c = { account: m[1]!, credentials: webIdentityCredentials({ roleArn, region, token, sts: stsFor(region), now: f.now }) };
            credentialsByRegion.set(region, c);
        }
        return c;
    };
    const sfnClients = new Map<string, RegionalClient>();
    const ec2Clients = new Map<string, RegionalClient>();
    const sfnFor = (region: string): RegionalClient => {
        let r = sfnClients.get(region);
        if (!r) {
            const c = caller(region);
            r = { client: sfnFactory(region, c.credentials), account: c.account };
            sfnClients.set(region, r);
        }
        return r;
    };
    const ec2For = (region: string): RegionalClient => {
        let r = ec2Clients.get(region);
        if (!r) {
            const c = caller(region);
            r = { client: ec2Factory(region, c.credentials), account: c.account };
            ec2Clients.set(region, r);
        }
        return r;
    };
    return {
        starter: createSfnLifecycleStarter(sfnFor),
        executions: createSfnExecutionReader(sfnFor),
        describer: createEc2EnrollmentDescriber(ec2For),
    };
}

/** The settings the shared collaborators depend on; a change rebuilds them. */
function collaboratorKey(env: Env): string {
    const regions = (env.AWS_REGIONS ?? '').split(',');
    return JSON.stringify([env.EZIL_AWS_COMPUTERS_ENABLED ?? '', env.AWS_REGIONS ?? '', ...regions.map((r) => env[appCallerRoleEnv(r)] ?? '')]);
}
let shared: { key: string; value: AwsSdkCollaborators } | null = null;

/**
 * One set of collaborators per warm function instance, so the cached caller
 * credentials survive across requests. Rebuilt when the relevant settings
 * change; `{}` while AWS is off.
 */
export function sharedAwsSdkCollaborators(env: Env = process.env): AwsSdkCollaborators {
    if (!isAwsComputersEnabled(env)) return {};
    const key = collaboratorKey(env);
    if (shared?.key !== key) shared = { key, value: createAwsSdkCollaborators(env) };
    return shared.value;
}
