import { getBillingDeps } from '@/server/billing/deps';
import { billingV2EntitlementReader, gateComputerStart } from '@/server/billing/v2/compute-access';
import { billingComputeMeter } from '@/server/billing/v2/compute-meter';
import { sharedAwsSdkCollaborators } from './aws-clients';
import { instanceTypeForTier, readAwsAdmissionConfig, readAwsEnrollUrl } from './aws-config';
import { imageDesktopHealthy } from './aws-rebase-health';
import { handleImageRebase } from './aws-rebase-orchestrator';
import { createImageJobStore } from './aws-rebase-store';
import type { PlacementDb } from './placement';
import { plusPlanIds, resolveEntitlement, tierForEntitlement } from './tier';

export async function advanceStagingImageUpdate(db: PlacementDb, computerId: string, ownerUserId: string, allowStart: boolean) {
    const env = process.env;
    if (env.EZIL_AWS_AUTO_REBASE !== '1' || readAwsEnrollUrl(env) !== 'https://os-staging.ezil.work/api/compute/aws/enroll') return false;
    const admission = readAwsAdmissionConfig(env);
    if (!admission.enabled || admission.killSwitch) return false;
    const { starter, executions, describer } = sharedAwsSdkCollaborators(env);
    if (!starter || !executions || !describer?.describeSnapshot) return false;
    const result = await handleImageRebase({
        store: createImageJobStore(db, env), env, starter, executions, now: () => new Date(), meter: billingComputeMeter(),
        describer: { describeSnapshot: describer.describeSnapshot.bind(describer), describeVolume: describer.describeVolume.bind(describer),
            describeForEnrollment: describer.describeForEnrollment.bind(describer) },
        desktopHealthy: p => imageDesktopHealthy(p, env),
    }, { schemaVersion: 1, operation: 'prepare', computerId, jobId: null }, {
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
    return result.body.jobId !== null && result.body.phase !== 'failed' && result.body.phase !== 'unconfirmed';
}
