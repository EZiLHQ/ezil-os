import { CfnOutput, RemovalPolicy, Stack, Tags, type StackProps, aws_iam as iam,
    aws_kms as kms, aws_secretsmanager as secretsmanager } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { z } from 'zod';
import { NAMESPACE_TAG } from './identity.js';
import { NamespaceSchema, REGION_PATTERN } from './lifecycle/deployment.js';

export const PilotKeysConfigSchema = z.object({
    namespace: NamespaceSchema,
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(REGION_PATTERN),
}).strict();
export type PilotKeysConfig = z.infer<typeof PilotKeysConfigSchema>;

/** Founder-owned prerequisites for the lifecycle stack. No roles or assets. */
export class PilotKeysStack extends Stack {
    readonly dataKey: kms.Key;
    readonly authorityKey: kms.Key;
    readonly authoritySecret: secretsmanager.CfnSecret;

    constructor(scope: Construct, id: string, props: StackProps & { config: PilotKeysConfig }) {
        super(scope, id, props);
        const c = PilotKeysConfigSchema.parse(props.config);
        if (props.env?.region !== c.region || props.env?.account !== c.accountId)
            throw new Error('stack env must equal the keys config');
        Tags.of(this).add(NAMESPACE_TAG, c.namespace);

        // The account principal enables IAM delegation, including administration.
        // Lifecycle roles still need their own IAM allows and namespace boundary.
        const account = new iam.AccountPrincipal(c.accountId);
        const rootPolicy = () => new iam.PolicyStatement({ sid: 'EnableIAMUserPermissions',
            principals: [account], actions: ['kms:*'], resources: ['*'] });
        const viaEc2 = { StringEquals: { 'kms:ViaService': `ec2.${c.region}.amazonaws.com` } };
        this.dataKey = new kms.Key(this, 'DataKey', {
            keySpec: kms.KeySpec.SYMMETRIC_DEFAULT, keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
            enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN,
            policy: new iam.PolicyDocument({ statements: [
                rootPolicy(),
                new iam.PolicyStatement({ sid: 'AllowEBSUsage', principals: [account], resources: ['*'],
                    actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
                    conditions: viaEc2 }),
                new iam.PolicyStatement({ sid: 'AllowEBSGrants', principals: [account], resources: ['*'],
                    actions: ['kms:CreateGrant', 'kms:ListGrants', 'kms:RevokeGrant'],
                    conditions: { ...viaEc2, Bool: { 'kms:GrantIsForAWSResource': 'true' } } }),
            ] }),
        });
        this.authorityKey = new kms.Key(this, 'AuthorityKey', {
            keySpec: kms.KeySpec.SYMMETRIC_DEFAULT, keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
            enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN,
            policy: new iam.PolicyDocument({ statements: [rootPolicy()] }),
        });
        // L1 keeps AuthorityKey's policy root-only; the L2 Secret adds service
        // statements to its key policy even though IAM delegation suffices.
        this.authoritySecret = new secretsmanager.CfnSecret(this, 'AuthoritySecret', {
            name: `ezil/${c.namespace}/lifecycle-authority`, kmsKeyId: this.authorityKey.keyArn,
            // The lifecycle Lambda and the app both require exactly 64 lowercase hex chars
            // (a 32-byte HMAC key, hex-decoded): only 0-9 and a-f may be generated.
            generateSecretString: { passwordLength: 64, excludePunctuation: true, excludeUppercase: true, includeSpace: false,
                excludeCharacters: 'ghijklmnopqrstuvwxyz' },
        });
        this.authoritySecret.applyRemovalPolicy(RemovalPolicy.RETAIN);

        new CfnOutput(this, 'DataKeyArn', { value: this.dataKey.keyArn });
        new CfnOutput(this, 'AuthorityKeyArn', { value: this.authorityKey.keyArn });
        new CfnOutput(this, 'AuthoritySecretArn', { value: this.authoritySecret.ref });
    }
}
