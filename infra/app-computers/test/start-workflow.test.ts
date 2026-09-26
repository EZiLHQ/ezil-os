import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { ComputerStartDelivery } from '../lib/computer-start-delivery.js';
import { createStartHelper } from '../lib/start/helper.js';
import { startDefinition } from '../lib/start/definition.js';
import { receiptFor, type HostAction } from '../lib/start/contract.js';
import { fixture, settings } from './start-fixture.js';

// Execute the shipped ASL graph's JSONPath/Choice/Wait/Task subset with real
// helper code. Only AWS and the already separately tested host are simulated.
async function run(options: { lostStart?: boolean; revoke?: boolean; recovery?: boolean;
    missing?: boolean; forged?: boolean; wrongReceipt?: boolean } = {}) {
    const f = fixture(), delivery = f.input, helper = createStartHelper(settings, f.deps);
    if (options.recovery) Object.assign(f.state.execution, { status: 'ABORTED' });
    const definition = startDefinition('helper', options.recovery);
    let status = 'absent', startCount = 0, observed = 0, serial = 0;
    const commands = new Map<string, { action: HostAction; input: Record<string, any>; at: number }>();
    const data: Record<string, any> = { sourceExecutionArn: f.event.executionArn };
    const context: Record<string, any> = { Execution: { Id: f.event.executionArn, StartTime: f.event.recoveryStartedAt } };
    const path = (input: string, root = data): any => input === '$' ? root
        : input.replace(/^\$\$?\./, '').split('.').reduce((o, k) => o?.[k], input.startsWith('$$') ? context : root);
    const parameters = (values: Record<string, any>, root = data) => Object.fromEntries(Object.entries(values)
        .map(([k, v]) => [k.endsWith('.$') ? k.slice(0, -2) : k, k.endsWith('.$') ? path(v, root) : v]));
    f.deps.command = async id => {
        if (options.missing) return undefined;
        const c = commands.get(id)!;
        return { CommandId: id, ...c.input, RequestedDateTime: new Date(c.at),
            ...(options.forged ? { InstanceIds: ['i-00000000000000000'] } : {}) };
    };
    f.deps.invocation = async id => {
        const c = commands.get(id)!;
        if (c.action === 'observe' && status === 'running') { observed++; if (observed >= 2) status = 'succeeded'; }
        if (c.action === 'cancel') status = 'cancelled';
        return { CommandId: id, InstanceId: delivery.work.scope.providerInstanceId, DocumentName: settings.documentName,
            DocumentVersion: settings.documentVersion, PluginName: 'operateStart', Status: 'Success', ResponseCode: 0,
            StandardOutputContent: JSON.stringify({ schemaVersion: 1, authorizationId: delivery.work.authorizationId,
                scope: delivery.work.scope, status, ...(status === 'succeeded'
                    ? { result: options.wrongReceipt ? { loaded: true } : receiptFor(delivery) } : {}) }) };
    };
    let next = definition.StartAt;
    for (let step = 0; step < 5000; step++) {
        const state = (definition.States as Record<string, any>)[next]; assert.ok(state, next);
        if (state.Type === 'Fail') return { error: state.Error, startCount, status, commands, f };
        if (state.Type === 'Pass') return { result: state.InputPath ? path(state.InputPath) : state.Result, startCount, status, commands, f };
        if (state.Type === 'Wait') { f.state.now += state.Seconds * 1000; next = state.Next; continue; }
        if (state.Type === 'Choice') { next = state.Choices.find((c: any) => path(c.Variable) === c.StringEquals)?.Next ?? state.Default; continue; }
        assert.equal(state.Type, 'Task'); assert.equal(state.Retry, undefined);
        try {
            let result: any;
            const input = parameters(state.Parameters);
            if (state.Resource === 'helper') result = await helper(input);
            else {
                assert.equal(state.Resource, 'arn:aws:states:::aws-sdk:ssm:sendCommand');
                const operation = JSON.parse(Buffer.from(input.Parameters.Operation[0], 'base64').toString());
                const action = operation.action as HostAction;
                if (action === 'start') { startCount++; status = 'running'; }
                if (options.revoke && action === 'start') f.state.authorized = false;
                const id = `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
                commands.set(id, { action, input, at: f.state.now });
                if (options.lostStart && action === 'start') throw new Error('response_lost_after_acceptance');
                result = { Command: { CommandId: id } };
            }
            if (state.ResultSelector) result = parameters(state.ResultSelector, result);
            data[state.ResultPath.slice(2)] = result;
            next = state.Next;
        } catch { next = state.Catch[0].Next; }
    }
    throw new Error('unbounded_workflow');
}

test('full Standard graph delivers, observes and emits only exact started receipt', async () => {
    const r = await run(); assert.deepEqual(r.result, receiptFor(r.f.input)); assert.equal(r.startCount, 1);
    assert.ok(r.f.state.authorityCalls >= 4);
});
test('accepted start with lost AWS response is recovered through observation, never restarted', async () => {
    const r = await run({ lostStart: true }); assert.deepEqual(r.result, receiptFor(r.f.input)); assert.equal(r.startCount, 1);
});
test('revocation during work and terminal workflow interruption use host cancellation fence', async () => {
    const revoked = await run({ revoke: true }); assert.equal(revoked.error, 'StartCancelled');
    assert.equal(revoked.status, 'cancelled'); assert.equal(revoked.startCount, 1);
    const recovery = await run({ recovery: true }); assert.deepEqual(recovery.result, { status: 'cancelled' });
    assert.equal(recovery.startCount, 0);
});
test('lost/forged command evidence and wrong receipts cannot produce success', async () => {
    for (const options of [{ missing: true }, { forged: true }, { wrongReceipt: true }]) {
        const r = await run(options); assert.equal(r.result, undefined); assert.equal(r.error, 'StartUnconfirmed');
        assert.equal(r.startCount, 1);
    }
});
test('CDK binds pinned documents, Standard history, restricted IAM and disabled reconciliation', () => {
    for (const recovery of [false, true]) {
        const definition = startDefinition('helper', recovery), reached = new Set<string>(), pending = [definition.StartAt];
        while (pending.length) {
            const name = pending.pop()!; if (reached.has(name)) continue;
            reached.add(name); const state = (definition.States as Record<string, any>)[name]; assert.ok(state, name);
            for (const target of [state.Next, state.Default, ...(state.Choices ?? []).map((c: any) => c.Next),
                ...(state.Catch ?? []).map((c: any) => c.Next)].filter(Boolean)) pending.push(target);
        }
        assert.deepEqual([...reached].sort(), Object.keys(definition.States).sort(), 'all ASL states must be reachable');
    }
    const app = new App(), stack = new Stack(app, 'DeliveryTest', { env: { account: settings.deployment.accountId, region: settings.deployment.region } });
    const { machineArn: _machine, documentName: _name, ...config } = settings;
    new ComputerStartDelivery(stack, 'Start', { settings: config, machineName: 'ezil-start-pilot', authorityKeyArn: settings.deployment.dataKeyArn });
    const template = assertions.Template.fromStack(stack);
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
    template.resourceCountIs('AWS::SSM::Document', 1);
    const document = Object.values(template.findResources('AWS::SSM::Document'))[0] as any;
    assert.equal(document.Properties.Content.mainSteps[0].name,'operateStart');
    assert.equal(document.Properties.Content.mainSteps[0].inputs.timeoutSeconds,'150');
    assert.deepEqual(document.Properties.Content.mainSteps[0].inputs.runCommand,
        ['/usr/local/bin/node /opt/ezil-supervisor/current/dist/start-operation.js']);
    template.resourceCountIs('AWS::EC2::Instance', 0); template.resourceCountIs('AWS::EC2::Volume', 0);
    const machines = Object.values(template.findResources('AWS::StepFunctions::StateMachine')) as any[];
    for (const machine of machines) {
        assert.equal(machine.Properties.StateMachineType, 'STANDARD');
        assert.equal(machine.Properties.LoggingConfiguration.IncludeExecutionData, false);
        assert.equal(machine.Properties.EncryptionConfiguration.Type, 'CUSTOMER_MANAGED_KMS_KEY');
        const definition = JSON.stringify(machine.Properties.DefinitionString);
        assert.match(definition, /aws-sdk:ssm:sendCommand/); assert.doesNotMatch(definition, /ClientToken|Retry|AWS-RunShellScript/);
    }
    for (const rule of Object.values(template.findResources('AWS::Events::Rule')) as any[]) assert.equal(rule.Properties.State, 'DISABLED');
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    assert.doesNotMatch(policies, /ec2:RunInstances|ec2:AttachVolume|states:RedriveExecution|ssm:CancelCommand|ssm:StartSession/);
    assert.match(policies, /ssm:resourceTag\/ezil:managed-by/);
    const helperPolicies = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([k]) => k.includes('Helper')).map(([, v]) => v);
    assert.doesNotMatch(JSON.stringify(helperPolicies), /ssm:SendCommand/);
    assert.doesNotMatch(policies,/secretsmanager:CreateSecret|secretsmanager:PutSecretValue|s3:GetObject/);
    assert.equal(startDefinition('helper').TimeoutSeconds,660);
    assert.equal(startDefinition('helper',true).TimeoutSeconds,360);
    app.synth(); // includes CloudFormation dependency-cycle validation
});
