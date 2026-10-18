-- Billing v2: additive tables and grant CHECK widening only.
-- Service-role policies and consent guards reuse the migration 0003 patterns.
CREATE TABLE "ezil_billing_compute_epochs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"subscription_id" text,
	"size" text NOT NULL,
	"weight" integer NOT NULL,
	"ready_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"overhead_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_billing_compute_epochs_size_chk" CHECK ("ezil_billing_compute_epochs"."size" in ('free-cf', 'std-2', 'cmp-4', 'cmp-8')),
	CONSTRAINT "ezil_billing_compute_epochs_weight_chk" CHECK (("ezil_billing_compute_epochs"."size" in ('free-cf', 'std-2') and "ezil_billing_compute_epochs"."weight" = 1) or ("ezil_billing_compute_epochs"."size" = 'cmp-4' and "ezil_billing_compute_epochs"."weight" = 2) or ("ezil_billing_compute_epochs"."size" = 'cmp-8' and "ezil_billing_compute_epochs"."weight" = 4)),
	CONSTRAINT "ezil_billing_compute_epochs_end_reason_chk" CHECK ("ezil_billing_compute_epochs"."end_reason" is null or "ezil_billing_compute_epochs"."end_reason" in ('user_stop', 'idle_sleep', 'session_max', 'allowance_exhausted', 'overage_cap', 'payment_issue', 'resize', 'provider_stop', 'platform_failure')),
	CONSTRAINT "ezil_billing_compute_epochs_end_pair_chk" CHECK (("ezil_billing_compute_epochs"."ended_at" is null) = ("ezil_billing_compute_epochs"."end_reason" is null)),
	CONSTRAINT "ezil_billing_compute_epochs_ended_at_chk" CHECK ("ezil_billing_compute_epochs"."ended_at" is null or "ezil_billing_compute_epochs"."ended_at" >= "ezil_billing_compute_epochs"."ready_at"),
	CONSTRAINT "ezil_billing_compute_epochs_overhead_seconds_chk" CHECK ("ezil_billing_compute_epochs"."overhead_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_compute_epochs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_overage_consents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ezil_billing_overage_consents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"cap_cents" integer NOT NULL,
	"terms_version" text NOT NULL,
	"catalog_version" integer NOT NULL,
	"rate_cents_per_std_hour" integer NOT NULL,
	"actor" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ezil_billing_overage_consents_decision_unique" UNIQUE("user_id","subscription_id","accepted_at","enabled","cap_cents","terms_version","catalog_version","rate_cents_per_std_hour","actor"),
	CONSTRAINT "ezil_billing_overage_consents_cap_cents_chk" CHECK ("ezil_billing_overage_consents"."cap_cents" between 0 and 10000),
	CONSTRAINT "ezil_billing_overage_consents_rate_chk" CHECK ("ezil_billing_overage_consents"."rate_cents_per_std_hour" > 0)
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_overage_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_overage_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"rating_version" integer NOT NULL,
	"std_seconds_over" bigint NOT NULL,
	"cents" integer NOT NULL,
	"stripe_invoice_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_billing_overage_invoices_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id"),
	CONSTRAINT "ezil_billing_overage_invoices_period_rating_unique" UNIQUE("subscription_id","period_start","rating_version"),
	CONSTRAINT "ezil_billing_overage_invoices_std_seconds_over_chk" CHECK ("ezil_billing_overage_invoices"."std_seconds_over" >= 0),
	CONSTRAINT "ezil_billing_overage_invoices_cents_chk" CHECK ("ezil_billing_overage_invoices"."cents" >= 0),
	CONSTRAINT "ezil_billing_overage_invoices_status_chk" CHECK ("ezil_billing_overage_invoices"."status" in ('pending', 'open', 'paid', 'payment_failed', 'requires_action', 'void', 'uncollectible'))
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_overage_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_payment_issues" (
	"stripe_invoice_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" text,
	"invoice_kind" text NOT NULL,
	"issue" text NOT NULL,
	"hosted_invoice_url" text,
	"stripe_event_created" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_billing_payment_issues_invoice_kind_chk" CHECK ("ezil_billing_payment_issues"."invoice_kind" in ('subscription', 'upgrade', 'overage')),
	CONSTRAINT "ezil_billing_payment_issues_issue_chk" CHECK ("ezil_billing_payment_issues"."issue" in ('payment_failed', 'requires_action', 'voided', 'uncollectible'))
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_payment_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_plan_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_sku" text NOT NULL,
	"to_sku" text,
	"stripe_invoice_id" text,
	"stripe_schedule_id" text,
	"hosted_invoice_url" text,
	"state" text NOT NULL,
	"effective_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_billing_plan_changes_kind_chk" CHECK ("ezil_billing_plan_changes"."kind" in ('upgrade', 'downgrade', 'cancel')),
	CONSTRAINT "ezil_billing_plan_changes_state_chk" CHECK ("ezil_billing_plan_changes"."state" in ('pending', 'requires_action', 'payment_failed', 'scheduled', 'applied', 'expired', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_plan_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ezil_billing_size_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"size" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_billing_size_preferences_size_chk" CHECK ("ezil_billing_size_preferences"."size" in ('free-cf', 'std-2', 'cmp-4', 'cmp-8'))
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_size_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_billing_grants" DROP CONSTRAINT "ezil_billing_grants_meter_chk";--> statement-breakpoint
ALTER TABLE "ezil_billing_grants" DROP CONSTRAINT "ezil_billing_grants_kind_chk";--> statement-breakpoint
ALTER TABLE "ezil_billing_grants" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "ezil_billing_compute_epochs" ADD CONSTRAINT "ezil_billing_compute_epochs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_compute_epochs" ADD CONSTRAINT "ezil_billing_compute_epochs_computer_id_fkey" FOREIGN KEY ("computer_id") REFERENCES "public"."ezil_computers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_overage_consents" ADD CONSTRAINT "ezil_billing_overage_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_overage_invoices" ADD CONSTRAINT "ezil_billing_overage_invoices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_payment_issues" ADD CONSTRAINT "ezil_billing_payment_issues_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_plan_changes" ADD CONSTRAINT "ezil_billing_plan_changes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_billing_size_preferences" ADD CONSTRAINT "ezil_billing_size_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_billing_compute_epochs_open_computer_uidx" ON "ezil_billing_compute_epochs" USING btree ("computer_id") WHERE "ezil_billing_compute_epochs"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_billing_plan_changes_open_kind_uidx" ON "ezil_billing_plan_changes" USING btree ("subscription_id","kind") WHERE "ezil_billing_plan_changes"."state" in ('pending', 'requires_action', 'payment_failed', 'scheduled');--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_billing_grants_plan_period_uidx" ON "ezil_billing_grants" USING btree ("subscription_id","period_start","meter") WHERE "ezil_billing_grants"."kind" = 'plan_period';--> statement-breakpoint
ALTER TABLE "ezil_billing_grants" ADD CONSTRAINT "ezil_billing_grants_meter_chk" CHECK ("ezil_billing_grants"."meter" in ('workspace_seconds', 'ai_usd_micro', 'compute_std_seconds'));--> statement-breakpoint
ALTER TABLE "ezil_billing_grants" ADD CONSTRAINT "ezil_billing_grants_kind_chk" CHECK ("ezil_billing_grants"."kind" in ('pro_period', 'topup', 'revoke', 'suspend', 'restore', 'plan_period', 'upgrade_prorated'));
--> statement-breakpoint
CREATE POLICY "Service role full access billing compute epochs"
    ON "ezil_billing_compute_epochs" FOR ALL USING (auth.role() = 'service_role');

--> statement-breakpoint
CREATE POLICY "Service role full access billing overage consents"
    ON "ezil_billing_overage_consents" FOR ALL USING (auth.role() = 'service_role');

--> statement-breakpoint
CREATE POLICY "Service role full access billing overage invoices"
    ON "ezil_billing_overage_invoices" FOR ALL USING (auth.role() = 'service_role');

--> statement-breakpoint
CREATE POLICY "Service role full access billing payment issues"
    ON "ezil_billing_payment_issues" FOR ALL USING (auth.role() = 'service_role');

--> statement-breakpoint
CREATE POLICY "Service role full access billing plan changes"
    ON "ezil_billing_plan_changes" FOR ALL USING (auth.role() = 'service_role');

--> statement-breakpoint
CREATE POLICY "Service role full access billing size preferences"
    ON "ezil_billing_size_preferences" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE TRIGGER "ezil_billing_overage_consents_refuse_update_delete"
    BEFORE UPDATE OR DELETE ON "ezil_billing_overage_consents"
    FOR EACH ROW EXECUTE FUNCTION "public"."ezil_billing_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ezil_billing_overage_consents_refuse_truncate"
    BEFORE TRUNCATE ON "ezil_billing_overage_consents"
    FOR EACH STATEMENT EXECUTE FUNCTION "public"."ezil_billing_refuse_mutation"();
