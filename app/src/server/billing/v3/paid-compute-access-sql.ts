/**
 * SQL counterpart of catalog.ts → standing.ts → funding.ts → operatorAccessFor.
 * Select the Stripe source BEFORE evaluating standing/funding, and suppress an operator grant while that source
 * still covers the account even when its receipt is missing/reversed. Pool planning and migration discovery share
 * these CTEs; discovery never writes a receipt or provisions a computer.
 */
import { sql } from 'drizzle-orm';
import { PAYMENT_GRACE_SECONDS } from './standing';

export function paidComputeAccessCtes(at: string, operator: boolean, userId?: string) {
    const current = sql`s.status IN ('active', 'trialing') AND s.current_period_start <= ${at}::timestamptz AND s.current_period_end > ${at}::timestamptz`;
    const manual = !operator ? sql`` : sql`
        UNION ALL SELECT o.user_id, o.sku, 'active' AS status, NULL::text AS stripe_subscription_id,
            o.starts_at AS current_period_start, COALESCE(o.ends_at, 'infinity'::timestamptz) AS current_period_end
        FROM public.ezil_operator_entitlements o JOIN auth.users u ON u.id = o.user_id
        WHERE o.ended_at IS NULL AND o.starts_at <= ${at}::timestamptz AND (o.ends_at IS NULL OR o.ends_at > ${at}::timestamptz)
            AND o.sku IN ('standard_monthly_v3', 'premium_monthly_v3')
            AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until <= ${at}::timestamptz)
            ${userId ? sql`AND o.user_id = ${userId}::uuid` : sql``}
            AND NOT EXISTS (SELECT 1 FROM stripe_standing s WHERE s.user_id = o.user_id AND s.covers)`;
    return sql`
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
                -- standing.ts neverPaidTrial: a trial that never paid has no renewal grace.
                WHEN s.in_dunning AND s.trial_end IS NOT NULL AND s.first_paid_at IS NULL THEN false
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
                AND (funding.amount > 0 OR (s.in_dunning AND funding.receipt_count = 0))${manual}
        ), eligible AS (
            SELECT s.*, CASE WHEN s.sku = 'standard_monthly_v3' THEN 'm6i.large'
                WHEN pref.size = 'cmp-4' THEN 'm6i.xlarge' WHEN pref.size = 'cmp-8' THEN 'm6i.2xlarge'
                ELSE 'm6i.large' END AS instance_type
            FROM effective s LEFT JOIN public.ezil_billing_size_preferences pref ON pref.user_id = s.user_id
        )`;
}
