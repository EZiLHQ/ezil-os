CREATE TABLE "ezil_computer_lifecycle_intents" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"computer_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"operation" text NOT NULL,
	"target_generation" integer NOT NULL,
	"fence_token" uuid NOT NULL,
	"provider_instance_id" text,
	"data_volume_id" text,
	"previous_generation" integer,
	"previous_instance_id" text,
	"previous_fence_token" uuid,
	"outbox_event" text DEFAULT 'reconcile' NOT NULL,
	"deployment" text NOT NULL,
	"digest" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_lifecycle_intents_revision_uq" UNIQUE("computer_id","revision"),
	CONSTRAINT "ezil_lifecycle_intents_digest_uq" UNIQUE("job_id","digest"),
	CONSTRAINT "ezil_lifecycle_intents_generation_chk" CHECK (revision >= 1 AND target_generation >= 1),
	CONSTRAINT "ezil_lifecycle_intents_outbox_chk" CHECK (outbox_event = 'reconcile'),
	CONSTRAINT "ezil_lifecycle_intents_scope_chk" CHECK (
        (provider_instance_id IS NULL OR provider_instance_id ~ '^i-[a-f0-9]{17}$')
        AND (data_volume_id IS NULL OR data_volume_id ~ '^vol-[a-f0-9]{17}$')
        AND (previous_instance_id IS NULL OR previous_instance_id ~ '^i-[a-f0-9]{17}$')),
	CONSTRAINT "ezil_lifecycle_intents_shape_chk" CHECK (
        (operation = 'provision' AND provider_instance_id IS NULL AND data_volume_id IS NULL
            AND previous_generation IS NULL AND previous_instance_id IS NULL AND previous_fence_token IS NULL)
        OR (operation IN ('start','stop','retire') AND provider_instance_id IS NOT NULL AND data_volume_id IS NOT NULL
            AND previous_generation IS NULL AND previous_instance_id IS NULL AND previous_fence_token IS NULL)
        OR (operation = 'replace' AND provider_instance_id IS NULL AND data_volume_id IS NOT NULL
            AND previous_generation IS NOT NULL AND previous_generation >= 1 AND previous_generation < target_generation
            AND previous_instance_id IS NOT NULL AND previous_fence_token IS NOT NULL)),
	CONSTRAINT "ezil_lifecycle_intents_deployment_size_chk" CHECK (octet_length(deployment) BETWEEN 2 AND 8192),
	CONSTRAINT "ezil_lifecycle_intents_digest_chk" CHECK (digest ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_intents" ADD CONSTRAINT "ezil_lifecycle_intents_job_fkey" FOREIGN KEY ("job_id","computer_id") REFERENCES "public"."ezil_computer_lifecycle_jobs"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_intents" ADD CONSTRAINT "ezil_lifecycle_intents_runtime_fkey" FOREIGN KEY ("computer_id") REFERENCES "public"."ezil_computer_runtimes"("computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_intents" ADD CONSTRAINT "ezil_lifecycle_intents_outbox_fkey" FOREIGN KEY ("job_id","outbox_event") REFERENCES "public"."ezil_computer_lifecycle_outbox"("job_id","event_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_intents" ADD CONSTRAINT "ezil_lifecycle_intents_previous_fkey" FOREIGN KEY ("computer_id","previous_generation") REFERENCES "public"."ezil_computer_instances"("computer_id","generation") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Publisher/user input cannot create these records. Current authorization and
-- provider evidence remain controller responsibilities, not claims by this DDL.
CREATE FUNCTION public.ezil_lifecycle_intent_insert() RETURNS trigger
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
    SELECT coalesce(max(revision),0) INTO latest FROM public.ezil_computer_lifecycle_intents WHERE computer_id=NEW.computer_id;
    IF latest=2147483647 OR NEW.revision<>latest+1 THEN
        RAISE EXCEPTION 'lifecycle revision mismatch' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.ezil_computer_lifecycle_intents i
        JOIN public.ezil_computer_lifecycle_jobs j ON j.id=i.job_id
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
    NEW.digest := encode(sha256(convert_to((to_jsonb(NEW)-ARRAY['digest','created_at'])::text,'UTF8')),'hex');
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_lifecycle_intent_insert_trg BEFORE INSERT ON public.ezil_computer_lifecycle_intents
FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_intent_insert();
--> statement-breakpoint
CREATE FUNCTION public.ezil_lifecycle_intent_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'lifecycle intent is immutable' USING ERRCODE='23514'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_lifecycle_intent_immutable_trg BEFORE UPDATE OR DELETE ON public.ezil_computer_lifecycle_intents
FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_lifecycle_intent_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_lifecycle_intents
FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE FUNCTION public.ezil_lifecycle_job_scope_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM public.ezil_computer_lifecycle_intents WHERE job_id=OLD.id)
        AND ROW(NEW.id,NEW.computer_id,NEW.operation,NEW.idempotency_key,NEW.target_generation,NEW.created_at)
            IS DISTINCT FROM ROW(OLD.id,OLD.computer_id,OLD.operation,OLD.idempotency_key,OLD.target_generation,OLD.created_at) THEN
        RAISE EXCEPTION 'lifecycle job scope is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_lifecycle_job_scope_immutable_trg BEFORE UPDATE ON public.ezil_computer_lifecycle_jobs
FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_job_scope_immutable();
--> statement-breakpoint
CREATE POLICY "Service role full access lifecycle intents" ON public.ezil_computer_lifecycle_intents
FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
