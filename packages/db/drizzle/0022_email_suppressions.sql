CREATE TYPE "public"."email_suppression_reason" AS ENUM('manual', 'bounce', 'complaint', 'suppressed');--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"reason" "email_suppression_reason" DEFAULT 'bounce' NOT NULL,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_practice_email_uq" ON "email_suppressions" USING btree ("practice_id","email");--> statement-breakpoint
CREATE INDEX "email_suppressions_practice_idx" ON "email_suppressions" USING btree ("practice_id","deleted_at");