-- Product entitlements v1: durable business-refusal receipts without fabricated assignments.
-- Apply after 0019 and before the corrected application. Keep this additive schema/history on image rollback.
-- The existing command uniqueness, owner metadata, RLS/revokes and append-only trigger remain authoritative.
ALTER TABLE public.ezil_operator_entitlement_events ALTER COLUMN assignment_ref DROP NOT NULL;
ALTER TABLE public.ezil_operator_entitlement_events ALTER COLUMN revision DROP NOT NULL;

ALTER TABLE public.ezil_operator_entitlement_events
    ADD CONSTRAINT ezil_operator_entitlement_events_result_links CHECK (
        COALESCE(
            ((result ->> 'outcome') = 'applied' AND assignment_ref IS NOT NULL AND revision IS NOT NULL)
            OR ((result ->> 'outcome') = 'refused' AND assignment_ref IS NULL AND revision IS NULL),
            false
        )
    );
