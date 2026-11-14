/**
 * Guarded operator runner for NULL-lower attestation (scripts/lower-attestation-operator.ts). It reuses the EXACT store,
 * verifier and compare-and-set the internal route uses; only the readers differ: the operator profile's own AWS CLI reads
 * (EC2, SSM command/document/invocation, CloudTrail with full pagination), never relayed JSON.
 *
 * Fails closed, before any store call, unless every pin holds:
 * - the runtime: git HEAD is the reviewed commit and no tracked file is modified;
 * - the AWS account, region and namespace, also cross-checked against the reviewed registry entry;
 * - DB role `postgres` and the DB system identifier;
 * - the attest.py sha256 at that commit, and the reviewed AWS-RunShellScript document hash.
 * Dry run unless --apply. Every mutation first creates its O_EXCL 0600 intent journal, then appends the outcome; stdout
 * carries phases, codes and hashes only (no computer, owner or instance identifiers).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Ec2EnrollmentView } from './aws-enroll';
import type { Ec2VolumeView } from './aws-clients';
import { AWS_IDENTITY_CERTS_ENV } from './aws-identity';
import { LIFECYCLE_DEPLOYMENTS_ENV } from './aws-intent';
import type { RebaseSnapshotView } from './aws-rebase-evidence';
import { RebaseHash, RebaseUuid } from './aws-rebase-json';
import { adoptLowerAttestation, attestationBody, attestationRegistry, buildAttestCommand, LOWER_ATTEST_DOCUMENT_SHA256_ENV, LOWER_ATTEST_MAINTENANCE_AMI_ENV,
    LOWER_ATTEST_SOURCE_SHA256_ENV, LOWER_ATTEST_USERDATA_SHA256_ENV, LowerAttestationReserveRequestSchema, maintenanceHostObservations,
    previewLowerAttestation, verifyFreshMaintenanceHost, type LowerAttestationReaders, type LowerAttestationRecord, type LowerAttestationStore,
    type SsmCommandView, type SsmDocumentView, type SsmInvocationView } from './aws-lower-attestation';

/** `aws <args> --region <region> --output json`, under the operator's own profile; resolves stdout or rejects. */
export type AwsCli = (args: readonly string[]) => Promise<string>;
export class OperatorRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = 'OperatorRefusal'; }
}
const refuse = (code: string): never => { throw new OperatorRefusal(code); };
const notFound = (error: unknown, codes: string[]) => error instanceof Error && codes.some(c => error.message.includes(c));
const Tags = z.array(z.object({ Key: z.string(), Value: z.string() }).passthrough()).optional();
const tagMap = (list: z.infer<typeof Tags>) => Object.fromEntries((list ?? []).map(t => [t.Key, t.Value]));
const Time = z.string().refine(t => Number.isFinite(Date.parse(t)));
/** The AWS CLI JSON fields each reader maps; anything else passes through unread, and a malformed answer refuses. */
const Cli = {
    snapshots: z.object({ Snapshots: z.array(z.object({ SnapshotId: z.string(), OwnerId: z.string(), VolumeId: z.string().optional(), VolumeSize: z.number().optional(),
        State: z.string().optional(), Encrypted: z.boolean().optional(), KmsKeyId: z.string().optional(), StartTime: Time, Tags }).passthrough()).max(1) }).passthrough(),
    volumes: z.object({ Volumes: z.array(z.object({ VolumeId: z.string(), State: z.string().optional(), Encrypted: z.boolean().optional(), KmsKeyId: z.string().optional(),
        Size: z.number().optional(), SnapshotId: z.string().optional(), AvailabilityZoneId: z.string().optional(), VolumeType: z.string().optional(), Tags,
        Attachments: z.array(z.object({ InstanceId: z.string(), State: z.string() }).passthrough()).optional() }).passthrough()).max(1) }).passthrough(),
    instances: z.object({ Reservations: z.array(z.object({ Instances: z.array(z.object({ InstanceId: z.string(), ImageId: z.string().optional(),
        InstanceType: z.string().optional(), State: z.object({ Name: z.string() }).passthrough().optional(),
        Placement: z.object({ AvailabilityZone: z.string().optional(), AvailabilityZoneId: z.string().optional() }).passthrough().optional(),
        PublicIpAddress: z.string().optional(), RootDeviceName: z.string().optional(), Tags,
        BlockDeviceMappings: z.array(z.object({ DeviceName: z.string().optional(), Ebs: z.object({ VolumeId: z.string(),
            DeleteOnTermination: z.boolean().optional() }).passthrough().optional() }).passthrough()).optional() }).passthrough()).max(1) }).passthrough()).max(1) }).passthrough(),
    commands: z.object({ Commands: z.array(z.object({ CommandId: z.string(), DocumentName: z.string(), DocumentVersion: z.string().optional(),
        InstanceIds: z.array(z.string()), Parameters: z.object({ commands: z.array(z.string()) }).passthrough(), RequestedDateTime: Time,
        Status: z.string() }).passthrough()).max(1) }).passthrough(),
    document: z.object({ Document: z.object({ Name: z.string(), DocumentVersion: z.string(), Owner: z.string(), DocumentType: z.string(), Status: z.string(),
        HashType: z.string(), Hash: z.string() }).passthrough() }).passthrough(),
    invocation: z.object({ CommandId: z.string(), InstanceId: z.string(), Status: z.string(), ResponseCode: z.number(),
        StandardOutputContent: z.string().optional(), StandardErrorContent: z.string().optional() }).passthrough(),
    events: z.object({ NextToken: z.undefined(), Events: z.array(z.object({ EventName: z.string().optional(), CloudTrailEvent: z.string() }).passthrough()) }).passthrough(),
    userData: z.object({ InstanceId: z.string(), UserData: z.object({ Value: z.string().optional() }).passthrough().optional() }).passthrough(),
    instanceCommands: z.object({ NextToken: z.undefined(), Commands: z.array(z.object({ CommandId: z.string() }).passthrough()) }).passthrough(),
    sessions: z.object({ NextToken: z.undefined(), Sessions: z.array(z.object({ SessionId: z.string() }).passthrough()) }).passthrough(),
};

