import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { ComputerLifecycle, controllerStatements } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { AppCaller, AppCallerConfigSchema, appCallerStatements } from '../lib/app-caller.js';
import { SettingsSchema } from '../lib/lifecycle/contract.js';
import { lifecycleFixture, REGION } from './lifecycle-fixture.js';

/** Exact equality: every action, resource, condition and effect is spelled out
 * here as the reviewed specification. Any IAM drift, in either direction, fails. */
const A = '123456789012', R = REGION, Z = 'aps1-az1';
const ec2 = (kind: string) => `arn:aws:ec2:${R}:${A}:${kind}`;
const KEY = `arn:aws:kms:${R}:${A}:key/11111111-1111-4111-8111-111111111111`;
const LT = { ArnEquals: { 'ec2:LaunchTemplate': ec2('launch-template/lt-11111111111111111') } };
const MANAGED = { 'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform', 'ec2:ResourceTag/ezil:stage': 'pilot' };
const REQUEST = { 'aws:RequestTag/ezil:managed-by': 'app-computer-platform', 'aws:RequestTag/ezil:stage': 'pilot' };
const REGION_EQ = { 'aws:RequestedRegion': R };
const DENIED = ['ec2:DeleteVolume', 'ec2:DeleteSnapshot', 'ec2:DetachVolume', 'ec2:ModifyInstanceAttribute',
    'ec2:ModifyInstanceMetadataOptions', 'ec2:DeleteTags', 'iam:PassRole'];
