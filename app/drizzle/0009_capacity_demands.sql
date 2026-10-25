-- Staging only: durable capacity demand, never part of the production apply plan.
-- One row per authenticated AWS open that capacity could not admit while reclaimable idle
-- pool liability (unleased spares) occupied the regional vCPU budget. It reserves future
-- demand without a placement, lifecycle job, enrollment nonce or usage record; consuming it
-- admits the placement in the same transaction. Rows are never deleted.
CREATE TABLE IF NOT EXISTS public.ezil_compute_capacity_demands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('create', 'wake')),
    region text NOT NULL,
    zone_id text NOT NULL,
    instance_type text NOT NULL,
    vcpu integer NOT NULL CHECK (vcpu > 0 AND vcpu <= 64),
    deployment_digest text NOT NULL CHECK (deployment_digest ~ '^[0-9a-f]{64}$'),
    source_generation integer CHECK (source_generation > 0),
    source_lease_epoch integer CHECK (source_lease_epoch > 0),
    state text NOT NULL CHECK (state IN ('active', 'consumed', 'cancelled', 'expired')),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    cleanup jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cleanup) = 'array' AND jsonb_array_length(cleanup) <= 8),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    closed_at timestamptz,
    CHECK ((state = 'active') = (closed_at IS NULL)),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
    CHECK ((kind = 'create' AND source_generation IS NULL AND source_lease_epoch IS NULL)
        OR (kind = 'wake' AND source_generation IS NOT NULL AND source_lease_epoch IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ezil_capacity_demand_request_idx ON public.ezil_compute_capacity_demands (request_id);
-- One active pressure demand per region, per computer and per owner.
CREATE UNIQUE INDEX IF NOT EXISTS ezil_capacity_demand_region_active_idx ON public.ezil_compute_capacity_demands (region) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ezil_capacity_demand_computer_active_idx ON public.ezil_compute_capacity_demands (computer_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ezil_capacity_demand_owner_active_idx ON public.ezil_compute_capacity_demands (owner_user_id) WHERE closed_at IS NULL;
ALTER TABLE public.ezil_compute_capacity_demands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_compute_capacity_demands FROM public, anon, authenticated;