/** The verifier's readers over the AWS CLI. The AWS CLI paginates LookupEvents to completion unless told otherwise. */
export function awsCliReaders(aws: AwsCli): LowerAttestationReaders {
    const read = async <S extends z.ZodTypeAny>(schema: S, args: string[], missing: string[], code = 'aws_output_invalid'): Promise<z.infer<S> | null> => {
        let raw: string;
        try { raw = await aws(args); } catch (error) { if (notFound(error, missing)) return null; throw error; }
        let value: unknown;
        try { value = JSON.parse(raw); } catch { return refuse('aws_output_invalid'); }
        const parsed = schema.safeParse(value);
        return parsed.success ? parsed.data : refuse(code);
    };
    return {
        async describeSnapshot(_region, snapshotId): Promise<RebaseSnapshotView | null> {
            const s = (await read(Cli.snapshots, ['ec2', 'describe-snapshots', '--snapshot-ids', snapshotId, '--owner-ids', 'self'], ['InvalidSnapshot.NotFound']))?.Snapshots[0];
            if (!s) return null;
            return { snapshotId: s.SnapshotId, ownerId: s.OwnerId, volumeId: s.VolumeId ?? '', volumeGiB: s.VolumeSize ?? 0, state: s.State ?? 'unknown',
                encrypted: s.Encrypted === true, kmsKeyId: s.KmsKeyId ?? '', startedAt: new Date(s.StartTime), tags: tagMap(s.Tags) };
        },
        async describeVolume(_region, volumeId): Promise<Ec2VolumeView | null> {
            const v = (await read(Cli.volumes, ['ec2', 'describe-volumes', '--volume-ids', volumeId], ['InvalidVolume.NotFound']))?.Volumes[0];
            if (!v) return null;
            return { volumeId: v.VolumeId, state: v.State ?? 'unknown', tags: tagMap(v.Tags), encrypted: v.Encrypted, kmsKeyId: v.KmsKeyId, sizeGiB: v.Size,
                snapshotId: v.SnapshotId || undefined, zoneId: v.AvailabilityZoneId, volumeType: v.VolumeType,
                attachments: (v.Attachments ?? []).map(x => ({ instanceId: x.InstanceId, state: x.State })) };
        },
        async describeForEnrollment(_region, instanceId): Promise<Ec2EnrollmentView | null> {
            const i = (await read(Cli.instances, ['ec2', 'describe-instances', '--instance-ids', instanceId], ['InvalidInstanceID.NotFound']))?.Reservations[0]?.Instances[0];
            if (!i) return null;
            return { instanceId: i.InstanceId, imageId: i.ImageId, instanceType: i.InstanceType, state: i.State?.Name ?? 'unknown',
                availabilityZone: i.Placement?.AvailabilityZone ?? '', availabilityZoneId: i.Placement?.AvailabilityZoneId ?? '', publicIp: i.PublicIpAddress ?? null,
                tags: tagMap(i.Tags), rootDeviceName: i.RootDeviceName,
                volumes: (i.BlockDeviceMappings ?? []).flatMap(m => m.Ebs ? [{ volumeId: m.Ebs.VolumeId, deviceName: m.DeviceName,
                    deleteOnTermination: m.Ebs.DeleteOnTermination === true, tags: {} }] : []) };
        },
        async getCommand(_region, commandId): Promise<SsmCommandView | null> {
            const c = (await read(Cli.commands, ['ssm', 'list-commands', '--command-id', commandId], ['InvalidCommandId']))?.Commands[0];
            if (!c) return null;
            return { commandId: c.CommandId, documentName: c.DocumentName, documentVersion: c.DocumentVersion ?? '', instanceIds: c.InstanceIds,
                commands: c.Parameters.commands, requestedAt: new Date(c.RequestedDateTime), status: c.Status };
        },
        async describeDocument(_region, name, documentVersion): Promise<SsmDocumentView | null> {
            const d = (await read(Cli.document, ['ssm', 'describe-document', '--name', name, '--document-version', documentVersion], ['InvalidDocument']))?.Document;
            if (!d) return null;
            return { name: d.Name, documentVersion: d.DocumentVersion, owner: d.Owner, documentType: d.DocumentType, status: d.Status, hashType: d.HashType, hash: d.Hash };
        },
        async getCommandInvocation(_region, commandId, instanceId): Promise<SsmInvocationView | null> {
            const i = await read(Cli.invocation, ['ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', instanceId], ['InvocationDoesNotExist']);
            if (!i) return null;
            return { commandId: i.CommandId, instanceId: i.InstanceId, status: i.Status, responseCode: i.ResponseCode,
                standardOutput: i.StandardOutputContent ?? '', standardError: i.StandardErrorContent ?? '' };
        },
        async describeUserData(_region, instanceId) {
            const u = await read(Cli.userData, ['ec2', 'describe-instance-attribute', '--instance-id', instanceId, '--attribute', 'userData'], ['InvalidInstanceID.NotFound']);
            return u && u.InstanceId === instanceId ? u.UserData?.Value ?? '' : null;
        },
        async listInstanceCommands(_region, instanceId) {
            const out = await read(Cli.instanceCommands, ['ssm', 'list-commands', '--instance-id', instanceId], [], 'ssm_listing_partial');
            return out!.Commands.map(c => c.CommandId);
        },
        async listInstanceSessions(_region, instanceId) {
            const ids: string[] = [];
            for (const state of ['Active', 'History']) {
                const out = await read(Cli.sessions, ['ssm', 'describe-sessions', '--state', state, '--filters', `key=Target,value=${instanceId}`], [], 'ssm_listing_partial');
                ids.push(...out!.Sessions.map(s => s.SessionId));
            }
            return ids;
        },
        async lookupRunInstances(_region, instanceId) {
            // A truncated listing (NextToken) is never "exactly one": the CLI must have drained every page.
            const out = await read(Cli.events, ['cloudtrail', 'lookup-events', '--lookup-attributes', `AttributeKey=ResourceName,AttributeValue=${instanceId}`],
                [], 'cloudtrail_partial');
            return out!.Events.filter(e => e.EventName === 'RunInstances').map(e => e.CloudTrailEvent);
        },
    };
}

