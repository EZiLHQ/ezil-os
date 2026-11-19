import { z } from 'zod';
import type { Settings } from './lifecycle/contract.js';
import { parseReleaseManifest, ReleaseManifestSchema, type ReleaseManifest } from './lifecycle/release-manifest.js';
import { priorVersion, type TransitionObserverVersions, type TransitionStateMachineVersions } from './observer-transition.js';

const observerVersions = z.object({
    lifecycle: z.string().regex(/^LifecycleObserverCurrentVersion[0-9A-F]{8}[a-f0-9]{32}$/),
    preparation: z.string().regex(/^LifecyclePreparationObserverCurrentVersion[0-9A-F]{8}[a-f0-9]{32}$/),
    recovery: z.string().regex(/^RecoveryObserverCurrentVersion[0-9A-F]{8}[a-f0-9]{32}$/),
}).strict();

export const RetainedRebaseBridgeConfigSchema = z.object({
    // The operator supplies these reviewed manifests and the existing retained Lambda logical IDs.
    sourceRelease: ReleaseManifestSchema,
    release: ReleaseManifestSchema,
    interveningRelease: ReleaseManifestSchema,
    observers: observerVersions,
}).strict();

export type RetainedRebaseBridge = Readonly<{
    amiIds: readonly [string, string];
    sourceLifecycleVersion: string;
    versions: Readonly<Required<TransitionStateMachineVersions>>;
    observers: Readonly<Required<TransitionObserverVersions>>;
}>;

export function resolveRetainedRebaseBridge(
    config: z.infer<typeof RetainedRebaseBridgeConfigSchema>,
    settings: Settings,
    transition: TransitionStateMachineVersions | undefined,
    transitionObservers: TransitionObserverVersions | undefined,
): RetainedRebaseBridge {
    const d = settings.deployment;
    const { sourceRelease, release, interveningRelease, observers } = config;
    const invalid = (): never => { throw new Error('invalid_retained_rebase_bridge'); };
    if (d.namespace !== 'mum' || settings.authorityOrigin !== 'https://os-staging.ezil.work'
        || !d.preparationStateMachineVersionArn || !d.recoveryStateMachineVersionArn
        || d.previousLowerImageDigest !== interveningRelease.lowerImageDigest
        || interveningRelease.previousLowerImageDigest !== release.lowerImageDigest
        || !d.lowerImageDigest || release.previousLowerImageDigest !== sourceRelease.lowerImageDigest
        || new Set([sourceRelease.lowerImageDigest, release.lowerImageDigest, interveningRelease.lowerImageDigest, d.lowerImageDigest]).size !== 4
        || new Set([sourceRelease.amiId, release.amiId, interveningRelease.amiId, d.amiId]).size !== 4
        || [sourceRelease, release, interveningRelease].some(r => r.launchTemplateId !== d.launchTemplateId)
        || Number(sourceRelease.launchTemplateVersion) >= Number(release.launchTemplateVersion)
        || Number(release.launchTemplateVersion) >= Number(interveningRelease.launchTemplateVersion)
        || Number(interveningRelease.launchTemplateVersion) >= Number(d.launchTemplateVersion)) return invalid();
    const repository = interveningRelease.lowerImageRef.split('@')[0]!;
    function validate(r: ReleaseManifest) {
        parseReleaseManifest(JSON.stringify(r), {
            ...d, amiId: r.amiId, launchTemplateVersion: r.launchTemplateVersion,
            lowerImageDigest: r.lowerImageDigest, previousLowerImageDigest: r.previousLowerImageDigest,
            stateMachineVersionArn: r.stateMachineVersionArn,
            preparationStateMachineVersionArn: r.preparationStateMachineVersionArn ?? undefined,
            recoveryStateMachineVersionArn: r.recoveryStateMachineVersionArn ?? undefined,
        }, repository);
    }
    validate(sourceRelease);
    validate(release);
    validate(interveningRelease);

    const versions = {
        lifecycle: release.stateMachineVersionArn,
        preparation: release.preparationStateMachineVersionArn!,
        recovery: release.recoveryStateMachineVersionArn!,
    };
    const intervening = {
        lifecycle: interveningRelease.stateMachineVersionArn,
        preparation: interveningRelease.preparationStateMachineVersionArn!,
        recovery: interveningRelease.recoveryStateMachineVersionArn!,
    };
    const current = {
        lifecycle: d.stateMachineVersionArn,
        preparation: d.preparationStateMachineVersionArn,
        recovery: d.recoveryStateMachineVersionArn,
    };
    for (const key of ['lifecycle', 'preparation', 'recovery'] as const) {
        const previousObserver = transitionObservers?.[key];
        if (transition?.[key] !== intervening[key] || !previousObserver || previousObserver === observers[key]) return invalid();
        priorVersion(current[key], intervening[key]);
        priorVersion(intervening[key], versions[key]);
    }
    priorVersion(versions.lifecycle, sourceRelease.stateMachineVersionArn);
    return { amiIds: [release.amiId, interveningRelease.amiId], sourceLifecycleVersion: sourceRelease.stateMachineVersionArn, versions, observers };
}
