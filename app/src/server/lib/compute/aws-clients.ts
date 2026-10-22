/**
 * The app's real AWS clients (docs/AWS-COMPUTERS.md §5, app caller).
 *
 * - `LifecycleStarter`          → Step Functions `StartExecution` (exact version ARN)
 * - `LifecycleExecutionReader`  → Step Functions `DescribeExecution`
 * - `Ec2EnrollmentDescriber`    → EC2 `DescribeInstances` / `DescribeVolumes`
 *
 * 🔴 CREDENTIALS. There are NO long-lived AWS keys. On Vercel, every call uses
 * short-lived credentials from
 * `AssumeRoleWithWebIdentity` on the region's app-caller role, using the Vercel
 * OIDC token of the CURRENT request (`x-vercel-oidc-token` in the request
 * context, else `VERCEL_OIDC_TOKEN_FILE`, else `VERCEL_OIDC_TOKEN`; Vercel
 * docs, "OIDC Federation Reference"). Every client is built with an explicit
 * credentials function, so the SDK's default chain (env keys, shared files,
 * instance metadata) is never consulted. A missing token is
 * `aws_caller_unavailable`; there is no fallback of any kind. Off Vercel,
 * explicit IMDSv2 credentials sign STS `AssumeRole` into the SAME regional
 * app-caller role; instance-role credentials never sign downstream calls.
 *
 * 🔴 REGIONS. A computer lives in its placement's region; every call names
 * that region, and an ARN from another region (or another account than the
 * caller role's) is refused before anything is sent.
 *
 * Nothing here is constructed while `EZIL_AWS_COMPUTERS_ENABLED` is off.
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { DescribeSnapshotsCommand, DescribeAvailabilityZonesCommand, DescribeInstancesCommand, DescribeVolumesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { AssumeRoleCommand, AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import { AWS_REGION_PATTERN, isAwsComputersEnabled, readAwsRegions, type Env } from './aws-config';
import { AwsClientError, toAwsClientError } from './aws-errors';
import { instanceMetadataCredentials } from './aws-instance-credentials';
import type { Ec2EnrollmentDescriber, Ec2EnrollmentView } from './aws-enroll';
import type { LifecycleStarter } from './aws-ec2';
import type { RebaseSnapshotDescriber } from './aws-rebase-evidence';
import type { LifecycleExecutionReader } from './aws-receipts';

// ── Errors (aws-errors.ts, SDK-free) ──────────────────────────────────────

export { AwsClientError, isDefiniteAwsRefusal, isExecutionAbsent, toAwsClientError, type AwsClientErrorCode } from './aws-errors';
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

/** EC2 base credentials are used only by STS; downstream clients use this regional session. */
export function instanceRoleCallerCredentials(opts: {
    roleArn: string;
    sts: Sender;
    now?: () => Date;
}): () => Promise<AwsCredentials> {
    if (!ROLE_ARN.test(opts.roleArn)) throw new AwsClientError('aws_config', false, 'AppCallerRoleArnInvalid');
    const now = opts.now ?? (() => new Date());
    let cached: AwsCredentials | null = null;
    let pending: Promise<AwsCredentials> | null = null;
    const assume = async (): Promise<AwsCredentials> => {
        let out: { Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date } };
        try {
            out = await opts.sts.send(new AssumeRoleCommand({
                RoleArn: opts.roleArn,
                RoleSessionName: `ezil-os-ec2-${randomBytes(6).toString('hex')}`,
                DurationSeconds: 900,
            })) as typeof out;
        } catch (error) {
            const mapped = toAwsClientError(error);
            if (mapped.code === 'credentials_unavailable' || mapped.code === 'aws_throttled') throw mapped;
            throw new AwsClientError('aws_caller_unavailable', false, mapped.awsName);
        }
        const c = out.Credentials;
        if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !(c.Expiration instanceof Date)
            || !Number.isFinite(c.Expiration.getTime()) || c.Expiration.getTime() <= now().getTime()) {
            throw new AwsClientError('aws_caller_unavailable', false, 'StsCredentialsIncomplete');
        }
        return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
    };
    return async () => {
        if (cached && cached.expiration.getTime() - CREDENTIAL_MARGIN_MS > now().getTime()) return cached;
        pending ??= assume().finally(() => { pending = null; });
        cached = await pending;
        return cached;
    };
}

