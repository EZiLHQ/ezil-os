-- Durable, server-only notification metadata. No historical reports are enqueued.
CREATE TABLE public.ezil_feedback_notifications (report_id uuid NOT NULL, category text NOT NULL, created_at timestamptz NOT NULL, attempts integer NOT NULL, next_attempt_at timestamptz NOT NULL, accepted_at timestamptz NULL, provider_message_id text NULL);
CREATE INDEX ezil_feedback_notifications_due ON public.ezil_feedback_notifications (accepted_at, next_attempt_at);
CREATE INDEX ezil_feedback_notifications_report ON public.ezil_feedback_notifications (report_id);
ALTER TABLE public.ezil_feedback_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_feedback_notifications FROM public, anon, authenticated;
