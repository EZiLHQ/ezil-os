import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { lifecycleFixture } from './lifecycle-fixture.js';

test('lifecycle CDK synthesizes a pinned Standard graph, scoped roles, encryption and disabled notifications',()=>{
    const f=lifecycleFixture(),app=new App(),stack=new Stack(app,'LifecycleTest',{env:{account:f.settings.deployment.accountId,region:'us-east-1'}});
    new ComputerLifecycle(stack,'Lifecycle',{settings:f.settings,authorityKeyArn:f.settings.deployment.dataKeyArn});
    const t=assertions.Template.fromStack(stack);
    t.resourceCountIs('AWS::EC2::Instance',0);t.resourceCountIs('AWS::EC2::Volume',0);
    t.resourceCountIs('AWS::StepFunctions::StateMachine',1);t.resourceCountIs('AWS::StepFunctions::StateMachineVersion',1);
    t.hasResourceProperties('AWS::StepFunctions::StateMachine',{StateMachineType:'STANDARD',EncryptionConfiguration:{Type:'CUSTOMER_MANAGED_KMS_KEY'},
        LoggingConfiguration:{IncludeExecutionData:false,Level:'ERROR'}});
    t.hasResourceProperties('AWS::Events::Rule',{State:'DISABLED',EventPattern:{detail:{status:['FAILED','TIMED_OUT','ABORTED']}}});
    t.hasResourceProperties('AWS::Lambda::Function',{Timeout:55,ReservedConcurrentExecutions:2});
    const policies=Object.values(t.findResources('AWS::IAM::Policy')) as any[];
    const statements=policies.flatMap(p=>p.Properties.PolicyDocument.Statement);
    const pass=statements.find(s=>([] as string[]).concat(s.Action).includes('iam:PassRole'));
    assert.equal(pass.Resource,'arn:aws:iam::123456789012:role/ezil/pilot/computers/*/g*');
    assert.equal(pass.Condition.StringEquals['iam:PassedToService'],'ec2.amazonaws.com');
    const all=JSON.stringify(statements);assert.ok(!all.includes('ec2:DeleteVolume'));assert.ok(!all.includes('ec2:DetachVolume'));
    assert.ok(!all.includes('iam:CreateRole'));assert.ok(!all.includes('ec2:*'));
    const stop=statements.find(s=>([] as string[]).concat(s.Action).includes('ec2:StopInstances'));
    assert.equal(stop.Condition.StringEquals['ec2:ResourceTag/ezil:managed-by'],'app-computer-platform');
    for(const queue of Object.values(t.findResources('AWS::SQS::Queue')) as any[]) {assert.ok(queue.Properties.KmsMasterKeyId);assert.equal(queue.DeletionPolicy,'Retain');}
    assert.equal((Object.values(t.findResources('AWS::StepFunctions::StateMachineVersion')) as any[])[0].DeletionPolicy,'Retain');
});
