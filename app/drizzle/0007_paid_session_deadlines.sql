ALTER TABLE "ezil_billing_compute_epochs" DROP CONSTRAINT "ezil_billing_compute_epochs_deadline_at_chk";--> statement-breakpoint
ALTER TABLE "ezil_billing_compute_epochs" ADD CONSTRAINT "ezil_billing_compute_epochs_deadline_at_chk" CHECK ("ezil_billing_compute_epochs"."deadline_at" is null or "ezil_billing_compute_epochs"."deadline_at" >= "ezil_billing_compute_epochs"."ready_at");
