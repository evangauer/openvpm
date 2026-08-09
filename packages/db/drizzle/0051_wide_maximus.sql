ALTER TABLE "clients" ADD COLUMN "import_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "import_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "soap_notes" ADD COLUMN "import_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "vaccination_records" ADD COLUMN "import_fingerprint" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "clients_import_fingerprint_uq" ON "clients" USING btree ("practice_id","import_fingerprint") WHERE "clients"."import_fingerprint" is not null and "clients"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "patients_import_fingerprint_uq" ON "patients" USING btree ("practice_id","import_fingerprint") WHERE "patients"."import_fingerprint" is not null and "patients"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "soap_notes_import_fingerprint_uq" ON "soap_notes" USING btree ("practice_id","import_fingerprint") WHERE "soap_notes"."import_fingerprint" is not null and "soap_notes"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "vaccination_records_import_fingerprint_uq" ON "vaccination_records" USING btree ("practice_id","import_fingerprint") WHERE "vaccination_records"."import_fingerprint" is not null and "vaccination_records"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_import_fingerprint_check" CHECK ("clients"."import_fingerprint" is null or "clients"."import_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_import_fingerprint_check" CHECK ("patients"."import_fingerprint" is null or "patients"."import_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "soap_notes" ADD CONSTRAINT "soap_notes_import_fingerprint_check" CHECK ("soap_notes"."import_fingerprint" is null or "soap_notes"."import_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "vaccination_records" ADD CONSTRAINT "vaccination_records_import_fingerprint_check" CHECK ("vaccination_records"."import_fingerprint" is null or "vaccination_records"."import_fingerprint" ~ '^[0-9a-f]{64}$');