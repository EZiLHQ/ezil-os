CREATE TABLE "ezil_error_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"event_class" varchar(32) NOT NULL,
	"source" varchar(16) NOT NULL,
	"fingerprint" char(19) NOT NULL,
	"user_hash" char(10) NOT NULL,
	"site" varchar(96) NOT NULL,
	"code" varchar(64) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"detail" varchar(200),
	"duration_ms" integer,
	"correlation_id" varchar(64),
	"computer_id" uuid,
	"attrs" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_error_events_fingerprint_chk" CHECK ("ezil_error_events"."fingerprint" ~ '^fp_[0-9a-f]{16}$'),
	CONSTRAINT "ezil_error_events_user_hash_chk" CHECK ("ezil_error_events"."user_hash" ~ '^u_[0-9a-f]{8}$'),
	CONSTRAINT "ezil_error_events_outcome_chk" CHECK ("ezil_error_events"."outcome" in ('ok','error','skipped'))
);
--> statement-breakpoint
ALTER TABLE "ezil_error_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_error_fingerprints" (
	"fingerprint" char(19) PRIMARY KEY NOT NULL,
	"event_class" varchar(32) NOT NULL,
	"source" varchar(16) NOT NULL,
	"site" varchar(96) NOT NULL,
	"code" varchar(64) NOT NULL,
	"normalized_detail" varchar(120),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_count" bigint DEFAULT 0 NOT NULL,
	"muted_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "ezil_error_fingerprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_error_user_hours" (
	"fingerprint" char(19) NOT NULL,
	"hour_bucket" timestamp with time zone NOT NULL,
	"user_hash" char(10) NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ezil_error_user_hours_pkey" PRIMARY KEY("fingerprint","hour_bucket","user_hash")
);
--> statement-breakpoint
ALTER TABLE "ezil_error_user_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_error_events" ADD CONSTRAINT "ezil_error_events_computer_id_fkey" FOREIGN KEY ("computer_id") REFERENCES "public"."ezil_computers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_error_user_hours" ADD CONSTRAINT "ezil_error_user_hours_fingerprint_fkey" FOREIGN KEY ("fingerprint") REFERENCES "public"."ezil_error_fingerprints"("fingerprint") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "idx_ezil_error_events_fp_time_user" ON "ezil_error_events" USING btree ("fingerprint","received_at","user_hash");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_events_class_time" ON "ezil_error_events" USING btree ("event_class","received_at");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_events_time" ON "ezil_error_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_events_user_time" ON "ezil_error_events" USING btree ("user_hash","received_at");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_fingerprints_last_seen" ON "ezil_error_fingerprints" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_fingerprints_class" ON "ezil_error_fingerprints" USING btree ("event_class","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_user_hours_hour" ON "ezil_error_user_hours" USING btree ("hour_bucket");--> statement-breakpoint

-- ── RLS (hand-written; drizzle-kit does not emit policies — same pattern as
-- 0000_massive_mole_man.sql's own hand-appended policy block) ─────────────
--
-- These three tables are SERVICE-ROLE ONLY. There is deliberately no policy
-- for `authenticated`: a user must not read other users' error rows, and has
-- no product reason to read their own. With RLS enabled and no matching
-- policy, every non-service-role SELECT/INSERT/UPDATE/DELETE returns nothing
-- or is rejected — the safe default, chosen on purpose rather than by
-- omission. If a "your crash reports" UI is ever built, it needs a new,
-- explicitly reviewed SELECT policy keyed on user_hash.
CREATE POLICY "Service role full access error events"
    ON "ezil_error_events" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access error fingerprints"
    ON "ezil_error_fingerprints" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access error user hours"
    ON "ezil_error_user_hours" FOR ALL USING (auth.role() = 'service_role');