/** NULL-lower attestation proofs: every binding refuses on its own; the lower is measured, never inferred. */
import { describe, expect, it } from 'vitest';
import { buildAttestCommand, launchTupleOf, LowerAttestationReceiptSchema, LowerAttestationRefusal, parseAttestCommand, parseLowerAttestationRow,
    verifyLowerAttestation, type InstanceProvenance, type LowerAttestationObservations, type MigrationProvenance } from './aws-lower-attestation';
import { ALIAS_RELEASE, CERT, CLONE, cloudTrail, COMMAND_ID, commandInput, CREATED, DEPLOYMENT, DOCUMENT_HASH, MAINTENANCE, maintenanceLaunch, MARKER, MEASURED,
    NOW, observations, OWNER, PINNED, PINS, placement, receipt, registryEntry, reserved, RESERVE, SNAPSHOT, SOURCE_RELEASE, TARGET_RELEASE } from './aws-lower-attestation.test-support';
import { createHash } from 'node:crypto';

const LEGACY_MARKER = Object.fromEntries(Object.entries(MARKER).filter(([k]) => k !== 'instanceId'));
const OTHER = 'i-77777777777777777';
const base = observations();
const withCommand = (over: Partial<NonNullable<LowerAttestationObservations['command']>>) => observations({ command: { ...base.command!, ...over } });
const withDocument = (over: Partial<NonNullable<LowerAttestationObservations['document']>>) => observations({ document: { ...base.document!, ...over } });
const withInvocation = (over: Partial<NonNullable<LowerAttestationObservations['invocation']>>) => observations({ invocation: { ...base.invocation!, ...over } });
const closed = (instanceId: string) => ({ instanceId, closed: true, tied: false });
/**
 * `receipt` is what the invocation printed and `event` what CloudTrail returned: both read from AWS, never relayed.
 * `released`: the placement's current instance_id is NULL (frozen NULL at reserve). `pool`: the retired claim row's instance.
 */
const prove = (o: { receipt?: string; event?: string; obs?: LowerAttestationObservations; registry?: unknown; cert?: string | null; pin?: string | null;
    doc?: string | null; a?: ReturnType<typeof reserved>; now?: Date; released?: boolean; pool?: string | null; usage?: InstanceProvenance['usage'];
    p?: ReturnType<typeof placement>; migrations?: MigrationProvenance[]; pins?: Partial<typeof PINS>; host?: Partial<LowerAttestationObservations['host']> } = {}) => {
    const obs0 = o.obs ?? observations({}, (o.receipt ?? receipt()) + '\n');
    const obs = { ...obs0, host: { ...obs0.host, ...o.host }, ...(o.event ? { runInstances: [o.event] } : {}) };
    return verifyLowerAttestation(o.a ?? reserved(o.released ? { currentInstanceId: null } : {}), o.p ?? placement(o.released ? { instanceId: null } : {}),
        COMMAND_ID, obs, o.registry ?? registryEntry(), o.cert === undefined ? CERT : o.cert,
        { ...PINS, sourceSha256: o.pin === undefined ? PINNED : o.pin, documentSha256: o.doc === undefined ? DOCUMENT_HASH : o.doc, ...o.pins }, o.now ?? NOW,
        { poolInstanceId: o.pool ?? null, usage: o.usage ?? null, migrations: o.migrations ?? [] });
};
/** A committed CF→AWS row whose persisted `_awsProvision` is exactly the reserved allocation, launched from SOURCE_RELEASE. */
const migration = (over: { placement?: Record<string, unknown>; deployment?: Record<string, unknown>; row?: Partial<MigrationProvenance>; released?: boolean } = {}): MigrationProvenance => ({
    id: '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a', userId: OWNER, fromProvider: 'cloudflare', toProvider: 'aws-ec2', ...over.row,
    provision: { placement: { computerId: RESERVE.computerId, ownerUserId: OWNER, provider: 'aws-ec2', store: 'ebs', generation: 1, leaseEpoch: 3,
        state: 'STARTING', region: 'ap-south-1', zoneId: 'aps1-az1', instanceId: RESERVE.sourceInstanceId, volumeId: RESERVE.sourceVolumeId,
        fsUuid: RESERVE.fsUuid, fenceToken: RESERVE.sourceFenceToken, ...over.placement },
    deployment: { ...DEPLOYMENT, amiId: SOURCE_RELEASE.amiId, launchTemplateId: SOURCE_RELEASE.launchTemplateId, launchTemplateVersion: SOURCE_RELEASE.launchTemplateVersion, ...over.deployment },
    source: null, reservedAt: '2026-10-20T07:59:00.000Z', ...(over.released === undefined ? {} : { released: over.released }) } });
