import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { App, BootstraplessSynthesizer, Stack, assertions } from 'aws-cdk-lib';
import { DeployIdentityStack, IdentityConfigSchema } from '../lib/identity.js';
import { AppComputerFoundationStack, FoundationConfigSchema } from '../lib/foundation.js';
import { OpsConfigSchema, OpsStack } from '../lib/ops.js';
import { PilotKeysConfigSchema, PilotKeysStack } from '../lib/pilot-keys.js';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { AppCaller, AppCallerConfigSchema } from '../lib/app-caller.js';
import { SettingsSchema } from '../lib/lifecycle/contract.js';
import { applyWorkloadIdentity, tagWorkload, workloadSynthesizer } from '../lib/workload-identity.js';

type Resource = { Type: string; Properties?: Record<string, any> };
type Template = { Resources?: Record<string, Resource> };
const example = (name: string) => JSON.parse(readFileSync(join(__dirname, '../config/', name + '.example.json'), 'utf8'));
const identity = IdentityConfigSchema.parse(example('identity'));
const foundation = FoundationConfigSchema.parse(example('foundation'));
const ops = OpsConfigSchema.parse(example('ops'));
const keys = PilotKeysConfigSchema.parse(example('keys'));
const lifecycle = example('lifecycle');
const env = { account: identity.accountId, region: identity.region };

/** Count the IAM document, not CloudFormation intrinsic syntax. For names
 * allocated at deployment, use the service's maximum name length. Unknown
 * references fail closed: extend this resolver when new policy targets appear.
 * This is an upper bound for generated names, exact for the literal boundary. */
function documentSize(document: unknown, resources: Record<string, Resource>, bytes = false): number {
    const arn = (service: string, suffix: string) =>
        'arn:aws:' + service + ':' + env.region + ':' + env.account + ':' + suffix;
    function target(id: string, attribute = 'Ref'): string {
        const pseudo: Record<string, string> = {
            'AWS::Partition': 'aws', 'AWS::Region': env.region,
            'AWS::AccountId': env.account, 'AWS::URLSuffix': 'amazonaws.com',
        };
        if (attribute === 'Ref' && id in pseudo) return pseudo[id]!;
        const resource = resources[id];
        assert.ok(resource, 'unknown policy reference: ' + id);
        const p = resource.Properties ?? {};
        const name = (key: string, maximum: number) =>
            p[key] === undefined ? 'x'.repeat(maximum) : String(resolve(p[key]));
        assert.ok(attribute === 'Ref' || attribute === 'Arn', 'unhandled policy attribute: ' + id + '.' + attribute);
        switch (resource.Type) {
            case 'AWS::KMS::Key': {
                const key = '00000000-0000-4000-8000-000000000000';
                return attribute === 'Arn' ? arn('kms', 'key/' + key) : key;
            }
            case 'AWS::Lambda::Function': {
                const fn = name('FunctionName', 64);
                return attribute === 'Arn' ? arn('lambda', 'function:' + fn) : fn;
            }
            case 'AWS::Lambda::Version': {
                const fn = String(resolve(p.FunctionName));
                // Qualifier maximum; deliberately conservative for numeric versions.
                return (fn.startsWith('arn:') ? fn : arn('lambda', 'function:' + fn)) + ':' + '1'.repeat(128);
            }
            case 'AWS::SQS::Queue': {
                const queue = name('QueueName', 80);
                return attribute === 'Arn' ? arn('sqs', queue)
                    : 'https://sqs.' + env.region + '.amazonaws.com/' + env.account + '/' + queue;
            }
            case 'AWS::Logs::LogGroup': {
                const group = name('LogGroupName', 512);
                return attribute === 'Arn' ? arn('logs', 'log-group:' + group + ':*') : group;
            }
            case 'AWS::StepFunctions::StateMachine':
                return arn('states', 'stateMachine:' + name('StateMachineName', 80));
            default:
                throw new Error('unhandled policy reference type: ' + resource.Type);
        }
    }
    function resolve(value: any): any {
        if (Array.isArray(value)) return value.map(resolve);
        if (!value || typeof value !== 'object') return value;
        if ('Ref' in value) return target(value.Ref);
        if ('Fn::GetAtt' in value) {
            const [id, attribute] = Array.isArray(value['Fn::GetAtt'])
                ? value['Fn::GetAtt'] : value['Fn::GetAtt'].split('.');
            return target(id, attribute);
        }
        if ('Fn::Join' in value) {
            const [separator, parts] = value['Fn::Join'];
            return parts.map(resolve).join(separator);
        }
        assert.ok(!Object.keys(value).some(key => key.startsWith('Fn::')), 'unhandled policy intrinsic');
        return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, resolve(part)]));
    }
    const json = JSON.stringify(resolve(document));
    return bytes ? Buffer.byteLength(json, 'utf8') : json.replace(/\s/g, '').length;
}

