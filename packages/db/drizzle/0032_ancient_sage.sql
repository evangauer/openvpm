CREATE TABLE "booking_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "booking_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "booking_pages" ADD CONSTRAINT "booking_pages_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_pages_practice_idx" ON "booking_pages" USING btree ("practice_id","deleted_at");--> statement-breakpoint
CREATE INDEX "booking_pages_slug_published_idx" ON "booking_pages" USING btree ("slug","published","deleted_at");