function expectedController(userDataOpen: boolean) {
    return [
        { Effect: 'Allow', Action: ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:TerminateInstances'], Resource: ec2('instance/*'),
            Condition: { StringEquals: { ...REGION_EQ, ...MANAGED } } },
        { Effect: 'Allow', Action: 'ec2:AttachVolume', Resource: [ec2('instance/*'), ec2('volume/*')],
            Condition: { StringEquals: { ...REGION_EQ, ...MANAGED, 'ec2:AvailabilityZoneId': Z } } },
        { Effect: 'Allow', Action: 'ec2:CreateVolume', Resource: ec2('volume/*'), Condition: {
            StringEquals: { ...REGION_EQ, ...REQUEST, 'ec2:VolumeType': 'gp3', 'ec2:AvailabilityZoneId': Z },
            ArnEquals: { 'ec2:KmsKeyId': KEY }, Bool: { 'ec2:Encrypted': 'true' },
            NumericGreaterThanEquals: { 'ec2:VolumeSize': '20' }, NumericLessThanEquals: { 'ec2:VolumeSize': '100' } } },
        { Effect: 'Allow', Action: 'ec2:RunInstances', Resource: [`arn:aws:ec2:${R}::image/ami-11111111111111111`, ec2('subnet/subnet-11111111111111111'),
            ec2('security-group/sg-11111111111111111'), ec2('launch-template/lt-11111111111111111'), ec2('network-interface/*')],
            Condition: { StringEquals: REGION_EQ, ...LT } },
        { Effect: 'Allow', Action: 'ec2:RunInstances', Resource: ec2('instance/*'), Condition: {
            StringEquals: { ...REGION_EQ, ...REQUEST, 'ec2:InstanceType': ['m6i.large', 'c6i.xlarge'], 'ec2:MetadataHttpTokens': 'required',
                'ec2:InstanceMetadataTags': 'disabled', 'ec2:AvailabilityZoneId': Z },
            NumericLessThanEquals: { 'ec2:MetadataHttpPutResponseHopLimit': '1' }, Null: { 'ec2:InstanceProfile': 'true' }, ...LT } },
        { Effect: 'Allow', Action: 'ec2:RunInstances', Resource: ec2('volume/*'), Condition: {
            StringEquals: { ...REGION_EQ, ...REQUEST, 'ec2:VolumeType': 'gp3' }, Bool: { 'ec2:Encrypted': 'true' },
            NumericLessThanEquals: { 'ec2:VolumeSize': '30' }, ...LT } },
        { Effect: 'Allow', Action: 'ec2:CreateTags', Resource: [ec2('instance/*'), ec2('volume/*')],
            Condition: { StringEquals: { ...REGION_EQ, 'ec2:CreateAction': ['RunInstances', 'CreateVolume'] } } },
        { Effect: 'Allow', Action: 'ec2:CreateTags', Resource: ec2('volume/*'), Condition: { StringEquals: { ...REGION_EQ, ...MANAGED },
            'ForAllValues:StringEquals': { 'aws:TagKeys': ['ezil:generation', 'ezil:fence-token'] }, Null: { 'aws:TagKeys': 'false' } } },
        { Effect: 'Deny', Action: 'ec2:CreateTags', Resource: '*', Condition: {
            'ForAnyValue:StringEquals': { 'aws:TagKeys': ['ezil:computer-id', 'ezil:managed-by', 'ezil:stage', 'ezil:backup'] }, Null: { 'ec2:CreateAction': 'true' } } },
        { Effect: 'Deny', Action: DENIED.filter(a => !(userDataOpen && a === 'ec2:ModifyInstanceAttribute')), Resource: '*' },
        ...(userDataOpen ? [
            { Effect: 'Allow', Action: 'ec2:ModifyInstanceAttribute', Resource: ec2('instance/*'),
                Condition: { StringEquals: { ...REGION_EQ, ...MANAGED, 'ec2:Attribute': 'userData' } } },
            { Effect: 'Deny', Action: 'ec2:ModifyInstanceAttribute', Resource: '*', Condition: { 'ForAnyValue:StringNotEquals': { 'ec2:Attribute': 'userData' } } },
            { Effect: 'Deny', Action: 'ec2:ModifyInstanceAttribute', Resource: '*', Condition: { Null: { 'ec2:Attribute': 'true' } } },
        ] : []),
        { Effect: 'Allow', Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKeyWithoutPlaintext', 'kms:ReEncrypt*', 'kms:DescribeKey'],
            Resource: KEY, Condition: { StringEquals: { 'kms:ViaService': `ec2.${R}.amazonaws.com` } } },
        { Effect: 'Allow', Action: 'kms:CreateGrant', Resource: KEY,
            Condition: { Bool: { 'kms:GrantIsForAWSResource': 'true' }, StringEquals: { 'kms:ViaService': `ec2.${R}.amazonaws.com` } } },
    ];
}
const json = (statements: { toStatementJson(): unknown }[]) => statements.map(s => s.toStatementJson());

test('controller policy equals the reviewed specification exactly (userData fence closed)', () => {
    const f = lifecycleFixture();
    assert.deepEqual(json(controllerStatements(f.settings)), expectedController(false));
    // The graph flag alone does not open the fence.
    const graphOnly = SettingsSchema.parse({ ...f.settings, features: { userDataNonce: true } });
    assert.deepEqual(json(controllerStatements(graphOnly)), expectedController(false));
});
test('controller policy with userData delivery verified: allow userData only, deny every other or missing attribute', () => {
    const f = lifecycleFixture();
    const open = SettingsSchema.parse({ ...f.settings, features: { userDataNonce: true, userDataAttributeKeyVerified: true } });
    assert.deepEqual(json(controllerStatements(open)), expectedController(true));
    const keyOnly = SettingsSchema.parse({ ...f.settings, features: { userDataAttributeKeyVerified: true } });
    assert.deepEqual(json(controllerStatements(keyOnly)), expectedController(false));
});

const GITHUB = { name: 'github' as const, providerArn: `arn:aws:iam::${A}:oidc-provider/token.actions.githubusercontent.com`,
    issuerHost: 'token.actions.githubusercontent.com', audience: 'sts.amazonaws.com', subject: 'repo:<org>@<orgId>/<repo>@<repoId>:environment:<env>' };
const VERSION = `arn:aws:states:${R}:${A}:stateMachine:ezil-pilot-lifecycle:1`;
const VERCEL = { name: 'vercel' as const, providerArn: `arn:aws:iam::${A}:oidc-provider/oidc.vercel.com/ezil-team`,
    issuerHost: 'oidc.vercel.com/ezil-team', audience: 'https://vercel.com/ezil-team', subject: 'owner:ezil-team:project:ezil-os:environment:production' };
test('item 9: app caller can only start the exact lifecycle version, read its computer executions, and describe EC2 in region', () => {
    assert.deepEqual(json(appCallerStatements(R, [VERSION])), [
        { Effect: 'Allow', Action: 'states:StartExecution', Resource: VERSION },
        { Effect: 'Allow', Action: 'states:DescribeExecution', Resource: `arn:aws:states:${R}:${A}:execution:ezil-pilot-lifecycle:computer-*` },
        { Effect: 'Allow', Action: ['ec2:DescribeInstances', 'ec2:DescribeVolumes', 'ec2:DescribeAvailabilityZones'], Resource: '*',
            Condition: { StringEquals: { 'aws:RequestedRegion': R } } },
    ]);
    assert.throws(() => appCallerStatements(R, [VERSION.replace(/:1$/, '')]), /invalid_version_arn/);
    assert.throws(() => appCallerStatements(R, [VERSION.replace(R, 'us-east-1')]), /version_arn_region/);
    assert.equal(AppCallerConfigSchema.parse({}).enabled, false, 'disabled by default');
    for (const bad of [{ ...GITHUB, subject: 'repo:<org>/*' }, { ...GITHUB, issuerHost: 'oidc.vercel.com/team' }, { ...GITHUB, audience: 'https://vercel.com/x' }])
        assert.equal(AppCallerConfigSchema.safeParse({ enabled: true, providers: [bad] }).success, false);
    assert.equal(AppCallerConfigSchema.safeParse({ enabled: true, providers: [] }).success, false);
});
test('item 9: a Vercel caller trusts one exact team/project/environment, never development or a wildcard', () => {
    assert.equal(AppCallerConfigSchema.safeParse({ enabled: true, providers: [VERCEL] }).success, true);
    const globalMode = { ...VERCEL, providerArn: `arn:aws:iam::${A}:oidc-provider/oidc.vercel.com`, issuerHost: 'oidc.vercel.com' };
    assert.equal(AppCallerConfigSchema.safeParse({ enabled: true, providers: [globalMode] }).success, true, 'global issuer mode');
    assert.equal(AppCallerConfigSchema.safeParse({ enabled: true, providers: [{ ...VERCEL, audience: 'sts.amazonaws.com' }] }).success, true, 'custom audience');
    const refused: [string, object][] = [
        ['wildcard project', { ...VERCEL, subject: 'owner:ezil-team:project:*:environment:production' }],
        ['development tokens', { ...VERCEL, subject: 'owner:ezil-team:project:ezil-os:environment:development' }],
        ['another team in the subject', { ...VERCEL, subject: 'owner:other:project:ezil-os:environment:production' }],
        // With a custom audience only the issuer/subject team check can catch it.
        ['another team in the subject, custom audience', { ...VERCEL, audience: 'sts.amazonaws.com', subject: 'owner:other:project:ezil-os:environment:production' }],
        ['another team in the audience', { ...VERCEL, audience: 'https://vercel.com/other' }],
        ['a foreign issuer', { ...VERCEL, providerArn: `arn:aws:iam::${A}:oidc-provider/oidc.example.com/ezil-team`, issuerHost: 'oidc.example.com/ezil-team' }],
        ['a malformed subject', { ...VERCEL, subject: 'repo:ezil/ezil-os:environment:production' }],
    ];
    for (const [why, bad] of refused) assert.equal(AppCallerConfigSchema.safeParse({ enabled: true, providers: [bad] }).success, false, why);
    const app = new App(), stack = new Stack(app, 'VercelCaller', { env: { account: A, region: R } });
    new AppCaller(stack, 'AppCaller', { config: { enabled: true, providers: [VERCEL] }, region: R, versionArns: [VERSION] });
    const role = Object.values(assertions.Template.fromStack(stack).findResources('AWS::IAM::Role'))[0] as any;
    assert.deepEqual(role.Properties.AssumeRolePolicyDocument.Statement, [{ Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity',
        Principal: { Federated: VERCEL.providerArn }, Condition: { StringEquals: {
            'oidc.vercel.com/ezil-team:aud': 'https://vercel.com/ezil-team', 'oidc.vercel.com/ezil-team:sub': VERCEL.subject } } }]);
});
test('item 9: app caller trust is web identity on the exact audience and subject', () => {
    const app = new App(), stack = new Stack(app, 'Caller', { env: { account: A, region: R } });
    new AppCaller(stack, 'AppCaller', { config: { enabled: true, providers: [GITHUB] }, region: R, versionArns: [VERSION] });
    const role = Object.values(assertions.Template.fromStack(stack).findResources('AWS::IAM::Role'))[0] as any;
    assert.deepEqual(role.Properties.AssumeRolePolicyDocument.Statement, [{ Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity',
        Principal: { Federated: GITHUB.providerArn }, Condition: { StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': GITHUB.subject } } }]);
    assert.equal(role.Properties.ManagedPolicyArns, undefined);
});

/** Every policy-bearing resource of the synthesized stacks, compared with a
 * committed, reviewed snapshot. Regenerate only deliberately:
 *   UPDATE_IAM_SNAPSHOT=1 npm test   (then review the diff). */
const POLICY_TYPES: Record<string, string[]> = {
    'AWS::IAM::Role': ['AssumeRolePolicyDocument', 'ManagedPolicyArns', 'Policies', 'PermissionsBoundary'],
    'AWS::IAM::Policy': ['PolicyDocument', 'Roles'], 'AWS::IAM::ManagedPolicy': ['PolicyDocument'],
    'AWS::KMS::Key': ['KeyPolicy'], 'AWS::SQS::QueuePolicy': ['PolicyDocument', 'Queues'],
    'AWS::Lambda::Permission': ['Action', 'FunctionName', 'Principal', 'SourceAccount', 'SourceArn'],
    'AWS::IAM::InstanceProfile': ['Roles'],
};
function policies(stack: Stack) {
    const resources = assertions.Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
    return Object.fromEntries(Object.entries(resources).filter(([, r]) => r.Type in POLICY_TYPES).sort(([a], [b]) => a < b ? -1 : 1)
        .map(([id, r]) => [id, { Type: r.Type, ...Object.fromEntries(POLICY_TYPES[r.Type]!.filter(k => k in r.Properties).map(k => [k, r.Properties[k]])) }]));
}
test('every role, key, queue and invoke policy in the synthesized stacks equals the reviewed snapshot', () => {
    const f = lifecycleFixture(), app = new App(), stack = new Stack(app, 'Snapshot', { env: { account: A, region: R } });
    const lifecycle = new ComputerLifecycle(stack, 'Lifecycle', { settings: f.settings, authorityKeyArn: `arn:aws:kms:${R}:${A}:key/22222222-2222-4222-8222-222222222222` });
    new ComputerLifecycleRecovery(stack, 'Recovery', { settings: { lifecycle: f.settings,
        recoveryVersionArn: `arn:aws:states:${R}:${A}:stateMachine:ezil-pilot-recovery:1` }, sourceHistoryKey: lifecycle.historyKey });
    new AppCaller(stack, 'AppCaller', { config: { enabled: true, providers: [GITHUB] }, region: R, versionArns: [f.settings.deployment.stateMachineVersionArn] });
    // Lambda version logical IDs embed the code hash; normalize them so the
    // snapshot changes only when a policy changes, not when handler code does.
    const actual = JSON.parse(JSON.stringify(policies(stack)).replace(/CurrentVersion([A-F0-9]{8})[a-f0-9]{32}/g, 'CurrentVersion$1<code-hash>')), file = join(__dirname, '__snapshots__', 'iam-policies.json');
    if (process.env.UPDATE_IAM_SNAPSHOT === '1') writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    assert.ok(existsSync(file), 'snapshot missing: run UPDATE_IAM_SNAPSHOT=1 npm test and review it');
    assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')));
    // No grant to a service principal is unconditioned (confused deputy).
    for (const [id, r] of Object.entries(actual) as [string, any][]) {
        const statements = r.KeyPolicy?.Statement ?? r.PolicyDocument?.Statement ?? [];
        for (const s of statements) if (s.Principal?.Service === 'events.amazonaws.com') {
            assert.ok(s.Condition?.ArnEquals?.['aws:SourceArn'] && s.Condition?.StringEquals?.['aws:SourceAccount'] === A, id);
        }
        if (r.Type === 'AWS::Lambda::Permission' && r.Principal === 'events.amazonaws.com') assert.ok(r.SourceArn && r.SourceAccount === A, id);
    }
});
