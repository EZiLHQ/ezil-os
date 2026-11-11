-- Sponsor attribution (request sponsor-checkout-20261111). FUTURE, OUTSIDE the ordered drizzle journal: never listed in
-- drizzle/meta/_journal.json, never run by a startup, migrate-up or directory include, and it must not ride along with the pending
-- 0022-0025 objects. It needs the 0021 Standard trial schema (ezil_billing_trials) and nothing else. Applied only by a separately
-- reviewed, exact-file staging runner after migrations/sponsor/preflight.sql passes. Additive, service-only, atomic (one transaction).
BEGIN;

-- One row per pseudonymous account (account_key = HMAC of the user id, see v3/sponsor.ts). The FIRST accepted campaign wins and is never
-- overwritten. signed_up_at is set ONLY for an account the server created through the sponsor path; an existing account never gains it.
-- No FK to auth.users: the key is kept after the account is deleted, so the counts are durable.
CREATE TABLE "ezil_sponsor_attributions" (
	"account_key" uuid PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"config_sha256" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_up_at" timestamp with time zone,
	CONSTRAINT "ezil_sponsor_attributions_account_campaign_unique" UNIQUE ("account_key", "campaign_id"),
	CONSTRAINT "ezil_sponsor_attributions_campaign_chk" CHECK ("campaign_id" ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
	CONSTRAINT "ezil_sponsor_attributions_partner_chk" CHECK ("partner_id" ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
	CONSTRAINT "ezil_sponsor_attributions_config_chk" CHECK ("config_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
-- The sponsor linkage of ONE trial (the existing trial row stays the only trial authority). Frozen at quote time with the campaign and
-- its config hash; claimed_at and the Stripe subscription are set once, together, when the subscription binds. Counts are DISTINCT
-- claimed trial ids: an abandoned quote is never a claim and a later cancellation never removes one.
CREATE TABLE "ezil_sponsor_trial_claims" (
	"trial_id" uuid PRIMARY KEY NOT NULL,
	"account_key" uuid NOT NULL,
	"campaign_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"config_sha256" text NOT NULL,
	"quoted_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"stripe_subscription_id" text,
	CONSTRAINT "ezil_sponsor_trial_claims_subscription_unique" UNIQUE ("stripe_subscription_id"),
	CONSTRAINT "ezil_sponsor_trial_claims_campaign_chk" CHECK ("campaign_id" ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
	CONSTRAINT "ezil_sponsor_trial_claims_partner_chk" CHECK ("partner_id" ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
	CONSTRAINT "ezil_sponsor_trial_claims_config_chk" CHECK ("config_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ezil_sponsor_trial_claims_subscription_chk" CHECK ("stripe_subscription_id" is null or "stripe_subscription_id" ~ '^sub_[A-Za-z0-9]{1,250}$'),
	CONSTRAINT "ezil_sponsor_trial_claims_claimed_chk" CHECK (("claimed_at" is null) = ("stripe_subscription_id" is null)),
	CONSTRAINT "ezil_sponsor_trial_claims_order_chk" CHECK ("claimed_at" is null or "claimed_at" >= "quoted_at")
);
--> statement-breakpoint
-- The linkage must name the same account and campaign as its attribution (composite FK on the attribution's UNIQUE pair).
ALTER TABLE "ezil_sponsor_trial_claims" ADD CONSTRAINT "ezil_sponsor_trial_claims_attribution_fkey"
	FOREIGN KEY ("account_key", "campaign_id") REFERENCES "ezil_sponsor_attributions" ("account_key", "campaign_id") ON DELETE RESTRICT ON UPDATE RESTRICT;--> statement-breakpoint
-- An UNSTARTED linkage may go with its reclaimed trial row (0021 only ever deletes a never-started quote). A consumed one never does.
ALTER TABLE "ezil_sponsor_trial_claims" ADD CONSTRAINT "ezil_sponsor_trial_claims_trial_fkey"
	FOREIGN KEY ("trial_id") REFERENCES "ezil_billing_trials" ("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
CREATE INDEX "ezil_sponsor_trial_claims_campaign_claimed_idx" ON "ezil_sponsor_trial_claims" ("campaign_id", "claimed_at");--> statement-breakpoint
CREATE INDEX "ezil_sponsor_attributions_campaign_signup_idx" ON "ezil_sponsor_attributions" ("campaign_id", "signed_up_at") WHERE "signed_up_at" is not null;--> statement-breakpoint

-- Immutability. Attribution: campaign, partner, config hash, accepted_at never change; signed_up_at may be set once (null -> value).
-- Trial linkage: while unclaimed only quoted_at and the frozen config hash may move (a re-quote of an unbound quote); once claimed nothing changes and nothing is deleted.
CREATE FUNCTION "public"."ezil_sponsor_attribution_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sponsor attribution is permanent' USING ERRCODE = '23000'; END IF;
	IF NEW.account_key IS DISTINCT FROM OLD.account_key OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
		OR NEW.config_sha256 IS DISTINCT FROM OLD.config_sha256 OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
		OR (OLD.signed_up_at IS NOT NULL AND NEW.signed_up_at IS DISTINCT FROM OLD.signed_up_at) THEN
		RAISE EXCEPTION 'sponsor attribution is immutable' USING ERRCODE = '23000';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "ezil_sponsor_attribution_guard" BEFORE UPDATE OR DELETE ON "ezil_sponsor_attributions" FOR EACH ROW EXECUTE FUNCTION "public"."ezil_sponsor_attribution_guard"();--> statement-breakpoint
CREATE FUNCTION "public"."ezil_sponsor_trial_claim_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'a consumed sponsor trial claim is permanent' USING ERRCODE = '23000'; END IF;
		RETURN OLD;
	END IF;
	IF OLD.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'a consumed sponsor trial claim is immutable' USING ERRCODE = '23000'; END IF;
	IF NEW.trial_id IS DISTINCT FROM OLD.trial_id OR NEW.account_key IS DISTINCT FROM OLD.account_key OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
		OR NEW.partner_id IS DISTINCT FROM OLD.partner_id THEN
		RAISE EXCEPTION 'a sponsor trial claim keeps its campaign and account' USING ERRCODE = '23000';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "ezil_sponsor_trial_claim_guard" BEFORE UPDATE OR DELETE ON "ezil_sponsor_trial_claims" FOR EACH ROW EXECUTE FUNCTION "public"."ezil_sponsor_trial_claim_guard"();--> statement-breakpoint

-- Service-only: RLS on, a service-role policy, and no privilege for anon, authenticated or public.
ALTER TABLE "ezil_sponsor_attributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_sponsor_trial_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "Service role full access sponsor attributions" ON "ezil_sponsor_attributions" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
CREATE POLICY "Service role full access sponsor trial claims" ON "ezil_sponsor_trial_claims" FOR ALL USING (auth.role() = 'service_role');--> statement-breakpoint
REVOKE ALL ON "ezil_sponsor_attributions", "ezil_sponsor_trial_claims" FROM public, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ezil_sponsor_attribution_guard"(), "public"."ezil_sponsor_trial_claim_guard"() FROM public, anon, authenticated;

COMMIT;
