CREATE TABLE "ezil_computer_recovery_intents" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"computer_id" uuid NOT NULL,
	"source_job_id" uuid NOT NULL,
	"source_schema_version" integer NOT NULL,
	"source_digest" text NOT NULL,
	"revision" integer NOT NULL,
	"target_generation" integer NOT NULL,
	"fence_token" uuid NOT NULL,
	"data_volume_id" text NOT NULL,
	"data_generation" integer NOT NULL,
	"data_fence_token" uuid NOT NULL,
	"outbox_event" text DEFAULT 'reconcile' NOT NULL,
	"deployment" text NOT NULL,
	"digest" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_recovery_intents_revision_uq" UNIQUE("computer_id","revision"),
	CONSTRAINT "ezil_recovery_intents_digest_uq" UNIQUE("job_id","digest"),
	CONSTRAINT "ezil_recovery_intents_generation_chk" CHECK (revision >= 1 AND data_generation >= 1 AND target_generation > data_generation),
	CONSTRAINT "ezil_recovery_intents_source_chk" CHECK (source_schema_version IN (1,2) AND source_job_id <> job_id AND fence_token <> data_fence_token),
	CONSTRAINT "ezil_recovery_intents_volume_chk" CHECK (data_volume_id ~ '^vol-[a-f0-9]{17}$'),
	CONSTRAINT "ezil_recovery_intents_outbox_chk" CHECK (outbox_event = 'reconcile'),
	CONSTRAINT "ezil_recovery_intents_deployment_chk" CHECK (octet_length(deployment) BETWEEN 2 AND 8192),
	CONSTRAINT "ezil_recovery_intents_digest_chk" CHECK (digest ~ '^[a-f0-9]{64}$' AND source_digest ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_recovery_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_jobs" DROP CONSTRAINT "ezil_computer_lifecycle_jobs_operation_chk";--> statement-breakpoint
ALTER TABLE "ezil_computer_recovery_intents" ADD CONSTRAINT "ezil_recovery_intents_job_fkey" FOREIGN KEY ("job_id","computer_id") REFERENCES "public"."ezil_computer_lifecycle_jobs"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_recovery_intents" ADD CONSTRAINT "ezil_recovery_intents_source_job_fkey" FOREIGN KEY ("source_job_id","computer_id") REFERENCES "public"."ezil_computer_lifecycle_jobs"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_recovery_intents" ADD CONSTRAINT "ezil_recovery_intents_runtime_fkey" FOREIGN KEY ("computer_id") REFERENCES "public"."ezil_computer_runtimes"("computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_recovery_intents" ADD CONSTRAINT "ezil_recovery_intents_outbox_fkey" FOREIGN KEY ("job_id","outbox_event") REFERENCES "public"."ezil_computer_lifecycle_outbox"("job_id","event_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_jobs" ADD CONSTRAINT "ezil_computer_lifecycle_jobs_operation_chk" CHECK ("ezil_computer_lifecycle_jobs"."operation" in ('provision', 'start', 'stop', 'replace', 'retire', 'migrate', 'recover'));
--> statement-breakpoint
-- V1 content and its document function are unchanged. V2 recovery is explicit
-- and cannot reinterpret an old provision operation as permission to reuse disk.
CREATE FUNCTION public.ezil_computer_recovery_document(intent public.ezil_computer_recovery_intents) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT jsonb_build_object('schemaVersion',2,'operation','recover','jobId',intent.job_id,'computerId',intent.computer_id,
        'revision',intent.revision,'targetGeneration',intent.target_generation,'fenceToken',intent.fence_token,
        'source',jsonb_build_object('schemaVersion',intent.source_schema_version,'jobId',intent.source_job_id,'digest',intent.source_digest),
        'dataVolumeId',intent.data_volume_id,'dataScope',jsonb_build_object('generation',intent.data_generation,'fenceToken',intent.data_fence_token),
        'deployment',intent.deployment::jsonb)::text;
$$;
--> statement-breakpoint
CREATE FUNCTION public.ezil_computer_recovery_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE runtime public.ezil_computer_runtimes%ROWTYPE;
    job public.ezil_computer_lifecycle_jobs%ROWTYPE;
    source_job public.ezil_computer_lifecycle_jobs%ROWTYPE;
    source_document jsonb; source_hash text; deployment jsonb; value jsonb; latest integer;
BEGIN
    PERFORM 1 FROM public.ezil_computers WHERE id=NEW.computer_id AND provider='aws-ec2' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'recovery computer missing' USING ERRCODE='23503'; END IF;
    SELECT * INTO runtime FROM public.ezil_computer_runtimes WHERE computer_id=NEW.computer_id FOR UPDATE;
    SELECT * INTO job FROM public.ezil_computer_lifecycle_jobs WHERE id=NEW.job_id AND computer_id=NEW.computer_id FOR UPDATE;
    IF runtime.computer_id IS NULL OR job.id IS NULL THEN RAISE EXCEPTION 'recovery scope missing' USING ERRCODE='23503'; END IF;
    IF job.status<>'queued' OR job.operation<>'recover' OR (job.target_generation IS NOT NULL AND job.target_generation<>NEW.target_generation)
        OR runtime.data_volume_id IS DISTINCT FROM NEW.data_volume_id OR runtime.data_volume_id IS NULL THEN
        RAISE EXCEPTION 'recovery job or disk mismatch' USING ERRCODE='23514';
    END IF;
    SELECT coalesce(max(revision),0) INTO latest FROM (
        SELECT revision FROM public.ezil_computer_lifecycle_intents WHERE computer_id=NEW.computer_id
        UNION ALL SELECT revision FROM public.ezil_computer_recovery_intents WHERE computer_id=NEW.computer_id
    ) revisions;
    IF latest=2147483647 OR NEW.revision<>latest+1 THEN
        RAISE EXCEPTION 'recovery revision mismatch' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM (
        SELECT job_id,computer_id FROM public.ezil_computer_lifecycle_intents
        UNION ALL SELECT job_id,computer_id FROM public.ezil_computer_recovery_intents
    ) i JOIN public.ezil_computer_lifecycle_jobs j ON j.id=i.job_id
        WHERE i.computer_id=NEW.computer_id AND j.status IN ('queued','running')) THEN
        RAISE EXCEPTION 'recovery work still active' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM public.ezil_computer_instances WHERE computer_id=NEW.computer_id
        AND (fenced_at IS NULL OR observed_state<>'stopped')) THEN
        RAISE EXCEPTION 'recovery writer not fenced' USING ERRCODE='23514'; END IF;
    SELECT * INTO source_job FROM public.ezil_computer_lifecycle_jobs WHERE id=NEW.source_job_id AND computer_id=NEW.computer_id FOR SHARE;
    IF source_job.id IS NULL OR source_job.status NOT IN ('failed','cancelled') OR source_job.error_code IS DISTINCT FROM 'lifecycle_recovered' THEN
        RAISE EXCEPTION 'recovery source not reconciled' USING ERRCODE='23514'; END IF;
    IF NEW.source_schema_version=1 THEN
        SELECT public.ezil_lifecycle_intent_document(i)::jsonb,i.digest INTO source_document,source_hash
            FROM public.ezil_computer_lifecycle_intents i WHERE i.job_id=NEW.source_job_id AND i.computer_id=NEW.computer_id;
    ELSIF NEW.source_schema_version=2 THEN
        SELECT public.ezil_computer_recovery_document(i)::jsonb,i.digest INTO source_document,source_hash
            FROM public.ezil_computer_recovery_intents i WHERE i.job_id=NEW.source_job_id AND i.computer_id=NEW.computer_id;
    END IF;
    IF source_document IS NULL OR source_hash IS DISTINCT FROM NEW.source_digest
        OR (source_document->>'revision')::integer<>latest
        OR ((source_document->>'dataVolumeId') IS NOT NULL AND source_document->>'dataVolumeId'<>NEW.data_volume_id) THEN
        RAISE EXCEPTION 'recovery source mismatch' USING ERRCODE='23514'; END IF;
    IF NOT coalesce(
        (NEW.data_generation=(source_document->>'targetGeneration')::integer AND NEW.data_fence_token=(source_document->>'fenceToken')::uuid)
        OR (NEW.source_schema_version=1 AND NEW.data_generation=(source_document->>'previousGeneration')::integer
            AND NEW.data_fence_token=(source_document->>'previousFenceToken')::uuid)
        OR (NEW.source_schema_version=2 AND NEW.data_generation=(source_document#>>'{dataScope,generation}')::integer
            AND NEW.data_fence_token=(source_document#>>'{dataScope,fenceToken}')::uuid),false) THEN
        RAISE EXCEPTION 'recovery disk generation mismatch' USING ERRCODE='23514'; END IF;
    IF runtime.next_generation=2147483647 OR NEW.target_generation<>runtime.next_generation
        OR NEW.fence_token=(source_document->>'fenceToken')::uuid
        OR EXISTS(SELECT 1 FROM public.ezil_computer_instances WHERE computer_id=NEW.computer_id
            AND (generation>=NEW.target_generation OR fence_token=NEW.fence_token)) THEN
        RAISE EXCEPTION 'recovery generation mismatch' USING ERRCODE='23514'; END IF;
    IF octet_length(NEW.deployment) NOT BETWEEN 2 AND 8192 THEN
        RAISE EXCEPTION 'lifecycle deployment invalid' USING ERRCODE='23514'; END IF;
    BEGIN deployment := NEW.deployment::jsonb;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'lifecycle deployment invalid' USING ERRCODE='23514'; END;
    IF NOT coalesce(jsonb_typeof(deployment)='object'
        AND deployment ?& ARRAY['accountId','region','availabilityZone','subnetId','securityGroupId','launchTemplateId',
            'launchTemplateVersion','amiId','instanceProfileArn','dataKeyArn','stateMachineVersionArn','namespace']
        AND deployment - ARRAY['accountId','region','availabilityZone','subnetId','securityGroupId','launchTemplateId',
            'launchTemplateVersion','amiId','instanceProfileArn','dataKeyArn','stateMachineVersionArn','namespace']='{}'::jsonb
        AND deployment->>'accountId' ~ '^[0-9]{12}$' AND deployment->>'region'='us-east-1'
        AND runtime.region=deployment->>'region'
        AND deployment->>'availabilityZone' ~ '^us-east-1[a-z]$'
        AND (runtime.availability_zone IS NULL OR runtime.availability_zone=deployment->>'availabilityZone')
        AND deployment->>'subnetId' ~ '^subnet-[a-f0-9]{17}$'
        AND deployment->>'securityGroupId' ~ '^sg-[a-f0-9]{17}$'
        AND deployment->>'launchTemplateId' ~ '^lt-[a-f0-9]{17}$'
        AND deployment->>'launchTemplateVersion' ~ '^[1-9][0-9]{0,9}$'
        AND deployment->>'amiId' ~ '^ami-[a-f0-9]{17}$'
        AND deployment->>'namespace' ~ '^[a-z][a-z0-9-]{0,30}$'
        AND length(deployment->>'instanceProfileArn') <= 600
        AND deployment->>'instanceProfileArn' ~ ('^arn:aws:iam::'||(deployment->>'accountId')||':instance-profile/[A-Za-z0-9/+=,.@_-]+$')
        AND deployment->>'dataKeyArn' ~ ('^arn:aws:kms:us-east-1:'||(deployment->>'accountId')||':key/[a-f0-9-]{36}$')
        AND deployment->>'stateMachineVersionArn' ~ ('^arn:aws:states:us-east-1:'||(deployment->>'accountId')||':stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$'),false) THEN
        RAISE EXCEPTION 'lifecycle deployment invalid' USING ERRCODE='23514';
    END IF;
    FOR value IN SELECT e.value FROM jsonb_each(deployment) e LOOP
        IF jsonb_typeof(value)<>'string' THEN RAISE EXCEPTION 'lifecycle deployment invalid' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF NOT coalesce(deployment->>'accountId'=source_document#>>'{deployment,accountId}'
        AND deployment->>'region'=source_document#>>'{deployment,region}'
        AND deployment->>'availabilityZone'=source_document#>>'{deployment,availabilityZone}'
        AND deployment->>'dataKeyArn'=source_document#>>'{deployment,dataKeyArn}'
        AND deployment->>'namespace'=source_document#>>'{deployment,namespace}',false) THEN
        RAISE EXCEPTION 'recovery storage deployment mismatch' USING ERRCODE='23514'; END IF;
    UPDATE public.ezil_computer_runtimes SET next_generation=next_generation+1,updated_at=clock_timestamp() WHERE computer_id=NEW.computer_id;
    UPDATE public.ezil_computer_lifecycle_jobs SET target_generation=NEW.target_generation WHERE id=NEW.job_id;
    NEW.deployment := deployment::text;
    NEW.digest := encode(sha256(convert_to(public.ezil_computer_recovery_document(NEW),'UTF8')),'hex');
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_computer_recovery_insert_trg BEFORE INSERT ON public.ezil_computer_recovery_intents
FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_recovery_insert();
--> statement-breakpoint
CREATE TRIGGER ezil_computer_recovery_immutable_trg BEFORE UPDATE OR DELETE ON public.ezil_computer_recovery_intents
FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_computer_recovery_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_recovery_intents
FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE POLICY "Service role full access computer recovery intents" ON public.ezil_computer_recovery_intents
FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');

--> statement-breakpoint
-- V1 and V2 reserve revisions under the same computer lock.
CREATE OR REPLACE FUNCTION public.ezil_lifecycle_intent_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE runtime public.ezil_computer_runtimes%ROWTYPE;
    job public.ezil_computer_lifecycle_jobs%ROWTYPE;
    writer public.ezil_computer_instances%ROWTYPE;
    deployment jsonb; value jsonb; latest integer;
BEGIN
    PERFORM 1 FROM public.ezil_computers WHERE id=NEW.computer_id AND provider='aws-ec2' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle computer missing' USING ERRCODE='23503'; END IF;
    SELECT * INTO runtime FROM public.ezil_computer_runtimes WHERE computer_id=NEW.computer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle runtime missing' USING ERRCODE='23503'; END IF;
    SELECT * INTO job FROM public.ezil_computer_lifecycle_jobs WHERE id=NEW.job_id AND computer_id=NEW.computer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle job missing' USING ERRCODE='23503'; END IF;
    IF job.operation IS DISTINCT FROM NEW.operation OR job.status <> 'queued'
        OR (job.target_generation IS NOT NULL AND job.target_generation <> NEW.target_generation) THEN
        RAISE EXCEPTION 'lifecycle job mismatch' USING ERRCODE='23514';
    END IF;
    SELECT coalesce(max(revision),0) INTO latest FROM (
        SELECT revision FROM public.ezil_computer_lifecycle_intents WHERE computer_id=NEW.computer_id
        UNION ALL SELECT revision FROM public.ezil_computer_recovery_intents WHERE computer_id=NEW.computer_id
    ) revisions;
    IF latest=2147483647 OR NEW.revision<>latest+1 THEN
        RAISE EXCEPTION 'lifecycle revision mismatch' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM (
            SELECT job_id,computer_id FROM public.ezil_computer_lifecycle_intents
            UNION ALL SELECT job_id,computer_id FROM public.ezil_computer_recovery_intents
        ) i JOIN public.ezil_computer_lifecycle_jobs j ON j.id=i.job_id
        WHERE i.computer_id=NEW.computer_id AND j.status IN ('queued','running')) THEN
        RAISE EXCEPTION 'lifecycle work still active' USING ERRCODE='23514';
    END IF;
    IF octet_length(NEW.deployment) NOT BETWEEN 2 AND 8192 THEN
        RAISE EXCEPTION 'lifecycle deployment invalid' USING ERRCODE='23514'; END IF;
    BEGIN deployment := NEW.deployment::jsonb;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'lifecycle deployment invalid' USING ERRCODE='23514'; END;
    IF NOT coalesce(jsonb_typeof(deployment)='object'
        AND deployment ?& ARRAY['accountId','region','availabilityZone','subnetId','securityGroupId','launchTemplateId',
            'launchTemplateVersion','amiId','instanceProfileArn','dataKeyArn','stateMachineVersionArn','namespace']
        AND deployment - ARRAY['accountId','region','availabilityZone','subnetId','securityGroupId','launchTemplateId',
            'launchTemplateVersion','amiId','instanceProfileArn','dataKeyArn','stateMachineVersionArn','namespace']='{}'::jsonb
        AND deployment->>'accountId' ~ '^[0-9]{12}$' AND deployment->>'region'='us-east-1'
        AND runtime.region=deployment->>'region'
        AND deployment->>'availabilityZone' ~ '^us-east-1[a-z]$'
        AND (runtime.availability_zone IS NULL OR runtime.availability_zone=deployment->>'availabilityZone')
        AND deployment->>'subnetId' ~ '^subnet-[a-f0-9]{17}$'
        AND deployment->>'securityGroupId' ~ '^sg-[a-f0-9]{17}$'
        AND deployment->>'launchTemplateId' ~ '^lt-[a-f0-9]{17}$'
        AND deployment->>'launchTemplateVersion' ~ '^[1-9][0-9]{0,9}$'
        AND deployment->>'amiId' ~ '^ami-[a-f0-9]{17}$'
        AND deployment->>'namespace' ~ '^[a-z][a-z0-9-]{0,30}$'
        AND length(deployment->>'instanceProfileArn') <= 600
        AND deployment->>'instanceProfileArn' ~ ('^arn:aws:iam::'||(deployment->>'accountId')||':instance-profile/[A-Za-z0-9/+=,.@_-]+$')
        AND deployment->>'dataKeyArn' ~ ('^arn:aws:kms:us-east-1:'||(deployment->>'accountId')||':key/[a-f0-9-]{36}$')
        AND deployment->>'stateMachineVersionArn' ~ ('^arn:aws:states:us-east-1:'||(deployment->>'accountId')||':stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$'),false) THEN
        RAISE EXCEPTION 'lifecycle deployment invalid' USING ERRCODE='23514';
    END IF;
    FOR value IN SELECT e.value FROM jsonb_each(deployment) e LOOP
        IF jsonb_typeof(value)<>'string' THEN RAISE EXCEPTION 'lifecycle deployment invalid' USING ERRCODE='23514'; END IF;
    END LOOP;
    SELECT * INTO writer FROM public.ezil_computer_instances WHERE computer_id=NEW.computer_id AND fenced_at IS NULL FOR SHARE;
    IF NEW.operation='provision' THEN
        IF writer.computer_id IS NOT NULL OR runtime.data_volume_id IS NOT NULL THEN
            RAISE EXCEPTION 'lifecycle provision has existing resources' USING ERRCODE='23514'; END IF;
    ELSIF NEW.operation='replace' THEN
        IF writer.computer_id IS NULL OR writer.generation IS DISTINCT FROM NEW.previous_generation
            OR writer.provider_instance_id IS DISTINCT FROM NEW.previous_instance_id
            OR writer.fence_token IS DISTINCT FROM NEW.previous_fence_token
            OR runtime.data_volume_id IS DISTINCT FROM NEW.data_volume_id
            OR NEW.fence_token=writer.fence_token THEN
            RAISE EXCEPTION 'lifecycle previous writer mismatch' USING ERRCODE='23514'; END IF;
    ELSE
        IF writer.computer_id IS NULL OR writer.generation IS DISTINCT FROM NEW.target_generation
            OR writer.provider_instance_id IS DISTINCT FROM NEW.provider_instance_id OR writer.fence_token IS DISTINCT FROM NEW.fence_token
            OR runtime.data_volume_id IS DISTINCT FROM NEW.data_volume_id THEN
            RAISE EXCEPTION 'lifecycle writer mismatch' USING ERRCODE='23514'; END IF;
    END IF;
    IF NEW.operation IN ('provision','replace') THEN
        IF runtime.next_generation=2147483647 OR NEW.target_generation<>runtime.next_generation
            OR EXISTS (SELECT 1 FROM public.ezil_computer_instances WHERE computer_id=NEW.computer_id AND generation>=NEW.target_generation) THEN
            RAISE EXCEPTION 'lifecycle generation mismatch' USING ERRCODE='23514'; END IF;
        -- Reservation never frees the old writer or claims provider stop/detach.
        UPDATE public.ezil_computer_runtimes SET next_generation=next_generation+1,updated_at=clock_timestamp()
            WHERE computer_id=NEW.computer_id;
    END IF;
    UPDATE public.ezil_computer_lifecycle_jobs SET target_generation=NEW.target_generation WHERE id=NEW.job_id;
    NEW.deployment := deployment::text;
    NEW.digest := encode(sha256(convert_to(public.ezil_lifecycle_intent_document(NEW),'UTF8')),'hex');
    RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ezil_lifecycle_job_scope_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM public.ezil_computer_lifecycle_intents WHERE job_id=OLD.id)
        OR EXISTS(SELECT 1 FROM public.ezil_computer_recovery_intents WHERE job_id=OLD.id) THEN
        IF ROW(NEW.id,NEW.computer_id,NEW.operation,NEW.idempotency_key,NEW.target_generation,NEW.created_at)
            IS DISTINCT FROM ROW(OLD.id,OLD.computer_id,OLD.operation,OLD.idempotency_key,OLD.target_generation,OLD.created_at) THEN
            RAISE EXCEPTION 'lifecycle job scope is immutable' USING ERRCODE='23514';
        END IF;
        IF (OLD.status IN ('succeeded','failed','cancelled') AND NEW.status<>OLD.status)
            OR (OLD.status='running' AND NEW.status='queued') THEN
            RAISE EXCEPTION 'lifecycle job cannot move backwards' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
