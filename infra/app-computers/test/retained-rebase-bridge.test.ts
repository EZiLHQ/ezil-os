import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { AppCaller } from '../lib/app-caller.js';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { SettingsSchema } from '../lib/lifecycle/contract.js';
import { ReleaseManifestSchema } from '../lib/lifecycle/release-manifest.js';
import { RetainedRebaseBridgeConfigSchema, resolveRetainedRebaseBridge, type RetainedRebaseBridge } from '../lib/retained-rebase-bridge.js';
import type { TransitionObserverVersions } from '../lib/observer-transition.js';
import { applyWorkloadIdentity } from '../lib/workload-identity.js';
import { preparationFixture } from './preparation-fixture.js';

const base = preparationFixture().settings.deployment;
const digest = (n: number) => 'sha256:' + String(n).repeat(64);
const arn = (name: string, n: number) => `arn:aws:states:${base.region}:${base.accountId}:stateMachine:ezil-mum-${name}:${n}`;
const versions = (n: number) => ({ lifecycle: arn('lifecycle', n), preparation: arn('rebase-preparation', n), recovery: arn('recovery', n) });
const settings = (n: number) => SettingsSchema.parse({
    authorityOrigin: 'https://os-staging.ezil.work',
    authoritySecretArn: `arn:aws:secretsmanager:${base.region}:${base.accountId}:secret:ezil/mum/lifecycle-key-abcdef`,
    deployment: { ...base, namespace: 'mum', amiId: 'ami-' + String(n).repeat(17), launchTemplateVersion: String(n),
        lowerImageDigest: digest(n), previousLowerImageDigest: digest(n - 1), stateMachineVersionArn: versions(n).lifecycle,
        preparationStateMachineVersionArn: versions(n).preparation, recoveryStateMachineVersionArn: versions(n).recovery },
});
function manifest(n: number) {
    const d = settings(n).deployment;
    const { zoneId, subnetId, securityGroupId, instanceTypes, storage, dataKeyArn, ...tuple } = d;
    const repo = `${d.accountId}.dkr.ecr.${d.region}.amazonaws.com/example`;
    return ReleaseManifestSchema.parse({ ...tuple, schemaVersion: 1, recipeVersion: `1.0.${n}`,
        lowerImageRef: repo + '@' + d.lowerImageDigest, previousLowerImageRef: repo + '@' + d.previousLowerImageDigest,
        createdAt: '2026-11-19T00:00:00.000Z', agentCommit: 'a'.repeat(40) });
}
const prefixes = { lifecycle: 'LifecycleObserverCurrentVersion', preparation: 'LifecyclePreparationObserverCurrentVersion',
    recovery: 'RecoveryObserverCurrentVersion' };
const kinds = Object.keys(prefixes) as (keyof typeof prefixes)[];
type ObserverIds = Required<TransitionObserverVersions>;
const sample = (n: number) => Object.fromEntries(kinds.map(k => [k, prefixes[k] + '1'.repeat(8) + String(n).repeat(32)])) as ObserverIds;
const input = (observers: ObserverIds) => RetainedRebaseBridgeConfigSchema.parse({
    sourceRelease: manifest(1), release: manifest(2), interveningRelease: manifest(3), observers,
});

test('explicit staging bridge requires an older immutable tuple linked through the normal predecessor', () => {
    const config = input(sample(2));
    assert.deepEqual(resolveRetainedRebaseBridge(config, settings(4), versions(3), sample(3)),
        { amiId: config.release.amiId, sourceLifecycleVersion: versions(1).lifecycle, versions: versions(2), observers: sample(2) });
    for (const delta of [{ namespace: 'prd' }, { amiId: config.interveningRelease.amiId }, { lowerImageDigest: digest(4) },
        { launchTemplateId: 'lt-' + 'a'.repeat(17) }, { launchTemplateVersion: '8' }, { stateMachineVersionArn: arn('lifecycle', 4) }]) {
        assert.throws(() => resolveRetainedRebaseBridge({ ...config, release: { ...config.release, ...delta } }, settings(4), versions(3), sample(3)));
    }
    assert.throws(() => resolveRetainedRebaseBridge(config, { ...settings(4), authorityOrigin: 'https://os.ezil.work' }, versions(3), sample(3)));
    assert.throws(() => resolveRetainedRebaseBridge(config, settings(4), versions(2), sample(3)));
    assert.throws(() => resolveRetainedRebaseBridge({ ...config, sourceRelease: manifest(5) }, settings(4), versions(3), sample(3)));
    assert.throws(() => resolveRetainedRebaseBridge(config, settings(4), versions(3), sample(2)));
});

