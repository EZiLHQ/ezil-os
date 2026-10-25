import { describe, expect, it } from 'vitest';
import { readLifecycleDeployments } from './aws-intent';
import { parseRebaseRelease, parseRebaseSourceRelease, RebaseReleaseSchema, RebaseSourceReleaseSchema,
    resolveRebaseReleases, sourceDeploymentFor } from './aws-rebase-release';
import { fixtureReleaseRegistry106, fixtureSharedLowerSuccessor, LOWER_102, LOWER_105, PREMIUM_LOWER } from './aws-rebase-release-registry.test-support';

describe('B2/B4/B5 retained 1.0.6 release registry', () => {
    it('resolves 8dbc to 1.0.6 while preserving the entire legacy 1.0.2 source deployment', () => {
        const f = fixtureReleaseRegistry106();
        const resolved = resolveRebaseReleases(f.entry, LOWER_102);
        expect(resolved).toEqual({ source: f.release102, target: f.release106,
            deployment: f.deployment106, repository: f.repository });
        const source = sourceDeploymentFor(resolved.deployment, resolved.source);
        expect(source).toEqual(f.deployment102);
        expect(source).toMatchObject({ amiId: 'ami-22222222222222222', launchTemplateVersion: '3',
            lowerImageDigest: LOWER_102, previousLowerImageDigest: null,
            preparationStateMachineVersionArn: null, recoveryStateMachineVersionArn: null });
        expect(parseRebaseSourceRelease(f.release102, source, f.repository)).toEqual(f.release102);
        expect(parseRebaseRelease(JSON.stringify(f.release106), resolved.deployment, f.repository)).toEqual(f.release106);
    });

    it('refuses shared lower 34ac without observed AMI evidence', () => {
        const f = fixtureReleaseRegistry106();
        expect(f.release105.amiId).not.toBe(f.release106.amiId);
        expect(() => resolveRebaseReleases(f.entry, LOWER_105)).toThrow('release_mismatch');
    });

    it('accepts the rolled-back 1.0.5 tuple with 1.0.6 retained and resolves 8dbc to 1.0.5', () => {
        const f = fixtureReleaseRegistry106();
        const entry = { ...f.deployment105, releases: f.releases };
        expect(readLifecycleDeployments({ EZIL_AWS_LIFECYCLE_DEPLOYMENTS: JSON.stringify({ [entry.region]: entry }) }, [entry.region]))
            .toEqual({ ok: true, deployments: { [entry.region]: f.deployment105 } });
        const resolved = resolveRebaseReleases(entry, LOWER_102);
        expect(resolved).toEqual({ source: f.release102, target: f.release105,
            deployment: f.deployment105, repository: f.repository });
        expect(parseRebaseRelease(f.release105, resolved.deployment, f.repository)).toEqual(f.release105);
        expect(sourceDeploymentFor(resolved.deployment, resolved.source)).toEqual(f.deployment102);
    });

    it.each([
        ['unregistered premium 0769', PREMIUM_LOWER, 'release_mismatch'],
        ['unknown source digest', null, 'source_digest_unknown'],
    ] as const)('refuses %s', (_label, lower, error) => {
        expect(() => resolveRebaseReleases(fixtureReleaseRegistry106().entry, lower)).toThrow(error);
    });

    it('refuses two records with the same full target tuple even if their provenance differs', () => {
        const f = fixtureReleaseRegistry106();
        const duplicate = { ...f.release106, agentCommit: 'f'.repeat(40) };
        expect(RebaseReleaseSchema.parse(duplicate)).toEqual(duplicate);
        expect(() => resolveRebaseReleases({ ...f.entry, releases: [...f.releases, duplicate] }, LOWER_102))
            .toThrow('release_mismatch');
    });

    it.each(['preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn'] as const)
    ('refuses a target with null %s, although it is valid source evidence', field => {
        const f = fixtureReleaseRegistry106();
        const target = { ...f.release106, [field]: null };
        expect(RebaseSourceReleaseSchema.parse(target)).toEqual(target);
        expect(RebaseReleaseSchema.safeParse(target).success).toBe(false);
        expect(() => parseRebaseRelease(target, f.deployment106, f.repository)).toThrow();
        expect(() => resolveRebaseReleases({ ...f.entry, releases: [f.release102, f.release105, target] }, LOWER_102))
            .toThrow('release_mismatch');
    });

    it('refuses a target with no predecessor even when its workflow pins match the region tuple', () => {
        const f = fixtureReleaseRegistry106();
        const target = { ...f.release106, previousLowerImageDigest: null, previousLowerImageRef: null };
        expect(RebaseReleaseSchema.parse(target)).toEqual(target);
        expect(() => resolveRebaseReleases({ ...f.entry, previousLowerImageDigest: null,
            releases: [f.release102, f.release105, target] }, LOWER_102)).toThrow('unsupported_predecessor');
    });

    it.each([{ order: [1, 0, 2] }, { order: [0, 2, 1] }])('refuses out-of-order createdAt at registry indexes $order', ({ order }) => {
        const f = fixtureReleaseRegistry106();
        expect(() => resolveRebaseReleases({ ...f.entry, releases: order.map(i => f.releases[i]!) }, LOWER_102))
            .toThrow('release_mismatch');
    });

    it.each([
        ['account', { accountId: '999999999999' }],
        ['region', { region: 'us-east-1' }],
        ['namespace', { namespace: 'foreign' }],
        ['repository', {}],
    ] as const)('refuses a schema-valid foreign %s source', (boundary, identity) => {
        const f = fixtureReleaseRegistry106();
        const source = { ...f.release102, ...identity };
        const repository = `${source.accountId}.dkr.ecr.${source.region}.amazonaws.com/${boundary === 'repository' ? 'foreign' : 'desktop'}`;
        source.lowerImageRef = `${repository}@${f.release102.lowerImageRef.split('@')[1]}`;
        source.stateMachineVersionArn = `arn:aws:states:${source.region}:${source.accountId}:stateMachine:ezil-${source.namespace}-lifecycle:8`;
        // Do not let malformed evidence mask the resolver's source/target boundary check.
        expect(RebaseSourceReleaseSchema.parse(source)).toEqual(source);
        expect(() => resolveRebaseReleases({ ...f.entry, releases: [source, f.release105, f.release106] }, LOWER_102))
            .toThrow('release_mismatch');
    });

    it('refuses a unique registered source that is not the target predecessor', () => {
        const f = fixtureReleaseRegistry106();
        const target = { ...f.release106, previousLowerImageDigest: PREMIUM_LOWER,
            previousLowerImageRef: `${f.repository}@${PREMIUM_LOWER}` };
        expect(RebaseReleaseSchema.parse(target)).toEqual(target);
        expect(() => resolveRebaseReleases({ ...f.entry, previousLowerImageDigest: PREMIUM_LOWER,
            releases: [f.release102, f.release105, target] }, LOWER_102)).toThrow('unsupported_predecessor');
    });

    it.each([
        ['amiId', 'ami-55555555555555555'],
        ['launchTemplateId', 'lt-22222222222222222'],
        ['launchTemplateVersion', '4'],
        ['stateMachineVersionArn', ':9'],
        ['preparationStateMachineVersionArn', ':1'],
        ['recoveryStateMachineVersionArn', ':1'],
    ] as const)('requires the target %s pin in both resolution and parsing', (field, value) => {
        const f = fixtureReleaseRegistry106();
        const deployment = { ...f.deployment106, [field]: value.startsWith(':')
            ? f.release106[field].replace(/:[0-9]+$/, value) : value };
        expect(() => resolveRebaseReleases({ ...deployment, releases: f.releases }, LOWER_102)).toThrow('release_mismatch');
        expect(() => parseRebaseRelease(f.release106, deployment, f.repository)).toThrow('release_mismatch');
    });

    it('requires the approved repository when parsing the selected 1.0.6 release', () => {
        const f = fixtureReleaseRegistry106();
        expect(() => parseRebaseRelease(f.release106, f.deployment106, f.repository + '-foreign')).toThrow('release_mismatch');
    });
});

