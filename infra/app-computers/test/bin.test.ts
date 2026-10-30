import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** Runs a bin entrypoint exactly as `cdk synth` would (CDK_OUTDIR set, so the
 * App synthesizes on exit), fully offline, and returns its templates. */
const root = join(__dirname, '..');
const offline = { AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' };
function synth(bin: string, env: Record<string, string>) {
    const out = mkdtempSync(join(tmpdir(), 'ezil-bin-'));
    try {
        const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_') && !k.startsWith('EZIL_')));
        // File-backed output also works in sandboxes that reject child-process pipes.
        const logPath = join(out, 'synth.log'), log = openSync(logPath, 'w');
        try {
            execFileSync(process.execPath, ['--import', 'tsx', bin], { cwd: root, stdio: ['ignore', log, log], env: { ...clean, ...offline, ...env, CDK_OUTDIR: out } });
        } catch (cause) {
            throw new Error(`${bin} synthesis failed:\n${readFileSync(logPath, 'utf8')}`, { cause });
        } finally { closeSync(log); }
        const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
        const stacks = Object.entries(manifest.artifacts as Record<string, any>).filter(([, a]) => a.type === 'aws:cloudformation:stack');
        return Object.fromEntries(stacks.map(([name, a]) => [name, { stackName: a.properties.stackName ?? name, terminationProtection: a.properties.terminationProtection, template: JSON.parse(readFileSync(join(out, a.properties.templateFile), 'utf8')),
            assets: (a.dependencies ?? []).filter((d: string) => d.endsWith('.assets')).map((d: string) =>
                JSON.parse(readFileSync(join(out, manifest.artifacts[d].properties.file), 'utf8'))) }]));
    } finally { rmSync(out, { recursive: true, force: true }); }
}
const roles = (t: any) => Object.values(t.Resources as Record<string, any>).filter(r => r.Type === 'AWS::IAM::Role');
const BOUNDARY = 'arn:aws:iam::123456789012:policy/ezil/identity/ezil-pilot-boundary';

test('bin/lifecycle applies the workload identity: path, boundary, namespace tag, identity bucket, no bootstrap', () => {
    const stacks = synth('bin/lifecycle.ts', { EZIL_LIFECYCLE_CONFIG: 'config/lifecycle.example.json' });
    assert.deepEqual(Object.keys(stacks), ['ezil-pilot-lifecycle']);
    const { template, assets } = stacks['ezil-pilot-lifecycle']!;
    assert.ok(roles(template).length >= 5);
    for (const r of roles(template)) { assert.equal(r.Properties.Path, '/ezil/pilot/'); assert.equal(r.Properties.PermissionsBoundary, BOUNDARY); }
    for (const k of Object.values(template.Resources as Record<string, any>).filter(r => r.Type === 'AWS::KMS::Key'))
        assert.ok(k.Properties.Tags.some((t: any) => t.Key === 'ezil:namespace' && t.Value === 'pilot'));
    assert.ok(!JSON.stringify(template).includes('BootstrapVersion'));
    const destinations = assets.flatMap((m: any) => Object.values(m.files).flatMap((f: any) => Object.values(f.destinations)));
    assert.ok(destinations.length >= 2);
    for (const d of destinations as any[]) { assert.equal(d.bucketName, 'ezil-pilot-deploy-assets-123456789012'); assert.match(d.objectKey, /^assets\//);
        assert.equal(d.assumeRoleArn, undefined, 'no bootstrap publishing role'); }
});
for (const stage of ['pilot', 'production', 'mum']) test(`bin/main foundation: ${stage} names, resource tags and termination protection`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezil-foundation-config-'));
    try {
        const config = JSON.parse(readFileSync(join(root, 'config/foundation.example.json'), 'utf8'));
        const path = join(dir, 'foundation.json');
        writeFileSync(path, JSON.stringify({ ...config, stage }));
        const stacks = synth('bin/main.ts', { EZIL_FOUNDATION_CONFIG: path });
        assert.deepEqual(Object.keys(stacks), [`ezil-${stage}-foundation`]);
        const { stackName, template, terminationProtection, assets } = stacks[`ezil-${stage}-foundation`]!;
        assert.equal(stackName, `ezil-${stage}-foundation`);
        assert.equal(terminationProtection, stage === 'production');
        assert.deepEqual(assets, []);
        assert.ok(!JSON.stringify(template).includes('BootstrapVersion'));
        // These three CloudFormation resource types do not support tags.
        const untaggable = new Set(['AWS::EC2::VPCGatewayAttachment', 'AWS::EC2::Route', 'AWS::EC2::SubnetRouteTableAssociation']);
        for (const [id, resource] of Object.entries(template.Resources as Record<string, any>)) {
            if (untaggable.has(resource.Type)) continue;
            const tags = resource.Type === 'AWS::EC2::LaunchTemplate'
                ? resource.Properties.TagSpecifications.find((s: any) => s.ResourceType === 'launch-template')?.Tags
                : resource.Properties.Tags;
            assert.deepEqual(tags?.filter((t: any) => t.Key === 'ezil:namespace'),
                [{ Key: 'ezil:namespace', Value: stage }], `${id} (${resource.Type}) namespace tag`);
        }
        const resources = Object.values(template.Resources as Record<string, any>);
        const vpc = resources.find(r => r.Type === 'AWS::EC2::VPC');
        assert.deepEqual(vpc.Properties.Tags.filter((t: any) => t.Key === 'Name'),
            [{ Key: 'Name', Value: `ezil-app-computers-${stage}` }]);
        const launchTemplate = resources.find(r => r.Type === 'AWS::EC2::LaunchTemplate');
        assert.equal(launchTemplate.Properties.LaunchTemplateName, `ezil-app-computer-${stage}`);
        const instanceTags = launchTemplate.Properties.LaunchTemplateData.TagSpecifications.find((s: any) => s.ResourceType === 'instance').Tags;
        assert.deepEqual(instanceTags.filter((t: any) => t.Key === 'ezil:stage'), [{ Key: 'ezil:stage', Value: stage }]);
        if (stage === 'pilot' || stage === 'production') {
            // Captured from HEAD before broadening foundation stage validation.
            const snapshots = JSON.parse(readFileSync(join(__dirname, '__snapshots__/foundation.json'), 'utf8'));
            assert.deepEqual({ terminationProtection, template }, snapshots[stage]);
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('bin/identity and bin/ops synthesize without bootstrap under their fixed names', () => {
    const identity = synth('bin/identity.ts', { EZIL_IDENTITY_CONFIG: 'config/identity.example.json' })['ezil-identity-pilot']!.template;
    assert.deepEqual(roles(identity).map(r => r.Properties.RoleName).sort(), ['ezil-pilot-cfn-exec', 'ezil-pilot-deploy']);
    const ops = synth('bin/ops.ts', { EZIL_OPS_CONFIG: 'config/ops.example.json' })['ezil-pilot-ops']!.template;
    assert.equal(roles(ops).length, 0);
    for (const t of [identity, ops]) assert.ok(!JSON.stringify(t).includes('BootstrapVersion'));
});
test('bin/ami is a protected founder stack with no assets, bootstrap or workload boundary', () => {
    const stacks = synth('bin/ami.ts', { EZIL_AMI_CONFIG: 'config/ami.example.json' });
    assert.deepEqual(Object.keys(stacks), ['ezil-pilot-ami']);
    const { template, assets, terminationProtection } = stacks['ezil-pilot-ami']!;
    assert.equal(terminationProtection, true);
    assert.deepEqual(assets, []);
    assert.equal(roles(template).length, 1);
    assert.equal(roles(template)[0].Properties.Path, '/ezil/pilot/');
    assert.equal(roles(template)[0].Properties.PermissionsBoundary, undefined);
    assert.ok(!JSON.stringify(template).includes('BootstrapVersion'));
});
test('bin entrypoints refuse to run without a config', () => {
    for (const bin of ['bin/main.ts', 'bin/lifecycle.ts', 'bin/identity.ts', 'bin/ops.ts', 'bin/ami.ts']) assert.throws(() => synth(bin, {}), bin);
});

test('bin/lifecycle passes the optional exact EC2 caller list from deployment config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezil-ec2-caller-config-'));
    try {
        const config = JSON.parse(readFileSync(join(root, 'config/lifecycle.example.json'), 'utf8'));
        const arn = 'arn:aws:iam::123456789012:role/ezil-os-staging-host';
        config.appCaller.enabled = true;
        config.appCaller.providers = config.appCaller.providers.filter((p: any) => p.name === 'vercel');
        config.appCaller.ec2CallerRoleArns = [arn];
        const path = join(dir, 'lifecycle.json');
        writeFileSync(path, JSON.stringify(config));
        const { template } = synth('bin/lifecycle.ts', { EZIL_LIFECYCLE_CONFIG: path })['ezil-pilot-lifecycle']!;
        const caller = roles(template).find(r => r.Properties.AssumeRolePolicyDocument.Statement.some((s: any) => s.Action === 'sts:AssumeRoleWithWebIdentity'));
        const statements = caller!.Properties.AssumeRolePolicyDocument.Statement;
        assert.equal(statements.length, 2);
        assert.deepEqual(statements[1], { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: arn },
            Condition: { StringEquals: { 'aws:PrincipalTag/ezil:env': 'billing-staging' } } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bin/lifecycle prd: the production host alone trusts ezil-prd-app-caller at the fixed /ezil/prd/ ARN', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezil-prd-caller-config-'));
    try {
        // The founder's prd shape (PROD-COMPUTERS-PLAN P7) on the example's placeholder account.
        const text = readFileSync(join(root, 'config/lifecycle.example.json'), 'utf8').replace(/pilot/g, 'prd');
        const config = JSON.parse(text), host = 'arn:aws:iam::123456789012:role/ezil-os-prod-host-InstanceRole-example';
        config.settings.authorityOrigin = 'https://os-prod.ezil.work';
        config.appCaller = { enabled: true, roleName: 'ezil-prd-app-caller', providers: [], ec2CallerRoleArns: [host], ec2CallerEnv: 'production' };
        const path = join(dir, 'lifecycle.json');
        writeFileSync(path, JSON.stringify(config));
        const stacks = synth('bin/lifecycle.ts', { EZIL_LIFECYCLE_CONFIG: path });
        assert.deepEqual(Object.keys(stacks), ['ezil-prd-lifecycle']);
        const { template } = stacks['ezil-prd-lifecycle']!;
        const caller = roles(template).filter(r => r.Properties.RoleName === 'ezil-prd-app-caller');
        assert.equal(caller.length, 1);
        // Path + name are what deploy/aws/os-staging/app-host.yaml pins for production:
        // arn:aws:iam::<account>:role/ezil/prd/ezil-prd-app-caller.
        assert.equal(caller[0].Properties.Path, '/ezil/prd/');
        assert.equal(caller[0].Properties.PermissionsBoundary, 'arn:aws:iam::123456789012:policy/ezil/identity/ezil-prd-boundary');
        assert.deepEqual(caller[0].Properties.AssumeRolePolicyDocument.Statement, [{ Effect: 'Allow', Action: 'sts:AssumeRole',
            Principal: { AWS: host }, Condition: { StringEquals: { 'aws:PrincipalTag/ezil:env': 'production' } } }]);
        for (const r of roles(template)) assert.equal(r.Properties.Path, '/ezil/prd/');
        const settings = Object.values<any>(template.Resources)
            .map(r => r.Properties?.Environment?.Variables?.EZIL_LIFECYCLE_SETTINGS).filter(Boolean);
        assert.ok(settings.length > 0);
        for (const s of settings) assert.equal(JSON.parse(s).authorityOrigin, 'https://os-prod.ezil.work', 'authority origin baked into the lifecycle');
        assert.ok(!/billing-staging|os-staging|ezil-mum|ezil-pilot/.test(JSON.stringify(template)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
