-- Persist assignment clock events at the same boundary as the verified provider transition.
CREATE TABLE public.ezil_assignment_migration_clock (
    migration_id uuid PRIMARY KEY REFERENCES public.ezil_compute_migrations(id) ON DELETE CASCADE,
    paused_at timestamptz NOT NULL,
    pause_delivered_at timestamptz,
    resumed_at timestamptz,
    resume_event text CHECK (resume_event IN ('ready', 'recovered')),
    resume_delivered_at timestamptz,
    CHECK ((resumed_at IS NULL) = (resume_event IS NULL))
);
CREATE INDEX ezil_assignment_migration_clock_pending_resume
    ON public.ezil_assignment_migration_clock (resumed_at, migration_id)
    WHERE resumed_at IS NOT NULL AND resume_delivered_at IS NULL;
ALTER TABLE public.ezil_assignment_migration_clock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ezil_assignment_migration_clock FROM public, anon, authenticated;

CREATE FUNCTION public.ezil_record_assignment_migration_clock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    IF NEW.state = 'fenced' AND OLD.state = 'requested' THEN
        INSERT INTO public.ezil_assignment_migration_clock (migration_id, paused_at)
        VALUES (NEW.id, clock_timestamp()) ON CONFLICT DO NOTHING;
    ELSIF NEW.state = 'failed_reopened' AND OLD.state <> NEW.state THEN
        UPDATE public.ezil_assignment_migration_clock
        SET resumed_at = clock_timestamp(), resume_event = 'recovered'
        WHERE migration_id = NEW.id AND resumed_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER ezil_assignment_migration_clock_state
AFTER UPDATE OF state ON public.ezil_compute_migrations FOR EACH ROW
WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION public.ezil_record_assignment_migration_clock();

CREATE FUNCTION public.ezil_record_assignment_migration_ready() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    -- Only the published, enrolled AWS placement belonging to this migration can resume it.
    UPDATE public.ezil_assignment_migration_clock c
    SET resumed_at = clock_timestamp(), resume_event = 'ready'
    FROM public.ezil_compute_migrations m
    WHERE c.migration_id = m.id AND c.resumed_at IS NULL
      AND m.state = 'committed' AND m.computer_id = NEW.computer_id
      AND m.user_id = NEW.owner_user_id
      AND m.workspace_head #>> '{_awsProvision,placement,computerId}' = NEW.computer_id::text
      AND m.workspace_head #>> '{_awsProvision,placement,ownerUserId}' = NEW.owner_user_id::text
      AND m.workspace_head #>> '{_awsProvision,placement,instanceType}' = NEW.instance_type
      AND m.workspace_head #>> '{_awsProvision,placement,instanceId}' = NEW.instance_id
      AND m.workspace_head #>> '{_awsProvision,placement,volumeId}' = NEW.volume_id
      AND m.workspace_head #>> '{_awsProvision,placement,generation}' = NEW.generation::text
      AND m.workspace_head #>> '{_awsProvision,placement,leaseEpoch}' = NEW.lease_epoch::text;
    RETURN NEW;
END;
$$;
CREATE TRIGGER ezil_assignment_migration_clock_ready
AFTER UPDATE OF state ON public.ezil_computer_placements FOR EACH ROW
WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state = 'RUNNING' AND NEW.provider = 'aws-ec2')
EXECUTE FUNCTION public.ezil_record_assignment_migration_ready();
