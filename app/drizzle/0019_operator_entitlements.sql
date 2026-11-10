-- Product entitlements v1, producer ezil-os (Plans brief 40e7021e76d781d796d5f8bb03f1b616, Gateway contract 58d78935):
-- an EZiL operator assigns Standard or Premium to one OS account through the signed Gateway command. Administrative
-- access only: no Stripe subscription, invoice, renewal or charge is ever written for it, and the Stripe tables are not
-- touched. Additive and backward compatible: until this exists the app reads "no operator assignments".

CREATE TABLE IF NOT EXISTS public.ezil_operator_entitlements (
    ref text PRIMARY KEY CHECK (ref ~ '^osg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    user_id uuid NOT NULL REFERENCES auth.users (id),
    account_public_id uuid NOT NULL,
    sku text NOT NULL CHECK (sku IN ('standard_monthly_v3', 'premium_monthly_v3')),
    revision integer NOT NULL CHECK (revision >= 1),
    starts_at timestamptz NOT NULL,
    -- null = until revoked (the operator chose it explicitly).
    ends_at timestamptz,
    -- Set by an `end` command, or when a lapsed assignment is closed before a new one; never cleared.
    ended_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ezil_operator_entitlements_validity CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT ezil_operator_entitlements_ended CHECK (ended_at IS NULL OR ended_at >= starts_at)
);

-- One live (not ended) operator assignment per account.
CREATE UNIQUE INDEX IF NOT EXISTS ezil_operator_entitlements_one_live
    ON public.ezil_operator_entitlements (user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS ezil_operator_entitlements_user ON public.ezil_operator_entitlements (user_id, starts_at DESC);

-- Append-only audit and idempotency: one row per applied command (its result is replayed for the same command_id).
CREATE TABLE IF NOT EXISTS public.ezil_operator_entitlement_events (
    id uuid PRIMARY KEY,
    command_id uuid NOT NULL UNIQUE,
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    action text NOT NULL CHECK (action IN ('assign', 'change', 'end')),
    assignment_ref text NOT NULL REFERENCES public.ezil_operator_entitlements (ref),
    revision integer NOT NULL CHECK (revision >= 1),
    user_id uuid NOT NULL,
    operator_via text NOT NULL CHECK (length(operator_via) BETWEEN 1 AND 80),
    operator_actor text NOT NULL CHECK (length(operator_actor) BETWEEN 1 AND 200),
    sender_kid text NOT NULL CHECK (length(sender_kid) BETWEEN 1 AND 80),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ezil_operator_entitlement_events_assignment ON public.ezil_operator_entitlement_events (assignment_ref, revision);

CREATE OR REPLACE FUNCTION public.ezil_operator_entitlement_events_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ezil_operator_entitlement_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS ezil_operator_entitlement_events_append_only ON public.ezil_operator_entitlement_events;
CREATE TRIGGER ezil_operator_entitlement_events_append_only BEFORE UPDATE OR DELETE ON public.ezil_operator_entitlement_events
    FOR EACH ROW EXECUTE FUNCTION public.ezil_operator_entitlement_events_append_only();

-- Server-only: the app's service connection writes these; browser roles never read them.
ALTER TABLE public.ezil_operator_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ezil_operator_entitlement_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_operator_entitlements FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.ezil_operator_entitlement_events FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.ezil_operator_entitlement_events_append_only() FROM public, anon, authenticated;
