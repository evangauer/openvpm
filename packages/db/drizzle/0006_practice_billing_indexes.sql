CREATE INDEX "practices_billing_trial_idx" ON "practices" USING btree ("billing_status","trial_ends_at","deleted_at");--> statement-breakpoint
CREATE INDEX "practices_stripe_customer_idx" ON "practices" USING btree ("stripe_customer_id","deleted_at");--> statement-breakpoint
CREATE INDEX "practices_stripe_subscription_idx" ON "practices" USING btree ("stripe_subscription_id","deleted_at");