type Resources = Record<string, any>;
function synth(n: number, previous?: ObserverIds, retainedBridge?: RetainedRebaseBridge): Resources {
    const s = settings(n), d = s.deployment, transition = previous && versions(n - 1);
    const stack = new Stack(new App(), 'RetainedRebaseBridge', { env: { account: d.accountId, region: d.region } });
    applyWorkloadIdentity(stack, d.accountId, d.namespace);
    const lifecycle = new ComputerLifecycle(stack, 'Lifecycle', { settings: s, authorityKeyArn: d.dataKeyArn,
        transitionObserverVersions: previous, transitionStateMachineVersions: transition, retainedBridge });
    new ComputerLifecycleRecovery(stack, 'Recovery', { settings: { lifecycle: s, recoveryVersionArn: versions(n).recovery },
        sourceHistoryKey: lifecycle.historyKey, transitionObserverVersionLogicalId: previous?.recovery, transitionStateMachineVersions: transition, retainedBridge });
    new AppCaller(stack, 'AppCaller', { config: { enabled: true, ec2CallerRoleArns: [`arn:aws:iam::${d.accountId}:role/ezil-staging-host`] },
        region: d.region, versionArns: [d.stateMachineVersionArn], historyKeyArn: lifecycle.historyKey.keyArn, transitionStateMachineVersions: transition, retainedBridge });
    return assertions.Template.fromStack(stack).toJSON().Resources;
}
function currentIds(resources: Resources, previous?: ObserverIds) {
    return Object.fromEntries(kinds.map(key => {
        const ids = Object.keys(resources).filter(id => id.startsWith(prefixes[key]) && id !== previous?.[key]);
        assert.equal(ids.length, 1);
        return [key, ids[0]!];
    })) as ObserverIds;
}

test('retained IAM adds only the older AMI and exact prior version grants', () => {
    const older = currentIds(synth(2));
    const before = synth(3, older), previous = currentIds(before, older);
    const bridge = resolveRetainedRebaseBridge(input(older), settings(4), versions(3), previous);
    const disabled = synth(4, previous), active = synth(4, previous, bridge);
    for (const k of kinds) {
        assert.deepEqual(active[older[k]], before[older[k]]);
        assert.deepEqual(active[previous[k]], disabled[previous[k]]);
        const grants = Object.entries(active).filter(([id, r]) => id.includes('RetainedBridgeObserverPolicy') &&
            r.Properties.PolicyDocument.Statement[0].Resource.Ref === older[k]);
        assert.equal(grants.length, 1);
        assert.deepEqual(grants[0]![1].Properties.PolicyDocument.Statement, [
            { Action: 'lambda:InvokeFunction', Effect: 'Allow', Resource: { Ref: older[k] } },
        ]);
    }
    const launch = Object.entries(active).filter(([id]) => id.startsWith('LifecycleRetainedBridgeLaunchPolicy'));
    assert.equal(launch.length, 1);
    assert.deepEqual(launch[0]![1].Properties.PolicyDocument.Statement, [{
        Action: 'ec2:RunInstances', Effect: 'Allow', Resource: bridge.amiIds.map(amiId => `arn:aws:ec2:${base.region}::image/${amiId}`),
        Condition: { StringEquals: { 'aws:RequestedRegion': base.region },
            ArnEquals: { 'ec2:LaunchTemplate': `arn:aws:ec2:${base.region}:${base.accountId}:launch-template/${base.launchTemplateId}` } },
    }]);
    let sourceHistoryGrants = 0;
    for (const [id, existing] of Object.entries(disabled)) {
        if (existing.Type !== 'AWS::IAM::Policy' || !id.includes('DefaultPolicy')) continue;
        const rows = (r: any) => r.Properties.PolicyDocument.Statement.map((s: any) => JSON.stringify(s)) as string[];
        const original = rows(existing), adjusted = rows(active[id]);
        for (const statement of original) assert.ok(adjusted.includes(statement));
        for (const raw of adjusted.filter(s => !original.includes(s))) {
            const s = JSON.parse(raw);
            assert.equal(s.Action, 'kms:Decrypt');
            const c = s.Condition.StringEquals;
            assert.equal(c['kms:ViaService'], `states.${base.region}.amazonaws.com`);
            const arns: string[] = c['kms:EncryptionContext:aws:states:stateMachineArn'];
            const allowed = Object.values(bridge.versions);
            if (id.startsWith('AppCallerRoleDefaultPolicy')) allowed.push(bridge.sourceLifecycleVersion);
            if (arns.includes(bridge.sourceLifecycleVersion)) {
                assert.ok(id.startsWith('AppCallerRoleDefaultPolicy'));
                assert.deepEqual(arns, [arn('lifecycle', 1).replace(/:1$/, ''), bridge.sourceLifecycleVersion]);
                sourceHistoryGrants++;
            }
            assert.ok(arns.some(v => allowed.includes(v)));
            assert.ok(arns.every(v => allowed.some(p => v === p || v === p.slice(0, p.lastIndexOf(':')))));
        }
    }
    assert.equal(sourceHistoryGrants, 1);
    assert.equal(Object.keys(disabled).filter(id => id.includes('RetainedBridge')).length, 0);
});