export const OperatorPinsSchema = z.object({ region: z.string().regex(/^[a-z]{2}-[a-z]+-[0-9]$/), accountId: z.string().regex(/^[0-9]{12}$/),
    namespace: z.string().regex(/^[a-z][a-z0-9]{0,20}$/),
    dbSystemIdentifier: z.string().regex(/^[0-9]{1,20}$/), sourceCommit: z.string().regex(/^[0-9a-f]{40}$/), sourceSha256: RebaseHash,
    documentSha256: RebaseHash, documentVersion: z.string().regex(/^[1-9][0-9]{0,9}$/), maintenanceAmiId: z.string().regex(/^ami-[0-9a-f]{17}$/),
    userDataSha256: RebaseHash.nullable() }).strict();
export type OperatorPins = z.infer<typeof OperatorPinsSchema>;
/** Observed identities, each read by the runner itself before any store call. */
export interface OperatorObserved {
    accountId: string; dbRole: string; dbSystemIdentifier: string; source: Buffer;
    /** `git rev-parse HEAD` and `git status --porcelain --untracked-files=no` of the checkout this runner, store and verifier run from. */
    head: string; trackedChanges: string;
    /** The reviewed registry entry for the pinned region (`{...deployment, releases}`). */
    registry: unknown;
}
/**
 * The whole runtime is pinned, not only the delivered host file: the checkout the RUNNING code was loaded from (its own
 * toplevel, never the process cwd) is exactly the pinned commit with no tracked edit. Checked before any DB or AWS read.
 */
