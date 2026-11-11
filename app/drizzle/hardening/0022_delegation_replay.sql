-- One-time ledger for EZiL MCP delegation assertions (EZiL MCP CONTRACT.md v2, requirement 5).
-- The app inserts each assertion's jti once; the unique index makes a replay lose on every
-- app instance. Rows are pruned shortly after the assertion expires. No user data is stored.
-- Written in the production migration grammar (docs/production-migrations.md): no defaults,
-- keys or constraints beyond unique indexes; the app supplies every value. RLS on, no grants.
CREATE TABLE public.ezil_delegation_replay (
    jti uuid NOT NULL,
    expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX ezil_delegation_replay_jti_key ON public.ezil_delegation_replay (jti);
--> statement-breakpoint
CREATE INDEX ezil_delegation_replay_expires_at_idx ON public.ezil_delegation_replay (expires_at);
--> statement-breakpoint
ALTER TABLE public.ezil_delegation_replay ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.ezil_delegation_replay FROM public, anon, authenticated;
