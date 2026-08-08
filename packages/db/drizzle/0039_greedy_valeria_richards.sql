ALTER TABLE "clients" ADD COLUMN "external_source" varchar(64);--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "external_id" varchar(160);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "external_source" varchar(64);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "external_id" varchar(160);--> statement-breakpoint
CREATE UNIQUE INDEX "clients_external_id_uq" ON "clients" USING btree ("practice_id","external_source","external_id") WHERE "clients"."external_source" is not null and "clients"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "patients_external_id_uq" ON "patients" USING btree ("practice_id","external_source","external_id") WHERE "patients"."external_source" is not null and "patients"."external_id" is not null;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_external_identity_pair_check" CHECK (("clients"."external_source" is null) = ("clients"."external_id" is null));--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_external_identity_pair_check" CHECK (("patients"."external_source" is null) = ("patients"."external_id" is null));