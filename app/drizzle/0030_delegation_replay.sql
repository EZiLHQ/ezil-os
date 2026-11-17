-- RESERVED SOURCE MIGRATION, unapplied. One-time ledger for EZiL MCP delegated computer reads
-- (app/src/server/api/delegation-store.ts). The app inserts each accepted assertion's jti once; the unique
-- index makes a replay lose on every app instance. No user data, no foreign key, no default: the app supplies
-- every value. Registered as a production snapshot only; not in the staging runner or the Drizzle journal.
CREATE TABLE public.ezil_delegation_replay (
    jti uuid NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX ezil_delegation_replay_jti_key ON public.ezil_delegation_replay (jti);
CREATE INDEX ezil_delegation_replay_expires_at_idx ON public.ezil_delegation_replay (expires_at);
ALTER TABLE public.ezil_delegation_replay ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_delegation_replay FROM public, anon, authenticated;
