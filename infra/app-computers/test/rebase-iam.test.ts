import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { AppCaller, AppCallerConfigSchema } from '../lib/app-caller.js';
import { preparationStatements } from '../lib/rebase-preparation.js';
import { SNAPSHOT_TAG_KEYS } from '../lib/lifecycle/preparation-contract.js';
import { applyWorkloadIdentity } from '../lib/workload-identity.js';
import { preparationFixture } from './preparation-fixture.js';

const list = (v: any): any[] => v === undefined ? [] : [v].flat();
function permits(action: string, resource: string, context: Record<string, unknown>) {
    const statements = preparationStatements(preparationFixture().settings).map(s => s.toStatementJson()).filter(s =>
        list(s.Action).includes(action) && list(s.Resource).some(r => r === '*' || resource.startsWith(r.replace(/\*$/, '')))
        && Object.entries(s.Condition ?? {}).every(([op, entries]) => Object.entries(entries as any).every(([key, wanted]) => {
            const values = list(context[key]), expected = list(wanted);
            if (op === 'Null') return String(values.length === 0) === wanted;
            if (op === 'StringEquals') return values.length > 0 && values.every(v => expected.includes(v));
            if (op === 'ForAllValues:StringEquals') return values.every(v => expected.includes(v));
            if (op === 'ForAnyValue:StringEquals') return values.some(v => expected.includes(v));
            assert.fail('unhandled condition ' + op);
        })));
    return statements.some(s => s.Effect === 'Allow') && !statements.some(s => s.Effect === 'Deny');
}
test('preparation snapshot IAM separates source volume, destination and create-time tagging with the empty-account snapshot ARN', () => {
    const policies = preparationStatements(preparationFixture().settings).map(s => s.toStatementJson());
    const source = policies.filter(s => s.Effect === 'Allow' && s.Action === 'ec2:CreateSnapshot');
    assert.deepEqual(source.map(s => s.Resource), ['arn:aws:ec2:ap-south-1:123456789012:volume/*', 'arn:aws:ec2:ap-south-1::snapshot/*']);
    assert.deepEqual(source[0].Condition, { StringEquals: { 'aws:RequestedRegion': 'ap-south-1',
        'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform', 'ec2:ResourceTag/ezil:stage': 'pilot', 'ec2:ResourceTag/ezil:backup': 'pilot' },
    Null: { 'aws:ResourceTag/ezil:computer-id': 'false', 'aws:ResourceTag/ezil:pool': 'true' } });
    assert.deepEqual(source[1].Condition, { StringEquals: { 'aws:RequestedRegion': 'ap-south-1',
        'aws:RequestTag/ezil:managed-by': 'app-computer-platform', 'aws:RequestTag/ezil:stage': 'pilot', 'aws:RequestTag/ezil:purpose': 'pre-rebase' },
    Null: Object.fromEntries(['aws:TagKeys', ...SNAPSHOT_TAG_KEYS.map(k => 'aws:RequestTag/' + k)].map(k => [k, 'false'])),
    'ForAllValues:StringEquals': { 'aws:TagKeys': [...SNAPSHOT_TAG_KEYS] } });
    const tagging = policies.find(s => s.Effect === 'Allow' && s.Action === 'ec2:CreateTags')!;
    assert.equal(tagging.Resource, source[1].Resource);
    assert.deepEqual(tagging.Condition, { ...source[1].Condition, StringEquals: { ...source[1].Condition.StringEquals, 'ec2:CreateAction': 'CreateSnapshot' } });
});
test('preparation IAM refuses each absent tag, absent TagKeys, foreign namespace/region and post-create mutation', () => {
    const arn = 'arn:aws:ec2:ap-south-1::snapshot/snap-11111111111111111';
    const context: Record<string, unknown> = { 'aws:RequestedRegion': 'ap-south-1', 'ec2:CreateAction': 'CreateSnapshot',
        'aws:TagKeys': [...SNAPSHOT_TAG_KEYS], ...Object.fromEntries(SNAPSHOT_TAG_KEYS.map(k => ['aws:RequestTag/' + k, 'present'])),
        'aws:RequestTag/ezil:managed-by': 'app-computer-platform', 'aws:RequestTag/ezil:stage': 'pilot', 'aws:RequestTag/ezil:purpose': 'pre-rebase' };
    for (const action of ['ec2:CreateSnapshot', 'ec2:CreateTags']) {
        assert.equal(permits(action, arn, context), true);
        for (const key of ['aws:TagKeys', ...SNAPSHOT_TAG_KEYS.map(k => 'aws:RequestTag/' + k)]) assert.equal(permits(action, arn, { ...context, [key]: undefined }), false, key);
        for (const patch of [{ 'aws:RequestTag/ezil:stage': 'foreign' }, { 'aws:RequestedRegion': 'us-east-1' },
            { 'aws:TagKeys': [...SNAPSHOT_TAG_KEYS, 'Name'] }]) assert.equal(permits(action, arn, { ...context, ...patch }), false);
    }
    assert.equal(permits('ec2:CreateTags', arn, { ...context, 'ec2:CreateAction': undefined }), false);
    for (const action of ['ec2:DeleteSnapshot', 'ec2:DeleteVolume', 'ec2:DetachVolume', 'ec2:DeleteTags', 'ec2:ModifyInstanceMetadataOptions', 'iam:PassRole'])
        assert.equal(permits(action, arn, context), false);
});
test('preparation IAM source requires a managed data volume, computer identity and no pool tag', () => {
    const resource = 'arn:aws:ec2:ap-south-1:123456789012:volume/vol-11111111111111111';
    const context = { 'aws:RequestedRegion': 'ap-south-1', 'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform',
        'ec2:ResourceTag/ezil:stage': 'pilot', 'ec2:ResourceTag/ezil:backup': 'pilot', 'aws:ResourceTag/ezil:computer-id': 'computer' };
    assert.equal(permits('ec2:CreateSnapshot', resource, context), true);
    for (const key of Object.keys(context)) assert.equal(permits('ec2:CreateSnapshot', resource, { ...context, [key]: undefined }), false, key);
    assert.equal(permits('ec2:CreateSnapshot', resource, { ...context, 'aws:ResourceTag/ezil:pool': '1' }), false);
    assert.equal(permits('ec2:CreateSnapshot', resource.replace('123456789012', '999999999999'), context), false);
});
test('owned lifecycle construct wires preparation, exact observer version, history key, boundary and caller grants', () => {
    const f = preparationFixture(), stack = new Stack(new App(), 'RebaseIam', { env: { account: '123456789012', region: 'ap-south-1' } });
    applyWorkloadIdentity(stack, '123456789012', 'pilot');
    const lifecycle = new ComputerLifecycle(stack, 'Lifecycle', { settings: f.settings, authorityKeyArn: f.intent.deployment.dataKeyArn });
    new AppCaller(stack, 'AppCaller', { config: AppCallerConfigSchema.parse({ enabled: true, providers: [{ name: 'github',
        providerArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com', issuerHost: 'token.actions.githubusercontent.com',
        audience: 'sts.amazonaws.com', subject: 'repo:example/repo:environment:test' }] }), region: 'ap-south-1',
    versionArns: [f.intent.deployment.stateMachineVersionArn], historyKeyArn: lifecycle.historyKey.keyArn });
    const t = assertions.Template.fromStack(stack), all = t.toJSON().Resources as Record<string, any>;
    const machine = Object.values(all).find(r => r.Type === 'AWS::StepFunctions::StateMachine' && r.Properties.StateMachineName === 'ezil-pilot-rebase-preparation')!;
    assert.equal(machine.Properties.StateMachineType, 'STANDARD'); assert.equal(machine.Properties.LoggingConfiguration.Level, 'ERROR');
    assert.equal(machine.Properties.LoggingConfiguration.IncludeExecutionData, false);
    const role = Object.values(all).find(r => r.Type === 'AWS::IAM::Role' && r.Properties.RoleName === 'ezil-pilot-rebase-preparation')!;
    assert.equal(role.Properties.Path, '/ezil/pilot/');
    assert.equal(role.Properties.PermissionsBoundary, 'arn:aws:iam::123456789012:policy/ezil/identity/ezil-pilot-boundary');
    assert.deepEqual(role.Properties.AssumeRolePolicyDocument.Statement[0].Condition, { StringEquals: { 'aws:SourceAccount': '123456789012' },
        ArnEquals: { 'aws:SourceArn': 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-pilot-rebase-preparation' } });
    const policies = Object.entries(all).filter(([id, r]) => id.startsWith('AppCaller') && r.Type === 'AWS::IAM::Policy').flatMap(([, r]) => r.Properties.PolicyDocument.Statement);
    assert.ok(policies.some(s => list(s.Action).includes('states:StartExecution') && list(s.Resource).includes('arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-pilot-rebase-preparation')));
    assert.ok(policies.some(s => list(s.Action).includes('ec2:DescribeSnapshots') && s.Condition.StringEquals['aws:RequestedRegion'] === 'ap-south-1'));
    const observerPolicies = Object.entries(all).filter(([id, r]) => id.startsWith('LifecyclePreparationObserverRole') && r.Type === 'AWS::IAM::Policy').flatMap(([, r]) => r.Properties.PolicyDocument.Statement);
    assert.ok(observerPolicies.length);
    assert.ok(observerPolicies.every(s => list(s.Action).every(a => /^ec2:Describe|^states:DescribeExecution$|^kms:Decrypt$|^secretsmanager:GetSecretValue$|^logs:(CreateLogStream|PutLogEvents)$/.test(a))));
    const controllerPolicies = Object.entries(all).filter(([id, r]) => id.startsWith('LifecyclePreparationRebasePreparationRole') && r.Type === 'AWS::IAM::Policy').flatMap(([, r]) => r.Properties.PolicyDocument.Statement);
    const invoke = controllerPolicies.filter(s => list(s.Action).includes('lambda:InvokeFunction'));
    assert.equal(invoke.length, 1); assert.match(JSON.stringify(invoke[0].Resource), /CurrentVersion/);
    assert.doesNotMatch(JSON.stringify(invoke), /function:\*/);
    assert.ok(Object.keys(t.toJSON().Outputs).some(k => k.includes('PreparationVersionArn')));
});