/** Both embedded Policies and separate IAM Policy/RolePolicy resources count
 * against the SAME role quota. A policy attached to two roles counts for each. */
function checkStack(stack: Stack): string[] {
    const template = assertions.Template.fromStack(stack).toJSON() as Template;
    const resources = template.Resources ?? {}, failures: string[] = [];
    const roles = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::IAM::Role');
    const totals = new Map<string, number>();
    const limit = (label: string, size: number, maximum: number) => {
        if (size > maximum) failures.push(stack.stackName + '/' + label + ': ' + size + ' > ' + maximum);
    };
    function roleKey(value: any): string {
        if (value && typeof value === 'object' && 'Ref' in value) {
            assert.equal(resources[value.Ref]?.Type, 'AWS::IAM::Role', 'inline policy references an unknown role');
            return value.Ref;
        }
        assert.equal(typeof value, 'string', 'unhandled inline policy role reference');
        return roles.find(([, r]) => r.Properties?.RoleName === value)?.[0] ?? 'external:' + value;
    }
    function inline(key: string, document: unknown) {
        totals.set(key, (totals.get(key) ?? 0) + documentSize(document, resources));
    }
    for (const [id, resource] of Object.entries(resources)) {
        const p = resource.Properties ?? {};
        switch (resource.Type) {
            case 'AWS::KMS::Key':
                limit(id + '/key policy bytes', documentSize(p.KeyPolicy, resources, true), 32768);
                break;
            case 'AWS::IAM::ManagedPolicy':
                limit(id + '/managed', documentSize(p.PolicyDocument, resources), 6144);
                // Billing v2 adds exactly 27 serialized characters for the two
                // paid Compute type names; keep the rest of the headroom target.
                if (p.ManagedPolicyName?.endsWith('-boundary'))
                    limit(id + '/boundary headroom', documentSize(p.PolicyDocument, resources), 5627);
                break;
            case 'AWS::IAM::Role':
                limit(id + '/trust', documentSize(p.AssumeRolePolicyDocument, resources), 2048);
                for (const policy of p.Policies ?? []) inline(id, policy.PolicyDocument);
                break;
            case 'AWS::IAM::Policy':
                for (const role of p.Roles ?? []) inline(roleKey(role), p.PolicyDocument);
                break;
            case 'AWS::IAM::RolePolicy':
                inline(roleKey(p.RoleName), p.PolicyDocument);
                break;
        }
    }
    for (const [role, size] of totals) limit(role + '/inline aggregate', size, 10240);
    for (const [id, role] of roles) {
        const attached = new Set((role.Properties?.ManagedPolicyArns ?? []).map((arn: unknown) => JSON.stringify(arn)));
        for (const [policyId, policy] of Object.entries(resources)) {
            if (policy.Type === 'AWS::IAM::ManagedPolicy'
                && policy.Properties?.Roles?.some((r: unknown) => roleKey(r) === id))
                attached.add(JSON.stringify({ Ref: policyId }));
        }
        limit(id + '/managed attachments', attached.size, 10);
    }
    return failures;
}