describe('B2 shared lower resolved by observed AMI', () => {
    it.each(['release105', 'release106'] as const)('selects exactly %s for an eligible successor', key => {
        const f = fixtureSharedLowerSuccessor();
        expect(resolveRebaseReleases(f.entry, LOWER_105, f[key].amiId)).toEqual({
            source: f[key], target: f.target, deployment: f.deployment, repository: f.repository });
    });
    it.each(['release105', 'release106'] as const)('still refuses %s on 34ac for target 1.0.6 (previous 8dbc)', key => {
        const f = fixtureReleaseRegistry106();
        expect(() => resolveRebaseReleases(f.entry, LOWER_105, f[key].amiId)).toThrow('unsupported_predecessor');
    });
    it.each([undefined, '', 'ami-99999999999999999', 'ami-22222222222222222'])('refuses a missing, unknown or different-lower AMI %s', amiId => {
        expect(() => resolveRebaseReleases(fixtureSharedLowerSuccessor().entry, LOWER_105, amiId)).toThrow('release_mismatch');
    });
    it.each([{}, { agentCommit: 'f'.repeat(40) }])('refuses a duplicate selected (lower, AMI) pair %#', patch => {
        const f = fixtureSharedLowerSuccessor();
        f.entry.releases.splice(2, 0, { ...f.release105, ...patch });
        expect(() => resolveRebaseReleases(f.entry, LOWER_105, f.release105.amiId)).toThrow('release_mismatch');
    });
    it.each(['account', 'region', 'namespace', 'repository'] as const)('refuses a schema-valid shared-lower source in a foreign %s', boundary => {
        const f = fixtureSharedLowerSuccessor(), source = { ...f.release105 };
        if (boundary === 'account') source.accountId = '999999999999';
        if (boundary === 'region') source.region = 'us-east-1';
        if (boundary === 'namespace') source.namespace = 'foreign';
        const repository = `${source.accountId}.dkr.ecr.${source.region}.amazonaws.com/${boundary === 'repository' ? 'foreign' : 'desktop'}`;
        source.lowerImageRef = `${repository}@${LOWER_105}`;
        source.previousLowerImageRef = `${repository}@${LOWER_102}`;
        for (const [key, name] of [['stateMachineVersionArn', 'lifecycle'], ['preparationStateMachineVersionArn', 'rebase-preparation'],
            ['recoveryStateMachineVersionArn', 'recovery']] as const)
            source[key] = `arn:aws:states:${source.region}:${source.accountId}:stateMachine:ezil-${source.namespace}-${name}:1`;
        expect(RebaseSourceReleaseSchema.parse(source)).toEqual(source);
        f.entry.releases[1] = source;
        expect(() => resolveRebaseReleases(f.entry, LOWER_105, source.amiId)).toThrow('release_mismatch');
    });
    it('keeps unique 8dbc resolution independent of AMI evidence', () => {
        const f = fixtureReleaseRegistry106();
        expect(resolveRebaseReleases(f.entry, LOWER_102, 'ami-99999999999999999').source).toEqual(f.release102);
    });
});

