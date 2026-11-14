import { createHash } from 'node:crypto';
import fx from './aws-identity.fixtures.json';
import { fixtureRebaseDeployments, fixtureRebaseRelease } from './aws-intent.test-support';
import { buildAttestCommand, placementDigest, requestDigest, type AttestCommandInput, type LowerAttestationRecord, type LowerAttestationObservations,
    type LowerAttestationReserveRequest } from './aws-lower-attestation';
import type { ImagePlacement } from './placement';

/** Measured lower: the source release's (fixture 'a'); target is 'b'. Identity fixture = maintenance host on the target AMI. */
export const MEASURED = 'sha256:' + 'a'.repeat(64);
export const MAINTENANCE = 'i-22222222222222222';
export const NOW = new Date('2026-10-22T12:00:00.000Z');
export const CREATED = '2026-10-22T11:00:00.000Z';
export const CERT = fx.cert_rsa;
const { deployment, sourceDeployment } = fixtureRebaseDeployments();
export const DEPLOYMENT = deployment;
export const SOURCE_RELEASE = fixtureRebaseRelease(sourceDeployment);
export const TARGET_RELEASE = fixtureRebaseRelease(deployment);
/** Shares the measured lower with SOURCE_RELEASE on another AMI (the AMI44/AMI46 case): never selected by lower alone. */
export const ALIAS_RELEASE = { ...SOURCE_RELEASE, amiId: 'ami-33333333333333333', createdAt: '2026-10-22T10:30:00.000Z' };
export const registryEntry = (releases: unknown[] = [SOURCE_RELEASE, ALIAS_RELEASE, TARGET_RELEASE]) => ({ ...DEPLOYMENT, releases });

export const RESERVE: LowerAttestationReserveRequest = { schemaVersion: 1, operation: 'attest-lower-reserve',
    attestationId: '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a', computerId: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
    sourceInstanceId: 'i-11111111111111111', sourceVolumeId: 'vol-11111111111111111', fsUuid: '22222222-2222-4222-8222-222222222222',
    sourceGeneration: 1, sourceLeaseEpoch: 3, sourceFenceToken: 'fefefefe-fefe-4efe-8efe-fefefefefefe', region: 'ap-south-1', zoneId: 'aps1-az1' };
export const OWNER = '33333333-3333-4333-8333-333333333333';
export const CLONE = 'vol-99999999999999999';
export const SNAPSHOT = 'snap-88888888888888888';
export const CHALLENGE = 'c'.repeat(64);
export const COMMAND_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
/** Stand-in for the reviewed attest.py bytes; the pin is its sha256. */
export const SOURCE = Buffer.from('# reviewed attest.py stand-in\n');
export const PINNED = createHash('sha256').update(SOURCE).digest('hex');
/** Stand-in for the reviewed AWS-RunShellScript document hash (ssm:DescribeDocument). */
export const DOCUMENT_HASH = 'e'.repeat(64);
export const PINS = { sourceSha256: PINNED, documentSha256: DOCUMENT_HASH };
export const commandInput = (over: Partial<AttestCommandInput> = {}): AttestCommandInput => ({ sourceBase64: SOURCE.toString('base64'), sourceSha256: PINNED,
    attestationId: RESERVE.attestationId, computerId: RESERVE.computerId, originalVolumeId: RESERVE.sourceVolumeId, cloneVolumeId: CLONE, snapshotId: SNAPSHOT,
    fsUuid: RESERVE.fsUuid, instanceId: RESERVE.sourceInstanceId, generation: 1, leaseEpoch: 3, challenge: CHALLENGE, ...over });

export function placement(over: Partial<ImagePlacement> = {}): ImagePlacement {
    return { computerId: RESERVE.computerId, ownerUserId: OWNER, provider: 'aws-ec2', store: 'ebs', generation: 1, leaseEpoch: 3, state: 'STOPPED',
        region: 'ap-south-1', zoneId: 'aps1-az1', instanceId: RESERVE.sourceInstanceId, instanceType: 'm6i.large', volumeId: RESERVE.sourceVolumeId,
        fsUuid: RESERVE.fsUuid, tunnelId: null, enrollNonceHash: null, enrollExpiresAt: null, enrollConsumedHash: null, leaseUntil: null, presenceAt: null,
        fenceToken: RESERVE.sourceFenceToken, lifecycleJobId: null, lifecycleDigest: null, lastError: null, updatedAt: new Date(CREATED),
        lowerImageDigest: null, lowerDigestObservedAt: null, imageUpgradeJobId: RESERVE.attestationId, ...over } as ImagePlacement;
}
export function reserved(over: Partial<LowerAttestationRecord> = {}): LowerAttestationRecord {
    const { operation: _op, schemaVersion: _v, ...t } = RESERVE;
    return { ...t, ownerUserId: OWNER, reservedRowSha256: placementDigest(placement()), requestSha256: requestDigest(RESERVE), challenge: CHALLENGE,
        currentInstanceId: RESERVE.sourceInstanceId, commandId: null, phase: 'reserved',
        evidence: null, evidenceSha256: null, measuredDigest: null, measuredAt: null, markerSha256: null, snapshotId: null, cloneVolumeId: null,
        maintenanceInstanceId: null, maintenanceAmiId: null, sourceRelease: null, failureCode: null, createdAt: CREATED, updatedAt: CREATED, completedAt: null, ...over };
}

