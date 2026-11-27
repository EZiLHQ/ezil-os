/**
 * SQL counterpart of catalog.ts → standing.ts → funding.ts → operatorAccessFor (effective-access.ts precedence).
 * Select the Stripe source BEFORE evaluating standing/funding, and suppress an operator grant while that source
 * still covers the account even when its receipt is missing/reversed. Pool planning and migration discovery share
 * these CTEs; discovery never writes a receipt or provisions a computer.
 *
 * A live override decides first: Free removes the account from `effective`; a paid override replaces Stripe/grants.
 * Once table availability is verified, JSON column reads honor overrides even during partial 0038 installation and
 * remain compatible with true pre-0038 rows. Column-probe failure or stale absence can never select legacy paid SQL.
 */
import { sql, type SQL } from 'drizzle-orm';
import { operatorBranchEnabled } from '@/server/entitlements/operator/installed';
import { PAYMENT_GRACE_SECONDS } from './standing';

/** Whether the operator table was verified present. No independent override switch: every table read honors it. */
export interface PaidComputeBranches { operator: boolean }

/** A failed availability probe throws before any eligibility, demand or migration query is issued. */
export async function paidComputeBranches(db: { execute(query: SQL): Promise<unknown> }): Promise<PaidComputeBranches> {
    return { operator: await operatorBranchEnabled(db) };
}

