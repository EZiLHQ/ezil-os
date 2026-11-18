-- RESERVED SOURCE MIGRATION, unapplied. Native authorization outbox: server-only rows written by
-- app/src/server/native-session/native-authorization-outbox.ts. Registered as a production snapshot only; it is not
-- in the staging runner's explicit list and not in the Drizzle journal. 0031 and 0032 belong to other writers.
-- No plaintext token, proof, credential or key column: a renewal's candidate exists only as AES-256-GCM ciphertext
-- under a deployment-pinned wrapping key, bound by its additional data to the owner, operation, authorization,
-- semantic digest and token hash. Rows are never deleted, truncated or re-keyed; history, revocation and every used
-- consent outlive computers, sessions and accounts.

-- One row per consent authorization the OS has signed for: its immutable approved binding, and a terminal revoke.
CREATE TABLE public.ezil_native_authorizations (
    authorization_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    binding text NOT NULL,
    binding_digest text NOT NULL,
    revoke_operation_id uuid NULL,
    revoke_requested_at timestamptz NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT ezil_native_authorizations_pkey PRIMARY KEY (authorization_id),
    CONSTRAINT ezil_native_authorizations_digest_check CHECK (binding_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT ezil_native_authorizations_revoke_check CHECK ((revoke_operation_id IS NULL) = (revoke_requested_at IS NULL))
);
CREATE FUNCTION public.ezil_native_authorizations_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'native authorizations are permanent' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.authorization_id, NEW.owner_user_id, NEW.binding, NEW.binding_digest, NEW.created_at)
        IS DISTINCT FROM (OLD.authorization_id, OLD.owner_user_id, OLD.binding, OLD.binding_digest, OLD.created_at) THEN
        RAISE EXCEPTION 'native authorization binding is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.revoke_operation_id IS NOT NULL OR NEW.revoke_operation_id IS NULL THEN
        RAISE EXCEPTION 'native authorization revocation is set once and terminal' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER ezil_native_authorizations_guard_rows BEFORE UPDATE OR DELETE ON public.ezil_native_authorizations
    FOR EACH ROW EXECUTE FUNCTION public.ezil_native_authorizations_guard();
CREATE TRIGGER ezil_native_authorizations_guard_truncate BEFORE TRUNCATE ON public.ezil_native_authorizations
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_native_authorizations_guard();
REVOKE ALL ON FUNCTION public.ezil_native_authorizations_guard() FROM public, anon, authenticated;
ALTER TABLE public.ezil_native_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_native_authorizations FROM public, anon, authenticated;

