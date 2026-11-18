-- RESERVED SOURCE MIGRATION, unapplied. Native runtime control (docs/NATIVE-RUNTIME-CONTROL-v1.md): server-only
-- control leases, immutable (owner, request) control requests with their outbox state, and permanent cancel
-- tombstones, written only by app/src/server/native-session/runtime-store.ts. Registered as a production snapshot
-- only; not in the staging runner's explicit list and not in the Drizzle journal. 0031 is reserved for the
-- auth-intent lane. No token, proof, credential or AI grant column. No foreign key to computers or users: a request
-- identity outlives computer deletion, reassignment and account removal. Rows are never deleted or truncated.
CREATE TABLE public.ezil_native_runtime_leases (
    control_authorization_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    client_id text NOT NULL,
    session_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    runtime_id uuid NULL,
    host_epoch text NULL,
    placement_generation bigint NOT NULL,
    placement_lease_epoch bigint NOT NULL,
    placement_instance_id text NOT NULL,
    placement_fence_token uuid NOT NULL,
    profile text NOT NULL,
    policy_digest text NULL,
    ai_authorization_id uuid NOT NULL,
    action_set text NOT NULL,
    prepared_request_id uuid NOT NULL,
    lease_digest text NOT NULL,
    state text NOT NULL,
    consent_expires_at timestamptz NOT NULL,
    control_deadline timestamptz NOT NULL,
    decided_at timestamptz NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT ezil_native_runtime_leases_pkey PRIMARY KEY (control_authorization_id),
    CONSTRAINT ezil_native_runtime_leases_client_check CHECK (char_length(client_id) BETWEEN 1 AND 512),
    CONSTRAINT ezil_native_runtime_leases_runtime_check CHECK ((runtime_id IS NULL) = (host_epoch IS NULL)
        AND (host_epoch IS NULL OR host_epoch ~ '^[A-Za-z0-9_-]{1,128}$')
        AND (runtime_id IS NOT NULL OR action_set = 'cancel_only')),
    CONSTRAINT ezil_native_runtime_leases_placement_check CHECK (placement_generation >= 0 AND placement_lease_epoch >= 0
        AND placement_instance_id ~ '^i-[0-9a-f]{8,17}$'),
    CONSTRAINT ezil_native_runtime_leases_profile_check CHECK (profile = 'ezil-native-claude-v1'),
    CONSTRAINT ezil_native_runtime_leases_policy_check CHECK (policy_digest IS NULL OR policy_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ezil_native_runtime_leases_action_set_check CHECK (action_set IN ('runtime', 'cancel_only')),
    CONSTRAINT ezil_native_runtime_leases_digest_check CHECK (lease_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT ezil_native_runtime_leases_state_check CHECK (state IN ('required', 'approved', 'denied')
        AND (decided_at IS NULL) = (state = 'required')),
    CONSTRAINT ezil_native_runtime_leases_window_check CHECK (consent_expires_at <= control_deadline
        AND created_at < consent_expires_at)
);
CREATE INDEX ezil_native_runtime_leases_scope
    ON public.ezil_native_runtime_leases (owner_user_id, session_id, runtime_id, state, control_deadline);

CREATE TABLE public.ezil_native_runtime_requests (
    owner_user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    client_id text NOT NULL,
    session_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    kind text NOT NULL,
    request_digest text NOT NULL,
    instruction_digest text NULL,
    instruction text NULL,
    prompt_id uuid NULL,
    prompt_revision integer NULL,
    prompt_input_digest text NULL,
    decision text NULL,
    message text NULL,
    target_request_id uuid NULL,
    prompt_snapshot jsonb NULL,
    control_authorization_id uuid NULL REFERENCES public.ezil_native_runtime_leases (control_authorization_id),
    request_deadline timestamptz NULL,
    state text NOT NULL,
    effect text NOT NULL,
    reason text NULL,
    dispatch_claimed_at timestamptz NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT ezil_native_runtime_requests_pkey PRIMARY KEY (owner_user_id, request_id),
    CONSTRAINT ezil_native_runtime_requests_client_check CHECK (char_length(client_id) BETWEEN 1 AND 512),
    CONSTRAINT ezil_native_runtime_requests_kind_check CHECK (kind IN ('send', 'answer', 'cancel')),
    CONSTRAINT ezil_native_runtime_requests_digest_check CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT ezil_native_runtime_requests_send_check CHECK ((kind = 'send') = (instruction IS NOT NULL)
        AND (instruction IS NULL) = (instruction_digest IS NULL)
        AND (instruction_digest IS NULL OR instruction_digest ~ '^sha256:[0-9a-f]{64}$')
        AND (instruction IS NULL OR octet_length(instruction) BETWEEN 1 AND 16384)),
    CONSTRAINT ezil_native_runtime_requests_answer_check CHECK ((kind = 'answer') = (prompt_id IS NOT NULL)
        AND (prompt_id IS NULL) = (prompt_revision IS NULL) AND (prompt_id IS NULL) = (prompt_input_digest IS NULL)
        AND (prompt_id IS NULL) = (decision IS NULL)
        AND (prompt_revision IS NULL OR prompt_revision >= 1)
        AND (prompt_input_digest IS NULL OR prompt_input_digest ~ '^[0-9a-f]{64}$')
        AND (decision IS NULL OR decision IN ('allow', 'deny'))
        AND (message IS NULL OR (decision = 'deny' AND octet_length(message) BETWEEN 1 AND 2048))
        AND (prompt_snapshot IS NULL OR kind = 'answer')),
    CONSTRAINT ezil_native_runtime_requests_cancel_check CHECK ((kind = 'cancel') = (target_request_id IS NOT NULL)
        AND target_request_id IS DISTINCT FROM request_id),
    CONSTRAINT ezil_native_runtime_requests_state_check CHECK (state IN ('authorization_required', 'authorization_denied',
        'authorization_expired', 'blocked', 'approved', 'dispatching', 'host_refused', 'dispatch_unknown', 'recorded',
        'delivering', 'accepted', 'cancelling', 'completed', 'failed', 'cancelled', 'unknown', 'cancelled_before_dispatch')),
    CONSTRAINT ezil_native_runtime_requests_effect_check CHECK (effect IN ('none', 'tombstone_before_dispatch', 'recorded',
        'written_unacknowledged', 'native_observed', 'unknown')
        AND (state NOT IN ('authorization_required', 'authorization_denied', 'authorization_expired', 'approved',
            'dispatching', 'host_refused') OR effect = 'none')
        AND (state <> 'blocked' OR effect = 'none' OR dispatch_claimed_at IS NOT NULL)
        AND (state <> 'cancelled_before_dispatch' OR effect = 'tombstone_before_dispatch')
        AND (state <> 'dispatch_unknown' OR effect = 'unknown')
        -- A tombstone is either the OS's own (the target, cancelled_before_dispatch, never claimed; or the cancel itself,
        -- completed unclaimed) or Core's answer to a claimed cancel RPC (cancelled or completed). Never send/answer.
        AND (effect <> 'tombstone_before_dispatch' OR state = 'cancelled_before_dispatch'
            OR (kind = 'cancel' AND state IN ('completed', 'cancelled')))),
    CONSTRAINT ezil_native_runtime_requests_lease_check CHECK ((control_authorization_id IS NULL) = (request_deadline IS NULL)
        AND (control_authorization_id IS NOT NULL OR state IN ('blocked', 'cancelled_before_dispatch'))),
    -- The outbox: claimed once (approved > dispatching) and never again. Pre-dispatch states have no claim, every
    -- post-dispatch state has one; blocked and completed exist both ways (refused or tombstoned before dispatch).
    CONSTRAINT ezil_native_runtime_requests_dispatch_check CHECK (
        (state IN ('authorization_required', 'authorization_denied', 'authorization_expired', 'approved',
            'cancelled_before_dispatch') AND dispatch_claimed_at IS NULL)
        OR state IN ('blocked', 'completed')
        OR dispatch_claimed_at IS NOT NULL),
    CONSTRAINT ezil_native_runtime_requests_reason_check CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$')
);
CREATE INDEX ezil_native_runtime_requests_lease
    ON public.ezil_native_runtime_requests (control_authorization_id) WHERE control_authorization_id IS NOT NULL;
CREATE INDEX ezil_native_runtime_requests_target
    ON public.ezil_native_runtime_requests (owner_user_id, target_request_id) WHERE target_request_id IS NOT NULL;

CREATE TABLE public.ezil_native_runtime_tombstones (
    owner_user_id uuid NOT NULL,
    target_request_id uuid NOT NULL,
    session_id uuid NOT NULL,
    client_id text NOT NULL,
    cancel_request_id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT ezil_native_runtime_tombstones_pkey PRIMARY KEY (owner_user_id, target_request_id),
    CONSTRAINT ezil_native_runtime_tombstones_self_check CHECK (cancel_request_id <> target_request_id)
);

CREATE FUNCTION public.ezil_native_runtime_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'UPDATE' OR TG_TABLE_NAME = 'ezil_native_runtime_tombstones' THEN
        RAISE EXCEPTION 'native runtime control rows are permanent' USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_TABLE_NAME = 'ezil_native_runtime_leases' THEN
        IF (NEW.control_authorization_id, NEW.owner_user_id, NEW.client_id, NEW.session_id, NEW.computer_id, NEW.runtime_id,
            NEW.host_epoch, NEW.placement_generation, NEW.placement_lease_epoch, NEW.placement_instance_id,
            NEW.placement_fence_token, NEW.profile, NEW.policy_digest, NEW.ai_authorization_id, NEW.action_set,
            NEW.prepared_request_id, NEW.lease_digest, NEW.consent_expires_at, NEW.control_deadline, NEW.created_at)
            IS DISTINCT FROM (OLD.control_authorization_id, OLD.owner_user_id, OLD.client_id, OLD.session_id, OLD.computer_id,
            OLD.runtime_id, OLD.host_epoch, OLD.placement_generation, OLD.placement_lease_epoch, OLD.placement_instance_id,
            OLD.placement_fence_token, OLD.profile, OLD.policy_digest, OLD.ai_authorization_id, OLD.action_set,
            OLD.prepared_request_id, OLD.lease_digest, OLD.consent_expires_at, OLD.control_deadline, OLD.created_at) THEN
            RAISE EXCEPTION 'native runtime lease identity is immutable' USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.state || '>' || NEW.state NOT IN ('required>approved', 'required>denied') THEN
            RAISE EXCEPTION 'illegal native runtime lease transition' USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.owner_user_id, NEW.request_id, NEW.client_id, NEW.session_id, NEW.computer_id, NEW.kind, NEW.request_digest,
        NEW.instruction_digest, NEW.instruction, NEW.prompt_id, NEW.prompt_revision, NEW.prompt_input_digest, NEW.decision,
        NEW.message, NEW.target_request_id, NEW.prompt_snapshot, NEW.control_authorization_id, NEW.request_deadline,
        NEW.created_at)
        IS DISTINCT FROM (OLD.owner_user_id, OLD.request_id, OLD.client_id, OLD.session_id, OLD.computer_id, OLD.kind,
        OLD.request_digest, OLD.instruction_digest, OLD.instruction, OLD.prompt_id, OLD.prompt_revision,
        OLD.prompt_input_digest, OLD.decision, OLD.message, OLD.target_request_id, OLD.prompt_snapshot,
        OLD.control_authorization_id, OLD.request_deadline, OLD.created_at) THEN
        RAISE EXCEPTION 'native runtime request identity is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.dispatch_claimed_at IS NOT NULL AND NEW.dispatch_claimed_at IS DISTINCT FROM OLD.dispatch_claimed_at THEN
        RAISE EXCEPTION 'native runtime dispatch claim is permanent' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.state || '>' || NEW.state NOT IN (
        'authorization_required>approved', 'authorization_required>authorization_denied',
        'authorization_required>authorization_expired', 'authorization_required>cancelled_before_dispatch',
        'approved>dispatching', 'approved>blocked', 'approved>cancelled_before_dispatch', 'approved>completed',
        'dispatching>host_refused', 'dispatching>dispatch_unknown', 'dispatching>blocked', 'dispatching>recorded',
        'dispatching>delivering', 'dispatching>accepted', 'dispatching>cancelling', 'dispatching>completed',
        'dispatching>failed', 'dispatching>cancelled', 'dispatching>unknown',
        'recorded>delivering', 'recorded>accepted', 'recorded>cancelling', 'recorded>completed', 'recorded>failed',
        'recorded>cancelled', 'recorded>unknown', 'recorded>recorded',
        'delivering>accepted', 'delivering>cancelling', 'delivering>completed', 'delivering>failed',
        'delivering>cancelled', 'delivering>unknown',
        'accepted>cancelling', 'accepted>completed', 'accepted>failed', 'accepted>cancelled', 'accepted>unknown',
        'cancelling>cancelled', 'cancelling>completed', 'cancelling>failed', 'cancelling>unknown',
        'dispatch_unknown>recorded', 'dispatch_unknown>delivering', 'dispatch_unknown>accepted',
        'dispatch_unknown>cancelling', 'dispatch_unknown>completed', 'dispatch_unknown>failed',
        'dispatch_unknown>cancelled', 'dispatch_unknown>blocked',
        'unknown>recorded', 'unknown>delivering', 'unknown>accepted', 'unknown>cancelling', 'unknown>completed',
        'unknown>failed', 'unknown>cancelled') THEN
        RAISE EXCEPTION 'illegal native runtime request transition' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER ezil_native_runtime_leases_guard_rows BEFORE UPDATE OR DELETE ON public.ezil_native_runtime_leases
    FOR EACH ROW EXECUTE FUNCTION public.ezil_native_runtime_guard();
