-- This SECURITY DEFINER routine is a trigger implementation, not an RPC. The
-- trigger owner can continue to invoke it without exposing direct execution to
-- API or application roles.
REVOKE ALL ON FUNCTION public.validate_sms_provider_event_resolution_insert() FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'openpims_app']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.validate_sms_provider_event_resolution_insert() FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$$;