-- One row per Gateway operation (renew or revoke): its sealed semantic tuple, the renewal's sealed candidate, and the
-- durable dispatch state. prepared > dispatching > granted | revoked | refused | delivery_unknown; only an explicit
-- reconciliation of the SAME operation moves delivery_unknown (or an abandoned dispatching) back to dispatching, at
-- most three attempts in all.
CREATE TABLE public.ezil_native_authorization_operations (
    operation_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    kind text NOT NULL,
    authorization_id uuid NOT NULL,
    consent_operation_id uuid NOT NULL,
    request_digest text NOT NULL,
    semantic text NOT NULL,
    semantic_digest text NOT NULL,
    lease_expires_at timestamptz NULL,
    token_sha256 text NULL,
    candidate_version smallint NULL,
    candidate_key_id text NULL,
    candidate_nonce bytea NULL,
    candidate_ciphertext bytea NULL,
    state text NOT NULL,
    attempt smallint NOT NULL,
    attempt_id uuid NULL,
    dispatched_at timestamptz NULL,
    reason text NULL,
    refusal_status smallint NULL,
    grant_id uuid NULL,
    grant_expires_at timestamptz NULL,
    grant_replayed boolean NULL,
    gateway_revoked_at timestamptz NULL,
    already_revoked boolean NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT ezil_native_authorization_operations_pkey PRIMARY KEY (operation_id),
    CONSTRAINT ezil_native_authorization_operations_authorization_fkey FOREIGN KEY (authorization_id)
        REFERENCES public.ezil_native_authorizations (authorization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ezil_native_authorization_operations_token_key UNIQUE (token_sha256),
    CONSTRAINT ezil_native_authorization_operations_kind_check CHECK (kind IN ('renew', 'revoke')),
    CONSTRAINT ezil_native_authorization_operations_digest_check CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'
        AND semantic_digest ~ '^sha256:[0-9a-f]{64}$'),
    -- Explicit IS NOT NULL on every renew field, and COALESCE around the whole: a CHECK that evaluates to NULL passes.
    CONSTRAINT ezil_native_authorization_operations_candidate_check CHECK (COALESCE(CASE kind
        WHEN 'renew' THEN lease_expires_at IS NOT NULL AND token_sha256 IS NOT NULL AND candidate_version IS NOT NULL
            AND candidate_key_id IS NOT NULL AND candidate_nonce IS NOT NULL AND candidate_ciphertext IS NOT NULL
            AND token_sha256 ~ '^[0-9a-f]{64}$' AND candidate_version = 1
            AND candidate_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND octet_length(candidate_nonce) = 12
            AND octet_length(candidate_ciphertext) = 63
        WHEN 'revoke' THEN lease_expires_at IS NULL AND token_sha256 IS NULL AND candidate_version IS NULL AND candidate_key_id IS NULL
            AND candidate_nonce IS NULL AND candidate_ciphertext IS NULL END, false)),
    CONSTRAINT ezil_native_authorization_operations_state_check CHECK (state IN ('prepared', 'dispatching', 'granted', 'revoked',
        'refused', 'delivery_unknown') AND (state <> 'granted' OR kind = 'renew') AND (state <> 'revoked' OR kind = 'revoke')),
    CONSTRAINT ezil_native_authorization_operations_attempt_check CHECK (attempt BETWEEN 0 AND 3
        AND (attempt = 0) = (state = 'prepared') AND (attempt_id IS NULL) = (attempt = 0) AND (dispatched_at IS NULL) = (attempt = 0)),    CONSTRAINT ezil_native_authorization_operations_reason_check CHECK ((reason IS NULL) = (state NOT IN ('refused', 'delivery_unknown'))
        AND (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$')),
    CONSTRAINT ezil_native_authorization_operations_outcome_check CHECK ((refusal_status IS NOT NULL) = (state = 'refused')
        AND (refusal_status IS NULL OR refusal_status BETWEEN 400 AND 499)
        AND (grant_id IS NOT NULL) = (state = 'granted') AND (grant_expires_at IS NOT NULL) = (state = 'granted')
        AND (grant_replayed IS NOT NULL) = (state = 'granted')
        AND (gateway_revoked_at IS NOT NULL) = (state = 'revoked') AND (already_revoked IS NOT NULL) = (state = 'revoked'))
);
CREATE INDEX ezil_native_authorization_operations_authorization
    ON public.ezil_native_authorization_operations (authorization_id, created_at, operation_id);
CREATE FUNCTION public.ezil_native_authorization_operations_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'native authorization operations are permanent' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.operation_id, NEW.owner_user_id, NEW.kind, NEW.authorization_id, NEW.consent_operation_id, NEW.request_digest,
        NEW.semantic, NEW.semantic_digest, NEW.lease_expires_at, NEW.token_sha256, NEW.candidate_version, NEW.candidate_key_id,
        NEW.candidate_nonce, NEW.candidate_ciphertext, NEW.created_at)
        IS DISTINCT FROM (OLD.operation_id, OLD.owner_user_id, OLD.kind, OLD.authorization_id, OLD.consent_operation_id,
        OLD.request_digest, OLD.semantic, OLD.semantic_digest, OLD.lease_expires_at, OLD.token_sha256, OLD.candidate_version,
        OLD.candidate_key_id, OLD.candidate_nonce, OLD.candidate_ciphertext, OLD.created_at) THEN
        RAISE EXCEPTION 'native authorization operation is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.state || '>' || NEW.state NOT IN ('prepared>dispatching', 'dispatching>granted', 'dispatching>revoked',
        'dispatching>refused', 'dispatching>delivery_unknown', 'delivery_unknown>dispatching', 'dispatching>dispatching') THEN
        RAISE EXCEPTION 'illegal native authorization operation transition' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.state = 'dispatching' THEN
        IF NEW.attempt <> OLD.attempt + 1 OR NEW.attempt_id IS NOT DISTINCT FROM OLD.attempt_id THEN
            RAISE EXCEPTION 'a dispatch is a new attempt' USING ERRCODE = 'restrict_violation';
        END IF;
    ELSIF (NEW.attempt, NEW.attempt_id, NEW.dispatched_at) IS DISTINCT FROM (OLD.attempt, OLD.attempt_id, OLD.dispatched_at) THEN
        RAISE EXCEPTION 'only a dispatch starts an attempt' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER ezil_native_authorization_operations_guard_rows BEFORE UPDATE OR DELETE
    ON public.ezil_native_authorization_operations FOR EACH ROW EXECUTE FUNCTION public.ezil_native_authorization_operations_guard();
CREATE TRIGGER ezil_native_authorization_operations_guard_truncate BEFORE TRUNCATE
    ON public.ezil_native_authorization_operations FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_native_authorization_operations_guard();
REVOKE ALL ON FUNCTION public.ezil_native_authorization_operations_guard() FROM public, anon, authenticated;
ALTER TABLE public.ezil_native_authorization_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_native_authorization_operations FROM public, anon, authenticated;
