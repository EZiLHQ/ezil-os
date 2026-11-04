/**
 * Whether app/drizzle/0019_operator_entitlements.sql is applied, so the compute SQL readers (ready-pool.ts eligibility,
 * placement.ts paid move candidates) include their operator branch. Dependency-free on purpose: those low-level modules
 * import it. Cached: "yes" for the life of the process, "no" for a minute (the app can deploy before the migration).
 */
import { sql, type SQL } from 'drizzle-orm';
import { SENDER_KEYS_ENV } from './signature';

let installed: { value: boolean; at: number } | null = null;

export async function operatorEntitlementsInstalled(db: { execute(query: SQL): Promise<unknown> }, now = Date.now()): Promise<boolean> {
    if (installed && (installed.value || now - installed.at < 60_000)) return installed.value;
    const result = await db.execute(sql`SELECT to_regclass('public.ezil_operator_entitlements') IS NOT NULL AS present`);
    const rows = (Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] } | null)?.rows) ?? [];
    installed = { value: rows[0]?.present === true, at: now };
    return installed.value;
}

/**
 * Whether compute SQL includes operator grants: only once the ezil-os source is configured (its sender keys set; the
 * release applies 0019 first) and the table exists. Unconfigured (every test and every deployment without the
 * source) answers false with no query, so the SQL is exactly what it was before.
 */
export async function operatorBranchEnabled(db: { execute(query: SQL): Promise<unknown> }, env: Record<string, string | undefined> = process.env): Promise<boolean> {
    if (!env[SENDER_KEYS_ENV]?.trim()) return false;
    try {
        return await operatorEntitlementsInstalled(db);
    } catch {
        return false;
    }
}

/** Tests only. */
export function resetOperatorEntitlementsInstalled(): void { installed = null; }
