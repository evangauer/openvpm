CREATE TABLE "consent_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "form_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_forms" ADD CONSTRAINT "consent_forms_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_forms_practice_slug_uq" ON "consent_forms" USING btree ("practice_id","slug");--> statement-breakpoint
CREATE INDEX "consent_forms_practice_idx" ON "consent_forms" USING btree ("practice_id","deleted_at");--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_form_id_consent_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."consent_forms"("id") ON DELETE no action ON UPDATE no action;