const CREDENTIAL_SOURCE_LOGGED = Symbol.for('ezil.aws-credential-source-logged');
function logCredentialSource(source: 'vercel-oidc' | 'ec2-instance-role'): void {
    const state = globalThis as Record<symbol, unknown>;
    if (state[CREDENTIAL_SOURCE_LOGGED]) return;
    state[CREDENTIAL_SOURCE_LOGGED] = true;
    console.info(source);
}

// ── ARN pinning ─────────────────────────────────────────────────────────

const VERSION_ARN = /^arn:aws:states:([a-z0-9-]+):(\d{12}):stateMachine:([A-Za-z0-9_-]{1,80}):([1-9][0-9]*)$/;
const EXECUTION_ARN = /^arn:aws:states:([a-z0-9-]+):(\d{12}):execution:([A-Za-z0-9_-]{1,80}):(computer-[0-9a-f-]{36})$/;
const EXECUTION_NAME = /^computer-[0-9a-f-]{36}$/;
const INSTANCE_ID = /^i-[a-f0-9]{8,17}$/;
const VOLUME_ID = /^vol-[a-f0-9]{8,17}$/;

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
            let out: { status?: string; output?: string; error?: string; cause?: string; startDate?: Date; stopDate?: Date; input?: string; executionArn?: string; stateMachineVersionArn?: string; stateMachineAliasArn?: string; redriveCount?: number };
            try {
                out = (await client.send(new DescribeExecutionCommand({ executionArn }))) as typeof out;
            } catch (error) {
                throw toAwsClientError(error);
            }
            if (typeof out.status !== 'string') throw new AwsClientError('aws_error', false, 'DescribeExecutionNoStatus');
            const startDate = out.startDate instanceof Date && Number.isFinite(out.startDate.getTime()) ? out.startDate : null;
            const stopDate = out.stopDate instanceof Date && Number.isFinite(out.stopDate.getTime()) ? out.stopDate : null;
            return { status: out.status, output: out.output ?? null, error: out.error ?? null, cause: out.cause ?? null, startDate, stopDate,
                input: out.input, executionArn: out.executionArn, stateMachineVersionArn: out.stateMachineVersionArn, stateMachineAliasArn: out.stateMachineAliasArn, redriveCount: out.redriveCount };
        },
    };
}

// ── EC2 (enrollment's live check) ────────────────────────────────────────

type Ec2Tag = { Key?: string; Value?: string };
const tagMap = (tags: readonly Ec2Tag[] | undefined): Record<string, string> => {
    const out: Record<string, string> = Object.create(null);
    for (const tag of tags ?? []) {
        if (typeof tag.Key !== 'string' || typeof tag.Value !== 'string' || Object.hasOwn(out, tag.Key))
            throw new AwsClientError('aws_error', false, 'DescribeTagsAmbiguous');
        out[tag.Key] = tag.Value;
    }
    return out;
};

/**
 * The read-only describe C-6 step 3 needs, in `region`. null when EC2 has no
 * such instance. The ZoneId comes from the instance's placement (or, for an
 * SDK response without it, `DescribeAvailabilityZones` for that zone name).
 */
/**
 * What a read-only `DescribeVolumes` shows about one data volume: the reconciler's check
 * that a lost instance's retained volume still exists before it records the computer as
 * recoverable (aws-receipts.ts `reconcileGuestStop`). null when EC2 has no such volume.
 */
export interface Ec2VolumeView {
    volumeId: string;
    /** EC2 volume state: creating | available | in-use | deleting | deleted | error. */
    state: string;
    tags?: Readonly<Record<string, string>>;
    attachments?: readonly { instanceId: string; state: string }[];
    encrypted?: boolean;
    kmsKeyId?: string;
    sizeGiB?: number;
    snapshotId?: string;
    zoneId?: string;
}

export interface Ec2VolumeDescriber {
    describeVolume(region: string, volumeId: string): Promise<Ec2VolumeView | null>;
}

/**
 * Every EC2 resource tagged with one computer's id (`ezil:computer-id`, set by the lifecycle
 * helper on each instance and volume it creates), in one region: the evidence a placement
 * that recorded NO resource ids (a provision that failed before any id was recorded) owns
 * none, before it is released (aws-receipts.ts `settleUnconfirmedAwsPlacement`).
 * Terminated instances and deleted volumes are gone and not listed. A listing too large to
 * read in full throws: a partial answer is never evidence of "none".
 */
