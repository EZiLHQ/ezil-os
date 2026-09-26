CREATE TABLE "ezil_computer_data_mount_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computer_id" uuid NOT NULL,
	"computer_generation" integer NOT NULL,
	"lifecycle_job_id" uuid NOT NULL,
	"fence_token" uuid NOT NULL,
	"provider_instance_id" text NOT NULL,
	"data_volume_id" text NOT NULL,
	"filesystem_uuid" uuid NOT NULL,
	"mode" text NOT NULL,
	"digest" text DEFAULT '' NOT NULL,
	"provider_observed_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ezil_mount_authority_job_uq" UNIQUE("lifecycle_job_id"),
	CONSTRAINT "ezil_mount_authority_scope_chk" CHECK (computer_generation >= 1 AND provider_instance_id ~ '^i-[a-f0-9]{17}$' AND data_volume_id ~ '^vol-[a-f0-9]{17}$'),
	CONSTRAINT "ezil_mount_authority_mode_chk" CHECK (mode IN ('initialize','mount')),
	CONSTRAINT "ezil_mount_authority_digest_chk" CHECK (digest ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ezil_mount_authority_lifetime_chk" CHECK (expires_at = issued_at + interval '900 seconds' AND provider_observed_at BETWEEN issued_at - interval '30 seconds' AND issued_at + interval '5 seconds')
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_data_mount_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_computer_data_mount_deliveries" (
	"authorization_id" uuid PRIMARY KEY NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"mounted_at" timestamp with time zone,
	"receipt" text,
	CONSTRAINT "ezil_mount_delivery_attempts_chk" CHECK (attempts >= 0),
	CONSTRAINT "ezil_mount_delivery_error_chk" CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "ezil_mount_delivery_receipt_chk" CHECK ((mounted_at IS NULL) = (receipt IS NULL) AND (receipt IS NULL OR octet_length(receipt) BETWEEN 2 AND 4096))
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_data_mount_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_computer_data_mount_authorizations" ADD CONSTRAINT "ezil_mount_authority_writer_fkey" FOREIGN KEY ("computer_id","computer_generation") REFERENCES "public"."ezil_computer_instances"("computer_id","generation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_data_mount_authorizations" ADD CONSTRAINT "ezil_mount_authority_job_fkey" FOREIGN KEY ("lifecycle_job_id","computer_id") REFERENCES "public"."ezil_computer_lifecycle_jobs"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_data_mount_deliveries" ADD CONSTRAINT "ezil_mount_delivery_authority_fkey" FOREIGN KEY ("authorization_id") REFERENCES "public"."ezil_computer_data_mount_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_mount_authority_initialization_uidx" ON "ezil_computer_data_mount_authorizations" USING btree ("computer_id") WHERE mode = 'initialize';--> statement-breakpoint
CREATE INDEX "ezil_mount_delivery_due_idx" ON "ezil_computer_data_mount_deliveries" USING btree ("available_at") WHERE mounted_at IS NULL;--> statement-breakpoint
-- Canonical bytes match the host DataMountPlan contract. These columns are
-- immutable, and the database computes the digest instead of accepting one.
CREATE FUNCTION public.ezil_data_mount_plan(a public.ezil_computer_data_mount_authorizations) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
    SELECT format('{"computerId":"%s","filesystemUuid":"%s","mode":"%s","schemaVersion":1,"volumeId":"%s"}',
        a.computer_id, a.filesystem_uuid, a.mode, a.data_volume_id)
$$;
--> statement-breakpoint
-- Caller must separately verify live OS entitlement/deployment/provider state.
-- Lock order agrees with lifecycle consumers. A provider receipt is not a
-- mounted-disk receipt; this predicate checks only stored authority scope.
CREATE FUNCTION public.ezil_data_mount_current(a public.ezil_computer_data_mount_authorizations) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE c public.ezil_computers; r public.ezil_computer_runtimes;
    j public.ezil_computer_lifecycle_jobs; w public.ezil_computer_instances; i jsonb;
BEGIN
    SELECT * INTO c FROM public.ezil_computers WHERE id=a.computer_id FOR UPDATE;
    SELECT * INTO r FROM public.ezil_computer_runtimes WHERE computer_id=a.computer_id FOR UPDATE;
    SELECT * INTO j FROM public.ezil_computer_lifecycle_jobs WHERE id=a.lifecycle_job_id AND computer_id=a.computer_id FOR UPDATE;
    SELECT * INTO w FROM public.ezil_computer_instances WHERE computer_id=a.computer_id AND generation=a.computer_generation FOR UPDATE;
    IF j.operation='recover' THEN
        SELECT public.ezil_computer_recovery_document(t)::jsonb INTO i FROM public.ezil_computer_recovery_intents t WHERE job_id=j.id;
    ELSE
        SELECT public.ezil_lifecycle_intent_document(t)::jsonb INTO i FROM public.ezil_computer_lifecycle_intents t WHERE job_id=j.id;
    END IF;
    RETURN COALESCE(c.provider='aws-ec2' AND c.deleted_at IS NULL AND r.desired_state='running'
        AND j.status='succeeded' AND j.completed_at IS NOT NULL AND j.requested_by=c.user_id
        AND j.operation IN ('provision','start','replace','recover') AND j.target_generation=a.computer_generation
        AND w.fenced_at IS NULL AND w.observed_state='running' AND w.fence_token=a.fence_token
        AND w.provider_instance_id=a.provider_instance_id AND r.data_volume_id=a.data_volume_id
        AND r.data_filesystem_uuid=a.filesystem_uuid
        AND i->>'computerId'=a.computer_id::text AND i->>'fenceToken'=a.fence_token::text
        AND (i->>'targetGeneration')::integer=a.computer_generation
        AND (CASE WHEN j.operation='provision' THEN a.mode='initialize' AND i->'dataVolumeId'='null'::jsonb
            ELSE a.mode='mount' AND i->>'dataVolumeId'=a.data_volume_id END)
        AND NOT EXISTS(SELECT 1 FROM public.ezil_computer_lifecycle_jobs later WHERE later.computer_id=a.computer_id
            AND later.id<>j.id AND (later.status IN ('queued','running') OR later.created_at>=j.created_at))
        AND NOT EXISTS(SELECT 1 FROM public.ezil_computer_cancellations WHERE source_job_id=j.id), false);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.ezil_data_mount_authority_write() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
            OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
            RAISE EXCEPTION 'mount authority is immutable' USING ERRCODE='23514';
        END IF;
        IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN NEW.revoked_at:=clock_timestamp(); END IF;
        RETURN NEW;
    END IF;
    IF NEW.revoked_at IS NOT NULL OR NOT public.ezil_data_mount_current(NEW) THEN
        RAISE EXCEPTION 'mount authority scope invalid' USING ERRCODE='23514';
    END IF;
    NEW.issued_at:=date_trunc('second',clock_timestamp());
    NEW.expires_at:=NEW.issued_at+interval '900 seconds';
    NEW.digest:=encode(sha256(convert_to(public.ezil_data_mount_plan(NEW),'UTF8')),'hex');
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_mount_authority_write_trg BEFORE INSERT OR UPDATE ON public.ezil_computer_data_mount_authorizations
    FOR EACH ROW EXECUTE FUNCTION public.ezil_data_mount_authority_write();
--> statement-breakpoint
CREATE TRIGGER ezil_mount_authority_no_delete_trg BEFORE DELETE ON public.ezil_computer_data_mount_authorizations
    FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_mount_authority_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_data_mount_authorizations
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE FUNCTION public.ezil_data_mount_enqueue() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
    INSERT INTO public.ezil_computer_data_mount_deliveries(authorization_id) VALUES (NEW.id);
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_mount_authority_enqueue_trg AFTER INSERT ON public.ezil_computer_data_mount_authorizations
    FOR EACH ROW EXECUTE FUNCTION public.ezil_data_mount_enqueue();
--> statement-breakpoint
CREATE FUNCTION public.ezil_data_mount_delivery_write() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a public.ezil_computer_data_mount_authorizations; v jsonb; scope jsonb;
BEGIN
    IF TG_OP='INSERT' THEN
        IF NEW.mounted_at IS NOT NULL OR NEW.receipt IS NOT NULL OR NEW.attempts<>0 OR NEW.lease_until IS NOT NULL THEN
            RAISE EXCEPTION 'mount delivery initial state invalid' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.authorization_id IS DISTINCT FROM OLD.authorization_id OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
        OR (OLD.mounted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'mount delivery history is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.mounted_at IS NOT NULL THEN
        SELECT * INTO a FROM public.ezil_computer_data_mount_authorizations WHERE id=NEW.authorization_id;
        IF NOT public.ezil_data_mount_current(a) THEN
            RAISE EXCEPTION 'mount receipt scope invalid' USING ERRCODE='23514';
        END IF;
        SELECT * INTO a FROM public.ezil_computer_data_mount_authorizations WHERE id=NEW.authorization_id FOR UPDATE;
        IF a.revoked_at IS NOT NULL OR a.expires_at<=clock_timestamp() OR OLD.lease_until IS NULL
            OR OLD.lease_until<=clock_timestamp() OR OLD.attempts<1 THEN
            RAISE EXCEPTION 'mount receipt authority expired' USING ERRCODE='23514';
        END IF;
        v:=NEW.receipt::jsonb;
        scope:=jsonb_build_object('computerId',a.computer_id,'computerGeneration',a.computer_generation,
            'fenceToken',a.fence_token,'providerInstanceId',a.provider_instance_id,'dataVolumeId',a.data_volume_id);
        IF v IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'authorizationId',a.id,'scope',scope,'digest',a.digest,
            'state','mounted','computerId',a.computer_id,'volumeId',a.data_volume_id,'filesystemUuid',a.filesystem_uuid) THEN
            RAISE EXCEPTION 'mount receipt invalid' USING ERRCODE='23514';
        END IF;
        NEW.mounted_at:=clock_timestamp(); NEW.lease_until:=NULL; NEW.error_code:=NULL;
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_mount_delivery_write_trg BEFORE INSERT OR UPDATE ON public.ezil_computer_data_mount_deliveries
    FOR EACH ROW EXECUTE FUNCTION public.ezil_data_mount_delivery_write();
--> statement-breakpoint
CREATE TRIGGER ezil_mount_delivery_no_delete_trg BEFORE DELETE ON public.ezil_computer_data_mount_deliveries
    FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_mount_delivery_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_data_mount_deliveries
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE POLICY "Service role full access mount authorities" ON public.ezil_computer_data_mount_authorizations
    FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access mount deliveries" ON public.ezil_computer_data_mount_deliveries
    FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
