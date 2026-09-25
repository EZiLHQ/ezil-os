import assert from 'node:assert/strict';
import test from 'node:test';

import { App, assertions } from 'aws-cdk-lib';

import { AppComputerFoundationStack } from '../lib/foundation.js';

function template() {
    const app = new App();
    const stack = new AppComputerFoundationStack(app, 'TestAppComputers', {
        stage: 'pilot', env: { region: 'us-east-1' },
    });
    return assertions.Template.fromStack(stack);
}

test('synthesizes one outbound-only public subnet without a continuously billed NAT gateway', () => {
    const output = template();
    output.resourceCountIs('AWS::EC2::NatGateway', 0);
    output.resourceCountIs('AWS::EC2::Subnet', 1);
    output.hasResourceProperties('AWS::EC2::Subnet', { MapPublicIpOnLaunch: true });
    const groups = Object.values(output.findResources('AWS::EC2::SecurityGroup')) as
        { Properties: { SecurityGroupIngress?: unknown[]; SecurityGroupEgress?: unknown[] } }[];
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.Properties.SecurityGroupIngress?.length ?? 0, 0);
    const egress = JSON.stringify(groups[0]?.Properties.SecurityGroupEgress);
    assert.match(egress, /443/);
    assert.match(egress, /3478/);
});

test('launch template pins capacity and encrypts only the disposable root volume', () => {
    const output = template();
    const resource = Object.values(output.findResources('AWS::EC2::LaunchTemplate'))[0] as {
        Properties: { LaunchTemplateData: Record<string, unknown> };
    };
    assert.ok(resource);
    const data = resource.Properties.LaunchTemplateData;
    assert.equal(data.InstanceType, 'm7i.large');
    assert.deepEqual(data.MetadataOptions, {
        HttpEndpoint: 'enabled', HttpTokens: 'required', HttpPutResponseHopLimit: 1,
    });
    assert.deepEqual(data.BlockDeviceMappings, [{
        DeviceName: '/dev/xvda',
        Ebs: { VolumeType: 'gp3', VolumeSize: 30, Encrypted: true, DeleteOnTermination: true },
    }]);
    assert.deepEqual(data.ImageId, { Ref: 'SupervisorAmiId' });
    assert.equal((data.BlockDeviceMappings as unknown[]).length, 1,
        'persistent user data must be a separate controller-owned volume');
});

test('image registry is retained and the host role has no EC2 or EBS controller permissions', () => {
    const output = template();
    output.hasResourceProperties('AWS::ECR::Repository', {
        ImageTagMutability: 'IMMUTABLE',
        ImageScanningConfiguration: { ScanOnPush: true },
        EncryptionConfiguration: { EncryptionType: 'AES256' },
    });
    const repos = Object.values(output.findResources('AWS::ECR::Repository')) as
        { DeletionPolicy?: string }[];
    assert.equal(repos[0]?.DeletionPolicy, 'Retain');
    const roles = JSON.stringify(output.findResources('AWS::IAM::Role'));
    assert.match(roles, /AmazonSSMManagedInstanceCore/);
    assert.doesNotMatch(roles, /ec2:RunInstances|ec2:AttachVolume|ec2:DeleteVolume/);
    output.resourceCountIs('AWS::EC2::Instance', 0);
    output.resourceCountIs('AWS::EC2::Volume', 0);
});
