ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_last_used_totp_counter" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_recovery_code_hashes" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_pending_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_pending_expires_at" timestamp with time zone;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		WITH expected(column_name, data_type) AS (
			VALUES
				('mfa_secret_encrypted', 'text'),
				('mfa_enabled_at', 'timestamp with time zone'),
				('mfa_last_used_totp_counter', 'integer'),
				('mfa_recovery_code_hashes', 'jsonb'),
				('mfa_pending_secret_encrypted', 'text'),
				('mfa_pending_expires_at', 'timestamp with time zone')
		)
		SELECT 1
		FROM expected
		LEFT JOIN information_schema.columns AS actual
			ON actual.table_schema = 'public'
			AND actual.table_name = 'users'
			AND actual.column_name = expected.column_name
		WHERE actual.column_name IS NULL
			OR actual.data_type <> expected.data_type
			OR actual.is_nullable <> 'YES'
			OR actual.column_default IS NOT NULL
	) THEN
		RAISE EXCEPTION 'OpenVPM MFA column adoption preflight failed: public.users has an incompatible MFA column definition';
	END IF;
END $$;
