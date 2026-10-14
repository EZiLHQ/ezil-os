/**
 * Lifecycle intent contract (docs/AWS-COMPUTERS.md C-1/C-3). The fixtures are
 * the app's side of the contract: infra's `parseLifecycleWork` must accept
 * each `input` unchanged. infra/app-computers/test/app-intent-contract.test.ts
 * reads this fixture file and parses every entry with the real infra code.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AWS_TIERS } from './aws-config';
import { buildLifecycleWork, KNOWN_INSTANCE_TYPES, LIFECYCLE_DEPLOYMENTS_ENV, LifecycleIntentInvalidError, readLifecycleDeployments, type LifecycleIntent } from './aws-intent';
import { fixtureDeployment, fixtureIntent } from './aws-intent.test-support';
import fixtures from './aws-intent.fixtures.json';

const FREE_TIER_DEPLOYMENT_TYPES = ['t3a.medium', 't3.medium', 'm6i.large'];

describe('buildLifecycleWork', () => {
    it.each([
        ['start-ap-south-1', fixtureIntent('start')],
        ['provision-ap-south-1', fixtureIntent('provision')],
        ['stop-us-east-1', fixtureIntent('stop', 'us-east-1')],
        ['provision-free-ap-south-1', fixtureIntent('provision', 'ap-south-1', 't3a.medium', FREE_TIER_DEPLOYMENT_TYPES)],
    ] as const)('%s matches the pinned fixture byte for byte', (key, intent) => {
        const w = buildLifecycleWork(intent);
        expect({ name: w.name, stateMachineArn: w.stateMachineArn, digest: w.digest, input: w.input }).toEqual(fixtures[key]);
    });

    it('the envelope digest is the sha256 of the document, and the name/ARN are what the helper requires', () => {
        const w = buildLifecycleWork(fixtureIntent('start'));
        const envelope = JSON.parse(w.input) as { schemaVersion: number; document: string; digest: string };
        expect(Object.keys(envelope)).toEqual(['schemaVersion', 'document', 'digest']);
        expect(envelope.digest).toBe(createHash('sha256').update(envelope.document, 'utf8').digest('hex'));
        expect(w.name).toBe(`computer-${w.intent.jobId}`);
        expect(w.stateMachineArn).toMatch(/:stateMachine:ezil-pilot-lifecycle:1$/); // the VERSION, never unqualified
    });

    it('every tier type is in infra\'s instance-type allowlist', () => {
        for (const types of Object.values(AWS_TIERS)) for (const t of types) expect(KNOWN_INSTANCE_TYPES).toContain(t);
    });

    it('a free-tier type builds when the region deployment allows it', () => {
        const i = { ...fixtureIntent('start'), instanceType: 't3a.medium', deployment: fixtureDeployment('ap-south-1', ['t3a.medium', 't3.medium', 'm6i.large']) };
        expect(buildLifecycleWork(i).intent.instanceType).toBe('t3a.medium');
    });

    const bad: [string, (i: LifecycleIntent) => LifecycleIntent][] = [
        ['type outside the deployment allowlist', (i) => ({ ...i, instanceType: 't3a.medium' })],
        ['unknown type in the deployment', (i) => ({ ...i, deployment: { ...i.deployment, instanceTypes: ['m6i.large', 'x9.huge'] } })],
        ['start carrying a data size', (i) => ({ ...i, dataVolumeGiB: 20 })],
        ['start without an instance', (i) => ({ ...i, providerInstanceId: null })],
        ['start carrying previous-generation fields', (i) => ({ ...i, previousGeneration: 1 })],
        ['zone outside the region', (i) => ({ ...i, deployment: { ...i.deployment, zoneId: 'use1-az4' } })],
        ['state machine ARN in another region', (i) => ({ ...i, deployment: { ...i.deployment, stateMachineVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-pilot-lifecycle:1' } })],
        ['unqualified state machine ARN', (i) => ({ ...i, deployment: { ...i.deployment, stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-pilot-lifecycle' } })],
        ['state machine name outside the namespace', (i) => ({ ...i, deployment: { ...i.deployment, stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-lifecycle:1' } })],
        ["another namespace's state machine", (i) => ({ ...i, deployment: { ...i.deployment, stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-other-lifecycle:1' } })],
        ['namespace containing a dash', (i) => ({ ...i, deployment: { ...i.deployment, namespace: 'pi-lot', stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-pi-lot-lifecycle:1' } })],
        ['reserved namespace', (i) => ({ ...i, deployment: { ...i.deployment, namespace: 'identity', stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-identity-lifecycle:1' } })],
        ['instance type outside the allowlist', (i) => ({ ...i, instanceType: 'x9.huge', deployment: { ...i.deployment, instanceTypes: ['m6i.large'] } })],
        ['lease epoch 0', (i) => ({ ...i, leaseEpoch: 0 })],
        ['upper-case uuid', (i) => ({ ...i, jobId: i.jobId.toUpperCase() })],
        ['extra key', (i) => ({ ...i, region: 'ap-south-1' }) as unknown as LifecycleIntent],
    ];
    it.each(bad)('refuses %s', (_name, mutate) => {
        expect(() => buildLifecycleWork(mutate(fixtureIntent('start')))).toThrow(LifecycleIntentInvalidError);
    });

    it('provision needs user data, a data size in range and no instance or volume', () => {
        const p = fixtureIntent('provision');
        expect(() => buildLifecycleWork({ ...p, userData: null })).toThrow(LifecycleIntentInvalidError);
        expect(() => buildLifecycleWork({ ...p, dataVolumeGiB: 101 })).toThrow(LifecycleIntentInvalidError);
        expect(() => buildLifecycleWork({ ...p, dataVolumeId: 'vol-11111111111111111' })).toThrow(LifecycleIntentInvalidError);
    });
});

describe('readLifecycleDeployments', () => {
    const env = (value: unknown) => ({ [LIFECYCLE_DEPLOYMENTS_ENV]: typeof value === 'string' ? value : JSON.stringify(value) });
    const both = { 'ap-south-1': fixtureDeployment('ap-south-1'), 'us-east-1': fixtureDeployment('us-east-1') };

    it('returns every configured region', () => {
        const r = readLifecycleDeployments(env(both), ['ap-south-1', 'us-east-1']);
        expect(r.ok && Object.keys(r.deployments)).toEqual(['ap-south-1', 'us-east-1']);
    });

    it.each([
        ['unset', {}, ['ap-south-1'], [LIFECYCLE_DEPLOYMENTS_ENV]],
        ['not JSON', env('{'), ['ap-south-1'], [LIFECYCLE_DEPLOYMENTS_ENV]],
        ['an array', env([both['ap-south-1']]), ['ap-south-1'], [LIFECYCLE_DEPLOYMENTS_ENV]],
        ['a configured region missing', env({ 'ap-south-1': both['ap-south-1'] }), ['ap-south-1', 'us-east-1'], [`${LIFECYCLE_DEPLOYMENTS_ENV}.us-east-1`]],
        ['a deployment filed under another region', env({ 'us-east-1': both['ap-south-1'] }), ['us-east-1'], [`${LIFECYCLE_DEPLOYMENTS_ENV}.us-east-1`]],
        ['an inherited key', env({}), ['toString' as string], [`${LIFECYCLE_DEPLOYMENTS_ENV}.toString`]],
    ] as const)('%s fails closed', (_name, e, regions, invalid) => {
        expect(readLifecycleDeployments(e as Record<string, string>, regions as unknown as string[])).toEqual({ ok: false, invalid });
    });
});
