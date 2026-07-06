DROP INDEX "communications_practice_list_idx";--> statement-breakpoint
DROP INDEX "communications_client_timeline_idx";--> statement-breakpoint
DROP INDEX "communications_inbox_status_idx";--> statement-breakpoint
DROP INDEX "communications_assigned_idx";--> statement-breakpoint
DROP INDEX "communications_provider_message_idx";--> statement-breakpoint
CREATE INDEX "communications_practice_list_idx" ON "communications" USING btree ("practice_id","deleted_at","created_at");--> statement-breakpoint
CREATE INDEX "communications_client_timeline_idx" ON "communications" USING btree ("practice_id","client_id","deleted_at","created_at");--> statement-breakpoint
CREATE INDEX "communications_inbox_status_idx" ON "communications" USING btree ("practice_id","direction","status","deleted_at");--> statement-breakpoint
CREATE INDEX "communications_assigned_idx" ON "communications" USING btree ("practice_id","assigned_to","deleted_at");--> statement-breakpoint
CREATE INDEX "communications_provider_message_idx" ON "communications" USING btree ("practice_id","provider_message_id","channel","direction");