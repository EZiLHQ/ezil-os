-- STAGING DRAFT, unapplied. Interview evidence v1 (docs/contracts/interview-evidence-v1.md §7). Staging only.
-- Evidence only: no scoring, no WorkScore/TaskScore change, no attention or cheating inference, no camera/face data.
-- Applied by hand on os-staging (deploy request). The drizzle journal stops at 0021 and is NOT edited; raw SQL, like
-- the ai-request-traces slice (0025) whose role/RLS/grant conventions this copies. No shared schema file.
--
-- `at` and `seq` are server-derived; a client's `clientAt` is advisory and never orders. The identity tuple
-- (os_user_id, ezil_id_subject, notice_sha256) is bound once at consent and never changed afterwards.

-- ── Registry: one row per interview, keyed by interviewId, unique by canonical git-qa URL ───────────────────────────
CREATE TABLE public.ezil_interviews (
    interview_id uuid PRIMARY KEY,
    canonical_url text NOT NULL UNIQUE CHECK (
        length(canonical_url) <= 256 AND
        canonical_url ~ '^https://git-qa\.ezil\.work/[A-Za-z0-9]([A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?/[A-Za-z0-9]([A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\.git$'
    ),
    repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,18}$'),
    handle text NOT NULL CHECK (length(handle) BETWEEN 1 AND 100),
    owner_ezil_id_subject text NOT NULL CHECK (length(owner_ezil_id_subject) BETWEEN 1 AND 255),
    works_account_id text NOT NULL CHECK (works_account_id ~ '^[1-9][0-9]{0,18}$'),
    state text NOT NULL DEFAULT 'registered' CHECK (state IN ('registered', 'consented', 'started', 'finished')),
    -- Null until consent; the OS account (GoTrue auth.users.id) the gateway binds its member subject to.
    os_user_id uuid,
    -- Bound at consent; equals owner_ezil_id_subject (the candidate is the Works owner).
    ezil_id_subject text CHECK (ezil_id_subject IS NULL OR length(ezil_id_subject) BETWEEN 1 AND 255),
    notice_sha256 text CHECK (notice_sha256 IS NULL OR notice_sha256 ~ '^[0-9a-f]{64}$'),
    registered_at timestamptz NOT NULL DEFAULT now(),
    consented_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    -- The three binding columns appear together, exactly at consent, and never while still registered.
    CONSTRAINT ezil_interviews_binding_together CHECK (
        (os_user_id IS NULL) = (ezil_id_subject IS NULL) AND (os_user_id IS NULL) = (notice_sha256 IS NULL)
    ),
    CONSTRAINT ezil_interviews_registered_unbound CHECK (state <> 'registered' OR os_user_id IS NULL),
    CONSTRAINT ezil_interviews_consented_bound CHECK (state NOT IN ('consented', 'started') OR os_user_id IS NOT NULL)
);
CREATE INDEX ezil_interviews_owner ON public.ezil_interviews (owner_ezil_id_subject);
CREATE INDEX ezil_interviews_os_user ON public.ezil_interviews (os_user_id);

-- ── Events: append-only, gapless `seq` per interview (source is always 'os' here) ───────────────────────────────────
CREATE TABLE public.ezil_interview_events (
    interview_id uuid NOT NULL REFERENCES public.ezil_interviews (interview_id),
    seq integer NOT NULL CHECK (seq >= 1),
    source text NOT NULL DEFAULT 'os' CHECK (source = 'os'),
    -- Closed type list for OS (contract §3). works/gateway types are rejected here.
    type text NOT NULL CHECK (type IN (
        'consent.accepted', 'interview.started', 'computer.opened', 'tab.visibility', 'window.focus',
        'app.focus', 'presence.idle', 'session.heartbeat', 'agent.turn_start', 'agent.turn_end', 'interview.finished'
    )),
    at timestamptz NOT NULL DEFAULT now(),
    -- Only on client-reported types; advisory, never used for ordering.
    client_at timestamptz,
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 8192),
    PRIMARY KEY (interview_id, seq)
);
CREATE INDEX ezil_interview_events_at ON public.ezil_interview_events (at);

