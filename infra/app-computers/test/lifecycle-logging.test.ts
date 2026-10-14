import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { IdentityConfigSchema, execStatements } from '../lib/identity.js';
import { lifecycleFixture, REGION } from './lifecycle-fixture.js';

// Live: GetAtt LogGroup.Arn already ends in ':*'; appending another made Step Functions reject
// 'name:*' as the log group name and roll the whole lifecycle stack back.
function template() {
    const f = lifecycleFixture(), stack = new Stack(new App(), 'LifecycleLogging', { env: { account: f.settings.deployment.accountId, region: REGION } });
    const lifecycle = new ComputerLifecycle(stack, 'Lifecycle', { settings: f.settings, authorityKeyArn: f.settings.deployment.dataKeyArn });
    new ComputerLifecycleRecovery(stack, 'Recovery', { settings: { lifecycle: f.settings,
        recoveryVersionArn: `arn:aws:states:${REGION}:${f.settings.deployment.accountId}:stateMachine:ezil-pilot-recovery:1` }, sourceHistoryKey: lifecycle.historyKey });
    return assertions.Template.fromStack(stack).toJSON() as { Resources: Record<string, { Type: string; Properties: any }> };
}
const of = (t: ReturnType<typeof template>, type: string) => Object.entries(t.Resources).filter(([, r]) => r.Type === type);

const machines = (t: ReturnType<typeof template>) => {
    const m = of(t, 'AWS::StepFunctions::StateMachine');
    assert.equal(m.length, 2, 'lifecycle and recovery state machines');
    return m.map(([, r]) => r.Properties);
};

test('every state machine logs to the log group ARN exactly as CloudFormation returns it', () => {
    const t = template();
    for (const machine of machines(t)) {
        const dest = machine.LoggingConfiguration.Destinations;
        assert.equal(dest.length, 1);
        const arn = dest[0].CloudWatchLogsLogGroup.LogGroupArn;
        assert.equal(Object.keys(arn).join(), 'Fn::GetAtt');
        assert.equal(arn['Fn::GetAtt'][1], 'Arn');
        assert.equal(t.Resources[arn['Fn::GetAtt'][0]]!.Type, 'AWS::Logs::LogGroup');
    }
});

test('every state machine key lets vended log delivery decrypt (encrypted state machine with logging)', () => {
    const t = template();
    for (const machine of machines(t)) {
        const key = t.Resources[machine.EncryptionConfiguration.KmsKeyId['Fn::GetAtt'][0]]!;
        const s = key.Properties.KeyPolicy.Statement.filter((x: any) => x.Principal?.Service === 'delivery.logs.amazonaws.com');
        assert.equal(s.length, 1);
        assert.equal(s[0].Action, 'kms:Decrypt');
    }
});

test('exec role may use namespaced keys only via Step Functions for CreateStateMachine/DescribeStateMachine', () => {
    const cfg = IdentityConfigSchema.parse(JSON.parse(readFileSync(join(__dirname, '../config/identity.example.json'), 'utf8')));
    const stmts = execStatements(cfg).map(x => x.toStatementJson()), r = cfg.region;
    const hit = stmts.filter((x: any) => [x.Action].flat().includes('kms:GenerateDataKey'));
    assert.equal(hit.length, 1);
    assert.deepEqual([hit[0].Action].flat().sort(), ['kms:Decrypt', 'kms:GenerateDataKey']);
    assert.deepEqual(hit[0].Condition, { StringEquals: { 'aws:RequestedRegion': r, 'aws:ResourceTag/ezil:namespace': cfg.namespace,
        'kms:ViaService': `states.${r}.amazonaws.com` } });
    assert.equal(hit[0].Resource, `arn:aws:kms:${r}:${cfg.accountId}:key/*`);
});
