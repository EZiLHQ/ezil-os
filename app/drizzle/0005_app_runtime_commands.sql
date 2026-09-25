
ALTER TABLE "ezil_app_installations" ADD CONSTRAINT "ezil_app_installations_id_computer_app_uq" UNIQUE("id","computer_id","app_id");--> statement-breakpoint

ALTER TABLE "ezil_app_jobs" ADD CONSTRAINT "ezil_app_jobs_command_target_uq" UNIQUE("id","installation_id","computer_id","operation");--> statement-breakpoint
CREATE TABLE "ezil_app_runtime_commands" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"installation_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"computer_generation" integer NOT NULL,
	"generation" integer NOT NULL,
	"auth_generation" integer NOT NULL,
	"operation" text NOT NULL,
	"outbox_event" text DEFAULT 'reconcile' NOT NULL,
	"plan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_app_runtime_commands_revision_uq" UNIQUE("installation_id","generation"),
	CONSTRAINT "ezil_app_runtime_commands_job_installation_uq" UNIQUE("job_id","installation_id"),
	CONSTRAINT "ezil_app_runtime_commands_generation_chk" CHECK (generation >= 1 AND computer_generation >= 1 AND auth_generation >= 1),
	CONSTRAINT "ezil_app_runtime_commands_operation_chk" CHECK (operation in ('start','stop') AND outbox_event = 'reconcile'),
	CONSTRAINT "ezil_app_runtime_commands_plan_chk" CHECK (jsonb_typeof(plan) = 'object' AND octet_length(plan::text) <= 49152 AND coalesce(plan->>'releaseId','') = release_id::text AND coalesce(plan->>'policyDigest','') ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint

ALTER TABLE "ezil_app_runtime_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "ezil_app_runtime_requests" (
	"installation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_app_runtime_requests_pk" PRIMARY KEY("installation_id","request_id")
);
--> statement-breakpoint

ALTER TABLE "ezil_app_runtime_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "ezil_app_runtime_commands" ADD CONSTRAINT "ezil_app_runtime_commands_installation_fkey" FOREIGN KEY ("installation_id","computer_id","app_id") REFERENCES "public"."ezil_app_installations"("id","computer_id","app_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "ezil_app_runtime_commands" ADD CONSTRAINT "ezil_app_runtime_commands_release_fkey" FOREIGN KEY ("release_id","app_id") REFERENCES "public"."ezil_app_releases"("id","app_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "ezil_app_runtime_commands" ADD CONSTRAINT "ezil_app_runtime_commands_writer_fkey" FOREIGN KEY ("computer_id","computer_generation") REFERENCES "public"."ezil_computer_instances"("computer_id","generation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "ezil_app_runtime_commands" ADD CONSTRAINT "ezil_app_runtime_commands_job_fkey" FOREIGN KEY ("job_id","installation_id","computer_id","operation") REFERENCES "public"."ezil_app_jobs"("id","installation_id","computer_id","operation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "ezil_app_runtime_commands" ADD CONSTRAINT "ezil_app_runtime_commands_outbox_fkey" FOREIGN KEY ("job_id","outbox_event") REFERENCES "public"."ezil_app_outbox"("job_id","event_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "ezil_app_runtime_requests" ADD CONSTRAINT "ezil_app_runtime_requests_command_fkey" FOREIGN KEY ("job_id","installation_id") REFERENCES "public"."ezil_app_runtime_commands"("job_id","installation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "ezil_app_runtime_requests" ADD CONSTRAINT "ezil_app_runtime_requests_requester_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Drizzle metadata captures tables/constraints; these trigger invariants are
-- intentionally maintained in SQL. No existing rows are rewritten.
CREATE FUNCTION public.ezil_app_runtime_command_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE expected_revision bigint;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'runtime commands are immutable' USING ERRCODE = '23514';
    END IF;
    -- Same lock order as the producer: computer, then installation. The
    -- installation lock also serializes privileged writers outside the API.
    PERFORM 1 FROM public.ezil_computers WHERE id = NEW.computer_id FOR UPDATE;
    PERFORM 1 FROM public.ezil_app_installations
        WHERE id = NEW.installation_id AND computer_id = NEW.computer_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'runtime command installation mismatch' USING ERRCODE = '23503';
    END IF;
    SELECT coalesce(max(generation)::bigint, 0) + 1 INTO expected_revision
        FROM public.ezil_app_runtime_commands WHERE installation_id = NEW.installation_id;
    IF NEW.generation <> expected_revision THEN
        RAISE EXCEPTION 'runtime command revision conflict' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_app_runtime_command_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.ezil_app_runtime_commands
FOR EACH ROW EXECUTE FUNCTION public.ezil_app_runtime_command_guard();
--> statement-breakpoint
CREATE TRIGGER ezil_app_runtime_command_no_truncate_trg
BEFORE TRUNCATE ON public.ezil_app_runtime_commands
FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_app_runtime_command_guard();
--> statement-breakpoint
-- A new start/stop job cannot commit before its immutable intent exists.
-- Install/build/inspection producers remain compatible. Producers insert the
-- job, then its outbox event, then the command, all in the same transaction.
CREATE FUNCTION public.ezil_app_runtime_job_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.ezil_app_jobs WHERE id = NEW.id AND operation IN ('start','stop'))
        AND NOT EXISTS (SELECT 1 FROM public.ezil_app_runtime_commands WHERE job_id = NEW.id) THEN
        RAISE EXCEPTION 'runtime job requires a committed command' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ezil_app_runtime_job_complete_trg
AFTER INSERT OR UPDATE OF operation, installation_id, computer_id ON public.ezil_app_jobs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.ezil_app_runtime_job_complete();
--> statement-breakpoint
CREATE POLICY "Service role full access runtime commands" ON public.ezil_app_runtime_commands
FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
--> statement-breakpoint
CREATE TRIGGER ezil_app_runtime_request_immutable_trg
BEFORE UPDATE OR DELETE ON public.ezil_app_runtime_requests
FOR EACH ROW EXECUTE FUNCTION public.ezil_app_runtime_command_guard();
--> statement-breakpoint
CREATE TRIGGER ezil_app_runtime_request_no_truncate_trg
BEFORE TRUNCATE ON public.ezil_app_runtime_requests
FOR EACH STATEMENT EXECUTE FUNCTION public.ezil_app_runtime_command_guard();
--> statement-breakpoint
CREATE POLICY "Service role full access runtime requests" ON public.ezil_app_runtime_requests
FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
