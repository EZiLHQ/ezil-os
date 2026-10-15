import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CfnOutput, CfnParameter, Fn, Stack, type StackProps,
    aws_iam as iam, aws_imagebuilder as imagebuilder,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { z } from 'zod';
import { NAMESPACE_TAG } from './identity.js';
import { NamespaceSchema, REGION_PATTERN } from './lifecycle/deployment.js';
import { workloadPath } from './workload-identity.js';

export const AmiConfigSchema = z.object({
    namespace: NamespaceSchema,
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(REGION_PATTERN),
    // Image Builder components and recipes are immutable. Bump for each update,
    // including changed component parameter values or a new parent AMI.
    version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
        .refine(v => v.split('.').every(n => Number(n) <= 1073741823)),
}).strict();
export type AmiConfig = z.infer<typeof AmiConfigSchema>;

/** Founder change sets only: the workload boundary deliberately cannot grant
 * Image Builder's managed policies or create an EC2 instance profile. */
export class AmiPipelineStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps & { config: AmiConfig }) {
        super(scope, id, props);
        const c = AmiConfigSchema.parse(props.config);
        if (props.env?.region !== c.region || props.env?.account !== c.accountId) throw new Error('stack env must equal the AMI config');
        const name = `ezil-host-${c.namespace}`, tags = { [NAMESPACE_TAG]: c.namespace };
        const bucket = new CfnParameter(this, 'AssetBucketName', {
            type: 'String', allowedPattern: '[a-z0-9][a-z0-9-]{1,61}[a-z0-9]',
            description: 'AssetBucketName output of the deploy identity stack',
        });
        const repository = new CfnParameter(this, 'ApplicationImageRepositoryUri', {
            type: 'String',
            allowedPattern: `${c.accountId}\\.dkr\\.ecr\\.${c.region}\\.amazonaws\\.com/(?!.*\\.amazonaws\\.com/)[a-z0-9][a-z0-9._/-]*`,
            description: 'URI of the foundation application image repository (without a tag or digest)',
        });
        // Bind pull permission and the pinned image to the same repository,
        // including repository names containing slashes. Validation excludes a
        // second split delimiter in the name so the ARN cannot be truncated.
        const repositoryArn = Fn.sub('arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/${RepositoryName}', {
            RepositoryName: Fn.select(1, Fn.split('.amazonaws.com/', repository.valueAsString)),
        });
        const desktopDigest = new CfnParameter(this, 'DesktopImageDigest', {
            type: 'String', allowedPattern: '^sha256:[0-9a-f]{64}$',
            description: 'ECR manifest digest of the desktop image',
        });
        const subnet = new CfnParameter(this, 'SubnetId', {
            type: 'AWS::EC2::Subnet::Id', description: 'Foundation SubnetId0 (public subnet with outbound internet)',
        });
        const securityGroup = new CfnParameter(this, 'SecurityGroupId', {
            type: 'AWS::EC2::SecurityGroup::Id', description: 'Foundation SecurityGroupId',
        });
        const parent = new CfnParameter(this, 'UbuntuAmiId', {
            type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
            default: '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
            // Validate the SSM key, not just the image ID that it resolves to.
            allowedValues: ['/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'],
            description: 'Canonical Ubuntu 24.04 amd64 public SSM parameter; resolved by CloudFormation',
        });
        // Restrict shell-interpolated component inputs to their expected formats.
        const inputs = {
            AgentSrcS3Uri: 's3://[a-z0-9][a-z0-9-]{1,61}[a-z0-9]/ami/host-agent-[a-f0-9]{40}\\.tgz',
            DesktopImageId: 'sha256:[a-f0-9]{64}',
            CloudflaredVersion: '[0-9]{4}\\.[0-9]+\\.[0-9]+',
            CloudflaredSha256: '[a-f0-9]{64}',
            EnrollUrl: 'https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~%/-]*)?',
        };
        const parameters = Object.entries(inputs).map(([key, allowedPattern]) => ({
            name: key, value: [new CfnParameter(this, key, { type: 'String', allowedPattern }).valueAsString],
        }));
        parameters.push({ name: 'DesktopImageRef', value: [Fn.sub('${RepositoryUri}@${Digest}', {
            RepositoryUri: repository.valueAsString, Digest: desktopDigest.valueAsString,
        })] });

        const role = new iam.CfnRole(this, 'BuildRole', {
            roleName: `ezil-${c.namespace}-ami-build`, path: workloadPath(c.namespace),
            assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [
                { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'ec2.amazonaws.com' } },
            ] },
            managedPolicyArns: [
                Fn.sub('arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore'),
                Fn.sub('arn:${AWS::Partition}:iam::aws:policy/EC2InstanceProfileForImageBuilder'),
            ],
            policies: [{ policyName: 'BuildInputs', policyDocument: { Version: '2012-10-17', Statement: [
                { Effect: 'Allow', Action: 's3:GetObject',
                    Resource: Fn.sub('arn:${AWS::Partition}:s3:::${Bucket}/ami/host-agent-*.tgz', { Bucket: bucket.valueAsString }) },
                { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
                { Effect: 'Allow', Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
                    Resource: repositoryArn },
            ] } }],
            tags: [{ key: NAMESPACE_TAG, value: c.namespace }],
        });
        const profile = new iam.CfnInstanceProfile(this, 'BuildProfile', {
            instanceProfileName: `ezil-${c.namespace}-ami-build`,
            path: workloadPath(c.namespace), roles: [role.ref],
        });
        const component = new imagebuilder.CfnComponent(this, 'Component', {
            name, platform: 'Linux', version: c.version, tags,
            data: readFileSync(join(__dirname, '../../host-agent/ami/imagebuilder-component.yaml'), 'utf8'),
        });
        const recipe = new imagebuilder.CfnImageRecipe(this, 'Recipe', {
            name, version: c.version, parentImage: parent.valueAsString, tags,
            components: [{ componentArn: component.ref, parameters }],
            // Canonical's root device is /dev/sda1, including on Nitro instances.
            blockDeviceMappings: [{ deviceName: '/dev/sda1',
                ebs: { volumeType: 'gp3', volumeSize: 30, encrypted: true, deleteOnTermination: true } }],
        });
        const infrastructure = new imagebuilder.CfnInfrastructureConfiguration(this, 'Infrastructure', {
            name, instanceProfileName: profile.ref, instanceTypes: ['t3a.large'],
            subnetId: subnet.valueAsString, securityGroupIds: [securityGroup.valueAsString],
            instanceMetadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1 },
            terminateInstanceOnFailure: true, resourceTags: tags, tags,
            // No keyPair: SSM is the only build-instance access path.
        });
        const distribution = new imagebuilder.CfnDistributionConfiguration(this, 'Distribution', {
            name, tags, distributions: [{ region: c.region, amiDistributionConfiguration: {
                // This L1 property is raw JSON, so use CloudFormation casing.
                Name: `${name}-{{imagebuilder:buildDate}}`, AmiTags: tags,
            } }],
        });
        const pipeline = new imagebuilder.CfnImagePipeline(this, 'Pipeline', {
            name, status: 'ENABLED', tags,
            imageRecipeArn: recipe.ref, infrastructureConfigurationArn: infrastructure.ref,
            distributionConfigurationArn: distribution.ref,
            // No schedule or CfnImage: deploying this stack never starts a bake.
        });
        new CfnOutput(this, 'PipelineArn', { value: pipeline.ref });
    }
}
