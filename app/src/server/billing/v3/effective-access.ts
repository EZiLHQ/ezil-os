/**
 * Explicit EZiL OS access overrides (Notion task 4117021e76d781fab0f4f390ee1d7f42, Plans contract
 * 40e7021e76d781d796d5f8bb03f1b616). An operator's signed `assign` with `access_override: true` sets the account's
 * effective OS tier (Free, Standard or Premium) for its own validity, in an active slot of its own beside any ordinary
 * operator grant. It decides access only: Stripe, AI credits and the remote runtime are never written from it, and
 * Stripe billing operations keep reading the Stripe-only plan.
 *
 * Effective tier, one rule for every reader: a live explicit override > Stripe paid access (paid, renewal grace, ending
 * at period end) > an ordinary operator grant in effect > Free. When the override ends, the next source applies again.
 */
import { operatorAccess, type OperatorEntitlementRow, type OperatorSku } from './operator-access';

/**
 * An operator row as the effective-tier readers see it. The source lane widens `OperatorEntitlementRow` the same way
 * (`accessOverride?: boolean`, `sku` admitting `free_v3` for overrides only); absent `accessOverride` is an ordinary grant.
 */
export type AccessRow = Omit<OperatorEntitlementRow, 'sku'> & { sku: OperatorSku | 'free_v3'; accessOverride?: boolean };

/** Which source decides the account's effective tier. */
export type AccessSource = 'override' | 'stripe' | 'grant' | 'free';
export interface EffectiveAccess {
    source: AccessSource;
    /** The operator row that decides the plan (`override` or `grant`); null for Stripe or Free. */
    row: AccessRow | null;
}

const OVERRIDE_SKUS: readonly AccessRow['sku'][] = ['free_v3', 'standard_monthly_v3', 'premium_monthly_v3'];

export const isAccessOverride = (row: Pick<AccessRow, 'accessOverride'>): boolean => row.accessOverride === true;

/** A row whose tier is paid (Standard or Premium): every ordinary grant, and a paid override. */
export const paidAccessRow = (row: AccessRow): row is AccessRow & { sku: OperatorSku } => row.sku !== 'free_v3';

/**
 * The explicit override in effect at `now`: started, not past its end, not ended by an operator. Newest start wins.
 * Same rule as the source lane's `operatorOverrideInEffect` (operator-access.ts), which replaces it at integration.
 */
export function accessOverrideInEffect(rows: readonly AccessRow[] | null | undefined, now: Date): AccessRow | null {
    const at = now.getTime();
    return (rows ?? []).filter(row => isAccessOverride(row) && OVERRIDE_SKUS.includes(row.sku) && row.startsAt.getTime() <= at
        && (row.endsAt === null || row.endsAt.getTime() > at) && row.endedAt === null)
        .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || (a.ref < b.ref ? -1 : 1))[0] ?? null;
}

/** Ordinary grants only: an override never decides through the grant rule (Stripe paid access wins over a grant). */
export const ordinaryGrants = (rows: readonly AccessRow[] | null | undefined) =>
    (rows ?? []).filter((row): row is AccessRow & { sku: OperatorSku } => !isAccessOverride(row) && paidAccessRow(row));

/** The precedence itself; `stripePaidAccess` is the Stripe-only standing (`deriveStanding` without an operator row). */
export function effectiveAccess(input: { grants: readonly AccessRow[] | null | undefined; now: Date; stripePaidAccess: boolean }): EffectiveAccess {
    const override = accessOverrideInEffect(input.grants, input.now);
    if (override) return { source: 'override', row: override };
    if (input.stripePaidAccess) return { source: 'stripe', row: null };
    const grant = operatorAccess({ grants: ordinaryGrants(input.grants), now: input.now, stripePaidAccess: false });
    return grant ? { source: 'grant', row: grant } : { source: 'free', row: null };
}
