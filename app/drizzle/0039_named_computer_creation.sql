-- A delegated create request and its original result are stored in the same
-- transaction as the normal computer row. Only the OS server reads this ledger.
CREATE TABLE public.ezil_named_computer_creations (
    user_id uuid NOT NULL,
    client_id text NOT NULL,
    idempotency_key uuid NOT NULL,
    computer_id uuid NOT NULL,
    input_digest text NOT NULL,
    slot integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_named_computer_creations_request_key
    ON public.ezil_named_computer_creations (user_id, client_id, idempotency_key);
--> statement-breakpoint
ALTER TABLE public.ezil_named_computer_creations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.ezil_named_computer_creations FROM public, anon, authenticated;
