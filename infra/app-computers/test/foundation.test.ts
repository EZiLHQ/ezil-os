import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { App, assertions } from 'aws-cdk-lib';

import { AppComputerFoundationStack, FoundationConfigSchema, type FoundationConfig } from '../lib/foundation.js';
import { zoneIdMatchesRegion, zoneIdPrefix } from '../lib/lifecycle/deployment.js';

const base: FoundationConfig = { stage: 'pilot', region: 'ap-south-1', zoneIds: ['aps1-az1'], instanceType: 'm6i.large', rootDeviceName: '/dev/sda1', rootVolumeGiB: 30 };
function template(config: Partial<FoundationConfig> = {}) {
    const app = new App(), merged = { ...base, ...config };
    const stack = new AppComputerFoundationStack(app, 'TestAppComputers', { config: merged, env: { region: merged.region } });
    return assertions.Template.fromStack(stack);
}

test('item 1: region and ZoneIds are configuration; ap-south-1 / aps1-az1 synthesizes one subnet pinned by ZoneId', () => {
    const output = template();
    output.resourceCountIs('AWS::EC2::Subnet', 1);
    output.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZoneId: 'aps1-az1', MapPublicIpOnLaunch: true });
    const json = JSON.stringify(output.toJSON());
    assert.ok(!json.includes('"AvailabilityZone"'), 'no account-mapped zone names');
    assert.ok(!json.includes('Fn::GetAZs'), 'no zone-name lookup');
    assert.doesNotMatch(json, /us-east-1|m7i/);
});

test('item 1: one subnet per configured ZoneId', () => {
    const output = template({ zoneIds: ['aps1-az1', 'aps1-az3'] });
    output.resourceCountIs('AWS::EC2::Subnet', 2);
    output.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZoneId: 'aps1-az3' });
    output.resourceCountIs('AWS::EC2::SubnetRouteTableAssociation', 2);
});

test('item 1: ZoneId and region validation', () => {
    assert.equal(zoneIdPrefix('ap-south-1'), 'aps1');
    assert.equal(zoneIdPrefix('ap-northeast-1'), 'apne1');
    assert.ok(zoneIdMatchesRegion('aps1-az1', 'ap-south-1'));
    assert.ok(zoneIdMatchesRegion('aps1-az3', 'ap-south-1'));
    for (const [zoneIds, region] of [[['ap-south-1a'], 'ap-south-1'], [['use1-az1'], 'ap-south-1'], [['aps1-az1', 'aps1-az1'], 'ap-south-1'],
        [['APS1-AZ1'], 'ap-south-1'], [['aps1-az1'], 'mumbai'], [[], 'ap-south-1']] as const) {
        assert.equal(FoundationConfigSchema.safeParse({ ...base, zoneIds, region }).success, false, `${zoneIds} ${region}`);
    }
    assert.ok(template({ region: 'eu-west-2', zoneIds: ['euw2-az1'] }));
    assert.throws(() => new AppComputerFoundationStack(new App(), 'X', { config: base, env: { region: 'eu-west-2' } }), /region/);
});

test('item 4: no NAT, no load balancer, no inbound rules, all outbound', () => {
    const output = template();
    output.resourceCountIs('AWS::EC2::NatGateway', 0);
    output.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    output.resourceCountIs('AWS::ElasticLoadBalancing::LoadBalancer', 0);
    output.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    const groups = Object.values(output.findResources('AWS::EC2::SecurityGroup')) as
        { Properties: { SecurityGroupIngress?: unknown[]; SecurityGroupEgress?: unknown[] } }[];
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.Properties.SecurityGroupIngress?.length ?? 0, 0);
    assert.deepEqual(groups[0]?.Properties.SecurityGroupEgress, [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'All outbound (metered outside the guest)' }]);
    output.resourceCountIs('AWS::EC2::SecurityGroupEgress', 0);
});