CREATE TRIGGER ezil_native_runtime_leases_guard_truncate BEFORE TRUNCATE ON public.ezil_native_runtime_leases
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_native_runtime_guard();
CREATE TRIGGER ezil_native_runtime_requests_guard_rows BEFORE UPDATE OR DELETE ON public.ezil_native_runtime_requests
    FOR EACH ROW EXECUTE FUNCTION public.ezil_native_runtime_guard();
CREATE TRIGGER ezil_native_runtime_requests_guard_truncate BEFORE TRUNCATE ON public.ezil_native_runtime_requests
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_native_runtime_guard();
CREATE TRIGGER ezil_native_runtime_tombstones_guard_rows BEFORE UPDATE OR DELETE ON public.ezil_native_runtime_tombstones
    FOR EACH ROW EXECUTE FUNCTION public.ezil_native_runtime_guard();
CREATE TRIGGER ezil_native_runtime_tombstones_guard_truncate BEFORE TRUNCATE ON public.ezil_native_runtime_tombstones
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_native_runtime_guard();
REVOKE ALL ON FUNCTION public.ezil_native_runtime_guard() FROM public, anon, authenticated;
ALTER TABLE public.ezil_native_runtime_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ezil_native_runtime_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ezil_native_runtime_tombstones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_native_runtime_leases FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.ezil_native_runtime_requests FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.ezil_native_runtime_tombstones FROM public, anon, authenticated;
