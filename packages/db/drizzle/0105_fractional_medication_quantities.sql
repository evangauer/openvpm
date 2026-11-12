-- Recreate the dependent trigger in the same migration transaction.
DROP TRIGGER invoice_items_validate_dispense_charge ON public.invoice_items;
--> statement-breakpoint
ALTER TABLE "prescriptions" ALTER COLUMN "quantity" SET DATA TYPE numeric(13, 3);--> statement-breakpoint
ALTER TABLE "prescription_events" ALTER COLUMN "quantity" SET DATA TYPE numeric(13, 3);--> statement-breakpoint
ALTER TABLE "invoice_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(13, 3);--> statement-breakpoint
ALTER TABLE "invoice_items" ALTER COLUMN "quantity" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "stock_quantity" SET DATA TYPE numeric(13, 3);--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ALTER COLUMN "quantity" SET DATA TYPE numeric(13, 3);
--> statement-breakpoint
CREATE TRIGGER invoice_items_validate_dispense_charge
  BEFORE INSERT OR UPDATE OF source_dispense_charge_id, invoice_id, item_type, item_id, quantity, unit_price, description, deleted_at
  ON public.invoice_items
  FOR EACH ROW
  WHEN (NEW.source_dispense_charge_id IS NOT NULL AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION validate_dispense_charge_invoice_line();
