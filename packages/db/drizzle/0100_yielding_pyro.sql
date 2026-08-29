ALTER TABLE "users" ADD COLUMN "mfa_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_last_used_totp_counter" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_recovery_code_hashes" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_pending_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_pending_expires_at" timestamp with time zone;
