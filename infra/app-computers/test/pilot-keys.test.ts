import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { App, BootstraplessSynthesizer, assertions } from 'aws-cdk-lib';
import { PilotKeysConfigSchema, PilotKeysStack } from '../lib/pilot-keys.js';
import { SettingsSchema } from '../lib/lifecycle/contract.js';
import { zoneIdPrefix } from '../lib/lifecycle/deployment.js';

const config = PilotKeysConfigSchema.parse(JSON.parse(readFileSync(join(__dirname, '../config/keys.example.json'), 'utf8')));
const env = { account: config.accountId, region: config.region };
const stack = new PilotKeysStack(new App({ autoSynth: false }), `ezil-${config.namespace}-keys`, {
    config, env, terminationProtection: true, synthesizer: new BootstraplessSynthesizer(),
});
const template = assertions.Template.fromStack(stack);
const resources = template.toJSON().Resources as Record<string, any>;
const keys = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::KMS::Key');
const [dataId, data] = keys.find(([id]) => id.startsWith('DataKey'))!;
const [authorityId, authority] = keys.find(([id]) => id.startsWith('AuthorityKey'))!;
const [secretId, secret] = Object.entries(resources).find(([, r]) => r.Type === 'AWS::SecretsManager::Secret')!;
const root = { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::${config.accountId}:root`]] } };

test('pilot keys: exactly two symmetric encryption keys with rotation enabled', () => {
    template.resourceCountIs('AWS::KMS::Key', 2);
    for (const [, key] of keys) {
        assert.equal(key.Properties.KeySpec, 'SYMMETRIC_DEFAULT');
        assert.equal(key.Properties.KeyUsage, 'ENCRYPT_DECRYPT');
        assert.equal(key.Properties.EnableKeyRotation, true);
    }
});

test('pilot keys: keys and secret retain on deletion/replacement and carry the namespace tag', () => {
    assert.equal(Object.keys(resources).length, 3);
    for (const resource of Object.values(resources)) {
        assert.equal(resource.DeletionPolicy, 'Retain');
        assert.equal(resource.UpdateReplacePolicy, 'Retain');
        assert.ok(resource.Properties.Tags.some((tag: any) => tag.Key === 'ezil:namespace' && tag.Value === config.namespace));
    }
});

test('pilot keys: AWS generates the authority value and encrypts it with AuthorityKey', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    assert.equal(secret.Properties.Name, `ezil/${config.namespace}/lifecycle-authority`);
    assert.deepEqual(secret.Properties.KmsKeyId, { 'Fn::GetAtt': [authorityId, 'Arn'] });
    assert.deepEqual(secret.Properties.GenerateSecretString, { PasswordLength: 64, ExcludePunctuation: true, ExcludeUppercase: true,
        IncludeSpace: false, ExcludeCharacters: 'ghijklmnopqrstuvwxyz' });
    // The generator's possible alphabet must be exactly lowercase hex: the lifecycle Lambda
    // (aws.ts) and the app authority route both refuse any other secret format.
    const g = secret.Properties.GenerateSecretString;
    const alphabet = [...'abcdefghijklmnopqrstuvwxyz', ...(g.ExcludeUppercase ? [] : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), ...'0123456789',
        ...(g.ExcludePunctuation ? [] : '!"#$%&()*+,-./:;<=>?@[]^_`{|}~'), ...(g.IncludeSpace ? [' '] : [])]
        .filter(ch => !(g.ExcludeCharacters ?? '').includes(ch));
    assert.equal(alphabet.join(''), 'abcdef0123456789');
    assert.equal(g.PasswordLength, 64);
    assert.doesNotMatch(JSON.stringify(template.toJSON()), /"SecretString"\s*:/);
    assert.deepEqual(template.toJSON().Outputs, {
        DataKeyArn: { Value: { 'Fn::GetAtt': [dataId, 'Arn'] } },
        AuthorityKeyArn: { Value: { 'Fn::GetAtt': [authorityId, 'Arn'] } },
        AuthoritySecretArn: { Value: { Ref: secretId } },
    });
});

test('pilot keys: generated secret ARN is accepted by the actual lifecycle contract', () => {
    const lifecycle = JSON.parse(readFileSync(join(__dirname, '../config/lifecycle.example.json'), 'utf8'));
    const arn = `arn:aws:secretsmanager:${config.region}:${config.accountId}:secret:${secret.Properties.Name}-AbCdEf`;
    const settings = { ...lifecycle.settings, authoritySecretArn: arn, deployment: {
        ...lifecycle.settings.deployment, ...config, zoneId: `${zoneIdPrefix(config.region)}-az1`,
        dataKeyArn: `arn:aws:kms:${config.region}:${config.accountId}:key/00000000-0000-4000-8000-000000000000`,
        stateMachineVersionArn: `arn:aws:states:${config.region}:${config.accountId}:stateMachine:ezil-${config.namespace}-lifecycle:1`,
    } };
    assert.equal(SettingsSchema.safeParse(settings).success, true);
    assert.equal(SettingsSchema.safeParse({ ...settings, authoritySecretArn: arn.slice(0, -1) }).success, false);
});

test('pilot keys: account root delegates to IAM; EBS usage and AWS resource grants use EC2 ViaService', () => {
    const admin = { Sid: 'EnableIAMUserPermissions', Effect: 'Allow', Principal: root, Action: 'kms:*', Resource: '*' };
    assert.deepEqual(authority.Properties.KeyPolicy.Statement, [admin]);
    const statements = data.Properties.KeyPolicy.Statement as any[];
    assert.equal(statements.length, 3);
    assert.deepEqual(statements[0], admin);
    const usage = statements.slice(1);
    for (const statement of usage) {
        assert.equal(statement.Effect, 'Allow');
        assert.deepEqual(statement.Principal, root);
        assert.equal(statement.Resource, '*');
        assert.deepEqual(statement.Condition.StringEquals, { 'kms:ViaService': `ec2.${config.region}.amazonaws.com` });
    }
    assert.deepEqual(usage[0].Action, ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey']);
    assert.deepEqual(usage[1].Action, ['kms:CreateGrant', 'kms:ListGrants', 'kms:RevokeGrant']);
    assert.deepEqual(usage[1].Condition.Bool, { 'kms:GrantIsForAWSResource': 'true' });
});

test('pilot keys: founder stack has no bootstrap dependency and rejects mismatched environments', () => {
    assert.equal(stack.stackName, 'ezil-pilot-keys');
    assert.equal(stack.terminationProtection, true);
    assert.doesNotMatch(JSON.stringify(template.toJSON()), /BootstrapVersion|AWS::IAM::/);
    for (const badEnv of [undefined, { ...env, account: '210987654321' }, { ...env, region: 'eu-west-2' }])
        assert.throws(() => new PilotKeysStack(new App(), 'Mismatch', { config, env: badEnv }), /env must equal/);
});

test('pilot keys: configuration accepts only namespace, accountId and commercial region', () => {
    for (const bad of [{ namespace: 'identity' }, { namespace: 'pilot-other' }, { accountId: '123' },
        { region: 'us-gov-west-1' }, { secretValue: 'must-not-be-configured' }])
        assert.equal(PilotKeysConfigSchema.safeParse({ ...config, ...bad }).success, false);
});
