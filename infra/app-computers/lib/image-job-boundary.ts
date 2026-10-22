import { aws_iam as iam } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { LifecycleDeployment } from './lifecycle/deployment.js';
import { preparationStatements, dataKeyStatements, workflowLogActions } from './rebase-preparation.js';
import { boundaryStatements, compactStatements, type IdentityConfig } from './identity.js';

export const imageJobBoundaryArn = (account: string, namespace: string) =>
    `arn:aws:iam::${account}:policy/ezil/${namespace}/ezil-${namespace}-image-job-boundary`;
export const imageJobRoleArns = (account: string, namespace: string) =>
    ['rebase-preparation', 'recovery'].map(name => `arn:aws:iam::${account}:role/ezil/${namespace}/ezil-${namespace}-${name}`);

export const RESTORE_TAG_KEYS = ['ezil:managed-by', 'ezil:stage', 'ezil:computer-id', 'ezil:generation',
    'ezil:fence-token', 'ezil:backup', 'ezil:restored-from-snapshot', 'ezil:original-volume-id', 'ezil:recovery-job-id'] as const;
export function recoveryRestoreStatements(d: LifecycleDeployment): iam.PolicyStatement[] {
    const volume = `arn:aws:ec2:${d.region}:${d.accountId}:volume/*`;
    const request = { 'aws:RequestedRegion': d.region, 'aws:RequestTag/ezil:managed-by': 'app-computer-platform',
        'aws:RequestTag/ezil:stage': d.namespace, 'aws:RequestTag/ezil:backup': d.namespace };
    const tags = { Null: Object.fromEntries(['aws:TagKeys', ...RESTORE_TAG_KEYS.map(k => 'aws:RequestTag/' + k)].map(k => [k, 'false'])),
        'ForAllValues:StringEquals': { 'aws:TagKeys': [...RESTORE_TAG_KEYS] } };
    return [
        new iam.PolicyStatement({ actions: ['ec2:CreateVolume'], resources: [`arn:aws:ec2:${d.region}::snapshot/*`], conditions: {
            StringEquals: { 'aws:RequestedRegion': d.region, 'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform',
                'ec2:ResourceTag/ezil:stage': d.namespace, 'ec2:ResourceTag/ezil:purpose': 'pre-rebase' },
            Null: { 'aws:ResourceTag/ezil:preparation-job-id': 'false' } } }),
        new iam.PolicyStatement({ actions: ['ec2:CreateVolume'], resources: [volume], conditions: {
            StringEquals: { ...request, 'ec2:VolumeType': 'gp3', 'ec2:AvailabilityZoneId': d.zoneId },
            ArnEquals: { 'ec2:KmsKeyId': d.dataKeyArn }, Bool: { 'ec2:Encrypted': 'true' },
            NumericGreaterThanEquals: { 'ec2:VolumeSize': String(d.storage.dataMinGiB) },
            NumericLessThanEquals: { 'ec2:VolumeSize': String(d.storage.dataMaxGiB) },
            Null: { 'aws:RequestTag/ezil:computer-id': 'false' } } }),
        new iam.PolicyStatement({ actions: ['ec2:CreateTags'], resources: [volume], conditions: {
            StringEquals: { ...request, 'ec2:CreateAction': 'CreateVolume' }, ...tags } }),
        ...dataKeyStatements(d),
        new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['ec2:CreateTags'], resources: ['*'], conditions: {
            'ForAnyValue:StringEquals': { 'aws:TagKeys': [...RESTORE_TAG_KEYS] }, Null: { 'ec2:CreateAction': 'true' } } }),
    ];
}

/** Founder-owned ceiling. Data grants use the reviewed deployment; the
 * namespace-scoped history/invocation ceilings retain the existing boundary's
 * conditions. Execution roles still name their exact keys and observer versions. */
