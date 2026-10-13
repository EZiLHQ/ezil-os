import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
        execFileSync(process.execPath, ['--import', 'tsx', bin], { cwd: root, stdio: 'pipe', env: { ...clean, ...offline, ...env, CDK_OUTDIR: out } });
        const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
        const stacks = Object.entries(manifest.artifacts as Record<string, any>).filter(([, a]) => a.type === 'aws:cloudformation:stack');
        return Object.fromEntries(stacks.map(([name, a]) => [name, { template: JSON.parse(readFileSync(join(out, a.properties.templateFile), 'utf8')),
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
test('bin/main (foundation), bin/identity and bin/ops synthesize without bootstrap under their fixed names', () => {
    const foundation = synth('bin/main.ts', { EZIL_FOUNDATION_CONFIG: 'config/foundation.example.json' })['ezil-pilot-foundation']!.template;
    assert.ok(!JSON.stringify(foundation).includes('BootstrapVersion'));
    const vpc = Object.values(foundation.Resources as Record<string, any>).find(r => r.Type === 'AWS::EC2::VPC');
    assert.ok(vpc.Properties.Tags.some((t: any) => t.Key === 'ezil:namespace' && t.Value === 'pilot'));
    const identity = synth('bin/identity.ts', { EZIL_IDENTITY_CONFIG: 'config/identity.example.json' })['ezil-identity-pilot']!.template;
    assert.deepEqual(roles(identity).map(r => r.Properties.RoleName).sort(), ['ezil-pilot-cfn-exec', 'ezil-pilot-deploy']);
    const ops = synth('bin/ops.ts', { EZIL_OPS_CONFIG: 'config/ops.example.json' })['ezil-pilot-ops']!.template;
    assert.equal(roles(ops).length, 0);
    for (const t of [identity, ops]) assert.ok(!JSON.stringify(t).includes('BootstrapVersion'));
});
test('bin entrypoints refuse to run without a config', () => {
    for (const bin of ['bin/main.ts', 'bin/lifecycle.ts', 'bin/identity.ts', 'bin/ops.ts']) assert.throws(() => synth(bin, {}), bin);
});