/** `false` is only for a verified absent operator table. Both pre-0038 and current tables use the same reader. */
export function paidComputeAccessCtes(at: string, branches: boolean | PaidComputeBranches, userId?: string) {
    const operator = typeof branches === 'boolean' ? branches : branches.operator;
    const override = operator;
    const overrideFlag = sql`COALESCE((to_jsonb(o)->>'access_override')::boolean, false)`;
    // An account with a live explicit override is decided by it alone (Stripe and grant rows give way).
    const noOverride = (column: SQL) => override ? sql`AND NOT EXISTS (SELECT 1 FROM override_live ov WHERE ov.user_id = ${column})` : sql``;
    const overrideLive = !override ? sql`` : sql`
        override_live AS (
            SELECT DISTINCT ON (o.user_id) o.user_id, o.sku, o.starts_at, o.ends_at
            FROM public.ezil_operator_entitlements o JOIN auth.users u ON u.id = o.user_id
            WHERE ${overrideFlag} AND o.ended_at IS NULL AND o.starts_at <= ${at}::timestamptz AND (o.ends_at IS NULL OR o.ends_at > ${at}::timestamptz)
                AND o.sku IN ('free_v3', 'standard_monthly_v3', 'premium_monthly_v3')
                AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until <= ${at}::timestamptz)
                ${userId ? sql`AND o.user_id = ${userId}::uuid` : sql``}
            ORDER BY o.user_id, o.starts_at DESC, o.ref COLLATE "C"
        ),`;
    const current = sql`s.status IN ('active', 'trialing') AND s.current_period_start <= ${at}::timestamptz AND s.current_period_end > ${at}::timestamptz`;
    const manual = !operator ? sql`` : sql`
        UNION ALL SELECT o.user_id, o.sku, 'active' AS status, NULL::text AS stripe_subscription_id,
            o.starts_at AS current_period_start, COALESCE(o.ends_at, 'infinity'::timestamptz) AS current_period_end
        FROM public.ezil_operator_entitlements o JOIN auth.users u ON u.id = o.user_id
        WHERE o.ended_at IS NULL AND o.starts_at <= ${at}::timestamptz AND (o.ends_at IS NULL OR o.ends_at > ${at}::timestamptz)
            AND o.sku IN ('standard_monthly_v3', 'premium_monthly_v3')
            AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until <= ${at}::timestamptz)
            ${userId ? sql`AND o.user_id = ${userId}::uuid` : sql``}
            AND NOT EXISTS (SELECT 1 FROM stripe_standing s WHERE s.user_id = o.user_id AND s.covers)${override ? sql`
            AND NOT ${overrideFlag} ${noOverride(sql`o.user_id`)}` : sql``}`;
    // A paid override is paid access with no Stripe period or receipt (funding.ts: its plan's own fair use).
    const paidOverride = !override ? sql`` : sql`
        UNION ALL SELECT ov.user_id, ov.sku, 'active' AS status, NULL::text AS stripe_subscription_id,
            ov.starts_at AS current_period_start, COALESCE(ov.ends_at, 'infinity'::timestamptz) AS current_period_end
        FROM override_live ov WHERE ov.sku IN ('standard_monthly_v3', 'premium_monthly_v3')`;
    return sql`${overrideLive}
        stripe_candidates AS (
            SELECT s.*, (${current}) AS period_active,
                CASE WHEN ${current} THEN 0 ELSE 1 END AS source_priority
            FROM public.ezil_billing_subscriptions s JOIN auth.users u ON u.id = s.user_id
            WHERE s.sku IN ('standard_monthly_v3', 'premium_monthly_v3', 'standard_monthly_v2', 'compute_monthly_v2', 'pro_monthly_v1')
                AND ((${current}) OR s.status IN ('past_due', 'unpaid', 'incomplete'))
                AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until <= ${at}::timestamptz)
                ${userId ? sql`AND s.user_id = ${userId}::uuid` : sql``}
        ), stripe_selected AS (
            SELECT DISTINCT ON (s.user_id) s.*,
                CASE WHEN s.current_period_start IS NOT NULL AND s.current_period_end IS NOT NULL
                    THEN date_trunc('second', s.current_period_start) ELSE date_trunc('month', ${at}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END AS window_start,
                CASE WHEN s.current_period_start IS NOT NULL AND s.current_period_end IS NOT NULL
                    THEN date_trunc('second', s.current_period_end) ELSE (date_trunc('month', ${at}::timestamptz AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' END AS window_end
            FROM stripe_candidates s ORDER BY s.user_id, s.source_priority,
                s.current_period_end DESC NULLS LAST, s.current_period_start DESC NULLS LAST, s.stripe_subscription_id COLLATE "C"
        ), stripe_grace AS (
            SELECT s.*, issue.issue_count,
                (s.status = 'past_due' OR issue.issue_count > 0) AS in_dunning,
                LEAST(COALESCE(issue.first_at, CASE WHEN s.status = 'past_due' THEN date_trunc('second', s.current_period_start) END)
                    + ${PAYMENT_GRACE_SECONDS} * interval '1 second', issue.final_at) AS grace_end
            FROM stripe_selected s LEFT JOIN LATERAL (
                SELECT count(*) AS issue_count, min(date_trunc('second', i.stripe_event_created)) AS first_at,
                    min(date_trunc('second', i.stripe_event_created)) FILTER (WHERE i.issue = 'uncollectible') AS final_at
                FROM public.ezil_billing_payment_issues i WHERE i.user_id = s.user_id AND i.subscription_id = s.stripe_subscription_id
                    AND i.invoice_kind = 'subscription' AND i.resolved_at IS NULL AND i.issue <> 'voided'
            ) issue ON true
        ), stripe_standing AS (
            SELECT s.*, CASE WHEN s.status IN ('unpaid', 'incomplete') THEN false
                -- standing.ts neverPaidTrial: neither a new active period nor dunning proves the first payment.
                WHEN s.trial_end IS NOT NULL AND s.first_paid_at IS NULL
                    AND (s.in_dunning OR date_trunc('second', ${at}::timestamptz) >= date_trunc('second', s.trial_end)) THEN false
                WHEN s.in_dunning THEN date_trunc('second', ${at}::timestamptz) < s.grace_end
                ELSE s.period_active END AS covers
            FROM stripe_grace s
        ), effective AS (
            SELECT s.user_id, s.sku, s.status, s.stripe_subscription_id, s.current_period_start, s.current_period_end
            FROM stripe_standing s LEFT JOIN LATERAL (
                SELECT count(*) AS receipt_count, COALESCE(sum(g.amount), 0) AS amount
                FROM public.ezil_billing_grants g WHERE g.user_id = s.user_id AND g.subscription_id = s.stripe_subscription_id
                    AND g.meter = 'compute_std_seconds' AND g.period_start < s.window_end AND g.period_end > s.window_start
            ) funding ON true
            WHERE s.covers AND s.sku IN ('standard_monthly_v3', 'premium_monthly_v3')
                AND (funding.amount > 0 OR (s.in_dunning AND funding.receipt_count = 0))${noOverride(sql`s.user_id`)}${manual}${paidOverride}
        ), eligible AS (
            SELECT s.*, CASE WHEN s.sku = 'standard_monthly_v3' THEN 'm6i.large'
                WHEN pref.size = 'cmp-4' THEN 'm6i.xlarge' WHEN pref.size = 'cmp-8' THEN 'm6i.2xlarge'
                ELSE 'm6i.large' END AS instance_type
            FROM effective s LEFT JOIN public.ezil_billing_size_preferences pref ON pref.user_id = s.user_id
        )`;
}
