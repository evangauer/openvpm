CREATE TYPE "public"."migration_run_mode" AS ENUM('clients', 'patients', 'vaccinations', 'soap_notes');--> statement-breakpoint
CREATE TYPE "public"."migration_run_status" AS ENUM('previewed', 'superseded', 'committing', 'committed');--> statement-breakpoint
CREATE TABLE "migration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"mode" "migration_run_mode" NOT NULL,
	"source" varchar(64) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"status" "migration_run_status" DEFAULT 'previewed' NOT NULL,
	"source_row_count" integer DEFAULT 0 NOT NULL,
	"planned_insert_count" integer DEFAULT 0 NOT NULL,
	"planned_reconcile_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"unmatched_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"reconciled_count" integer DEFAULT 0 NOT NULL,
	"preview_expires_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"committed_by" uuid,
	CONSTRAINT "migration_runs_file_hash_check" CHECK ("migration_runs"."file_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "migration_runs_file_size_check" CHECK ("migration_runs"."file_size_bytes" between 1 and 5000000),
	CONSTRAINT "migration_runs_source_check" CHECK ("migration_runs"."source" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "migration_runs_preview_expiry_check" CHECK ("migration_runs"."preview_expires_at" > "migration_runs"."created_at"),
	CONSTRAINT "migration_runs_committed_state_check" CHECK (("migration_runs"."status" <> 'committed' or ("migration_runs"."committed_at" is not null and "migration_runs"."committed_by" is not null))),
	CONSTRAINT "migration_runs_superseded_state_check" CHECK (("migration_runs"."status" <> 'superseded' or ("migration_runs"."superseded_at" is not null and "migration_runs"."committed_at" is null and "migration_runs"."committed_by" is null))),
	CONSTRAINT "migration_runs_counts_check" CHECK ("migration_runs"."source_row_count" >= 0
        and "migration_runs"."planned_insert_count" >= 0
        and "migration_runs"."planned_reconcile_count" >= 0
        and "migration_runs"."duplicate_count" >= 0
        and "migration_runs"."unmatched_count" >= 0
        and "migration_runs"."error_count" >= 0
        and "migration_runs"."imported_count" >= 0
        and "migration_runs"."reconciled_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_committed_by_users_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_runs_active_preview_uq" ON "migration_runs" USING btree ("practice_id","mode") WHERE "migration_runs"."status" = 'previewed' and "migration_runs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "migration_runs_practice_status_idx" ON "migration_runs" USING btree ("practice_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "migration_runs_created_by_idx" ON "migration_runs" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "migration_runs_committed_by_idx" ON "migration_runs" USING btree ("committed_by");--> statement-breakpoint
CREATE INDEX "migration_runs_pending_expiry_idx" ON "migration_runs" USING btree ("preview_expires_at") WHERE "migration_runs"."status" = 'previewed';