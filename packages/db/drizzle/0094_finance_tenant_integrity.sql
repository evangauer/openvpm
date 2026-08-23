CREATE UNIQUE INDEX "invoices_practice_id_uq" ON "invoices" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_invoice_id_uq" ON "payments" USING btree ("invoice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "practice_payment_accounts_tenant_provider_account_uq" ON "practice_payment_accounts" USING btree ("practice_id","provider","stripe_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_processor_settlements_practice_id_uq" ON "payment_processor_settlements" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_processor_settlements_tenant_payment_uq" ON "payment_processor_settlements" USING btree ("practice_id","id","payment_id");--> statement-breakpoint
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_actor_tenant_fk" FOREIGN KEY ("practice_id","closed_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_settlement_tenant_fk" FOREIGN KEY ("practice_id","settlement_id") REFERENCES "public"."payment_processor_settlements"("practice_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_processor_payouts" ADD CONSTRAINT "payment_processor_payouts_account_tenant_fk" FOREIGN KEY ("practice_id","provider","connected_account_id") REFERENCES "public"."practice_payment_accounts"("practice_id","provider","stripe_account_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_processor_refunds" ADD CONSTRAINT "payment_processor_refunds_settlement_payment_tenant_fk" FOREIGN KEY ("practice_id","settlement_id","original_payment_id") REFERENCES "public"."payment_processor_settlements"("practice_id","id","payment_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_processor_refunds" ADD CONSTRAINT "payment_processor_refunds_account_tenant_fk" FOREIGN KEY ("practice_id","provider","connected_account_id") REFERENCES "public"."practice_payment_accounts"("practice_id","provider","stripe_account_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_processor_settlements" ADD CONSTRAINT "payment_processor_settlements_invoice_tenant_fk" FOREIGN KEY ("practice_id","invoice_id") REFERENCES "public"."invoices"("practice_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_processor_settlements" ADD CONSTRAINT "payment_processor_settlements_payment_invoice_fk" FOREIGN KEY ("invoice_id","payment_id") REFERENCES "public"."payments"("invoice_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_processor_settlements" ADD CONSTRAINT "payment_processor_settlements_account_tenant_fk" FOREIGN KEY ("practice_id","provider","connected_account_id") REFERENCES "public"."practice_payment_accounts"("practice_id","provider","stripe_account_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "financial_closes" VALIDATE CONSTRAINT "financial_closes_actor_tenant_fk";--> statement-breakpoint
ALTER TABLE "payment_disputes" VALIDATE CONSTRAINT "payment_disputes_settlement_tenant_fk";--> statement-breakpoint
ALTER TABLE "payment_processor_payouts" VALIDATE CONSTRAINT "payment_processor_payouts_account_tenant_fk";--> statement-breakpoint
ALTER TABLE "payment_processor_refunds" VALIDATE CONSTRAINT "payment_processor_refunds_settlement_payment_tenant_fk";--> statement-breakpoint
ALTER TABLE "payment_processor_refunds" VALIDATE CONSTRAINT "payment_processor_refunds_account_tenant_fk";--> statement-breakpoint
ALTER TABLE "payment_processor_settlements" VALIDATE CONSTRAINT "payment_processor_settlements_invoice_tenant_fk";--> statement-breakpoint
ALTER TABLE "payment_processor_settlements" VALIDATE CONSTRAINT "payment_processor_settlements_payment_invoice_fk";--> statement-breakpoint
ALTER TABLE "payment_processor_settlements" VALIDATE CONSTRAINT "payment_processor_settlements_account_tenant_fk";--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.validate_payment_processor_refund_tenant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  original_practice_id uuid;
  refund_practice_id uuid;
BEGIN
  SELECT invoice.practice_id
    INTO original_practice_id
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
   WHERE payment.id = NEW.original_payment_id;

  IF original_practice_id IS DISTINCT FROM NEW.practice_id THEN
    RAISE EXCEPTION 'original payment does not belong to refund practice'
      USING ERRCODE = '23514';
  END IF;

  SELECT invoice.practice_id
    INTO refund_practice_id
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
   WHERE payment.id = NEW.refund_payment_id;

  IF refund_practice_id IS DISTINCT FROM NEW.practice_id THEN
    RAISE EXCEPTION 'refund payment does not belong to refund practice'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.validate_payment_processor_refund_tenant() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_processor_refunds_tenant_guard ON public.payment_processor_refunds;--> statement-breakpoint
CREATE TRIGGER payment_processor_refunds_tenant_guard
BEFORE INSERT OR UPDATE OF practice_id, original_payment_id, refund_payment_id
ON public.payment_processor_refunds
FOR EACH ROW
EXECUTE FUNCTION public.validate_payment_processor_refund_tenant();
