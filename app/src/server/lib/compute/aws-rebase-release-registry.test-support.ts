import { fixtureRebaseDeployments, fixtureRebaseRelease } from './aws-intent.test-support';
import type { LifecycleDeployment, SourceLifecycleDeployment } from './aws-intent';
import type { RebaseRelease, RebaseSourceRelease } from './aws-rebase-release';

// Synthetic pins reuse local fixtures; full digests retain the contract's prefixes.
export const LOWER_102 = 'sha256:' + '8dbc'.padEnd(64, '0');
export const LOWER_105 = 'sha256:' + '34ac'.padEnd(64, '0');
export const PREMIUM_LOWER = 'sha256:' + '0769'.padEnd(64, '0');

export function fixtureReleaseRegistry106() {
    const base = fixtureRebaseDeployments();
    const deployment102: SourceLifecycleDeployment = {
        ...base.sourceDeployment, lowerImageDigest: LOWER_102, previousLowerImageDigest: null,
        launchTemplateId: 'lt-22222222222222222', launchTemplateVersion: '3',
        stateMachineVersionArn: base.sourceDeployment.stateMachineVersionArn.replace(/:2$/, ':8'),
        preparationStateMachineVersionArn: null, recoveryStateMachineVersionArn: null,
    };
    const deployment105: LifecycleDeployment = {
        ...base.deployment, lowerImageDigest: LOWER_105, previousLowerImageDigest: LOWER_102,
        amiId: 'ami-55555555555555555', launchTemplateVersion: '4',
        stateMachineVersionArn: base.deployment.stateMachineVersionArn.replace(/:1$/, ':9'),
    };
    const deployment106: LifecycleDeployment = {
        ...deployment105, amiId: 'ami-66666666666666666', launchTemplateVersion: '5',
        stateMachineVersionArn: deployment105.stateMachineVersionArn.replace(/:9$/, ':10'),
        preparationStateMachineVersionArn: deployment105.preparationStateMachineVersionArn!.replace(/:1$/, ':2'),
        recoveryStateMachineVersionArn: deployment105.recoveryStateMachineVersionArn!.replace(/:1$/, ':2'),
    };
    const release102: RebaseSourceRelease = {
        ...fixtureRebaseRelease(deployment102), recipeVersion: '1.0.2', createdAt: '2026-10-20T10:00:00.000Z',
    };
    const base105 = fixtureRebaseRelease(deployment105);
    const release105: RebaseRelease = {
        ...base105, recipeVersion: '1.0.5', createdAt: '2026-10-21T10:00:00.000Z',
        lowerImageRef: base105.previousLowerImageRef!, previousLowerImageRef: release102.lowerImageRef,
    };
    const release106: RebaseRelease = {
        ...fixtureRebaseRelease(deployment106), recipeVersion: '1.0.6', createdAt: '2026-10-22T10:00:00.000Z',
        lowerImageRef: release105.lowerImageRef, previousLowerImageRef: release102.lowerImageRef,
    };
    const releases = [release102, release105, release106];
    return { deployment102, deployment105, deployment106, release102, release105, release106, releases,
        entry: { ...deployment106, releases }, repository: release106.lowerImageRef.split('@')[0]! };
}

/** Synthetic successor makes 34ac eligible, so tests can inspect the selected immutable source. */
export function fixtureSharedLowerSuccessor() {
    const f = fixtureReleaseRegistry106();
    const deployment = { ...f.deployment106, amiId: 'ami-77777777777777777',
        lowerImageDigest: 'sha256:' + '7'.repeat(64), previousLowerImageDigest: LOWER_105 };
    const target: RebaseRelease = { ...f.release106, amiId: deployment.amiId, lowerImageDigest: deployment.lowerImageDigest,
        previousLowerImageDigest: deployment.previousLowerImageDigest, recipeVersion: '1.0.7',
        lowerImageRef: `${f.repository}@${deployment.lowerImageDigest}`, previousLowerImageRef: f.release105.lowerImageRef,
        createdAt: '2026-10-22T11:00:00.000Z' };
    return { ...f, deployment, target, entry: { ...deployment, releases: [...f.releases, target] } };
}