export interface Ec2ComputerResources {
    instances: { instanceId: string; state: string }[];
    volumes: { volumeId: string; state: string }[];
}

export interface ReplacementWriter { instanceId: string; state: string; accountId: string; clientToken: string; tags: Readonly<Record<string, string>> }
export interface Ec2ReplacementDescriber {
    describeReplacementWriters(region: string, clientToken: string): Promise<ReplacementWriter[]>;
}

export interface Ec2ComputerResourceFinder {
    findComputerResources(region: string, computerId: string): Promise<Ec2ComputerResources>;
}

/** Pages read per resource kind before a listing is refused as too large to be evidence. */
const RESOURCE_SEARCH_MAX_PAGES = 10;
const COMPUTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createEc2EnrollmentDescriber(
    ec2For: (region: string) => RegionalClient,
): Ec2EnrollmentDescriber & Ec2VolumeDescriber & Ec2ComputerResourceFinder & Ec2ReplacementDescriber & RebaseSnapshotDescriber {
    return {
        async describeSnapshot(region, snapshotId) {
            assertRegion(region);
            if (!/^snap-[0-9a-f]{8,17}$/.test(snapshotId)) throw new AwsClientError('aws_config', false, 'SnapshotIdInvalid');
            const { client, account } = ec2For(region);
            let out;
            try { out = await client.send(new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId], OwnerIds: [account] })) as {
                Snapshots?: { SnapshotId?: string; OwnerId?: string; VolumeId?: string; VolumeSize?: number; State?: string;
                    Encrypted?: boolean; KmsKeyId?: string; StartTime?: Date; Tags?: Ec2Tag[] }[] };
            } catch (error) { if (nameOf(error) === 'InvalidSnapshot.NotFound') return null; throw toAwsClientError(error); }
            if (!out.Snapshots?.length) return null;
            const v = out.Snapshots[0]!;
            if (out.Snapshots.length !== 1 || v.SnapshotId !== snapshotId || v.OwnerId !== account || !(v.StartTime instanceof Date))
                throw new AwsClientError('aws_error', false, 'DescribeSnapshotsAmbiguous');
            return { snapshotId, ownerId: v.OwnerId, volumeId: v.VolumeId ?? '', volumeGiB: v.VolumeSize ?? 0, state: v.State ?? 'unknown',
                encrypted: v.Encrypted === true, kmsKeyId: v.KmsKeyId ?? '', startedAt: v.StartTime, tags: tagMap(v.Tags) };
        },
        async describeForEnrollment(region, instanceId) {
            assertRegion(region);
            if (!INSTANCE_ID.test(instanceId)) return null;
            const { client } = ec2For(region);
            type Instance = {
                InstanceId?: string;
                InstanceType?: string;
                State?: { Name?: string };
                StateTransitionReason?: string;
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
                    const volumes = out.Volumes ?? [];
                    if (volumes.some(v => typeof v.VolumeId !== 'string' || !volumeIds.includes(v.VolumeId))
                        || new Set(volumes.map(v => v.VolumeId)).size !== volumes.length) throw new AwsClientError('aws_error', false, 'DescribeVolumesAmbiguous');
                    volumeTags = new Map(volumes.map((v) => [v.VolumeId!, tagMap(v.Tags)]));
                } catch (error) {
                    throw toAwsClientError(error);
                }
                // Every attached volume must be described: a partial answer is not evidence.
                if (volumeIds.some((id) => !volumeTags.has(id))) throw new AwsClientError('aws_error', false, 'DescribeVolumesIncomplete');
            }
            // EC2 supplies shutdown time as e.g. "User initiated (2026-10-19 12:34:56 GMT)".
            // Only accept that explicit UTC timestamp; other reasons have no usable time.
            const stamp = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT\)/.exec(inst.StateTransitionReason ?? '');
            const transitionAt = stamp ? new Date(`${stamp[1]}T${stamp[2]}Z`) : null;
            const view: Ec2EnrollmentView = {
                instanceId,
                ...(inst.InstanceType ? { instanceType: inst.InstanceType } : {}),
                state: inst.State?.Name ?? 'unknown',
                ...(transitionAt && Number.isFinite(transitionAt.getTime()) ? { stateTransitionAt: transitionAt } : {}),
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

        async describeVolume(region, volumeId) {
            assertRegion(region);
            if (!VOLUME_ID.test(volumeId)) return null;
            const { client } = ec2For(region);
            type Volume = { VolumeId?: string; State?: string; Tags?: Ec2Tag[]; Attachments?: { InstanceId?: string; State?: string }[]; Encrypted?: boolean; KmsKeyId?: string; Size?: number; SnapshotId?: string; AvailabilityZoneId?: string; AvailabilityZone?: string };
            let volumes: Volume[];
            try {
                const out = (await client.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }))) as { Volumes?: Volume[] };
                volumes = out.Volumes ?? [];
            } catch (error) {
                if (nameOf(error) === 'InvalidVolume.NotFound') return null;
                throw toAwsClientError(error);
            }
            if (volumes.length === 0) return null;
            if (volumes.length !== 1 || volumes[0]!.VolumeId !== volumeId) throw new AwsClientError('aws_error', false, 'DescribeVolumesAmbiguous');
            const v = volumes[0]!;
            let zoneId = v.AvailabilityZoneId;
            if (!zoneId && v.AvailabilityZone) {
                const zones = await client.send(new DescribeAvailabilityZonesCommand({ ZoneNames: [v.AvailabilityZone] })) as { AvailabilityZones?: { ZoneName?: string; ZoneId?: string }[] };
                if (zones.AvailabilityZones?.length !== 1 || zones.AvailabilityZones[0]!.ZoneName !== v.AvailabilityZone) throw new AwsClientError('aws_error', false, 'VolumeZoneAmbiguous');
                zoneId = zones.AvailabilityZones[0]!.ZoneId;
            }
            return { volumeId, state: v.State ?? 'unknown', tags: tagMap(v.Tags), encrypted: v.Encrypted, kmsKeyId: v.KmsKeyId, sizeGiB: v.Size, snapshotId: v.SnapshotId, zoneId,
                attachments: v.Attachments?.map((a) => ({ instanceId: a.InstanceId ?? '', state: a.State ?? 'unknown' })) };
        },

        async describeReplacementWriters(region, clientToken) {
            assertRegion(region);
            if (!/^[0-9a-f]{64}$/.test(clientToken)) throw new AwsClientError('aws_config', false, 'ClientTokenInvalid');
            const { client } = ec2For(region);
            const found: ReplacementWriter[] = [];
            let next: string | undefined;
            for (let page = 0; ; page++) {
                if (page >= RESOURCE_SEARCH_MAX_PAGES) throw new AwsClientError('aws_error', false, 'DescribeInstancesTooMany');
                const out = await client.send(new DescribeInstancesCommand({
                    Filters: [{ Name: 'client-token', Values: [clientToken] }], MaxResults: 100, NextToken: next,
                })) as { Reservations?: { OwnerId?: string; Instances?: { InstanceId?: string; ClientToken?: string; State?: { Name?: string }; Tags?: Ec2Tag[] }[] }[]; NextToken?: string };
                for (const r of out.Reservations ?? []) for (const i of r.Instances ?? []) found.push({
                    instanceId: i.InstanceId ?? '', state: i.State?.Name ?? 'unknown', accountId: r.OwnerId ?? '',
                    clientToken: i.ClientToken ?? '', tags: tagMap(i.Tags),
                });
                next = out.NextToken;
                if (!next) return found;
            }
        },

        async findComputerResources(region, computerId) {
            assertRegion(region);
            if (!COMPUTER_ID.test(computerId)) throw new AwsClientError('aws_config', false, 'ComputerIdInvalid');
            const { client } = ec2For(region);
            const Filters = [{ Name: 'tag:ezil:computer-id', Values: [computerId] }];
            const instances: Ec2ComputerResources['instances'] = [];
            const volumes: Ec2ComputerResources['volumes'] = [];
            try {
                let token: string | undefined;
                for (let page = 0; ; page++) {
                    if (page >= RESOURCE_SEARCH_MAX_PAGES) throw new AwsClientError('aws_error', false, 'DescribeInstancesTooMany');
                    const out = (await client.send(new DescribeInstancesCommand({ Filters, MaxResults: 100, NextToken: token }))) as {
                        Reservations?: { Instances?: { InstanceId?: string; State?: { Name?: string } }[] }[]; NextToken?: string;
                    };
                    for (const inst of (out.Reservations ?? []).flatMap((r) => r.Instances ?? [])) {
                        const state = inst.State?.Name ?? 'unknown';
                        if (state !== 'terminated') instances.push({ instanceId: inst.InstanceId ?? '', state });
                    }
                    token = out.NextToken || undefined;
                    if (!token) break;
                }
                token = undefined;
                for (let page = 0; ; page++) {
                    if (page >= RESOURCE_SEARCH_MAX_PAGES) throw new AwsClientError('aws_error', false, 'DescribeVolumesTooMany');
                    const out = (await client.send(new DescribeVolumesCommand({ Filters, MaxResults: 500, NextToken: token }))) as {
                        Volumes?: { VolumeId?: string; State?: string }[]; NextToken?: string;
                    };
                    for (const v of out.Volumes ?? []) {
                        const state = v.State ?? 'unknown';
                        if (state !== 'deleted') volumes.push({ volumeId: v.VolumeId ?? '', state });
                    }
                    token = out.NextToken || undefined;
                    if (!token) break;
                }
            } catch (error) {
                throw toAwsClientError(error);
            }
            return { instances, volumes };
        },
    };
}

