import { getBillingDeps } from '@/server/billing/deps';
import { billingV2EntitlementReader, gateComputerStart } from '@/server/billing/v2/compute-access';
import { billingComputeMeter } from '@/server/billing/v2/compute-meter';
import { sharedAwsSdkCollaborators } from './aws-clients';
import { instanceTypeForTier, isAutomaticImageUpdateAllowed, readAwsAdmissionConfig, supportsAutomaticImageUpdates } from './aws-config';
import { imageDesktopHealthy } from './aws-rebase-health';
import { handleImageRebase, isAutomaticImageJob, type ImageRebaseDeps } from './aws-rebase-orchestrator';
import { createImageJobStore } from './aws-rebase-store';
import type { PlacementDb } from './placement';
import { plusPlanIds, resolveEntitlement, tierForEntitlement } from './tier';

function dependencies(db: PlacementDb): ImageRebaseDeps | null {
    const env = process.env;
    const { starter, executions, describer } = sharedAwsSdkCollaborators(env);
    if (!starter || !executions || !describer?.describeSnapshot) return null;
    return {
        store: createImageJobStore(db, env), env, starter, executions, now: () => new Date(), meter: billingComputeMeter(),
        describer: { describeSnapshot: describer.describeSnapshot.bind(describer), describeVolume: describer.describeVolume.bind(describer),
            describeForEnrollment: describer.describeForEnrollment.bind(describer) },
        desktopHealthy: p => imageDesktopHealthy(p, env),
    };
}

/** Verification can finish already dispatched jobs even after automatic starts are disabled. */
export async function verifyLaunchedAutomaticImageUpdates(db: PlacementDb) {
    if (!supportsAutomaticImageUpdates()) return;
    const deps = dependencies(db);
    if (!deps) return;
    const jobs = (await deps.store.launchedForVerification()).filter(isAutomaticImageJob).slice(0, 3);
    await Promise.all(jobs.map(async job => {
        const result = await handleImageRebase(deps, { schemaVersion: 1, operation: 'verify',
            computerId: job.computerId, jobId: job.jobId });
        if (result.body.failureCode && result.body.failureCode !== 'desktop_unhealthy')
            console.warn('[aws-auto-update] background verification', { phase: result.body.phase, reason: result.body.failureCode });
    }));
}

export async function advanceAutomaticImageUpdate(db: PlacementDb, computerId: string, ownerUserId: string, allowStart: boolean) {
    const env = process.env;
    if (!isAutomaticImageUpdateAllowed(computerId, env)) return false;
    const admission = readAwsAdmissionConfig(env);
    if (!admission.enabled || admission.killSwitch) return false;
    const engine = dependencies(db);
    if (!engine) return false;
    const result = await handleImageRebase(engine, { schemaVersion: 1, operation: 'prepare', computerId, jobId: null }, {
        ownerUserId, allowStart,
        canBoot: async p => {
            const deps = getBillingDeps();
            const entitlement = await resolveEntitlement(ownerUserId, billingV2EntitlementReader(() => deps));
            const tier = tierForEntitlement(entitlement, plusPlanIds(env));
            // Image updates retain the machine type. Regular starts can resize to the newly entitled tier.
            if (entitlement?.grantPending || tier === 'free' || p.instanceType !== instanceTypeForTier(tier)) return false;
            return (await gateComputerStart({ deps, computerId, userId: ownerUserId,
                kind: 'aws-ec2', instanceType: p.instanceType, now: deps.now() })).allowed;
        },
    });
    const { body } = result;
    if (body.failureCode && body.failureCode !== 'desktop_unhealthy') {
        console.warn('[aws-auto-update] Code open', { phase: body.phase, reason: body.failureCode });
        if (allowStart && body.jobId === null && body.failureCode === 'image_job_conflict')
            return advanceAutomaticImageUpdate(db, computerId, ownerUserId, false);
    }
    return body.jobId !== null && (body.eligible || (result.status === 202 && body.failureCode === 'desktop_unhealthy'));
}