describe('nine-record registry capacity and rollback compatibility', () => {
    function registry(count: number) {
        const f = fixtureReleaseRegistry106();
        const releases = [...f.releases];
        for (let n = 7; releases.length < count; n++) releases.push({ ...f.release106,
            amiId: `ami-${n.toString(16).padStart(17, '0')}`, recipeVersion: `1.0.${n}` });
        return { ...f, releases };
    }
    it.each([8, 9])('accepts %i retained records through both production validators', count => {
        const f = registry(count);
        for (const deployment of [f.deployment106, f.deployment105]) {
            const entry = { ...deployment, releases: f.releases };
            const original = JSON.stringify(entry);
            expect(readLifecycleDeployments({ EZIL_AWS_LIFECYCLE_DEPLOYMENTS: JSON.stringify({ [entry.region]: entry }) }, [entry.region]).ok).toBe(true);
            expect(resolveRebaseReleases(entry, LOWER_102).target.amiId).toBe(deployment.amiId);
            expect(JSON.stringify(entry)).toBe(original);
        }
    });
    it('refuses ten records in both validators even when all identities are valid', () => {
        const f = registry(10), entry = { ...f.deployment106, releases: f.releases };
        f.releases.forEach(r => expect(RebaseSourceReleaseSchema.safeParse(r).success).toBe(true));
        expect(readLifecycleDeployments({ EZIL_AWS_LIFECYCLE_DEPLOYMENTS: JSON.stringify({ [entry.region]: entry }) }, [entry.region]).ok).toBe(false);
        expect(() => resolveRebaseReleases(entry, LOWER_102)).toThrow();
    });
});
