ALTER TABLE "users" ADD CONSTRAINT "users_mfa_active_shape_check" CHECK (("users"."mfa_enabled_at" is null
          and "users"."mfa_secret_encrypted" is null
          and "users"."mfa_last_used_totp_counter" is null
          and "users"."mfa_recovery_code_hashes" is null)
        or
        ("users"."mfa_enabled_at" is not null
          and length("users"."mfa_secret_encrypted") between 40 and 1024
          and jsonb_typeof("users"."mfa_recovery_code_hashes") = 'array'
          and jsonb_array_length("users"."mfa_recovery_code_hashes") <= 20));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_mfa_pending_shape_check" CHECK (("users"."mfa_pending_secret_encrypted" is null and "users"."mfa_pending_expires_at" is null)
        or
        ("users"."mfa_enabled_at" is null
          and length("users"."mfa_pending_secret_encrypted") between 40 and 1024
          and "users"."mfa_pending_expires_at" is not null));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_mfa_totp_counter_check" CHECK ("users"."mfa_last_used_totp_counter" is null or "users"."mfa_last_used_totp_counter" >= 0);