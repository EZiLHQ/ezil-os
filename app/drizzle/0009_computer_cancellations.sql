CREATE TABLE "ezil_computer_cancellation_outbox" (
	"cancellation_id" uuid PRIMARY KEY NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_cancellation_outbox_attempts_chk" CHECK (attempts >= 0),
	CONSTRAINT "ezil_cancellation_outbox_error_chk" CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,80}$')
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_cancellation_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_computer_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computer_id" uuid NOT NULL,
	"source_job_id" uuid NOT NULL,
	"source_schema_version" integer NOT NULL,
	"source_digest" text NOT NULL,
	"source_state" text DEFAULT 'queued' NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid,
	"workflow_version_arn" text NOT NULL,
	"digest" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_cancellations_source_uq" UNIQUE("source_job_id"),
	CONSTRAINT "ezil_cancellations_version_chk" CHECK (source_schema_version IN (1,2)),
	CONSTRAINT "ezil_cancellations_state_chk" CHECK (source_state IN ('queued','running')),
	CONSTRAINT "ezil_cancellations_reason_chk" CHECK ((reason='stop_requested' AND requested_by IS NOT NULL) OR (reason='authority_revoked' AND requested_by IS NULL)),
	CONSTRAINT "ezil_cancellations_digest_chk" CHECK (digest ~ '^[a-f0-9]{64}$' AND source_digest ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ezil_cancellations_workflow_chk" CHECK (workflow_version_arn ~ '^arn:aws:states:us-east-1:[0-9]{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$')
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_cancellations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_computer_cancellation_outbox" ADD CONSTRAINT "ezil_cancellation_outbox_intent_fkey" FOREIGN KEY ("cancellation_id") REFERENCES "public"."ezil_computer_cancellations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_cancellations" ADD CONSTRAINT "ezil_cancellations_source_fkey" FOREIGN KEY ("source_job_id","computer_id") REFERENCES "public"."ezil_computer_lifecycle_jobs"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_cancellations" ADD CONSTRAINT "ezil_cancellations_requester_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ezil_cancellation_outbox_due_idx" ON "ezil_computer_cancellation_outbox" USING btree ("available_at") WHERE "ezil_computer_cancellation_outbox"."delivered_at" IS NULL;
--> statement-breakpoint
-- Cancellation is explicit authority bound to original immutable work. A false
-- launch-authority response is never permission to terminate a healthy computer.
CREATE FUNCTION public.ezil_computer_cancellation_document(c public.ezil_computer_cancellations) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT jsonb_build_object('schemaVersion',1,'operation','cancel','cancellationId',c.id,'computerId',c.computer_id,
        'source',jsonb_build_object('schemaVersion',c.source_schema_version,'jobId',c.source_job_id,
            'digest',c.source_digest,'stateAtRequest',c.source_state),
        'reason',c.reason,'requestedBy',c.requested_by,'workflowVersionArn',c.workflow_version_arn)::text;
$$;
--> statement-breakpoint
CREATE FUNCTION public.ezil_computer_cancellation_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE job public.ezil_computer_lifecycle_jobs%ROWTYPE; document jsonb; source_hash text;
BEGIN
    -- Same computer -> runtime -> job order as the lifecycle consumer. Producers
    -- must authenticate owner/admin stops or establish actual access revocation.
    PERFORM 1 FROM public.ezil_computers WHERE id=NEW.computer_id AND provider='aws-ec2' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'cancellation computer missing' USING ERRCODE='23503'; END IF;
    PERFORM 1 FROM public.ezil_computer_runtimes WHERE computer_id=NEW.computer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'cancellation runtime missing' USING ERRCODE='23503'; END IF;
    SELECT * INTO job FROM public.ezil_computer_lifecycle_jobs WHERE id=NEW.source_job_id AND computer_id=NEW.computer_id FOR UPDATE;
    IF job.id IS NULL OR job.status NOT IN ('queued','running') OR job.operation NOT IN ('provision','start','replace','recover')
        OR job.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'cancellation source not active' USING ERRCODE='23514'; END IF;
    IF NEW.source_schema_version=1 THEN
        SELECT public.ezil_lifecycle_intent_document(i)::jsonb,i.digest INTO document,source_hash
            FROM public.ezil_computer_lifecycle_intents i WHERE i.job_id=job.id AND i.computer_id=NEW.computer_id;
    ELSIF NEW.source_schema_version=2 THEN
        SELECT public.ezil_computer_recovery_document(i)::jsonb,i.digest INTO document,source_hash
            FROM public.ezil_computer_recovery_intents i WHERE i.job_id=job.id AND i.computer_id=NEW.computer_id;
    END IF;
    IF document IS NULL OR source_hash IS DISTINCT FROM NEW.source_digest THEN
        RAISE EXCEPTION 'cancellation source mismatch' USING ERRCODE='23514'; END IF;
    IF NOT coalesce(NEW.workflow_version_arn ~ ('^arn:aws:states:us-east-1:'||(document#>>'{deployment,accountId}')
            ||':stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$')
        AND regexp_replace(NEW.workflow_version_arn, ':[0-9]+$', '')
            <> regexp_replace(document#>>'{deployment,stateMachineVersionArn}', ':[0-9]+$', ''),false) THEN
        RAISE EXCEPTION 'cancellation workflow mismatch' USING ERRCODE='23514'; END IF;
    NEW.source_state := job.status;
    NEW.created_at := clock_timestamp();
    NEW.digest := encode(sha256(convert_to(public.ezil_computer_cancellation_document(NEW),'UTF8')),'hex');
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_computer_cancellation_insert_trg BEFORE INSERT ON public.ezil_computer_cancellations
FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_cancellation_insert();
--> statement-breakpoint
CREATE TRIGGER ezil_computer_cancellation_immutable_trg BEFORE UPDATE OR DELETE ON public.ezil_computer_cancellations
FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_computer_cancellation_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_cancellations
FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE FUNCTION public.ezil_cancellation_outbox_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF ROW(NEW.cancellation_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.cancellation_id,OLD.created_at)
            OR NEW.attempts<OLD.attempts OR (OLD.delivered_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
            RAISE EXCEPTION 'cancellation delivery is immutable or backwards' USING ERRCODE='23514'; END IF;
    ELSE
        IF NEW.attempts<>0 OR NEW.lease_until IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.error_code IS NOT NULL THEN
            RAISE EXCEPTION 'cancellation delivery must start pending' USING ERRCODE='23514'; END IF;
        NEW.created_at := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_cancellation_outbox_write_trg BEFORE INSERT OR UPDATE ON public.ezil_computer_cancellation_outbox
FOR EACH ROW EXECUTE FUNCTION public.ezil_cancellation_outbox_write();
--> statement-breakpoint
CREATE TRIGGER ezil_cancellation_outbox_no_delete_trg BEFORE DELETE ON public.ezil_computer_cancellation_outbox
FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_cancellation_outbox_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_cancellation_outbox
FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
-- Existing v1/v2 work without a cancellation retains its previous behavior.
CREATE FUNCTION public.ezil_cancelled_source_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_TABLE_NAME='ezil_computer_lifecycle_jobs' THEN
        IF EXISTS(SELECT 1 FROM public.ezil_computer_cancellations WHERE source_job_id=OLD.id) AND (
            (OLD.status='queued' AND NEW.status='running')
            OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
            OR (OLD.status='cancelled' AND NEW IS DISTINCT FROM OLD)) THEN
            RAISE EXCEPTION 'cancelled source cannot advance or change' USING ERRCODE='23514'; END IF;
    ELSE
        IF EXISTS(SELECT 1 FROM public.ezil_computer_cancellations WHERE source_job_id=OLD.job_id) AND (
            ROW(NEW.id,NEW.job_id,NEW.computer_id,NEW.event_type,NEW.created_at)
                IS DISTINCT FROM ROW(OLD.id,OLD.job_id,OLD.computer_id,OLD.event_type,OLD.created_at)
            OR NEW.attempts<OLD.attempts OR (OLD.delivered_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)) THEN
            RAISE EXCEPTION 'cancelled source delivery cannot change' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_cancelled_source_job_trg BEFORE UPDATE ON public.ezil_computer_lifecycle_jobs
FOR EACH ROW EXECUTE FUNCTION public.ezil_cancelled_source_write();
--> statement-breakpoint
CREATE TRIGGER ezil_cancelled_source_outbox_trg BEFORE UPDATE ON public.ezil_computer_lifecycle_outbox
FOR EACH ROW EXECUTE FUNCTION public.ezil_cancelled_source_write();
--> statement-breakpoint
CREATE FUNCTION public.ezil_computer_cancellation_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE c public.ezil_computer_cancellations%ROWTYPE; job public.ezil_computer_lifecycle_jobs%ROWTYPE;
    original public.ezil_computer_lifecycle_outbox%ROWTYPE; delivery public.ezil_computer_cancellation_outbox%ROWTYPE;
    source_document jsonb;
BEGIN
    IF TG_TABLE_NAME='ezil_computer_cancellations' THEN
        SELECT * INTO c FROM public.ezil_computer_cancellations WHERE id=NEW.id;
    ELSIF TG_TABLE_NAME='ezil_computer_cancellation_outbox' THEN
        IF TG_OP='UPDATE' AND OLD.delivered_at IS NOT NULL THEN RETURN NULL; END IF;
        SELECT * INTO c FROM public.ezil_computer_cancellations WHERE id=NEW.cancellation_id;
    ELSIF TG_TABLE_NAME='ezil_computer_lifecycle_jobs' THEN
        IF OLD.status='cancelled' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
        SELECT * INTO c FROM public.ezil_computer_cancellations WHERE source_job_id=NEW.id;
    ELSE
        IF OLD.delivered_at IS NOT NULL AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
        SELECT * INTO c FROM public.ezil_computer_cancellations WHERE source_job_id=NEW.job_id;
    END IF;
    IF c.id IS NULL THEN RETURN NULL; END IF;
    PERFORM 1 FROM public.ezil_computers WHERE id=c.computer_id FOR UPDATE;
    PERFORM 1 FROM public.ezil_computer_runtimes WHERE computer_id=c.computer_id FOR UPDATE;
    SELECT * INTO job FROM public.ezil_computer_lifecycle_jobs WHERE id=c.source_job_id FOR UPDATE;
    SELECT * INTO original FROM public.ezil_computer_lifecycle_outbox WHERE job_id=job.id AND event_type='reconcile' FOR UPDATE;
    SELECT * INTO delivery FROM public.ezil_computer_cancellation_outbox WHERE cancellation_id=c.id FOR UPDATE;
    IF original.id IS NULL OR delivery.cancellation_id IS NULL THEN
        RAISE EXCEPTION 'cancellation delivery incomplete' USING ERRCODE='23514'; END IF;
    IF job.status IN ('queued','running') THEN
        -- Keep uncertain running work in admission until atomic settlement.
        IF job.status<>c.source_state OR job.completed_at IS NOT NULL OR original.delivered_at IS NOT NULL OR delivery.delivered_at IS NOT NULL THEN
            RAISE EXCEPTION 'cancellation still pending' USING ERRCODE='23514'; END IF;
    ELSE
        IF job.status<>'cancelled' OR job.completed_at IS NULL OR job.error_code IS NULL
            OR job.error_code NOT IN ('lifecycle_cancelled','lifecycle_recovered')
            OR original.delivered_at IS NULL OR delivery.delivered_at IS NULL
            OR original.lease_until IS NOT NULL OR delivery.lease_until IS NOT NULL OR delivery.error_code IS NOT NULL THEN
            RAISE EXCEPTION 'cancellation settlement incomplete' USING ERRCODE='23514'; END IF;
        IF job.error_code='lifecycle_cancelled' THEN
            -- Only an unclaimed first provision can settle without a provider
            -- call. Queued start/replace/recover already own persistent resources.
            IF c.source_state<>'queued' OR job.operation<>'provision' OR job.started_at IS NOT NULL OR original.attempts<>0
                OR EXISTS(SELECT 1 FROM public.ezil_computer_instances WHERE computer_id=c.computer_id)
                OR EXISTS(SELECT 1 FROM public.ezil_computer_runtimes WHERE computer_id=c.computer_id AND data_volume_id IS NOT NULL) THEN
                RAISE EXCEPTION 'cancellation requires provider reconciliation' USING ERRCODE='23514'; END IF;
        ELSIF EXISTS(SELECT 1 FROM public.ezil_computer_instances WHERE computer_id=c.computer_id
            AND (fenced_at IS NULL OR observed_state<>'stopped' OR observed_at IS NULL)) THEN
            RAISE EXCEPTION 'cancellation writer not fenced' USING ERRCODE='23514';
        END IF;
        IF c.source_schema_version=1 THEN
            SELECT public.ezil_lifecycle_intent_document(i)::jsonb INTO source_document
                FROM public.ezil_computer_lifecycle_intents i WHERE i.job_id=job.id;
        ELSE
            SELECT public.ezil_computer_recovery_document(i)::jsonb INTO source_document
                FROM public.ezil_computer_recovery_intents i WHERE i.job_id=job.id;
        END IF;
        IF source_document->>'dataVolumeId' IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM public.ezil_computer_runtimes WHERE computer_id=c.computer_id
                AND data_volume_id=source_document->>'dataVolumeId'
                AND availability_zone=source_document#>>'{deployment,availabilityZone}') THEN
            RAISE EXCEPTION 'cancellation must retain source disk' USING ERRCODE='23514'; END IF;
        IF c.source_schema_version=1 AND job.operation IN ('start','replace') AND NOT EXISTS(
            SELECT 1 FROM public.ezil_computer_instances WHERE computer_id=c.computer_id
                AND generation=coalesce(source_document->>'previousGeneration',source_document->>'targetGeneration')::integer
                AND provider_instance_id=coalesce(source_document->>'previousInstanceId',source_document->>'providerInstanceId')
                AND fence_token=coalesce(source_document->>'previousFenceToken',source_document->>'fenceToken')::uuid) THEN
            RAISE EXCEPTION 'cancellation must retain source writer' USING ERRCODE='23514'; END IF;
        -- SQL checks recorded state only. The consumer must independently
        -- verify exact provider writers, disk preservation and absent effects.
    END IF;
    RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ezil_cancellation_complete_trg AFTER INSERT ON public.ezil_computer_cancellations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_cancellation_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ezil_cancellation_delivery_complete_trg AFTER INSERT OR UPDATE ON public.ezil_computer_cancellation_outbox
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_cancellation_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ezil_cancellation_job_complete_trg AFTER UPDATE ON public.ezil_computer_lifecycle_jobs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_cancellation_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ezil_cancellation_original_complete_trg AFTER UPDATE ON public.ezil_computer_lifecycle_outbox
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_cancellation_complete();
--> statement-breakpoint
CREATE POLICY "Service role full access computer cancellations" ON public.ezil_computer_cancellations
FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access computer cancellation outbox" ON public.ezil_computer_cancellation_outbox
FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
