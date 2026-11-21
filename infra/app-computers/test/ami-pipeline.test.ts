import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { App, BootstraplessSynthesizer, assertions } from 'aws-cdk-lib';
import { AmiConfigSchema, AmiPipelineStack, NATIVE_PAYLOAD_OBJECT, type AmiConfig } from '../lib/ami-pipeline.js';
import { DEFAULT_STORAGE, LifecycleDeploymentSchema } from '../lib/lifecycle/deployment.js';
import { FoundationConfigSchema } from '../lib/foundation.js';

const config: AmiConfig = { namespace: 'pilot', accountId: '123456789012', region: 'ap-south-1', version: '1.0.0' };
const tags = { 'ezil:namespace': 'pilot' };
function template(candidate: AmiConfig = config) {
    return assertions.Template.fromStack(new AmiPipelineStack(new App({ context: {
        '@aws-cdk/core:validateAgainstDefaultRules': true,
    } }), 'ezil-' + candidate.namespace + '-ami', {
        config: candidate, env: { account: candidate.accountId, region: candidate.region },
        synthesizer: new BootstraplessSynthesizer(), terminationProtection: true,
    }));
}

test('AMI role and profile equal the complete reviewed IAM specification', () => {
    const t = template();
    t.resourceCountIs('AWS::IAM::Role', 1);
    t.resourceCountIs('AWS::IAM::InstanceProfile', 1);
    t.resourceCountIs('AWS::IAM::Policy', 0);
    t.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
    const role = t.toJSON().Resources.BuildRole.Properties;
    assert.deepEqual(role, {
        RoleName: 'ezil-pilot-ami-build', Path: '/ezil/pilot/',
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [
            { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'ec2.amazonaws.com' } },
        ] },
        ManagedPolicyArns: [
            { 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore' },
            { 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/EC2InstanceProfileForImageBuilder' },
        ],
        Policies: [{ PolicyName: 'BuildInputs', PolicyDocument: { Version: '2012-10-17', Statement: [
            { Effect: 'Allow', Action: 's3:GetObject', Resource: { 'Fn::Sub': [
                'arn:${AWS::Partition}:s3:::${Bucket}/ami/host-agent-*.tgz', { Bucket: { Ref: 'AssetBucketName' } },
            ] } },
            { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
            { Effect: 'Allow', Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
                Resource: { 'Fn::Sub': [
                    'arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/${RepositoryName}',
                    { RepositoryName: { 'Fn::Select': [1, { 'Fn::Split': ['.amazonaws.com/', { Ref: 'ApplicationImageRepositoryUri' }] }] } },
                ] } },
        ] } }],
        Tags: [{ Key: 'ezil:namespace', Value: 'pilot' }],
    });
    // Exact equality above also forbids any extra inline statement, S3 wildcard
    // action, bucket-wide object ARN, ECR push grant or workload boundary.
    assert.deepEqual(t.toJSON().Resources.BuildProfile.Properties, {
        InstanceProfileName: 'ezil-pilot-ami-build', Path: '/ezil/pilot/', Roles: [{ Ref: 'BuildRole' }],
    });
});

test('AMI infrastructure: exact type/network, IMDSv2 hop 1, terminate on failure, no key pair', () => {
    const properties = template().toJSON().Resources.Infrastructure.Properties;
    assert.deepEqual(properties, {
        Name: 'ezil-host-pilot', InstanceProfileName: { Ref: 'BuildProfile' },
        InstanceTypes: ['t3a.large'], SubnetId: { Ref: 'SubnetId' }, SecurityGroupIds: [{ Ref: 'SecurityGroupId' }],
        InstanceMetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1 },
        TerminateInstanceOnFailure: true, ResourceTags: tags, Tags: tags,
    });
    assert.equal(Object.hasOwn(properties, 'KeyPair'), false);
});