// ── Wiring from the environment ──────────────────────────────────────────

export interface AwsSdkFactories {
    /** Defaults to the Vercel OIDC token of the current request. */
    token?: () => string | null;
    sts?: (region: string, credentials: () => Promise<AwsCredentials>) => Sender;
    sfn?: (region: string, credentials: () => Promise<AwsCredentials>) => Sender;
    ec2?: (region: string, credentials: () => Promise<AwsCredentials>) => Sender;
    now?: () => Date;
    /** Test seam: replaces the HTTP layer of the DEFAULT SDK clients (credentials, signing and serialization stay real). */
    requestHandler?: unknown;
}

export interface AwsSdkCollaborators {
    starter?: LifecycleStarter;
    executions?: LifecycleExecutionReader;
    describer?: Ec2EnrollmentDescriber & Ec2VolumeDescriber & Ec2ComputerResourceFinder & Partial<Ec2ReplacementDescriber & RebaseSnapshotDescriber>;
}

/**
 * The SDK-backed collaborators for `env`. With the AWS flag off, no valid
 * region list, or any configured region without a valid caller role
 * (`EZIL_AWS_APP_CALLER_ROLE_ARN_<REGION>`), nothing is built and `{}` is
 * returned (the provider then refuses `aws_lifecycle_unconfigured`; enrollment
 * answers 503). Clients are built lazily, per region, on first use, each with
 * that region's own role; a region outside `AWS_REGIONS` is `aws_config`.
 */
