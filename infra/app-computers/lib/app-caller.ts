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
    if (p.name === 'github') {
        if (p.issuerHost !== GITHUB_ISSUER) ctx.addIssue({ code: 'custom', message: 'github_issuer' });
        if (p.audience !== 'sts.amazonaws.com') ctx.addIssue({ code: 'custom', message: 'github_audience' });
        return;
    }
    // Vercel (docs: vercel.com/docs/oidc/reference, /docs/oidc/aws):
    //   issuer   https://oidc.vercel.com/<team> (team mode) or https://oidc.vercel.com (global)
    //   aud      https://vercel.com/<team> (default) or a custom audience such as sts.amazonaws.com
    //   sub      owner:<team>:project:<project>:environment:<environment>
    const issuer = VERCEL_ISSUER.exec(p.issuerHost), sub = VERCEL_SUBJECT.exec(p.subject);
    if (!issuer) { ctx.addIssue({ code: 'custom', message: 'vercel_issuer' }); return; }
    if (!sub) { ctx.addIssue({ code: 'custom', message: 'vercel_subject' }); return; }
    const [, issuerTeam] = issuer, [, team, , environment] = sub;
    if (issuerTeam !== undefined && issuerTeam !== team) ctx.addIssue({ code: 'custom', message: 'vercel_team_mismatch' });
    if (p.audience !== `https://vercel.com/${team}` && p.audience !== 'sts.amazonaws.com') ctx.addIssue({ code: 'custom', message: 'vercel_audience' });
    // `development` tokens are issued to individual users' machines (12 h): never a production caller.
    if (environment === 'development') ctx.addIssue({ code: 'custom', message: 'vercel_development_refused' });
});
const GITHUB_ISSUER = 'token.actions.githubusercontent.com';
const VERCEL_ISSUER = /^oidc\.vercel\.com(?:\/([a-z0-9][a-z0-9-]{0,99}))?$/;
const VERCEL_SUBJECT = /^owner:([a-z0-9][a-z0-9-]{0,99}):project:([a-z0-9][a-z0-9._-]{0,99}):environment:([a-z0-9][a-z0-9-]{0,99})$/;
/** R7 app identity (I5 partial). Disabled by default. One role per lifecycle
 * stack (one region, one namespace); each provider entry trusts ONE exact
 * subject, so production and preview never share a role.
 * - GitHub: issuer token.actions.githubusercontent.com, audience
 *   sts.amazonaws.com, subject in the immutable-ID form, e.g.
 *   `repo:<org>@<orgId>/<repo>@<repoId>:environment:<env>`.
 * - Vercel (the app's runtime): issuer `oidc.vercel.com/<team>` (team issuer
 *   mode; `oidc.vercel.com` in global mode), audience `https://vercel.com/<team>`,
 *   subject `owner:<team>:project:<project>:environment:production`. The IAM
 *   OIDC provider for that issuer is created by the founder (the boundary
 *   denies identity-provider writes to CI). */
export const AppCallerConfigSchema = z.object({
    enabled: z.boolean().default(false),
    roleName: z.string().regex(/^[A-Za-z0-9+=,.@_-]{1,64}$/).optional(),
    providers: z.array(ProviderSchema).max(2).default([]),
    // Exact IAM role ARNs only; never account root, STS sessions, or wildcards.
    ec2CallerRoleArns: z.array(z.string().regex(/^arn:aws:iam::\d{12}:role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]{1,64}$/))
        .max(10).refine(v => new Set(v).size === v.length, { message: 'duplicate_ec2_caller' }).optional(),
}).strict().superRefine((c, ctx) => {
    if (c.enabled && c.providers.length === 0) ctx.addIssue({ code: 'custom', message: 'enabled_without_provider' });
    if (new Set(c.providers.map(p => p.name)).size !== c.providers.length) ctx.addIssue({ code: 'custom', message: 'duplicate_provider' });
});
export type AppCallerConfig = z.infer<typeof AppCallerConfigSchema>;

/** `states:StartExecution` of exactly these VERSION ARNs. Step Functions authorizes a
 * version (or alias) call against the UNQUALIFIED state machine ARN, so a version ARN
 * as the resource never matches (live AccessDenied, ezil-mum 2026-10-21). The version is
 * pinned with `states:StateMachineQualifier`, which an unqualified call does not carry,
 * so the unqualified (latest revision) start stays denied. */
