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
import { adoptLowerAttestation, attestationBody, buildAttestCommand, LOWER_ATTEST_DOCUMENT_SHA256_ENV, LOWER_ATTEST_SOURCE_SHA256_ENV,
    LowerAttestationReserveRequestSchema, previewLowerAttestation, type LowerAttestationReaders, type LowerAttestationRecord, type LowerAttestationStore,
    type SsmCommandView, type SsmDocumentView, type SsmInvocationView } from './aws-lower-attestation';

/** `aws <args> --region <region> --output json`, under the operator's own profile; resolves stdout or rejects. */
export type AwsCli = (args: readonly string[]) => Promise<string>;
export class OperatorRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = 'OperatorRefusal'; }
}
const refuse = (code: string): never => { throw new OperatorRefusal(code); };
const json = (raw: string) => { try { return JSON.parse(raw) as Record<string, any>; } catch { return refuse('aws_output_invalid'); } };
const tags = (list: unknown) => Object.fromEntries((Array.isArray(list) ? list : []).map((t: { Key?: unknown; Value?: unknown }) => [String(t.Key), String(t.Value)]));
const one = <T>(list: unknown): T | null => {
    if (!Array.isArray(list) || list.length > 1) return list === undefined ? null : refuse('aws_output_ambiguous');
    return (list[0] as T | undefined) ?? null;
};
const notFound = (error: unknown, codes: string[]) => error instanceof Error && codes.some(c => error.message.includes(c));

/** The verifier's readers over the AWS CLI. The AWS CLI paginates LookupEvents to completion unless told otherwise. */
export function awsCliReaders(aws: AwsCli): LowerAttestationReaders {
    const read = async (args: string[], missing: string[]) => {
        try { return json(await aws(args)); } catch (error) { if (notFound(error, missing)) return null; throw error; }
    };
    return {
        async describeSnapshot(_region, snapshotId): Promise<RebaseSnapshotView | null> {
            const s = one<Record<string, any>>((await read(['ec2', 'describe-snapshots', '--snapshot-ids', snapshotId, '--owner-ids', 'self'], ['InvalidSnapshot.NotFound']))?.Snapshots);
            if (!s) return null;
            const startedAt = new Date(s.StartTime);
            if (!Number.isFinite(startedAt.getTime())) refuse('aws_output_invalid');
            return { snapshotId: s.SnapshotId, ownerId: s.OwnerId, volumeId: s.VolumeId ?? '', volumeGiB: s.VolumeSize ?? 0, state: s.State ?? 'unknown',
                encrypted: s.Encrypted === true, kmsKeyId: s.KmsKeyId ?? '', startedAt, tags: tags(s.Tags) };
        },
        async describeVolume(_region, volumeId): Promise<Ec2VolumeView | null> {
            const v = one<Record<string, any>>((await read(['ec2', 'describe-volumes', '--volume-ids', volumeId], ['InvalidVolume.NotFound']))?.Volumes);
            if (!v) return null;
            return { volumeId: v.VolumeId, state: v.State ?? 'unknown', tags: tags(v.Tags), encrypted: v.Encrypted, kmsKeyId: v.KmsKeyId, sizeGiB: v.Size,
                snapshotId: v.SnapshotId || undefined, zoneId: v.AvailabilityZoneId, volumeType: v.VolumeType,
                attachments: (v.Attachments ?? []).map((x: Record<string, any>) => ({ instanceId: x.InstanceId, state: x.State })) };
        },
        async describeForEnrollment(_region, instanceId): Promise<Ec2EnrollmentView | null> {
            const out = await read(['ec2', 'describe-instances', '--instance-ids', instanceId], ['InvalidInstanceID.NotFound']);
            const reservation = one<Record<string, any>>(out?.Reservations);
            const i = reservation ? one<Record<string, any>>(reservation.Instances) : null;
            if (!i) return null;
            return { instanceId: i.InstanceId, imageId: i.ImageId, instanceType: i.InstanceType, state: i.State?.Name ?? 'unknown',
                availabilityZone: i.Placement?.AvailabilityZone ?? '', availabilityZoneId: i.Placement?.AvailabilityZoneId ?? '', publicIp: i.PublicIpAddress ?? null,
                tags: tags(i.Tags), rootDeviceName: i.RootDeviceName,
                volumes: (i.BlockDeviceMappings ?? []).map((m: Record<string, any>) => ({ volumeId: m.Ebs?.VolumeId, deviceName: m.DeviceName,
                    deleteOnTermination: m.Ebs?.DeleteOnTermination === true, tags: {} })) };
        },
        async getCommand(_region, commandId): Promise<SsmCommandView | null> {
            const c = one<Record<string, any>>((await read(['ssm', 'list-commands', '--command-id', commandId], ['InvalidCommandId']))?.Commands);
            if (!c) return null;
            const requestedAt = new Date(c.RequestedDateTime);
            if (!Number.isFinite(requestedAt.getTime()) || !Array.isArray(c.Parameters?.commands)) refuse('aws_output_invalid');
            return { commandId: c.CommandId, documentName: c.DocumentName, documentVersion: String(c.DocumentVersion ?? ''), instanceIds: c.InstanceIds ?? [],
                commands: c.Parameters.commands, requestedAt, status: c.Status };
        },
        async describeDocument(_region, name, documentVersion): Promise<SsmDocumentView | null> {
            const d = (await read(['ssm', 'describe-document', '--name', name, '--document-version', documentVersion], ['InvalidDocument']))?.Document;
            if (!d) return null;
            return { name: d.Name, documentVersion: String(d.DocumentVersion), owner: d.Owner, documentType: d.DocumentType, status: d.Status,
                hashType: d.HashType, hash: d.Hash };
        },
        async getCommandInvocation(_region, commandId, instanceId): Promise<SsmInvocationView | null> {
            const i = await read(['ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', instanceId], ['InvocationDoesNotExist']);
            if (!i) return null;
            return { commandId: i.CommandId, instanceId: i.InstanceId, status: i.Status, responseCode: i.ResponseCode,
                standardOutput: i.StandardOutputContent ?? '', standardError: i.StandardErrorContent ?? '' };
        },
        async lookupRunInstances(_region, instanceId) {
            const out = json(await aws(['cloudtrail', 'lookup-events', '--lookup-attributes', `AttributeKey=ResourceName,AttributeValue=${instanceId}`]));
            // A truncated listing is never "exactly one": the CLI must have drained every page.
            if (out.NextToken !== undefined || !Array.isArray(out.Events)) refuse('cloudtrail_partial');
            return (out.Events as Record<string, any>[]).filter(e => e.EventName === 'RunInstances').map(e => {
                if (typeof e.CloudTrailEvent !== 'string') refuse('aws_output_invalid');
                return e.CloudTrailEvent as string;
            });
        },
    };
}

