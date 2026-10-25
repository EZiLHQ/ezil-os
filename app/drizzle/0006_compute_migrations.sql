CREATE TABLE public.ezil_compute_migrations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    from_provider text NOT NULL CHECK (from_provider = 'cloudflare'),
    to_provider text NOT NULL CHECK (to_provider = 'aws-ec2'),
    to_size text NOT NULL CHECK (to_size IN ('standard', 'premium')),
    state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'fenced', 'exported', 'provisioning', 'restored', 'committed', 'failed_reopened', 'failed_needs_operator')),
    generation uuid,
    workspace_head jsonb,
    system_head jsonb,
    source_etag text,
    source_system_etag text,
    migrated_etag text,
    restore_token_sha256 text,
    restore_token_expires_at timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ezil_compute_migrations_one_active_per_computer
    ON public.ezil_compute_migrations (computer_id)
    WHERE state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator');
CREATE INDEX ezil_compute_migrations_computer_created
    ON public.ezil_compute_migrations (computer_id, created_at);
ALTER TABLE public.ezil_compute_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_compute_migrations FROM public, anon, authenticated;
