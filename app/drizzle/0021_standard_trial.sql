-- Standard one-calendar-month trial (request standard-trial-01b28d18-20261105-v1). Additive and staging-only.
-- Apply after 0020 and before the trial application. An app rollback keeps this schema: older builds never
-- read the new table or columns, and the widened CHECKs only admit two new values.
--
-- One trial per verified person: the account (user_id), its sign-in subject and its normalized verified
-- email are each unique. A row is claimed when the server quotes the trial end it will disclose, and it is
-- never released to another account (an abandoned checkout keeps the claim for the same account only).
-- Deleting an account keeps its row as a tombstone (user_id set null), so a trial that started still claims
-- its subject and email when the person signs up again; only a never-started quote may then be reclaimed.
CREATE TABLE "ezil_billing_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"auth_subject" text NOT NULL,
	"email_normalized" text NOT NULL,
	"sku" text NOT NULL,
	"policy_version" integer NOT NULL,
	"status" text DEFAULT 'quoted' NOT NULL,
	"quoted_at" timestamp with time zone NOT NULL,
	"trial_end" timestamp with time zone NOT NULL,
	"checkout_session_id" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"trial_start" timestamp with time zone,
	"return_origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_billing_trials_user_unique" UNIQUE("user_id"),
	CONSTRAINT "ezil_billing_trials_subject_unique" UNIQUE("auth_subject"),
	CONSTRAINT "ezil_billing_trials_email_unique" UNIQUE("email_normalized"),
	CONSTRAINT "ezil_billing_trials_checkout_unique" UNIQUE("checkout_session_id"),
	CONSTRAINT "ezil_billing_trials_subscription_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "ezil_billing_trials_sku_chk" CHECK ("ezil_billing_trials"."sku" = 'standard_monthly_v3'),
	CONSTRAINT "ezil_billing_trials_policy_chk" CHECK ("ezil_billing_trials"."policy_version" >= 1),
	CONSTRAINT "ezil_billing_trials_status_chk" CHECK ("ezil_billing_trials"."status" in ('quoted', 'checkout', 'trialing', 'converted', 'canceled', 'ended', 'payment_failed')),
	CONSTRAINT "ezil_billing_trials_bound_chk" CHECK (("ezil_billing_trials"."stripe_subscription_id" is null) = ("ezil_billing_trials"."status" in ('quoted', 'checkout'))),
	CONSTRAINT "ezil_billing_trials_email_chk" CHECK ("ezil_billing_trials"."email_normalized" = lower("ezil_billing_trials"."email_normalized") and position('@' in "ezil_billing_trials"."email_normalized") > 1),
	CONSTRAINT "ezil_billing_trials_subject_chk" CHECK (length("ezil_billing_trials"."auth_subject") between 1 and 255),
	CONSTRAINT "ezil_billing_trials_end_chk" CHECK ("ezil_billing_trials"."trial_end" > "ezil_billing_trials"."quoted_at"),
	CONSTRAINT "ezil_billing_trials_origin_chk" CHECK ("ezil_billing_trials"."return_origin" ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$')
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_trials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_billing_trials" ADD CONSTRAINT "ezil_billing_trials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE POLICY "Service role full access billing trials"
    ON "ezil_billing_trials" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
-- Every verified identity a STARTED trial's account has had (append-only). The trial row keeps the identity it was
-- quoted under; this keeps the later ones (a changed verified email or sign-in subject), so deleting the account keeps
-- all of them as claims. Rows go only with their trial (a reclaimed never-started quote never has any).
CREATE TABLE "ezil_billing_trial_identities" (
	"trial_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"email_domain" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_billing_trial_identities_pkey" PRIMARY KEY("trial_id","kind","value"),
	CONSTRAINT "ezil_billing_trial_identities_kind_chk" CHECK ("ezil_billing_trial_identities"."kind" in ('email', 'subject')),
	CONSTRAINT "ezil_billing_trial_identities_value_chk" CHECK (length("ezil_billing_trial_identities"."value") between 1 and 320),
	CONSTRAINT "ezil_billing_trial_identities_email_chk" CHECK ("ezil_billing_trial_identities"."kind" = 'subject' or (
		"ezil_billing_trial_identities"."value" = lower("ezil_billing_trial_identities"."value")
		and position('@' in "ezil_billing_trial_identities"."value") > 1
		and "ezil_billing_trial_identities"."email_domain" = split_part("ezil_billing_trial_identities"."value", '@', 2))),
	CONSTRAINT "ezil_billing_trial_identities_domain_chk" CHECK (("ezil_billing_trial_identities"."kind" = 'email') = ("ezil_billing_trial_identities"."email_domain" is not null))
);
--> statement-breakpoint
ALTER TABLE "ezil_billing_trial_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_billing_trial_identities" ADD CONSTRAINT "ezil_billing_trial_identities_trial_id_fkey" FOREIGN KEY ("trial_id") REFERENCES "public"."ezil_billing_trials"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE POLICY "Service role full access billing trial identities"
    ON "ezil_billing_trial_identities" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE INDEX "ezil_billing_trial_identities_value_idx" ON "ezil_billing_trial_identities" USING btree ("kind","value");--> statement-breakpoint
CREATE INDEX "ezil_billing_trial_identities_domain_idx" ON "ezil_billing_trial_identities" USING btree ("email_domain") WHERE "ezil_billing_trial_identities"."kind" = 'email';--> statement-breakpoint
-- Stripe's trial window as last read, and the first positive paid period: a trial that never paid gets no grace.
ALTER TABLE "ezil_billing_subscriptions" ADD COLUMN "trial_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ezil_billing_subscriptions" ADD COLUMN "trial_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ezil_billing_subscriptions" ADD COLUMN "first_paid_at" timestamp with time zone;--> statement-breakpoint
-- The trial's ledger row has its own kind and source, so it is never read as a paid invoice period.
ALTER TABLE "ezil_billing_grants" DROP CONSTRAINT "ezil_billing_grants_kind_chk";--> statement-breakpoint
ALTER TABLE "ezil_billing_grants" ADD CONSTRAINT "ezil_billing_grants_kind_chk" CHECK ("ezil_billing_grants"."kind" in ('pro_period', 'topup', 'revoke', 'suspend', 'restore', 'plan_period', 'upgrade_prorated', 'trial_period'));--> statement-breakpoint
ALTER TABLE "ezil_billing_grants" DROP CONSTRAINT "ezil_billing_grants_source_type_chk";--> statement-breakpoint
ALTER TABLE "ezil_billing_grants" ADD CONSTRAINT "ezil_billing_grants_source_type_chk" CHECK ("ezil_billing_grants"."source_type" in ('invoice', 'payment_intent', 'refund', 'dispute', 'trial'));--> statement-breakpoint
CREATE UNIQUE INDEX "ezil_billing_grants_trial_once_uidx" ON "ezil_billing_grants" USING btree ("user_id","meter") WHERE "ezil_billing_grants"."kind" = 'trial_period';
