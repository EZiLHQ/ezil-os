CREATE TABLE "ezil_app_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ezil_app_admins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"app_id" uuid,
	"release_id" uuid,
	"submission_id" uuid,
	"installation_id" uuid,
	"computer_id" uuid,
	"reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_app_audit_action_chk" CHECK (length(action) between 1 and 100),
	CONSTRAINT "ezil_app_audit_reason_chk" CHECK (reason_code is null or length(reason_code) <= 100),
	CONSTRAINT "ezil_app_audit_scope_chk" CHECK ((release_id is null or app_id is not null) and (installation_id is null or computer_id is not null))
);
--> statement-breakpoint
ALTER TABLE "ezil_app_audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_folder_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"scope" text NOT NULL,
	"project_id" uuid,
	"access" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ezil_app_folder_grants_folder_chk" CHECK (folder in ('Documents','Projects','Downloads')),
	CONSTRAINT "ezil_app_folder_grants_access_chk" CHECK (access in ('read','read-write')),
	CONSTRAINT "ezil_app_folder_grants_scope_chk" CHECK ((scope = 'whole-folder' and project_id is null) or (scope = 'selected-projects' and folder = 'Projects' and project_id is not null))
);
--> statement-breakpoint
ALTER TABLE "ezil_app_folder_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_grants" (
	"user_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ezil_app_grants_pk" PRIMARY KEY("user_id","app_id")
);
--> statement-breakpoint
ALTER TABLE "ezil_app_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computer_id" uuid NOT NULL,
	"computer_provider" text DEFAULT 'aws-ec2' NOT NULL,
	"app_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"installed_by" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"auth_generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_at" timestamp with time zone,
	"uninstalled_at" timestamp with time zone,
	CONSTRAINT "ezil_app_installations_id_computer_uq" UNIQUE("id","computer_id"),
	CONSTRAINT "ezil_app_installations_provider_chk" CHECK (computer_provider = 'aws-ec2'),
	CONSTRAINT "ezil_app_installations_status_chk" CHECK (status in ('pending','installed','failed','uninstalled')),
	CONSTRAINT "ezil_app_installations_generation_chk" CHECK (auth_generation >= 1),
	CONSTRAINT "ezil_app_installations_uninstalled_chk" CHECK ((status = 'uninstalled') = (uninstalled_at is not null))
);
--> statement-breakpoint
ALTER TABLE "ezil_app_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid,
	"installation_id" uuid,
	"computer_id" uuid,
	"requested_by" uuid NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ezil_app_jobs_target_chk" CHECK (((operation in ('inspect','build') and submission_id is not null and installation_id is null and computer_id is null) or (operation in ('install','start','stop','update','uninstall') and submission_id is null and installation_id is not null and computer_id is not null))),
	CONSTRAINT "ezil_app_jobs_status_chk" CHECK (status in ('queued','running','succeeded','failed','cancelled')),
	CONSTRAINT "ezil_app_jobs_idempotency_chk" CHECK (length(idempotency_key) between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "ezil_app_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"event_type" text DEFAULT 'reconcile' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_app_outbox_job_event_uq" UNIQUE("job_id","event_type"),
	CONSTRAINT "ezil_app_outbox_event_chk" CHECK (event_type = 'reconcile'),
	CONSTRAINT "ezil_app_outbox_attempts_chk" CHECK (attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "ezil_app_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_port_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"service_name" text NOT NULL,
	"host_port" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "ezil_app_port_leases_port_chk" CHECK (host_port between 1024 and 65535)
);
--> statement-breakpoint
ALTER TABLE "ezil_app_port_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_publications" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"release_id" uuid NOT NULL,
	"published_by" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ezil_app_publications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_publishers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ezil_app_publishers_owner_uq" UNIQUE("owner_user_id"),
	CONSTRAINT "ezil_app_publishers_name_chk" CHECK (length(display_name) between 1 and 120),
	CONSTRAINT "ezil_app_publishers_status_chk" CHECK (status in ('invited','active','revoked'))
);
--> statement-breakpoint
ALTER TABLE "ezil_app_publishers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"manifest_digest" text NOT NULL,
	"policy_digest" text NOT NULL,
	"image_reference" text NOT NULL,
	"provenance_digest" text NOT NULL,
	"source_commit_sha" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_app_releases_app_version_uq" UNIQUE("app_id","version"),
	CONSTRAINT "ezil_app_releases_id_app_uq" UNIQUE("id","app_id"),
	CONSTRAINT "ezil_app_releases_version_chk" CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]*$' AND length(version) <= 64),
	CONSTRAINT "ezil_app_releases_manifest_version_chk" CHECK (coalesce(manifest->>'schemaVersion','') = '2' AND coalesce(policy->>'schemaVersion','') = '2'),
	CONSTRAINT "ezil_app_releases_digest_chk" CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$' AND policy_digest ~ '^sha256:[0-9a-f]{64}$' AND provenance_digest ~ '^sha256:[0-9a-f]{64}$' AND image_reference ~ '@sha256:[0-9a-f]{64}$'),
	CONSTRAINT "ezil_app_releases_source_pin_chk" CHECK (((coalesce(manifest #>> '{source,kind}','') = 'github') and source_commit_sha is not null and source_commit_sha ~ '^[0-9a-f]{40}$' and source_commit_sha = lower(coalesce(manifest #>> '{source,commitSha}',''))) or ((coalesce(manifest #>> '{source,kind}','') = 'oci') and source_commit_sha is null and image_reference = coalesce(manifest #>> '{source,image}',''))),
	CONSTRAINT "ezil_app_releases_policy_image_chk" CHECK (image_reference = coalesce(policy #>> '{image,reference}','')),
	CONSTRAINT "ezil_app_releases_status_chk" CHECK (status in ('draft','validated','approved','rejected','revoked')),
	CONSTRAINT "ezil_app_releases_approval_chk" CHECK ((status in ('draft','validated','rejected') and approved_by is null and approved_at is null and revoked_at is null) or (status = 'approved' and approved_by is not null and approved_at is not null and revoked_at is null) or (status = 'revoked' and approved_by is not null and approved_at is not null and revoked_at is not null))
);
--> statement-breakpoint
ALTER TABLE "ezil_app_releases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_services" (
	"installation_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"protocol" text DEFAULT 'http' NOT NULL,
	"scope" text NOT NULL,
	"internal_port" integer NOT NULL,
	"preferred_host_port" integer,
	"health_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_app_services_pk" PRIMARY KEY("installation_id","computer_id","name"),
	CONSTRAINT "ezil_app_services_name_chk" CHECK (name ~ '^[a-z][a-z0-9-]*$' AND length(name) <= 48),
	CONSTRAINT "ezil_app_services_protocol_chk" CHECK (protocol = 'http'),
	CONSTRAINT "ezil_app_services_scope_chk" CHECK (scope in ('installation','selected-project')),
	CONSTRAINT "ezil_app_services_ports_chk" CHECK (internal_port between 1024 and 65535 AND (preferred_host_port is null or preferred_host_port between 1024 and 65535)),
	CONSTRAINT "ezil_app_services_health_chk" CHECK (health_path like '/%' AND length(health_path) <= 256)
);
--> statement-breakpoint
ALTER TABLE "ezil_app_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_app_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submitted_by" uuid NOT NULL,
	"app_id" uuid,
	"repository_url" text NOT NULL,
	"requested_commit_sha" text,
	"resolved_commit_sha" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"inspection" jsonb,
	"error_code" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_app_submissions_idempotency_uq" UNIQUE("submitted_by","idempotency_key"),
	CONSTRAINT "ezil_app_submissions_url_chk" CHECK (length(repository_url) between 1 and 2048),
	CONSTRAINT "ezil_app_submissions_pin_chk" CHECK ((requested_commit_sha is null or requested_commit_sha ~ '^[0-9a-f]{40}$') AND (resolved_commit_sha is null or resolved_commit_sha ~ '^[0-9a-f]{40}$')),
	CONSTRAINT "ezil_app_submissions_status_chk" CHECK (status in ('queued','inspecting','needs-config','building','validated','rejected','cancelled')),
	CONSTRAINT "ezil_app_submissions_idempotency_chk" CHECK (length(idempotency_key) between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "ezil_app_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisher_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"category" text NOT NULL,
	"logo_asset_key" text,
	"visibility" text DEFAULT 'grant-only' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_apps_slug_uq" UNIQUE("slug"),
	CONSTRAINT "ezil_apps_slug_chk" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 64),
	CONSTRAINT "ezil_apps_name_chk" CHECK (length(name) between 1 and 80),
	CONSTRAINT "ezil_apps_summary_chk" CHECK (length(summary) between 1 and 500),
	CONSTRAINT "ezil_apps_category_chk" CHECK (length(category) between 1 and 60),
	CONSTRAINT "ezil_apps_visibility_chk" CHECK (visibility in ('grant-only','all-authenticated'))
);
--> statement-breakpoint
ALTER TABLE "ezil_apps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Drizzle emits this composite unique constraint after foreign keys. It must
-- exist first because installation and folder-grant owner FKs reference it.
ALTER TABLE "ezil_computers" ADD CONSTRAINT "ezil_computers_id_user_uq" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "ezil_app_admins" ADD CONSTRAINT "ezil_app_admins_user_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_admins" ADD CONSTRAINT "ezil_app_admins_granter_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_audit_events" ADD CONSTRAINT "ezil_app_audit_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_audit_events" ADD CONSTRAINT "ezil_app_audit_app_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."ezil_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_audit_events" ADD CONSTRAINT "ezil_app_audit_release_app_fkey" FOREIGN KEY ("release_id","app_id") REFERENCES "public"."ezil_app_releases"("id","app_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_audit_events" ADD CONSTRAINT "ezil_app_audit_submission_fkey" FOREIGN KEY ("submission_id") REFERENCES "public"."ezil_app_submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_audit_events" ADD CONSTRAINT "ezil_app_audit_installation_computer_fkey" FOREIGN KEY ("installation_id","computer_id") REFERENCES "public"."ezil_app_installations"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_folder_grants" ADD CONSTRAINT "ezil_app_folder_grants_installation_computer_fkey" FOREIGN KEY ("installation_id","computer_id") REFERENCES "public"."ezil_app_installations"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_folder_grants" ADD CONSTRAINT "ezil_app_folder_grants_granter_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_folder_grants" ADD CONSTRAINT "ezil_app_folder_grants_owner_fkey" FOREIGN KEY ("computer_id","granted_by") REFERENCES "public"."ezil_computers"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_grants" ADD CONSTRAINT "ezil_app_grants_user_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_grants" ADD CONSTRAINT "ezil_app_grants_app_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."ezil_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_grants" ADD CONSTRAINT "ezil_app_grants_admin_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."ezil_app_admins"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_installations" ADD CONSTRAINT "ezil_app_installations_computer_provider_fkey" FOREIGN KEY ("computer_id","computer_provider") REFERENCES "public"."ezil_computers"("id","provider") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_installations" ADD CONSTRAINT "ezil_app_installations_owner_fkey" FOREIGN KEY ("computer_id","installed_by") REFERENCES "public"."ezil_computers"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_installations" ADD CONSTRAINT "ezil_app_installations_release_app_fkey" FOREIGN KEY ("release_id","app_id") REFERENCES "public"."ezil_app_releases"("id","app_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_installations" ADD CONSTRAINT "ezil_app_installations_installer_fkey" FOREIGN KEY ("installed_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_jobs" ADD CONSTRAINT "ezil_app_jobs_submission_fkey" FOREIGN KEY ("submission_id") REFERENCES "public"."ezil_app_submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_jobs" ADD CONSTRAINT "ezil_app_jobs_installation_computer_fkey" FOREIGN KEY ("installation_id","computer_id") REFERENCES "public"."ezil_app_installations"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_jobs" ADD CONSTRAINT "ezil_app_jobs_requester_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_outbox" ADD CONSTRAINT "ezil_app_outbox_job_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ezil_app_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_port_leases" ADD CONSTRAINT "ezil_app_port_leases_service_fkey" FOREIGN KEY ("installation_id","computer_id","service_name") REFERENCES "public"."ezil_app_services"("installation_id","computer_id","name") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_publications" ADD CONSTRAINT "ezil_app_publications_app_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."ezil_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_publications" ADD CONSTRAINT "ezil_app_publications_release_app_fkey" FOREIGN KEY ("release_id","app_id") REFERENCES "public"."ezil_app_releases"("id","app_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_publications" ADD CONSTRAINT "ezil_app_publications_admin_fkey" FOREIGN KEY ("published_by") REFERENCES "public"."ezil_app_admins"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_publishers" ADD CONSTRAINT "ezil_app_publishers_owner_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_publishers" ADD CONSTRAINT "ezil_app_publishers_inviter_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."ezil_app_admins"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_releases" ADD CONSTRAINT "ezil_app_releases_app_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."ezil_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_releases" ADD CONSTRAINT "ezil_app_releases_approver_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."ezil_app_admins"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_services" ADD CONSTRAINT "ezil_app_services_installation_computer_fkey" FOREIGN KEY ("installation_id","computer_id") REFERENCES "public"."ezil_app_installations"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_submissions" ADD CONSTRAINT "ezil_app_submissions_submitter_fkey" FOREIGN KEY ("submitted_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_app_submissions" ADD CONSTRAINT "ezil_app_submissions_app_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."ezil_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_apps" ADD CONSTRAINT "ezil_apps_publisher_fkey" FOREIGN KEY ("publisher_id") REFERENCES "public"."ezil_app_publishers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_app_folder_grants_whole_uidx" ON "ezil_app_folder_grants" USING btree ("installation_id","folder") WHERE scope = 'whole-folder' and revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_app_folder_grants_project_uidx" ON "ezil_app_folder_grants" USING btree ("installation_id","folder","project_id") WHERE scope = 'selected-projects' and revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_app_installations_active_uidx" ON "ezil_app_installations" USING btree ("computer_id","app_id") WHERE uninstalled_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_app_jobs_submission_idempotency_uidx" ON "ezil_app_jobs" USING btree ("submission_id","idempotency_key") WHERE submission_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_app_jobs_installation_idempotency_uidx" ON "ezil_app_jobs" USING btree ("installation_id","idempotency_key") WHERE installation_id is not null;--> statement-breakpoint
CREATE INDEX "ezil_app_outbox_due_idx" ON "ezil_app_outbox" USING btree ("available_at") WHERE delivered_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_app_port_leases_computer_port_uidx" ON "ezil_app_port_leases" USING btree ("computer_id","host_port") WHERE released_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_app_port_leases_service_uidx" ON "ezil_app_port_leases" USING btree ("installation_id","service_name") WHERE released_at is null;--> statement-breakpoint

-- Release content is frozen, including the source pin and image/provenance.
-- Lifecycle status may advance; published releases cannot be revoked until
-- their current publication pointer is removed in the same transaction.
CREATE FUNCTION public.ezil_app_release_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'release must begin as draft' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'release deletion is forbidden' USING ERRCODE = '23514';
    END IF;
    IF ROW(OLD.id, OLD.app_id, OLD.version, OLD.manifest, OLD.policy,
           OLD.manifest_digest, OLD.policy_digest, OLD.image_reference,
           OLD.provenance_digest, OLD.source_commit_sha, OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.id, NEW.app_id, NEW.version, NEW.manifest, NEW.policy,
           NEW.manifest_digest, NEW.policy_digest, NEW.image_reference,
           NEW.provenance_digest, NEW.source_commit_sha, NEW.created_at) THEN
        RAISE EXCEPTION 'release content is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'draft' AND NEW.status IN ('validated','rejected')) OR
        (OLD.status = 'validated' AND NEW.status IN ('approved','rejected')) OR
        (OLD.status = 'approved' AND NEW.status = 'revoked')
    ) THEN
        RAISE EXCEPTION 'invalid release transition' USING ERRCODE = '23514';
    END IF;
    IF OLD.approved_by IS NOT NULL AND
       (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
        RAISE EXCEPTION 'release approver is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' AND OLD.status <> 'approved' AND NOT EXISTS (
        SELECT 1 FROM public.ezil_app_admins
        WHERE user_id = NEW.approved_by AND revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'approval requires an active administrator' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'revoked' AND EXISTS (
        SELECT 1 FROM public.ezil_app_publications WHERE release_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'unpublish before revocation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER ezil_app_release_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.ezil_app_releases
FOR EACH ROW EXECUTE FUNCTION public.ezil_app_release_guard();--> statement-breakpoint

CREATE FUNCTION public.ezil_app_publication_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.ezil_app_releases
        WHERE id = NEW.release_id AND app_id = NEW.app_id AND status = 'approved'
        FOR UPDATE
    ) THEN
        RAISE EXCEPTION 'publication requires an approved release' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.ezil_app_admins
        WHERE user_id = NEW.published_by AND revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'publication requires an active administrator' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER ezil_app_publication_guard_trg
BEFORE INSERT OR UPDATE ON public.ezil_app_publications
FOR EACH ROW EXECUTE FUNCTION public.ezil_app_publication_guard();--> statement-breakpoint

-- Retired leases remain historical records, and live host-port assignments
-- cannot silently change during stop/restart or an application update.
CREATE FUNCTION public.ezil_app_port_lease_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'port leases are retained' USING ERRCODE = '23514';
    END IF;
    IF ROW(OLD.id, OLD.installation_id, OLD.computer_id, OLD.service_name, OLD.host_port, OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.id, NEW.installation_id, NEW.computer_id, NEW.service_name, NEW.host_port, NEW.created_at)
       OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
        RAISE EXCEPTION 'port lease identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER ezil_app_port_lease_guard_trg
BEFORE UPDATE OR DELETE ON public.ezil_app_port_leases
FOR EACH ROW EXECUTE FUNCTION public.ezil_app_port_lease_guard();--> statement-breakpoint

CREATE FUNCTION public.ezil_app_installation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE validate_target boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'installation records are retained' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        validate_target := true;
        IF NEW.status <> 'pending' THEN
            RAISE EXCEPTION 'installation must begin pending' USING ERRCODE = '23514';
        END IF;
    ELSE
        validate_target := NEW.release_id IS DISTINCT FROM OLD.release_id;
        IF ROW(NEW.id, NEW.computer_id, NEW.computer_provider, NEW.app_id,
               NEW.installed_by, NEW.created_at)
           IS DISTINCT FROM
           ROW(OLD.id, OLD.computer_id, OLD.computer_provider, OLD.app_id,
               OLD.installed_by, OLD.created_at) THEN
            RAISE EXCEPTION 'installation ownership is immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.auth_generation < OLD.auth_generation OR
           (OLD.uninstalled_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
            RAISE EXCEPTION 'installation generation or retirement is immutable' USING ERRCODE = '23514';
        END IF;
        IF validate_target AND NEW.auth_generation <= OLD.auth_generation THEN
            RAISE EXCEPTION 'release update must advance authorization generation' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF validate_target THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.ezil_app_releases
            WHERE id = NEW.release_id AND app_id = NEW.app_id AND status = 'approved'
            FOR UPDATE
        ) THEN
            RAISE EXCEPTION 'installation requires an approved release' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.ezil_computers
            WHERE id = NEW.computer_id AND provider = 'aws-ec2' AND deleted_at IS NULL
            FOR UPDATE
        ) THEN
            RAISE EXCEPTION 'installation requires an active AWS computer' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER ezil_app_installation_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.ezil_app_installations
FOR EACH ROW EXECUTE FUNCTION public.ezil_app_installation_guard();--> statement-breakpoint

CREATE FUNCTION public.ezil_app_audit_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
CREATE TRIGGER ezil_app_audit_append_only_trg
BEFORE UPDATE OR DELETE ON public.ezil_app_audit_events
FOR EACH ROW EXECUTE FUNCTION public.ezil_app_audit_append_only();--> statement-breakpoint

-- Direct Supabase/PostgREST access is denied to authenticated users. The
-- server's privileged connection must still perform role/owner checks.
CREATE POLICY "Service role full access app admins" ON "ezil_app_admins" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app publishers" ON "ezil_app_publishers" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access apps" ON "ezil_apps" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app releases" ON "ezil_app_releases" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app publications" ON "ezil_app_publications" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app grants" ON "ezil_app_grants" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app submissions" ON "ezil_app_submissions" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app installations" ON "ezil_app_installations" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app services" ON "ezil_app_services" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app port leases" ON "ezil_app_port_leases" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app folder grants" ON "ezil_app_folder_grants" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app jobs" ON "ezil_app_jobs" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app outbox" ON "ezil_app_outbox" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access app audit" ON "ezil_app_audit_events" FOR ALL USING (auth.role() = 'service_role');
