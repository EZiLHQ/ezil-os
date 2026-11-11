import { describe, expect, it } from 'vitest';
import { fixtureRebasePreparation, fixtureRebaseRelease } from './aws-intent.test-support';
import { LifecycleDeploymentSchema } from './aws-intent';
import { RebaseSourceReleaseSchema, resolveRebaseReleases } from './aws-rebase-release';

const IMAGE_FIELDS = ['lowerImageDigest', 'previousLowerImageDigest',
    'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn'] as const;
function fixture() {
    const p = fixtureRebasePreparation().intent;
    const base = Object.fromEntries(Object.entries(p.sourceDeployment).filter(([k]) => !IMAGE_FIELDS.includes(k as typeof IMAGE_FIELDS[number])));
    const legacy = LifecycleDeploymentSchema.parse(base);
    // Historical provisions omit the whole image group; an admitted legacy source can still have recovery enabled.
    const source = RebaseSourceReleaseSchema.parse({ ...fixtureRebaseRelease(p.sourceDeployment),
        previousLowerImageDigest: null, previousLowerImageRef: null, preparationStateMachineVersionArn: null });
    const target = fixtureRebaseRelease(p.deployment);
    return { legacy, source, target, deployment: p.deployment, repository: target.lowerImageRef.split('@')[0]!,
        entry: { ...p.deployment, releases: [source, target] } };
}

