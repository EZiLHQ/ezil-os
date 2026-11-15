/**
 * Operator-assigned individual plan access (product entitlements v1, producer `ezil-os`; Plans brief
 * 40e7021e76d781d796d5f8bb03f1b616, contract 58d78935). An EZiL operator assigns Standard or Premium to one account
 * through the signed Gateway command (`server/entitlements/operator`). It is an administrative grant: no Stripe
 * subscription, invoice, renewal, charge or AI credits, and never written into the Stripe tables.
 *
 * Effective access, one rule for every reader: Stripe paid access wins (paid, renewal grace, ending at period end);
 * otherwise an operator grant in effect; otherwise Free. The operator plan then has the paid plan's product access
 * (paid compute policy v1: no monthly computer-hours cutoff, six-hour sessions, AWS, the plan's machine choice).
 */
import { CATALOG_V2 } from '../v2/contract';
import { CATALOG_V3 } from './contract';
import type { ResolvedPlanV3 } from './catalog';

export const OPERATOR_SKUS = Object.freeze(['standard_monthly_v3', 'premium_monthly_v3'] as const);
export type OperatorSku = typeof OPERATOR_SKUS[number];

/** One row of `ezil_operator_entitlements` (app/drizzle/0019_operator_entitlements.sql). */
export interface OperatorEntitlementRow {
    ref: string;
    revision: number;
    userId: string;
    accountPublicId: string;
    sku: OperatorSku;
    startsAt: Date;
    /** null = until revoked. */
    endsAt: Date | null;
    /** Set by an `end` command (revoked early); null while not ended by an operator. */
    endedAt: Date | null;
    /** The issuing organization's name shown on the plan card (0023); null/absent = EZiL (every pre-0023 row). */
    issuedBy?: string | null;
}

export const isOperatorSku = (sku: string): sku is OperatorSku => (OPERATOR_SKUS as readonly string[]).includes(sku);

/** The organization a grant without its own issuing-organization name is shown as assigned by. */
export const DEFAULT_ISSUED_BY = 'EZiL';
export const ISSUED_BY_MAX = 80;
// Control (C0 except NUL, DEL, C1), Arabic letter mark, zero-width, line/paragraph separator, bidi embedding/override/
// isolate and BOM characters. NUL is not listed: a Postgres text value cannot hold it, and the CHECK's range starts at U+0001.
const ISSUED_BY_UNSAFE = /[\u0001-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const ISSUED_BY_NUL = /\u0000/;
// A UTF-16 surrogate that is not half of a pair: not encodable as UTF-8, so it can never reach canonical JSON or JSONB.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * An issuing-organization name as signed and stored: already trimmed, 1-80 code points, no control or invisible
 * formatting character, no lone surrogate (the 0023 CHECK, which counts code points the same way). The Gateway trims
 * before signing; this never trims, so stored = hashed.
 */
export const isIssuedBy = (v: unknown): v is string => {
    if (typeof v !== 'string' || v.length < 1 || v.length > ISSUED_BY_MAX * 2) return false;
    if (ISSUED_BY_NUL.test(v) || ISSUED_BY_UNSAFE.test(v) || LONE_SURROGATE.test(v)) return false;
    const points = Array.from(v).length;
    return points >= 1 && points <= ISSUED_BY_MAX && v === v.trim();
};

/** What the plan card says assigned a grant: its stored name, or EZiL for none (legacy) or anything unreadable. */
export const issuedByOf = (grant: Pick<OperatorEntitlementRow, 'issuedBy'>): string => isIssuedBy(grant.issuedBy) ? grant.issuedBy : DEFAULT_ISSUED_BY;

/** The grant in effect at `now`: started, not past its end, not ended by an operator. Newest start wins. */
export function operatorGrantInEffect(rows: readonly OperatorEntitlementRow[] | null | undefined, now: Date): OperatorEntitlementRow | null {
    const at = now.getTime();
    return (rows ?? []).filter(row => isOperatorSku(row.sku) && row.startsAt.getTime() <= at
        && (row.endsAt === null || row.endsAt.getTime() > at) && row.endedAt === null)
        .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || (a.ref < b.ref ? -1 : 1))[0] ?? null;
}

/** The plan an operator grant gives: the paid offer, active, with no Stripe subscription, renewal or cancel date. */
export function operatorPlan(grant: OperatorEntitlementRow, free: ResolvedPlanV3): ResolvedPlanV3 & { operator: OperatorEntitlementRow } {
    const offer = CATALOG_V3[grant.sku];
    // The v2 family the v3 resolver maps each paid SKU to (catalog.ts planFromSubscriptions).
    const family = CATALOG_V2[grant.sku === 'standard_monthly_v3' ? 'standard_monthly_v2' : 'compute_monthly_v2'].family;
    // Usage is metered on the Free calendar-month window and paid usage is never capped by it; the grant's own
    // one-calendar-month validity (startsAt..endsAt) governs access, not metering.
    return { sku: grant.sku, offer, legacy: null, legacyFree: free.legacyFree, sessionMaxSeconds: offer.sessionMaxSeconds, family,
        status: 'active', planActive: true, subscriptionId: null, window: free.window, renewsAt: null, cancelsAt: null, operator: grant };
}

/**
 * The operator grant that decides this account's plan, or null when Stripe gives paid access (paid wins, never
 * replaced) or no grant is in effect. `stripePaidAccess` is the Stripe-only standing (`deriveStanding` without an
 * operator), so the rule is evaluated once, the same way, by every reader.
 */
export function operatorAccess(input: { grants: readonly OperatorEntitlementRow[] | null | undefined; now: Date; stripePaidAccess: boolean }): OperatorEntitlementRow | null {
    return input.stripePaidAccess ? null : operatorGrantInEffect(input.grants, input.now);
}

