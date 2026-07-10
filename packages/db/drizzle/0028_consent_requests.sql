CREATE TABLE "consent_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"created_by" uuid,
	"token" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"title" varchar(200) NOT NULL,
	"body_text" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"signer_name" varchar(120),
	"signed_at" timestamp with time zone,
	"file_id" uuid
);
--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_requests_token_uq" ON "consent_requests" USING btree ("token");--> statement-breakpoint
CREATE INDEX "consent_requests_practice_idx" ON "consent_requests" USING btree ("practice_id","deleted_at");--> statement-breakpoint
CREATE INDEX "consent_requests_patient_idx" ON "consent_requests" USING btree ("patient_id");