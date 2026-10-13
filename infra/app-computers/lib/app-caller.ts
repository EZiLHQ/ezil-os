import { CfnOutput, aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { z } from 'zod';

/** One OIDC issuer the app runs under. The subject is matched exactly
 * (StringEquals), so it must not contain IAM wildcards. */
const ProviderSchema = z.object({
    name: z.enum(['github', 'vercel']),
    providerArn: z.string().regex(/^arn:aws:iam::\d{12}:oidc-provider\/[A-Za-z0-9._/-]{1,200}$/),
    issuerHost: z.string().regex(/^[a-z0-9.-]+(?:\/[A-Za-z0-9._-]+)*$/),
    audience: z.string().min(1).max(256),
    subject: z.string().min(1).max(256).refine(v => !/[*?]/.test(v), { message: 'subject_must_be_exact' }),
}).strict().superRefine((p, ctx) => {
    if (!p.providerArn.endsWith(`:oidc-provider/${p.issuerHost}`)) ctx.addIssue({ code: 'custom', message: 'provider_issuer_mismatch' });
});
/** R7 app identity (I5 partial). Disabled by default.
 * GitHub: issuer token.actions.githubusercontent.com, audience sts.amazonaws.com,
 * subject in the immutable-ID form, e.g.
 * `repo:<org>@<orgId>/<repo>@<repoId>:environment:<env>`.
 * Vercel: a separate provider (issuer oidc.vercel.com/<team>); TODO confirm
 * the team's audience and subject format before enabling it. */
export const AppCallerConfigSchema = z.object({
    enabled: z.boolean().default(false),
    roleName: z.string().regex(/^[A-Za-z0-9+=,.@_-]{1,64}$/).optional(),
    providers: z.array(ProviderSchema).max(2).default([]),
}).strict().superRefine((c, ctx) => {
    if (c.enabled && c.providers.length === 0) ctx.addIssue({ code: 'custom', message: 'enabled_without_provider' });
    if (new Set(c.providers.map(p => p.name)).size !== c.providers.length) ctx.addIssue({ code: 'custom', message: 'duplicate_provider' });
});
export type AppCallerConfig = z.infer<typeof AppCallerConfigSchema>;

/** The policy of the app caller: start only the exact lifecycle version(s);
 * describe EC2 in the configured region. Exported for exact-equality tests. */
export function appCallerStatements(region: string, versionArns: string[]): iam.PolicyStatement[] {
    for (const v of versionArns) if (!/^arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$/.test(v)) throw new Error('invalid_version_arn');
    return [
        new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [...versionArns] }),
        new iam.PolicyStatement({ actions: ['ec2:Describe*'], resources: ['*'], conditions: { StringEquals: { 'aws:RequestedRegion': region } } }),
    ];
}
export function appCallerTrust(p: z.infer<typeof ProviderSchema>): iam.PolicyStatement {
    return new iam.PolicyStatement({ actions: ['sts:AssumeRoleWithWebIdentity'], principals: [new iam.FederatedPrincipal(p.providerArn)],
        conditions: { StringEquals: { [`${p.issuerHost}:aud`]: p.audience, [`${p.issuerHost}:sub`]: p.subject } } });
}

export class AppCaller extends Construct {
    readonly role: iam.Role;
    constructor(scope: Construct, id: string, props: { config: AppCallerConfig; region: string; versionArns: string[] }) {
        super(scope, id);
        const config = AppCallerConfigSchema.parse(props.config);
        if (!config.enabled) throw new Error('app caller is disabled');
        const [first, ...rest] = config.providers;
        this.role = new iam.Role(this, 'Role', { ...(config.roleName ? { roleName: config.roleName } : {}),
            description: 'EZiL app: start exact lifecycle versions and describe EC2 only',
            assumedBy: new iam.FederatedPrincipal(first!.providerArn, appCallerTrust(first!).conditions, 'sts:AssumeRoleWithWebIdentity') });
        for (const p of rest) this.role.assumeRolePolicy!.addStatements(appCallerTrust(p));
        for (const s of appCallerStatements(props.region, props.versionArns)) this.role.addToPolicy(s);
        new CfnOutput(this, 'RoleArn', { value: this.role.roleArn });
    }
}
