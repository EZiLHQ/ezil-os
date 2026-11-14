/** Operator runner: AWS CLI readers map AWS's own JSON onto the verifier's views; pins fail closed; output carries no identifiers. */
import { describe, expect, it } from 'vitest';
import { maintenanceHostObservations, parseAttestCommand, verifyLowerAttestation } from './aws-lower-attestation';
import { assertOperatorPins, attestSendCommandInput, awsCliReaders, OperatorRefusal, operatorLine, runOperator, type AwsCli, type OperatorDeps,
    type OperatorPins } from './aws-lower-attestation-operator';
import type { LowerAttestationStore } from './aws-lower-attestation';
import { CERT, CLONE, COMMAND_ID, DOCUMENT_HASH, MAINTENANCE, MEASURED, NOW, observations, PINNED, PINS, placement, registryEntry, reserved, RESERVE,
    SNAPSHOT, SOURCE } from './aws-lower-attestation.test-support';

const o = observations();
const pairs = (t: Record<string, string>) => Object.entries(t).map(([Key, Value]) => ({ Key, Value }));
/** AWS CLI JSON for exactly the fixture observations. */
const responses: Record<string, unknown> = {
    'ec2 describe-snapshots': { Snapshots: [{ SnapshotId: SNAPSHOT, OwnerId: o.snapshot!.ownerId, VolumeId: o.snapshot!.volumeId, VolumeSize: 20, State: 'completed',
        Encrypted: true, KmsKeyId: o.snapshot!.kmsKeyId, StartTime: o.snapshot!.startedAt.toISOString(), Tags: pairs(o.snapshot!.tags) }] },
    [`ec2 describe-volumes ${CLONE}`]: { Volumes: [{ VolumeId: CLONE, State: 'in-use', Encrypted: true, KmsKeyId: o.clone!.kmsKeyId, Size: 20, SnapshotId: SNAPSHOT,
        AvailabilityZone: 'ap-south-1a', AvailabilityZoneId: 'aps1-az1', VolumeType: 'gp3', Tags: pairs(o.clone!.tags!), Attachments: [{ InstanceId: MAINTENANCE, State: 'attached' }] }] },
    [`ec2 describe-volumes ${RESERVE.sourceVolumeId}`]: { Volumes: [{ VolumeId: RESERVE.sourceVolumeId, State: 'available', Encrypted: true, KmsKeyId: o.original!.kmsKeyId,
        Size: 20, SnapshotId: '', AvailabilityZoneId: 'aps1-az1', Tags: pairs(o.original!.tags!), Attachments: [] }] },
    'ec2 describe-instances': { Reservations: [{ Instances: [{ InstanceId: MAINTENANCE, ImageId: o.maintenance!.imageId, InstanceType: 't3a.medium', State: { Name: 'running' },
        Placement: { AvailabilityZone: 'ap-south-1a', AvailabilityZoneId: 'aps1-az1' }, Tags: pairs(o.maintenance!.tags), RootDeviceName: '/dev/sda1',
        BlockDeviceMappings: o.maintenance!.volumes.map(v => ({ DeviceName: v.deviceName, Ebs: { VolumeId: v.volumeId, DeleteOnTermination: v.deleteOnTermination } })) }] }] },
    'ssm list-commands': { Commands: [{ CommandId: COMMAND_ID, DocumentName: 'AWS-RunShellScript', DocumentVersion: '1', InstanceIds: [MAINTENANCE],
        Parameters: { commands: o.command!.commands }, RequestedDateTime: o.command!.requestedAt.toISOString(), Status: 'Success' }] },
    'ssm describe-document': { Document: { Name: 'AWS-RunShellScript', DocumentVersion: '1', Owner: 'Amazon', DocumentType: 'Command', Status: 'Active',
        HashType: 'Sha256', Hash: DOCUMENT_HASH } },
    'ssm get-command-invocation': { CommandId: COMMAND_ID, InstanceId: MAINTENANCE, Status: 'Success', ResponseCode: 0,
        StandardOutputContent: o.invocation!.standardOutput, StandardErrorContent: '' },
    'cloudtrail lookup-events': { Events: [{ EventName: 'StopInstances', CloudTrailEvent: '{}' }, { EventName: 'RunInstances', CloudTrailEvent: o.runInstances[0] }] },
    'cloudtrail lookup-events maintenance': { Events: [{ EventName: 'RunInstances', CloudTrailEvent: o.host.launches[0] }] },
    'ec2 describe-instance-attribute': { InstanceId: MAINTENANCE, UserData: {} },
    'ssm list-commands --instance-id': { Commands: [{ CommandId: COMMAND_ID }] },
    'ssm describe-sessions': { Sessions: [] },
};
const fake = (over: Record<string, unknown> = {}): AwsCli & { calls: string[][] } => {
    const calls: string[][] = [];
    const cli = async (args: readonly string[]) => {
        calls.push([...args]);
        const command = args.slice(0, 2).join(' '), volume = args[args.indexOf('--volume-ids') + 1];
        // An override answers its key; volumes are keyed by id, the host's own history by its instance.
        const key = command === 'ec2 describe-volumes' ? `${command} ${volume}`
            : command === 'ssm list-commands' && args.includes('--instance-id') ? `${command} --instance-id`
                : command === 'cloudtrail lookup-events' && args.join(' ').includes(MAINTENANCE) ? `${command} maintenance` : command;
        const value = key in over ? over[key] : command in over && !key.includes(' maintenance') && !key.endsWith('--instance-id') ? over[command] : responses[key];
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error('unexpected aws call');
        return JSON.stringify(value);
    };
    return Object.assign(cli, { calls });
};