export function assertRuntimePins(pins: OperatorPins, seen: { codeRoot: string; toplevel: string; head: string; trackedChanges: string; source: Buffer }) {
    if (seen.toplevel.trim() !== seen.codeRoot) refuse('runtime_not_pinned');
    if (seen.head.trim() !== pins.sourceCommit) refuse('runtime_not_pinned');
    if (seen.trackedChanges.trim() !== '') refuse('runtime_dirty');
    if (createHash('sha256').update(seen.source).digest('hex') !== pins.sourceSha256) refuse('source_not_pinned');
}
export function assertOperatorPins(pins: OperatorPins, seen: OperatorObserved) {
    if (seen.head.trim() !== pins.sourceCommit) refuse('runtime_not_pinned');
    if (seen.trackedChanges.trim() !== '') refuse('runtime_dirty');
    if (seen.accountId !== pins.accountId) refuse('account_mismatch');
    const r = seen.registry as { accountId?: unknown; region?: unknown; namespace?: unknown } | null;
    if (!r || typeof r !== 'object' || r.accountId !== pins.accountId || r.region !== pins.region || r.namespace !== pins.namespace) refuse('registry_mismatch');
    // Root-verified backend role; an arbitrary BYPASSRLS role is never accepted instead.
    if (seen.dbRole !== 'postgres') refuse('db_role_mismatch');
    if (seen.dbSystemIdentifier !== pins.dbSystemIdentifier) refuse('db_identity_mismatch');
    if (createHash('sha256').update(seen.source).digest('hex') !== pins.sourceSha256) refuse('source_not_pinned');
}
/** The verifier's environment: reviewed registry and identity certificates from files, and the two pins. Nothing else. */
export function operatorEnv(pins: OperatorPins, deploymentsJson: string, identityCertsJson: string): Record<string, string> {
    return { [LIFECYCLE_DEPLOYMENTS_ENV]: deploymentsJson, [AWS_IDENTITY_CERTS_ENV]: identityCertsJson,
        [LOWER_ATTEST_SOURCE_SHA256_ENV]: pins.sourceSha256, [LOWER_ATTEST_DOCUMENT_SHA256_ENV]: pins.documentSha256,
        [LOWER_ATTEST_MAINTENANCE_AMI_ENV]: pins.maintenanceAmiId, ...(pins.userDataSha256 ? { [LOWER_ATTEST_USERDATA_SHA256_ENV]: pins.userDataSha256 } : {}) };
}

