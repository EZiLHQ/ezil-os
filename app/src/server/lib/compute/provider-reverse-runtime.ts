/**
 * AWS → Cloudflare moves (Phase B): the reverse machine's runtime (docs/compute/REVERSE-MOVE-CONTRACT.md §5). It wires
 * `provider-reverse.ts`'s ports to the database, the admission claim, the lifecycle receipts, the Worker import routes
 * and billing, and it owns the sweep's driver (`advanceReverseMoves`, billing-session-sweep's last step, §5.4).
 *
 * - The claim (§5.1) rebuilds the wake's cold replace from the exported builders (§5.1.2) and runs `admitExportBoot`
 *   with the reverse row's `recordExportBoot` inside its transaction. The Step Functions start runs only AFTER that
 *   commits (a start inside it would be authorized against an uncommitted row), with the wake's own undo.
 * - The export boot's receipts are the ordinary receipts in export-boot mode (aws-receipts.ts); its release is
 *   `releaseExportBoot` + the existing `retireUnenrolledHost`. No new placement edge.
 * - Transactions 1 and 2 of the flip (§5.6) and the compensation's final write (§5.7) hold the admission then the
 *   computer lock. No HTTP call is made inside any of them.
 */
import { randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto';
import { after } from 'next/server';

import { admitExportBoot } from './admission';
import { readAwsAdmissionConfig, readAwsEnrollUrl, type Env } from './aws-config';
import { buildEnrollmentUserData, issueEnrollmentNonce, type TunnelClient } from './aws-enroll';
import type { Ec2ComputerResourceFinder, Ec2ReplacementDescriber, Ec2VolumeDescriber } from './aws-clients';
import type { Ec2EnrollmentDescriber } from './aws-enroll';
import type { LifecycleStarter } from './aws-ec2';
import {
    buildLifecycleWork, LifecycleIntentInvalidError, readLifecycleDeployments, type LifecycleDeployment, type LifecycleIntent, type LifecycleWork,
} from './aws-intent';
import { settleReplacementGeneration } from './aws-rebase-generation';
import { applyLifecycleReceipt, retireUnenrolledHost, startLifecycleJob, type LifecycleExecutionReader, type PoolDeps, type ReceiptDeps } from './aws-receipts';
import type { ComputeMeter } from '@/server/billing/v2/compute-meter';
import {
    flipPlacementToCloudflare, lockComputerUnderAdmission, markLifecycleStartUnknown, readPlacement, releaseExportBoot, transitionPlacement,
    withAdmission, type Placement, type PlacementDb,
} from './placement';
import {
    advanceReverseMove, reverseBootSettled, reverseReadyToFlip, sweepReverseMoves, type ReverseClaimOutcome, type ReversePorts,
} from './provider-reverse';
import { createProviderReverseStore, reverseMovesTablePresent, type ComputeReverseMove } from './provider-reverse-store';

/** §5.1.2: the boot's 15 min plus the host's own hard hold bound (185 min after its job starts, §2.5 step 7). */
export const EXPORT_BOOT_LEASE_MS = 200 * 60_000;

/**
 * The export boot's lifecycle intent: the wake's private `replaceIntent` field for field (aws-ec2.ts), for the same
 * STOPPED placement, at generation N+1 and lease epoch E+1, keeping the placement's own type (no resize). Only `jobId`,
 * `fenceToken` and the nonce inside `userData` differ from the wake's (the §5.1.2 parity test drives aws-ec2.ts).
 */
export function exportBootIntent(p: Placement, deployment: LifecycleDeployment,
    next: { jobId: string; fenceToken: string; leaseEpoch: number; userData: string }): LifecycleIntent {
    return {
        schemaVersion: 1, jobId: next.jobId, computerId: p.computerId.toLowerCase(), revision: 1, operation: 'replace',
        targetGeneration: p.generation + 1, fenceToken: next.fenceToken, providerInstanceId: null, dataVolumeId: p.volumeId,
        previousGeneration: p.generation, previousInstanceId: p.instanceId, previousFenceToken: p.fenceToken, deployment,
        instanceType: p.instanceType!, dataVolumeGiB: null, leaseEpoch: next.leaseEpoch, userData: next.userData,
    };
}

/** The AWS collaborators the receipts and the lifecycle starts need (`defaultAwsCollaborators`, compute-dispatch.ts). */
export interface ReverseAwsCollaborators {
    starter?: LifecycleStarter;
    executions?: LifecycleExecutionReader;
    tunnels?: TunnelClient;
    describer?: Pick<Ec2EnrollmentDescriber, 'describeForEnrollment'> & Partial<Ec2VolumeDescriber & Ec2ReplacementDescriber & Ec2ComputerResourceFinder>;
    meter?: ComputeMeter;
}
/** Billing, as the machine reads it: the paid standing (and its sku, for §5.6 step 4) and an open epoch while metering. */
export interface ReverseBilling {
    standing(userId: string): Promise<{ paid: boolean; sku: string | null }>;
    openEpoch(computerId: string): Promise<boolean>;
}

/** Billing v3's own reads: `deriveStanding` + `paidAccess` (standing.ts), the plan's sku, `openEpochFor` while metering is active. */
export function billingForReverseMoves(): ReverseBilling {
    const deps = async () => (await import('@/server/billing/deps')).getBillingDeps();
    return {
        async standing(userId) {
            const billing = await deps();
            const [{ deriveStanding, paidAccess }, { planFromSubscriptions }] = await Promise.all([
                import('@/server/billing/v3/standing'), import('@/server/billing/v3/catalog')]);
            const now = billing.now();
            const [subscriptions, paymentIssues] = await Promise.all([billing.store.subscriptionsFor(userId), billing.store.openPaymentIssues(userId)]);
            const { standing } = deriveStanding({ subscriptions, paymentIssues, placementProvider: null, now });
            return { paid: paidAccess(standing), sku: planFromSubscriptions({ subs: subscriptions, now, userCreatedAt: null }).sku };
        },
        async openEpoch(computerId) {
            const billing = await deps();
            const { billingMeteringActive } = await import('@/server/billing/v2/compute-access');
            return billingMeteringActive(billing.config) && (await billing.store.openEpochFor(computerId)) !== null;
        },
    };
}

/** The Worker's import routes for this move (§4), on the move's own sandbox name and the export boot's counters. */
async function workerFor(m: ComputeReverseMove) {
    const client = await import('../cloudflare-guacamole-provider');
    const name = client.deriveGuacamoleSandboxId(m.userId, m.computerId);
    const boot = m.exportBoot!;
    const ids = { moveId: m.id, generation: m.generation, computerId: m.computerId };
    return { client, name, ids, binding: { ...ids, placementGeneration: boot.placementGeneration, leaseEpoch: boot.leaseEpoch } };
}

export function createReverseRuntime(db: PlacementDb, options: {
    env?: Env;
    aws?: ReverseAwsCollaborators;
    pool?: PoolDeps;
    billing?: ReverseBilling;
    clock?: () => number;
    newId?: () => string;
    randomBytes?: (n: number) => Buffer;
    sleep?: (ms: number) => Promise<void>;
} = {}): ReversePorts {
    const env = () => options.env ?? process.env;
    const aws = options.aws ?? {};
    const billing = options.billing ?? billingForReverseMoves();
    const newId = options.newId ?? randomUUID;
    const store = createProviderReverseStore(db);
    const receiptDeps = (): ReceiptDeps & { newId: () => string } => ({ db, ...aws, ...(options.pool ? { pool: options.pool } : {}), newId,
        ...(options.sleep ? { sleep: options.sleep } : {}) });
    const deploymentFor = (region: string | null): LifecycleDeployment | null => {
        const config = readAwsAdmissionConfig(env());
        if (!config.enabled || !region) return null;
        const d = readLifecycleDeployments(env(), config.regions.map(r => r.name));
        return d.ok ? d.deployments[region] ?? null : null;
    };
    const placement = async (computerId: string) => (await readPlacement(db, computerId)).record;

    return {
        store,
        clock: options.clock ?? Date.now,
        killSwitchOn() {
            const config = readAwsAdmissionConfig(env());
            return config.enabled && config.killSwitch;
        },
        paid: async userId => (await billing.standing(userId)).paid,
        openEpoch: computerId => billing.openEpoch(computerId),
        readPlacement: placement,

        async claim(m, p): Promise<ReverseClaimOutcome> {
            const e = env();
            const config = readAwsAdmissionConfig(e);
            if (!config.enabled) return { admitted: false, reason: config.reason };
            const deployments = readLifecycleDeployments(e, config.regions.map(r => r.name));
            // A deployment that cannot start a lifecycle job is configuration, never this computer's fault (try later).
            if (!deployments.ok || !aws.starter || !readAwsEnrollUrl(e)) return { admitted: false, reason: 'aws_config_invalid' };
            const deployment = deployments.deployments[p.region ?? ''];
            if (!deployment) return { admitted: false, reason: 'region_not_configured' };
            // An incomplete legacy row cannot be replaced (the wake answers aws_placement_incomplete): a wait with an anomaly
            // line, never a guess (contract gap: no pinned code; the deadline pass ends it boot_unavailable).
            if (!p.volumeId || !p.fsUuid || !p.fenceToken || !p.instanceType || !p.instanceId) return { admitted: false, reason: 'placement_incomplete' };
            const now = new Date();
            const nonce = issueEnrollmentNonce(now, options.randomBytes ?? nodeRandomBytes);
            const fenceToken = newId(), leaseEpoch = p.leaseEpoch + 1;
            const userData = buildEnrollmentUserData({ computerId: p.computerId, volumeId: p.volumeId, fsUuid: p.fsUuid, generation: p.generation + 1,
                leaseEpoch, nonce: nonce.nonce, provision: false, enrollUrl: readAwsEnrollUrl(e)! });
            let work: LifecycleWork;
            // Built BEFORE admission, so an intent the deployment refuses (say, its instanceTypes no longer list this
            // computer's type) leases nothing and starts nothing: a wait, never a throw that skips the row's deadline.
            try { work = buildLifecycleWork(exportBootIntent(p, deployment, { jobId: newId(), fenceToken, leaseEpoch, userData })); } catch (error) {
                if (error instanceof LifecycleIntentInvalidError) return { admitted: false, reason: 'intent_invalid' };
                throw error;
            }
            let recorded: ComputeReverseMove | null = null;
            const outcome = await admitExportBoot(db, {
                userId: m.userId, computerId: m.computerId, expected: { generation: p.generation, leaseEpoch: p.leaseEpoch },
                leaseUntil: new Date(now.getTime() + EXPORT_BOOT_LEASE_MS),
                fields: { fenceToken, enrollNonceHash: nonce.nonceHash, enrollExpiresAt: nonce.expiresAt, enrollConsumedHash: null,
                    lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null },
            }, async (tx, leased) => {
                recorded = await createProviderReverseStore(tx).recordExportBoot(m, { placementGeneration: leased.generation, leaseEpoch: leased.leaseEpoch,
                    region: leased.region!, volumeId: leased.volumeId!, jobId: work.intent.jobId, instanceId: null, fsUuid: leased.fsUuid, claimedAt: now.toISOString() });
            }, { env: e, now: () => now });
            if (!outcome.admitted) return { admitted: false, reason: outcome.reason };
            // After commit: the wake's own start and undo (aws-ec2.ts `launch`), a replace's undo being UNCONFIRMED.
            const leased = outcome.placement;
            try {
                const started = await startLifecycleJob(aws.starter, leased.region!, work, options.sleep);
                if (started === 'started') {
                    await transitionPlacement(db, { computerId: leased.computerId, ownerUserId: m.userId, expected: leased, to: 'STARTING' });
                } else if (started === 'refused') {
                    if (await settleReplacementGeneration(receiptDeps(), leased, { ...work, intent: work.intent }, true) !== 'settled')
                        await transitionPlacement(db, { computerId: leased.computerId, ownerUserId: m.userId, expected: leased, to: 'UNCONFIRMED',
                            fields: { enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null } });
                } else {
                    await markLifecycleStartUnknown(db, { computerId: leased.computerId, ownerUserId: m.userId, expected: leased, undo: 'UNCONFIRMED' });
                }
            } catch (error) {
                // The claim committed (the row is `booting`): a failed write after it leaves the boot LEASED with its job,
                // which the `booting` pass hands to the receipts, bounded by boot_timeout (§5.4). Never "not admitted".
                console.warn('[reverse-move] error', { moveId: m.id, step: 'claim_start', error: error instanceof Error ? error.message.slice(0, 80) : 'unknown' });
            }
            return { admitted: true, move: recorded! };
        },

        async settleBoot(p) {
            const deployment = deploymentFor(p.region);
            if (deployment) await applyLifecycleReceipt(receiptDeps(), p, deployment);
        },
        async releaseBoot(p, boot) {
            const released = await releaseExportBoot(db, p, { placementGeneration: boot.placementGeneration, leaseEpoch: boot.leaseEpoch });
            if (released.ok) await retireUnenrolledHost(receiptDeps(), released.placement, deploymentFor(released.placement.region) ?? undefined);
        },
        async retireHost(p) {
            await retireUnenrolledHost(receiptDeps(), p, deploymentFor(p.region) ?? undefined);
        },

        worker: {
            async begin(m) { const w = await workerFor(m); return w.client.migrateImportBegin(w.name, w.binding); },
            async pull(m, from, count) { const w = await workerFor(m); return w.client.migrateImportPull(w.name, { ...w.binding, from, count }); },
            async verify(m) {
                const w = await workerFor(m);
                return w.client.migrateImportCommit(w.name, { ...w.ids, sha256: m.exportHead!.sha256, chunkCount: m.exportHead!.chunks.length, verifyOnly: true });
            },
            async commit(m) {
                const w = await workerFor(m);
                return w.client.migrateImportCommit(w.name, { ...w.ids, sha256: m.exportHead!.sha256, chunkCount: m.exportHead!.chunks.length, verifyOnly: false });
            },
            async abort(m) { const w = await workerFor(m); return w.client.migrateImportAbort(w.name, w.ids); },
        },

        async toFlipping(m) {
            const boot = m.exportBoot!;
            try {
                return await withAdmission(db, async (tx, lock) => {
                    await lockComputerUnderAdmission(tx, lock, m.computerId);
                    const locked = createProviderReverseStore(tx);
                    const current = await locked.readById(m.id);
                    if (!current || current.state !== 'checking' || current.updatedAt !== m.updatedAt) return 'not_ready' as const;
                    if (!reverseReadyToFlip((await readPlacement(tx, m.computerId)).record, boot)) return 'not_ready' as const;
                    // 🔴 The entitlement re-check in the SAME transaction that sets commit_sent_at (§5.8): paid before it → compensate.
                    if ((await billing.standing(m.userId)).paid) return 'paid' as const;
                    return locked.advance(current, 'flipping');
                });
            } catch (error) {
                // Unknown (a billing or placement read failed): never past the point of no return on an unknown standing.
                console.warn('[reverse-move] flip check unavailable', { moveId: m.id, error: error instanceof Error ? error.name : 'unknown' });
                return 'not_ready';
            }
        },
        async flip(m, storeKind) {
            const boot = m.exportBoot!;
            let done: ComputeReverseMove | null = null;
            await flipPlacementToCloudflare(db, { computerId: m.computerId, ownerUserId: m.userId, store: storeKind,
                expected: { placementGeneration: boot.placementGeneration, leaseEpoch: boot.leaseEpoch, volumeId: boot.volumeId },
                finishInTx: async tx => {
                    done = await createProviderReverseStore(tx).finish(m, { awsVolumeId: boot.volumeId, awsFsUuid: boot.fsUuid, awsSnapshotId: null });
                } });
            return done!;
        },
        async afterCommit(m) {
            // §5.6 step 4 / §5.8: a resubscribe after commit_sent_at gets the forward move onto a fresh volume. Mandatory:
            // `invoice.paid` during the move skipped this computer (not Cloudflare then). The retained volume is rollback-only.
            const { paid, sku } = await billing.standing(m.userId);
            if (!paid || (sku !== 'standard_monthly_v3' && sku !== 'premium_monthly_v3')) return;
            await (await import('./provider-migrate-runtime')).startPaidMigration(m.userId, sku);
        },
        async failSettled(m, to, reason) {
            const boot = m.exportBoot!;
            return withAdmission(db, async (tx, lock) => {
                await lockComputerUnderAdmission(tx, lock, m.computerId);
                if (!reverseBootSettled((await readPlacement(tx, m.computerId)).record, boot)) return null;
                return createProviderReverseStore(tx).fail(m, to, reason);
            });
        },
        log(event, fields) {
            console.warn(`[reverse-move] ${event}`, fields);
        },
    };
}

/** The production collaborators: the routers' own AWS collaborators and pool deps (lazy: this runs in the billing sweep). */
async function productionRuntime(db: PlacementDb): Promise<ReversePorts> {
    const [{ defaultAwsCollaborators }, { createPoolDeps }] = await Promise.all([
        import('@/server/api/routers/compute-dispatch'), import('./aws-pool-runtime')]);
    return createReverseRuntime(db, { aws: defaultAwsCollaborators(process.env), pool: createPoolDeps(db, process.env) });
}

/** Lane O's seam module (§7.2): `reverse-snapshot.ts` is lane O's file, loaded only by the snapshot step. */
type ReverseSnapshotSeam = { advanceReverseSnapshots(input: { deadlineMs: number }): Promise<{ status: string }> };

/**
 * billing-session-sweep's last step (§5.4): after `drain()` on both of its paths. Returns at once without 0012 (production)
 * and does nothing later than the handler's start + 150 s. Lane O's `advanceReverseSnapshots` (§7.2, `reverse-snapshot.ts`)
 * runs first in the pass, awaited. 🔴 Never throws out of the billing handler.
 * 🔴 The seam is loaded INSIDE the snapshot step, whose own guard turns any fault (a load failure included) into
 * `snapshot: 'error'`: the pass still claims and drives its rows, because only it enforces their deadlines.
 */
export async function advanceReverseMoves(handlerStartedAt = Date.now(), context: {
    db?: PlacementDb;
    ports?: ReversePorts;
    snapshots?: (input: { deadlineMs: number }) => Promise<{ status: string }>;
    loadSnapshots?: () => Promise<ReverseSnapshotSeam>;
    clock?: () => number;
} = {}): Promise<void> {
    try {
        const db = context.db ?? (await import('@/server/db')).db as unknown as PlacementDb;
        const load = context.loadSnapshots ?? (() => import('./reverse-snapshot'));
        const snapshots = context.snapshots ?? (async (input: { deadlineMs: number }) => (await load()).advanceReverseSnapshots(input));
        let ports: ReversePorts | undefined = context.ports;
        await sweepReverseMoves({
            handlerStartedAt, ...(context.clock ? { clock: context.clock } : {}),
            tablePresent: () => reverseMovesTablePresent(db),
            snapshots,
            claimStale: limit => createProviderReverseStore(db).claimStale(limit),
            drive: async (m, deadlineMs) => advanceReverseMove(ports ??= await productionRuntime(db), m, deadlineMs),
        });
    } catch {
        console.warn('[reverse-move] pass unavailable');
    }
}

/** §5.4: a start, a retry or the open trigger drives its row once right away (60 s), so the first steps never wait for a tick. */
export const REVERSE_IMMEDIATE_DRIVE_MS = 60_000;
export function scheduleReverseMove(moveId: string,
    schedule: (work: () => Promise<void>) => void = work => { try { after(work); } catch { void work().catch(() => {}); } }): void {
    try {
        schedule(async () => {
            try {
                const db = (await import('@/server/db')).db as unknown as PlacementDb;
                const m = await createProviderReverseStore(db).readById(moveId);
                if (m) await advanceReverseMove(await productionRuntime(db), m, Date.now() + REVERSE_IMMEDIATE_DRIVE_MS);
            } catch { console.warn('[reverse-move] immediate drive failed', { moveId }); }
        });
    } catch { /* A scheduling failure never fails the request: the sweep takes the row. */ }
}
