SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
CREATE TABLE "practice_nps_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"survey" varchar(64) NOT NULL,
	"score" integer NOT NULL,
	"comment" varchar(1000),
	CONSTRAINT "practice_nps_responses_score_check" CHECK ("practice_nps_responses"."score" between 0 and 10)
);
--> statement-breakpoint
ALTER TABLE "practice_nps_responses" ADD CONSTRAINT "practice_nps_responses_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "practice_nps_responses_practice_survey_uq" ON "practice_nps_responses" USING btree ("practice_id","survey");--> statement-breakpoint
CREATE INDEX "practice_nps_responses_created_idx" ON "practice_nps_responses" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "practice_nps_responses" ENABLE ROW LEVEL SECURITY;