-- ── Forward-only state machine; the identity tuple is immutable once bound (contract §1, §7.2) ──────────────────────
CREATE OR REPLACE FUNCTION public.ezil_interviews_forward_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state <> OLD.state AND NOT (
        (OLD.state = 'registered' AND NEW.state IN ('consented', 'finished'))
        OR (OLD.state = 'consented' AND NEW.state IN ('started', 'finished'))
        OR (OLD.state = 'started' AND NEW.state = 'finished')
    ) THEN
        RAISE EXCEPTION 'ezil_interviews state is forward-only (% -> %)', OLD.state, NEW.state;
    END IF;
    IF OLD.os_user_id IS NOT NULL AND NEW.os_user_id IS DISTINCT FROM OLD.os_user_id THEN
        RAISE EXCEPTION 'ezil_interviews os_user_id is immutable once bound';
    END IF;
    IF OLD.ezil_id_subject IS NOT NULL AND NEW.ezil_id_subject IS DISTINCT FROM OLD.ezil_id_subject THEN
        RAISE EXCEPTION 'ezil_interviews ezil_id_subject is immutable once bound';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ezil_interviews_forward_only ON public.ezil_interviews;
CREATE TRIGGER ezil_interviews_forward_only BEFORE UPDATE ON public.ezil_interviews
    FOR EACH ROW EXECUTE FUNCTION public.ezil_interviews_forward_only();

-- ── Events are append-only: UPDATE is always refused ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ezil_interview_events_no_update() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ezil_interview_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS ezil_interview_events_no_update ON public.ezil_interview_events;
CREATE TRIGGER ezil_interview_events_no_update BEFORE UPDATE ON public.ezil_interview_events
    FOR EACH ROW EXECUTE FUNCTION public.ezil_interview_events_no_update();

-- ── DELETE is refused unless the row is older than the 30-day activity retention ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.ezil_interview_events_retention_delete() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.at >= now() - interval '30 days' THEN
        RAISE EXCEPTION 'ezil_interview_events rows are deletable only after 30 days (at %)', OLD.at;
    END IF;
    RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS ezil_interview_events_retention_delete ON public.ezil_interview_events;
CREATE TRIGGER ezil_interview_events_retention_delete BEFORE DELETE ON public.ezil_interview_events
    FOR EACH ROW EXECUTE FUNCTION public.ezil_interview_events_retention_delete();

-- ── An insert is refused unless the interview is `started`, with the two transition exceptions (contract §7.2) ──────
--    consent.accepted only inside registered->consented; interview.finished only inside ->finished; all else started.
CREATE OR REPLACE FUNCTION public.ezil_interview_events_insert_state() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE cur text;
BEGIN
    SELECT state INTO cur FROM public.ezil_interviews WHERE interview_id = NEW.interview_id;
    IF cur IS NULL THEN
        RAISE EXCEPTION 'ezil_interview_events insert for unknown interview %', NEW.interview_id;
    ELSIF NEW.type = 'consent.accepted' THEN
        IF cur <> 'consented' THEN RAISE EXCEPTION 'consent.accepted only during registered->consented (state %)', cur; END IF;
    ELSIF NEW.type = 'interview.finished' THEN
        IF cur <> 'finished' THEN RAISE EXCEPTION 'interview.finished only during ->finished (state %)', cur; END IF;
    ELSIF cur <> 'started' THEN
        RAISE EXCEPTION 'event % only while started (state %)', NEW.type, cur;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ezil_interview_events_insert_state ON public.ezil_interview_events;
CREATE TRIGGER ezil_interview_events_insert_state BEFORE INSERT ON public.ezil_interview_events
    FOR EACH ROW EXECUTE FUNCTION public.ezil_interview_events_insert_state();

-- ── Per-user rate limit for the client events route: 120 events / minute (mirrors ezil_ai_trace_limits) ─────────────
CREATE TABLE public.ezil_interview_event_limits (
    os_user_id uuid PRIMARY KEY,
    window_start timestamptz NOT NULL,
    used integer NOT NULL CHECK (used BETWEEN 1 AND 120)
);
CREATE INDEX ezil_interview_event_limits_window ON public.ezil_interview_event_limits (window_start);

-- ── Server-only: the app's service connection writes these; browser roles (anon, authenticated) never touch them ────
ALTER TABLE public.ezil_interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ezil_interview_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ezil_interview_event_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_interviews FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.ezil_interview_events FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.ezil_interview_event_limits FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.ezil_interviews_forward_only() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.ezil_interview_events_no_update() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.ezil_interview_events_retention_delete() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.ezil_interview_events_insert_state() FROM public, anon, authenticated;
