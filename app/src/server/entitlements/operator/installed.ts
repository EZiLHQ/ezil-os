/**
 * Schema availability for the operator source. Only a successful boolean probe proves absence; a failed or malformed
 * probe must hold access reads. Never cache absence: this process may span an additive schema installation.
 * Dependency-free because pool eligibility and migration discovery import it.
 */
import { sql, type SQL } from 'drizzle-orm';

type Executor = { execute(query: SQL): Promise<unknown> };
async function present(db: Executor, query: SQL): Promise<boolean> {
    const result = await db.execute(query);
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown } | null)?.rows;
    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.present !== 'boolean') {
        throw new Error('operator_schema_probe_unavailable');
    }
    return rows[0].present;
}

export async function operatorEntitlementsInstalled(db: Executor): Promise<boolean> {
    return present(db, sql`SELECT to_regclass('public.ezil_operator_entitlements') IS NOT NULL AS present`);
}

/** Stored access survives transport-key rotation/removal. Unknown availability is never an absent branch. */
export async function operatorBranchEnabled(db: Executor): Promise<boolean> {
    return operatorEntitlementsInstalled(db);
}

/** 0038's final index gates catalog capability only; access reads must honor stored overrides even without it. */
export async function operatorOverridesInstalled(db: Executor): Promise<boolean> {
    return present(db, sql`SELECT to_regclass('public.ezil_operator_entitlements_one_live_override') IS NOT NULL AS present`);
}

/** Tests using the older reader may call this across schema changes; probes are now always fresh. */
export function resetOperatorEntitlementsInstalled(): void {}
