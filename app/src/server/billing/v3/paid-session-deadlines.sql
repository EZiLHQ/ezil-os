-- S11 integration prerequisite: register this as the next Drizzle migration,
-- and remove the six-hour upper bound in schema/billing.ts. Those paths belong
-- to the lead; this worker must not edit them or apply SQL to a database.
ALTER TABLE public.ezil_billing_compute_epochs
    DROP CONSTRAINT ezil_billing_compute_epochs_deadline_at_chk,
    ADD CONSTRAINT ezil_billing_compute_epochs_deadline_at_chk
        CHECK (deadline_at IS NULL OR deadline_at >= ready_at);
-- Admission and rating retain plan-specific bounds, including legacy six-hour caps.
