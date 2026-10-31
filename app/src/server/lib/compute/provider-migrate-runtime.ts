import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { billingV2EntitlementReader } from '@/server/billing/v2/compute-access';
import { billingComputeMeter } from '@/server/billing/v2/compute-meter';
import { deriveGuacamoleSandboxId, migrateBegin, migrateAbort, migrateCommit, migrateReopen, migrateExport, migrateExportHead } from '../cloudflare-guacamole-provider';
import { decideAdmission } from './admission';
import { AWS_TIER_DATA_GIB, awsTierForSize, instanceTypeForTier, readAwsAdmissionConfig, readAwsEnrollUrl } from './aws-config';
import { sharedAwsSdkCollaborators } from './aws-clients';
import { buildAwsProvisionUserData, type LifecycleStarter } from './aws-ec2';
import { issueEnrollmentNonce, type Ec2EnrollmentView } from './aws-enroll';
import { buildLifecycleWork, currentGenerationIntent, LifecycleIntentInvalidError, readLifecycleDeployments, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { ENROLL_HOST_RETIRE_RETRY_MS, LifecycleReceiptSchema, lifecycleExecutionArn, readMigrationReadyReceipt, START_SETTLE_MS, startLifecycleJob } from './aws-receipts';
import { isExecutionAbsent, toAwsClientError } from './aws-errors';
import { cloudflareComputeProvider } from './cloudflare';
import { finishFreshProvision, flipPlacementToAws, rollbackMigrationPlacement, readAdmissionCounters, readPlacement, withAdmission, type Placement, type PlacementDb } from './placement';
import { advanceMigration, MigrationStepError, type MigrationDeps } from './provider-migrate-orchestrator';
import { createProviderMigrationStore, type ComputeMigration } from './provider-migrate-store';
import { provisionFor, type MigrationProvision, type MigrationProvisionHoldReason } from './provider-migrate-provision';
import { restoreFetchBase, restoreLeaseFor } from './provider-migrate';
import { utcMonthStart } from './usage';

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows?: Record<string, unknown>[] })?.rows) as Record<string, unknown>[] ?? [];
const TERMINAL_EXECUTION: readonly string[] = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'];
const HOLD_SIGNAL_INTERVAL_MS = 10 * 60_000;

