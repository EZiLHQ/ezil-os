-- Staging-only: AWS -> Cloudflare moves (Phase B, docs/compute/REVERSE-MOVE-CONTRACT.md). A NEW table:
-- 0006 stays one-directional, so no forward reader ever sees a reverse row and an app rollback is safe.
-- The cross-direction exclusion is enforced by both stores under the per-computer advisory lock.
CREATE TABLE public.ezil_compute_reverse_moves (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    started_by text NOT NULL CHECK (started_by IN ('user', 'open', 'cron')),
    state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'booting', 'exporting', 'copying', 'checking', 'flipping', 'committed', 'failed_reopened', 'failed_needs_operator')),
    generation uuid NOT NULL DEFAULT gen_random_uuid(),
    export_boot jsonb CHECK (export_boot IS NULL OR jsonb_typeof(export_boot) = 'object'),
    export_head jsonb CHECK (export_head IS NULL OR jsonb_typeof(export_head) = 'object'),
    import_progress jsonb CHECK (import_progress IS NULL OR jsonb_typeof(import_progress) = 'object'),
    bytes_total bigint CHECK (bytes_total IS NULL OR bytes_total BETWEEN 0 AND 536870912),
    skipped integer CHECK (skipped IS NULL OR skipped >= 0),
    aws_volume_id text CHECK (aws_volume_id IS NULL OR aws_volume_id ~ '^vol-[0-9a-f]{8,17}$'),
    aws_fs_uuid uuid,
    aws_snapshot_id text CHECK (aws_snapshot_id IS NULL OR aws_snapshot_id ~ '^snap-[0-9a-f]{8,17}$'),
    retain_until timestamptz CONSTRAINT ezil_compute_reverse_moves_retain_until_check CHECK (retain_until IS NULL OR state = 'committed'),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    last_error text CHECK (last_error IS NULL OR length(last_error) <= 200),
    -- Set on every state change (never by claimStale or a retry): the anchor of every per-state timeout.
    state_entered_at timestamptz NOT NULL DEFAULT now(),
    -- The point of no return: set once, by checking -> flipping, before the Worker commit may be sent.
    -- A row that carries it can never be failed_reopened (the Cloudflare head may already be committed).
    commit_sent_at timestamptz CONSTRAINT ezil_compute_reverse_moves_commit_sent_at_check
        CHECK (commit_sent_at IS NULL OR state IN ('flipping', 'committed', 'failed_needs_operator')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- failed_needs_operator still holds the computer: only an operator releases it (-> failed_reopened).
CREATE UNIQUE INDEX ezil_compute_reverse_moves_one_active_per_computer
    ON public.ezil_compute_reverse_moves (computer_id)
    WHERE state NOT IN ('committed', 'failed_reopened');
CREATE INDEX ezil_compute_reverse_moves_computer_created
    ON public.ezil_compute_reverse_moves (computer_id, created_at);
ALTER TABLE public.ezil_compute_reverse_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_compute_reverse_moves FROM public, anon, authenticated;
