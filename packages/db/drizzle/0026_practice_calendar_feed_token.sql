ALTER TABLE "practices" ADD COLUMN "calendar_feed_token" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "practices_calendar_feed_token_uq" ON "practices" USING btree ("calendar_feed_token");