/** `aws ssm send-command --cli-input-json file://…` input for exactly this reservation; the operator sends it. */
export function attestSendCommandInput(a: LowerAttestationRecord, pins: OperatorPins, source: Buffer,
    target: { maintenanceInstanceId: string; cloneVolumeId: string; snapshotId: string }) {
    if (a.phase !== 'reserved') refuse('attestation_not_reserved');
    if (!/^i-[0-9a-f]{17}$/.test(target.maintenanceInstanceId) || !/^vol-[0-9a-f]{17}$/.test(target.cloneVolumeId)
        || !/^snap-[0-9a-f]{8,17}$/.test(target.snapshotId) || target.cloneVolumeId === a.sourceVolumeId
        || target.maintenanceInstanceId === a.sourceInstanceId) refuse('target_invalid');
    const commands = buildAttestCommand({ sourceBase64: source.toString('base64'), sourceSha256: pins.sourceSha256, attestationId: a.attestationId,
        computerId: a.computerId, originalVolumeId: a.sourceVolumeId, cloneVolumeId: target.cloneVolumeId, snapshotId: target.snapshotId, fsUuid: a.fsUuid,
        instanceId: a.sourceInstanceId, generation: a.sourceGeneration, leaseEpoch: a.sourceLeaseEpoch, challenge: a.challenge });
    return { DocumentName: 'AWS-RunShellScript', DocumentVersion: pins.documentVersion, InstanceIds: [target.maintenanceInstanceId],
        Parameters: { commands }, Comment: `ezil lower attestation ${a.attestationId}`.slice(0, 100), TimeoutSeconds: 600 };
}

export const OperatorIdsSchema = z.object({ attestationId: RebaseUuid, computerId: RebaseUuid }).strict();
export const OperatorReserveFileSchema = LowerAttestationReserveRequestSchema;
/** The only line an operation prints: no computer, owner or instance identifiers. */
export function operatorLine(op: string, r: { phase: string; failureCode?: string | null; measuredDigest?: string | null; evidenceSha256?: string | null } | null) {
    return JSON.stringify({ op, phase: r?.phase ?? 'absent', failureCode: r?.failureCode ?? null, measuredDigest: r?.measuredDigest ?? null,
        evidenceSha256: r?.evidenceSha256 ?? null });
}

/** An O_EXCL 0600 journal file, created before the mutation it records; outcome lines are appended. */
export interface OperatorJournal { append(line: string): void; close(): void }
export interface OperatorDeps {
    aws: AwsCli;
    /** The real repository root derived from the running script's own path (never the process cwd). */
    codeRoot: string;
    /** `git -C <codeRoot> <args>`; resolves stdout. */
    git: (args: readonly string[]) => Promise<Buffer>;
    readFile: (path: string) => string;
    /** Throws if the file exists or cannot be created: nothing is then mutated. */
    createJournal: (dir: string, name: string) => OperatorJournal;
    /** current_user and pg_control_system().system_identifier of the database the store writes. */
    dbIdentity: () => Promise<{ role: string; systemIdentifier: string }>;
    store: LowerAttestationStore;
    /** The send-command input file, O_EXCL 0600. */
    writeExclusive: (path: string, body: string) => void;
    now: () => Date;
    print: (line: string) => void;
}
export const ATTEST_SOURCE_REPO_PATH = 'infra/host-agent/lib/ezil_host/attest.py';
const flagsOf = (argv: readonly string[]) => {
    const out: Record<string, string | true> = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i]!, value = argv[i + 1];
        if (!/^--[a-z-]+$/.test(key) || key.slice(2) in out) refuse('arguments_invalid');
        if (value === undefined || value.startsWith('--')) out[key.slice(2)] = true; else { out[key.slice(2)] = value; i++; }
    }
    return out;
};