export function imageJobBoundaryStatements(c: IdentityConfig, d: LifecycleDeployment): iam.PolicyStatement[] {
    const shared = boundaryStatements(c);
    const preparation = preparationStatements({ deployment: d } as Parameters<typeof preparationStatements>[0]);
    const statements = compactStatements([
        ...shared.filter(s => s.effect === iam.Effect.DENY),
        ...shared.filter(s => s.effect === iam.Effect.ALLOW && s.actions.some(a => a === 'lambda:InvokeFunction' || a === 'kms:Encrypt')),
        new iam.PolicyStatement({ actions: workflowLogActions, resources: ['*'] }),
        // Recovery's historical grant intentionally has no computer/pool Null
        // condition. Preserve that effective allow set; its observer proves identity.
        new iam.PolicyStatement({ actions: ['ec2:StopInstances', 'ec2:TerminateInstances'],
            resources: [`arn:aws:ec2:${d.region}:${d.accountId}:instance/*`], conditions: { StringEquals: {
                'aws:RequestedRegion': d.region, 'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform', 'ec2:ResourceTag/ezil:stage': d.namespace } } }),
        ...preparation.filter(s => !s.actions.includes('ec2:StopInstances') && !s.actions.some(a => a.startsWith('kms:'))),
        ...recoveryRestoreStatements(d).filter(s => !s.actions.some(a => a.startsWith('kms:'))),
        new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['ec2:DetachVolume', 'ec2:DeleteTags',
            'ec2:ModifyInstanceMetadataOptions', 'ec2:CopySnapshot', 'ec2:ModifySnapshotAttribute',
            'ec2:ResetSnapshotAttribute'], resources: ['*'] }),
    ]);
    return compactImageStatements(statements);
}

/** Equivalent effective image-role permissions: StringEquals already requires presence. A
 * create-time tagging grant can share snapshot request conditions with
 * CreateSnapshot when an explicit Deny retains its CreateAction restriction.
 * The role policies remain in the contract's separate-row form. Attribute
 * denies are strengthened because neither execution role can use attributes. */
export function compactImageStatements(statements: iam.PolicyStatement[]): iam.PolicyStatement[] {
    const json = statements.map(s => s.toStatementJson());
    for (const s of json) {
        if (s.Effect === 'Deny' && ['ec2:DescribeInstanceAttribute', 'ec2:ModifyInstanceAttribute'].includes(s.Action)) { s.Resource = '*'; delete s.Condition; }
        for (const key of Object.keys(s.Condition?.StringEquals ?? {}))
            if (s.Condition?.Null?.[key] === 'false') delete s.Condition.Null[key];
        if (s.Condition?.Null && !Object.keys(s.Condition.Null).length) delete s.Condition.Null;
    }
    const snapshotTags = json.find(s => s.Effect === 'Allow' && s.Action === 'ec2:CreateTags' && String(s.Resource).includes('::snapshot/'));
    if (snapshotTags) {
        delete snapshotTags.Condition.StringEquals['ec2:CreateAction'];
        json.push({ Effect: 'Deny', Action: 'ec2:CreateTags', Resource: snapshotTags.Resource,
            Condition: { StringNotEquals: { 'ec2:CreateAction': 'CreateSnapshot' } } });
    }
    const immutable = json.filter(s => s.Effect === 'Deny' && s.Action === 'ec2:CreateTags' && s.Condition?.Null?.['ec2:CreateAction'] === 'true');
    const keys = [...new Set(immutable.flatMap(s => s.Condition['ForAnyValue:StringEquals']['aws:TagKeys']))];
    const filtered = json.filter(s => !immutable.includes(s));
    filtered.push({ Effect: 'Deny', Action: 'ec2:CreateTags', Resource: '*', Condition: {
        'ForAnyValue:StringEquals': { 'aws:TagKeys': keys }, Null: { 'ec2:CreateAction': 'true' } } });
    return compactStatements(filtered.map(s => iam.PolicyStatement.fromJson(s)));
}

export function applyImageJobBoundary(role: iam.Role, d: LifecycleDeployment) {
    iam.PermissionsBoundary.of(role).apply(iam.ManagedPolicy.fromManagedPolicyArn(role, 'ImageJobBoundary',
        imageJobBoundaryArn(d.accountId, d.namespace)));
}

export class ImageJobBoundary extends iam.ManagedPolicy {
    constructor(scope: Construct, c: IdentityConfig, deployment: LifecycleDeployment) {
        super(scope, 'ImageJobBoundary', { managedPolicyName: `ezil-${c.namespace}-image-job-boundary`,
            path: `/ezil/${c.namespace}/`, document: new iam.PolicyDocument({ statements: imageJobBoundaryStatements(c, deployment) }) });
    }
}
