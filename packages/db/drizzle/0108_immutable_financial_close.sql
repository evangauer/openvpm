-- Reissue the clinic-day close guards after canonical reconciliation 0107.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.validate_financial_close_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  practice_timezone text;
  expected_cutoff timestamptz;
  payment_count_actual bigint;
  gross_receipts_actual bigint;
  refunds_actual bigint;
  net_receipts_actual bigint;
  cash_actual bigint;
  check_actual bigint;
  card_online_actual bigint;
  other_actual bigint;
  processor_gross_actual bigint;
  processor_fee_actual bigint;
  application_fee_actual bigint;
  clinic_net_actual bigint;
  paid_out_actual bigint;
  open_dispute_actual bigint;
  unresolved_payment_actual bigint;
  unresolved_refund_actual bigint;
  unresolved_payout_actual bigint;
BEGIN
  IF session_user <> current_user
     AND coalesce(current_setting('app.rls_bypass', true), '') <> 'on'
     AND NEW.practice_id IS DISTINCT FROM
       nullif(current_setting('app.current_practice_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Financial close tenant context is invalid.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_closes_tenant_context_guard';
  END IF;

  SELECT p.timezone
  INTO practice_timezone
  FROM public.practices p
  WHERE p.id = NEW.practice_id
    AND p.deleted_at IS NULL
  FOR UPDATE;

  IF practice_timezone IS NULL THEN
    RAISE EXCEPTION 'Financial close requires an active practice.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_closes_active_practice_guard';
  END IF;
  IF NEW.timezone IS DISTINCT FROM practice_timezone THEN
    RAISE EXCEPTION 'Financial close timezone must match the practice.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_closes_timezone_guard';
  END IF;

  expected_cutoff :=
    ((NEW.business_date + 1)::timestamp AT TIME ZONE practice_timezone);
  IF NEW.cutoff_at IS DISTINCT FROM expected_cutoff THEN
    RAISE EXCEPTION 'Financial close cutoff must be clinic-local midnight.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_closes_cutoff_guard';
  END IF;
  IF expected_cutoff > clock_timestamp() THEN
    RAISE EXCEPTION 'Financial close cannot precede the clinic-day cutoff.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_closes_ended_day_guard';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = NEW.closed_by
      AND u.practice_id = NEW.practice_id
      AND u.role = 'admin'
      AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Financial close requires an active clinic administrator.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_closes_active_admin_guard';
  END IF;

  WITH payment_rows AS (
    SELECT
      pay.id,
      round(pay.amount::numeric * 100)::bigint AS amount_cents,
      pay.method::text AS method,
      pay.external_id
    FROM public.payments pay
    JOIN public.invoices i ON i.id = pay.invoice_id
    WHERE i.practice_id = NEW.practice_id
      AND i.deleted_at IS NULL
      AND pay.deleted_at IS NULL
      AND pay.received_at >=
        (NEW.business_date::timestamp AT TIME ZONE practice_timezone)
      AND pay.received_at < expected_cutoff
  )
  SELECT
    count(*)::bigint,
    coalesce(sum(greatest(pr.amount_cents, 0)), 0)::bigint,
    coalesce(sum(abs(least(pr.amount_cents, 0))), 0)::bigint,
    coalesce(sum(pr.amount_cents), 0)::bigint,
    coalesce(sum(pr.amount_cents) FILTER (WHERE pr.method = 'cash'), 0)::bigint,
    coalesce(sum(pr.amount_cents) FILTER (WHERE pr.method = 'check'), 0)::bigint,
    coalesce(sum(pr.amount_cents) FILTER (
      WHERE pr.method IN ('credit_card', 'debit_card', 'online')
    ), 0)::bigint,
    coalesce(sum(pr.amount_cents) FILTER (WHERE pr.method = 'other'), 0)::bigint,
    count(*) FILTER (
      WHERE pr.amount_cents > 0
        AND pr.method = 'online'
        AND pr.external_id LIKE 'stripe:connect:%'
        AND s.id IS NULL
    )::bigint,
    count(*) FILTER (
      WHERE pr.amount_cents < 0
        AND pr.method = 'online'
        AND pr.external_id LIKE 'refund:payment:%'
        AND (r.id IS NULL OR r.status <> 'succeeded')
    )::bigint
  INTO
    payment_count_actual,
    gross_receipts_actual,
    refunds_actual,
    net_receipts_actual,
    cash_actual,
    check_actual,
    card_online_actual,
    other_actual,
    unresolved_payment_actual,
    unresolved_refund_actual
  FROM payment_rows pr
  LEFT JOIN public.payment_processor_settlements s
    ON s.payment_id = pr.id
   AND s.practice_id = NEW.practice_id
   AND s.deleted_at IS NULL
  LEFT JOIN public.payment_processor_refunds r
    ON r.refund_payment_id = pr.id
   AND r.practice_id = NEW.practice_id
   AND r.deleted_at IS NULL;

  WITH payment_rows AS (
    SELECT pay.id
    FROM public.payments pay
    JOIN public.invoices i ON i.id = pay.invoice_id
    WHERE i.practice_id = NEW.practice_id
      AND i.deleted_at IS NULL
      AND pay.deleted_at IS NULL
      AND pay.received_at >=
        (NEW.business_date::timestamp AT TIME ZONE practice_timezone)
      AND pay.received_at < expected_cutoff
  )
  SELECT
    coalesce(sum(s.gross_amount_cents), 0)::bigint,
    coalesce(sum(s.processor_fee_cents), 0)::bigint,
    coalesce(sum(s.application_fee_cents), 0)::bigint,
    coalesce(sum(s.clinic_net_cents), 0)::bigint
  INTO
    processor_gross_actual,
    processor_fee_actual,
    application_fee_actual,
    clinic_net_actual
  FROM public.payment_processor_settlements s
  JOIN payment_rows pr ON pr.id = s.payment_id
  WHERE s.practice_id = NEW.practice_id
    AND s.deleted_at IS NULL;

  SELECT
    coalesce(sum(p.amount_cents) FILTER (
      WHERE p.status = 'paid' AND p.reconciliation_complete
    ), 0)::bigint,
    count(*) FILTER (WHERE NOT p.reconciliation_complete)::bigint
  INTO paid_out_actual, unresolved_payout_actual
  FROM public.payment_processor_payouts p
  WHERE p.practice_id = NEW.practice_id
    AND p.deleted_at IS NULL
    AND p.arrival_at >=
      (NEW.business_date::timestamp AT TIME ZONE practice_timezone)
    AND p.arrival_at < expected_cutoff;

  SELECT coalesce(sum(d.amount_cents), 0)::bigint
  INTO open_dispute_actual
  FROM public.payment_disputes d
  WHERE d.practice_id = NEW.practice_id
    AND d.deleted_at IS NULL
    AND d.provider_created_at < expected_cutoff
    AND (d.closed_at IS NULL OR d.closed_at >= expected_cutoff);

  IF coalesce(unresolved_payment_actual, 0)
       + coalesce(unresolved_refund_actual, 0)
       + coalesce(unresolved_payout_actual, 0) > 0
     OR NEW.unreconciled_count <> 0 THEN
    RAISE EXCEPTION 'Financial close has unresolved processor evidence.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_closes_reconciliation_guard';
  END IF;

  IF NEW.payment_count IS DISTINCT FROM payment_count_actual
     OR NEW.gross_receipts_cents IS DISTINCT FROM gross_receipts_actual
     OR NEW.refunds_cents IS DISTINCT FROM refunds_actual
     OR NEW.net_receipts_cents IS DISTINCT FROM net_receipts_actual
     OR NEW.cash_cents IS DISTINCT FROM cash_actual
     OR NEW.check_cents IS DISTINCT FROM check_actual
     OR NEW.card_and_online_cents IS DISTINCT FROM card_online_actual
     OR NEW.other_cents IS DISTINCT FROM other_actual
     OR NEW.processor_gross_cents IS DISTINCT FROM processor_gross_actual
     OR NEW.processor_fee_cents IS DISTINCT FROM processor_fee_actual
     OR NEW.application_fee_cents IS DISTINCT FROM application_fee_actual
     OR NEW.clinic_net_cents IS DISTINCT FROM clinic_net_actual
     OR NEW.paid_out_cents IS DISTINCT FROM paid_out_actual
     OR NEW.open_dispute_cents IS DISTINCT FROM open_dispute_actual THEN
    RAISE EXCEPTION 'Financial close snapshot does not match committed evidence.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_closes_snapshot_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.guard_financial_close_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Financial close snapshots are immutable.'
    USING ERRCODE = '23514',
          CONSTRAINT = 'financial_closes_immutable_guard';
END
$$;

CREATE OR REPLACE FUNCTION public.guard_closed_financial_payment_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  old_practice_id uuid;
  new_practice_id uuid;
  payment_changed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    payment_changed := OLD.invoice_id IS DISTINCT FROM NEW.invoice_id
      OR OLD.amount IS DISTINCT FROM NEW.amount
      OR OLD.method IS DISTINCT FROM NEW.method
      OR OLD.received_at IS DISTINCT FROM NEW.received_at
      OR OLD.external_id IS DISTINCT FROM NEW.external_id
      OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at;
  ELSE
    payment_changed := true;
  END IF;
  IF NOT payment_changed THEN
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT i.practice_id INTO old_practice_id
    FROM public.invoices i
    WHERE i.id = OLD.invoice_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT i.practice_id INTO new_practice_id
    FROM public.invoices i
    WHERE i.id = NEW.invoice_id;
  END IF;

  IF session_user <> current_user
     AND coalesce(current_setting('app.rls_bypass', true), '') <> 'on'
     AND (
       (
         TG_OP IN ('UPDATE', 'DELETE')
         AND old_practice_id IS DISTINCT FROM
           nullif(current_setting('app.current_practice_id', true), '')::uuid
       )
       OR (
         TG_OP IN ('INSERT', 'UPDATE')
         AND new_practice_id IS DISTINCT FROM
           nullif(current_setting('app.current_practice_id', true), '')::uuid
       )
     ) THEN
    RAISE EXCEPTION 'Payment tenant context is invalid.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'payments_financial_close_tenant_guard';
  END IF;

  PERFORM 1
  FROM public.practices p
  WHERE p.id IN (old_practice_id, new_practice_id)
  ORDER BY p.id
  FOR SHARE;

  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
    SELECT 1
    FROM public.financial_closes fc
    WHERE fc.practice_id = old_practice_id
      AND fc.deleted_at IS NULL
      AND OLD.received_at >=
        (fc.business_date::timestamp AT TIME ZONE fc.timezone)
      AND OLD.received_at < fc.cutoff_at
  ) THEN
    RAISE EXCEPTION 'Payment belongs to an immutable financial close.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'payments_financial_close_guard';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND EXISTS (
    SELECT 1
    FROM public.financial_closes fc
    WHERE fc.practice_id = new_practice_id
      AND fc.deleted_at IS NULL
      AND NEW.received_at >=
        (fc.business_date::timestamp AT TIME ZONE fc.timezone)
      AND NEW.received_at < fc.cutoff_at
  ) THEN
    RAISE EXCEPTION 'Payment belongs to an immutable financial close.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'payments_financial_close_guard';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.guard_closed_financial_invoice_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.practice_id IS NOT DISTINCT FROM NEW.practice_id
     AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN
    RETURN NEW;
  END IF;

  IF session_user <> current_user
     AND coalesce(current_setting('app.rls_bypass', true), '') <> 'on'
     AND (
       OLD.practice_id IS DISTINCT FROM
         nullif(current_setting('app.current_practice_id', true), '')::uuid
       OR (
         TG_OP = 'UPDATE'
         AND NEW.practice_id IS DISTINCT FROM
           nullif(current_setting('app.current_practice_id', true), '')::uuid
       )
     ) THEN
    RAISE EXCEPTION 'Invoice tenant context is invalid.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'invoices_financial_close_tenant_guard';
  END IF;

  PERFORM 1
  FROM public.practices p
  WHERE p.id IN (OLD.practice_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.practice_id END)
  ORDER BY p.id
  FOR SHARE;

  IF EXISTS (
    SELECT 1
    FROM public.payments pay
    JOIN public.financial_closes fc
      ON fc.practice_id IN (
        OLD.practice_id,
        CASE WHEN TG_OP = 'UPDATE' THEN NEW.practice_id END
      )
     AND fc.deleted_at IS NULL
     AND pay.received_at >=
       (fc.business_date::timestamp AT TIME ZONE fc.timezone)
     AND pay.received_at < fc.cutoff_at
    WHERE pay.invoice_id = OLD.id
      AND pay.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Invoice has payments in an immutable financial close.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'invoices_financial_close_guard';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS financial_closes_validate_insert ON public.financial_closes;
CREATE TRIGGER financial_closes_validate_insert
BEFORE INSERT ON public.financial_closes
FOR EACH ROW EXECUTE FUNCTION public.validate_financial_close_insert();

DROP TRIGGER IF EXISTS financial_closes_immutable ON public.financial_closes;
CREATE TRIGGER financial_closes_immutable
BEFORE UPDATE OR DELETE ON public.financial_closes
FOR EACH ROW EXECUTE FUNCTION public.guard_financial_close_immutability();

DROP TRIGGER IF EXISTS payments_financial_close_guard ON public.payments;
CREATE TRIGGER payments_financial_close_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.guard_closed_financial_payment_mutation();

DROP TRIGGER IF EXISTS invoices_financial_close_guard ON public.invoices;
CREATE TRIGGER invoices_financial_close_guard
BEFORE UPDATE OF practice_id, deleted_at OR DELETE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.guard_closed_financial_invoice_mutation();

REVOKE ALL ON FUNCTION public.validate_financial_close_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_financial_close_immutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_closed_financial_payment_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_closed_financial_invoice_mutation() FROM PUBLIC;
