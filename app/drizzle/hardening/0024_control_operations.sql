-- EZiL MCP session controls (computer start, session create and configure), as durable rows.
-- Written in the production migration grammar (docs/production-migrations.md): no defaults, keys,
-- checks or foreign keys; uniqueness is by unique index and every value (ids, times, statuses) is
-- supplied and validated by the app (app/src/server/agent-session/control-store.ts and
-- app/src/server/computer-start/start.ts).
--   ezil_control_operations: one row per delegated control request. Unique per (person, OAuth
--     client, procedure, idempotency key), so a retry finds the original and the same key with
--     other input is a conflict. Holds only the request's ids and its requested model and effort
--     (never instruction text, a shell, a mode, an approval or a preview URL). Rows are deleted
--     after 7 days.
-- RLS on with no policies: never readable or writable through PostgREST.
CREATE TABLE public.ezil_control_operations (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id text NOT NULL,
    proc text NOT NULL,
    idempotency_key uuid NOT NULL,
    input_digest text NOT NULL,
    kind text NOT NULL,
    computer_id uuid NOT NULL,
    session_id uuid,
    status text NOT NULL,
    reason text,
    requested_model text,
    requested_effort text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_control_operations_id_key ON public.ezil_control_operations (id);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_control_operations_idempotency_key ON public.ezil_control_operations (user_id, client_id, proc, idempotency_key);
--> statement-breakpoint
CREATE INDEX ezil_control_operations_created_idx ON public.ezil_control_operations (created_at);
--> statement-breakpoint
ALTER TABLE public.ezil_control_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.ezil_control_operations FROM public, anon, authenticated
