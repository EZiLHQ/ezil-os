-- Audit ledger for delegated computer-tools, terminal jobs and their replays
-- (EZIL-COMPUTER-TOOLS/1, contract §5.4). One row per delegation-verified call,
-- including refused and failed ones. Full commands and output are NEVER stored:
-- only command_sha256 and a secret-redacted command_prefix (≤120 chars). Only the
-- OS server reads this ledger. Migration 0038 belongs to WS1; 0022 onwards are not
-- in the Drizzle journal, so applying 0039 on os-staging is a deploy step.
CREATE TABLE public.ezil_computer_tool_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    client_id text NOT NULL,
    jti text NOT NULL,
    procedure text NOT NULL,
    scope text NOT NULL,
    request_id uuid,
    request_sha256 text,
    replay_of uuid REFERENCES public.ezil_computer_tool_jobs (id),
    tool_name text,
    job_id text,
    command_sha256 text,
    command_prefix text,
    state text,
    exit_code integer,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT ezil_computer_tool_jobs_command_prefix_len CHECK (command_prefix IS NULL OR char_length(command_prefix) <= 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_computer_tool_jobs_jti_key ON public.ezil_computer_tool_jobs (jti);
--> statement-breakpoint
-- The atomic first-call fence: at most one originating row per (computer, procedure, requestId).
-- Replays (replay_of IS NOT NULL) and request-less reads (request_id IS NULL) are unconstrained.
CREATE UNIQUE INDEX ezil_computer_tool_jobs_request_key
    ON public.ezil_computer_tool_jobs (computer_id, procedure, request_id)
    WHERE request_id IS NOT NULL AND replay_of IS NULL;
--> statement-breakpoint
ALTER TABLE public.ezil_computer_tool_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.ezil_computer_tool_jobs FROM public, anon, authenticated;