describe('awsCliReaders', () => {
    it('maps AWS JSON onto exactly the views the verifier proves', async () => {
        const r = awsCliReaders(fake());
        const read = { command: await r.getCommand('ap-south-1', COMMAND_ID), document: await r.describeDocument('ap-south-1', 'AWS-RunShellScript', '1'),
            invocation: await r.getCommandInvocation('ap-south-1', COMMAND_ID, MAINTENANCE), snapshot: await r.describeSnapshot('ap-south-1', SNAPSHOT),
            clone: await r.describeVolume('ap-south-1', CLONE), original: await r.describeVolume('ap-south-1', RESERVE.sourceVolumeId),
            maintenance: await r.describeForEnrollment('ap-south-1', MAINTENANCE), runInstances: await r.lookupRunInstances('ap-south-1', RESERVE.sourceInstanceId),
            host: await maintenanceHostObservations(r, 'ap-south-1', MAINTENANCE) };
        expect(read.host).toEqual(o.host);
        expect(read.runInstances).toEqual(o.runInstances);
        const proof = verifyLowerAttestation(reserved(), placement(), COMMAND_ID, read, registryEntry(), CERT, PINS, NOW, { poolInstanceId: null, usage: null });
        expect(proof.measuredDigest).toBe(MEASURED);
    });

    it('answers null for a missing resource and refuses ambiguous, malformed or partial output', async () => {
        await expect(awsCliReaders(fake({ 'ec2 describe-snapshots': new Error('An error occurred (InvalidSnapshot.NotFound)') })).describeSnapshot('r', SNAPSHOT)).resolves.toBeNull();
        await expect(awsCliReaders(fake({ 'ssm list-commands': { Commands: [] } })).getCommand('r', COMMAND_ID)).resolves.toBeNull();
        await expect(awsCliReaders(fake({ 'ec2 describe-snapshots': { Snapshots: [{}, {}] } })).describeSnapshot('r', SNAPSHOT)).rejects.toThrow('aws_output_invalid');
        await expect(awsCliReaders(fake({ 'cloudtrail lookup-events': { Events: [], NextToken: 'more' } })).lookupRunInstances('r', RESERVE.sourceInstanceId)).rejects.toThrow('cloudtrail_partial');
        await expect(awsCliReaders(fake({ 'ec2 describe-volumes': new Error('AccessDenied') })).describeVolume('r', CLONE)).rejects.toThrow('AccessDenied');
    });

    it('reads CloudTrail by the source instance and never limits the listing', async () => {
        const cli = fake();
        await awsCliReaders(cli).lookupRunInstances('r', RESERVE.sourceInstanceId);
        expect(cli.calls[0]).toEqual(['cloudtrail', 'lookup-events', '--lookup-attributes', `AttributeKey=ResourceName,AttributeValue=${RESERVE.sourceInstanceId}`]);
        expect(cli.calls.flat()).not.toContain('--max-items');
    });
});

