import { sql } from 'drizzle-orm';
import { decideAdmission } from './admission';
import { awsTierForSize, instanceTypeForTier, readAwsAdmissionConfig, type Env } from './aws-config';
import { readAdmissionCounters, withAdmission, type PlacementExecutor } from './placement';
import { advanceMigration } from './provider-migrate-orchestrator';
import { utcMonthStart } from './usage';

export interface PaidMigrationCandidate {
    userId: string;
    computerId: string;
    toSize: 'standard' | 'premium';
}

/** One computer per paid owner, including the implicit Cloudflare placement. */
export async function paidCloudflareCandidates(db: PlacementExecutor, now: Date, limit = 10): Promise<PaidMigrationCandidate[]> {
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(10, Math.trunc(limit))) : 0;
    if (!count) return [];
    const result = await db.execute(sql`SELECT DISTINCT ON (s.user_id) s.user_id::text AS user_id,
        c.id::text AS computer_id, s.sku
        FROM public.ezil_billing_subscriptions s
        JOIN public.ezil_computers c ON c.user_id = s.user_id AND c.deleted_at IS NULL
        LEFT JOIN public.ezil_computer_placements p ON p.computer_id = c.id
        WHERE s.sku IN ('standard_monthly_v3', 'premium_monthly_v3') AND s.status = 'active'
          AND s.current_period_start <= ${now.toISOString()}::timestamptz
          AND s.current_period_end > ${now.toISOString()}::timestamptz
          AND (p.computer_id IS NULL OR p.provider = 'cloudflare')
          AND NOT EXISTS (SELECT 1 FROM public.ezil_compute_migrations m WHERE m.user_id = s.user_id
            AND (m.state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator')
              OR m.updated_at >= ${new Date(now.getTime() - 600_000).toISOString()}::timestamptz))
        ORDER BY s.user_id, s.current_period_end DESC, s.current_period_start DESC, c.slot, c.id LIMIT ${count}`);
    const rows: Record<string, unknown>[] = (Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] })?.rows) ?? [];
    return rows.map(row => ({ userId: String(row.user_id), computerId: String(row.computer_id),
        toSize: row.sku === 'standard_monthly_v3' ? 'standard' : 'premium' }));
}

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
