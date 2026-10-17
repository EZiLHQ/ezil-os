-- Additive ready-pool schema (C2). Pool targets and capacity default to zero.
CREATE TABLE "ezil_pool_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shape" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"leased_at" timestamp with time zone,
	"lease_id" uuid,
	"leased_to_user_id" uuid,
	"leased_computer_id" uuid,
	"last_error" text,
	CONSTRAINT "ezil_pool_slots_sandbox_id_unique" UNIQUE("sandbox_id"),
	CONSTRAINT "ezil_pool_slots_lease_id_unique" UNIQUE("lease_id"),
	CONSTRAINT "ezil_pool_slots_state_check" CHECK ("ezil_pool_slots"."state" in ('warming','ready','leased','draining','destroyed')),
	CONSTRAINT "ezil_pool_slots_shape_check" CHECK ("ezil_pool_slots"."shape" in ('standard','performance'))
);

--> statement-breakpoint
ALTER TABLE "ezil_pool_slots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_pool_slots_live_user_idx" ON "ezil_pool_slots" USING btree ("leased_to_user_id") WHERE "ezil_pool_slots"."state" = 'leased';
--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_pool_slots_live_computer_idx" ON "ezil_pool_slots" USING btree ("leased_computer_id") WHERE "ezil_pool_slots"."state" = 'leased';
--> statement-breakpoint
CREATE INDEX "ezil_pool_slots_ready_idx" ON "ezil_pool_slots" USING btree ("shape","ready_at") WHERE "ezil_pool_slots"."state" = 'ready';
--> statement-breakpoint
CREATE POLICY "Service role full access pool slots"
    ON "ezil_pool_slots" FOR ALL USING (auth.role() = 'service_role');
