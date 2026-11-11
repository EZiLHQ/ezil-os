-- READ-ONLY preflight for migrations/sponsor/0001_sponsor_attribution.sql (request sponsor-checkout-20261111). Writes nothing, creates nothing.
-- Run in a read-only transaction against the TARGET database only after the runner has pinned its system identifier. One row per check; the
-- runner applies the sponsor file only when every `ok` is true and `state` is 'absent' (not partial, not conflicting). `state` = 'present' means
-- the sponsor schema already exists: the runner then verifies it is the same and does nothing.
SELECT check_name, ok FROM (
	SELECT 1 AS n, '0021 trials table exists' AS check_name, to_regclass('public.ezil_billing_trials') IS NOT NULL AS ok
	UNION ALL SELECT 2, 'trials.id is a uuid primary key', EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
		WHERE i.indrelid = to_regclass('public.ezil_billing_trials') AND i.indisprimary AND a.attname = 'id' AND a.atttypid = 'uuid'::regtype)
	UNION ALL SELECT 3, 'trials has its 0021 identity uniques', (SELECT count(*) FROM pg_constraint WHERE conrelid = to_regclass('public.ezil_billing_trials') AND contype = 'u'
		AND conname IN ('ezil_billing_trials_user_unique', 'ezil_billing_trials_subject_unique', 'ezil_billing_trials_email_unique', 'ezil_billing_trials_checkout_unique', 'ezil_billing_trials_subscription_unique')) = 5
	UNION ALL SELECT 4, 'trials has row level security on', COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.ezil_billing_trials')), false)
	UNION ALL SELECT 5, 'auth.role() exists', to_regprocedure('auth.role()') IS NOT NULL
	UNION ALL SELECT 6, 'roles anon and authenticated exist', (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) = 2
	UNION ALL SELECT 7, 'no sponsor object exists (absent) or the full set does (present)', (
		SELECT n IN (0, 8) FROM (SELECT
			(to_regclass('public.ezil_sponsor_attributions') IS NOT NULL)::int + (to_regclass('public.ezil_sponsor_trial_claims') IS NOT NULL)::int
			+ (to_regprocedure('public.ezil_sponsor_attribution_guard()') IS NOT NULL)::int + (to_regprocedure('public.ezil_sponsor_trial_claim_guard()') IS NOT NULL)::int
			+ (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('ezil_sponsor_attribution_guard', 'ezil_sponsor_trial_claim_guard'))::int
			+ (SELECT count(*) FROM pg_policy WHERE polname IN ('Service role full access sponsor attributions', 'Service role full access sponsor trial claims'))::int AS n) s)
	UNION ALL SELECT 8, 'sponsor schema state is ' || CASE WHEN to_regclass('public.ezil_sponsor_attributions') IS NULL THEN 'absent' ELSE 'present' END, true
	UNION ALL SELECT 9, 'no pending ordered objects are required or touched', to_regclass('public.ezil_billing_trials') IS NOT NULL
) c ORDER BY n;