export const MARKER = { computerId: RESERVE.computerId, volumeId: RESERVE.sourceVolumeId, fsUuid: RESERVE.fsUuid, generation: 1, leaseEpoch: 3,
    lowerImageDigest: MEASURED, instanceId: RESERVE.sourceInstanceId };
/** Exactly what host `attest-lower` prints (json.dumps sort_keys, compact). */
export function receipt(over: Record<string, unknown> = {}, marker: Record<string, unknown> | string = MARKER): string {
    const raw = Buffer.from((typeof marker === 'string' ? marker : JSON.stringify(marker)) + '\n');
    const r: Record<string, unknown> = { v: 1, kind: 'ezil-lower-attestation-receipt', attestationId: RESERVE.attestationId, computerId: RESERVE.computerId,
        originalVolumeId: RESERVE.sourceVolumeId, cloneVolumeId: CLONE, snapshotId: SNAPSHOT, fsUuid: RESERVE.fsUuid, sourceInstanceId: RESERVE.sourceInstanceId,
        generation: 1, leaseEpoch: 3, challenge: CHALLENGE, maintenanceInstanceId: MAINTENANCE, identityDocument: fx.document, identitySignature: fx.pkcs7_rsa_detached,
        mountOptions: ['nodev', 'noexec', 'norecovery', 'nosuid', 'ro'], blockDeviceReadOnly: true, markerBase64: raw.toString('base64'),
        markerSha256: createHash('sha256').update(raw).digest('hex'), lowerImageDigest: MEASURED, observedAt: '2026-10-22T11:30:00.000Z', ...over };
    return JSON.stringify(Object.fromEntries(Object.keys(r).sort().map(k => [k, r[k]])));
}
export function cloudTrail(over: Record<string, unknown> = {}, item: Record<string, unknown> = {}, template: Record<string, unknown> | null = {}): string {
    return JSON.stringify({ eventVersion: '1.08', eventSource: 'ec2.amazonaws.com', eventName: 'RunInstances', awsRegion: 'ap-south-1',
        eventTime: '2026-10-20T08:00:00Z', eventID: 'e0e0e0e0-0000-4000-8000-000000000000', recipientAccountId: DEPLOYMENT.accountId,
        requestParameters: { instancesSet: { items: [{ imageId: SOURCE_RELEASE.amiId }] },
            ...(template === null ? {} : { launchTemplate: { launchTemplateId: SOURCE_RELEASE.launchTemplateId, version: SOURCE_RELEASE.launchTemplateVersion, ...template } }) },
        responseElements: { instancesSet: { items: [{ instanceId: RESERVE.sourceInstanceId, imageId: SOURCE_RELEASE.amiId, ...item }] } }, ...over });
}
const TAGS = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': DEPLOYMENT.namespace, 'ezil:computer-id': RESERVE.computerId };
/** Every observation as the adopting side reads it from AWS; `stdout` is the invocation output (the receipt line). */
export function observations(over: Partial<LowerAttestationObservations> = {}, stdout = receipt() + '\n'): LowerAttestationObservations {
    return {
        command: { commandId: COMMAND_ID, documentName: 'AWS-RunShellScript', documentVersion: '1', instanceIds: [MAINTENANCE],
            commands: buildAttestCommand(commandInput()), requestedAt: new Date('2026-10-22T11:20:00.000Z'), status: 'Success' },
        document: { name: 'AWS-RunShellScript', documentVersion: '1', owner: 'Amazon', documentType: 'Command', status: 'Active', hashType: 'Sha256', hash: DOCUMENT_HASH },
        invocation: { commandId: COMMAND_ID, instanceId: MAINTENANCE, status: 'Success', responseCode: 0, standardOutput: stdout, standardError: '' },
        runInstances: [cloudTrail()],
        snapshot: { snapshotId: SNAPSHOT, ownerId: DEPLOYMENT.accountId, volumeId: RESERVE.sourceVolumeId, volumeGiB: 20, state: 'completed', encrypted: true,
            kmsKeyId: DEPLOYMENT.dataKeyArn, startedAt: new Date('2026-10-22T11:05:00.000Z'), tags: { ...TAGS, 'ezil:attestation-id': RESERVE.attestationId } },
        clone: { volumeId: CLONE, state: 'in-use', snapshotId: SNAPSHOT, encrypted: true, kmsKeyId: DEPLOYMENT.dataKeyArn, zoneId: 'aps1-az1', sizeGiB: 20,
            attachments: [{ instanceId: MAINTENANCE, state: 'attached' }], tags: { ...TAGS, 'ezil:attestation-id': RESERVE.attestationId } },
        original: { volumeId: RESERVE.sourceVolumeId, state: 'available', attachments: [], encrypted: true, kmsKeyId: DEPLOYMENT.dataKeyArn,
            tags: { ...TAGS, 'ezil:backup': DEPLOYMENT.namespace, 'ezil:generation': '1', 'ezil:fence-token': RESERVE.sourceFenceToken } },
        maintenance: { instanceId: MAINTENANCE, imageId: DEPLOYMENT.amiId, state: 'running', availabilityZone: 'ap-south-1a', availabilityZoneId: 'aps1-az1',
            publicIp: null, tags: { 'ezil:attestation-id': RESERVE.attestationId, 'ezil:computer-id': RESERVE.computerId }, volumes: [{ volumeId: 'vol-77777777777777777', deviceName: '/dev/sda1', deleteOnTermination: true, tags: {} },
                { volumeId: CLONE, deviceName: '/dev/sdf', deleteOnTermination: false, tags: {} }] },
        ...over };
}
