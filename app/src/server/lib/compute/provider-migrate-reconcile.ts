import { decideAdmission } from './admission';
import { awsTierForSize, instanceTypeForTier, readAwsAdmissionConfig, type Env } from './aws-config';
import { paidCloudflareCandidates, readAdmissionCounters, withAdmission, type PaidMigrationCandidate, type PlacementExecutor } from './placement';
import { advanceMigration } from './provider-migrate-orchestrator';
import { utcMonthStart } from './usage';

export type { PaidMigrationCandidate } from './placement';

export { paidCloudflareCandidates } from './placement';

/** The sweep shares its launch budget with existing migration recovery. */
export async function reconcilePaidMigrations(input: {
    enabled: boolean;
    startedAt: number;
    now?: () => number;
    candidates(limit: number): Promise<PaidMigrationCandidate[]>;
    admitted(candidate: PaidMigrationCandidate): Promise<boolean>;
    create(candidate: PaidMigrationCandidate): Promise<{ id: string }>;
    advance(id: string): Promise<void>;
}): Promise<number> {
    if (!input.enabled) {
        console.info('[compute.migration.reconcile] AWS admission disabled');
        return 0;
    }
    const now = input.now ?? Date.now;
    const expired = () => now() - input.startedAt >= 40_000;
    if (expired()) return 0;
    let launched = 0;
    for (const candidate of (await input.candidates(10)).slice(0, 10)) {
        if (expired()) break;
        try {
            if (!await input.admitted(candidate)) continue;
            if (expired()) break;
            const migration = await input.create(candidate);
            if (expired()) break; // The durable row can be resumed next minute.
            launched++;
            await input.advance(migration.id);
        } catch { console.warn('[compute.migration.reconcile] candidate deferred'); }
    }
    return launched;
}

export async function reconcilePaidCloudflareUsers(startedAt: number, env: Env = process.env): Promise<void> {
    const config = readAwsAdmissionConfig(env);
    const enabled = config.enabled && !config.killSwitch;
    // Do not even import DB/runtime dependencies while disabled or out of budget.
    if (!enabled) {
        console.info('[compute.migration.reconcile] AWS admission disabled');
        return;
    }
    if (Date.now() - startedAt >= 40_000) return;
    try {
        const [{ db }, { createMigrationRuntime }, { billingV2EntitlementReader }] = await Promise.all([
            import('@/server/db'), import('./provider-migrate-runtime'), import('@/server/billing/v2/compute-access'),
        ]);
        const runtime = createMigrationRuntime(db, { env });
        const entitlement = billingV2EntitlementReader();
        await reconcilePaidMigrations({ enabled, startedAt,
            candidates: limit => paidCloudflareCandidates(db, new Date(), limit),
            admitted: async candidate => {
                const plan = await entitlement.read(candidate.userId);
                if (!plan || plan.status !== 'active' || plan.paymentIssue || plan.provider !== 'aws'
                    || plan.planId !== `${candidate.toSize}_monthly_v3`) return false;
                const tier = plan.size && awsTierForSize(plan.size);
                if (!tier || tier === 'free') return false;
                // Provisioning rechecks under this same admission lock. A failed
                // preflight must not fence a working Cloudflare computer.
                return withAdmission(db, async (tx, lock) => {
                    const now = new Date();
                    const counters = await readAdmissionCounters(tx, lock, { ...candidate, now, monthStart: utcMonthStart(now) });
                    return decideAdmission({ config, counters, userId: candidate.userId, now,
                        region: { kind: 'lease', region: 'ap-south-1' },
                        instanceType: instanceTypeForTier(tier) }).admit;
                });
            },
            create: candidate => runtime.store.createOrGetActive(candidate),
            advance: id => advanceMigration(runtime, id),
        });
    } catch { console.warn('[compute.migration.reconcile] unavailable'); }
}
