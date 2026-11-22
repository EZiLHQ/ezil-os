-- Staging pilot. Apply through the existing reviewed staging migration path.
-- IDs for assignment, owner and computer are pinned by server configuration.
-- One additive migration: the final shape of the former 0034 + 0035 pair
-- (consent v1|v2 with separately consented Chat capture, 32 KiB event detail).
CREATE TABLE public.ezil_assignment_evidence_attempts (
    id uuid PRIMARY KEY,
    assignment_id uuid NOT NULL UNIQUE,
    owner_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    repository_id text NOT NULL CHECK (repository_id ~ '^[a-z0-9]{1,64}$'),
    repository_ref text NOT NULL,
    base_sha text NOT NULL CHECK (base_sha ~ '^[a-f0-9]{40}$'),
    consent_version text NOT NULL,
    started_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > started_at),
    ended_at timestamptz CHECK (ended_at >= started_at),
    last_sequence integer NOT NULL CHECK (last_sequence BETWEEN 1 AND 10002),
    capture_chat boolean NOT NULL DEFAULT false,
    CONSTRAINT assignment_evidence_consent_version
        CHECK (consent_version IN ('assignment-evidence-v1', 'assignment-evidence-v2')),
    CONSTRAINT assignment_evidence_chat_consent
        CHECK (NOT capture_chat OR consent_version = 'assignment-evidence-v2')
);

CREATE TABLE public.ezil_assignment_evidence_events (
    attempt_id uuid NOT NULL REFERENCES public.ezil_assignment_evidence_attempts(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 10002),
    kind text NOT NULL,
    source text NOT NULL CHECK (source IN ('client_reported', 'server_observed')),
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL,
    detail jsonb NOT NULL,
    PRIMARY KEY (attempt_id, id),
    UNIQUE (attempt_id, sequence),
    CONSTRAINT assignment_evidence_detail
        CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 32768)
);

ALTER TABLE public.ezil_assignment_evidence_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ezil_assignment_evidence_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ezil_assignment_evidence_attempts, public.ezil_assignment_evidence_events FROM PUBLIC, anon, authenticated;
