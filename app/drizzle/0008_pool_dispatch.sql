-- Staging only: durable pool dispatch, never part of the production apply plan.
ALTER TABLE public.ezil_compute_pool_hosts ADD COLUMN IF NOT EXISTS lifecycle_job_id uuid;
ALTER TABLE public.ezil_compute_pool_hosts ADD COLUMN IF NOT EXISTS lifecycle_digest text;
ALTER TABLE public.ezil_compute_pool_hosts ADD COLUMN IF NOT EXISTS lifecycle_input text;
ALTER TABLE public.ezil_compute_pool_hosts ADD COLUMN IF NOT EXISTS dispatch_status text;
CREATE UNIQUE INDEX IF NOT EXISTS ezil_pool_lifecycle_job_idx ON public.ezil_compute_pool_hosts (lifecycle_job_id);
ALTER TABLE public.ezil_compute_pool_hosts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_compute_pool_hosts FROM public, anon, authenticated;
-- This timestamp is immutable across placement progress and acknowledgement retries.
ALTER TABLE public.ezil_compute_pool_hosts ADD COLUMN IF NOT EXISTS session_ready_at timestamptz;