const PINNED_OPERATOR: OperatorPins = { region: 'ap-south-1', accountId: '123456789012', namespace: 'pilot', dbSystemIdentifier: '7311111111111111111',
    sourceCommit: 'a'.repeat(40), sourceSha256: PINNED, documentSha256: DOCUMENT_HASH, documentVersion: '1', maintenanceAmiId: 'ami-11111111111111111', userDataSha256: null };
const SEEN = { accountId: '123456789012', dbRole: 'postgres', dbSystemIdentifier: '7311111111111111111', source: SOURCE, head: 'a'.repeat(40) + '\n',
    trackedChanges: '', registry: registryEntry() };

describe('operator pins and output', () => {
    it.each([
        ['runtime_not_pinned', { head: 'b'.repeat(40) }],
        ['runtime_dirty', { trackedChanges: ' M app/src/server/lib/compute/aws-lower-attestation.ts\n' }],
        ['registry_mismatch', { registry: { ...registryEntry(), namespace: 'prod' } }],
        ['registry_mismatch', { registry: { ...registryEntry(), accountId: '210987654321' } }],
        ['registry_mismatch', { registry: null }],
        ['account_mismatch', { accountId: '210987654321' }],
        ['db_role_mismatch', { dbRole: 'service_role' }],
        ['db_role_mismatch', { dbRole: 'supabase_admin' }],                  // another BYPASSRLS role is never accepted
        ['db_identity_mismatch', { dbSystemIdentifier: '7322222222222222222' }],
        ['source_not_pinned', { source: Buffer.from('import os\n') }],
    ])('refuses %s', (code, over) => {
        expect(() => assertOperatorPins(PINNED_OPERATOR, { ...SEEN, ...over })).toThrow(new OperatorRefusal(code));
    });

    it('accepts exactly the pinned account, role, database and source', () => {
        expect(() => assertOperatorPins(PINNED_OPERATOR, SEEN)).not.toThrow();
    });

    it('builds the one send-command input the verifier accepts, for a reserved row only', () => {
        const input = attestSendCommandInput(reserved(), PINNED_OPERATOR, SOURCE, { maintenanceInstanceId: MAINTENANCE, cloneVolumeId: CLONE, snapshotId: SNAPSHOT });
        expect(input).toMatchObject({ DocumentName: 'AWS-RunShellScript', DocumentVersion: '1', InstanceIds: [MAINTENANCE] });
        expect(input.Parameters.commands).toEqual(o.command!.commands);
        expect(parseAttestCommand(input.Parameters.commands)).toMatchObject({ challenge: reserved().challenge, cloneVolumeId: CLONE });
        const target = { maintenanceInstanceId: MAINTENANCE, cloneVolumeId: CLONE, snapshotId: SNAPSHOT };
        expect(() => attestSendCommandInput(reserved(), PINNED_OPERATOR, SOURCE, { ...target, cloneVolumeId: RESERVE.sourceVolumeId })).toThrow('target_invalid');
        expect(() => attestSendCommandInput(reserved(), PINNED_OPERATOR, SOURCE, { ...target, maintenanceInstanceId: RESERVE.sourceInstanceId })).toThrow('target_invalid');
        expect(() => attestSendCommandInput(reserved({ phase: 'refused', failureCode: 'operator_abandoned', completedAt: reserved().createdAt }), PINNED_OPERATOR, SOURCE, target))
            .toThrow('attestation_not_reserved');
    });

    it('prints phases, codes and hashes only', () => {
        const line = operatorLine('adopt', { phase: 'adopted', failureCode: null, measuredDigest: MEASURED, evidenceSha256: 'f'.repeat(64) });
        for (const id of [RESERVE.computerId, RESERVE.attestationId, RESERVE.sourceInstanceId, RESERVE.sourceVolumeId, MAINTENANCE, CLONE, SNAPSHOT])
            expect(line).not.toContain(id);
        expect(JSON.parse(line)).toEqual({ op: 'adopt', phase: 'adopted', failureCode: null, measuredDigest: MEASURED, evidenceSha256: 'f'.repeat(64) });
    });
});