test('items 2/4/5: launch template is IMDSv2-only, hop 1, tags off, no hibernation, allowlisted type, encrypted configured root', () => {
    for (const instanceType of ['m6i.large', 'c6i.xlarge', 'm6i.xlarge', 'm6i.2xlarge'] as const) {
        const resource = Object.values(template({ instanceType }).findResources('AWS::EC2::LaunchTemplate'))[0] as {
            Properties: { LaunchTemplateData: Record<string, unknown> } };
        const data = resource.Properties.LaunchTemplateData;
        assert.equal(data.InstanceType, instanceType);
        assert.deepEqual(data.MetadataOptions, { HttpEndpoint: 'enabled', HttpTokens: 'required', HttpPutResponseHopLimit: 1, InstanceMetadataTags: 'disabled' });
        assert.deepEqual(data.HibernationOptions, { Configured: false });
        assert.equal(data.InstanceInitiatedShutdownBehavior, 'stop');
        assert.equal(data.IamInstanceProfile, undefined, 'item 3: hosts launch without an instance role');
        assert.deepEqual(data.BlockDeviceMappings, [{ DeviceName: '/dev/sda1',
            Ebs: { VolumeType: 'gp3', VolumeSize: 30, Encrypted: true, DeleteOnTermination: true } }]);
        assert.deepEqual(data.ImageId, { Ref: 'HostAmiId' });
    }
    for (const instanceType of ['m7i.large', 't3.large']) {
        assert.equal(FoundationConfigSchema.safeParse({ ...base, instanceType }).success, false, instanceType);
    }
    assert.equal(FoundationConfigSchema.safeParse({ ...base, rootVolumeGiB: 30 }).success, true);
    assert.equal(FoundationConfigSchema.safeParse({ ...base, rootVolumeGiB: 65 }).success, false);
});

test('item 3: no host role, profile or policy; registry retained and encrypted', () => {
    const output = template();
    output.resourceCountIs('AWS::IAM::Role', 0);
    output.resourceCountIs('AWS::IAM::InstanceProfile', 0);
    output.resourceCountIs('AWS::IAM::Policy', 0);
    output.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
    assert.doesNotMatch(JSON.stringify(output.toJSON()), /AmazonSSMManagedInstanceCore|ssm:GetParameter|iam:PassRole/);
    output.hasResourceProperties('AWS::ECR::Repository', {
        ImageTagMutability: 'IMMUTABLE', ImageScanningConfiguration: { ScanOnPush: true }, EncryptionConfiguration: { EncryptionType: 'AES256' },
    });
    const repos = Object.values(output.findResources('AWS::ECR::Repository')) as { DeletionPolicy?: string }[];
    assert.equal(repos[0]?.DeletionPolicy, 'Retain');
    output.resourceCountIs('AWS::EC2::Instance', 0);
    output.resourceCountIs('AWS::EC2::Volume', 0);
});

test('launch template uses the validated configured root device name', () => {
    assert.equal(FoundationConfigSchema.parse({ ...base, rootDeviceName: undefined }).rootDeviceName, '/dev/sda1');
    assert.equal(FoundationConfigSchema.parse({ ...base, rootVolumeGiB: undefined }).rootVolumeGiB, 30);
    for (const rootDeviceName of ['/dev/sda1', '/dev/xvda'] as const) {
        template({ rootDeviceName }).hasResourceProperties('AWS::EC2::LaunchTemplate', {
            LaunchTemplateData: { BlockDeviceMappings: [{ DeviceName: rootDeviceName,
                Ebs: { VolumeType: 'gp3', VolumeSize: 30, Encrypted: true, DeleteOnTermination: true } }] },
        });
    }
    for (const rootDeviceName of ['/dev/sdf', '/dev/nvme0n1', '', null]) {
        assert.equal(FoundationConfigSchema.safeParse({ ...base, rootDeviceName }).success, false);
    }
});

test('item 1/2: no region or legacy instance-type literal anywhere in shipped source', () => {
    const root = join(__dirname, '..');
    const files = ['bin', 'lib', 'config'].flatMap(dir => {
        const walk = (path: string): string[] => statSync(path).isDirectory() ? readdirSync(path).flatMap(f => walk(join(path, f))) : [path];
        return walk(join(root, dir));
    // Only shipped files: local deploy configs (config/*.pilot.json etc.) are gitignored
    // and legitimately name a real region; the committed examples must not.
    }).filter(f => !f.includes(`${join(root, 'config')}`) || f.endsWith('.example.json'));
    assert.ok(files.length > 10);
    for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /us-east-1|m7i\.|availabilityZone:|writerProfile|instanceProfileArn/, file);
});
