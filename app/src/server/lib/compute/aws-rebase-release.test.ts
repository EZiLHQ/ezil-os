import { describe, expect, it } from 'vitest';
import { fixtureRebasePreparation, fixtureRebaseRelease } from './aws-intent.test-support';
import { resolveRebaseReleases, sourceDeploymentFor, parseRebaseSourceRelease } from './aws-rebase-release';
import { buildRebasePreparation } from './aws-rebase-preparation';
import { readLifecycleDeployments, LifecycleDeploymentSchema } from './aws-intent';
const p = fixtureRebasePreparation();
const source = fixtureRebaseRelease(p.intent.sourceDeployment), target = fixtureRebaseRelease(p.intent.deployment);
const entry = () => ({ ...p.intent.deployment, releases: [source, target] });
describe('A1 immutable region release registry', () => {
    it('resolves both full records and keeps the registry out of hashed workflow deployments', () => {
        expect(resolveRebaseReleases(entry(), source.lowerImageDigest)).toMatchObject({ source, target });
        const read = readLifecycleDeployments({ EZIL_AWS_LIFECYCLE_DEPLOYMENTS: JSON.stringify({ [p.intent.deployment.region]: entry() }) }, [p.intent.deployment.region]);
        expect(read).toEqual({ ok: true, deployments: { [p.intent.deployment.region]: p.intent.deployment } });
    });
    it.each([[], [target], [source], [source, source, target], [source, target, target], Array(9).fill(target)])('refuses absent or ambiguous releases %#', releases => {
        expect(() => resolveRebaseReleases({ ...entry(), releases }, source.lowerImageDigest)).toThrow();
    });
    it('distinguishes unknown source and unsupported predecessors', () => {
        expect(() => resolveRebaseReleases(entry(), null)).toThrow('source_digest_unknown');
        expect(() => resolveRebaseReleases(entry(), 'sha256:' + 'f'.repeat(64))).toThrow('release_mismatch');
        const older = { ...source, lowerImageDigest: 'sha256:' + 'f'.repeat(64) };
        expect(() => resolveRebaseReleases({ ...entry(), releases: [older, target] }, older.lowerImageDigest)).toThrow('unsupported_predecessor');
    });
    it('allows legacy source records only on preparation source deployments', () => {
        const legacy = { ...source, preparationStateMachineVersionArn: null, recoveryStateMachineVersionArn: null };
        const r = resolveRebaseReleases({ ...entry(), releases: [legacy, target] }, source.lowerImageDigest);
        const d = sourceDeploymentFor(r.deployment, legacy);
        expect(parseRebaseSourceRelease(legacy, d, r.repository)).toEqual(legacy);
        expect(() => buildRebasePreparation({ ...p.intent, sourceDeployment: d })).not.toThrow();
        expect(LifecycleDeploymentSchema.safeParse(d).success).toBe(false);
        expect(() => resolveRebaseReleases({ ...entry(), releases: [source, { ...target, preparationStateMachineVersionArn: null }] }, source.lowerImageDigest)).toThrow('release_mismatch');
    });
    it('refuses records that drift from the region tuple or cross repositories', () => {
        for (const patch of [{ amiId: source.amiId }, { launchTemplateVersion: '2' }, { recoveryStateMachineVersionArn: target.recoveryStateMachineVersionArn.replace(/:1$/, ':2') }])
            expect(() => resolveRebaseReleases({ ...entry(), ...patch }, source.lowerImageDigest)).toThrow('release_mismatch');
        expect(() => resolveRebaseReleases({ ...entry(), releases: [{ ...source, lowerImageRef: source.lowerImageRef.replace('/desktop@', '/foreign@') }, target] }, source.lowerImageDigest)).toThrow('release_mismatch');
    });
});
