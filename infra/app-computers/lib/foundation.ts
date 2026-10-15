import {
    CfnOutput, CfnParameter, RemovalPolicy, Stack, type StackProps,
    aws_ec2 as ec2, aws_ecr as ecr,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { z } from 'zod';
import { NAMESPACE_TAG } from './identity.js';
import { DEFAULT_STORAGE, InstanceTypeSchema, RootDeviceNameSchema, REGION_PATTERN, ZONE_ID_PATTERN, zoneIdMatchesRegion } from './lifecycle/deployment.js';

/** Foundation configuration. Region and ZoneIds are configuration, never
 * literals (R1); zone names are never stored because they are account-mapped. */
export const FoundationConfigSchema = z.object({
    stage: z.enum(['pilot', 'production']),
    region: z.string().regex(REGION_PATTERN),
    /** One public subnet per ZoneId. A pilot uses exactly one. */
    zoneIds: z.array(z.string().regex(ZONE_ID_PATTERN)).min(1).max(3),
    /** Launch-template default; the lifecycle supplies the per-computer type. */
    instanceType: InstanceTypeSchema,
    rootDeviceName: RootDeviceNameSchema,
    rootVolumeGiB: z.number().int().min(8).max(64).default(DEFAULT_STORAGE.rootGiB),
}).strict().superRefine((c, ctx) => {
    if (new Set(c.zoneIds).size !== c.zoneIds.length) ctx.addIssue({ code: 'custom', path: ['zoneIds'], message: 'duplicate_zone_id' });
    for (const zoneId of c.zoneIds) if (!zoneIdMatchesRegion(zoneId, c.region)) {
        ctx.addIssue({ code: 'custom', path: ['zoneIds'], message: 'zone_not_in_region' });
    }
});
export type FoundationConfig = z.infer<typeof FoundationConfigSchema>;

export interface AppComputerFoundationProps extends StackProps {
    readonly config: FoundationConfig;
}

/** Shared resources only. The lifecycle workflow later creates one encrypted
 * data volume per computer and launches an instance only from an approved,
 * pinned host AMI under a generation-fenced placement. */
export class AppComputerFoundationStack extends Stack {
    constructor(scope: Construct, id: string, props: AppComputerFoundationProps) {
        super(scope, id, props);
        const config = FoundationConfigSchema.parse(props.config);
        if (props.env?.region !== config.region) throw new Error('stack region must equal the configured region');

        // L1 networking on purpose: the L2 Vpc places subnets by account-mapped
        // zone *names* (Fn::GetAZs / context lookups). A subnet here is pinned by
        // AvailabilityZoneId and nothing else.
        const vpc = new ec2.CfnVPC(this, 'ComputerVpc', {
            cidrBlock: '10.76.0.0/24', enableDnsHostnames: true, enableDnsSupport: true,
            tags: [{ key: 'Name', value: `ezil-app-computers-${config.stage}` }],
        });
        const gateway = new ec2.CfnInternetGateway(this, 'InternetGateway');
        const attachment = new ec2.CfnVPCGatewayAttachment(this, 'InternetGatewayAttachment', {
            vpcId: vpc.ref, internetGatewayId: gateway.ref,
        });
        const routes = new ec2.CfnRouteTable(this, 'PublicRoutes', { vpcId: vpc.ref });
        const defaultRoute = new ec2.CfnRoute(this, 'DefaultRoute', {
            routeTableId: routes.ref, destinationCidrBlock: '0.0.0.0/0', gatewayId: gateway.ref,
        });
        defaultRoute.addResourceDependency(attachment);
        // R6: a public subnet gives the outbound tunnel and developer egress a
        // path without a NAT gateway that bills while every computer is stopped.
        // No load balancer; the security group admits no inbound traffic.
        config.zoneIds.forEach((zoneId, index) => {
            const subnet = new ec2.CfnSubnet(this, `ComputerSubnet${index}`, {
                vpcId: vpc.ref, availabilityZoneId: zoneId, cidrBlock: `10.76.0.${index * 32}/27`,
                mapPublicIpOnLaunch: true,
                tags: [{ key: 'ezil:zone-id', value: zoneId }],
            });
            new ec2.CfnSubnetRouteTableAssociation(this, `ComputerSubnetRoutes${index}`, {
                subnetId: subnet.ref, routeTableId: routes.ref,
            });
            new CfnOutput(this, `SubnetId${index}`, { value: subnet.ref, description: `Public computer subnet in ${zoneId}` });
        });

        // R6: no inbound rules at all; all outbound for developer-desktop parity
        // (apt over 80, git over ssh). Egress is bounded by out-of-guest metering.
        const securityGroup = new ec2.CfnSecurityGroup(this, 'ComputerSecurityGroup', {
            vpcId: vpc.ref, groupDescription: 'EZiL application computers; no inbound connections',
            securityGroupIngress: [],
            securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0', description: 'All outbound (metered outside the guest)' }],
        });

        // The host AMI build pulls from this registry; hosts do not (R3: the
        // image is pre-pulled into the AMI), so no host credential is needed.
        const imageRepository = new ecr.Repository(this, 'ApplicationImages', {
            imageTagMutability: ecr.TagMutability.IMMUTABLE,
            imageScanOnPush: true,
            encryption: ecr.RepositoryEncryption.AES_256,
            removalPolicy: RemovalPolicy.RETAIN,
        });
        const cfnRepository = imageRepository.node.defaultChild;
        if (!(cfnRepository instanceof ecr.CfnRepository)) throw new Error('unexpected ECR construct');
        // L2 omits AES_256 because it is ECR's default. Keep the reviewed
        // CloudFormation artifact explicit about encryption at creation.
        cfnRepository.encryptionConfiguration = { encryptionType: 'AES256' };

        // R5: no instance role and no instance profile. See README "Host role".
        const hostAmi = new CfnParameter(this, 'HostAmiId', {
            type: 'AWS::EC2::Image::Id',
            description: 'Approved Linux/amd64 host AMI (OS plus pre-pulled desktop image)',
        });
        const launchTemplate = new ec2.CfnLaunchTemplate(this, 'ComputerLaunchTemplate', {
            launchTemplateName: `ezil-app-computer-${config.stage}`,
            // The template's own tag: the I5 execution role may change it only by this tag.
            tagSpecifications: [{ resourceType: 'launch-template', tags: [{ key: NAMESPACE_TAG, value: config.stage }] }],
            launchTemplateData: {
                imageId: hostAmi.valueAsString,
                instanceType: config.instanceType,
                securityGroupIds: [securityGroup.attrGroupId],
                ebsOptimized: true,
                monitoring: { enabled: false },
                // R9: a guest-initiated shutdown stops (never terminates).
                instanceInitiatedShutdownBehavior: 'stop',
                // R12: hibernation off.
                hibernationOptions: { configured: false },
                // R5: IMDSv2 only, hop limit 1, instance tags not exposed.
                metadataOptions: {
                    httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1, instanceMetadataTags: 'disabled',
                },
                blockDeviceMappings: [{
                    // R3: the root disk is disposable (OS + pre-pulled image) and
                    // encrypted. The retained data disk is created per computer
                    // by the lifecycle workflow, never by this template.
                    deviceName: config.rootDeviceName,
                    ebs: { volumeType: 'gp3', volumeSize: config.rootVolumeGiB, encrypted: true, deleteOnTermination: true },
                }],
                tagSpecifications: [{
                    resourceType: 'instance',
                    tags: [
                        { key: 'ezil:managed-by', value: 'app-computer-platform' },
                        { key: 'ezil:stage', value: config.stage },
                    ],
                }],
            },
        });

        new CfnOutput(this, 'VpcId', { value: vpc.ref });
        new CfnOutput(this, 'SecurityGroupId', { value: securityGroup.attrGroupId });
        new CfnOutput(this, 'LaunchTemplateId', { value: launchTemplate.ref });
        new CfnOutput(this, 'ApplicationImageRepositoryUri', { value: imageRepository.repositoryUri });
    }
}