test('AMI component embeds the checked-in YAML; recipe resolves Ubuntu via SSM and encrypts the 30 GiB gp3 root', () => {
    const t = template().toJSON();
    assert.deepEqual(t.Resources.Component.Properties, {
        Name: 'ezil-host-pilot', Platform: 'Linux', Version: '1.0.0', Tags: tags,
        Data: readFileSync(join(__dirname, '../../host-agent/ami/imagebuilder-component.yaml'), 'utf8'),
    });
    assert.equal(t.Parameters.UbuntuAmiId.Type, 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>');
    assert.equal(t.Parameters.UbuntuAmiId.Default,
        '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id');
    assert.deepEqual(t.Parameters.UbuntuAmiId.AllowedValues, [t.Parameters.UbuntuAmiId.Default]);
    for (const key of ['/attacker/ubuntu24/ami-id',
        '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
        '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id']) {
        assert.equal(t.Parameters.UbuntuAmiId.AllowedValues.includes(key), false, key);
    }
    assert.equal(t.Parameters.SubnetId.Type, 'AWS::EC2::Subnet::Id');
    assert.equal(t.Parameters.SecurityGroupId.Type, 'AWS::EC2::SecurityGroup::Id');
    const inputs = ['AgentSrcS3Uri', 'DesktopImageId', 'CloudflaredVersion', 'CloudflaredSha256', 'EnrollUrl'];
    for (const key of [...inputs, 'ApplicationImageRepositoryUri', 'DesktopImageDigest']) {
        assert.equal(t.Parameters[key].Type, 'String');
        assert.equal(t.Parameters[key].Default, undefined, `${key} must be explicit`);
    }
    assert.deepEqual(t.Resources.Recipe.Properties, {
        Name: 'ezil-host-pilot', Version: '1.0.0', ParentImage: { Ref: 'UbuntuAmiId' }, Tags: tags,
        Components: [{ ComponentArn: { Ref: 'Component' },
            Parameters: [...inputs.map(Name => ({ Name, Value: [{ Ref: Name }] })),
                { Name: 'DesktopImageRef', Value: [{ 'Fn::Sub': ['${RepositoryUri}@${Digest}', {
                    RepositoryUri: { Ref: 'ApplicationImageRepositoryUri' }, Digest: { Ref: 'DesktopImageDigest' },
                }] }] },
                { Name: 'PreviousDesktopImageRef', Value: [{ 'Fn::If': ['HasPreviousDesktopImage',
                    { 'Fn::Sub': ['${RepositoryUri}@${Digest}', { RepositoryUri: { Ref: 'ApplicationImageRepositoryUri' },
                        Digest: { Ref: 'PreviousDesktopImageDigest' } }] }, ''] }] },
                { Name: 'PreviousDesktopImageId', Value: [{ Ref: 'PreviousDesktopImageId' }] }] }],
        BlockDeviceMappings: [{ DeviceName: '/dev/sda1',
            Ebs: { VolumeType: 'gp3', VolumeSize: 30, Encrypted: true, DeleteOnTermination: true } }],
    });
});

test('production AMI adds the exact standalone Git probe only in the existing component test phase', () => {
    const production = template({ ...config, namespace: 'prd' }).toJSON();
    const base = readFileSync(join(__dirname, '../../host-agent/ami/imagebuilder-component.yaml'), 'utf8').trimEnd();
    const data: string = production.Resources.Component.Properties.Data;
    assert(data.startsWith(base + '\n'));
    assert(Buffer.byteLength(data) <= 16_000);

    const phase = data.slice(base.length + 1);
    assert.match(phase, /^  - name: test\n    steps:\n      - name: QualifyStandaloneGit\n/);
    assert.match(phase, /\/usr\/bin\/unshare --mount --propagation private -- \/usr\/bin\/python3 -I -B -c/);
    assert.match(phase, /'\{\{ DesktopImageId \}\}' '\{\{ AgentSrcS3Uri \}\}' <<'EZIL_STANDALONE_GIT_TEST'/);
    const payload = phase.match(/\n                ([A-Za-z0-9+/=]+)\n                EZIL_STANDALONE_GIT_TEST\n$/);
    assert(payload);
    assert.deepEqual(gunzipSync(Buffer.from(payload[1]!, 'base64')),
        readFileSync(join(__dirname, '../lib/standalone-git-imagebuilder.py')));

    const pilot = template().toJSON();
    assert.deepEqual(Object.keys(production.Resources).sort(), Object.keys(pilot.Resources).sort());
    assert.deepEqual(production.Resources.Recipe.Properties.Components, pilot.Resources.Recipe.Properties.Components);
    assert.deepEqual(production.Resources.BuildRole.Properties.ManagedPolicyArns, pilot.Resources.BuildRole.Properties.ManagedPolicyArns);
    assert.deepEqual(production.Resources.BuildRole.Properties.Policies, pilot.Resources.BuildRole.Properties.Policies);
    const infrastructure = production.Resources.Infrastructure.Properties;
    assert.equal(infrastructure.TerminateInstanceOnFailure, true);
    assert.deepEqual(infrastructure.InstanceMetadataOptions, { HttpTokens: 'required', HttpPutResponseHopLimit: 1 });
    assert.equal(Object.hasOwn(infrastructure, 'KeyPair'), false);
});

test('Ubuntu recipe root fits lifecycle and foundation defaults and example configurations', () => {
    const root = template().toJSON().Resources.Recipe.Properties.BlockDeviceMappings[0];
    const lifecycle = LifecycleDeploymentSchema.parse(JSON.parse(readFileSync(join(__dirname, '../config/lifecycle.example.json'), 'utf8')).settings.deployment);
    const foundation = FoundationConfigSchema.parse(JSON.parse(readFileSync(join(__dirname, '../config/foundation.example.json'), 'utf8')));
    for (const storage of [DEFAULT_STORAGE, lifecycle.storage]) {
        assert.equal(root.DeviceName, storage.rootDeviceName);
        assert.ok(root.Ebs.VolumeSize <= storage.rootGiB);
    }
    assert.equal(root.DeviceName, foundation.rootDeviceName);
    assert.ok(root.Ebs.VolumeSize <= foundation.rootVolumeGiB);
});

test('AMI distribution stays private in the configured region; pipeline has no schedule or deploy-time bake', () => {
    const t = template(), resources = t.toJSON().Resources;
    assert.deepEqual(resources.Distribution.Properties, {
        Name: 'ezil-host-pilot', Tags: tags, Distributions: [{ Region: 'ap-south-1',
            AmiDistributionConfiguration: { Name: 'ezil-host-pilot-{{imagebuilder:buildDate}}', AmiTags: tags } }],
    });
    assert.deepEqual(resources.Pipeline.Properties, {
        Name: 'ezil-host-pilot', Status: 'ENABLED', Tags: tags, ImageRecipeArn: { Ref: 'Recipe' },
        InfrastructureConfigurationArn: { Ref: 'Infrastructure' }, DistributionConfigurationArn: { Ref: 'Distribution' },
    });
    assert.equal(Object.hasOwn(resources.Pipeline.Properties, 'Schedule'), false);
    assert.deepEqual(t.toJSON().Outputs, { PipelineArn: { Value: { Ref: 'Pipeline' } } });
    assert.deepEqual(Object.values(resources).map((r: any) => r.Type).sort(), [
        'AWS::IAM::InstanceProfile', 'AWS::IAM::Role', 'AWS::ImageBuilder::Component',
        'AWS::ImageBuilder::DistributionConfiguration', 'AWS::ImageBuilder::ImagePipeline',
        'AWS::ImageBuilder::ImageRecipe', 'AWS::ImageBuilder::InfrastructureConfiguration',
    ].sort());
    assert.doesNotMatch(JSON.stringify(t.toJSON()), /BootstrapVersion|AWS::CloudFormation::CustomResource/);
});

test('AMI inputs reject unpinned images, foreign repositories, broad tarball paths and shell interpolation', () => {
    const parameters = template().toJSON().Parameters;
    const accepts = (key: string, value: string) => new RegExp(`^(?:${parameters[key].AllowedPattern})$`).test(value);
    const digest = 'a'.repeat(64);
    assert.ok(accepts('AgentSrcS3Uri', `s3://deploy-assets/ami/host-agent-${'b'.repeat(40)}.tgz`));
    assert.ok(accepts('DesktopImageDigest', `sha256:${digest}`));
    assert.ok(accepts('ApplicationImageRepositoryUri', '123456789012.dkr.ecr.ap-south-1.amazonaws.com/team/desktop'));
    assert.equal(parameters.DesktopImageDigest.AllowedPattern, '^sha256:[0-9a-f]{64}$');
    assert.equal(parameters.DesktopImageRef, undefined, 'the image reference must be derived');
    assert.equal(parameters.ApplicationImageRepositoryArn, undefined, 'pull permission must be derived');
    assert.ok(accepts('EnrollUrl', 'https://os.ezil.work/api/compute/aws/enroll'));
    for (const [key, value] of [
        ['AssetBucketName', '*'], ['AgentSrcS3Uri', 's3://deploy-assets/other/source.tgz'],
        ['ApplicationImageRepositoryUri', '123456789012.dkr.ecr.ap-south-1.amazonaws.com/*'],
        ['ApplicationImageRepositoryUri', '210987654321.dkr.ecr.ap-south-1.amazonaws.com/desktop'],
        ['ApplicationImageRepositoryUri', '123456789012.dkr.ecr.eu-west-2.amazonaws.com/desktop'],
        ['ApplicationImageRepositoryUri', '123456789012.dkr.ecr.ap-south-1.amazonaws.com/desktop:latest'],
        ['ApplicationImageRepositoryUri', '123456789012.dkr.ecr.ap-south-1.amazonaws.com/team.amazonaws.com/desktop'],
        ['ApplicationImageRepositoryUri', `123456789012.dkr.ecr.ap-south-1.amazonaws.com/desktop@sha256:${digest}`],
        ['DesktopImageDigest', 'latest'], ['DesktopImageDigest', `sha256:${'a'.repeat(63)}`],
        ['DesktopImageDigest', `sha256:${'a'.repeat(65)}`], ['DesktopImageDigest', `sha256:${'A'.repeat(64)}`],
        ['DesktopImageDigest', `sha512:${digest}`], ['DesktopImageDigest', `sha256:${digest}; echo bad`],
        ['DesktopImageId', 'sha256:short'], ['CloudflaredSha256', 'latest'],
        ['CloudflaredVersion', "2026.1.1'; echo bad"], ['EnrollUrl', "https://example.com/'; echo bad"],
    ]) assert.equal(accepts(key!, value!), false, `${key}: ${value}`);
});

test('AMI config requires matching explicit account/region and a bounded immutable version', () => {
    for (const bad of [{ namespace: 'identity' }, { accountId: '123' }, { region: 'somewhere' },
        { version: 'latest' }, { version: '1.0.1073741824' }, { version: '01.0.0' },
        { nativeCandidate: true }, { nativeCandidateParentAmi: 'ami-0123456789abcdef0' },
        { nativeCandidate: false, nativeCandidateParentAmi: 'ami-0123456789abcdef0' },
        { nativeCandidate: true, nativeCandidateParentAmi: '/aws/service/canonical/ubuntu' }]) {
        assert.equal(AmiConfigSchema.safeParse({ ...config, ...bad }).success, false);
    }
    for (const env of [{ account: '210987654321', region: config.region }, { account: config.accountId, region: 'eu-west-2' }]) {
        assert.throws(() => new AmiPipelineStack(new App(), 'WrongEnv', { config, env }), /env must equal/);
    }
});


test('previous lower inputs are paired, optional, distinct and use the approved repository', () => {
    const t = template().toJSON();
    for (const name of ['PreviousDesktopImageDigest', 'PreviousDesktopImageId']) {
        assert.deepEqual(t.Parameters[name], { Type: 'String', Default: '', AllowedPattern: '^(sha256:[0-9a-f]{64})?$' });
        for (const bad of ['latest', 'sha256:short', `sha256:${'A'.repeat(64)}`, "'; echo bad"]) {
            assert.equal(new RegExp(t.Parameters[name].AllowedPattern).test(bad), false);
        }
    }
    assert.deepEqual(t.Conditions.HasPreviousDesktopImage, { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'PreviousDesktopImageDigest' }, ''] }] });
    const parts = JSON.parse(readFileSync(join(__dirname, '../../../deploy/aws/mum/tests/fixtures/ami-previous-bindings.json'), 'utf8'));
    assert.deepEqual(t.Rules, parts.Rules);
    assert.deepEqual(t.Conditions, parts.Conditions);
    assert.deepEqual(t.Resources.Recipe.Properties.Components[0].Parameters.slice(-2), parts.Bindings);
    const assertions = t.Rules.PreviousDesktopImagePair.Assertions;
    assert.deepEqual(assertions[0].Assert, { 'Fn::Or': [
        { 'Fn::And': [
            { 'Fn::Equals': [{ Ref: 'PreviousDesktopImageDigest' }, ''] },
            { 'Fn::Equals': [{ Ref: 'PreviousDesktopImageId' }, ''] },
        ] },
        { 'Fn::And': [
            { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'PreviousDesktopImageDigest' }, ''] }] },
            { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'PreviousDesktopImageId' }, ''] }] },
        ] },
    ] });
    assert.deepEqual(assertions[1].Assert, { 'Fn::Or': [
        { 'Fn::Equals': [{ Ref: 'PreviousDesktopImageId' }, ''] },
        { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'PreviousDesktopImageId' }, { Ref: 'DesktopImageId' }] }] },
    ] });
});

