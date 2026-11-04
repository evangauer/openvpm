SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "inventory_stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"adjustment" numeric(13, 3) NOT NULL,
	"quantity_after" numeric(13, 3) NOT NULL,
	"reason" text NOT NULL,
	"adjusted_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "controlled_substance_log" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_stock_adjustments" ADD CONSTRAINT "inventory_stock_adjustments_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_adjustments" ADD CONSTRAINT "inventory_stock_adjustments_adjusted_by_users_id_fk" FOREIGN KEY ("adjusted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_adjustments" ADD CONSTRAINT "inventory_stock_adjustments_practice_product_fk" FOREIGN KEY ("practice_id","product_id") REFERENCES "public"."products"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_adjustments_practice_operation_uq" ON "inventory_stock_adjustments" USING btree ("practice_id","operation_id");--> statement-breakpoint
CREATE INDEX "inventory_stock_adjustments_product_idx" ON "inventory_stock_adjustments" USING btree ("practice_id","product_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cs_log_practice_operation_uq" ON "controlled_substance_log" USING btree ("practice_id","operation_id") WHERE "controlled_substance_log"."operation_id" is not null;--> statement-breakpoint
ALTER TABLE "inventory_stock_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "inventory_stock_adjustments"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON inventory_stock_adjustments FROM openpims_app;
		GRANT SELECT, INSERT ON inventory_stock_adjustments TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON inventory_stock_adjustments FROM anon; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON inventory_stock_adjustments FROM authenticated; END IF;
END $$;