export function createAwsSdkCollaborators(env: Env, f: AwsSdkFactories = {}): AwsSdkCollaborators {
    if (!isAwsComputersEnabled(env)) return {};
    const regions = readAwsRegions(env);
    if (!regions.ok) return {};
    // A half-configured caller is no caller: every region a computer may live in
    // needs its own role, or nothing is built and the provider refuses BEFORE any
    // placement write (`aws_lifecycle_unconfigured`) instead of failing mid-way.
    if (!regions.regions.every((r) => ROLE_ARN.test(env[appCallerRoleEnv(r.name)]?.trim() ?? ''))) return {};
    const configured = new Set(regions.regions.map((r) => r.name));
    const token = f.token ?? (() => readVercelOidcToken(env));
    const vercel = env.VERCEL === '1';
    const baseCredentials = vercel ? NO_AMBIENT_CREDENTIALS : instanceMetadataCredentials({ now: f.now });
    // `requestHandler` is spread only when a test supplies it; production uses the SDK's own HTTP handler.
    const http = f.requestHandler ? { requestHandler: f.requestHandler as never } : {};
    const stsFor = f.sts ?? ((region: string, credentials: () => Promise<AwsCredentials>) => new STSClient({ region, credentials, maxAttempts: 2, ...http }));
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
            const sts = stsFor(region, baseCredentials);
            const credentials = vercel
                ? webIdentityCredentials({ roleArn, region, token, sts, now: f.now })
                : instanceRoleCallerCredentials({ roleArn, sts, now: f.now });
            c = { account: m[1]!, credentials: () => {
                logCredentialSource(vercel ? 'vercel-oidc' : 'ec2-instance-role');
                return credentials();
            } };
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
    return JSON.stringify([env.EZIL_AWS_COMPUTERS_ENABLED ?? '', env.VERCEL ?? '', env.AWS_REGIONS ?? '', ...regions.map((r) => env[appCallerRoleEnv(r)] ?? '')]);
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