export const OperatorPinsSchema = z.object({ region: z.string().regex(/^[a-z]{2}-[a-z]+-[0-9]$/), accountId: z.string().regex(/^[0-9]{12}$/),
    namespace: z.string().regex(/^[a-z][a-z0-9]{0,20}$/),
    dbSystemIdentifier: z.string().regex(/^[0-9]{1,20}$/), sourceCommit: z.string().regex(/^[0-9a-f]{40}$/), sourceSha256: RebaseHash,
    documentSha256: RebaseHash, documentVersion: z.string().regex(/^[1-9][0-9]{0,9}$/) }).strict();
export type OperatorPins = z.infer<typeof OperatorPinsSchema>;
/** Observed identities, each read by the runner itself before any store call. */
export interface OperatorObserved {
    accountId: string; dbRole: string; dbSystemIdentifier: string; source: Buffer;
    /** `git rev-parse HEAD` and `git status --porcelain --untracked-files=no` of the checkout this runner, store and verifier run from. */
    head: string; trackedChanges: string;
    /** The reviewed registry entry for the pinned region (`{...deployment, releases}`). */
    registry: unknown;
}
export function assertOperatorPins(pins: OperatorPins, seen: OperatorObserved) {
    // The whole runtime is pinned, not only the delivered host file: this exact commit, no tracked edits.
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
        [LOWER_ATTEST_SOURCE_SHA256_ENV]: pins.sourceSha256, [LOWER_ATTEST_DOCUMENT_SHA256_ENV]: pins.documentSha256 };
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
    /** `git <args>` in the checkout the runner runs from; resolves stdout. */
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
    const [head, trackedChanges, source] = await Promise.all([deps.git(['rev-parse', 'HEAD']), deps.git(['status', '--porcelain', '--untracked-files=no']),
        deps.git(['show', `${p.sourceCommit}:${ATTEST_SOURCE_REPO_PATH}`])]);
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
        const input = attestSendCommandInput(a, p, source, { maintenanceInstanceId: text('maintenance-instance-id'), cloneVolumeId: text('clone-volume-id'),
            snapshotId: text('snapshot-id') });
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
