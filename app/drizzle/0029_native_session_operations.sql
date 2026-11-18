-- RESERVED SOURCE MIGRATION, unapplied. Native session operations: server-only (user, operation) tombstones
-- written by app/src/server/native-session/authority.ts. Registered as a production snapshot only; it is not in
-- the staging runner's explicit list and not in the Drizzle journal. 0026-0028 stay reserved for older references.
-- No token, proof or credential column. No foreign key or cascade: an operation identity outlives computer
-- deletion, reassignment and account removal. Rows are never deleted, truncated or re-keyed.
CREATE TABLE public.ezil_native_session_operations (
    user_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL,
    session_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    instruction_revision bigint NOT NULL,
    instruction_digest text NOT NULL,
    task_ref text NOT NULL,
    request_digest text NOT NULL,
    placement_generation bigint NOT NULL,
    placement_lease_epoch bigint NOT NULL,
    placement_instance_id text NOT NULL,
    placement_fence_token uuid NOT NULL,
    state text NOT NULL,
    reason text NULL,
    grant_id uuid NULL,
    grant_expires_at timestamptz NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT ezil_native_session_operations_pkey PRIMARY KEY (user_id, operation_id),
    CONSTRAINT ezil_native_session_operations_kind_check CHECK (kind IN ('create', 'renew')),
    CONSTRAINT ezil_native_session_operations_revision_check CHECK (instruction_revision >= 1),
    CONSTRAINT ezil_native_session_operations_instruction_digest_check CHECK (instruction_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT ezil_native_session_operations_task_ref_check CHECK (task_ref ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
    CONSTRAINT ezil_native_session_operations_request_digest_check CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT ezil_native_session_operations_placement_check CHECK (placement_generation >= 0 AND placement_lease_epoch >= 0
        AND placement_instance_id ~ '^i-[0-9a-f]{8,17}$'),
    CONSTRAINT ezil_native_session_operations_state_check CHECK (state IN ('claimed', 'exchanging', 'exchange_refused',
        'exchange_unknown', 'granted', 'authority_changed', 'delivering', 'delivered', 'host_refused', 'delivery_unknown')),
    CONSTRAINT ezil_native_session_operations_reason_check CHECK ((reason IS NULL) = (state IN ('claimed', 'exchanging',
        'granted', 'delivering', 'delivered')) AND (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$')),
    CONSTRAINT ezil_native_session_operations_grant_check CHECK ((grant_id IS NULL) = (grant_expires_at IS NULL)
        AND (grant_id IS NULL) = (state IN ('claimed', 'exchanging', 'exchange_refused', 'exchange_unknown')))
);
CREATE UNIQUE INDEX ezil_native_session_operations_one_create
    ON public.ezil_native_session_operations (user_id, session_id) WHERE kind = 'create';
CREATE INDEX ezil_native_session_operations_session
    ON public.ezil_native_session_operations (user_id, session_id, created_at, operation_id);
CREATE FUNCTION public.ezil_native_session_operations_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'native session operations are permanent' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.user_id, NEW.operation_id, NEW.kind, NEW.session_id, NEW.computer_id, NEW.instruction_revision,
        NEW.instruction_digest, NEW.task_ref, NEW.request_digest, NEW.placement_generation, NEW.placement_lease_epoch,
        NEW.placement_instance_id, NEW.placement_fence_token, NEW.created_at)
        IS DISTINCT FROM (OLD.user_id, OLD.operation_id, OLD.kind, OLD.session_id, OLD.computer_id, OLD.instruction_revision,
        OLD.instruction_digest, OLD.task_ref, OLD.request_digest, OLD.placement_generation, OLD.placement_lease_epoch,
        OLD.placement_instance_id, OLD.placement_fence_token, OLD.created_at) THEN
        RAISE EXCEPTION 'native session operation identity is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.grant_id IS NOT NULL AND (NEW.grant_id, NEW.grant_expires_at) IS DISTINCT FROM (OLD.grant_id, OLD.grant_expires_at) THEN
        RAISE EXCEPTION 'native session grant receipt is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.state || '>' || NEW.state NOT IN ('claimed>exchanging', 'exchanging>exchange_refused', 'exchanging>exchange_unknown',
        'exchanging>granted', 'granted>authority_changed', 'granted>delivering', 'delivering>delivered',
        'delivering>host_refused', 'delivering>delivery_unknown') THEN
        RAISE EXCEPTION 'illegal native session operation transition' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER ezil_native_session_operations_guard_rows BEFORE UPDATE OR DELETE ON public.ezil_native_session_operations
    FOR EACH ROW EXECUTE FUNCTION public.ezil_native_session_operations_guard();
CREATE TRIGGER ezil_native_session_operations_guard_truncate BEFORE TRUNCATE ON public.ezil_native_session_operations
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_native_session_operations_guard();
REVOKE ALL ON FUNCTION public.ezil_native_session_operations_guard() FROM public, anon, authenticated;
ALTER TABLE public.ezil_native_session_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_native_session_operations FROM public, anon, authenticated;
