-- Durable, server-only incident alert outbox and collection health. Metadata only; no history is enqueued.
CREATE TABLE public.ezil_telemetry_alerts (outbox_key text NOT NULL, fingerprint text NOT NULL, event_class text NOT NULL, site text NOT NULL, code text NOT NULL, distinct_users integer NOT NULL, event_count integer NOT NULL, window_start timestamptz NOT NULL, window_end timestamptz NOT NULL, created_at timestamptz NOT NULL, attempts integer NOT NULL, next_attempt_at timestamptz NOT NULL, accepted_at timestamptz NULL, provider_message_id text NULL);
CREATE UNIQUE INDEX ezil_telemetry_alerts_key ON public.ezil_telemetry_alerts (outbox_key);
CREATE INDEX ezil_telemetry_alerts_due ON public.ezil_telemetry_alerts (accepted_at, next_attempt_at);
CREATE INDEX ezil_telemetry_alerts_fingerprint ON public.ezil_telemetry_alerts (fingerprint, created_at);
ALTER TABLE public.ezil_telemetry_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_telemetry_alerts FROM public, anon, authenticated;
CREATE TABLE public.ezil_telemetry_alert_health (id integer NOT NULL, first_observed_at timestamptz NOT NULL, last_scan_at timestamptz NULL, last_event_at timestamptz NULL, last_accepted_at timestamptz NULL, last_failure_at timestamptz NULL, consecutive_failures integer NOT NULL, dropped_total integer NOT NULL, silent_alerted_at timestamptz NULL);
CREATE UNIQUE INDEX ezil_telemetry_alert_health_id ON public.ezil_telemetry_alert_health (id);
ALTER TABLE public.ezil_telemetry_alert_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_telemetry_alert_health FROM public, anon, authenticated;
