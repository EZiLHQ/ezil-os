import { canonical, type Delivery, type Settings } from '../lib/delivery/contract.js';
import type { Dependencies } from '../lib/delivery/aws.js';
import type { HelperEvent } from '../lib/delivery/helper.js';

export const settings: Settings = { accountId: '123456789012', region: 'us-east-1', stage: 'pilot', namespace: 'pilot',
    bucket: 'ezil-test-configurations', dataKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    machineArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-delivery-pilot', workflowVersion: '1',
    authorityOrigin: 'https://cloud.ezil.org', authoritySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:ezil/authority-abcdef',
    documentName: 'ezil-configuration-pilot-test', documentVersion: '1', documentHash: 'a'.repeat(64) };
export const delivery: Delivery = { schemaVersion: 1, configurationId: '11111111-1111-4111-8111-111111111111', operation: 'prepare',
    scope: { computerId: '22222222-2222-4222-8222-222222222222', computerGeneration: 1,
        fenceToken: '33333333-3333-4333-8333-333333333333', providerInstanceId: 'i-12345678901234567', dataVolumeId: 'vol-12345678901234567' },
    revision: 1, digest: 'b'.repeat(64), object: { bucket: settings.bucket,
        key: 'pilot/computers/22222222-2222-4222-8222-222222222222/generations/1/configurations/11111111-1111-4111-8111-111111111111.json',
        versionId: 'immutable-version', bytes: 100, sha256: 'b'.repeat(64) } };
export function fixture() {
    const start = Date.now() - 5000;
    const state = { now: start + 5000, authorized: true, writer: true, authorityCalls: 0,
        execution: { executionArn: settings.machineArn.replace(':stateMachine:', ':execution:') + `:configuration-prepare-${delivery.configurationId}`,
            stateMachineArn: settings.machineArn, stateMachineVersionArn: settings.machineArn + ':1',
            name: `configuration-prepare-${delivery.configurationId}`, status: 'RUNNING' as const, redriveCount: 0,
            startDate: new Date(start), input: canonical(delivery), $metadata: {} },
    };
    const deps: Dependencies = { now: () => state.now, authority: async () => { state.authorityCalls++; return state.authorized; },
        writer: async () => state.writer, execution: async () => state.execution,
        command: async () => undefined, invocation: async () => undefined };
    const event: HelperEvent = { mode: 'initialize', executionArn: state.execution.executionArn,
        recovery: false, recoveryStartedAt: new Date(start).toISOString() };
    return { state, deps, event, start };
}
