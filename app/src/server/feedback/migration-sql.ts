/**
 * The reviewed SQL for the feedback tables. `migration-sql.test.ts` runs both
 * strings through the production grammar (`additiveSQL`), checks them column
 * for column against `app/src/server/db/schema/feedback.ts`, and requires
 * `app/drizzle/0011_feedback.sql` to equal `FEEDBACK_MIGRATION_SQL` byte for
 * byte. That file is what the os-staging schema tool applies
 * (`app/scripts/billing-staging-schema.mjs`, `EXPLICIT_FILES`); it is a
 * `snapshot` source in `.github/production-migrations.json`, never a grammar
 * `migration`, and the tool refuses it for `aws-production`
 * (`docs/feedback-migration.md`).
 */

export const FEEDBACK_REPORTS_SQL = `CREATE TABLE public.ezil_feedback_reports (id uuid NOT NULL, user_id uuid NOT NULL, computer_id uuid NULL, created_at timestamptz NOT NULL, category text NOT NULL, description text NOT NULL, diagnostics jsonb NULL, client_request_id uuid NOT NULL, shell_version text NULL, status text NOT NULL, redaction_count integer NOT NULL, has_screenshot boolean NOT NULL, deploy_sha text NULL);
CREATE INDEX ezil_feedback_reports_user_created ON public.ezil_feedback_reports (user_id, created_at);
CREATE INDEX ezil_feedback_reports_id ON public.ezil_feedback_reports (id);
ALTER TABLE public.ezil_feedback_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_feedback_reports FROM public, anon, authenticated;
CREATE TABLE public.ezil_feedback_access_log (id uuid NOT NULL, report_id uuid NOT NULL, admin_user_id uuid NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL);
CREATE INDEX ezil_feedback_access_log_report ON public.ezil_feedback_access_log (report_id, created_at);
ALTER TABLE public.ezil_feedback_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_feedback_access_log FROM public, anon, authenticated`;

export const FEEDBACK_ATTACHMENTS_SQL = `CREATE TABLE public.ezil_feedback_attachments (report_id uuid NOT NULL, user_id uuid NOT NULL, created_at timestamptz NOT NULL, content_type text NOT NULL, sha256 text NOT NULL, byte_length integer NOT NULL, bytes bytea NOT NULL);
CREATE INDEX ezil_feedback_attachments_report ON public.ezil_feedback_attachments (report_id);
CREATE INDEX ezil_feedback_attachments_created ON public.ezil_feedback_attachments (created_at);
ALTER TABLE public.ezil_feedback_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_feedback_attachments FROM public, anon, authenticated`;

/** Exact content of `app/drizzle/0011_feedback.sql` (psql `-f`, one transaction). */
export const FEEDBACK_MIGRATION_SQL = `-- In-product feedback (docs/FEEDBACK-CONTROLS-CONTRACT.md §4). Staging-only; inert while EZIL_OS_FEEDBACK is off.
${FEEDBACK_REPORTS_SQL};
${FEEDBACK_ATTACHMENTS_SQL};
`;
