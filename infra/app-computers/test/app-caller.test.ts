import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { AppCaller, AppCallerConfigSchema } from '../lib/app-caller.js';

const account = '123456789012';
const roleArn = `arn:aws:iam::${account}:role/ezil-os-staging-host`;
const provider = { name: 'vercel' as const, providerArn: `arn:aws:iam::${account}:oidc-provider/oidc.vercel.com/ezil-team`,
    issuerHost: 'oidc.vercel.com/ezil-team', audience: 'https://vercel.com/ezil-team',
    subject: 'owner:ezil-team:project:ezil-os:environment:production' };
function template(ec2CallerRoleArns?: string[], directProp = false) {
    const stack = new Stack(new App(), 'Caller', { env: { account, region: 'ap-south-1' } });
    new AppCaller(stack, 'AppCaller', {
        config: AppCallerConfigSchema.parse({ enabled: true, providers: [provider], ...(!directProp && ec2CallerRoleArns ? { ec2CallerRoleArns } : {}) }),
        ...(directProp ? { ec2CallerRoleArns } : {}),
        region: 'ap-south-1', versionArns: [`arn:aws:states:ap-south-1:${account}:stateMachine:ezil-pilot-lifecycle:1`],
        historyKeyArn: `arn:aws:kms:ap-south-1:${account}:key/33333333-3333-4333-8333-333333333333`,
    });
    return assertions.Template.fromStack(stack).toJSON();
}
function trust(t: any) {
    return (Object.values(t.Resources) as any[]).find(r => r.Type === 'AWS::IAM::Role').Properties.AssumeRolePolicyDocument.Statement;
}
test('EC2 callers are optional, exact and tag conditioned; OIDC and permissions remain unchanged', () => {
    const absent = template(), empty = template([]), enabled = template([roleArn]);
    assert.deepEqual(absent, empty);
    assert.deepEqual(template([roleArn], true), enabled);
    assert.equal(trust(absent).length, 1);
    assert.equal(trust(absent)[0].Action, 'sts:AssumeRoleWithWebIdentity');
    assert.deepEqual(trust(enabled), [...trust(absent), {
        Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: roleArn },
        Condition: { StringEquals: { 'aws:PrincipalTag/ezil:env': 'billing-staging' } },
    }]);
    const multiple = trust(template([roleArn, `${roleArn}-second`]));
    assert.deepEqual([multiple[1].Principal.AWS, multiple[2].Principal.AWS].flat(), [roleArn, `${roleArn}-second`]);
    const actual = { oidcOnly: absent, withEc2Caller: enabled };
    const file = join(__dirname, '__snapshots__', 'app-caller.json');
    if (process.env.UPDATE_APP_CALLER_SNAPSHOT === '1') writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')));
});
const prodRole = `arn:aws:iam::${account}:role/ezil-os-prod-host-InstanceRole-example`;
function caller(config: Record<string, unknown>, ec2CallerRoleArns?: string[]) {
    const stack = new Stack(new App(), 'Caller', { env: { account, region: 'ap-south-1' } });
    new AppCaller(stack, 'AppCaller', { config: AppCallerConfigSchema.parse({ enabled: true, ...config }), ec2CallerRoleArns,
        region: 'ap-south-1', versionArns: [`arn:aws:states:ap-south-1:${account}:stateMachine:ezil-prd-lifecycle:1`],
        historyKeyArn: `arn:aws:kms:ap-south-1:${account}:key/33333333-3333-4333-8333-333333333333` });
    return assertions.Template.fromStack(stack).toJSON();
}
const policy = (t: any) => (Object.values(t.Resources) as any[]).filter(r => r.Type === 'AWS::IAM::Policy');
test('an EC2-only caller trusts exactly one instance role under its environment tag, with unchanged permissions', () => {
    const production = caller({ providers: [], ec2CallerRoleArns: [prodRole], ec2CallerEnv: 'production' });
    assert.deepEqual(trust(production), [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: prodRole },
        Condition: { StringEquals: { 'aws:PrincipalTag/ezil:env': 'production' } } }]);
    assert.doesNotMatch(JSON.stringify(trust(production)), /Federated|WebIdentity|billing-staging/);
    // Same grants as an OIDC caller of the same version: only the trust differs.
    assert.deepEqual(policy(production), policy(caller({ providers: [provider] })));
    assert.equal(policy(production).length, 1);
    // The tag defaults to staging's, so existing configs keep their exact trust.
    assert.deepEqual(trust(caller({ ec2CallerRoleArns: [roleArn] })), [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: roleArn },
        Condition: { StringEquals: { 'aws:PrincipalTag/ezil:env': 'billing-staging' } } }]);
});
test('EC2-only and production callers fail closed', () => {
    const refused: [string, Record<string, unknown>][] = [
        ['no caller at all', { providers: [], ec2CallerRoleArns: [] }],
        ['no caller list', { providers: [] }],
        ['two EC2 roles without a provider', { ec2CallerRoleArns: [roleArn, prodRole] }],
        ['production caller with an OIDC provider', { providers: [provider], ec2CallerRoleArns: [prodRole], ec2CallerEnv: 'production' }],
        ['production caller with only an OIDC provider', { providers: [provider], ec2CallerEnv: 'production' }],
        ['unknown environment tag', { ec2CallerRoleArns: [prodRole], ec2CallerEnv: 'prod' }],
    ];
    for (const [why, config] of refused) assert.equal(AppCallerConfigSchema.safeParse({ enabled: true, ...config }).success, false, why);
    // The constructor re-checks a caller list passed directly.
    assert.throws(() => caller({ ec2CallerRoleArns: [prodRole] }, [roleArn, prodRole]), /ec2_only_caller_must_be_one_role/);
    // A staging trust (provider plus EC2 roles) keeps its shape and default tag.
    assert.equal(AppCallerConfigSchema.parse({ enabled: true, providers: [provider], ec2CallerRoleArns: [roleArn, prodRole] }).ec2CallerEnv, 'billing-staging');
});
test('EC2 trust refuses wildcard, root, STS session, malformed and duplicate role ARNs', () => {
    for (const arns of [['*'], [`${roleArn}*`], [`${roleArn}?`], [`arn:aws:iam::${account}:root`],
        [`arn:aws:sts::${account}:assumed-role/staging/session`], ['role/staging'], [`${roleArn}/`], [`arn:aws:iam::${account}:role/`], [roleArn, roleArn]]) {
        assert.equal(AppCallerConfigSchema.safeParse({ enabled: true, providers: [provider], ec2CallerRoleArns: arns }).success, false);
    }
});
