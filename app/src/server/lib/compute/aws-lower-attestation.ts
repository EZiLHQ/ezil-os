/**
 * NULL recorded lower recovery for an already-committed, STOPPED AWS placement (operator only).
 *
 * The digest is MEASURED from the guard marker of a snapshot CLONE on a trusted maintenance host (host
 * `attest-lower`), never inferred from config or a launch tuple. The launch tuple only corroborates: the source
 * instance's RunInstances {account, region, AMI, launch template id+version} must join exactly ONE registry record,
 * whose lower equals the measured one. A shared lower or AMI alone never selects a release.
 *
 * Trust: STRICT AWS READS by the adopting side, nothing relayed. The receipt is the SSM invocation output of the one
 * command that delivered the pinned attest.py with this job's challenge; the launch tuple is CloudTrail's own record;
 * snapshot, clone, original and maintenance host are EC2 reads. The AWS-signed instance identity in the receipt proves
 * only which instance and AMI the maintenance host is; it does not sign the measurement.
 *
 * Source instance: the placement's current instance, or, for a released placement whose instance_id is NULL, the
 * instance of its latest CLOSED usage session (authoritative history, never an id from the request alone).
 *
 * reserve: exact tuple, STOPPED, NULL lower, no job of any kind; sets only image_upgrade_job_id (the ordinary
 *   reservation fence: every open, start and admission refuses while it is set).
 * adopt: ONE transaction compare-and-sets the unchanged NULL row to the measured digest and observation time, clears
 *   the fence and seals the audit row. Any refusal, drift or expiry seals `refused` and clears only this attestation's
 *   own reservation; the lower is never written then.
 * refuse (abort): the same terminal path, at any time. The original volume is never attached, written or rebound here.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ec2EnrollmentView } from './aws-enroll';
import type { Ec2VolumeView } from './aws-clients';
import { readIdentityCertificate, verifyIdentitySignature } from './aws-identity';
import { LIFECYCLE_DEPLOYMENTS_ENV, LifecycleDeploymentSchema, type LifecycleDeployment } from './aws-intent';
import type { RebaseSnapshotView } from './aws-rebase-evidence';
import { parseRebaseJson, RebaseCounter, RebaseDigest, RebaseHash, RebaseSnapshot, RebaseTime, RebaseUuid, RebaseVolume } from './aws-rebase-json';
import { REBASE_RELEASE_REGISTRY_CAPACITY, RebaseSourceReleaseSchema, type RebaseSourceRelease } from './aws-rebase-release';
import type { Env } from './aws-config';
import { assertNoImageReservation, ImageJobConflictError, lockImagePlacement, setImageReservation, withAdmission,
    type ImagePlacement, type PlacementDb, type PlacementExecutor } from './placement';
import { reverseMoveHolds } from './provider-reverse-store';

export const LOWER_ATTESTATION_PHASES = ['reserved', 'adopted', 'refused'] as const;
export const LOWER_ATTESTATION_FAILURE_CODES = ['command_invalid', 'source_not_pinned', 'receipt_invalid', 'marker_mismatch', 'mount_not_readonly', 'identity_invalid',
    'untrusted_ami', 'snapshot_lineage_mismatch', 'clone_lineage_mismatch', 'original_not_fenced', 'launch_tuple_invalid',
    'release_mismatch', 'instance_provenance_missing', 'placement_changed', 'reservation_expired', 'operator_abandoned'] as const;
/** A measurement interrupted for longer than this cannot be adopted; any later adopt or refuse releases the fence. */
export const LOWER_ATTESTATION_TTL_MS = 24 * 3600000;
export type LowerAttestationFailure = typeof LOWER_ATTESTATION_FAILURE_CODES[number];
export class LowerAttestationRefusal extends Error {
    constructor(readonly code: LowerAttestationFailure) { super(code); this.name = 'LowerAttestationRefusal'; }
}
const refuse = (code: LowerAttestationFailure): never => { throw new LowerAttestationRefusal(code); };

const instance = z.string().regex(/^i-[0-9a-f]{17}$/);
const counter = z.number().int().min(0).max(2147483647);
const v4 = RebaseUuid.refine(id => id.split('-')[2]![0] === '4');
const tuple = { computerId: RebaseUuid, sourceInstanceId: instance, sourceVolumeId: RebaseVolume, fsUuid: RebaseUuid,
    sourceGeneration: RebaseCounter, sourceLeaseEpoch: RebaseCounter, sourceFenceToken: RebaseUuid, region: z.string().min(1).max(32), zoneId: z.string().min(1).max(32) };
export const LowerAttestationReserveRequestSchema = z.object({ schemaVersion: z.literal(1), operation: z.literal('attest-lower-reserve'),
    attestationId: v4, ...tuple }).strict();
/** Only the SSM command id: the command, its output and the launch record are read from AWS by the adopting side, never relayed. */
export const LowerAttestationAdoptRequestSchema = z.object({ schemaVersion: z.literal(1), operation: z.literal('attest-lower-adopt'),
    attestationId: v4, computerId: RebaseUuid, commandId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) }).strict();
export const LowerAttestationRefuseRequestSchema = z.object({ schemaVersion: z.literal(1), operation: z.literal('attest-lower-refuse'),
    attestationId: v4, computerId: RebaseUuid, failureCode: z.literal('operator_abandoned') }).strict();
export const LowerAttestationInspectRequestSchema = z.object({ schemaVersion: z.literal(1), operation: z.literal('attest-lower-inspect'),
    attestationId: v4, computerId: RebaseUuid }).strict();
export type LowerAttestationReserveRequest = z.infer<typeof LowerAttestationReserveRequestSchema>;
export type LowerAttestationAdoptRequest = z.infer<typeof LowerAttestationAdoptRequestSchema>;

/** Host `attest-lower` output, exactly. */
export const LowerAttestationReceiptSchema = z.object({ v: z.literal(1), kind: z.literal('ezil-lower-attestation-receipt'),
    attestationId: RebaseUuid, computerId: RebaseUuid, originalVolumeId: RebaseVolume, cloneVolumeId: RebaseVolume, snapshotId: RebaseSnapshot,
    fsUuid: RebaseUuid, sourceInstanceId: instance, generation: counter, leaseEpoch: counter, challenge: RebaseHash, maintenanceInstanceId: instance,
    identityDocument: z.string().min(2).max(4096), identitySignature: z.string().min(16).max(8192),
    mountOptions: z.array(z.string().regex(/^[a-z0-9_=.:-]{1,64}$/)).min(1).max(32), blockDeviceReadOnly: z.literal(true),
    markerBase64: z.string().min(4).max(87384), markerSha256: RebaseHash, lowerImageDigest: RebaseDigest, observedAt: RebaseTime }).strict();
/** guard.py new_marker, exactly. Older markers have no instanceId; then the usage ledger must name the instance. */
const MarkerSchema = z.object({ computerId: RebaseUuid, volumeId: RebaseVolume, fsUuid: RebaseUuid, generation: counter, leaseEpoch: counter,
    lowerImageDigest: RebaseDigest, instanceId: instance.optional() }).strict();
const IdentitySchema = z.object({ instanceId: instance, imageId: z.string().regex(/^ami-[0-9a-f]{17}$/), accountId: z.string().regex(/^[0-9]{12}$/),
    region: z.string().min(1) }).passthrough();

/**
 * The one SSM delivery this verifier accepts (AWS-RunShellScript `commands`, element for element): the reviewed attest.py,
 * checked against its pinned sha256 on the host, loaded as `ezil_host.attest` beside the AMI's own agent library, run with
 * exactly the reservation's arguments and the server's challenge. deploy/aws/mum/attest_lower.py builds the same lines.
 */
export const ATTEST_SOURCE_PATH = '/run/ezil-attest/attest.py';
const LOADER = 'import importlib.util,sys;sys.path.insert(0,"/opt/ezil-host/lib");import ezil_host;from ezil_host import config;'
    + `s=importlib.util.spec_from_file_location("ezil_host.attest","${ATTEST_SOURCE_PATH}");m=importlib.util.module_from_spec(s);`
    + 'sys.modules["ezil_host.attest"]=m;s.loader.exec_module(m);sys.exit(m.main(config.load(),sys.argv[1:]))';
