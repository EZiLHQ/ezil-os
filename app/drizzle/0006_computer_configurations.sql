CREATE TABLE "ezil_computer_configuration_deliveries" (
	"configuration_id" uuid PRIMARY KEY NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"prepared_at" timestamp with time zone,
	"loaded_at" timestamp with time zone,
	"loaded_digest" text,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "ezil_computer_configuration_deliveries_attempts_chk" CHECK (attempts >= 0),
	CONSTRAINT "ezil_computer_configuration_deliveries_error_chk" CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "ezil_computer_configuration_deliveries_receipt_chk" CHECK (
        (loaded_at IS NULL) = (loaded_digest IS NULL)
        AND (loaded_at IS NULL OR (prepared_at IS NOT NULL AND loaded_at >= prepared_at AND superseded_at IS NULL))
    )
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_configuration_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_computer_configuration_installations" (
	"configuration_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"auth_generation" integer NOT NULL,
	"install_job_id" uuid,
	"install_operation" text DEFAULT 'install' NOT NULL,
	"install_event" text DEFAULT 'reconcile' NOT NULL,
	"runtime_job_id" uuid,
	CONSTRAINT "ezil_computer_configuration_installations_pk" PRIMARY KEY("configuration_id","installation_id"),
	CONSTRAINT "ezil_computer_configuration_installations_generation_chk" CHECK (auth_generation >= 1),
	CONSTRAINT "ezil_computer_configuration_installations_operation_chk" CHECK (install_operation = 'install' AND install_event = 'reconcile')
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_configuration_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_computer_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computer_id" uuid NOT NULL,
	"computer_generation" integer NOT NULL,
	"revision" integer NOT NULL,
	"provider_instance_id" text NOT NULL,
	"fence_token" uuid NOT NULL,
	"data_volume_id" text NOT NULL,
	"configuration" text NOT NULL,
	"digest" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_computer_configurations_revision_uq" UNIQUE("computer_id","revision"),
	CONSTRAINT "ezil_computer_configurations_id_computer_uq" UNIQUE("id","computer_id"),
	CONSTRAINT "ezil_computer_configurations_receipt_uq" UNIQUE("id","digest"),
	CONSTRAINT "ezil_computer_configurations_generation_chk" CHECK (computer_generation >= 1 AND revision >= 1),
	CONSTRAINT "ezil_computer_configurations_scope_chk" CHECK (provider_instance_id ~ '^i-([0-9a-f]{8}|[0-9a-f]{17})$' AND data_volume_id ~ '^vol-([0-9a-f]{8}|[0-9a-f]{17})$'),
	CONSTRAINT "ezil_computer_configurations_size_chk" CHECK (octet_length(configuration) BETWEEN 1 AND 262144),
	CONSTRAINT "ezil_computer_configurations_digest_chk" CHECK (digest ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ezil_computer_configurations_envelope_chk" CHECK (COALESCE((
        jsonb_typeof(configuration::jsonb) = 'object'
        AND configuration::jsonb ?& ARRAY['schemaVersion','computerId','computerGeneration','configurationRevision','volumeId',
            'dataRoot','stateDirectory','stagingRoot','controlPort','memoryBudgetMiB','suspended','preparedInstallations','approvedInstallations']
        AND configuration::jsonb - ARRAY['schemaVersion','computerId','computerGeneration','configurationRevision','volumeId',
            'dataRoot','stateDirectory','stagingRoot','controlPort','memoryBudgetMiB','suspended','preparedInstallations','approvedInstallations'] = '{}'::jsonb
        AND configuration::jsonb->'schemaVersion' = '1'::jsonb
        AND configuration::jsonb->>'computerId' = computer_id::text
        AND configuration::jsonb->'computerGeneration' = to_jsonb(computer_generation)
        AND configuration::jsonb->'configurationRevision' = to_jsonb(revision)
        AND configuration::jsonb->>'volumeId' = data_volume_id
        AND jsonb_typeof(configuration::jsonb->'suspended') = 'boolean'
        AND jsonb_typeof(configuration::jsonb->'preparedInstallations') = 'array'
        AND jsonb_typeof(configuration::jsonb->'approvedInstallations') = 'array'
        AND jsonb_array_length(configuration::jsonb->'preparedInstallations') <= 128
        AND jsonb_array_length(configuration::jsonb->'approvedInstallations') <= 128
    ), false))
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_configurations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_computer_configuration_deliveries" ADD CONSTRAINT "ezil_computer_configuration_deliveries_config_fkey" FOREIGN KEY ("configuration_id") REFERENCES "public"."ezil_computer_configurations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_configuration_deliveries" ADD CONSTRAINT "ezil_computer_configuration_deliveries_digest_fkey" FOREIGN KEY ("configuration_id","loaded_digest") REFERENCES "public"."ezil_computer_configurations"("id","digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_configuration_installations" ADD CONSTRAINT "ezil_computer_configuration_installations_config_fkey" FOREIGN KEY ("configuration_id","computer_id") REFERENCES "public"."ezil_computer_configurations"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_configuration_installations" ADD CONSTRAINT "ezil_computer_configuration_installations_scope_fkey" FOREIGN KEY ("installation_id","computer_id","app_id") REFERENCES "public"."ezil_app_installations"("id","computer_id","app_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_configuration_installations" ADD CONSTRAINT "ezil_computer_configuration_installations_release_fkey" FOREIGN KEY ("release_id","app_id") REFERENCES "public"."ezil_app_releases"("id","app_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_configuration_installations" ADD CONSTRAINT "ezil_computer_configuration_installations_install_job_fkey" FOREIGN KEY ("install_job_id","installation_id","computer_id","install_operation") REFERENCES "public"."ezil_app_jobs"("id","installation_id","computer_id","operation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_configuration_installations" ADD CONSTRAINT "ezil_computer_configuration_installations_runtime_job_fkey" FOREIGN KEY ("runtime_job_id","installation_id") REFERENCES "public"."ezil_app_runtime_commands"("job_id","installation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_configuration_installations" ADD CONSTRAINT "ezil_computer_configuration_installations_outbox_fkey" FOREIGN KEY ("install_job_id","install_event") REFERENCES "public"."ezil_app_outbox"("job_id","event_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_configurations" ADD CONSTRAINT "ezil_computer_configurations_writer_fkey" FOREIGN KEY ("computer_id","computer_generation") REFERENCES "public"."ezil_computer_instances"("computer_id","generation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ezil_computer_configuration_deliveries_due_idx" ON "ezil_computer_configuration_deliveries" USING btree ("available_at") WHERE loaded_at IS NULL AND superseded_at IS NULL;
--> statement-breakpoint
-- These invariants are maintained in SQL; Drizzle metadata captures the tables.
CREATE FUNCTION public.ezil_configuration_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    RAISE EXCEPTION 'computer configuration history is immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.ezil_configuration_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE expected_revision bigint;
BEGIN
    PERFORM 1 FROM public.ezil_computers WHERE id = NEW.computer_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'configuration computer unavailable' USING ERRCODE = '23503'; END IF;
    PERFORM 1 FROM public.ezil_computer_instances i
        JOIN public.ezil_computer_runtimes r ON r.computer_id = i.computer_id
        WHERE i.computer_id = NEW.computer_id AND i.generation = NEW.computer_generation
        AND i.fenced_at IS NULL AND i.fence_token = NEW.fence_token
        AND i.provider_instance_id = NEW.provider_instance_id AND r.data_volume_id = NEW.data_volume_id
        FOR SHARE OF i,r;
    IF NOT FOUND THEN RAISE EXCEPTION 'configuration writer mismatch' USING ERRCODE = '23514'; END IF;
    SELECT coalesce(max(revision)::bigint,0)+1 INTO expected_revision
        FROM public.ezil_computer_configurations WHERE computer_id = NEW.computer_id;
    IF NEW.revision <> expected_revision THEN
        RAISE EXCEPTION 'configuration revision conflict' USING ERRCODE = '23514';
    END IF;
    NEW.digest := encode(sha256(convert_to(NEW.configuration, 'UTF8')), 'hex');
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_configuration_insert_trg BEFORE INSERT ON public.ezil_computer_configurations
FOR EACH ROW EXECUTE FUNCTION public.ezil_configuration_insert();
--> statement-breakpoint
CREATE TRIGGER ezil_configuration_immutable_trg BEFORE UPDATE OR DELETE ON public.ezil_computer_configurations
FOR EACH ROW EXECUTE FUNCTION public.ezil_configuration_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_configuration_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_configurations
FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_configuration_immutable();
--> statement-breakpoint
CREATE FUNCTION public.ezil_configuration_binding_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE snapshot public.ezil_computer_configurations;
BEGIN
    PERFORM 1 FROM public.ezil_computers WHERE id = NEW.computer_id FOR UPDATE;
    SELECT * INTO snapshot FROM public.ezil_computer_configurations
        WHERE id = NEW.configuration_id AND computer_id = NEW.computer_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'configuration binding scope mismatch' USING ERRCODE = '23503'; END IF;
    PERFORM 1 FROM public.ezil_app_installations i
        JOIN public.ezil_app_releases r ON r.id = NEW.release_id AND r.app_id = NEW.app_id
        WHERE i.id = NEW.installation_id AND i.computer_id = NEW.computer_id AND i.app_id = NEW.app_id
        AND i.release_id = r.id AND i.auth_generation = NEW.auth_generation AND i.uninstalled_at IS NULL
        AND r.status = 'approved'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot.configuration::jsonb->'preparedInstallations') p
            WHERE p = jsonb_build_object('installationId',i.id::text,'releaseId',r.id::text,
                'policyDigest',r.policy_digest,'image',r.image_reference,'privateDirectories',
                CASE WHEN r.manifest->'persistence'->>'mode' = 'computer-volume'
                    THEN r.manifest->'persistence'->'privateDirectories' ELSE '[]'::jsonb END))
        FOR SHARE OF i,r;
    IF NOT FOUND THEN RAISE EXCEPTION 'configuration prepared release mismatch' USING ERRCODE = '23514'; END IF;
    IF NEW.runtime_job_id IS NOT NULL THEN
        PERFORM 1 FROM public.ezil_app_runtime_commands c
            WHERE c.job_id = NEW.runtime_job_id AND c.installation_id = NEW.installation_id
            AND c.computer_id = NEW.computer_id AND c.computer_generation = snapshot.computer_generation
            AND c.app_id = NEW.app_id AND c.release_id = NEW.release_id AND c.auth_generation = NEW.auth_generation
            AND c.operation = 'start'
            AND c.generation = (SELECT max(generation) FROM public.ezil_app_runtime_commands WHERE installation_id = c.installation_id)
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot.configuration::jsonb->'approvedInstallations') p
                WHERE p = jsonb_build_object('installationId',c.installation_id::text,'plan',c.plan));
        IF NOT FOUND THEN RAISE EXCEPTION 'configuration execution mismatch' USING ERRCODE = '23514'; END IF;
    ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot.configuration::jsonb->'approvedInstallations') p
        WHERE p->>'installationId' = NEW.installation_id::text) THEN
        RAISE EXCEPTION 'execution requires a committed command' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_configuration_binding_insert_trg BEFORE INSERT ON public.ezil_computer_configuration_installations