describe('runOperator', () => {
    const IDS = ['--attestation-id', RESERVE.attestationId, '--computer-id', RESERVE.computerId];
    const BASE = ['--pins', 'pins.json', '--deployments', 'deployments.json', '--identity-certs', 'certs.json'];
    /** Every effect in order: journal creation and lines, store calls, prints. */
    const harness = (over: { pins?: Partial<OperatorPins>; head?: string; dirty?: string; toplevel?: string; journal?: 'fails'; store?: 'fails';
        aws?: Record<string, unknown> } = {}) => {
        const events: string[] = [];
        const refused = reserved({ phase: 'refused', failureCode: 'operator_abandoned', completedAt: '2026-10-22T11:59:00.000Z', updatedAt: '2026-10-22T11:59:00.000Z' });
        const spy = (name: string, value: unknown) => async () => {
            events.push(`store:${name}`);
            if (over.store === 'fails') throw new Error('image_job_conflict');
            return value;
        };
        const store = { inspect: spy('inspect', reserved()), reserve: spy('reserve', reserved()), refuse: spy('refuse', refused),
            adopt: spy('adopt', refused), preview: spy('preview', { phase: 'refused', failureCode: 'command_invalid', measuredDigest: null }) } as unknown as LowerAttestationStore;
        const files: Record<string, string> = { 'pins.json': JSON.stringify({ ...PINNED_OPERATOR, ...over.pins }),
            'deployments.json': JSON.stringify({ 'ap-south-1': registryEntry() }), 'certs.json': JSON.stringify({ 'ap-south-1': CERT }) };
        const deps: OperatorDeps = {
            aws: async args => { events.push(`aws:${args.slice(0, 2).join(' ')}`); return args[0] === 'sts' ? JSON.stringify({ Account: '123456789012' }) : fake(over.aws)(args); },
            codeRoot: '/checkouts/pinned',
            git: async args => Buffer.from(args[1] === '--show-toplevel' ? (over.toplevel ?? '/checkouts/pinned') + '\n'
                : args[0] === 'rev-parse' ? (over.head ?? 'a'.repeat(40)) + '\n' : args[0] === 'status' ? over.dirty ?? '' : SOURCE.toString()),
            readFile: path => files[path] ?? (() => { throw new Error('missing file'); })(),
            createJournal: (_dir, name) => {
                if (over.journal === 'fails') throw new Error('EEXIST');
                events.push(`journal:create:${name.split('-').pop()}`);
                return { append: line => { events.push(`journal:${Object.keys(JSON.parse(line))[0]}`); }, close: () => { events.push('journal:close'); } };
            },
            dbIdentity: async () => { events.push('db:identity'); return { role: 'postgres', systemIdentifier: '7311111111111111111' }; },
            store, writeExclusive: () => { events.push('write:command'); }, now: () => NOW, print: line => { events.push(`print:${JSON.parse(line).op}`); },
        };
        return { events, deps };
    };
    const mutations = (events: string[]) => events.filter(e => /^store:(reserve|adopt|refuse)$/.test(e));

    it('journals the intent (O_EXCL) before the one store mutation, then the outcome', async () => {
        const { events, deps } = harness();
        await runOperator(['abort', ...BASE, ...IDS, '--journal', 'j', '--apply'], deps);
        expect(events.filter(e => !e.startsWith('aws:'))).toEqual(['db:identity', 'journal:create:abort.json', 'journal:intent', 'store:refuse', 'journal:outcome',
            'print:abort', 'journal:close']);
    });

    it('journals a failed store call and rethrows it', async () => {
        const { events, deps } = harness({ store: 'fails' });
        await expect(runOperator(['abort', ...BASE, ...IDS, '--journal', 'j', '--apply'], deps)).rejects.toThrow('image_job_conflict');
        expect(events.filter(e => e.startsWith('journal:') || e.startsWith('store:'))).toEqual(['journal:create:abort.json', 'journal:intent', 'store:refuse', 'journal:outcome', 'journal:close']);
    });

    it.each([
        ['runtime_not_pinned', { head: 'b'.repeat(40) }],
        ['runtime_dirty', { dirty: ' M app/src/server/lib/compute/aws-lower-attestation.ts\n' }],
        ['registry_mismatch', { pins: { namespace: 'prod' } }],
        ['source_not_pinned', { pins: { sourceSha256: 'f'.repeat(64) } }],
        ['EEXIST', { journal: 'fails' as const }],
    ])('%s: nothing is mutated', async (code, over) => {
        for (const argv of [['abort', ...BASE, ...IDS, '--journal', 'j', '--apply'], ['reserve', ...BASE, '--request', 'request.json', '--journal', 'j', '--apply']]) {
            const { events, deps } = harness(over);
            deps.readFile = (path => path === 'request.json' ? JSON.stringify(RESERVE) : (harness(over).deps.readFile)(path));
            await expect(runOperator(argv, deps)).rejects.toThrow(code);
            expect(mutations(events)).toEqual([]);
        }
    });

    it.each([
        ['a pinned clean checkout elsewhere (cross-checkout)', { toplevel: '/checkouts/other' }, 'runtime_not_pinned'],
        ['another commit', { head: 'b'.repeat(40) }, 'runtime_not_pinned'],
        ['a modified tracked file', { dirty: ' M app/scripts/lower-attestation-operator.ts\n' }, 'runtime_dirty'],
        ['an unpinned attest.py', { pins: { sourceSha256: 'f'.repeat(64) } }, 'source_not_pinned'],
    ])('the runtime pin refuses %s before any database or AWS read', async (_name, over, code) => {
        const { events, deps } = harness(over);
        await expect(runOperator(['status', ...BASE, ...IDS], deps)).rejects.toThrow(code);
        expect(events.filter(e => e.startsWith('db:') || e.startsWith('aws:') || e.startsWith('store:'))).toEqual([]);
    });

    it('the command file is written only for a fresh maintenance host no SSM command or session has reached', async () => {
        const argv = ['command', ...BASE, ...IDS, '--maintenance-instance-id', MAINTENANCE, '--clone-volume-id', CLONE, '--snapshot-id', SNAPSHOT, '--out', 'send.json'];
        const fresh = { 'ssm list-commands --instance-id': { Commands: [] } };
        const clean = harness({ aws: fresh });
        await runOperator(argv, clean.deps);
        expect(clean.events).toContain('write:command');
        for (const aws of [{ 'ssm list-commands --instance-id': { Commands: [{ CommandId: COMMAND_ID }] } },
            { ...fresh, 'ssm describe-sessions': { Sessions: [{ SessionId: 'operator-0123456789abcdef0' }] } },
            { ...fresh, 'ec2 describe-instance-attribute': { InstanceId: MAINTENANCE, UserData: { Value: Buffer.from('#!/bin/sh\n').toString('base64') } } },
            { ...fresh, 'ssm list-commands --instance-id': { Commands: [], NextToken: 'more' } }]) {
            const { events, deps } = harness({ aws });
            await expect(runOperator(argv, deps)).rejects.toThrow(/command_invalid|untrusted_ami|ssm_listing_partial/);
            expect(events).not.toContain('write:command');
        }
    });

    it('an apply without a journal directory is refused before anything is read', async () => {
        const { events, deps } = harness();
        await expect(runOperator(['abort', ...BASE, ...IDS, '--apply'], deps)).rejects.toThrow('missing_journal');
        expect(events).toEqual([]);
    });

    it('a dry run never mutates: adopt previews, abort and reserve only report', async () => {
        for (const argv of [['adopt', ...BASE, ...IDS, '--command-id', COMMAND_ID], ['abort', ...BASE, ...IDS]]) {
            const { events, deps } = harness();
            await runOperator(argv, deps);
            expect(mutations(events)).toEqual([]);
            expect(events.some(e => e.startsWith('journal:'))).toBe(false);
        }
    });
});
