-- STAGING DRAFT, unapplied. All inference fields are unverified client metadata, never billing authority.
-- received_at and user_id are server-derived. No prompts, responses, paths, tool payloads or error text.
CREATE TABLE public.ezil_ai_request_traces (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    model_alias varchar(128) NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('completed', 'failed', 'cancelled')),
    input_tokens integer CHECK (input_tokens >= 0),
    output_tokens integer CHECK (output_tokens >= 0),
    cache_read_tokens integer CHECK (cache_read_tokens >= 0),
    cache_write_tokens integer CHECK (cache_write_tokens >= 0),
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    read_heavy boolean NOT NULL,
    metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192),
    PRIMARY KEY (user_id, request_id)
);
CREATE INDEX ezil_ai_request_traces_received ON public.ezil_ai_request_traces (received_at, user_id, request_id);
CREATE INDEX ezil_ai_request_traces_user_received ON public.ezil_ai_request_traces (user_id, received_at, request_id);
ALTER TABLE public.ezil_ai_request_traces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_ai_request_traces FROM public, anon, authenticated;
CREATE TABLE public.ezil_ai_trace_limits (
    user_id uuid PRIMARY KEY,
    window_start timestamptz NOT NULL,
    used integer NOT NULL CHECK (used BETWEEN 1 AND 120)
);
CREATE INDEX ezil_ai_trace_limits_window ON public.ezil_ai_trace_limits (window_start);
ALTER TABLE public.ezil_ai_trace_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_ai_trace_limits FROM public, anon, authenticated;
