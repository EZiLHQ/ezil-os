-- ezil_os_access — the EZiL OS invite allow-list. See
-- src/server/db/schema/os-access.ts for the full design rationale (why the
-- primary key is the email and not a user id; why `text` + a CHECK rather
-- than `citext`; why revocation is soft; why there is no partial index).
--
-- ADDITIVE ONLY. This migration creates one new table and touches nothing
-- that already exists — `public` on the hosted database also holds ~40
-- tables belonging to an older project sharing it (see docs/RUNBOOK.md
-- § "Database migrations — read this before running `drizzle-kit migrate`"),
-- so every migration here is written to be safe to run beside them.
--
-- NOTE: `auth.users` already exists (Supabase Auth owns it) and is only
-- REFERENCED by the foreign key below — same as 0000_massive_mole_man.sql.
-- drizzle-kit did not re-emit `CREATE SCHEMA "auth"` here because
-- meta/0000_snapshot.json already records it; nothing was removed by hand
-- from the generated DDL in this file.
CREATE TABLE "ezil_os_access" (
	"email" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ezil_os_access_email_lower_chk" CHECK ("ezil_os_access"."email" = lower("ezil_os_access"."email"))
);
--> statement-breakpoint
ALTER TABLE "ezil_os_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_os_access" ADD CONSTRAINT "ezil_os_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint

-- ── RLS (hand-written; drizzle-kit does not emit policies — same pattern as
-- 0000_massive_mole_man.sql and 0001_telemetry.sql, both of which append
-- their policy blocks here rather than generating them) ───────────────────
--
-- 🔴 RLS IS NOT THE GATE. The gate is `assertOsAccess()`
-- (src/server/api/os-access.ts), called from `protectedProcedure` and the
-- page gates, on this app's own Postgres connection
-- (`SUPABASE_DATABASE_URL`, src/server/db/index.ts) — which is the role this
-- policy admits. Enabling RLS here changes nothing about how the product
-- authorizes anybody.
--
-- It is enabled anyway, with a SERVICE-ROLE-ONLY policy and deliberately NO
-- policy for `authenticated`, because every other table in this schema does
-- the same and because the failure it forecloses is real: a signed-in user
-- reaching this table through PostgREST or a Supabase client could otherwise
-- read who else has been invited, or — far worse — write themselves a row.
-- With RLS on and no matching policy, every non-service-role
-- SELECT/INSERT/UPDATE/DELETE returns nothing or is rejected. That is the
-- safe default, chosen rather than arrived at by omission.
CREATE POLICY "Service role full access os access"
    ON "ezil_os_access" FOR ALL USING (auth.role() = 'service_role');