export interface AttestCommandInput {
    sourceBase64: string; sourceSha256: string; attestationId: string; computerId: string; originalVolumeId: string; cloneVolumeId: string;
    snapshotId: string; fsUuid: string; instanceId: string; generation: number; leaseEpoch: number; challenge: string;
}
export function buildAttestCommand(c: AttestCommandInput): string[] {
    return ['set -euo pipefail', 'umask 077', 'install -d -m 700 /run/ezil-attest',
        `printf '%s' '${c.sourceBase64}' | base64 -d > ${ATTEST_SOURCE_PATH}`,
        `echo '${c.sourceSha256}  ${ATTEST_SOURCE_PATH}' | sha256sum -c --quiet -`,
        `python3 -I -c '${LOADER}' --attestation-id ${c.attestationId} --computer-id ${c.computerId} --original-volume-id ${c.originalVolumeId}`
        + ` --clone-volume-id ${c.cloneVolumeId} --snapshot-id ${c.snapshotId} --fs-uuid ${c.fsUuid} --instance-id ${c.instanceId}`
        + ` --generation ${c.generation} --lease-epoch ${c.leaseEpoch} --challenge ${c.challenge}`];
}
/** Recovers the variable parts, then requires the command to be byte-equal to its canonical rebuild. */
export function parseAttestCommand(commands: readonly string[]): AttestCommandInput | null {
    const src = /^printf '%s' '([A-Za-z0-9+/]+={0,2})' \| base64 -d > \/run\/ezil-attest\/attest\.py$/.exec(commands[3] ?? '');
    const sha = /^echo '([0-9a-f]{64})  \/run\/ezil-attest\/attest\.py' \| sha256sum -c --quiet -$/.exec(commands[4] ?? '');
    const args = / --attestation-id (\S+) --computer-id (\S+) --original-volume-id (\S+) --clone-volume-id (\S+) --snapshot-id (\S+) --fs-uuid (\S+) --instance-id (\S+) --generation ([0-9]{1,10}) --lease-epoch ([0-9]{1,10}) --challenge (\S+)$/.exec(commands[5] ?? '');
    if (!src || !sha || !args) return null;
    const c: AttestCommandInput = { sourceBase64: src[1]!, sourceSha256: sha[1]!, attestationId: args[1]!, computerId: args[2]!, originalVolumeId: args[3]!,
        cloneVolumeId: args[4]!, snapshotId: args[5]!, fsUuid: args[6]!, instanceId: args[7]!, generation: Number(args[8]), leaseEpoch: Number(args[9]), challenge: args[10]! };
    const canonical = buildAttestCommand(c);
    return canonical.length === commands.length && canonical.every((line, i) => line === commands[i]) ? c : null;
}

export interface LowerAttestationRecord {
    attestationId: string; computerId: string; ownerUserId: string; region: string; zoneId: string; sourceInstanceId: string;
    /** The placement's instance_id when reserved, frozen: NULL for a released placement; the adopt CAS compares exactly this. */
    currentInstanceId: string | null; sourceVolumeId: string; fsUuid: string; sourceGeneration: number; sourceLeaseEpoch: number; sourceFenceToken: string;
    reservedRowSha256: string; requestSha256: string; challenge: string; commandId: string | null; phase: typeof LOWER_ATTESTATION_PHASES[number];
    evidence: Record<string, unknown> | null; evidenceSha256: string | null; measuredDigest: string | null; measuredAt: string | null;
    markerSha256: string | null; snapshotId: string | null; cloneVolumeId: string | null; maintenanceInstanceId: string | null;
    maintenanceAmiId: string | null; sourceRelease: RebaseSourceRelease | null; failureCode: LowerAttestationFailure | null;
    createdAt: string; updatedAt: string; completedAt: string | null;
}
const COLUMNS = [
    ['attestationId', 'attestation_id', 'uuid'], ['computerId', 'computer_id', 'uuid'], ['ownerUserId', 'owner_user_id', 'uuid'],
    ['region', 'region', 'text'], ['zoneId', 'zone_id', 'text'], ['sourceInstanceId', 'source_instance_id', 'text'],
    ['currentInstanceId', 'current_instance_id', 'text'],
    ['sourceVolumeId', 'source_volume_id', 'text'], ['fsUuid', 'fs_uuid', 'uuid'], ['sourceGeneration', 'source_generation', 'bigint'],
    ['sourceLeaseEpoch', 'source_lease_epoch', 'bigint'], ['sourceFenceToken', 'source_fence_token', 'uuid'],
    ['reservedRowSha256', 'reserved_row_sha256', 'text'], ['requestSha256', 'request_sha256', 'text'], ['challenge', 'challenge', 'text'],
    ['commandId', 'command_id', 'text'], ['phase', 'phase', 'text'],
    ['evidence', 'evidence', 'jsonb'], ['evidenceSha256', 'evidence_sha256', 'text'], ['measuredDigest', 'measured_digest', 'text'],
    ['measuredAt', 'measured_at', 'timestamptz'], ['markerSha256', 'marker_sha256', 'text'], ['snapshotId', 'snapshot_id', 'text'],
    ['cloneVolumeId', 'clone_volume_id', 'text'], ['maintenanceInstanceId', 'maintenance_instance_id', 'text'],
    ['maintenanceAmiId', 'maintenance_ami_id', 'text'], ['sourceRelease', 'source_release', 'jsonb'], ['failureCode', 'failure_code', 'text'],
    ['createdAt', 'created_at', 'timestamptz'], ['updatedAt', 'updated_at', 'timestamptz'], ['completedAt', 'completed_at', 'timestamptz'],
] as const;
const columnNames = sql.raw(COLUMNS.map(([, name]) => name).join(', '));
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Sorted-key JSON: jsonb reorders object keys, so the sealed evidence hash must not depend on insertion order. */
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
        : JSON.stringify(value);
export const evidenceDigest = (evidence: Record<string, unknown>) => sha256(canonical(evidence));
const rowsOf = (r: unknown): Record<string, unknown>[] => {
    const rows = Array.isArray(r) ? r : (r as { rows?: unknown } | null)?.rows;
    if (!Array.isArray(rows)) throw new ImageJobConflictError();
    return rows as Record<string, unknown>[];
};
const iso = (value: unknown) => {
    if (value === null) return null;
    const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
    if (!date || !Number.isFinite(date.getTime())) throw new ImageJobConflictError();
    return date.toISOString();
};
const AttestationSchema = z.object({ attestationId: v4, ...tuple, currentInstanceId: instance.nullable(), ownerUserId: RebaseUuid,
    reservedRowSha256: RebaseHash, requestSha256: RebaseHash,
    challenge: RebaseHash, commandId: z.string().regex(/^[0-9a-f-]{36}$/).nullable(),
    phase: z.enum(LOWER_ATTESTATION_PHASES), evidence: z.record(z.string(), z.unknown()).nullable(), evidenceSha256: RebaseHash.nullable(),
    measuredDigest: RebaseDigest.nullable(), measuredAt: RebaseTime.nullable(), markerSha256: RebaseHash.nullable(), snapshotId: RebaseSnapshot.nullable(),
    cloneVolumeId: RebaseVolume.nullable(), maintenanceInstanceId: instance.nullable(), maintenanceAmiId: z.string().regex(/^ami-[0-9a-f]{17}$/).nullable(),
    sourceRelease: RebaseSourceReleaseSchema.nullable(), failureCode: z.enum(LOWER_ATTESTATION_FAILURE_CODES).nullable(),
    createdAt: RebaseTime, updatedAt: RebaseTime, completedAt: RebaseTime.nullable() }).strict().superRefine((a, ctx) => {
    const sealed = [a.commandId, a.evidence, a.evidenceSha256, a.measuredDigest, a.measuredAt, a.markerSha256, a.snapshotId, a.cloneVolumeId,
        a.maintenanceInstanceId, a.maintenanceAmiId, a.sourceRelease];
    const ok = a.phase === 'reserved' ? sealed.every(v => v === null) && !a.failureCode && !a.completedAt
        : a.phase === 'adopted' ? sealed.every(v => v !== null) && !a.failureCode && !!a.completedAt && a.sourceRelease!.lowerImageDigest === a.measuredDigest
            && evidenceDigest(a.evidence!) === a.evidenceSha256
            : sealed.every(v => v === null) && !!a.failureCode && !!a.completedAt;
    if (!ok || Date.parse(a.updatedAt) < Date.parse(a.createdAt)) ctx.addIssue({ code: 'custom', message: 'attestation_invalid' });
});
export function parseLowerAttestationRow(row: Record<string, unknown>): LowerAttestationRecord {
    if (Object.keys(row).some(k => !COLUMNS.some(([, name]) => name === k))) throw new ImageJobConflictError();
    const out: Record<string, unknown> = {};
    for (const [key, name, type] of COLUMNS) {
        let value = row[name];
        if (type === 'bigint' && typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
        if (type === 'timestamptz' && value !== null) value = iso(value);
        out[key] = value;
    }
    const parsed = AttestationSchema.safeParse(out);
    if (!parsed.success) throw new ImageJobConflictError();
    return parsed.data as LowerAttestationRecord;
}
const valueSql = (a: LowerAttestationRecord, key: keyof LowerAttestationRecord, type: string) => {
    const value = a[key];
    if (type === 'jsonb') return sql`${value === null ? null : JSON.stringify(value)}::text::jsonb`;
    return sql`${value}::${sql.raw(type)}`;
};

/** The reserved placement, canonically, minus the two columns the reservation itself writes. */
export function placementDigest(p: ImagePlacement): string {
    const canonical = Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'updatedAt' && k !== 'imageUpgradeJobId')
        .sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
    return sha256(JSON.stringify(canonical));
}
export function requestDigest(r: LowerAttestationReserveRequest): string {
    return sha256(JSON.stringify(Object.fromEntries(Object.keys(r).sort().map(k => [k, r[k as keyof typeof r]]))));
}

