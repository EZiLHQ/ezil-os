import {
    CfnOutput, CfnParameter, RemovalPolicy, Stack, type StackProps,
    aws_ec2 as ec2, aws_ecr as ecr, aws_iam as iam,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface AppComputerFoundationProps extends StackProps {
    readonly stage: 'pilot' | 'production';
}

/** Shared resources only. The lifecycle controller later creates one encrypted
 * data volume per computer and may launch an instance only after it has an
 * approved, pinned supervisor AMI and a generation-fenced runtime record. */
export class AppComputerFoundationStack extends Stack {
    constructor(scope: Construct, id: string, props: AppComputerFoundationProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'ComputerVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.76.0.0/24'),
            maxAzs: 1,
            natGateways: 0,
            subnetConfiguration: [{
                name: 'computer-public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 27,
            }],
        });
        // A public subnet gives the outbound Tunnel, SSM, ECR, and TURN a
        // network path without a continuously billed NAT gateway. Security
        // groups admit no inbound traffic; app ports bind only to loopback or
        // private container networks. A pilot must validate TURN egress.
        const subnet = vpc.publicSubnets[0];
        if (!subnet) throw new Error('public computer subnet missing');
        const cfnSubnet = subnet.node.defaultChild;
        if (!(cfnSubnet instanceof ec2.CfnSubnet)) throw new Error('unexpected subnet construct');
        cfnSubnet.mapPublicIpOnLaunch = true;

        const securityGroup = new ec2.SecurityGroup(this, 'ComputerSecurityGroup', {
            vpc, description: 'EZiL application computers; no inbound connections',
            allowAllOutbound: false,
        });
        securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443),
            'Tunnel, ECR, SSM, and trusted HTTPS endpoints');
        securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(3478),
            'TURN media candidate for pilot validation');
        securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3478),
            'TURN TCP fallback candidate for pilot validation');
        // Service-level egress allowlists are enforced by the host supervisor,
        // not by this shared host security group.

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
        const instanceRole = new iam.Role(this, 'ComputerInstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            description: 'Host-only access for EZiL application computer supervisor',
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });
        imageRepository.grantPull(instanceRole);
        const instanceProfile = new iam.CfnInstanceProfile(this, 'ComputerInstanceProfile', {
            roles: [instanceRole.roleName],
        });

        // The controller supplies the exact AMI ID after it has been built,
        // reviewed and tested. An unpinned latest AMI lookup is not a release.
        const supervisorAmi = new CfnParameter(this, 'SupervisorAmiId', {
            type: 'AWS::EC2::Image::Id',
            description: 'Approved Linux/amd64 AMI containing the authenticated supervisor',
        });
        const launchTemplate = new ec2.CfnLaunchTemplate(this, 'ComputerLaunchTemplate', {
            launchTemplateName: `ezil-app-computer-${props.stage}`,
            launchTemplateData: {
                imageId: supervisorAmi.valueAsString,
                instanceType: 'm7i.large',
                securityGroupIds: [securityGroup.securityGroupId],
                iamInstanceProfile: { arn: instanceProfile.attrArn },
                ebsOptimized: true,
                monitoring: { enabled: false },
                metadataOptions: {
                    httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1,
                },
                blockDeviceMappings: [{
                    // The approved AMI must report this root device name.
                    deviceName: '/dev/xvda',
                    ebs: { volumeType: 'gp3', volumeSize: 30, encrypted: true, deleteOnTermination: true },
                }],
                tagSpecifications: [{
                    resourceType: 'instance',
                    tags: [
                        { key: 'ezil:managed-by', value: 'app-computer-platform' },
                        { key: 'ezil:stage', value: props.stage },
                    ],
                }],
            },
        });

        new CfnOutput(this, 'VpcId', { value: vpc.vpcId });
        new CfnOutput(this, 'SubnetId', { value: subnet.subnetId });
        new CfnOutput(this, 'SecurityGroupId', { value: securityGroup.securityGroupId });
        new CfnOutput(this, 'LaunchTemplateId', { value: launchTemplate.ref });
        new CfnOutput(this, 'ApplicationImageRepositoryUri', { value: imageRepository.repositoryUri });
        new CfnOutput(this, 'InstanceProfileArn', { value: instanceProfile.attrArn });
    }
}
