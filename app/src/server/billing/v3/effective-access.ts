/**
 * An explicit operator override sets the account's
 * effective OS tier (Free, Standard or Premium) for its own validity, in an active slot of its own beside any ordinary
 * operator grant. It decides access only: Stripe, AI credits and the remote runtime are never written from it, and
 * Stripe billing operations keep reading the Stripe-only plan.
 *
 * Effective tier, one rule for every reader: a live explicit override > Stripe paid access (paid, renewal grace, ending
 * at period end) > an ordinary operator grant in effect > Free. When the override ends, the next source applies again.
 */
import { operatorGrantInEffect, operatorOverrideInEffect, type OperatorEntitlementRow, type OperatorSku } from './operator-access';

export type AccessRow = OperatorEntitlementRow;
export const accessOverrideInEffect = operatorOverrideInEffect;

/** Which source decides the account's effective tier. */
export type AccessSource = 'override' | 'stripe' | 'grant' | 'free';
export interface EffectiveAccess {
    source: AccessSource;
    /** The operator row that decides the plan (`override` or `grant`); null for Stripe or Free. */
    row: AccessRow | null;
}

export const isAccessOverride = (row: Pick<AccessRow, 'accessOverride'>): boolean => row.accessOverride === true;

/** A row whose tier is paid (Standard or Premium): every ordinary grant, and a paid override. */
export const paidAccessRow = (row: AccessRow): row is AccessRow & { sku: OperatorSku } => row.sku !== 'free_v3';

/** Ordinary grants only: an override never decides through the grant rule (Stripe paid access wins over a grant). */
export const ordinaryGrants = (rows: readonly AccessRow[] | null | undefined) =>
    (rows ?? []).filter((row): row is AccessRow & { sku: OperatorSku } => !isAccessOverride(row) && paidAccessRow(row));

/** The precedence itself; `stripePaidAccess` is the Stripe-only standing (`deriveStanding` without an operator row). */
export function effectiveAccess(input: { grants: readonly AccessRow[] | null | undefined; now: Date; stripePaidAccess: boolean }): EffectiveAccess {
    const override = accessOverrideInEffect(input.grants, input.now);
    if (override) return { source: 'override', row: override };
    if (input.stripePaidAccess) return { source: 'stripe', row: null };
    const grant = operatorGrantInEffect(input.grants, input.now);
    return grant ? { source: 'grant', row: grant } : { source: 'free', row: null };
}