const TRUSTED_TAGS = (namespace: string, computerId: string) => ({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': namespace, 'ezil:computer-id': computerId });
const LAUNCH_TUPLE = ['accountId', 'region', 'amiId', 'launchTemplateId', 'launchTemplateVersion'] as const;

/** ssm:ListCommands (one command id), ssm:DescribeDocument and ssm:GetCommandInvocation, read by the adopting side. */
export interface SsmCommandView { commandId: string; documentName: string; documentVersion: string; instanceIds: readonly string[];
    commands: readonly string[]; requestedAt: Date; status: string }
export interface SsmDocumentView { name: string; documentVersion: string; owner: string; documentType: string; status: string; hashType: string; hash: string }
export interface SsmInvocationView { commandId: string; instanceId: string; status: string; responseCode: number; standardOutput: string; standardError: string }
export interface LowerAttestationObservations {
    snapshot: RebaseSnapshotView | null; clone: Ec2VolumeView | null; original: Ec2VolumeView | null; maintenance: Ec2EnrollmentView | null;
    command: SsmCommandView | null; document: SsmDocumentView | null; invocation: SsmInvocationView | null;
    /** cloudtrail:LookupEvents (ResourceName = the source instance), raw `CloudTrailEvent` strings. */
    runInstances: readonly string[];
    /** The maintenance host's own history: its RunInstances records, its user-data, every SSM command and session that targeted it. */
    host: MaintenanceHostObservations;
}
export interface MaintenanceHostObservations {
    launches: readonly string[];
    /** ec2:DescribeInstanceAttribute userData Value (base64), '' when none; null when unreadable. */
    userData: string | null;
    /** ssm:ListCommands --instance-id, every page. */
    commandIds: readonly string[];
    /** ssm:DescribeSessions Active and History with Target = the host, every page. */
    sessionIds: readonly string[];
}
export interface LowerAttestationProof {
    commandId: string; measuredDigest: string; measuredAt: string; markerSha256: string; snapshotId: string; cloneVolumeId: string;
    maintenanceInstanceId: string; maintenanceAmiId: string; sourceRelease: RebaseSourceRelease; evidence: Record<string, unknown>;
}

/** Registry entry (`{...deployment, releases}`) for the attestation's region; validated as the rebase path does. */
export function attestationRegistry(entry: unknown): { deployment: LifecycleDeployment; releases: RebaseSourceRelease[] } {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) refuse('release_mismatch');
    const { releases, ...raw } = entry as Record<string, unknown>;
    const deployment = LifecycleDeploymentSchema.safeParse(raw);
    const records = z.array(RebaseSourceReleaseSchema).min(1).max(REBASE_RELEASE_REGISTRY_CAPACITY).safeParse(releases);
    if (!deployment.success || !records.success) return refuse('release_mismatch');
    return { deployment: deployment.data, releases: records.data };
}

/** Of the CloudTrail records read for the source instance, exactly one RunInstances that launched it. */
export function launchOf(rawEvents: readonly string[], a: Pick<LowerAttestationRecord, 'sourceInstanceId' | 'region' | 'createdAt'>, accountId: string) {
    const launches = rawEvents.filter(raw => {
        try { return (parseRebaseJson(raw, 65536) as { eventName?: unknown }).eventName === 'RunInstances'; } catch { return refuse('launch_tuple_invalid'); }
    });
    if (launches.length !== 1) refuse('launch_tuple_invalid');
    return launchTupleOf(launches[0]!, a, accountId);
}

/** The fields of a CloudTrail RunInstances record this proof reads; everything else passes through unread. */
const RunInstancesEventSchema = z.object({ eventSource: z.literal('ec2.amazonaws.com'), eventName: z.literal('RunInstances'),
    errorCode: z.undefined(), errorMessage: z.undefined(), awsRegion: z.string(), recipientAccountId: z.string(), eventID: z.string(),
    eventTime: z.string().refine(t => Number.isFinite(Date.parse(t))),
    // `$Latest`/`$Default` is not an immutable tuple; an absent template is recorded as absent.
    requestParameters: z.object({ launchTemplate: z.object({ launchTemplateId: z.string().regex(/^lt-[0-9a-f]{17}$/),
        version: z.string().regex(/^[1-9][0-9]{0,9}$/) }).passthrough().optional() }).passthrough(),
    responseElements: z.object({ instancesSet: z.object({ items: z.array(z.object({ instanceId: instance,
        imageId: z.string().regex(/^ami-[0-9a-f]{17}$/) }).passthrough()).length(1) }).passthrough() }).passthrough() }).passthrough();

/** One raw CloudTrail RunInstances record that launched exactly `instanceId` in this account and region. */
export function launchRecordOf(rawEvent: string, instanceId: string, region: string, accountId: string) {
    let e: z.infer<typeof RunInstancesEventSchema>;
    try { e = RunInstancesEventSchema.parse(parseRebaseJson(rawEvent, 65536)); } catch { return refuse('launch_tuple_invalid'); }
    const item = e.responseElements.instancesSet.items[0]!, template = e.requestParameters.launchTemplate;
    if (e.awsRegion !== region || e.recipientAccountId !== accountId || item.instanceId !== instanceId) refuse('launch_tuple_invalid');
    return { eventId: e.eventID, eventTime: new Date(e.eventTime).toISOString(), eventSha256: sha256(rawEvent), raw: rawEvent,
        // CloudTrail redacts user-data but records that the request carried it: any override is visible, its content never trusted.
        userDataOverride: Object.prototype.hasOwnProperty.call(e.requestParameters, 'userData'),
        tuple: { accountId, region, amiId: item.imageId, launchTemplateId: template?.launchTemplateId ?? null, launchTemplateVersion: template?.version ?? null } };
}
/** The source instance's launch: before the reservation, from an immutable launch template version. */
export function launchTupleOf(rawEvent: string, a: Pick<LowerAttestationRecord, 'sourceInstanceId' | 'region' | 'createdAt'>, accountId: string) {
    const r = launchRecordOf(rawEvent, a.sourceInstanceId, a.region, accountId);
    if (Date.parse(r.eventTime) > Date.parse(a.createdAt) || r.tuple.launchTemplateId === null || r.tuple.launchTemplateVersion === null) refuse('launch_tuple_invalid');
    return { ...r, tuple: { ...r.tuple, launchTemplateId: r.tuple.launchTemplateId!, launchTemplateVersion: r.tuple.launchTemplateVersion! } };
}

/**
 * Historical instance provenance, read under the lock. A released placement or a marker without instanceId needs one complete
 * binding of exactly this allocation (computer, owner, region, zone, generation, lease epoch, fence, volume, fsUuid):
 * - `poolInstanceId`: the ONE retired, settled pool claim row; or
 * - `migrations`: the committed CF→AWS migration rows of this computer, whose `_awsProvision` placement must match the allocation
 *   (migrationBinding). Its persisted deployment's launch tuple must also equal CloudTrail's, never the current config.
 * `usage`: the latest usage session; corroborating only, a conflict refuses.
 */
export interface MigrationProvenance { id: string; userId: string; fromProvider: string; toProvider: string; provision: unknown }
export interface InstanceProvenance {
    poolInstanceId: string | null;
    usage: { instanceId: string | null; closed: boolean; tied: boolean } | null;
    migrations?: readonly MigrationProvenance[];
}
const MigrationProvisionSchema = z.object({
    placement: z.object({ computerId: RebaseUuid, ownerUserId: RebaseUuid, provider: z.literal('aws-ec2'), store: z.literal('ebs'), generation: counter,
        leaseEpoch: counter, region: z.string(), zoneId: z.string(), instanceId: instance, volumeId: RebaseVolume, fsUuid: RebaseUuid, fenceToken: RebaseUuid }).passthrough(),
    deployment: z.object({ accountId: z.string(), region: z.string(), namespace: z.string(), amiId: z.string(), launchTemplateId: z.string(),
        launchTemplateVersion: z.string() }).passthrough(),
    released: z.boolean().optional() }).passthrough();
/** Committed CF→AWS rows whose persisted provision is exactly this allocation; each names an instance and its launch tuple. */
export function migrationBinding(a: Pick<LowerAttestationRecord, 'computerId' | 'ownerUserId' | 'region' | 'zoneId' | 'sourceVolumeId' | 'fsUuid'
    | 'sourceGeneration' | 'sourceLeaseEpoch' | 'sourceFenceToken'>, rows: readonly MigrationProvenance[]) {
    return rows.flatMap(row => {
        const parsed = MigrationProvisionSchema.safeParse(row.provision);
        if (!parsed.success || row.userId !== a.ownerUserId || row.fromProvider !== 'cloudflare' || row.toProvider !== 'aws-ec2' || parsed.data.released === true) return [];
        const pl = parsed.data.placement, d = parsed.data.deployment;
        if (pl.computerId !== a.computerId || pl.ownerUserId !== a.ownerUserId || pl.volumeId !== a.sourceVolumeId || pl.fsUuid !== a.fsUuid
            || pl.generation !== a.sourceGeneration || pl.leaseEpoch !== a.sourceLeaseEpoch || pl.fenceToken !== a.sourceFenceToken
            || pl.region !== a.region || pl.zoneId !== a.zoneId) return [];
        return [{ id: row.id, instanceId: pl.instanceId, provisionSha256: sha256(canonical(row.provision)), namespace: d.namespace,
            tuple: { accountId: d.accountId, region: d.region, amiId: d.amiId, launchTemplateId: d.launchTemplateId, launchTemplateVersion: d.launchTemplateVersion } }];
    });
}
/** The complete historical binding, or why not: a contradiction always refuses, an ambiguity refuses when the binding is needed. */
export function historicalBinding(a: Parameters<typeof migrationBinding>[0] & { sourceInstanceId: string }, provenance: InstanceProvenance) {
    const migrations = migrationBinding(a, provenance.migrations ?? []);
    const contradiction = (provenance.poolInstanceId !== null && provenance.poolInstanceId !== a.sourceInstanceId)
        || migrations.some(x => x.instanceId !== a.sourceInstanceId);
    const migration = migrations.length === 1 ? migrations[0]! : null;
    return { contradiction, migration, names: !contradiction && (provenance.poolInstanceId === a.sourceInstanceId || migration !== null) };
}
/** Reviewed pins: the attest.py sha256 and the exact AWS-RunShellScript document hash. Absent = nothing is adoptable. */
export interface LowerAttestationPins {
    sourceSha256: string | null; documentSha256: string | null;
    /** The reviewed maintenance AMI (also the registry's current target). */
    maintenanceAmiId: string | null;
    /** Must be null in this scope: the maintenance host has no user-data at all; any bootstrap pin is refused. */
    userDataSha256: string | null;
}

/**
 * A FRESH maintenance host for exactly this job: launched once (one RunInstances, after the reservation and before `notAfter`)
 * with the registry target's FULL immutable tuple (account, region, pinned AMI, launch template id and numeric version), no
 * user-data override in the launch and no user-data on the instance (this scope accepts none: a later attribute hash cannot
 * prove what booted), tagged managed-by/stage/job, and never reached by any SSM command or session other than
 * `expectedCommandIds` (none before the measurement, exactly the proof command at adoption). Shared by the runner's
 * pre-measurement check and the verifier.
 */
export function verifyFreshMaintenanceHost(a: Pick<LowerAttestationRecord, 'attestationId' | 'computerId' | 'region' | 'zoneId' | 'createdAt' | 'sourceInstanceId' | 'sourceVolumeId'>,
    hostId: string, host: Ec2EnrollmentView | null, o: MaintenanceHostObservations, expectedCommandIds: readonly string[],
    pins: Pick<LowerAttestationPins, 'maintenanceAmiId' | 'userDataSha256'>, target: Pick<LifecycleDeployment, 'accountId' | 'region' | 'namespace' | 'amiId'
        | 'launchTemplateId' | 'launchTemplateVersion'>, notAfter: Date) {
    if (!pins.maintenanceAmiId || pins.maintenanceAmiId !== target.amiId || pins.userDataSha256 !== null) refuse('source_not_pinned');
    const launches = o.launches.map(raw => launchRecordOf(raw, hostId, a.region, target.accountId));
    const launch = launches.length === 1 ? launches[0]! : refuse('untrusted_ami');
    const launchedAt = Date.parse(launch.eventTime);
    const userData = o.userData === null ? null : Buffer.from(o.userData, 'base64');
    if (launchedAt < Date.parse(a.createdAt) || launchedAt > notAfter.getTime() || launch.userDataOverride || target.region !== a.region
        || launch.tuple.amiId !== target.amiId || launch.tuple.launchTemplateId !== target.launchTemplateId || launch.tuple.launchTemplateVersion !== target.launchTemplateVersion
        || !host || host.instanceId !== hostId || host.imageId !== target.amiId || host.state !== 'running' || host.availabilityZoneId !== a.zoneId
        || host.tags['ezil:attestation-id'] !== a.attestationId || host.tags['ezil:computer-id'] !== a.computerId || host.tags['ezil:pool'] !== undefined
        || host.tags['ezil:managed-by'] !== 'app-computer-platform' || host.tags['ezil:stage'] !== target.namespace
        || host.volumes.some(x => x.volumeId === a.sourceVolumeId) || hostId === a.sourceInstanceId || userData === null || userData.length !== 0) refuse('untrusted_ami');
    // No host reuse, no interactive access, no bootstrap command: the only SSM traffic is the one reviewed proof command.
    if (o.sessionIds.length !== 0 || o.commandIds.length !== expectedCommandIds.length || o.commandIds.some(id => !expectedCommandIds.includes(id)))
        refuse('command_invalid');
    return launch;
}

/**
 * Pure: every proof, or a refusal. Every observation is the adopting side's own AWS read: the SSM command (pinned source, exact
 * arguments, this job's challenge, one maintenance instance), its exact document and its output (the receipt), EC2, CloudTrail.
 */
export function verifyLowerAttestation(a: LowerAttestationRecord, p: ImagePlacement, commandId: string, o: LowerAttestationObservations,
    registryEntry: unknown, identityCertificate: string | null, pins: LowerAttestationPins, now: Date,
    provenance: InstanceProvenance = { poolInstanceId: null, usage: null }): LowerAttestationProof {
    if (a.phase !== 'reserved') throw new ImageJobConflictError();
    const { deployment: d, releases } = attestationRegistry(registryEntry);
    const pinnedSourceSha256 = pins.sourceSha256;
    if (!pinnedSourceSha256 || !/^[0-9a-f]{64}$/.test(pinnedSourceSha256) || !pins.documentSha256 || !/^[0-9a-f]{64}$/.test(pins.documentSha256)
        || !pins.maintenanceAmiId || pins.userDataSha256 !== null) refuse('source_not_pinned');
    const cmd = o.command, run = o.command ? parseAttestCommand(o.command.commands) : null, doc = o.document;
    // The document is AWS's own, at the explicit version the command ran, with the reviewed hash: never `$DEFAULT`/`$LATEST`.
    if (!cmd || !doc || doc.name !== 'AWS-RunShellScript' || doc.owner !== 'Amazon' || doc.documentType !== 'Command' || doc.status !== 'Active'
        || !/^[1-9][0-9]{0,9}$/.test(cmd.documentVersion) || doc.documentVersion !== cmd.documentVersion || doc.hashType !== 'Sha256'
        || doc.hash !== pins.documentSha256) refuse('command_invalid');
    if (!cmd || !run || cmd.commandId !== commandId || cmd.documentName !== 'AWS-RunShellScript' || cmd.status !== 'Success'
        || cmd.instanceIds.length !== 1 || cmd.requestedAt.getTime() < Date.parse(a.createdAt) || cmd.requestedAt.getTime() > now.getTime()
        || run.attestationId !== a.attestationId || run.computerId !== a.computerId || run.originalVolumeId !== a.sourceVolumeId || run.fsUuid !== a.fsUuid
        || run.instanceId !== a.sourceInstanceId || run.generation !== a.sourceGeneration || run.leaseEpoch !== a.sourceLeaseEpoch
        || run.challenge !== a.challenge) refuse('command_invalid');
    // The delivered bytes are the reviewed source: decoded here, hashed here, equal to the pin and to the host-side check.
    if (sha256(Buffer.from(run!.sourceBase64, 'base64')) !== pinnedSourceSha256 || run!.sourceSha256 !== pinnedSourceSha256) refuse('source_not_pinned');
    const inv = o.invocation, maintenanceId = cmd!.instanceIds[0]!;
    if (!inv || inv.commandId !== commandId || inv.instanceId !== maintenanceId || inv.status !== 'Success' || inv.responseCode !== 0
        || inv.standardOutput.trim().split('\n').length !== 1) refuse('receipt_invalid');
    const receiptLine = inv!.standardOutput.trim();
    let r: z.infer<typeof LowerAttestationReceiptSchema>;
    try { r = LowerAttestationReceiptSchema.parse(parseRebaseJson(receiptLine, 16384)); } catch { return refuse('receipt_invalid'); }
    if (r.attestationId !== a.attestationId || r.computerId !== a.computerId || r.originalVolumeId !== a.sourceVolumeId || r.fsUuid !== a.fsUuid
        || r.sourceInstanceId !== a.sourceInstanceId || r.generation !== a.sourceGeneration || r.leaseEpoch !== a.sourceLeaseEpoch
        || r.challenge !== a.challenge || r.maintenanceInstanceId !== maintenanceId || r.cloneVolumeId !== run!.cloneVolumeId || r.snapshotId !== run!.snapshotId
        || r.cloneVolumeId === a.sourceVolumeId || r.maintenanceInstanceId === a.sourceInstanceId
        || Date.parse(r.observedAt) < cmd!.requestedAt.getTime() || Date.parse(r.observedAt) > now.getTime()) refuse('receipt_invalid');
    const opts = new Set(r.mountOptions);
    if (opts.has('rw') || !['ro', 'nosuid', 'nodev', 'noexec'].every(k => opts.has(k)) || !(opts.has('noload') || opts.has('norecovery'))) refuse('mount_not_readonly');
    // The hash is over the raw bytes the host read; the parse is the guard's strict marker shape.
    const raw = Buffer.from(r.markerBase64, 'base64');
    if (raw.toString('base64') !== r.markerBase64 || sha256(raw) !== r.markerSha256) refuse('marker_mismatch');
    let m: z.infer<typeof MarkerSchema>;
    try { m = MarkerSchema.parse(parseRebaseJson(raw.toString('utf8').trim(), 65536)); } catch { return refuse('marker_mismatch'); }
    if (m.computerId !== a.computerId || m.volumeId !== a.sourceVolumeId || m.fsUuid !== a.fsUuid
        // The marker's writer is exactly the reserved allocation: same generation AND lease epoch, no older epoch accepted.
        || (m.instanceId !== undefined && m.instanceId !== a.sourceInstanceId) || m.generation !== a.sourceGeneration || m.leaseEpoch !== a.sourceLeaseEpoch
        || m.lowerImageDigest !== r.lowerImageDigest) refuse('marker_mismatch');
    // Who wrote the marker. A present marker instanceId must be the source (above). A released placement (current NULL) or a
    // marker without instanceId is accepted only with the complete historical binding (pool claim row or committed migration of
    // exactly this allocation). Any contradicting record refuses; the usage ledger only corroborates.
    const binding = historicalBinding(a, provenance), historical = binding.names;
    if (binding.contradiction || p.instanceId !== a.currentInstanceId || (a.currentInstanceId !== null && a.currentInstanceId !== a.sourceInstanceId)
        || ((a.currentInstanceId === null || m.instanceId === undefined) && !historical)
        || (provenance.usage && (!provenance.usage.closed || provenance.usage.tied || provenance.usage.instanceId !== a.sourceInstanceId)))
        refuse('instance_provenance_missing');
    // Trusted AMI: AWS signed this host's identity, and its image is the registry's current target.
    const verdict = identityCertificate ? verifyIdentitySignature(r.identityDocument, r.identitySignature, identityCertificate, now) : { ok: false };
    let id: z.infer<typeof IdentitySchema>;
    try { id = IdentitySchema.parse(JSON.parse(r.identityDocument)); } catch { return refuse('identity_invalid'); }
    if (!verdict.ok || id.instanceId !== r.maintenanceInstanceId || id.accountId !== d.accountId || id.region !== a.region) refuse('identity_invalid');
    const target = releases.filter(x => x.amiId === d.amiId && x.launchTemplateId === d.launchTemplateId && x.launchTemplateVersion === d.launchTemplateVersion
        && x.lowerImageDigest === d.lowerImageDigest && x.stateMachineVersionArn === d.stateMachineVersionArn);
    const host = o.maintenance, tags = TRUSTED_TAGS(d.namespace, a.computerId);
    if (id.imageId !== d.amiId || target.length !== 1 || !host || host.instanceId !== r.maintenanceInstanceId || host.imageId !== id.imageId
        || host.state !== 'running' || host.availabilityZoneId !== a.zoneId || host.tags['ezil:attestation-id'] !== a.attestationId
        || host.tags['ezil:computer-id'] !== a.computerId || host.tags['ezil:pool'] !== undefined
        || host.volumes.some(x => x.volumeId === a.sourceVolumeId) || pins.maintenanceAmiId !== d.amiId) refuse('untrusted_ami');
    // Fresh for this job, launched before the command, and reached by exactly this one SSM command and no session.
    const maintenanceLaunch = verifyFreshMaintenanceHost(a, maintenanceId, host, o.host, [commandId], pins, d, cmd!.requestedAt);
    const s = o.snapshot;
    if (!s || s.snapshotId !== r.snapshotId || s.volumeId !== a.sourceVolumeId || s.state !== 'completed' || s.ownerId !== d.accountId
        || !s.encrypted || s.kmsKeyId !== d.dataKeyArn || s.startedAt.getTime() < Date.parse(a.createdAt)
        || s.tags['ezil:attestation-id'] !== a.attestationId || s.tags['ezil:computer-id'] !== a.computerId) refuse('snapshot_lineage_mismatch');
    const c = o.clone;
    if (!c || c.volumeId !== r.cloneVolumeId || c.snapshotId !== r.snapshotId || c.volumeId === a.sourceVolumeId || c.encrypted !== true
        || c.kmsKeyId !== d.dataKeyArn || c.zoneId !== a.zoneId || c.tags?.['ezil:attestation-id'] !== a.attestationId || c.tags?.['ezil:pool'] !== undefined
        || (c.attachments ?? []).length > 1 || (c.attachments ?? []).some(x => x.instanceId !== r.maintenanceInstanceId)) refuse('clone_lineage_mismatch');
    // The fence proof the marker lacks: the original still carries exactly the reserved generation and fence, detached.
    const v = o.original;
    if (!v || v.volumeId !== a.sourceVolumeId || v.state !== 'available' || (v.attachments ?? []).length !== 0 || v.encrypted !== true
        || v.kmsKeyId !== d.dataKeyArn || !v.tags || Object.entries(tags).some(([k, value]) => v.tags![k] !== value) || v.tags['ezil:pool'] !== undefined
        || v.tags['ezil:generation'] !== String(a.sourceGeneration) || v.tags['ezil:fence-token'] !== a.sourceFenceToken) refuse('original_not_fenced');
    const launch = launchOf(o.runInstances, a, d.accountId);
    const joined = releases.filter(x => LAUNCH_TUPLE.every(k => x[k] === launch.tuple[k]));
    if (joined.length !== 1 || joined[0]!.namespace !== d.namespace || joined[0]!.lowerImageDigest !== m.lowerImageDigest) refuse('release_mismatch');
    // A committed migration of this allocation persisted the deployment it launched from: it must be the launch CloudTrail saw.
    const migration = binding.migration;
    if (migration && (migration.namespace !== d.namespace || LAUNCH_TUPLE.some(k => migration.tuple[k] !== launch.tuple[k]))) refuse('release_mismatch');
    // Raw proof stays backend-only: this row, never an API answer or operator stdout.
    const poolNames = provenance.poolInstanceId === a.sourceInstanceId;
    const evidence = { v: 1, trust: 'aws-read:ssm-command+invocation,ec2,cloudtrail',
        instanceProvenance: m.instanceId ? 'marker' : poolNames ? 'pool-claim' : 'committed-migration',
        placementInstance: a.currentInstanceId === null ? 'released' : 'current', poolClaimNamesSource: poolNames,
        committedMigration: migration ? { id: migration.id, provisionSha256: migration.provisionSha256 } : null,
        usageLedger: provenance.usage === null ? 'none' : 'corroborates',
        command: { commandId, documentName: cmd!.documentName, documentVersion: cmd!.documentVersion, documentSha256: doc!.hash, requestedAt: cmd!.requestedAt.toISOString(), instanceId: maintenanceId,
            sourceSha256: pinnedSourceSha256, commandSha256: sha256(JSON.stringify(cmd!.commands)) },
        receiptSha256: sha256(receiptLine), receipt: receiptLine, marker: m,
        identity: { instanceId: id.instanceId, imageId: id.imageId, accountId: id.accountId, region: id.region },
        maintenanceLaunch: { eventId: maintenanceLaunch.eventId, eventTime: maintenanceLaunch.eventTime, eventSha256: maintenanceLaunch.eventSha256,
            ...maintenanceLaunch.tuple, userDataSha256: pins.userDataSha256, commandIds: [...o.host.commandIds], sessions: o.host.sessionIds.length },
        launch: { eventId: launch.eventId, eventTime: launch.eventTime, eventSha256: launch.eventSha256, raw: launch.raw, ...launch.tuple },
        snapshot: { snapshotId: s!.snapshotId, volumeId: s!.volumeId, startedAt: s!.startedAt.toISOString() },
        clone: { volumeId: c!.volumeId, snapshotId: c!.snapshotId, attachedTo: (c!.attachments ?? []).map(x => x.instanceId) },
        original: { volumeId: v!.volumeId, state: v!.state, generation: v!.tags!['ezil:generation'], fenceToken: v!.tags!['ezil:fence-token'] } };
    const sealed = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
    return { commandId, measuredDigest: m.lowerImageDigest, measuredAt: r.observedAt, markerSha256: r.markerSha256, snapshotId: s!.snapshotId,
        cloneVolumeId: c!.volumeId, maintenanceInstanceId: r.maintenanceInstanceId, maintenanceAmiId: id.imageId, sourceRelease: joined[0]!, evidence: sealed };
}

export function createLowerAttestationStore(db: PlacementDb) {
    const read = async (tx: PlacementExecutor, attestationId: string) => {
        const rows = rowsOf(await tx.execute(sql`/* attest:read */ SELECT ${columnNames} FROM public.ezil_computer_lower_attestations
            WHERE attestation_id = ${attestationId}::uuid LIMIT 2 FOR UPDATE`));
        if (rows.length > 1) throw new ImageJobConflictError();
        return rows.length ? parseLowerAttestationRow(rows[0]!) : null;
    };
    const owner = async (tx: PlacementExecutor, computerId: string) => {
        const rows = rowsOf(await tx.execute(sql`SELECT user_id::text AS user_id FROM public.ezil_computers
            WHERE id = ${computerId}::uuid AND deleted_at IS NULL FOR UPDATE`));
        return rows.length === 1 ? String(rows[0]!.user_id) : null;
    };
    /** Still fenced by exactly this reservation, same owner, not deleted, byte-for-byte the reserved NULL row. */
    const unchanged = async (tx: PlacementExecutor, p: ImagePlacement | null, a: LowerAttestationRecord): Promise<boolean> => !!p
        && p.imageUpgradeJobId === a.attestationId && p.ownerUserId === a.ownerUserId && await owner(tx, a.computerId) === a.ownerUserId
        && p.instanceId === a.currentInstanceId && p.lowerImageDigest === null && p.lowerDigestObservedAt === null && placementDigest(p) === a.reservedRowSha256;
    /** The claim row of exactly this allocation and the latest usage session, both locked (see InstanceProvenance). */
    const provenance = async (tx: PlacementExecutor, t: { computerId: string; ownerUserId: string; region: string; zoneId: string;
        sourceGeneration: number; sourceLeaseEpoch: number; sourceFenceToken: string; sourceVolumeId: string }): Promise<InstanceProvenance> => {
        const claims = rowsOf(await tx.execute(sql`/* attest:pool-claim-provenance */ SELECT instance_id FROM public.ezil_compute_pool_hosts
            WHERE leased_computer_id = ${t.computerId}::uuid AND region = ${t.region} AND zone_id = ${t.zoneId}
              AND claim_generation = ${t.sourceGeneration} AND claim_lease_epoch = ${t.sourceLeaseEpoch} AND claim_fence = ${t.sourceFenceToken}
              AND claim_volume_serial = ${t.sourceVolumeId.replace('-', '')} AND state = 'retired' AND dispatch_status = 'settled'
              AND instance_id IS NOT NULL AND lifecycle_job_id IS NOT NULL AND lifecycle_digest IS NOT NULL LIMIT 2 FOR UPDATE`));
        const usage = rowsOf(await tx.execute(sql`/* attest:usage-provenance */ SELECT instance_id, stopped_at, started_at FROM public.ezil_compute_usage
            WHERE computer_id = ${t.computerId}::uuid AND user_id = ${t.ownerUserId}::uuid ORDER BY started_at DESC LIMIT 2 FOR UPDATE`));
        const migrations = rowsOf(await tx.execute(sql`/* attest:migration-provenance */ SELECT id::text AS id, user_id::text AS user_id,
            from_provider, to_provider, workspace_head -> '_awsProvision' AS provision FROM public.ezil_compute_migrations
            WHERE computer_id = ${t.computerId}::uuid AND state = 'committed' ORDER BY created_at DESC, id LIMIT 8 FOR UPDATE`));
        if (migrations.length > 7) throw new ImageJobConflictError();
        const [row, next] = usage;
        // Two claim rows for one allocation are a contradiction, never "no claim": the sentinel names no instance.
        return { poolInstanceId: claims.length === 0 ? null : claims.length === 1 && typeof claims[0]!.instance_id === 'string' ? claims[0]!.instance_id : 'ambiguous',
            usage: row ? { instanceId: typeof row.instance_id === 'string' ? row.instance_id : null, closed: row.stopped_at !== null,
                tied: !!next && iso(next.started_at) === iso(row.started_at) } : null,
            migrations: migrations.map(m => ({ id: String(m.id), userId: String(m.user_id), fromProvider: String(m.from_provider), toProvider: String(m.to_provider),
                provision: typeof m.provision === 'string' ? JSON.parse(m.provision) : m.provision })) };
    };
    const seal = async (tx: PlacementExecutor, a: LowerAttestationRecord, next: LowerAttestationRecord) => {
        const parsed = parseLowerAttestationRow(Object.fromEntries(COLUMNS.map(([key, name]) => [name, next[key]])));
        const rows = rowsOf(await tx.execute(sql`/* attest:seal */ UPDATE public.ezil_computer_lower_attestations SET
            ${sql.join(COLUMNS.filter(([, name]) => !['attestation_id', 'computer_id', 'created_at'].includes(name))
                .map(([key, name, type]) => sql`${sql.raw(name)} = ${valueSql(parsed, key, type)}`), sql`, `)}
            WHERE attestation_id = ${a.attestationId}::uuid AND computer_id = ${a.computerId}::uuid AND phase = 'reserved'
              AND updated_at = ${a.updatedAt}::timestamptz RETURNING ${columnNames}`));
        if (rows.length !== 1) throw new ImageJobConflictError();
        return parseLowerAttestationRow(rows[0]!);
    };
    const time = (a: LowerAttestationRecord, now: Date) => new Date(Math.max(now.getTime(), Date.parse(a.updatedAt) + 1)).toISOString();
    /** Terminal refusal under the lock: seal the row, clear ONLY this attestation's own reservation if it is still there
     * (whatever else drifted), and never write the lower. */
    const terminate = async (tx: PlacementExecutor, a: LowerAttestationRecord, code: LowerAttestationFailure, now: Date) => {
        const sealed = await seal(tx, a, { ...a, phase: 'refused', failureCode: code, updatedAt: time(a, now), completedAt: time(a, now) });
        await tx.execute(sql`/* attest:release-own */ UPDATE public.ezil_computer_placements SET image_upgrade_job_id = NULL,
            updated_at = GREATEST(date_trunc('milliseconds', now()), date_trunc('milliseconds', updated_at) + interval '1 millisecond')
            WHERE computer_id = ${a.computerId}::uuid AND image_upgrade_job_id = ${a.attestationId}::uuid RETURNING computer_id`);
        return sealed;
    };
    return {
        async inspect(attestationId: string, computerId: string) {
            const a = await read(db, attestationId);
            return a && a.computerId === computerId ? a : null;
        },
        async reserve(input: LowerAttestationReserveRequest, now: Date): Promise<LowerAttestationRecord> {
            const req = LowerAttestationReserveRequestSchema.parse(input), requestSha256 = requestDigest(req);
            return withAdmission(db, async (tx, lock) => {
                const p = await lockImagePlacement(tx, lock, req.computerId);
                const existing = await read(tx, req.attestationId);
                if (existing) {
                    // Exact replay only: the same request answers with the recorded row, whatever its phase.
                    if (existing.requestSha256 !== requestSha256 || existing.computerId !== req.computerId) throw new ImageJobConflictError();
                    return existing;
                }
                const ownerUserId = await owner(tx, req.computerId);
                if (!p || !ownerUserId || p.ownerUserId !== ownerUserId || p.provider !== 'aws-ec2' || p.store !== 'ebs' || p.state !== 'STOPPED'
                    || p.lowerImageDigest !== null || p.lowerDigestObservedAt !== null || p.imageUpgradeJobId !== null || p.lifecycleJobId !== null
                    || p.enrollNonceHash !== null || p.volumeId !== req.sourceVolumeId || p.fsUuid !== req.fsUuid
                    || p.generation !== req.sourceGeneration || p.leaseEpoch !== req.sourceLeaseEpoch || p.fenceToken !== req.sourceFenceToken
                    || p.region !== req.region || p.zoneId !== req.zoneId) throw new ImageJobConflictError();
                // A released placement (instance_id NULL) names its source only through the complete historical binding of exactly
                // this allocation (claim row or committed migration); a current instance must be the source. Contradicting records
                // or conflicting usage history refuse either way.
                const history = await provenance(tx, { ...req, ownerUserId }), binding = historicalBinding({ ...req, ownerUserId }, history);
                if (binding.contradiction || (p.instanceId === null ? !binding.names : p.instanceId !== req.sourceInstanceId)
                    || (history.usage && (!history.usage.closed || history.usage.tied || history.usage.instanceId !== req.sourceInstanceId)))
                    throw new ImageJobConflictError();
                await assertNoImageReservation(tx, req.computerId);
                const migrations = rowsOf(await tx.execute(sql`SELECT id FROM public.ezil_compute_migrations
                    WHERE computer_id = ${req.computerId}::uuid AND state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator') LIMIT 2 FOR UPDATE`));
                const pool = rowsOf(await tx.execute(sql`SELECT id FROM public.ezil_compute_pool_hosts
                    WHERE leased_computer_id = ${req.computerId}::uuid AND state = 'leased' LIMIT 2 FOR UPDATE`));
                if (migrations.length || pool.length || await reverseMoveHolds(tx, req.computerId)) throw new ImageJobConflictError();
                const at = now.toISOString();
                const a = parseLowerAttestationRow(Object.fromEntries(COLUMNS.map(([key, name]) => [name, ({
                    attestationId: req.attestationId, computerId: req.computerId, ownerUserId, region: req.region, zoneId: req.zoneId,
                    sourceInstanceId: req.sourceInstanceId, sourceVolumeId: req.sourceVolumeId, fsUuid: req.fsUuid, sourceGeneration: req.sourceGeneration,
                    currentInstanceId: p.instanceId, sourceLeaseEpoch: req.sourceLeaseEpoch, sourceFenceToken: req.sourceFenceToken, reservedRowSha256: placementDigest(p),
                    requestSha256, challenge: randomBytes(32).toString('hex'), phase: 'reserved', createdAt: at, updatedAt: at } as Record<string, unknown>)[key] ?? null])));
                const rows = rowsOf(await tx.execute(sql`/* attest:insert */ INSERT INTO public.ezil_computer_lower_attestations (${columnNames})
                    VALUES (${sql.join(COLUMNS.map(([key, , type]) => valueSql(a, key, type)), sql`, `)}) RETURNING ${columnNames}`));
                if (rows.length !== 1) throw new ImageJobConflictError();
                await setImageReservation(tx, lock, p, a.attestationId);
                return parseLowerAttestationRow(rows[0]!);
            });
        },
        /**
         * Dry run: the same locks, drift, expiry, provenance and proof as adopt, and no write of any kind. Returns what adopt
         * would seal now (`adopted` with the measured digest, or the refusal code); a later adopt re-proves everything.
         */
        async preview(attestationId: string, computerId: string,
            prove: (a: LowerAttestationRecord, p: ImagePlacement, provenance: InstanceProvenance) => LowerAttestationProof, now: Date)
            : Promise<{ phase: LowerAttestationRecord['phase']; failureCode: LowerAttestationFailure | null; measuredDigest: string | null }> {
            return withAdmission(db, async (tx, lock) => {
                const p = await lockImagePlacement(tx, lock, computerId);
                const a = await read(tx, attestationId);
                if (!a || a.computerId !== computerId) throw new ImageJobConflictError();
                if (a.phase !== 'reserved') return { phase: a.phase, failureCode: a.failureCode, measuredDigest: a.measuredDigest };
                const refused = (failureCode: LowerAttestationFailure) => ({ phase: 'refused' as const, failureCode, measuredDigest: null });
                if (!await unchanged(tx, p, a)) return refused('placement_changed');
                if (now.getTime() - Date.parse(a.createdAt) > LOWER_ATTESTATION_TTL_MS) return refused('reservation_expired');
                try { return { phase: 'adopted' as const, failureCode: null, measuredDigest: prove(a, p!, await provenance(tx, a)).measuredDigest }; }
                catch (error) {
                    if (!(error instanceof LowerAttestationRefusal)) throw error;
                    return refused(error.code);
                }
            });
        },
        /**
         * One transaction under the placement lock: the proof is re-checked against the locked row, then the NULL row is
         * compare-and-set. Drift, expiry or a proof refusal seals `refused` and releases only this reservation (lower stays NULL).
         */
        async adopt(attestationId: string, computerId: string,
            prove: (a: LowerAttestationRecord, p: ImagePlacement, provenance: InstanceProvenance) => LowerAttestationProof, now: Date) {
            return withAdmission(db, async (tx, lock) => {
                const p = await lockImagePlacement(tx, lock, computerId);
                const a = await read(tx, attestationId);
                if (!a || a.computerId !== computerId) throw new ImageJobConflictError();
                if (a.phase !== 'reserved') return a;               // exactly once: the sealed row answers a replay
                if (!await unchanged(tx, p, a)) return terminate(tx, a, 'placement_changed', now);
                if (now.getTime() - Date.parse(a.createdAt) > LOWER_ATTESTATION_TTL_MS) return terminate(tx, a, 'reservation_expired', now);
                let proof: LowerAttestationProof;
                try { proof = prove(a, p!, await provenance(tx, a)); }
                catch (error) {
                    if (!(error instanceof LowerAttestationRefusal)) throw error;
                    return terminate(tx, a, error.code, now);
                }
                const sealed = await seal(tx, a, { ...a, phase: 'adopted', commandId: proof.commandId, evidence: proof.evidence, evidenceSha256: evidenceDigest(proof.evidence),
                    measuredDigest: proof.measuredDigest, measuredAt: proof.measuredAt, markerSha256: proof.markerSha256, snapshotId: proof.snapshotId,
                    cloneVolumeId: proof.cloneVolumeId, maintenanceInstanceId: proof.maintenanceInstanceId, maintenanceAmiId: proof.maintenanceAmiId,
                    sourceRelease: proof.sourceRelease, updatedAt: time(a, now), completedAt: time(a, now) });
                // Only the two lower columns and the fence change, and only on the exact reserved, still-NULL row: instance_id is
                // compared with the frozen current value (NULL for a released placement), never the historical source.
                const rows = rowsOf(await tx.execute(sql`/* attest:adopt-cas */ UPDATE public.ezil_computer_placements
                    SET lower_image_digest = ${proof.measuredDigest}::text, lower_digest_observed_at = ${proof.measuredAt}::timestamptz,
                        image_upgrade_job_id = NULL,
                        updated_at = GREATEST(date_trunc('milliseconds', now()), date_trunc('milliseconds', updated_at) + interval '1 millisecond')
                    WHERE computer_id = ${a.computerId}::uuid AND owner_user_id = ${a.ownerUserId}::uuid AND provider = 'aws-ec2'
                      AND workspace_store = 'ebs' AND state = 'STOPPED' AND generation = ${a.sourceGeneration} AND lease_epoch = ${a.sourceLeaseEpoch}
                      AND fence_token = ${a.sourceFenceToken}::uuid AND instance_id IS NOT DISTINCT FROM ${a.currentInstanceId}::text AND volume_id = ${a.sourceVolumeId}
                      AND fs_uuid = ${a.fsUuid}::uuid AND region = ${a.region} AND zone_id = ${a.zoneId} AND lifecycle_job_id IS NULL
                      AND image_upgrade_job_id = ${a.attestationId}::uuid AND lower_image_digest IS NULL AND lower_digest_observed_at IS NULL
                    RETURNING computer_id`));
                if (rows.length !== 1) throw new ImageJobConflictError();
                return sealed;
            });
        },
        /** Abort at any time, also after owner change, deletion or row drift: an interrupted measurement never strands the fence. */
        async refuse(attestationId: string, computerId: string, now: Date) {
            return withAdmission(db, async (tx, lock) => {
                await lockImagePlacement(tx, lock, computerId);
                const a = await read(tx, attestationId);
                if (!a || a.computerId !== computerId) throw new ImageJobConflictError();
                return a.phase === 'reserved' ? terminate(tx, a, 'operator_abandoned', now) : a;
            });
        },
    };
}
export type LowerAttestationStore = ReturnType<typeof createLowerAttestationStore>;

/**
 * Every read the verifier needs. Least privilege for whoever adopts (the app role or the operator profile runner):
 * ec2:DescribeSnapshots, ec2:DescribeVolumes, ec2:DescribeInstances, ec2:DescribeInstanceAttribute (userData), ssm:ListCommands,
 * ssm:DescribeDocument, ssm:GetCommandInvocation, ssm:DescribeSessions, cloudtrail:LookupEvents. A missing reader fails closed
 * (`attest_readers_unavailable`), never trusting relayed data instead. Listing readers read every page; a partial listing throws.
 */
export interface LowerAttestationReaders {
    describeSnapshot(region: string, snapshotId: string): Promise<RebaseSnapshotView | null>;
    describeVolume(region: string, volumeId: string): Promise<Ec2VolumeView | null>;
    describeForEnrollment(region: string, instanceId: string): Promise<Ec2EnrollmentView | null>;
    describeUserData(region: string, instanceId: string): Promise<string | null>;
    getCommand(region: string, commandId: string): Promise<SsmCommandView | null>;
    describeDocument(region: string, name: string, documentVersion: string): Promise<SsmDocumentView | null>;
    getCommandInvocation(region: string, commandId: string, instanceId: string): Promise<SsmInvocationView | null>;
    listInstanceCommands(region: string, instanceId: string): Promise<string[]>;
    listInstanceSessions(region: string, instanceId: string): Promise<string[]>;
    lookupRunInstances(region: string, instanceId: string): Promise<string[]>;
}
/** The maintenance host's own history, read in full (shared by the runner's pre-measurement check and adoption). */
export async function maintenanceHostObservations(readers: LowerAttestationReaders, region: string, hostId: string): Promise<MaintenanceHostObservations> {
    return { launches: await readers.lookupRunInstances(region, hostId), userData: await readers.describeUserData(region, hostId),
        commandIds: await readers.listInstanceCommands(region, hostId), sessionIds: await readers.listInstanceSessions(region, hostId) };
}
/** Every reader from one collaborator object, or null: no partial reader set is ever used. */
export function lowerAttestationReaders(source: Partial<LowerAttestationReaders> | null | undefined): LowerAttestationReaders | null {
    const keys = ['describeSnapshot', 'describeVolume', 'describeForEnrollment', 'describeUserData', 'getCommand', 'describeDocument', 'getCommandInvocation',
        'listInstanceCommands', 'listInstanceSessions', 'lookupRunInstances'] as const;
    if (!source || keys.some(k => typeof source[k] !== 'function')) return null;
    return Object.fromEntries(keys.map(k => [k, (source[k] as (...args: never[]) => unknown).bind(source)])) as unknown as LowerAttestationReaders;
}
/** The pinned sha256 of the reviewed infra/host-agent/lib/ezil_host/attest.py; absent = nothing is adoptable. */
export const LOWER_ATTEST_SOURCE_SHA256_ENV = 'EZIL_LOWER_ATTEST_SOURCE_SHA256';
/** The reviewed AWS-RunShellScript document hash (ssm:DescribeDocument Hash, Sha256) for the version the command names. */
export const LOWER_ATTEST_DOCUMENT_SHA256_ENV = 'EZIL_LOWER_ATTEST_SSM_DOCUMENT_SHA256';
/** The reviewed maintenance AMI, and the reviewed bootstrap user-data sha256 (absent = the host must have no user-data). */
export const LOWER_ATTEST_MAINTENANCE_AMI_ENV = 'EZIL_LOWER_ATTEST_MAINTENANCE_AMI';
export const LOWER_ATTEST_USERDATA_SHA256_ENV = 'EZIL_LOWER_ATTEST_USERDATA_SHA256';
export const lowerAttestationPins = (env: Env): LowerAttestationPins => ({ sourceSha256: env[LOWER_ATTEST_SOURCE_SHA256_ENV] ?? null,
    documentSha256: env[LOWER_ATTEST_DOCUMENT_SHA256_ENV] ?? null, maintenanceAmiId: env[LOWER_ATTEST_MAINTENANCE_AMI_ENV] ?? null,
    userDataSha256: env[LOWER_ATTEST_USERDATA_SHA256_ENV] ?? null });
/** Operator answer: identifiers and phase only (raw proof and marker stay in the row). The challenge is returned while reserved. */
export function attestationBody(a: LowerAttestationRecord | null) {
    return a ? { schemaVersion: 1, attestationId: a.attestationId, phase: a.phase, failureCode: a.failureCode,
        challenge: a.phase === 'reserved' ? a.challenge : null, commandId: a.commandId, measuredDigest: a.measuredDigest, measuredAt: a.measuredAt,
        evidenceSha256: a.evidenceSha256, sourceReleaseAmiId: a.sourceRelease?.amiId ?? null } : { schemaVersion: 1, phase: 'absent' };
}

/**
 * AWS reads happen outside the lock against the reserved row; adopt re-proves them against the locked row in its transaction,
 * so a placement that changed meanwhile is refused (`placement_changed`), never adopted. Reader errors throw before any write.
 */
export async function adoptLowerAttestation(deps: { store: LowerAttestationStore; readers: LowerAttestationReaders; env: Env; now: () => Date },
    input: LowerAttestationAdoptRequest) {
    const req = LowerAttestationAdoptRequestSchema.parse(input);
    const a = await deps.store.inspect(req.attestationId, req.computerId);
    if (!a) throw new ImageJobConflictError();
    if (a.phase !== 'reserved') return a;
    const command = await deps.readers.getCommand(a.region, req.commandId);
    const run = command ? parseAttestCommand(command.commands) : null, host = command?.instanceIds.length === 1 ? command.instanceIds[0]! : null;
    const ids = { snapshot: RebaseSnapshot.safeParse(run?.snapshotId), clone: RebaseVolume.safeParse(run?.cloneVolumeId), host: instance.safeParse(host) };
    const observations: LowerAttestationObservations = { command,
        document: command && /^[1-9][0-9]{0,9}$/.test(command.documentVersion)
            ? await deps.readers.describeDocument(a.region, command.documentName, command.documentVersion) : null,
        invocation: ids.host.success ? await deps.readers.getCommandInvocation(a.region, req.commandId, ids.host.data) : null,
        snapshot: ids.snapshot.success ? await deps.readers.describeSnapshot(a.region, ids.snapshot.data) : null,
        clone: ids.clone.success ? await deps.readers.describeVolume(a.region, ids.clone.data) : null,
        original: await deps.readers.describeVolume(a.region, a.sourceVolumeId),
        maintenance: ids.host.success ? await deps.readers.describeForEnrollment(a.region, ids.host.data) : null,
        runInstances: await deps.readers.lookupRunInstances(a.region, a.sourceInstanceId),
        host: ids.host.success ? await maintenanceHostObservations(deps.readers, a.region, ids.host.data) : { launches: [], userData: null, commandIds: [], sessionIds: [] } };
    const registry = (parseRebaseJson(deps.env[LIFECYCLE_DEPLOYMENTS_ENV] ?? '{}', 65536) as Record<string, unknown>)[a.region];
    const certificate = readIdentityCertificate(deps.env, a.region);
    const pins = lowerAttestationPins(deps.env);
    const prove = (locked: LowerAttestationRecord, p: ImagePlacement, provenance: InstanceProvenance) =>
        verifyLowerAttestation(locked, p, req.commandId, observations, registry, certificate, pins, deps.now(), provenance);
    return deps.store.adopt(a.attestationId, a.computerId, prove, deps.now());
}

/** The operator runner's dry run: the same AWS reads and the same locked proof as adoptLowerAttestation, writing nothing. */
export async function previewLowerAttestation(deps: { store: LowerAttestationStore; readers: LowerAttestationReaders; env: Env; now: () => Date },
    input: LowerAttestationAdoptRequest) {
    let preview: Awaited<ReturnType<LowerAttestationStore['preview']>> | null = null;
    const store = { ...deps.store, adopt: (async (attestationId, computerId, prove, now) => {
        preview = await deps.store.preview(attestationId, computerId, prove, now);
        return deps.store.inspect(attestationId, computerId);
    }) as LowerAttestationStore['adopt'] };
    const sealed = await adoptLowerAttestation({ ...deps, store }, input);
    return preview ?? { phase: sealed.phase, failureCode: sealed.failureCode, measuredDigest: sealed.measuredDigest };
}