const refusal = (fn: () => unknown) => {
    try { fn(); } catch (error) { if (error instanceof LowerAttestationRefusal) return error.code; throw error; }
    return 'accepted';
};

describe('verifyLowerAttestation', () => {
    it('adopts only the measured marker digest, joined to exactly one release by the full launch tuple', () => {
        const proof = prove();
        expect(proof.measuredDigest).toBe(MEASURED);
        expect(proof.measuredDigest).not.toBe(DEPLOYMENT.lowerImageDigest);     // never the current config's lower
        expect(proof.sourceRelease).toEqual(SOURCE_RELEASE);
        expect(proof.sourceRelease.amiId).not.toBe(ALIAS_RELEASE.amiId);         // a shared lower alone never selects
        expect(proof).toMatchObject({ measuredAt: '2026-10-22T11:30:00.000Z', snapshotId: SNAPSHOT, cloneVolumeId: CLONE,
            maintenanceInstanceId: MAINTENANCE, maintenanceAmiId: DEPLOYMENT.amiId });
        expect(proof.evidence).toMatchObject({ trust: 'aws-read:ssm-command+invocation,ec2,cloudtrail', receipt: receipt(), command: { commandId: COMMAND_ID,
            sourceSha256: PINNED, instanceId: MAINTENANCE }, launch: { amiId: SOURCE_RELEASE.amiId, launchTemplateVersion: '1', raw: cloudTrail() },
            original: { generation: '1', fenceToken: RESERVE.sourceFenceToken } });
        expect(proof.commandId).toBe(COMMAND_ID);
    });

    it.each([
        ['source_not_pinned', () => prove({ pin: null })],
        ['source_not_pinned', () => prove({ pin: 'f'.repeat(64) })],
        // The host-side check line names the pin, but the delivered bytes are something else.
        ['source_not_pinned', () => prove({ obs: withCommand({ commands: buildAttestCommand(commandInput({ sourceBase64: Buffer.from('import os\n').toString('base64') })) }) })],
        ['source_not_pinned', () => prove({ doc: null })],
        // Exact AWS document: AWS's own, the explicit version the command ran, the reviewed hash; never `$DEFAULT` or a look-alike.
        ['command_invalid', () => prove({ doc: 'f'.repeat(64) })],
        ['command_invalid', () => prove({ obs: observations({ document: null }) })],
        ['command_invalid', () => prove({ obs: withDocument({ owner: '123456789012' }) })],
        ['command_invalid', () => prove({ obs: withDocument({ documentVersion: '2' }) })],
        ['command_invalid', () => prove({ obs: withDocument({ status: 'Updating' }) })],
        ['command_invalid', () => prove({ obs: withDocument({ hashType: 'Sha1' }) })],
        ['command_invalid', () => prove({ obs: observations({ command: { ...base.command!, documentVersion: '$DEFAULT' }, document: { ...base.document!, documentVersion: '$DEFAULT' } }) })],
        ['command_invalid', () => prove({ obs: observations({ command: null }) })],
        ['command_invalid', () => prove({ obs: withCommand({ commandId: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c' }) })],
        ['command_invalid', () => prove({ obs: withCommand({ documentName: 'AWS-RunPowerShellScript' }) })],
        ['command_invalid', () => prove({ obs: withCommand({ status: 'Failed' }) })],
        ['command_invalid', () => prove({ obs: withCommand({ instanceIds: [MAINTENANCE, 'i-66666666666666666'] }) })],
        ['command_invalid', () => prove({ obs: withCommand({ requestedAt: new Date('2026-10-22T10:59:59.999Z') }) })],
        ['command_invalid', () => prove({ obs: withCommand({ commands: [...base.command!.commands, 'touch /tmp/x'] }) })],
        ['command_invalid', () => prove({ obs: withCommand({ commands: base.command!.commands.map((l, i) => i === 1 ? 'umask 022' : l) }) })],
        ['command_invalid', () => prove({ obs: withCommand({ commands: buildAttestCommand(commandInput({ challenge: 'd'.repeat(64) })) }) })],
        ['command_invalid', () => prove({ obs: withCommand({ commands: buildAttestCommand(commandInput({ generation: 2 })) }) })],
        ['command_invalid', () => prove({ obs: withCommand({ commands: buildAttestCommand(commandInput({ originalVolumeId: CLONE })) }) })],
        ['receipt_invalid', () => prove({ obs: withInvocation({ status: 'Failed', responseCode: 2, standardOutput: 'REFUSE needs_recovery\n' }) })],
        ['receipt_invalid', () => prove({ obs: withInvocation({ instanceId: 'i-66666666666666666' }) })],
        ['receipt_invalid', () => prove({ obs: withInvocation({ standardOutput: receipt() + '\n' + receipt() + '\n' }) })],
        ['receipt_invalid', () => prove({ receipt: receipt({ challenge: 'd'.repeat(64) }) })],
        ['receipt_invalid', () => prove({ receipt: receipt({ snapshotId: 'snap-77777777777777777' }) })],
        ['receipt_invalid', () => prove({ receipt: receipt({ observedAt: '2026-10-22T11:19:59.999Z' }) })],   // before the command
        ['untrusted_ami', () => prove({ obs: observations({ maintenance: { ...base.maintenance!, tags: {} } }) })],
        ['untrusted_ami', () => prove({ obs: observations({ maintenance: { ...base.maintenance!, volumes: [...base.maintenance!.volumes,
            { volumeId: RESERVE.sourceVolumeId, deleteOnTermination: false, tags: {} }] } }) })],                      // the ORIGINAL on the host
        ['launch_tuple_invalid', () => prove({ obs: observations({ runInstances: [] }) })],
        ['launch_tuple_invalid', () => prove({ obs: observations({ runInstances: [cloudTrail(), cloudTrail({ eventID: 'e1e1e1e1-0000-4000-8000-000000000000' })] }) })],
        ['receipt_invalid', () => prove({ receipt: 'not json' })],
        ['receipt_invalid', () => prove({ receipt: receipt({ extra: 1 }) })],
        ['receipt_invalid', () => prove({ receipt: receipt({ attestationId: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1' }) })],
        ['receipt_invalid', () => prove({ receipt: receipt({ cloneVolumeId: RESERVE.sourceVolumeId }) })],   // the original is never the measured disk
        ['receipt_invalid', () => prove({ receipt: receipt({ maintenanceInstanceId: RESERVE.sourceInstanceId }) })],
        ['receipt_invalid', () => prove({ receipt: receipt({ generation: 2 }) })],
        ['receipt_invalid', () => prove({ receipt: receipt({ observedAt: '2026-10-22T10:59:59.999Z' }) })],  // before the fence
        ['receipt_invalid', () => prove({ receipt: receipt({ observedAt: '2026-10-22T12:00:00.001Z' }) })],
        ['receipt_invalid', () => prove({ receipt: receipt({ blockDeviceReadOnly: false }) })],
        ['mount_not_readonly', () => prove({ receipt: receipt({ mountOptions: ['nodev', 'noexec', 'norecovery', 'nosuid', 'ro', 'rw'] }) })],
        ['mount_not_readonly', () => prove({ receipt: receipt({ mountOptions: ['nodev', 'noexec', 'nosuid', 'ro'] }) })],
        ['marker_mismatch', () => prove({ receipt: receipt({ markerSha256: 'f'.repeat(64) }) })],
        ['marker_mismatch', () => prove({ receipt: receipt({}, '{"computerId":') })],
        ['marker_mismatch', () => prove({ receipt: receipt({}, { ...MARKER, extra: true }) })],
        ['marker_mismatch', () => prove({ receipt: receipt({}, { ...MARKER, computerId: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1' }) })],
        ['marker_mismatch', () => prove({ receipt: receipt({}, { ...MARKER, volumeId: CLONE }) })],
        ['marker_mismatch', () => prove({ receipt: receipt({}, { ...MARKER, fsUuid: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1' }) })],
        ['marker_mismatch', () => prove({ receipt: receipt({}, { ...MARKER, generation: 0 }) })],
        ['marker_mismatch', () => prove({ receipt: receipt({}, { ...MARKER, leaseEpoch: 4 }) })],
        ['marker_mismatch', () => prove({ receipt: receipt({}, { ...MARKER, instanceId: 'i-77777777777777777' }) })],
        // A marker without instanceId needs the complete historical binding (the retired claim row of exactly this allocation).
        ['instance_provenance_missing', () => prove({ receipt: receipt({}, LEGACY_MARKER) })],
        ['instance_provenance_missing', () => prove({ receipt: receipt({}, LEGACY_MARKER), usage: closed(RESERVE.sourceInstanceId) })],  // usage alone never binds
        ['instance_provenance_missing', () => prove({ receipt: receipt({}, LEGACY_MARKER), pool: OTHER })],
        // The current instance is frozen at reserve; drift or another instance refuses.
        ['instance_provenance_missing', () => prove({ p: placement({ instanceId: OTHER }) })],
        ['instance_provenance_missing', () => prove({ a: reserved({ currentInstanceId: OTHER }), p: placement({ instanceId: OTHER }), pool: RESERVE.sourceInstanceId })],
        // Released placement (current NULL): only the claim row can name the source, never the request or usage alone.
        ['instance_provenance_missing', () => prove({ released: true })],
        ['instance_provenance_missing', () => prove({ released: true, usage: closed(RESERVE.sourceInstanceId) })],
        ['instance_provenance_missing', () => prove({ released: true, pool: OTHER })],
        ['instance_provenance_missing', () => prove({ released: true, receipt: receipt({}, LEGACY_MARKER), pool: OTHER })],
        ['instance_provenance_missing', () => prove({ released: true, pool: RESERVE.sourceInstanceId, p: placement({ instanceId: RESERVE.sourceInstanceId }) })],
        // Conflicting lineage: the usage ledger may only corroborate.
        ['instance_provenance_missing', () => prove({ released: true, pool: RESERVE.sourceInstanceId, usage: closed(OTHER) })],
        ['instance_provenance_missing', () => prove({ released: true, pool: RESERVE.sourceInstanceId, usage: { instanceId: RESERVE.sourceInstanceId, closed: false, tied: false } })],
        ['instance_provenance_missing', () => prove({ released: true, pool: RESERVE.sourceInstanceId, usage: { instanceId: RESERVE.sourceInstanceId, closed: true, tied: true } })],
        ['instance_provenance_missing', () => prove({ usage: closed(OTHER) })],
        ['marker_mismatch', () => prove({ receipt: receipt({ lowerImageDigest: TARGET_RELEASE.lowerImageDigest }) })],
        ['identity_invalid', () => prove({ receipt: receipt({ identityDocument: '{"instanceId":"i-22222222222222222"}' }) })],
        ['identity_invalid', () => prove({ cert: null })],
        ['receipt_invalid', () => prove({ receipt: receipt({ maintenanceInstanceId: 'i-66666666666666666' }) })],
        ['identity_invalid', () => prove({ receipt: receipt({ identitySignature: 'A'.repeat(64) }) })],
        ['untrusted_ami', () => prove({ registry: { ...registryEntry(), amiId: 'ami-44444444444444444', releases: [SOURCE_RELEASE, { ...TARGET_RELEASE, amiId: 'ami-44444444444444444' }] } })],
        ['untrusted_ami', () => prove({ obs: observations({ maintenance: null }) })],
        ['untrusted_ami', () => prove({ obs: observations({ maintenance: { ...observations().maintenance!, imageId: 'ami-44444444444444444' } }) })],
        ['snapshot_lineage_mismatch', () => prove({ obs: observations({ snapshot: null }) })],
        ['snapshot_lineage_mismatch', () => prove({ obs: observations({ snapshot: { ...observations().snapshot!, volumeId: CLONE } }) })],
        ['snapshot_lineage_mismatch', () => prove({ obs: observations({ snapshot: { ...observations().snapshot!, state: 'pending' } }) })],
        ['snapshot_lineage_mismatch', () => prove({ obs: observations({ snapshot: { ...observations().snapshot!, startedAt: new Date('2026-10-22T10:00:00.000Z') } }) })],
        ['snapshot_lineage_mismatch', () => prove({ obs: observations({ snapshot: { ...observations().snapshot!, tags: { ...observations().snapshot!.tags, 'ezil:attestation-id': 'x' } } }) })],
        ['clone_lineage_mismatch', () => prove({ obs: observations({ clone: { ...observations().clone!, snapshotId: 'snap-77777777777777777' } }) })],
        ['clone_lineage_mismatch', () => prove({ obs: observations({ clone: { ...observations().clone!, attachments: [{ instanceId: RESERVE.sourceInstanceId, state: 'attached' }] } }) })],
        ['original_not_fenced', () => prove({ obs: observations({ original: { ...observations().original!, state: 'in-use', attachments: [{ instanceId: MAINTENANCE, state: 'attached' }] } }) })],
        ['original_not_fenced', () => prove({ obs: observations({ original: { ...observations().original!, tags: { ...observations().original!.tags, 'ezil:fence-token': 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1' } } }) })],
        ['original_not_fenced', () => prove({ obs: observations({ original: { ...observations().original!, tags: { ...observations().original!.tags, 'ezil:generation': '2' } } }) })],
        ['launch_tuple_invalid', () => prove({ event: cloudTrail({ eventName: 'StartInstances' }) })],
        ['launch_tuple_invalid', () => prove({ event: cloudTrail({ errorCode: 'Client.UnauthorizedOperation' }) })],
        ['launch_tuple_invalid', () => prove({ event: cloudTrail({ eventTime: '2026-10-22T11:00:00.001Z' }) })],
        ['launch_tuple_invalid', () => prove({ event: cloudTrail({}, { instanceId: 'i-77777777777777777' }) })],
        ['launch_tuple_invalid', () => prove({ event: cloudTrail({}, {}, null) })],
        ['launch_tuple_invalid', () => prove({ event: cloudTrail({}, {}, { version: '$Latest' }) })],
        ['launch_tuple_invalid', () => prove({ event: cloudTrail({ recipientAccountId: '210987654321' }) })],
        ['release_mismatch', () => prove({ event: cloudTrail({}, { imageId: 'ami-55555555555555555' }) })],                   // no registry record
        ['release_mismatch', () => prove({ registry: registryEntry([SOURCE_RELEASE, { ...SOURCE_RELEASE, stateMachineVersionArn: SOURCE_RELEASE.stateMachineVersionArn.replace(/:2$/, ':3') }, TARGET_RELEASE]) })],
        ['release_mismatch', () => prove({ event: cloudTrail({}, { imageId: TARGET_RELEASE.amiId }) })],                       // launch tuple names another lower
        ['release_mismatch', () => prove({ registry: { releases: [] } })],
    ])('refuses %s', (code, fn) => {
        expect(refusal(fn)).toBe(code);
    });

    it('accepts a detached clone; a marker from any other epoch is not this allocation', () => {
        expect(prove({ obs: observations({ clone: { ...observations().clone!, state: 'available', attachments: [] } }) }).measuredDigest).toBe(MEASURED);
        expect(refusal(() => prove({ receipt: receipt({}, { ...MARKER, leaseEpoch: 2 }) }))).toBe('marker_mismatch');
    });

    it('accepts no user-data at all in this scope: a bootstrap, even pinned, is refused', () => {
        const bootstrap = Buffer.from('#cloud-config\n');
        const pinned = createHash('sha256').update(bootstrap).digest('hex');
        expect(refusal(() => prove({ host: { userData: bootstrap.toString('base64') }, pins: { userDataSha256: pinned } }))).toBe('source_not_pinned');
        expect(refusal(() => prove({ host: { userData: bootstrap.toString('base64') } }))).toBe('untrusted_ami');
    });

    it.each([
        ['no launch template (AMI only)', { launches: [maintenanceLaunch({}, null)] }],
        ['another launch template', { launches: [maintenanceLaunch({}, { launchTemplateId: 'lt-22222222222222222' })] }],
        ['another launch template version', { launches: [maintenanceLaunch({}, { version: '2' })] }],
        ['`$Latest` instead of a numeric version', { launches: [maintenanceLaunch({}, { version: '$Latest' })] }],
        ['a user-data override in the launch request', { launches: [maintenanceLaunch({ requestParameters: { userData: '<sensitiveDataRemoved>',
            instancesSet: { items: [{ imageId: DEPLOYMENT.amiId }] }, launchTemplate: { launchTemplateId: DEPLOYMENT.launchTemplateId, version: DEPLOYMENT.launchTemplateVersion } } })] }],
        ['another account', { launches: [maintenanceLaunch({ recipientAccountId: '210987654321' })] }],
    ])('a maintenance launch with %s is not the target tuple', (_name, host) => {
        expect(refusal(() => prove({ host }))).toMatch(/untrusted_ami|launch_tuple_invalid/);
    });

    it.each([['ezil:managed-by'], ['ezil:stage'], ['ezil:attestation-id']])('a maintenance host without %s is untrusted', tag => {
        const tags = Object.fromEntries(Object.entries(base.maintenance!.tags).filter(([k]) => k !== tag));
        expect(refusal(() => prove({ obs: observations({ maintenance: { ...base.maintenance!, tags } }) }))).toBe('untrusted_ami');
    });

    it('adopts the original QA shape: no claim row, one committed migration, current instance non-null but terminated, marker without instanceId', () => {
        const proof = prove({ receipt: receipt({}, LEGACY_MARKER), migrations: [migration()] });
        expect(proof.measuredDigest).toBe(MEASURED);
        expect(proof.evidence).toMatchObject({ placementInstance: 'current', instanceProvenance: 'committed-migration', poolClaimNamesSource: false,
            committedMigration: { id: '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a' } });
        expect(prove({ released: true, receipt: receipt({}, LEGACY_MARKER), migrations: [migration()] }).evidence).toMatchObject({ placementInstance: 'released' });
        // A committed migration of an earlier allocation, or a released provision, is no binding and no contradiction.
        expect(prove({ migrations: [migration({ placement: { generation: 0 } }), migration({ row: { id: '9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b' }, released: true })] }).measuredDigest).toBe(MEASURED);
    });

    it.each([
        ['instance_provenance_missing', { migrations: [migration({ placement: { instanceId: OTHER } })] }],                      // contradiction, always
        ['instance_provenance_missing', { migrations: [migration({ placement: { instanceId: OTHER } })], markerNamesInstance: true }],
        ['instance_provenance_missing', { migrations: [migration(), migration({ row: { id: '9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b' } })] }],   // ambiguous
        ['instance_provenance_missing', { migrations: [migration({ row: { userId: '44444444-4444-4444-8444-444444444444' } })] }],
        ['instance_provenance_missing', { migrations: [migration({ row: { fromProvider: 'aws-ec2' } })] }],
        ['instance_provenance_missing', { migrations: [migration({ placement: { fsUuid: '55555555-5555-4555-8555-555555555555' } })] }],
        ['instance_provenance_missing', { migrations: [migration({ placement: { fenceToken: '55555555-5555-4555-8555-555555555555' } })] }],
        ['instance_provenance_missing', { migrations: [migration({ placement: { zoneId: 'aps1-az2' } })] }],
        ['instance_provenance_missing', { migrations: [migration({ placement: { leaseEpoch: 2 } })] }],                          // exact epoch only
        ['instance_provenance_missing', { migrations: [migration()], pool: OTHER }],                                              // pool contradicts
        ['release_mismatch', { migrations: [migration({ deployment: { amiId: ALIAS_RELEASE.amiId } })] }],                       // persisted tuple ≠ CloudTrail
        ['release_mismatch', { migrations: [migration({ deployment: { launchTemplateVersion: '2' } })] }],
        ['release_mismatch', { migrations: [migration({ deployment: { namespace: 'other' } })] }],
    ])('committed-migration binding refuses %s', (code, { markerNamesInstance, ...o }: Parameters<typeof prove>[0] & { markerNamesInstance?: boolean }) => {
        expect(refusal(() => prove({ receipt: markerNamesInstance ? receipt() : receipt({}, LEGACY_MARKER), ...o }))).toBe(code);
    });

    it.each([
        ['launched before the reservation', { launches: [maintenanceLaunch({ eventTime: '2026-10-22T10:59:00Z' })] }],
        ['launched after the command', { launches: [maintenanceLaunch({ eventTime: '2026-10-22T11:21:00Z' })] }],
        ['launched twice', { launches: [maintenanceLaunch(), maintenanceLaunch({ eventID: 'e3e3e3e3-0000-4000-8000-000000000000' })] }],
        ['no launch record', { launches: [] }],
        ['user-data present without a pin', { userData: Buffer.from('#!/bin/sh\n').toString('base64') }],
        ['unreadable user-data', { userData: null }],
    ])('a maintenance host %s is untrusted', (_name, host) => {
        expect(refusal(() => prove({ host }))).toBe('untrusted_ami');
    });

    it.each([
        ['another SSM command reached the host', { commandIds: [COMMAND_ID, '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c'] }],
        ['an SSM session reached the host', { sessionIds: ['operator-0123456789abcdef0'] }],
        ['the proof command is not in the host history', { commandIds: [] }],
    ])('%s: refused', (_name, host) => {
        expect(refusal(() => prove({ host }))).toBe('command_invalid');
    });

    it.each([
        ['an AMI other than the pin', { pins: { maintenanceAmiId: 'ami-44444444444444444' } }],
        ['a launch from another AMI', { host: { launches: [cloudTrail({ eventTime: '2026-10-22T11:10:00Z' }, { instanceId: MAINTENANCE, imageId: 'ami-44444444444444444' }, null)] } }],
    ])('the maintenance host refuses %s', (_name, o) => {
        expect(refusal(() => prove(o))).toBe('untrusted_ami');
    });
    it('refuses an unpinned maintenance AMI', () => {
        expect(refusal(() => prove({ pins: { maintenanceAmiId: null } }))).toBe('source_not_pinned');
    });

    it('adopts a released placement (current NULL) whose retired claim row names the launched instance, with or without usage corroboration', () => {
        const proof = prove({ released: true, pool: RESERVE.sourceInstanceId });
        expect(proof.measuredDigest).toBe(MEASURED);
        expect(proof.evidence).toMatchObject({ placementInstance: 'released', poolClaimNamesSource: true, usageLedger: 'none', instanceProvenance: 'marker' });
        expect(prove({ released: true, pool: RESERVE.sourceInstanceId, usage: closed(RESERVE.sourceInstanceId) }).evidence).toMatchObject({ usageLedger: 'corroborates' });
    });

    it('adopts released + current NULL + marker without instanceId only through the complete claim-row binding', () => {
        const proof = prove({ released: true, pool: RESERVE.sourceInstanceId, receipt: receipt({}, LEGACY_MARKER) });
        expect(proof.measuredDigest).toBe(MEASURED);
        expect(proof.evidence).toMatchObject({ placementInstance: 'released', instanceProvenance: 'pool-claim' });
        expect(prove({ receipt: receipt({}, LEGACY_MARKER), pool: RESERVE.sourceInstanceId }).evidence).toMatchObject({ placementInstance: 'current', instanceProvenance: 'pool-claim' });
        expect(prove().evidence).toMatchObject({ instanceProvenance: 'marker' });
    });

    it('records the alias release a launch actually used, by its full tuple', () => {
        expect(prove({ event: cloudTrail({}, { imageId: ALIAS_RELEASE.amiId }) }).sourceRelease).toEqual(ALIAS_RELEASE);
    });

    it('never proves a sealed attestation again', () => {
        expect(() => prove({ a: reserved({ phase: 'refused', failureCode: 'operator_abandoned', completedAt: CREATED }) })).toThrow('image_job_conflict');
    });
});

describe('row and receipt shapes', () => {
    it('parses only the canonical SSM delivery, byte for byte', () => {
        expect(parseAttestCommand(buildAttestCommand(commandInput()))).toEqual(commandInput());
        const lines = buildAttestCommand(commandInput());
        expect(parseAttestCommand(lines.map((l, i) => i === 5 ? l + ' ; reboot' : l))).toBeNull();
        expect(parseAttestCommand(lines.map((l, i) => i === 5 ? l.replace('python3 -I -c', 'python3 -c') : l))).toBeNull();
        expect(parseAttestCommand(lines.slice(0, 5))).toBeNull();
    });
    it('reads the launch tuple only from an immutable RunInstances record of the source instance', () => {
        expect(launchTupleOf(cloudTrail(), { sourceInstanceId: RESERVE.sourceInstanceId, region: 'ap-south-1', createdAt: CREATED }, DEPLOYMENT.accountId).tuple)
            .toEqual({ accountId: DEPLOYMENT.accountId, region: 'ap-south-1', amiId: SOURCE_RELEASE.amiId, launchTemplateId: SOURCE_RELEASE.launchTemplateId, launchTemplateVersion: '1' });
    });
    it('the host receipt schema is strict', () => {
        expect(LowerAttestationReceiptSchema.safeParse({ ...JSON.parse(receipt()), extra: 1 }).success).toBe(false);
    });
    it('rejects an adopted row without sealed evidence, and a reserved row with any', () => {
        const row = (a: ReturnType<typeof reserved>) => Object.fromEntries(Object.entries({ attestation_id: a.attestationId, computer_id: a.computerId,
            owner_user_id: a.ownerUserId, region: a.region, zone_id: a.zoneId, source_instance_id: a.sourceInstanceId, source_volume_id: a.sourceVolumeId,
            fs_uuid: a.fsUuid, source_generation: '3', source_lease_epoch: '7', source_fence_token: a.sourceFenceToken, reserved_row_sha256: a.reservedRowSha256,
            request_sha256: a.requestSha256, challenge: a.challenge, command_id: a.commandId, current_instance_id: a.currentInstanceId, phase: a.phase, evidence: a.evidence, evidence_sha256: a.evidenceSha256, measured_digest: a.measuredDigest,
            measured_at: a.measuredAt, marker_sha256: a.markerSha256, snapshot_id: a.snapshotId, clone_volume_id: a.cloneVolumeId,
            maintenance_instance_id: a.maintenanceInstanceId, maintenance_ami_id: a.maintenanceAmiId, source_release: a.sourceRelease,
            failure_code: a.failureCode, created_at: new Date(a.createdAt), updated_at: new Date(a.updatedAt), completed_at: a.completedAt }));
        expect(parseLowerAttestationRow(row(reserved())).sourceGeneration).toBe(3);
        expect(() => parseLowerAttestationRow(row(reserved({ phase: 'adopted', completedAt: CREATED })))).toThrow('image_job_conflict');
        expect(() => parseLowerAttestationRow(row(reserved({ measuredDigest: MEASURED })))).toThrow('image_job_conflict');
    });
});
