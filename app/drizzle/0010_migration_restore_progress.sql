-- Staging-only restore accounting; lifecycle timestamps remain independent.
ALTER TABLE public.ezil_compute_migrations ADD COLUMN IF NOT EXISTS restore_progress jsonb;
