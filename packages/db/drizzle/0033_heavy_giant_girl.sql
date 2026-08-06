CREATE TABLE "demo_accesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"email" varchar(255) NOT NULL,
	"email_hash" varchar(64) NOT NULL,
	"first_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"access_count" integer DEFAULT 1 NOT NULL,
	"feedback_opt_out_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_accesses_email_uq" ON "demo_accesses" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_accesses_email_hash_uq" ON "demo_accesses" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "demo_accesses_recent_idx" ON "demo_accesses" USING btree ("last_accessed_at");