test('native candidate synthesizes a separate private recipe and only one extra exact object read', () => {
    const ordinary = template().toJSON();
    const c = { ...config, nativeCandidate: true, nativeCandidateParentAmi: 'ami-0123456789abcdef0' };
    const t = assertions.Template.fromStack(new AmiPipelineStack(new App(), 'ezil-pilot-ami-native-candidate', {
        config: c, env: { account: c.accountId, region: c.region },
        synthesizer: new BootstraplessSynthesizer(), terminationProtection: true,
    })).toJSON();
    const r = t.Resources;
    assert.equal(ordinary.Resources.NativeCandidateComponent, undefined);
    assert.equal(r.BuildRole.Properties.RoleName, 'ezil-pilot-native-candidate-ami-build');
    assert.equal(r.BuildProfile.Properties.InstanceProfileName, 'ezil-pilot-native-candidate-ami-build');
    assert.deepEqual(t.Parameters.AssetBucketName.AllowedValues, ['ezil-pilot-deploy-assets-123456789012']);
    assert.equal(t.Parameters.NativePayloadS3Uri, undefined);
    assert.equal(t.Parameters.UbuntuAmiId, undefined);
    assert.equal(r.Recipe.Properties.ParentImage, 'ami-0123456789abcdef0');
    assert.deepEqual(ordinary.Resources.Recipe.Properties.ParentImage, { Ref: 'UbuntuAmiId' });
    const statements = r.BuildRole.Properties.Policies[0].PolicyDocument.Statement;
    assert.deepEqual(statements.filter((s: { Action: unknown }) => s.Action === 's3:GetObject'), [
        ordinary.Resources.BuildRole.Properties.Policies[0].PolicyDocument.Statement[0],
        { Effect: 'Allow', Action: 's3:GetObject', Resource: { 'Fn::Sub': [
            'arn:${AWS::Partition}:s3:::${Bucket}/' + NATIVE_PAYLOAD_OBJECT, { Bucket: { Ref: 'AssetBucketName' } },
        ] } },
    ]);
    assert.deepEqual(statements.filter((s: { Action: unknown }) => s.Action !== 's3:GetObject'),
        ordinary.Resources.BuildRole.Properties.Policies[0].PolicyDocument.Statement.slice(1));
    assert.equal(r.NativeCandidateComponent.Properties.Data,
        readFileSync(join(__dirname, '../../host-agent/ami/imagebuilder-native-component.yaml'), 'utf8'));
    assert.deepEqual(r.Recipe.Properties.Components, [
        ordinary.Resources.Recipe.Properties.Components[0],
        { ComponentArn: { Ref: 'NativeCandidateComponent' }, Parameters: [{
            Name: 'NativePayloadS3Uri',
            Value: [{ 'Fn::Sub': ['s3://${Bucket}/' + NATIVE_PAYLOAD_OBJECT, { Bucket: { Ref: 'AssetBucketName' } }] }],
        }] },
    ]);
    assert.equal(r.Recipe.Properties.Name, 'ezil-host-pilot-native-candidate');
    assert.equal(r.Pipeline.Properties.Name, 'ezil-host-pilot-native-candidate');
    assert.equal(r.Pipeline.Properties.Schedule, undefined);
    assert.deepEqual(r.Distribution.Properties.Distributions, [{ Region: 'ap-south-1',
        AmiDistributionConfiguration: { Name: 'ezil-host-pilot-native-candidate-{{imagebuilder:buildDate}}', AmiTags: tags } }]);
    assert.equal(Object.values(r).some((v: any) => v.Type === 'AWS::ImageBuilder::Image' || v.Type === 'AWS::SSM::Parameter'), false);
    const installer = readFileSync(join(__dirname, '../../host-agent/ami/install-native-payload.py'), 'utf8');
    assert.ok(installer.includes('ARCHIVE_SHA = "' + NATIVE_PAYLOAD_OBJECT.match(/[a-f0-9]{64}/)![0] + '"'));
});