/** The launch's own receipt, only when it is bound to this exact intent. */
function launchReceipt(p: Placement, output: string | null | undefined) {
    let parsed;
    try { parsed = LifecycleReceiptSchema.safeParse(JSON.parse(output ?? 'null')); } catch { return null; }
    if (!parsed.success) return null;
    const r = parsed.data;
    return r.jobId === p.lifecycleJobId && r.digest === p.lifecycleDigest && r.computerId === p.computerId.toLowerCase()
        && r.generation === p.generation && r.leaseEpoch === p.leaseEpoch && r.fenceToken === p.fenceToken && r.state === 'running' ? r : null;
}
/** Infra `tagsFor`: the tags the provision stamped on this boot's instance. */
function bootTagsMatch(tags: Readonly<Record<string, string>>, p: Placement, namespace: string): boolean {
    return tags['ezil:managed-by'] === 'app-computer-platform' && tags['ezil:stage'] === namespace
        && tags['ezil:computer-id'] === p.computerId.toLowerCase() && tags['ezil:generation'] === String(p.generation)
        && !!p.fenceToken && tags['ezil:fence-token'] === p.fenceToken;
}
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
    /**
     * Keep a failed boot reserved for an operator. The CAS-written marker bounds the
     * `migration-boot-held` warning to one per row per `HOLD_SIGNAL_INTERVAL_MS`; a lost CAS emits nothing.
     */
    async function hold(m: ComputeMigration, intent: MigrationProvision, reason: MigrationProvisionHoldReason, instanceId: string | null): Promise<void> {
        const held = intent.held, now = new Date();
        const due = !held || !(now.getTime() - Date.parse(held.signalledAt) < HOLD_SIGNAL_INTERVAL_MS);
        if (held && !due && held.reason === reason) return;
        const since = held?.reason === reason ? held.since : now.toISOString();
        await store.saveProvision(m, { ...intent, held: { reason, since, signalledAt: held && !due ? held.signalledAt : now.toISOString() } });
        if (due) console.warn(JSON.stringify({ event: 'migration-boot-held', reason, migrationId: m.id,
            computer: m.computerId.slice(0, 8), instanceId, since }));
    }
    /**
     * End a failed migration's still-live boot through the lifecycle `retire` job, as
     * `retireUnenrolledHost` does for a cold boot: the job is recorded by CAS first, so the
     * authority finds it, then started. The helper stops and terminates the instance and keeps
     * the data volume (R11); after reopen the Cloudflare copy is authoritative. A refused or
     * failed retire is re-issued no sooner than `ENROLL_HOST_RETIRE_RETRY_MS` after the last.
     * Every boot left live here is held and signalled.
     */
    async function retireFailedBoot(m: ComputeMigration, intent: MigrationProvision, p: Placement,
        instance: Ec2EnrollmentView, deployment: LifecycleDeployment | undefined, starter: LifecycleStarter | undefined): Promise<void> {
        if (!starter) return hold(m, intent, 'no_starter', p.instanceId);
        if (!deployment) return hold(m, intent, 'no_deployment', p.instanceId);
        // Without its identity no retire can be built, as with an invalid intent below.
        if (!p.region || !p.volumeId || !p.fenceToken || !p.instanceType) return hold(m, intent, 'retire_failed', p.instanceId);
        // Never act on an instance this boot did not launch: its tags carry this intent's fence.
        if (deployment.namespace !== intent.deployment.namespace || !bootTagsMatch(instance.tags, p, intent.deployment.namespace))
            return hold(m, intent, 'foreign_instance', p.instanceId);
        // The recorded retire ended (or never started) with the boot still live.
        if (intent.retire && Date.now() - Date.parse(intent.retire.requestedAt) < ENROLL_HOST_RETIRE_RETRY_MS)
            return hold(m, intent, 'retire_failed', p.instanceId);
        // The authority reads a published AWS placement first and would refuse this retire.
        if ((await readPlacement(db, m.computerId)).provider === 'aws-ec2') return hold(m, intent, 'aws_placement_published', p.instanceId);
        let work: LifecycleWork;
        try {
            work = buildLifecycleWork(currentGenerationIntent(p, 'retire', deployment, { jobId: randomUUID(), userData: null, leaseEpoch: p.leaseEpoch }));
        } catch (error) {
            if (error instanceof LifecycleIntentInvalidError) return hold(m, intent, 'retire_failed', p.instanceId);
            throw error;
        }
        await store.saveProvision(m, { ...intent, retire: { jobId: work.intent.jobId, digest: work.digest, requestedAt: new Date().toISOString(),
            executionArn: lifecycleExecutionArn(deployment, work.intent.jobId) } });
        const outcome = await startLifecycleJob(starter, p.region, work);
        console.info('[compute.migration.retire]', { migrationId: m.id, computerId: m.computerId, instanceId: p.instanceId, jobId: work.intent.jobId, outcome });
    }
    const deps: MigrationDeps & { store: typeof store } = {
        store,
        async exclusive(id, run) {
            await db.transaction(async tx => {
                const lock = rows(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(1163554093, hashtext(${id})) AS acquired`))[0];
                if (lock?.acquired === true) await run();
            });
        },
        begin: m => migrateBegin(sandbox(m)),
        async freshProvision(m) {
            const config = readAwsAdmissionConfig(options.env ?? process.env);
            if (!config.enabled || config.killSwitch) throw new MigrationStepError(true);
            await finishFreshProvision(db, m, async () => {
                const result = await migrateBegin(sandbox(m));
                return !result.ok && result.error === 'conflict' && result.reason === 'no_workspace';
            });
        },
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
        async releaseProvision(m) {
            if (!['failed_reopened', 'failed_needs_operator'].includes(m.state)) return;
            const intent = provisionFor(m);
            if (!intent || intent.released === true) return;
            const p = intent.placement, { executions, describer, starter } = sdk();
            // A missing job identity is not proof that the launch never started.
            if (!p.region || !p.lifecycleJobId || !executions) return;
            let launch: Awaited<ReturnType<typeof executions.describe>> | null = null;
            try {
                launch = await executions.describe(p.region, lifecycleExecutionArn(intent.deployment, p.lifecycleJobId));
                if (!TERMINAL_EXECUTION.includes(launch.status)) return;
            } catch (error) {
                // Match restore's visibility grace for an accepted start whose response was lost.
                if (!isExecutionAbsent(error) || !(Date.now() - Date.parse(intent.reservedAt) >= 5 * 60_000)) return;
            }
            const deployments = readLifecycleDeployments(options.env ?? process.env, [p.region]);
            const deployment = deployments.ok ? deployments.deployments[p.region] : undefined;
            // A recorded retire settles before anything else: never release under a running retire.
            if (intent.retire) {
                try {
                    const retire = await executions.describe(p.region, intent.retire.executionArn);
                    if (!TERMINAL_EXECUTION.includes(retire.status)) return;
                } catch (error) {
                    if (!isExecutionAbsent(error) || Date.now() - Date.parse(intent.retire.requestedAt) < START_SETTLE_MS) return;
                }
            }
            // Enrollment records the boot's identity; a host that never enrolled is named by the launch receipt.
            let instanceId = p.instanceId, volumeId = p.volumeId;
            // An unidentified boot stays held after Step Functions expires its launch (~90 days).
            if (intent.held?.reason === 'receipt_invalid') return hold(m, intent, 'receipt_invalid', instanceId);
            if (launch?.status === 'SUCCEEDED' && (instanceId === null || volumeId === null)) {
                const receipt = launchReceipt(p, launch.output);
                // A succeeded launch whose instance cannot be identified stays reserved for an operator.
                if (!receipt || (instanceId !== null && receipt.instanceId !== instanceId)) return hold(m, intent, 'receipt_invalid', instanceId);
                instanceId = receipt.instanceId; volumeId = receipt.volumeId;
            }
            if (instanceId !== null) {
                if (!describer || !/^i-[a-f0-9]{17}$/.test(instanceId)) return;
                const instance = await describer.describeForEnrollment(p.region, instanceId);
                if (instance !== null && instance.instanceId !== instanceId) return;
                if (instance !== null && !['stopped', 'terminated'].includes(instance.state)) {
                    // Only a live boot of THIS intent is retired; anything in transition or unknown waits.
                    if (!['pending', 'running'].includes(instance.state)) return;
                    await retireFailedBoot(m, intent, { ...p, instanceId, volumeId }, instance, deployment, starter);
                    return;
                }
            }
            // The terminal execution cannot launch again. CAS also rejects any changed boot evidence.
            await store.saveProvision(m, { ...intent, released: true });
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
            // Retain the non-secret intent/capacity reservation: the stale sweep retires a still-live
            // failed boot through its lifecycle job, then releases it (`releaseProvision`).
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
