ALTER TABLE "users" ADD COLUMN "is_veterinarian" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "users" SET "is_veterinarian" = true WHERE "role" = 'veterinarian';--> statement-breakpoint
CREATE INDEX "users_veterinarian_idx" ON "users" USING btree ("practice_id","is_veterinarian","deleted_at");
