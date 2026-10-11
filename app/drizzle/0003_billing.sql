-- ADDITIVE ONLY. The shared public schema contains tables owned by other
-- applications. This migration creates only the seven billing tables and
-- their guards; existing tables are referenced by FKs, never altered.
-- Generated DDL is followed by hand-written RLS policies and append-only
-- triggers, which drizzle-kit does not represent in its schema snapshot.
CREATE TABLE "ezil_billing_customers" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_billing_customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"livemode" boolean NOT NULL,
	"payload_sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"meter" text NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_billing_grants_source_meter_kind_unique" UNIQUE("source_type","source_id","meter","kind"),
	CONSTRAINT "ezil_billing_grants_meter_chk" CHECK ("ezil_billing_grants"."meter" in ('workspace_seconds', 'ai_usd_micro')),
	CONSTRAINT "ezil_billing_grants_kind_chk" CHECK ("ezil_billing_grants"."kind" in ('pro_period', 'topup', 'revoke', 'suspend', 'restore')),
	CONSTRAINT "ezil_billing_grants_source_type_chk" CHECK ("ezil_billing_grants"."source_type" in ('invoice', 'payment_intent', 'refund', 'dispute'))
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "ezil_billing_outbox_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_storage_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"bytes" bigint NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "ezil_billing_storage_samples_bytes_chk" CHECK ("ezil_billing_storage_samples"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_storage_samples" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_subscriptions" (
	"stripe_subscription_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"sku" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"stripe_event_created" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_usage_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"close_reason" text,
	"source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_usage_intervals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_billing_customers" ADD CONSTRAINT "ezil_billing_customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_events" ADD CONSTRAINT "ezil_billing_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_grants" ADD CONSTRAINT "ezil_billing_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_outbox" ADD CONSTRAINT "ezil_billing_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_storage_samples" ADD CONSTRAINT "ezil_billing_storage_samples_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_subscriptions" ADD CONSTRAINT "ezil_billing_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_usage_intervals" ADD CONSTRAINT "ezil_billing_usage_intervals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_usage_intervals" ADD CONSTRAINT "ezil_billing_usage_intervals_computer_id_fkey" FOREIGN KEY ("computer_id") REFERENCES "public"."ezil_computers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_billing_usage_intervals_open_computer_uidx" ON "ezil_billing_usage_intervals" USING btree ("computer_id") WHERE "ezil_billing_usage_intervals"."ended_at" is null;

--> statement-breakpoint

-- RLS is hand-written, following 0002_os_access.sql. Billing state is only
-- accessible through the server; no authenticated or anonymous client policy
-- admits direct reads or writes through the shared database API.
CREATE POLICY "Service role full access billing customers"
    ON "ezil_billing_customers" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access billing events"
    ON "ezil_billing_events" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access billing grants"
    ON "ezil_billing_grants" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access billing outbox"
    ON "ezil_billing_outbox" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access billing storage samples"
    ON "ezil_billing_storage_samples" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access billing subscriptions"
    ON "ezil_billing_subscriptions" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access billing usage intervals"
    ON "ezil_billing_usage_intervals" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint

-- Corrections must be new rows so the funding and storage history survives.
-- Row triggers cover UPDATE/DELETE; TRUNCATE needs its own statement trigger.
-- These guards also refuse cascaded mutations from the required user FKs.
CREATE FUNCTION "public"."ezil_billing_refuse_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- The one deletion allowed: the ON DELETE CASCADE from "auth"."users"
    -- when an account is deleted. By the time the cascade reaches this row
    -- its owner is already gone, so a row whose user still exists can never
    -- be deleted, and nothing else can be updated or truncated.
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM "auth"."users" WHERE "id" = OLD."user_id"
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ezil_billing_grants_refuse_update_delete"
    BEFORE UPDATE OR DELETE ON "ezil_billing_grants"
    FOR EACH ROW EXECUTE FUNCTION "public"."ezil_billing_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ezil_billing_grants_refuse_truncate"
    BEFORE TRUNCATE ON "ezil_billing_grants"
    FOR EACH STATEMENT EXECUTE FUNCTION "public"."ezil_billing_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ezil_billing_storage_samples_refuse_update_delete"
    BEFORE UPDATE OR DELETE ON "ezil_billing_storage_samples"
    FOR EACH ROW EXECUTE FUNCTION "public"."ezil_billing_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ezil_billing_storage_samples_refuse_truncate"
    BEFORE TRUNCATE ON "ezil_billing_storage_samples"
    FOR EACH STATEMENT EXECUTE FUNCTION "public"."ezil_billing_refuse_mutation"();
