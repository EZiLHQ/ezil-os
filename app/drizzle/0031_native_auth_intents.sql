-- RESERVED SOURCE MIGRATION, unapplied. Native authorization intents and the private task artifacts sealed on
-- consent: written only by app/src/server/native-auth/store.ts. Registered as a production snapshot only; it is not
-- in the staging runner's explicit list and not in the Drizzle journal. 0030 is reserved for the receiver lane.
-- Requires 0029: the approved>blocked guard reads ezil_native_session_operations.
-- No token, proof, grant or credential column. Intents are never deleted, truncated or re-keyed: an operation id
-- that was used once conflicts forever on different input. The instruction text is private to its owner: RLS on,
-- nothing granted to anon or authenticated, and it never leaves the server except to the owner's consent page and
-- the private host delivery.
CREATE TABLE public.ezil_native_auth_intents (
    user_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL,
    session_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    instruction_revision bigint NULL,
    instruction_digest text NULL,
    instruction text NULL,
    instruction_bytes integer NULL,
    input_digest text NOT NULL,
    client_id text NOT NULL,
    idp_issuer text NOT NULL,
    subject text NOT NULL,
    scope text NOT NULL,
    state text NOT NULL,
    reason text NULL,
    -- Finite consent terms, set once on approval (a renewal copies its session create's terms unchanged).
    authz_id uuid NULL,
    consent_epoch text NULL,
    budget_micro text NULL,
    policy_id uuid NULL,
    service text NULL,
    profile text NULL,
    initial_approval_at timestamptz NULL,
    authorization_deadline timestamptz NULL,
    -- The full placement tuple pinned under the owner and computer locks at approval (a renewal copies it).
    approved_placement_generation bigint NULL,
    approved_placement_lease_epoch bigint NULL,
    approved_placement_instance_id text NULL,
    approved_placement_fence_token uuid NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    decided_at timestamptz NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT ezil_native_auth_intents_pkey PRIMARY KEY (user_id, operation_id),
    CONSTRAINT ezil_native_auth_intents_kind_check CHECK (kind IN ('create', 'renew')),
    -- IS TRUE: a NULL comparison would otherwise satisfy the CHECK and admit a create without its instruction.
    CONSTRAINT ezil_native_auth_intents_instruction_check CHECK ((CASE kind
        WHEN 'create' THEN instruction_revision IS NOT NULL AND instruction_digest IS NOT NULL AND instruction IS NOT NULL
            AND instruction_bytes IS NOT NULL AND instruction_revision = 1 AND instruction_digest ~ '^sha256:[0-9a-f]{64}$'
            AND instruction_bytes = octet_length(instruction) AND instruction_bytes BETWEEN 1 AND 16384
        ELSE instruction_revision IS NULL AND instruction_digest IS NULL AND instruction IS NULL AND instruction_bytes IS NULL END) IS TRUE),
    CONSTRAINT ezil_native_auth_intents_input_digest_check CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT ezil_native_auth_intents_actor_check CHECK (length(client_id) BETWEEN 1 AND 256 AND length(idp_issuer) BETWEEN 1 AND 512
        AND length(subject) BETWEEN 1 AND 256 AND scope ~ '^[\x21-\x7e]+( [\x21-\x7e]+)*$' AND length(scope) <= 1024),
    CONSTRAINT ezil_native_auth_intents_state_check CHECK (state IN ('required', 'approved', 'denied', 'expired', 'blocked')),
    CONSTRAINT ezil_native_auth_intents_reason_check CHECK ((reason IS NULL) = (state <> 'blocked')
        AND (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$')),
    CONSTRAINT ezil_native_auth_intents_expiry_check CHECK (expires_at = created_at + interval '5 minutes'),
    CONSTRAINT ezil_native_auth_intents_decided_check CHECK ((decided_at IS NULL) = (state = 'required')),
    -- All terms or none (IS TRUE: NULL never satisfies the CHECK). The challenge (expires_at, five minutes) and the
    -- consent (authorization_deadline, at most 24 hours after the first approval) are separate clocks.
    CONSTRAINT ezil_native_auth_intents_terms_check CHECK ((
        (authz_id IS NULL AND consent_epoch IS NULL AND budget_micro IS NULL AND policy_id IS NULL AND service IS NULL AND profile IS NULL
            AND initial_approval_at IS NULL AND authorization_deadline IS NULL AND approved_placement_generation IS NULL
            AND approved_placement_lease_epoch IS NULL AND approved_placement_instance_id IS NULL AND approved_placement_fence_token IS NULL)
        OR (authz_id IS NOT NULL AND consent_epoch IS NOT NULL AND budget_micro IS NOT NULL AND policy_id IS NOT NULL AND service IS NOT NULL
            AND profile IS NOT NULL AND initial_approval_at IS NOT NULL AND authorization_deadline IS NOT NULL
            AND approved_placement_generation IS NOT NULL AND approved_placement_lease_epoch IS NOT NULL
            AND approved_placement_instance_id IS NOT NULL AND approved_placement_fence_token IS NOT NULL
            AND approved_placement_generation >= 1 AND approved_placement_lease_epoch >= 1
            AND approved_placement_instance_id ~ '^i-[0-9a-f]{8,17}$'
            AND state IN ('approved', 'blocked') AND consent_epoch ~ '^[1-9][0-9]{0,18}$' AND budget_micro ~ '^[1-9][0-9]{0,18}$'
            AND service = 'ezil-os-native' AND profile = 'ezil-native-claude-v1'
            AND initial_approval_at = date_trunc('milliseconds', initial_approval_at)
            AND authorization_deadline = date_trunc('milliseconds', authorization_deadline)
            AND authorization_deadline > initial_approval_at AND authorization_deadline <= initial_approval_at + interval '24 hours')
    ) IS TRUE)
);
-- One create intent per (owner, session): a second create for the same session is refused at prepare time.
CREATE UNIQUE INDEX ezil_native_auth_intents_one_create
    ON public.ezil_native_auth_intents (user_id, session_id) WHERE kind = 'create';
CREATE FUNCTION public.ezil_native_auth_intents_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'native auth intents are permanent' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.user_id, NEW.operation_id, NEW.kind, NEW.session_id, NEW.computer_id, NEW.instruction_revision, NEW.instruction_digest,
        NEW.instruction, NEW.instruction_bytes, NEW.input_digest, NEW.client_id, NEW.idp_issuer, NEW.subject, NEW.scope,
        NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.user_id, OLD.operation_id, OLD.kind, OLD.session_id, OLD.computer_id, OLD.instruction_revision,
        OLD.instruction_digest, OLD.instruction, OLD.instruction_bytes, OLD.input_digest, OLD.client_id, OLD.idp_issuer, OLD.subject,
        OLD.scope, OLD.created_at, OLD.expires_at) THEN
        RAISE EXCEPTION 'native auth intent identity is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    -- Terms are written exactly once, by the required>approved move; an earlier approved row never gains them.
    IF (NEW.authz_id, NEW.consent_epoch, NEW.budget_micro, NEW.policy_id, NEW.service, NEW.profile, NEW.initial_approval_at,
        NEW.authorization_deadline, NEW.approved_placement_generation, NEW.approved_placement_lease_epoch, NEW.approved_placement_instance_id,
        NEW.approved_placement_fence_token) IS DISTINCT FROM (OLD.authz_id, OLD.consent_epoch, OLD.budget_micro, OLD.policy_id, OLD.service,
        OLD.profile, OLD.initial_approval_at, OLD.authorization_deadline, OLD.approved_placement_generation, OLD.approved_placement_lease_epoch,
        OLD.approved_placement_instance_id, OLD.approved_placement_fence_token)
        AND NOT (OLD.state = 'required' AND NEW.state = 'approved' AND OLD.authz_id IS NULL) THEN
        RAISE EXCEPTION 'native auth intent consent terms are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.decided_at IS NOT NULL AND NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
        RAISE EXCEPTION 'native auth intent decision time is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.state || '>' || NEW.state NOT IN ('required>approved', 'required>denied', 'required>expired', 'required>blocked',
        'approved>blocked') THEN
        RAISE EXCEPTION 'illegal native auth intent transition' USING ERRCODE = 'restrict_violation';
    END IF;
    -- approved>blocked records ONLY a definite pre-claim refusal of the one dispatch attempt: no native session
    -- operation exists under this key in any state, so nothing was exchanged or dispatched. Once one exists, even
    -- unknown, the intent stays approved and its exact operation state is what status reports.
    IF OLD.state = 'approved' AND EXISTS (SELECT 1 FROM public.ezil_native_session_operations o
        WHERE o.user_id = OLD.user_id AND o.operation_id = OLD.operation_id) THEN
        RAISE EXCEPTION 'native auth intent already dispatched' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.state = 'approved' AND clock_timestamp() >= OLD.expires_at THEN
        RAISE EXCEPTION 'native auth intent expired' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.state = 'expired' AND clock_timestamp() < OLD.expires_at THEN
        RAISE EXCEPTION 'native auth intent not yet expired' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER ezil_native_auth_intents_guard_rows BEFORE UPDATE OR DELETE ON public.ezil_native_auth_intents
    FOR EACH ROW EXECUTE FUNCTION public.ezil_native_auth_intents_guard();
CREATE TRIGGER ezil_native_auth_intents_guard_truncate BEFORE TRUNCATE ON public.ezil_native_auth_intents
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_native_auth_intents_guard();
REVOKE ALL ON FUNCTION public.ezil_native_auth_intents_guard() FROM public, anon, authenticated;
ALTER TABLE public.ezil_native_auth_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_native_auth_intents FROM public, anon, authenticated;

-- The owner's local STOP of a whole AI consent (one authz_id, shared by its create and derived renewals). A terminal
-- tombstone: once written, the consent binding is never readable again and no renewal derives from it, whatever the
-- Gateway-side revocation outcome. It never changes, resumes or cancels an existing operation. Insert-only.
-- It captures the immutable consent binding at the moment of the stop, with a stable gateway-revoke operation id, so
-- the Gateway revocation can still be sent (also for an authorization never issued) after the getter refuses it.
CREATE TABLE public.ezil_native_consent_revocations (
    user_id uuid NOT NULL,
    authz_id uuid NOT NULL,
    consent_operation_id uuid NOT NULL,
    gateway_revoke_operation_id uuid NOT NULL,
    session_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    client_id text NOT NULL,
    policy_id uuid NOT NULL,
    consent_epoch text NOT NULL,
    budget_micro text NOT NULL,
    initial_approval_at timestamptz NOT NULL,
    authorization_deadline timestamptz NOT NULL,
    approved_placement_generation bigint NOT NULL,
    approved_placement_lease_epoch bigint NOT NULL,
    approved_placement_instance_id text NOT NULL,
    approved_placement_fence_token uuid NOT NULL,
    revoked_at timestamptz NOT NULL,
    CONSTRAINT ezil_native_consent_revocations_pkey PRIMARY KEY (user_id, authz_id),
    CONSTRAINT ezil_native_consent_revocations_consent_key UNIQUE (user_id, consent_operation_id),
    CONSTRAINT ezil_native_consent_revocations_gateway_key UNIQUE (gateway_revoke_operation_id),
    CONSTRAINT ezil_native_consent_revocations_consent_fkey FOREIGN KEY (user_id, consent_operation_id)
        REFERENCES public.ezil_native_auth_intents (user_id, operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE FUNCTION public.ezil_native_consent_revocations_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'native consent revocations are permanent' USING ERRCODE = 'restrict_violation';
    END IF;
    -- The captured binding must be the owner's create consent, field for field.
    IF NOT EXISTS (SELECT 1 FROM public.ezil_native_auth_intents i
        WHERE i.user_id = NEW.user_id AND i.operation_id = NEW.consent_operation_id AND i.kind = 'create' AND i.authz_id = NEW.authz_id
            AND i.session_id = NEW.session_id AND i.computer_id = NEW.computer_id AND i.client_id = NEW.client_id
            AND i.policy_id = NEW.policy_id AND i.consent_epoch = NEW.consent_epoch AND i.budget_micro = NEW.budget_micro
            AND i.initial_approval_at = NEW.initial_approval_at AND i.authorization_deadline = NEW.authorization_deadline
            AND i.approved_placement_generation = NEW.approved_placement_generation
            AND i.approved_placement_lease_epoch = NEW.approved_placement_lease_epoch
            AND i.approved_placement_instance_id = NEW.approved_placement_instance_id
            AND i.approved_placement_fence_token = NEW.approved_placement_fence_token) THEN
        RAISE EXCEPTION 'native consent revocation does not match a consent of that owner' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER ezil_native_consent_revocations_guard_rows BEFORE INSERT OR UPDATE OR DELETE ON public.ezil_native_consent_revocations
    FOR EACH ROW EXECUTE FUNCTION public.ezil_native_consent_revocations_guard();
CREATE TRIGGER ezil_native_consent_revocations_guard_truncate BEFORE TRUNCATE ON public.ezil_native_consent_revocations
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_native_consent_revocations_guard();
REVOKE ALL ON FUNCTION public.ezil_native_consent_revocations_guard() FROM public, anon, authenticated;
ALTER TABLE public.ezil_native_consent_revocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_native_consent_revocations FROM public, anon, authenticated;

-- The owner- and operation-bound task a consented create intent admits. Sealed once, in the approving
-- transaction, from the approved intent itself; never updated or deleted. Resolved by task_ref
-- `native-task:<operation_id>` for the owner only.
CREATE TABLE public.ezil_native_task_artifacts (
    user_id uuid NOT NULL,
    task_ref text NOT NULL,
    operation_id uuid NOT NULL,
    session_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    instruction_revision bigint NOT NULL,
    instruction_digest text NOT NULL,
    instruction text NOT NULL,
    instruction_bytes integer NOT NULL,
    sealed_at timestamptz NOT NULL,
    CONSTRAINT ezil_native_task_artifacts_pkey PRIMARY KEY (user_id, task_ref),
    CONSTRAINT ezil_native_task_artifacts_operation_key UNIQUE (user_id, operation_id),
    CONSTRAINT ezil_native_task_artifacts_intent_fkey FOREIGN KEY (user_id, operation_id)
        REFERENCES public.ezil_native_auth_intents (user_id, operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ezil_native_task_artifacts_task_ref_check CHECK (task_ref = 'native-task:' || operation_id::text),
    CONSTRAINT ezil_native_task_artifacts_instruction_check CHECK (instruction_revision = 1
        AND instruction_digest ~ '^sha256:[0-9a-f]{64}$' AND instruction_bytes = octet_length(instruction)
        AND instruction_bytes BETWEEN 1 AND 16384)
);
CREATE FUNCTION public.ezil_native_task_artifacts_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'native task artifacts are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    -- Sealed only from an approved create intent of the same owner and operation, field for field.
    IF NOT EXISTS (SELECT 1 FROM public.ezil_native_auth_intents i
        WHERE i.user_id = NEW.user_id AND i.operation_id = NEW.operation_id AND i.kind = 'create' AND i.state = 'approved'
            AND i.session_id = NEW.session_id AND i.computer_id = NEW.computer_id
            AND i.instruction_revision = NEW.instruction_revision AND i.instruction_digest = NEW.instruction_digest
            AND i.instruction = NEW.instruction AND i.instruction_bytes = NEW.instruction_bytes) THEN
        RAISE EXCEPTION 'native task artifact has no approved intent' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER ezil_native_task_artifacts_guard_rows BEFORE INSERT OR UPDATE OR DELETE ON public.ezil_native_task_artifacts
    FOR EACH ROW EXECUTE FUNCTION public.ezil_native_task_artifacts_guard();
CREATE TRIGGER ezil_native_task_artifacts_guard_truncate BEFORE TRUNCATE ON public.ezil_native_task_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_native_task_artifacts_guard();
REVOKE ALL ON FUNCTION public.ezil_native_task_artifacts_guard() FROM public, anon, authenticated;
ALTER TABLE public.ezil_native_task_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_native_task_artifacts FROM public, anon, authenticated;
