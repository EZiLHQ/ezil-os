import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { billingV2EntitlementReader } from '@/server/billing/v2/compute-access';
import { billingComputeMeter } from '@/server/billing/v2/compute-meter';
import { deriveGuacamoleSandboxId, migrateBegin, migrateAbort, migrateCommit, migrateReopen, migrateExport, migrateExportHead } from '../cloudflare-guacamole-provider';
import { decideAdmission } from './admission';
import { AWS_TIER_DATA_GIB, awsTierForSize, instanceTypeForTier, readAwsAdmissionConfig, readAwsEnrollUrl } from './aws-config';
import { sharedAwsSdkCollaborators } from './aws-clients';
import { buildAwsProvisionUserData } from './aws-ec2';
import { issueEnrollmentNonce } from './aws-enroll';
import { buildLifecycleWork, readLifecycleDeployments, type LifecycleWork } from './aws-intent';
import { readMigrationReadyReceipt, startLifecycleJob } from './aws-receipts';
import { isExecutionAbsent, toAwsClientError } from './aws-errors';
import { cloudflareComputeProvider } from './cloudflare';
import { flipPlacementToAws, rollbackMigrationPlacement, readAdmissionCounters, readPlacement, withAdmission, type Placement, type PlacementDb } from './placement';
import { advanceMigration, MigrationStepError, type MigrationDeps } from './provider-migrate-orchestrator';
import { createProviderMigrationStore, type ComputeMigration } from './provider-migrate-store';
import { provisionFor } from './provider-migrate-provision';
import { restoreFetchBase, restoreLeaseFor } from './provider-migrate';
import { utcMonthStart } from './usage';

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows?: Record<string, unknown>[] })?.rows) as Record<string, unknown>[] ?? [];
export async function migrationStore() {
    const { db } = await import('@/server/db');
    return createProviderMigrationStore(db);
}