FOR EACH ROW EXECUTE FUNCTION public.ezil_configuration_binding_insert();
--> statement-breakpoint
CREATE TRIGGER ezil_configuration_binding_immutable_trg BEFORE UPDATE OR DELETE ON public.ezil_computer_configuration_installations
FOR EACH ROW EXECUTE FUNCTION public.ezil_configuration_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_configuration_binding_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_configuration_installations
FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_configuration_immutable();
--> statement-breakpoint
CREATE FUNCTION public.ezil_configuration_delivery_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE owner_computer uuid;
BEGIN
    SELECT computer_id INTO owner_computer FROM public.ezil_computer_configurations WHERE id = NEW.configuration_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'configuration delivery target missing' USING ERRCODE = '23503'; END IF;
    PERFORM 1 FROM public.ezil_computers WHERE id = owner_computer FOR UPDATE;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.configuration_id <> OLD.configuration_id OR NEW.attempts < OLD.attempts
            OR ((OLD.loaded_at IS NOT NULL OR OLD.superseded_at IS NOT NULL) AND NEW IS DISTINCT FROM OLD)
            OR (OLD.prepared_at IS NOT NULL AND NEW.prepared_at IS DISTINCT FROM OLD.prepared_at) THEN
            RAISE EXCEPTION 'configuration delivery history conflict' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF (NEW.lease_until IS NOT NULL AND (NEW.attempts = 0 OR NEW.loaded_at IS NOT NULL OR NEW.superseded_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'configuration delivery lease conflict' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_configuration_delivery_write_trg BEFORE INSERT OR UPDATE ON public.ezil_computer_configuration_deliveries
FOR EACH ROW EXECUTE FUNCTION public.ezil_configuration_delivery_write();
--> statement-breakpoint
CREATE TRIGGER ezil_configuration_delivery_no_delete_trg BEFORE DELETE ON public.ezil_computer_configuration_deliveries
FOR EACH ROW EXECUTE FUNCTION public.ezil_configuration_immutable();
--> statement-breakpoint
CREATE TRIGGER ezil_configuration_delivery_no_truncate_trg BEFORE TRUNCATE ON public.ezil_computer_configuration_deliveries
FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_configuration_immutable();
--> statement-breakpoint
-- The transaction must contain its complete membership and delivery event.
-- Validate a loaded receipt at commit, after all membership writes, so inserting
-- a receipt before its bindings cannot bypass current-generation checks.
CREATE FUNCTION public.ezil_configuration_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE target uuid; snapshot public.ezil_computer_configurations;
receipt public.ezil_computer_configuration_deliveries; bindings bigint; executable bigint;
BEGIN
    IF TG_TABLE_NAME = 'ezil_computer_configurations' THEN target := NEW.id;
    ELSE target := NEW.configuration_id; END IF;
    SELECT * INTO snapshot FROM public.ezil_computer_configurations WHERE id = target;
    SELECT * INTO receipt FROM public.ezil_computer_configuration_deliveries WHERE configuration_id = target;
    IF NOT FOUND THEN RAISE EXCEPTION 'configuration delivery record required' USING ERRCODE = '23514'; END IF;
    SELECT count(*),count(runtime_job_id) INTO bindings,executable FROM public.ezil_computer_configuration_installations
        WHERE configuration_id = target;
    IF bindings <> jsonb_array_length(snapshot.configuration::jsonb->'preparedInstallations')
        OR executable <> jsonb_array_length(snapshot.configuration::jsonb->'approvedInstallations') THEN
        RAISE EXCEPTION 'configuration membership incomplete' USING ERRCODE = '23514';
    END IF;
    IF receipt.loaded_at IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.ezil_computer_configurations
            WHERE computer_id = snapshot.computer_id AND revision > snapshot.revision) THEN
            RAISE EXCEPTION 'configuration receipt is stale' USING ERRCODE = '23514';
        END IF;
        PERFORM 1 FROM public.ezil_computer_instances i
            JOIN public.ezil_computer_runtimes r ON r.computer_id = i.computer_id
            JOIN public.ezil_computers c ON c.id = i.computer_id
            WHERE i.computer_id = snapshot.computer_id AND i.generation = snapshot.computer_generation
            AND i.fenced_at IS NULL AND i.fence_token = snapshot.fence_token
            AND i.provider_instance_id = snapshot.provider_instance_id AND r.data_volume_id = snapshot.data_volume_id
            AND c.deleted_at IS NULL FOR SHARE OF i,r,c;
        IF NOT FOUND THEN RAISE EXCEPTION 'configuration receipt writer changed' USING ERRCODE = '23514'; END IF;
        -- Hold the authority versions until commit, including raw privileged
        -- revocation writers that do not take the computer lock.
        PERFORM 1 FROM public.ezil_computer_configuration_installations b
            JOIN public.ezil_app_installations i ON i.id = b.installation_id
            JOIN public.ezil_app_releases r ON r.id = b.release_id
            WHERE b.configuration_id = target ORDER BY i.id FOR SHARE OF i,r;
        PERFORM 1 FROM public.ezil_computer_configuration_installations b
            JOIN public.ezil_app_jobs j ON j.id = b.install_job_id
            WHERE b.configuration_id = target ORDER BY j.id FOR SHARE OF j;
        IF EXISTS (SELECT 1 FROM public.ezil_computer_configuration_installations b
            JOIN public.ezil_app_installations i ON i.id = b.installation_id
            JOIN public.ezil_app_releases r ON r.id = b.release_id
            LEFT JOIN public.ezil_app_jobs j ON j.id = b.install_job_id
            LEFT JOIN public.ezil_app_runtime_commands cmd ON cmd.job_id = b.runtime_job_id
            WHERE b.configuration_id = target AND (i.auth_generation <> b.auth_generation OR i.release_id <> b.release_id
                OR i.uninstalled_at IS NOT NULL OR r.status <> 'approved' OR j.status IN ('failed','cancelled')
                OR (b.runtime_job_id IS NOT NULL AND cmd.generation <> (SELECT max(generation)
                    FROM public.ezil_app_runtime_commands WHERE installation_id = b.installation_id)))) THEN
            RAISE EXCEPTION 'configuration receipt authority changed' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ezil_configuration_complete_trg AFTER INSERT ON public.ezil_computer_configurations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ezil_configuration_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ezil_configuration_binding_complete_trg AFTER INSERT ON public.ezil_computer_configuration_installations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ezil_configuration_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ezil_configuration_delivery_complete_trg AFTER INSERT OR UPDATE ON public.ezil_computer_configuration_deliveries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ezil_configuration_complete();
--> statement-breakpoint
CREATE POLICY "Service role full access computer configurations" ON public.ezil_computer_configurations
FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access configuration installations" ON public.ezil_computer_configuration_installations
FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access configuration deliveries" ON public.ezil_computer_configuration_deliveries
FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