describe('R2 legacy recorded provision release selection', () => {
    it('selects the unique legacy source by all seven boot fields without injecting four missing image fields', () => {
        const f = fixture(), before = JSON.stringify({ entry: f.entry, legacy: f.legacy });
        expect(IMAGE_FIELDS.every(k => !Object.prototype.hasOwnProperty.call(f.legacy, k))).toBe(true);
        expect(f.source.previousLowerImageDigest).toBeNull();
        expect(f.source.preparationStateMachineVersionArn).toBeNull();
        expect(f.source.recoveryStateMachineVersionArn).toMatch(/-recovery:1$/);
        expect(resolveRebaseReleases(f.entry, f.source.lowerImageDigest, undefined, f.legacy)).toEqual({
            source: f.source, target: f.target, deployment: f.deployment, repository: f.repository });
        expect(JSON.stringify({ entry: f.entry, legacy: f.legacy })).toBe(before);
    });
    it.each(IMAGE_FIELDS)('refuses a partial historical image group with %s present', field => {
        const f = fixture();
        expect(() => resolveRebaseReleases(f.entry, f.source.lowerImageDigest, undefined,
            { ...f.legacy, [field]: f.source[field] })).toThrow('release_mismatch');
    });
    it.each(IMAGE_FIELDS)('does not treat an own undefined %s as absent', field => {
        const f = fixture();
        expect(() => resolveRebaseReleases(f.entry, f.source.lowerImageDigest, undefined,
            { ...f.legacy, [field]: undefined })).toThrow('release_mismatch');
    });
    it('refuses all four image keys explicitly present as undefined', () => {
        const f = fixture();
        expect(() => resolveRebaseReleases(f.entry, f.source.lowerImageDigest, undefined,
            { ...f.legacy, ...Object.fromEntries(IMAGE_FIELDS.map(k => [k, undefined])) })).toThrow('release_mismatch');
    });
    it.each([
        ['amiId', 'ami-99999999999999999'], ['launchTemplateId', 'lt-99999999999999999'],
        ['launchTemplateVersion', '99'], ['stateMachineVersionArn', 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-pilot-lifecycle:99'],
    ])('requires exact historical %s', (field, value) => {
        const f = fixture(), provisioned = { ...f.legacy, [field]: value };
        expect(LifecycleDeploymentSchema.safeParse(provisioned).success).toBe(true);
        expect(() => resolveRebaseReleases(f.entry, f.source.lowerImageDigest, undefined, provisioned)).toThrow('release_mismatch');
    });
    it('requires a valid complete lifecycle deployment even when all four image fields are absent', () => {
        const f = fixture();
        for (const provisioned of [{ ...f.legacy, subnetId: 'invalid' }, { ...f.legacy, extra: true },
            { ...f.legacy, storage: { ...f.legacy.storage, dataMinGiB: f.legacy.storage.dataMaxGiB + 1 } }])
            expect(() => resolveRebaseReleases(f.entry, f.source.lowerImageDigest, undefined, provisioned)).toThrow();
    });
    it('refuses ambiguous legacy records with identical boot fields and lower', () => {
        const f = fixture(), duplicate = { ...f.source, recoveryStateMachineVersionArn: f.source.recoveryStateMachineVersionArn!.replace(/:1$/, ':2') };
        expect(RebaseSourceReleaseSchema.parse(duplicate)).toEqual(duplicate);
        expect(() => resolveRebaseReleases({ ...f.entry, releases: [f.source, duplicate, f.target] }, f.source.lowerImageDigest,
            undefined, f.legacy)).toThrow('release_mismatch');
    });
    it('requires the recorded lower and target predecessor', () => {
        const f = fixture();
        expect(() => resolveRebaseReleases(f.entry, null, undefined, f.legacy)).toThrow('source_digest_unknown');
        expect(() => resolveRebaseReleases(f.entry, 'sha256:' + 'f'.repeat(64), undefined, f.legacy)).toThrow('release_mismatch');
        const target = { ...f.target, previousLowerImageDigest: 'sha256:' + 'f'.repeat(64) };
        expect(() => resolveRebaseReleases({ ...f.entry, previousLowerImageDigest: target.previousLowerImageDigest,
            releases: [f.source, target] }, f.source.lowerImageDigest, undefined, f.legacy)).toThrow('unsupported_predecessor');
    });
    it.each(['accountId', 'region', 'namespace', 'repository'] as const)('refuses a schema-valid foreign %s legacy source', boundary => {
        const f = fixture(), accountId = boundary === 'accountId' ? '999999999999' : f.source.accountId,
            region = boundary === 'region' ? 'us-east-1' : f.source.region, namespace = boundary === 'namespace' ? 'foreign' : f.source.namespace;
        const machine = (name: string) => `arn:aws:states:${region}:${accountId}:stateMachine:ezil-${namespace}-${name}:1`;
        const source = { ...f.source, accountId, region, namespace, stateMachineVersionArn: machine('lifecycle'),
            recoveryStateMachineVersionArn: machine('recovery'), lowerImageRef: `${accountId}.dkr.ecr.${region}.amazonaws.com/${boundary === 'repository' ? 'foreign' : 'desktop'}@${f.source.lowerImageDigest}` };
        const provisioned = { ...f.legacy, accountId, region, namespace, stateMachineVersionArn: source.stateMachineVersionArn,
            zoneId: region === 'us-east-1' ? 'use1-az1' : f.legacy.zoneId,
            dataKeyArn: f.legacy.dataKeyArn.replace(f.source.accountId, accountId).replace(f.source.region, region) };
        expect(RebaseSourceReleaseSchema.parse(source)).toEqual(source);
        expect(LifecycleDeploymentSchema.safeParse(provisioned).success).toBe(true);
        expect(() => resolveRebaseReleases({ ...f.entry, releases: [source, f.target] }, source.lowerImageDigest,
            undefined, provisioned)).toThrow('release_mismatch');
    });
    it('keeps fully image-enabled source records on the exact eleven-field rule', () => {
        const f = fixture(), source = { ...f.source, preparationStateMachineVersionArn: f.target.preparationStateMachineVersionArn };
        const entry = { ...f.entry, releases: [source, f.target] };
        expect(() => resolveRebaseReleases(entry, source.lowerImageDigest, undefined, f.legacy)).toThrow('release_mismatch');
        const modern = LifecycleDeploymentSchema.parse({ ...f.legacy, ...Object.fromEntries(IMAGE_FIELDS.map(k => [k, source[k]])) });
        expect(resolveRebaseReleases(entry, source.lowerImageDigest, undefined, modern).source).toEqual(source);
        for (const field of IMAGE_FIELDS) {
            const changed = field.endsWith('Arn') ? modern[field]!.replace(/:1$/, ':99') : 'sha256:' + 'f'.repeat(64);
            expect(() => resolveRebaseReleases(entry, source.lowerImageDigest, undefined, { ...modern, [field]: changed })).toThrow('release_mismatch');
        }
    });
});
