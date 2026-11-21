-- Extend the isolated assignment pilot with separately consented Chat text.
ALTER TABLE public.ezil_assignment_evidence_attempts
    DROP CONSTRAINT ezil_assignment_evidence_attempts_consent_version_check,
    ADD COLUMN capture_chat boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT assignment_evidence_consent_version
        CHECK (consent_version IN ('assignment-evidence-v1', 'assignment-evidence-v2')),
    ADD CONSTRAINT assignment_evidence_chat_consent
        CHECK (NOT capture_chat OR consent_version = 'assignment-evidence-v2');

ALTER TABLE public.ezil_assignment_evidence_events
    DROP CONSTRAINT ezil_assignment_evidence_events_detail_check,
    ADD CONSTRAINT assignment_evidence_detail
        CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 32768);
