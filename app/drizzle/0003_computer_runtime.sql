CREATE TABLE "ezil_computer_instances" (
	"computer_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"provider_instance_id" text,
	"fence_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"observed_state" text DEFAULT 'pending' NOT NULL,
	"observed_at" timestamp with time zone,
	"fenced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_computer_instances_pk" PRIMARY KEY("computer_id","generation"),
	CONSTRAINT "ezil_computer_instances_provider_id_uq" UNIQUE("provider_instance_id"),
	CONSTRAINT "ezil_computer_instances_generation_chk" CHECK ("ezil_computer_instances"."generation" >= 1),
	CONSTRAINT "ezil_computer_instances_state_chk" CHECK ("ezil_computer_instances"."observed_state" in ('pending', 'starting', 'running', 'stopping', 'stopped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_computer_lifecycle_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computer_id" uuid NOT NULL,
	"requested_by" uuid,
	"operation" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"target_generation" integer,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ezil_computer_lifecycle_jobs_computer_idempotency_uq" UNIQUE("computer_id","idempotency_key"),
	CONSTRAINT "ezil_computer_lifecycle_jobs_id_computer_uq" UNIQUE("id","computer_id"),
	CONSTRAINT "ezil_computer_lifecycle_jobs_operation_chk" CHECK ("ezil_computer_lifecycle_jobs"."operation" in ('provision', 'start', 'stop', 'replace', 'retire', 'migrate')),
	CONSTRAINT "ezil_computer_lifecycle_jobs_status_chk" CHECK ("ezil_computer_lifecycle_jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ezil_computer_lifecycle_jobs_generation_chk" CHECK ("ezil_computer_lifecycle_jobs"."target_generation" is null or "ezil_computer_lifecycle_jobs"."target_generation" >= 1),
	CONSTRAINT "ezil_computer_lifecycle_jobs_idempotency_chk" CHECK (length("ezil_computer_lifecycle_jobs"."idempotency_key") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_computer_lifecycle_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"event_type" text DEFAULT 'reconcile' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_computer_lifecycle_outbox_job_event_uq" UNIQUE("job_id","event_type"),
	CONSTRAINT "ezil_computer_lifecycle_outbox_event_chk" CHECK ("ezil_computer_lifecycle_outbox"."event_type" = 'reconcile'),
	CONSTRAINT "ezil_computer_lifecycle_outbox_attempts_chk" CHECK ("ezil_computer_lifecycle_outbox"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_computer_runtimes" (
	"computer_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'aws-ec2' NOT NULL,
	"region" text NOT NULL,
	"availability_zone" text,
	"data_volume_id" text,
	"next_generation" integer DEFAULT 1 NOT NULL,
	"desired_state" text DEFAULT 'stopped' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_computer_runtimes_volume_uq" UNIQUE("data_volume_id"),
	CONSTRAINT "ezil_computer_runtimes_provider_chk" CHECK ("ezil_computer_runtimes"."provider" = 'aws-ec2'),
	CONSTRAINT "ezil_computer_runtimes_generation_chk" CHECK ("ezil_computer_runtimes"."next_generation" >= 1),
	CONSTRAINT "ezil_computer_runtimes_state_chk" CHECK ("ezil_computer_runtimes"."desired_state" in ('stopped', 'running', 'retired')),
	CONSTRAINT "ezil_computer_runtimes_volume_az_chk" CHECK (("ezil_computer_runtimes"."data_volume_id" is null) = ("ezil_computer_runtimes"."availability_zone" is null))
);
--> statement-breakpoint
ALTER TABLE "ezil_computer_runtimes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_computers" ADD COLUMN "provider" text DEFAULT 'cloudflare' NOT NULL;--> statement-breakpoint
ALTER TABLE "ezil_computers" ADD CONSTRAINT "ezil_computers_id_provider_uq" UNIQUE("id","provider");--> statement-breakpoint
ALTER TABLE "ezil_computers" ADD CONSTRAINT "ezil_computers_provider_chk" CHECK ("ezil_computers"."provider" in ('cloudflare', 'aws-ec2'));--> statement-breakpoint
ALTER TABLE "ezil_computer_instances" ADD CONSTRAINT "ezil_computer_instances_runtime_fkey" FOREIGN KEY ("computer_id") REFERENCES "public"."ezil_computer_runtimes"("computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_jobs" ADD CONSTRAINT "ezil_computer_lifecycle_jobs_computer_fkey" FOREIGN KEY ("computer_id") REFERENCES "public"."ezil_computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_jobs" ADD CONSTRAINT "ezil_computer_lifecycle_jobs_requester_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_lifecycle_outbox" ADD CONSTRAINT "ezil_computer_lifecycle_outbox_job_computer_fkey" FOREIGN KEY ("job_id","computer_id") REFERENCES "public"."ezil_computer_lifecycle_jobs"("id","computer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ezil_computer_runtimes" ADD CONSTRAINT "ezil_computer_runtimes_computer_provider_fkey" FOREIGN KEY ("computer_id","provider") REFERENCES "public"."ezil_computers"("id","provider") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_computer_instances_single_writer_uidx" ON "ezil_computer_instances" USING btree ("computer_id") WHERE "ezil_computer_instances"."fenced_at" is null;--> statement-breakpoint
CREATE INDEX "ezil_computer_lifecycle_outbox_due_idx" ON "ezil_computer_lifecycle_outbox" USING btree ("available_at") WHERE "ezil_computer_lifecycle_outbox"."delivered_at" is null;--> statement-breakpoint

-- Existing direct PostgREST grants must not let an authenticated user choose
-- AWS for themselves. The app's privileged server connection creates AWS
-- records only after its own authorization and admission checks. Cloudflare
-- rows retain the prior direct-user insert/update behavior.
ALTER POLICY "Users can insert own computers" ON "ezil_computers"
    WITH CHECK (user_id = auth.uid() AND provider = 'cloudflare');
--> statement-breakpoint
ALTER POLICY "Users can update own computers" ON "ezil_computers"
    USING (user_id = auth.uid() AND provider = 'cloudflare')
    WITH CHECK (user_id = auth.uid() AND provider = 'cloudflare');
--> statement-breakpoint

-- RLS is service-only for all runtime/control records. The privileged API
-- still checks ownership independently; RLS is defense in depth against
-- direct client access through Supabase.
CREATE POLICY "Service role full access computer runtimes" ON "ezil_computer_runtimes"
    FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access computer instances" ON "ezil_computer_instances"
    FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access computer lifecycle jobs" ON "ezil_computer_lifecycle_jobs"
    FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access computer lifecycle outbox" ON "ezil_computer_lifecycle_outbox"
    FOR ALL USING (auth.role() = 'service_role');
