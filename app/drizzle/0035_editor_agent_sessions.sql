-- EZiL Chat sessions reachable through the editor bridge (EZiL MCP CONTRACT.md v3.0).
-- Written in the production migration grammar (docs/production-migrations.md): no defaults,
-- keys, checks or foreign keys; uniqueness is by unique index and every value (ids, times,
-- statuses) is supplied and validated by the app (app/src/server/agent-session/store.ts).
--   ezil_editor_bridge_owner: the one editor window that may take work for a computer and its
--     current owner, fenced by epoch; last_seq refuses a replayed sync.
--   ezil_agent_sessions: sessions the editor reported, under an OS-minted id, per computer AND
--     person, so a re-owned computer never reuses another person's session.
--   ezil_agent_operations: each send or cancel. Unique per (person, procedure, idempotency key);
--     each handout gets a fresh attempt_id and reports are only taken for that attempt.
--   ezil_agent_events: the instruction, its status changes and the final response of that one
--     request. No other chat history is stored. Rows are deleted after 7 days.
-- RLS on with no policies: never readable or writable through PostgREST.
CREATE TABLE public.ezil_editor_bridge_owner (
    computer_id uuid NOT NULL,
    user_id uuid NOT NULL,
    owner_id text NOT NULL,
    epoch bigint NOT NULL,
    last_seq bigint NOT NULL,
    lease_until timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_editor_bridge_owner_computer_key ON public.ezil_editor_bridge_owner (computer_id);
--> statement-breakpoint
CREATE TABLE public.ezil_agent_sessions (
    id uuid NOT NULL,
    computer_id uuid NOT NULL,
    user_id uuid NOT NULL,
    resource text NOT NULL,
    title text,
    present boolean NOT NULL,
    open boolean NOT NULL,
    status text NOT NULL,
    seen_at timestamptz NOT NULL,
    next_seq integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_agent_sessions_id_key ON public.ezil_agent_sessions (id);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_agent_sessions_resource_key ON public.ezil_agent_sessions (computer_id, user_id, resource);
--> statement-breakpoint
CREATE INDEX ezil_agent_sessions_user_idx ON public.ezil_agent_sessions (user_id, computer_id);
--> statement-breakpoint
CREATE TABLE public.ezil_agent_operations (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id text NOT NULL,
    proc text NOT NULL,
    idempotency_key uuid NOT NULL,
    input_digest text NOT NULL,
    kind text NOT NULL,
    text text,
    target_id uuid,
    status text NOT NULL,
    reason text,
    mode text,
    selected_model_id text,
    request_id text,
    delivered_epoch bigint,
    attempt_id uuid,
    attempts integer NOT NULL,
    delivered_at timestamptz,
    not_before timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_agent_operations_id_key ON public.ezil_agent_operations (id);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_agent_operations_idempotency_key ON public.ezil_agent_operations (user_id, proc, idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_agent_operations_attempt_key ON public.ezil_agent_operations (attempt_id) WHERE attempt_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX ezil_agent_operations_queue_idx ON public.ezil_agent_operations (computer_id, status, not_before);
--> statement-breakpoint
CREATE INDEX ezil_agent_operations_target_idx ON public.ezil_agent_operations (target_id);
--> statement-breakpoint
CREATE INDEX ezil_agent_operations_created_idx ON public.ezil_agent_operations (created_at);
--> statement-breakpoint
CREATE TABLE public.ezil_agent_events (
    session_id uuid NOT NULL,
    seq integer NOT NULL,
    at timestamptz NOT NULL,
    kind text NOT NULL,
    operation_id uuid NOT NULL,
    text text,
    status text
);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_agent_events_seq_key ON public.ezil_agent_events (session_id, seq);
--> statement-breakpoint
CREATE INDEX ezil_agent_events_operation_idx ON public.ezil_agent_events (operation_id);
--> statement-breakpoint
ALTER TABLE public.ezil_editor_bridge_owner ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ezil_agent_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ezil_agent_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ezil_agent_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.ezil_editor_bridge_owner FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE public.ezil_agent_sessions FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE public.ezil_agent_operations FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE public.ezil_agent_events FROM public, anon, authenticated
