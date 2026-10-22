import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseReleaseManifest, validateReleaseReadback, RELEASE_WORKFLOW_KEYS } from '../lib/lifecycle/release-manifest.js';
import { rebaseFixture } from './rebase-fixture.js';

function fixture() {
    const d = rebaseFixture().intent.deployment, repository = `${d.accountId}.dkr.ecr.${d.region}.amazonaws.com/ezil/desktop`;
    const manifest = { schemaVersion: 1 as const, accountId: d.accountId, region: d.region, namespace: d.namespace, amiId: d.amiId,
        recipeVersion: '1.2.3', lowerImageDigest: d.lowerImageDigest!, lowerImageRef: repository + '@sha256:' + 'c'.repeat(64),
        previousLowerImageDigest: d.previousLowerImageDigest!, previousLowerImageRef: repository + '@sha256:' + 'd'.repeat(64),
        agentCommit: 'e'.repeat(40), stateMachineVersionArn: d.stateMachineVersionArn,
        preparationStateMachineVersionArn: d.preparationStateMachineVersionArn!, recoveryStateMachineVersionArn: d.recoveryStateMachineVersionArn!,
        launchTemplateId: d.launchTemplateId, launchTemplateVersion: d.launchTemplateVersion, createdAt: '2026-10-22T12:00:00.000Z' };
    const reviewed = { buildArn: `arn:aws:imagebuilder:${d.region}:${d.accountId}:image/ezil-host/1.2.3/1`, recipeName: 'ezil-host',
        agentSourceS3Uri: `s3://ezil-pilot-assets/ami/host-agent-${manifest.agentCommit}.tgz`, now: Date.parse(manifest.createdAt) };
    const evidence = { build: { image: { arn: reviewed.buildArn, state: { status: 'AVAILABLE' }, outputResources: { amis: [{ image: d.amiId, region: d.region, accountId: d.accountId }] },
        imageRecipe: { name: reviewed.recipeName, version: manifest.recipeVersion, components: [{ parameters: Object.entries({ DesktopImageRef: manifest.lowerImageRef,
            DesktopImageId: manifest.lowerImageDigest, PreviousDesktopImageRef: manifest.previousLowerImageRef, PreviousDesktopImageId: manifest.previousLowerImageDigest,
            AgentSrcS3Uri: reviewed.agentSourceS3Uri }).map(([name, value]) => ({ name, value: [value] })) }] } } },
        image: { Images: [{ ImageId: d.amiId, OwnerId: d.accountId, State: 'available', Architecture: 'x86_64', Public: false }] },
        template: { LaunchTemplateVersions: [{ LaunchTemplateId: d.launchTemplateId, VersionNumber: Number(d.launchTemplateVersion), LaunchTemplateData: { ImageId: d.amiId } }] },
        versions: Object.fromEntries(RELEASE_WORKFLOW_KEYS.map(k => [k, { stateMachineVersions: [{ stateMachineVersionArn: manifest[k] }] }])),
        workflows: Object.fromEntries(RELEASE_WORKFLOW_KEYS.map(k => [k, { stateMachineArn: manifest[k], type: 'STANDARD', status: 'ACTIVE' }])),
    };
    return { d, repository, manifest, reviewed, evidence };
}
test('release manifest follows E property order and accepts registry hashes different from baked lower IDs', () => {
    const f = fixture(), r = parseReleaseManifest(JSON.stringify(f.manifest), f.d, f.repository);
    const schema = JSON.parse(readFileSync(join(__dirname, '../../../deploy/aws/mum/rebase-release.schema.json'), 'utf8'));
    assert.deepEqual(Object.keys(r), Object.keys(schema.properties));
    assert.notEqual(r.lowerImageDigest, r.lowerImageRef.split('@')[1]);
    validateReleaseReadback(r, f.evidence, f.reviewed);
});
test('source-only legacy records permit null workflows; target and maintenance require capable releases', () => {
    const f = fixture(), source = { ...f.manifest, previousLowerImageDigest: null, previousLowerImageRef: null,
        preparationStateMachineVersionArn: null, recoveryStateMachineVersionArn: null };
    const d = { ...f.d, previousLowerImageDigest: null };
    assert.equal(parseReleaseManifest(JSON.stringify(source), d, f.repository, 'source').recoveryStateMachineVersionArn, null);
    for (const mode of ['target', 'maintenance'] as const) assert.throws(() => parseReleaseManifest(JSON.stringify(source), d, f.repository, mode));
    const maintenance = { ...source, preparationStateMachineVersionArn: f.manifest.preparationStateMachineVersionArn, recoveryStateMachineVersionArn: f.manifest.recoveryStateMachineVersionArn };
    assert.equal(parseReleaseManifest(JSON.stringify(maintenance), d, f.repository, 'maintenance').previousLowerImageDigest, null);
});
test('manifest rejects partial pairs, mutable refs, unapproved repositories, malformed dates, integers and versions', () => {
    const f = fixture();
    for (const patch of [{ previousLowerImageRef: null }, { previousLowerImageDigest: f.manifest.lowerImageDigest },
        { lowerImageRef: f.repository + ':latest' }, { lowerImageRef: f.manifest.lowerImageRef.replace('/ezil/desktop', '/foreign') },
        { previousLowerImageRef: f.manifest.previousLowerImageRef.replace('/ezil/desktop', '/foreign') },
        { createdAt: '2026-02-30T12:00:00.000Z' }, { recipeVersion: '1073741824.0.0' }, { recipeVersion: '01.2.3' },
        { schemaVersion: true }, { agentCommit: 'abc123' }, { namespace: 'identity' }, { extra: 'x' },
        { preparationStateMachineVersionArn: f.manifest.preparationStateMachineVersionArn.replace(':1', ':latest') }])
        assert.throws(() => parseReleaseManifest(JSON.stringify({ ...f.manifest, ...patch }), f.d, f.repository));
    assert.throws(() => parseReleaseManifest(JSON.stringify(f.manifest).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), f.d, f.repository));
    assert.throws(() => parseReleaseManifest(' '.repeat(16385) + JSON.stringify(f.manifest), f.d, f.repository));
});
const mutations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    'wrong build': f => { f.evidence.build.image.arn += '2'; },
    'wrong bake lower': f => { f.evidence.build.image.imageRecipe.components[0]!.parameters[1]!.value = ['sha256:' + '0'.repeat(64)]; },
    'duplicate component binding': f => { f.evidence.build.image.imageRecipe.components[0]!.parameters.push(f.evidence.build.image.imageRecipe.components[0]!.parameters[0]!); },
    'wrong owner': f => { f.evidence.image.Images[0]!.OwnerId = '999999999999'; },
    'public AMI': f => { f.evidence.image.Images[0]!.Public = true; },
    'incomplete read': f => { Object.assign(f.evidence.image, { NextToken: 'another-page' }); },
    'wrong template': f => { f.evidence.template.LaunchTemplateVersions[0]!.VersionNumber++; },
    'unpublished workflow': f => { f.evidence.versions.recoveryStateMachineVersionArn!.stateMachineVersions = []; },
    'aliased workflow': f => { f.evidence.workflows.recoveryStateMachineVersionArn!.stateMachineArn += ':alias'; },
    'future manifest': f => { f.reviewed.now--; },
};
for (const [label, mutate] of Object.entries(mutations)) test('release readback refuses ' + label, () => {
    const f = fixture(); mutate(f); assert.throws(() => validateReleaseReadback(f.manifest, f.evidence, f.reviewed));
});