/** status | reserve | command | adopt | abort. Every pin is proved before the store is touched. */
export async function runOperator(argv: readonly string[], deps: OperatorDeps): Promise<void> {
    const [op, ...rest] = argv, f = flagsOf(rest);
    const text = (key: string) => typeof f[key] === 'string' ? f[key] as string : refuse(`missing_${key}`);
    if (!['status', 'reserve', 'command', 'adopt', 'abort'].includes(op ?? '')) refuse('operation_unknown');
    const pins = OperatorPinsSchema.safeParse(JSON.parse(deps.readFile(text('pins'))));
    if (!pins.success) return refuse('pins_invalid');
    const p = pins.data, apply = f.apply === true;
    const journalDir = apply ? text('journal') : null;
    const deploymentsJson = deps.readFile(text('deployments'));
    const registry = (JSON.parse(deploymentsJson) as Record<string, unknown>)[p.region] ?? null;
    // Runtime first: no DB or AWS read happens from an unpinned or modified checkout.
    const [toplevel, head, trackedChanges, source] = await Promise.all([deps.git(['rev-parse', '--show-toplevel']), deps.git(['rev-parse', 'HEAD']),
        deps.git(['status', '--porcelain', '--untracked-files=no']), deps.git(['show', `${p.sourceCommit}:${ATTEST_SOURCE_REPO_PATH}`])]);
    assertRuntimePins(p, { codeRoot: deps.codeRoot, toplevel: toplevel.toString('utf8'), head: head.toString('utf8'),
        trackedChanges: trackedChanges.toString('utf8'), source });
    const identity = await deps.dbIdentity();
    const accountId = (JSON.parse(await deps.aws(['sts', 'get-caller-identity'])) as { Account?: string }).Account ?? '';
    assertOperatorPins(p, { accountId, dbRole: identity.role, dbSystemIdentifier: identity.systemIdentifier, source,
        head: head.toString('utf8'), trackedChanges: trackedChanges.toString('utf8'), registry });
    const env = operatorEnv(p, deploymentsJson, deps.readFile(text('identity-certs')));
    /** Intent first (O_EXCL), then the one store call, then its outcome; a failed store call is journaled too. */
    const mutate = async <T extends LowerAttestationRecord>(name: string, intent: Record<string, unknown>, write: () => Promise<T>) => {
        const journal = deps.createJournal(journalDir!, `${deps.now().toISOString().replace(/[:.]/g, '-')}-${name}.json`);
        try {
            journal.append(JSON.stringify({ intent: name, at: deps.now().toISOString(), pins: p, ...intent }));
            let body;
            try { body = attestationBody(await write()); }
            catch (error) {
                journal.append(JSON.stringify({ outcome: 'error', code: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'operator_failed' }));
                throw error;
            }
            journal.append(JSON.stringify({ outcome: body }));
            deps.print(operatorLine(name, body));
        } finally { journal.close(); }
    };
    if (op === 'reserve') {
        const request = LowerAttestationReserveRequestSchema.parse(JSON.parse(deps.readFile(text('request'))));
        if (request.region !== p.region) refuse('region_mismatch');
        if (!apply) return deps.print(operatorLine('reserve-dry-run', { phase: 'not_written' }));
        return mutate('reserve', { request }, () => deps.store.reserve(request, deps.now()));
    }
    const ids = OperatorIdsSchema.parse({ attestationId: text('attestation-id'), computerId: text('computer-id') });
    if (op === 'status') return deps.print(operatorLine('status', attestationBody(await deps.store.inspect(ids.attestationId, ids.computerId))));
    if (op === 'command') {
        const a = await deps.store.inspect(ids.attestationId, ids.computerId);
        if (!a) return refuse('attestation_absent');
        const hostId = text('maintenance-instance-id');
        const input = attestSendCommandInput(a, p, source, { maintenanceInstanceId: hostId, cloneVolumeId: text('clone-volume-id'), snapshotId: text('snapshot-id') });
        // Before the measurement: a fresh host for this job that no SSM command or session has reached yet.
        const readers = awsCliReaders(deps.aws);
        verifyFreshMaintenanceHost(a, hostId, await readers.describeForEnrollment(p.region, hostId), await maintenanceHostObservations(readers, p.region, hostId),
            [], { maintenanceAmiId: p.maintenanceAmiId, userDataSha256: p.userDataSha256 }, attestationRegistry(registry).deployment, deps.now());
        deps.writeExclusive(text('out'), JSON.stringify(input));
        return deps.print(operatorLine('command-written', attestationBody(a)));
    }
    if (op === 'adopt') {
        const request = { schemaVersion: 1 as const, operation: 'attest-lower-adopt' as const, ...ids, commandId: text('command-id') };
        const adopt = { store: deps.store, readers: awsCliReaders(deps.aws), env, now: deps.now };
        if (!apply) return deps.print(operatorLine('adopt-dry-run', await previewLowerAttestation(adopt, request)));
        return mutate('adopt', { request }, () => adoptLowerAttestation(adopt, request));
    }
    if (!apply) return deps.print(operatorLine('abort-dry-run', attestationBody(await deps.store.inspect(ids.attestationId, ids.computerId))));
    return mutate('abort', { ids }, () => deps.store.refuse(ids.attestationId, ids.computerId, deps.now()));
}
