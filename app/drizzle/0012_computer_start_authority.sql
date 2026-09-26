CREATE TABLE "ezil_computer_control_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computer_id" uuid NOT NULL,
	"computer_generation" integer NOT NULL,
	"creation_mount_id" uuid NOT NULL,
	"fence_token" uuid NOT NULL,
	"provider_instance_id" text NOT NULL,
	"data_volume_id" text NOT NULL,
	"account_id" text NOT NULL,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"namespace" text NOT NULL,
	"control_domain" text NOT NULL,
	"kms_key_arn" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"create_attempted_at" timestamp with time zone,
	"key_confirmed_at" timestamp with time zone,
	"secret_arn" text,
	CONSTRAINT "ezil_control_binding_writer_uq" UNIQUE("computer_id","computer_generation"),
	CONSTRAINT "ezil_control_binding_scope_uq" UNIQUE("id","computer_id","computer_generation"),
	CONSTRAINT "ezil_control_binding_creation_chk" CHECK ((key_confirmed_at IS NULL) = (secret_arn IS NULL)
        AND (key_confirmed_at IS NULL OR (create_attempted_at IS NOT NULL AND key_confirmed_at >= create_attempted_at))
        AND (secret_arn IS NULL OR secret_arn ~ ('^arn:aws:secretsmanager:' || region || ':' || account_id || ':secret:'
            || namespace || '/computers/' || computer_id::text || '/generations/' || computer_generation::text || '/control-[A-Za-z0-9]{6}$'))),
	CONSTRAINT "ezil_control_binding_scope_chk" CHECK (computer_generation >= 1 AND provider_instance_id ~ '^i-[a-f0-9]{17}$' AND data_volume_id ~ '^vol-[a-f0-9]{17}$'),
	CONSTRAINT "ezil_control_binding_reference_chk" CHECK (region = 'us-east-1' AND account_id ~ '^[0-9]{12}$'
        AND namespace ~ '^[a-z][a-z0-9-]{0,30}$' AND octet_length(control_domain) <= 190
        AND control_domain ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])+[a-z]{2,63}$'
        AND kms_key_arn ~ ('^arn:aws:kms:us-east-1:' || account_id || ':key/[a-f0-9-]{36}$'))
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_control_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_computer_start_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computer_id" uuid NOT NULL,
	"computer_generation" integer NOT NULL,
	"control_binding_id" uuid NOT NULL,
	"configuration_id" uuid NOT NULL,
	"mount_authorization_id" uuid NOT NULL,
	"provider_observed_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ezil_start_authority_generation_chk" CHECK (computer_generation >= 1),
	CONSTRAINT "ezil_start_authority_lifetime_chk" CHECK (expires_at = issued_at + interval '300 seconds' AND provider_observed_at BETWEEN issued_at - interval '30 seconds' AND issued_at + interval '5 seconds')
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_start_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_computer_start_deliveries" (
	"authorization_id" uuid PRIMARY KEY NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone,
	"receipt" text,
	CONSTRAINT "ezil_start_delivery_attempts_chk" CHECK (attempts >= 0),
	CONSTRAINT "ezil_start_delivery_error_chk" CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "ezil_start_delivery_receipt_chk" CHECK ((started_at IS NULL) = (receipt IS NULL) AND (receipt IS NULL OR octet_length(receipt) BETWEEN 2 AND 4096))
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_start_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_computer_control_bindings" ADD CONSTRAINT "ezil_control_binding_writer_fkey" FOREIGN KEY ("computer_id","computer_generation") REFERENCES "public"."ezil_computer_instances"("computer_id","generation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_control_bindings" ADD CONSTRAINT "ezil_control_binding_mount_fkey" FOREIGN KEY ("creation_mount_id") REFERENCES "public"."ezil_computer_data_mount_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_start_authorizations" ADD CONSTRAINT "ezil_start_authority_binding_fkey" FOREIGN KEY ("control_binding_id","computer_id","computer_generation") REFERENCES "public"."ezil_computer_control_bindings"("id","computer_id","computer_generation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_start_authorizations" ADD CONSTRAINT "ezil_start_authority_configuration_fkey" FOREIGN KEY ("configuration_id","computer_id") REFERENCES "public"."ezil_computer_configurations"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_start_authorizations" ADD CONSTRAINT "ezil_start_authority_mount_fkey" FOREIGN KEY ("mount_authorization_id") REFERENCES "public"."ezil_computer_data_mount_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_start_deliveries" ADD CONSTRAINT "ezil_start_delivery_authority_fkey" FOREIGN KEY ("authorization_id") REFERENCES "public"."ezil_computer_start_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_start_authority_current_uidx" ON "ezil_computer_start_authorizations" USING btree ("computer_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "ezil_start_delivery_due_idx" ON "ezil_computer_start_deliveries" USING btree ("available_at") WHERE started_at IS NULL;--> statement-breakpoint
-- Stored evidence only: issuance must also recompile current OS/app authority,
-- approve domain/KMS policy and observe AWS. No function creates a secret or
-- starts compute. Callers lock computer/runtime/job/writer before queue rows.
-- Mount execution expiry does not invalidate an in-time completed mount.
CREATE FUNCTION public.ezil_start_mount_current(mount_id uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a public.ezil_computer_data_mount_authorizations; d public.ezil_computer_data_mount_deliveries;
BEGIN
    SELECT * INTO a FROM public.ezil_computer_data_mount_authorizations WHERE id=mount_id;
    IF NOT FOUND OR NOT public.ezil_data_mount_current(a) THEN RETURN false; END IF;
    -- Hold revocation authority until commit; completion records are immutable.
    SELECT * INTO a FROM public.ezil_computer_data_mount_authorizations WHERE id=mount_id FOR SHARE;
    SELECT * INTO d FROM public.ezil_computer_data_mount_deliveries WHERE authorization_id=mount_id;
    RETURN COALESCE(a.revoked_at IS NULL AND d.receipt IS NOT NULL
        AND d.mounted_at>=a.issued_at AND d.mounted_at<a.expires_at, false);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.ezil_control_binding_write() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a public.ezil_computer_data_mount_authorizations; deployment jsonb;
BEGIN
    IF TG_OP='UPDATE' THEN
        IF (to_jsonb(NEW)-ARRAY['revoked_at','create_attempted_at','key_confirmed_at','secret_arn'])
            IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','create_attempted_at','key_confirmed_at','secret_arn'])
            OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
            OR (OLD.create_attempted_at IS NOT NULL AND NEW.create_attempted_at IS DISTINCT FROM OLD.create_attempted_at)
            OR (OLD.key_confirmed_at IS NOT NULL AND ROW(NEW.key_confirmed_at,NEW.secret_arn)
                IS DISTINCT FROM ROW(OLD.key_confirmed_at,OLD.secret_arn)) THEN
            RAISE EXCEPTION 'control binding is immutable' USING ERRCODE='23514';
        END IF;
        -- Persist an attempt before CreateSecret. A crash or lost response may
        -- only observe that reserved version, never authorize another creation.
        IF OLD.create_attempted_at IS NULL AND NEW.create_attempted_at IS NOT NULL THEN
            IF NEW.revoked_at IS NOT NULL OR NEW.key_confirmed_at IS NOT NULL THEN
                RAISE EXCEPTION 'control key attempt invalid' USING ERRCODE='23514';
            END IF;
            NEW.create_attempted_at:=clock_timestamp();
        END IF;
        IF OLD.key_confirmed_at IS NULL AND NEW.key_confirmed_at IS NOT NULL THEN
            IF OLD.create_attempted_at IS NULL OR NEW.revoked_at IS NOT NULL THEN
                RAISE EXCEPTION 'control key confirmation invalid' USING ERRCODE='23514';
            END IF;
            NEW.key_confirmed_at:=clock_timestamp();
        END IF;
        IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN NEW.revoked_at:=clock_timestamp(); END IF;
        RETURN NEW;
    END IF;
    IF NEW.revoked_at IS NOT NULL OR NEW.create_attempted_at IS NOT NULL OR NEW.key_confirmed_at IS NOT NULL OR NEW.secret_arn IS NOT NULL
        OR NOT public.ezil_start_mount_current(NEW.creation_mount_id) THEN
        RAISE EXCEPTION 'control binding mount unavailable' USING ERRCODE='23514';
    END IF;
    SELECT * INTO a FROM public.ezil_computer_data_mount_authorizations WHERE id=NEW.creation_mount_id;
    SELECT i.deployment::jsonb INTO deployment FROM public.ezil_computer_lifecycle_intents i WHERE i.job_id=a.lifecycle_job_id;
    IF NOT FOUND THEN
        SELECT i.deployment::jsonb INTO deployment FROM public.ezil_computer_recovery_intents i WHERE i.job_id=a.lifecycle_job_id;
    END IF;
    IF ROW(NEW.computer_id,NEW.computer_generation,NEW.fence_token,NEW.provider_instance_id,NEW.data_volume_id,
        NEW.account_id,NEW.region,NEW.namespace) IS DISTINCT FROM ROW(a.computer_id,a.computer_generation,a.fence_token,
        a.provider_instance_id,a.data_volume_id,deployment->>'accountId',deployment->>'region',deployment->>'namespace') THEN
        RAISE EXCEPTION 'control binding scope invalid' USING ERRCODE='23514';
    END IF;
    NEW.created_at:=clock_timestamp();
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_control_binding_write_trg BEFORE INSERT OR UPDATE ON public.ezil_computer_control_bindings
    FOR EACH ROW EXECUTE FUNCTION public.ezil_control_binding_write();
--> statement-breakpoint
CREATE TRIGGER ezil_control_binding_no_delete_trg BEFORE DELETE ON public.ezil_computer_control_bindings
    FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_control_binding_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_control_bindings
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE FUNCTION public.ezil_computer_start_current(s public.ezil_computer_start_authorizations) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a public.ezil_computer_data_mount_authorizations; b public.ezil_computer_control_bindings;
    c public.ezil_computer_configurations; d public.ezil_computer_configuration_deliveries;
BEGIN
    IF NOT public.ezil_start_mount_current(s.mount_authorization_id) THEN RETURN false; END IF;
    SELECT * INTO a FROM public.ezil_computer_data_mount_authorizations WHERE id=s.mount_authorization_id;
    SELECT * INTO b FROM public.ezil_computer_control_bindings WHERE id=s.control_binding_id FOR SHARE;
    IF NOT FOUND OR b.revoked_at IS NOT NULL OR b.key_confirmed_at IS NULL OR b.secret_arn IS NULL THEN RETURN false; END IF;
    -- The creation mount may be historical after same-generation stop/start.
    -- Reuse that immutable key reference, but require a fresh current mount.
    SELECT * INTO c FROM public.ezil_computer_configurations WHERE id=s.configuration_id;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO d FROM public.ezil_computer_configuration_deliveries WHERE configuration_id=c.id FOR SHARE;
    RETURN COALESCE(d.prepared_at IS NOT NULL AND d.superseded_at IS NULL
        AND c.configuration::jsonb->'suspended'='false'::jsonb
        AND s.computer_id=a.computer_id AND s.computer_generation=a.computer_generation
        AND ROW(b.computer_id,b.computer_generation,b.fence_token,b.provider_instance_id,b.data_volume_id)
            IS NOT DISTINCT FROM ROW(a.computer_id,a.computer_generation,a.fence_token,a.provider_instance_id,a.data_volume_id)
        AND ROW(c.computer_id,c.computer_generation,c.fence_token,c.provider_instance_id,c.data_volume_id)
            IS NOT DISTINCT FROM ROW(a.computer_id,a.computer_generation,a.fence_token,a.provider_instance_id,a.data_volume_id)
        AND NOT EXISTS(SELECT 1 FROM public.ezil_computer_configurations later
            WHERE later.computer_id=s.computer_id AND later.revision>c.revision), false);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.ezil_computer_start_write() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
            OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
            RAISE EXCEPTION 'start authorization is immutable' USING ERRCODE='23514';
        END IF;
        IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN NEW.revoked_at:=clock_timestamp(); END IF;
        RETURN NEW;
    END IF;
    IF NEW.revoked_at IS NOT NULL OR NOT public.ezil_computer_start_current(NEW) THEN
        RAISE EXCEPTION 'start authorization scope invalid' USING ERRCODE='23514';
    END IF;
    NEW.issued_at:=date_trunc('second',clock_timestamp());
    NEW.expires_at:=NEW.issued_at+interval '300 seconds';
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_start_authority_write_trg BEFORE INSERT OR UPDATE ON public.ezil_computer_start_authorizations
    FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_start_write();
--> statement-breakpoint
CREATE TRIGGER ezil_start_authority_no_delete_trg BEFORE DELETE ON public.ezil_computer_start_authorizations
    FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_start_authority_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_start_authorizations
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE FUNCTION public.ezil_computer_start_enqueue() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
    INSERT INTO public.ezil_computer_start_deliveries(authorization_id) VALUES (NEW.id);
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_start_authority_enqueue_trg AFTER INSERT ON public.ezil_computer_start_authorizations
    FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_start_enqueue();
--> statement-breakpoint
CREATE FUNCTION public.ezil_computer_start_delivery_write() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE s public.ezil_computer_start_authorizations; c public.ezil_computer_configurations; v jsonb;
BEGIN
    IF TG_OP='INSERT' THEN
        IF NEW.started_at IS NOT NULL OR NEW.receipt IS NOT NULL OR NEW.attempts<>0 OR NEW.lease_until IS NOT NULL OR NEW.error_code IS NOT NULL THEN
            RAISE EXCEPTION 'start delivery initial state invalid' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.authorization_id IS DISTINCT FROM OLD.authorization_id OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
        OR (OLD.started_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'start delivery history is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.started_at IS NOT NULL THEN RETURN NEW; END IF;
    IF NEW.lease_until IS NOT NULL AND NEW.attempts=0 THEN
        RAISE EXCEPTION 'start delivery lease invalid' USING ERRCODE='23514';
    END IF;
    IF NEW.started_at IS NOT NULL THEN
        SELECT * INTO s FROM public.ezil_computer_start_authorizations WHERE id=NEW.authorization_id;
        IF NOT public.ezil_computer_start_current(s) THEN
            RAISE EXCEPTION 'start receipt scope invalid' USING ERRCODE='23514';
        END IF;
        SELECT * INTO s FROM public.ezil_computer_start_authorizations WHERE id=NEW.authorization_id FOR SHARE;
        IF s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR OLD.lease_until IS NULL
            OR OLD.lease_until<=clock_timestamp() OR OLD.attempts<1 OR NEW.attempts<>OLD.attempts THEN
            RAISE EXCEPTION 'start receipt authority expired' USING ERRCODE='23514';
        END IF;
        SELECT * INTO c FROM public.ezil_computer_configurations WHERE id=s.configuration_id;
        BEGIN v:=NEW.receipt::jsonb;
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'start receipt invalid' USING ERRCODE='23514';
        END;
        IF v IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'authorizationId',s.id,'state','started',
            'scope',jsonb_build_object('computerId',c.computer_id,'computerGeneration',c.computer_generation,
                'fenceToken',c.fence_token,'providerInstanceId',c.provider_instance_id,'dataVolumeId',c.data_volume_id),
            'descriptor',jsonb_build_object('computerId',c.computer_id,'computerGeneration',c.computer_generation,
                'configurationRevision',c.revision,'configurationDigest',c.digest)) THEN
            RAISE EXCEPTION 'start receipt invalid' USING ERRCODE='23514';
        END IF;
        NEW.started_at:=clock_timestamp(); NEW.lease_until:=NULL; NEW.error_code:=NULL;
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_start_delivery_write_trg BEFORE INSERT OR UPDATE ON public.ezil_computer_start_deliveries
    FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_start_delivery_write();
--> statement-breakpoint
CREATE TRIGGER ezil_start_delivery_no_delete_trg BEFORE DELETE ON public.ezil_computer_start_deliveries
    FOR EACH ROW EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_start_delivery_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_start_deliveries
    FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_lifecycle_intent_immutable();
--> statement-breakpoint
CREATE POLICY "Service role full access control bindings" ON public.ezil_computer_control_bindings
    FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access start authorizations" ON public.ezil_computer_start_authorizations
    FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access start deliveries" ON public.ezil_computer_start_deliveries
    FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