export async function defaultMigrationDeps() {
    const { db } = await import('@/server/db');
    return createMigrationRuntime(db);
}
export function createMigrationRuntime(db: PlacementDb, options: {
    env?: import('./aws-config').Env;
    entitlement?: import('./tier').EntitlementReader;
    collaborators?: import('./aws-clients').AwsSdkCollaborators;
} = {}) {
    const store = createProviderMigrationStore(db);
    const sandbox = (m: ComputeMigration) => deriveGuacamoleSandboxId(m.userId, m.computerId);
    const sdk = () => options.collaborators ?? sharedAwsSdkCollaborators(options.env ?? process.env);
    const deps: MigrationDeps & { store: typeof store } = {
        store,
        async exclusive(id, run) {
            await db.transaction(async tx => {
                const lock = rows(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(1163554093, hashtext(${id})) AS acquired`))[0];
                if (lock?.acquired === true) await run();
            });
        },
        begin: m => migrateBegin(sandbox(m)),
        head: (m, kind) => migrateExportHead(sandbox(m), kind),
        async exportEtag(m) {
            const result = await migrateExport(sandbox(m), 'workspace');
            if (!result.ok) throw new MigrationStepError(result.error === 'unavailable');
            const etag = result.data.headers.get('etag');
            await result.data.body?.cancel();
            if (!etag) throw new MigrationStepError(false);
            return etag.replace(/^"|"$/g, '');
        },
        async provision(m) {
            // A crash after recording the intent never rotates a boot's capability or launches twice.
            if (provisionFor(m)) return;
            const entitlement = await (options.entitlement ?? billingV2EntitlementReader()).read(m.userId);
            if (!entitlement || entitlement.status !== 'active' || entitlement.paymentIssue || entitlement.provider !== 'aws'
                || !['standard_monthly_v3', 'premium_monthly_v3'].includes(entitlement.planId ?? '')) throw new MigrationStepError(false);
            const size = entitlement.planId === 'standard_monthly_v3' ? 'std-2' : entitlement.size;
            const tier = size && awsTierForSize(size);
            if (!tier || tier === 'free') throw new MigrationStepError(false);
            const env = options.env ?? process.env, config = readAwsAdmissionConfig(env), now = new Date();
            if (!config.enabled) throw new MigrationStepError(true);
            const deployments = readLifecycleDeployments(env, config.regions.map(r => r.name));
            const enrollUrl = readAwsEnrollUrl(env), starter = sdk().starter;
            if (!deployments.ok || !enrollUrl || !starter || !deployments.deployments['ap-south-1']) throw new MigrationStepError(true);
            const deployment = deployments.deployments['ap-south-1'];
            let work: LifecycleWork | undefined;
            await withAdmission(db, async (tx, lock) => {
                const currentStore = createProviderMigrationStore(tx), current = await currentStore.readById(m.id);
                if (!current || current.state !== 'exported' || provisionFor(current)) return;
                const counters = await readAdmissionCounters(tx, lock, { userId: m.userId, computerId: m.computerId, now, monthStart: utcMonthStart(now) });
                const decision = decideAdmission({ config, counters, userId: m.userId, now,
                    region: { kind: 'lease', region: 'ap-south-1' }, instanceType: instanceTypeForTier(tier) });
                if (!decision.admit) throw new MigrationStepError(true);
                const source = (await readPlacement(tx, m.computerId)).record;
                if (source && source.provider !== 'cloudflare') throw new MigrationStepError(false);
                const token = await currentStore.mintRestoreToken(current);
                const fresh = (await currentStore.readById(m.id))!;
                const restore = restoreLeaseFor(fresh, token, restoreFetchBase(new URL(enrollUrl).origin, m.computerId));
                const fsUuid = randomUUID(), fenceToken = randomUUID(), nonce = issueEnrollmentNonce(now);
                const userData = buildAwsProvisionUserData({ computerId: m.computerId, volumeId: null, fsUuid,
                    generation: 1, leaseEpoch: 1, nonce: nonce.nonce, provision: true, enrollUrl, restore });
                work = buildLifecycleWork({ schemaVersion: 1, jobId: randomUUID(), computerId: m.computerId, revision: 1,
                    operation: 'provision', targetGeneration: 1, fenceToken, providerInstanceId: null, dataVolumeId: null,
                    previousGeneration: null, previousInstanceId: null, previousFenceToken: null, deployment,
                    instanceType: instanceTypeForTier(tier), dataVolumeGiB: AWS_TIER_DATA_GIB[tier], leaseEpoch: 1, userData });
                const placement: Placement = { computerId: m.computerId, ownerUserId: m.userId, provider: 'aws-ec2', store: 'ebs',
                    state: 'PROVISIONING', generation: 1, leaseEpoch: 1, region: 'ap-south-1', zoneId: deployment.zoneId,
                    instanceId: null, volumeId: null, instanceType: instanceTypeForTier(tier), fsUuid, fenceToken,
                    enrollNonceHash: nonce.nonceHash, enrollExpiresAt: nonce.expiresAt, enrollConsumedHash: null,
                    tunnelId: null, leaseUntil: new Date(now.getTime() + 3600_000), presenceAt: null,
                    lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null, updatedAt: now };
                await currentStore.saveProvision(fresh, { placement, deployment, source, reservedAt: now.toISOString() });
            });
            if (work && await startLifecycleJob(starter, 'ap-south-1', work) === 'refused') throw new MigrationStepError(false);
        },
        async restored(m) {
            const current = (await store.readById(m.id))!, intent = provisionFor(current), executions = sdk().executions;
            if (!intent || !executions) throw new MigrationStepError(true);
            let ready: boolean;
            try { ready = await readMigrationReadyReceipt(executions, intent.placement, intent.deployment); }
            catch (error) {
                // A recorded launch whose response was lost may not be visible yet.
                if (isExecutionAbsent(error) && Date.now() - Date.parse(intent.reservedAt) < 5 * 60_000) return false;
                if (error instanceof Error && error.message.startsWith('migration_')) throw error;
                if (toAwsClientError(error).retryable) throw new MigrationStepError(true);
                throw error;
            }
            if (!ready && Date.now() - Date.parse(intent.reservedAt) > 15 * 60_000) throw new MigrationStepError(false);
            return ready;
        },
        async flip(m) {
            const current = (await store.readById(m.id))!, p = provisionFor(current)?.placement;
            if (!p?.instanceId || !p.volumeId || !p.fsUuid) throw new MigrationStepError(false);
            await flipPlacementToAws(db, { computerId: m.computerId, ownerUserId: m.userId, migrationId: m.id,
                pendingReady: true, fields: { ...p, lastError: `migration_pending:${m.id}`, region: 'ap-south-1', instanceId: p.instanceId, volumeId: p.volumeId, fsUuid: p.fsUuid } });
        },
        async rollback(m) {
            const intent = provisionFor(m);
            if (intent) await rollbackMigrationPlacement(db, m, intent.source);
            // Retain the non-secret intent/capacity reservation for operator cleanup of a failed AWS boot.
            // It is never routed to a user and cannot open a billing epoch.
        },
        commit: (m, input) => migrateCommit(sandbox(m), input),
        abort: m => migrateAbort(sandbox(m)),
        reopen: (m, expectedMigratedEtag) => expectedMigratedEtag === m.sourceEtag
            ? migrateAbort(sandbox(m)) : migrateReopen(sandbox(m), { expectedMigratedEtag }),
        async stopCloudflare(m) {
            const result = await cloudflareComputeProvider.stop({ correlationId: m.id }, m, 'user');
            if (!result.ok) throw new MigrationStepError(true);
            await billingComputeMeter().stopped({ ...m, endedAt: new Date(), reason: 'provider_stop' });
        },
    };
    return deps;
}

export async function startPaidMigration(userId: string, sku: string, context?: {
    db: PlacementDb; deps: ReturnType<typeof createMigrationRuntime>;
}): Promise<void> {
    if (!['standard_monthly_v3', 'premium_monthly_v3'].includes(sku)) return;
    const db = context?.db ?? (await import('@/server/db')).db;
    const deps = context?.deps ?? createMigrationRuntime(db);
    const computers = rows(await db.execute(sql`SELECT id::text FROM public.ezil_computers
        WHERE user_id = ${userId}::uuid AND deleted_at IS NULL ORDER BY slot LIMIT 2`));
    for (const computer of computers) {
        const computerId = String(computer.id);
        if ((await readPlacement(db, computerId)).provider !== 'cloudflare') continue;
        const m = await deps.store.createOrGetActive({ computerId, userId, toSize: sku === 'standard_monthly_v3' ? 'standard' : 'premium' });
        try {
            // Begin immediately, and keep moving while each single-step call makes progress.
            for (let step = 0; step < 6; step++) {
                const before = await deps.store.readById(m.id);
                await advanceMigration(deps, m.id);
                const after = await deps.store.readById(m.id);
                if (before?.state === after?.state) break;
            }
        } catch { console.warn('[compute.migration]', { migrationId: m.id }); }
    }
}