for (const killSwitch of [false, true]) for (const userDataNonce of [false, true])
    for (const userDataAttributeKeyVerified of [false, true]) {
        const label = JSON.stringify({ killSwitch, userDataNonce, userDataAttributeKeyVerified });
        test('IAM policy size quotas, example stacks: ' + label, () => {
            const app = new App({ autoSynth: false });
            const identityStack = new DeployIdentityStack(app, 'ezil-identity-pilot', {
                config: { ...identity, killSwitch, userDataAttributeKeyVerified }, env,
                synthesizer: new BootstraplessSynthesizer(),
            });
            const foundationStack = new AppComputerFoundationStack(app, 'ezil-pilot-foundation', {
                config: foundation, env, synthesizer: new BootstraplessSynthesizer(),
            });
            tagWorkload(foundationStack, foundation.stage);
            const opsStack = new OpsStack(app, 'ezil-pilot-ops', {
                config: ops, env, synthesizer: new BootstraplessSynthesizer(),
            });
            const keysStack = new PilotKeysStack(app, 'ezil-pilot-keys', {
                config: keys, env: { account: keys.accountId, region: keys.region },
                synthesizer: new BootstraplessSynthesizer(),
            });
            const settings = SettingsSchema.parse({
                ...lifecycle.settings, features: { userDataNonce, userDataAttributeKeyVerified },
            });
            const lifecycleStack = new Stack(app, 'ezil-pilot-lifecycle', {
                env, synthesizer: workloadSynthesizer(lifecycle.deploy),
            });
            applyWorkloadIdentity(lifecycleStack, settings.deployment.accountId, settings.deployment.namespace);
            const controller = new ComputerLifecycle(lifecycleStack, 'Lifecycle', {
                settings, authorityKeyArn: lifecycle.authorityKeyArn,
                notificationsEnabled: lifecycle.notificationsEnabled,
            });
            new ComputerLifecycleRecovery(lifecycleStack, 'Recovery', {
                settings: { lifecycle: settings, recoveryVersionArn: lifecycle.recoveryVersionArn },
                sourceHistoryKey: controller.historyKey, enabled: lifecycle.recoveryEnabled,
            });
            // Include the optional caller's trust and inline policy as well.
            new AppCaller(lifecycleStack, 'AppCaller', {
                config: AppCallerConfigSchema.parse({ ...lifecycle.appCaller, enabled: true }),
                region: settings.deployment.region, versionArns: [settings.deployment.stateMachineVersionArn],
                historyKeyArn: controller.historyKey.keyArn,
            });
            const failures = [identityStack, foundationStack, opsStack, keysStack, lifecycleStack].flatMap(checkStack);
            assert.deepEqual(failures, [], 'IAM documents exceed their non-whitespace character quotas');
            for (const role of Object.values(assertions.Template.fromStack(lifecycleStack).findResources('AWS::IAM::Role'))) {
                assert.equal(role.Properties.Path, `/ezil/${settings.deployment.namespace}/`);
                assert.equal(role.Properties.PermissionsBoundary,
                    `arn:aws:iam::${env.account}:policy/ezil/identity/ezil-${settings.deployment.namespace}-boundary`);
            }
        });
    }

test('identity policies retain headroom with the longest accepted namespace/region and largest volume cap', () => {
    const config = IdentityConfigSchema.parse({ ...identity, namespace: 'a'.repeat(21), region: 'ap-northeast-1',
        maxVolumeGiB: 16384, killSwitch: true, userDataAttributeKeyVerified: true });
    const stack = new DeployIdentityStack(new App({ autoSynth: false }), 'IdentityMaximumSize', {
        config, env: { account: config.accountId, region: config.region }, synthesizer: new BootstraplessSynthesizer(),
    });
    assert.deepEqual(checkStack(stack), []);
});
