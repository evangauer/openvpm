CREATE TYPE "public"."file_replica_status" AS ENUM('pending', 'available', 'missing', 'corrupt', 'failed');--> statement-breakpoint
CREATE TYPE "public"."file_storage_status" AS ENUM('unverified', 'pending_upload', 'available', 'missing', 'corrupt', 'cleanup_pending');--> statement-breakpoint
CREATE TABLE "file_object_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"replica_target" varchar(64) NOT NULL,
	"object_key" varchar(512) NOT NULL,
	"object_etag" varchar(255),
	"object_version_id" varchar(255),
	"checksum_sha256" varchar(64),
	"file_size_bytes" integer,
	"status" "file_replica_status" DEFAULT 'pending' NOT NULL,
	"replicated_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"failure_code" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "file_object_replicas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "checksum_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "object_etag" varchar(255);--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "object_version_id" varchar(255);--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "storage_status" "file_storage_status" DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "storage_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "title" varchar(255);--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "document_type" varchar(64);--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "document_date" date;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "source" varchar(64);--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "idempotency_key" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "patient_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "files_practice_id_uq" ON "files" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "file_object_replicas" ADD CONSTRAINT "file_object_replicas_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_object_replicas" ADD CONSTRAINT "file_object_replicas_file_tenant_fk" FOREIGN KEY ("practice_id","file_id") REFERENCES "public"."files"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_object_replicas_file_target_uq" ON "file_object_replicas" USING btree ("file_id","replica_target");--> statement-breakpoint
CREATE INDEX "file_object_replicas_practice_status_idx" ON "file_object_replicas" USING btree ("practice_id","status","updated_at");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_patient_tenant_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_appointment_patient_tenant_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id") REFERENCES "public"."appointments"("practice_id","id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_patient_created_idx" ON "files" USING btree ("practice_id","patient_id","deleted_at","created_at");