export function startVersionStatements(versionArns: string[]): iam.PolicyStatement[] {
    return versionArns.map(v => {
        const m = /^(arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}):([1-9][0-9]*)$/.exec(v);
        if (!m) throw new Error('invalid_version_arn');
        return new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [m[1]!],
            conditions: { StringEquals: { 'states:StateMachineQualifier': m[2]! } } });
    });
}

/** The policy of the app caller, exported for exact-equality tests:
 * - start only the exact lifecycle VERSION(s), all in `region`;
 * - describe only the `computer-*` executions of those state machines, and decrypt
 *   their execution data with the lifecycle history key, via Step Functions only;
 * - read-only EC2 describes for enrollment's live check, in `region` only
 *   (DescribeInstances/Volumes/AvailabilityZones support no resource scoping). */
export function appCallerStatements(region: string, versionArns: string[], historyKeyArn: string): iam.PolicyStatement[] {
    const executions: string[] = [], machines: string[] = [];
    for (const v of versionArns) {
        const m = /^arn:aws:states:([a-z0-9-]+):(\d{12}):stateMachine:([A-Za-z0-9_-]{1,80}):[1-9][0-9]*$/.exec(v);
        if (!m) throw new Error('invalid_version_arn');
        if (m[1] !== region) throw new Error('version_arn_region');
        const execution = `arn:aws:states:${m[1]}:${m[2]}:execution:${m[3]}:computer-*`;
        if (!executions.includes(execution)) executions.push(execution);
        // The encryption context names the state machine; list the version too so either form matches.
        for (const machine of [`arn:aws:states:${m[1]}:${m[2]}:stateMachine:${m[3]}`, v]) if (!machines.includes(machine)) machines.push(machine);
    }
    return [
        ...startVersionStatements(versionArns),
        new iam.PolicyStatement({ actions: ['states:DescribeExecution'], resources: executions }),
        // The lifecycle machine encrypts execution data with its customer-managed history key, and
        // DescribeExecution then needs kms:Decrypt by the CALLER (Step Functions encryption-at-rest
        // docs). Only that key, only through Step Functions, only for these machines.
        new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [historyKeyArn],
            conditions: { StringEquals: { 'kms:ViaService': `states.${region}.amazonaws.com`,
                'kms:EncryptionContext:aws:states:stateMachineArn': machines } } }),
        new iam.PolicyStatement({ actions: ['ec2:DescribeInstances', 'ec2:DescribeVolumes', 'ec2:DescribeAvailabilityZones'], resources: ['*'],
            conditions: { StringEquals: { 'aws:RequestedRegion': region } } }),
    ];
}
export function appCallerTrust(p: z.infer<typeof ProviderSchema>): iam.PolicyStatement {
    return new iam.PolicyStatement({ actions: ['sts:AssumeRoleWithWebIdentity'], principals: [new iam.FederatedPrincipal(p.providerArn)],
        conditions: { StringEquals: { [`${p.issuerHost}:aud`]: p.audience, [`${p.issuerHost}:sub`]: p.subject } } });
}

export class AppCaller extends Construct {
    readonly role: iam.Role;
    constructor(scope: Construct, id: string, props: { config: AppCallerConfig; region: string; versionArns: string[]; historyKeyArn: string; ec2CallerRoleArns?: string[] }) {
        super(scope, id);
        const config = AppCallerConfigSchema.parse({ ...props.config,
            ec2CallerRoleArns: props.ec2CallerRoleArns ?? props.config.ec2CallerRoleArns });
        if (!config.enabled) throw new Error('app caller is disabled');
        const [first, ...rest] = config.providers;
        this.role = new iam.Role(this, 'Role', { ...(config.roleName ? { roleName: config.roleName } : {}),
            description: 'EZiL app: start exact lifecycle versions, read their computer executions, describe EC2',
            assumedBy: new iam.FederatedPrincipal(first!.providerArn, appCallerTrust(first!).conditions, 'sts:AssumeRoleWithWebIdentity') });
        for (const p of rest) this.role.assumeRolePolicy!.addStatements(appCallerTrust(p));
        for (const arn of config.ec2CallerRoleArns ?? []) {
            this.role.assumeRolePolicy!.addStatements(new iam.PolicyStatement({
                actions: ['sts:AssumeRole'], principals: [new iam.ArnPrincipal(arn)],
                conditions: { StringEquals: { 'aws:PrincipalTag/ezil:env': 'billing-staging' } },
            }));
        }
        for (const s of appCallerStatements(props.region, props.versionArns, props.historyKeyArn)) this.role.addToPolicy(s);
        new CfnOutput(this, 'RoleArn', { value: this.role.roleArn });
    }
}
